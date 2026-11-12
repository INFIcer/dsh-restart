// 客户端装配/卸载测试：用 vm + 假 DOM 跑真实的 client.js，
// 验证 dispose 会摘掉全局监听并复位装配状态，否则重装会叠加多份。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const clientPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

function makeNode(label) {
  return {
    labelName: label,
    id: '',
    className: '',
    textContent: '',
    hidden: false,
    style: {},
    children: [],
    parentNode: null,
    attrs: {},
    listeners: {},
    classList: {
      list: new Set(),
      add(...names) { for (const itemName of names) this.list.add(itemName) },
      remove(...names) { for (const itemName of names) this.list.delete(itemName) },
      toggle(itemName, enabled) { if (enabled) this.list.add(itemName); else this.list.delete(itemName) },
      contains(itemName) { return this.list.has(itemName) },
    },
    setAttribute(itemName, value) { this.attrs[itemName] = String(value) },
    appendChild(childEl) { childEl.parentNode = this; this.children.push(childEl); return childEl },
    removeChild(childEl) {
      const index = this.children.indexOf(childEl)
      if (index >= 0) this.children.splice(index, 1)
      childEl.parentNode = null
      return childEl
    },
    addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler) },
    removeEventListener(type, handler) {
      const list = this.listeners[type]
      if (!list) return
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    },
  }
}

function makePage() {
  const head = makeNode('head')
  const body = makeNode('body')
  const documentElement = makeNode('html')
  const docListeners = {}
  const winListeners = {}

  function find(rootEl, id) {
    if (rootEl.id === id) return rootEl
    for (const childEl of rootEl.children) {
      const found = find(childEl, id)
      if (found) return found
    }
    return null
  }

  const document = {
    head,
    body,
    documentElement,
    hidden: false,
    createElement: (label) => makeNode(label),
    getElementById: (id) => find(head, id) || find(body, id) || find(documentElement, id),
    addEventListener(type, handler) { (docListeners[type] || (docListeners[type] = [])).push(handler) },
    removeEventListener(type, handler) {
      const list = docListeners[type]
      if (!list) return
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    },
  }

  let registeredModule = null
  const window = {
    addEventListener(type, handler) { (winListeners[type] || (winListeners[type] = [])).push(handler) },
    removeEventListener(type, handler) {
      const list = winListeners[type]
      if (!list) return
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    },
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-restart-plugin')
        registeredModule = factory()
      },
    },
  }

  return { document, window, docListeners, winListeners, getModule: () => registeredModule }
}

function startClient(page, counter) {
  const sandbox = {
    document: page.document,
    window: page.window,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      counter.value += 1
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true, phase: 'idle', tasks: [], paused: false, busyCount: 0 }),
      }
    },
  }
  vm.runInNewContext(fs.readFileSync(clientPath, 'utf8'), sandbox, { filename: clientPath })
  return page.getModule()
}

function sleep(ms) {
  return new Promise((fulfill) => setTimeout(fulfill, ms))
}

test('client：apply 挂全局监听，dispose 后全部摘掉并可干净重装', async () => {
  const page = makePage()
  const counter = { value: 0 }
  const mod = startClient(page, counter)
  assert.equal(mod.name, 'dsh-restart-plugin')
  assert.ok(Array.isArray(mod.inject))

  const cleanup = []
  const ctx = { effect: (factory) => { cleanup.push(factory()) } }
  mod.apply(ctx)
  await sleep(30)

  assert.equal(page.docListeners.mousemove.length, 1)
  assert.equal(page.winListeners.blur.length, 1)
  assert.ok(page.document.getElementById('dsr-overlay'))
  assert.ok(page.document.getElementById('dsr-badge'))
  assert.ok(page.document.getElementById('dsr-style'))
  assert.ok(counter.value >= 1)

  for (const disposeFn of cleanup) disposeFn()

  assert.equal(page.docListeners.mousemove.length, 0)
  assert.equal(page.winListeners.blur.length, 0)
  assert.equal(page.document.getElementById('dsr-overlay'), null)
  assert.equal(page.document.getElementById('dsr-badge'), null)
  assert.equal(page.document.getElementById('dsr-style'), null)

  // 轮询确实停了：再过两个轮询周期，请求数不再增长。
  const requestsAfterDispose = counter.value
  await sleep(600)
  assert.equal(counter.value, requestsAfterDispose)

  // 装配标记已复位，同一个模块对象可以再装一次，监听仍然只有一份。
  const cleanup2 = []
  mod.apply({ effect: (factory) => { cleanup2.push(factory()) } })
  await sleep(30)
  assert.equal(page.docListeners.mousemove.length, 1)
  assert.equal(page.winListeners.blur.length, 1)
  assert.ok(page.document.getElementById('dsr-overlay'))
  for (const disposeFn of cleanup2) disposeFn()
  assert.equal(page.docListeners.mousemove.length, 0)
})
