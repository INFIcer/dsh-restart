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

/** 走同一条活动处理器的 document 事件（键盘另挂，因为还要处理 Esc）。 */
const activityEvents = ['mousemove', 'mousedown', 'wheel', 'touchstart', 'touchmove']

/** 每种输入监听各挂了几份。 */
function activityListenerCounts(page) {
  return activityEvents.map((eventName) => (page.docListeners[eventName] || []).length)
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

  // 鼠标移动、鼠标按键、滚轮、触摸共用同一个处理器；键盘单独一份。
  assert.deepEqual(activityListenerCounts(page), [1, 1, 1, 1, 1])
  assert.equal(page.docListeners.keydown.length, 1)
  assert.equal(page.winListeners.blur.length, 1)
  assert.ok(page.document.getElementById('dsr-overlay'))
  assert.ok(page.document.getElementById('dsr-hint'))
  assert.ok(page.document.getElementById('dsr-style'))
  assert.ok(counter.value >= 1)

  // 没有任务时输入不发暂停信号。
  const requestsBeforeInput = counter.value
  page.docListeners.mousemove[0]({})
  page.docListeners.keydown[0]({ key: 'a' })
  await sleep(20)
  assert.equal(counter.value, requestsBeforeInput)

  for (const disposeFn of cleanup) disposeFn()

  assert.deepEqual(activityListenerCounts(page), [0, 0, 0, 0, 0])
  assert.equal(page.docListeners.keydown.length, 0)
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
  assert.deepEqual(activityListenerCounts(page), [1, 1, 1, 1, 1])
  assert.equal(page.winListeners.blur.length, 1)
  assert.ok(page.document.getElementById('dsr-overlay'))
  for (const disposeFn of cleanup2) disposeFn()
  assert.deepEqual(activityListenerCounts(page), [0, 0, 0, 0, 0])
})

test('client：任何输入都会暂停倒计时，停止输入 1 秒后恢复', async () => {
  const page = makePage()
  const state = {
    ok: true,
    phase: 'countdown',
    paused: false,
    busyCount: 0,
    tasks: [{ id: 'task-1', sessionId: 'session-a', sessionLabel: '会话 A', remainingMs: 20000, reason: '测试' }],
  }
  const calls = []
  const mod = startClient(page, async (url, options) => {
    calls.push({ url: String(url), method: options?.method || 'GET' })
    const body = String(url).endsWith('/state') ? state : { ok: true }
    return { status: 200, text: async () => JSON.stringify(body) }
  })
  const cleanup = []
  mod.apply({ effect: (factory) => { cleanup.push(factory()) } })
  await sleep(50)

  const pauseCount = () => calls.filter((call) => call.url.endsWith('/pause')).length
  const before = pauseCount()
  // 同一瞬间的多种输入只发一次暂停（节流 200ms）；键盘也走同一条暂停路径。
  page.docListeners.mousemove[0]({})
  page.docListeners.mousedown[0]({})
  page.docListeners.wheel[0]({})
  page.docListeners.touchstart[0]({})
  page.docListeners.keydown[0]({ key: 'a' })
  await sleep(20)
  assert.equal(pauseCount(), before + 1)

  // 停止输入 1 秒后自动恢复，并顺手刷新一次快照。
  await sleep(1200)
  assert.ok(calls.some((call) => call.url.endsWith('/resume') && call.method === 'POST'))

  for (const disposeFn of cleanup) disposeFn()
})
