// 假 DOM 与客户端装载器：用 vm 跑真实的 client.js，验证装配、卸载与界面行为。
// 只模拟插件用到的那部分 DOM（createElement / getElementById / 事件 / textContent 清空子节点）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

export const clientPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

export function makeNode(label) {
  const node = {
    labelName: label,
    id: '',
    className: '',
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
  // 与真实 DOM 一致：写 textContent 会清空子节点，读的时候把子节点文本拼在后面。
  let ownText = ''
  Object.defineProperty(node, 'textContent', {
    get() {
      if (node.children.length === 0) return ownText
      return ownText + node.children.map((childEl) => childEl.textContent).join('')
    },
    set(value) {
      ownText = String(value)
      node.children.length = 0
    },
  })
  return node
}

export function makePage() {
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
        assert.equal(id, 'dsh-restart')
        registeredModule = factory()
      },
    },
  }

  return { document, window, docListeners, winListeners, getModule: () => registeredModule }
}

/** 在假 DOM 里执行 client.js，返回注册出去的模块对象。 */
export function startClient(page, fetchImpl) {
  const sandbox = {
    document: page.document,
    window: page.window,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl,
  }
  vm.runInNewContext(fs.readFileSync(clientPath, 'utf8'), sandbox, { filename: clientPath })
  return page.getModule()
}

/** 只执行模块注册、不装配界面：用来拿不依赖 DOM 的纯函数。 */
export function loadClientModule() {
  let registeredModule = null
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load({ factory }) { registeredModule = factory() },
      },
    },
  }
  vm.runInNewContext(fs.readFileSync(clientPath, 'utf8'), sandbox, { filename: clientPath })
  return registeredModule
}

/** 深度优先找第一个满足条件的节点。 */
export function findNode(rootEl, predicate) {
  if (!rootEl) return null
  if (predicate(rootEl)) return rootEl
  for (const childEl of rootEl.children) {
    const found = findNode(childEl, predicate)
    if (found) return found
  }
  return null
}

export function sleep(ms) {
  return new Promise((fulfill) => setTimeout(fulfill, ms))
}
