// 客户端装配/卸载测试：用 vm + 假 DOM 跑真实的 client.js，
// 验证 dispose 会摘掉全局监听并复位装配状态，否则重装会叠加多份。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makePage, startClient, sleep } from './fake-dom.js'

/** 任何请求都回一个空状态。 */
function idleFetch(counter) {
  return async () => {
    counter.value += 1
    return {
      status: 200,
      text: async () => JSON.stringify({ ok: true, phase: 'idle', tasks: [], paused: false, busyCount: 0 }),
    }
  }
}

test('client：apply 挂全局监听，dispose 后全部摘掉并可干净重装', async () => {
  const page = makePage()
  const counter = { value: 0 }
  const mod = startClient(page, idleFetch(counter))
  assert.equal(mod.name, 'dsh-restart-plugin')
  assert.ok(Array.isArray(mod.inject))

  const cleanup = []
  const ctx = { effect: (factory) => { cleanup.push(factory()) } }
  mod.apply(ctx)
  await sleep(30)

  assert.equal(page.docListeners.mousemove.length, 1)
  assert.equal(page.winListeners.blur.length, 1)
  assert.ok(page.document.getElementById('dsr-overlay'))
  assert.ok(page.document.getElementById('dsr-hint'))
  assert.ok(page.document.getElementById('dsr-style'))
  assert.ok(counter.value >= 1)

  for (const disposeFn of cleanup) disposeFn()

  assert.equal(page.docListeners.mousemove.length, 0)
  assert.equal(page.winListeners.blur.length, 0)
  assert.equal(page.document.getElementById('dsr-overlay'), null)
  assert.equal(page.document.getElementById('dsr-hint'), null)
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
