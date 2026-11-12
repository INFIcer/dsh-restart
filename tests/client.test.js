// 客户端装配/卸载测试：用 vm + 假 DOM 跑真实的 client.js，
// 验证 dispose 会摘掉全局监听并复位装配状态，否则重装会叠加多份。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const 客户端路径 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

function 造节点(标签) {
  return {
    标签Name: 标签,
    id: '',
    className: '',
    textContent: '',
    hidden: false,
    style: {},
    children: [],
    parentNode: null,
    属性: {},
    监听: {},
    classList: {
      列表: new Set(),
      add(...名字) { for (const 名 of 名字) this.列表.add(名) },
      remove(...名字) { for (const 名 of 名字) this.列表.delete(名) },
      toggle(名, 开) { if (开) this.列表.add(名); else this.列表.delete(名) },
      contains(名) { return this.列表.has(名) },
    },
    setAttribute(名, 值) { this.属性[名] = String(值) },
    appendChild(子) { 子.parentNode = this; this.children.push(子); return 子 },
    removeChild(子) {
      const 序号 = this.children.indexOf(子)
      if (序号 >= 0) this.children.splice(序号, 1)
      子.parentNode = null
      return 子
    },
    addEventListener(类型, 处理) { (this.监听[类型] || (this.监听[类型] = [])).push(处理) },
    removeEventListener(类型, 处理) {
      const 列表 = this.监听[类型]
      if (!列表) return
      const 序号 = 列表.indexOf(处理)
      if (序号 >= 0) 列表.splice(序号, 1)
    },
  }
}

function 造页面() {
  const head = 造节点('head')
  const body = 造节点('body')
  const documentElement = 造节点('html')
  const 文档监听 = {}
  const 窗口监听 = {}

  function 找(根, id) {
    if (根.id === id) return 根
    for (const 子 of 根.children) {
      const 命中 = 找(子, id)
      if (命中) return 命中
    }
    return null
  }

  const document = {
    head,
    body,
    documentElement,
    hidden: false,
    createElement: (标签) => 造节点(标签),
    getElementById: (id) => 找(head, id) || 找(body, id) || 找(documentElement, id),
    addEventListener(类型, 处理) { (文档监听[类型] || (文档监听[类型] = [])).push(处理) },
    removeEventListener(类型, 处理) {
      const 列表 = 文档监听[类型]
      if (!列表) return
      const 序号 = 列表.indexOf(处理)
      if (序号 >= 0) 列表.splice(序号, 1)
    },
  }

  let 已注册模块 = null
  const window = {
    addEventListener(类型, 处理) { (窗口监听[类型] || (窗口监听[类型] = [])).push(处理) },
    removeEventListener(类型, 处理) {
      const 列表 = 窗口监听[类型]
      if (!列表) return
      const 序号 = 列表.indexOf(处理)
      if (序号 >= 0) 列表.splice(序号, 1)
    },
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-restart-plugin')
        已注册模块 = factory()
      },
    },
  }

  return { document, window, 文档监听, 窗口监听, 取模块: () => 已注册模块 }
}

function 起客户端(页面, 计数) {
  const 沙箱 = {
    document: 页面.document,
    window: 页面.window,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      计数.value += 1
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true, phase: 'idle', tasks: [], paused: false, busyCount: 0 }),
      }
    },
  }
  vm.runInNewContext(fs.readFileSync(客户端路径, 'utf8'), 沙箱, { filename: 客户端路径 })
  return 页面.取模块()
}

function 等(毫秒) {
  return new Promise((兑现) => setTimeout(兑现, 毫秒))
}

test('client：apply 挂全局监听，dispose 后全部摘掉并可干净重装', async () => {
  const 页面 = 造页面()
  const 计数 = { value: 0 }
  const 模块 = 起客户端(页面, 计数)
  assert.equal(模块.name, 'dsh-restart-plugin')
  assert.ok(Array.isArray(模块.inject))

  const 清理 = []
  const ctx = { effect: (工厂) => { 清理.push(工厂()) } }
  模块.apply(ctx)
  await 等(30)

  assert.equal(页面.文档监听.mousemove.length, 1)
  assert.equal(页面.窗口监听.blur.length, 1)
  assert.ok(页面.document.getElementById('dsr-overlay'))
  assert.ok(页面.document.getElementById('dsr-badge'))
  assert.ok(页面.document.getElementById('dsr-style'))
  assert.ok(计数.value >= 1)

  for (const 清理函数 of 清理) 清理函数()

  assert.equal(页面.文档监听.mousemove.length, 0)
  assert.equal(页面.窗口监听.blur.length, 0)
  assert.equal(页面.document.getElementById('dsr-overlay'), null)
  assert.equal(页面.document.getElementById('dsr-badge'), null)
  assert.equal(页面.document.getElementById('dsr-style'), null)

  // 轮询确实停了：再过两个轮询周期，请求数不再增长。
  const 卸载后请求数 = 计数.value
  await 等(600)
  assert.equal(计数.value, 卸载后请求数)

  // 装配标记已复位，同一个模块对象可以再装一次，监听仍然只有一份。
  const 清理2 = []
  模块.apply({ effect: (工厂) => { 清理2.push(工厂()) } })
  await 等(30)
  assert.equal(页面.文档监听.mousemove.length, 1)
  assert.equal(页面.窗口监听.blur.length, 1)
  assert.ok(页面.document.getElementById('dsr-overlay'))
  for (const 清理函数 of 清理2) 清理函数()
  assert.equal(页面.文档监听.mousemove.length, 0)
})
