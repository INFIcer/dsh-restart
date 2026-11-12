// 左下悬浮条：纯函数（挑最短任务 / 格式化倒计时 / 文案）与收起弹窗后的显示行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makePage, startClient, loadClientModule, findNode, sleep } from './fake-dom.js'

/** 悬浮条上显示的那段文字（状态点之后的第二个子节点）。 */
function hintLabel(hint) {
  return hint.children[1] ? hint.children[1].textContent : ''
}

test('pickShortestTask：取剩余最短的，还没开始倒计时的排最后', () => {
  const { hint } = loadClientModule()

  const tasks = [
    { id: 'a', remainingMs: 9000 },
    { id: 'b', remainingMs: 3000 },
    { id: 'c', remainingMs: null },
  ]
  assert.equal(hint.pickShortestTask(tasks).id, 'b')
  assert.equal(hint.pickShortestTask([{ id: 'c', remainingMs: null }]).id, 'c')
  // 平手取靠前的，顺序稳定
  assert.equal(hint.pickShortestTask([{ id: 'x', remainingMs: 5000 }, { id: 'y', remainingMs: 5000 }]).id, 'x')
  // 全都还没开始倒计时 → 取最早排的那个
  assert.equal(hint.pickShortestTask([{ id: 'x', remainingMs: null }, { id: 'y', remainingMs: null }]).id, 'x')
  // 坏数据不参与比较
  assert.equal(hint.pickShortestTask([{ id: 'bad', remainingMs: 'abc' }, { id: 'ok', remainingMs: 7000 }]).id, 'ok')
  assert.equal(hint.pickShortestTask([]), null)
  assert.equal(hint.pickShortestTask(null), null)
  assert.equal(hint.pickShortestTask([null, undefined]), null)
})

test('formatCountdown：分钟以内用 mm:ss，超过一小时用 h:mm:ss，到 0 停在 00:00', () => {
  const { hint } = loadClientModule()

  assert.equal(hint.formatCountdown(32000), '00:32')
  assert.equal(hint.formatCountdown(1000), '00:01')
  // 还剩 1 毫秒也显示 00:01，不提前一秒归零
  assert.equal(hint.formatCountdown(1), '00:01')
  assert.equal(hint.formatCountdown(0), '00:00')
  assert.equal(hint.formatCountdown(-5000), '00:00')
  assert.equal(hint.formatCountdown(59000), '00:59')
  assert.equal(hint.formatCountdown(60000), '01:00')
  assert.equal(hint.formatCountdown(3599000), '59:59')
  assert.equal(hint.formatCountdown(3600000), '1:00:00')
  assert.equal(hint.formatCountdown(7323000), '2:02:03')
  assert.equal(hint.formatCountdown(null), '00:00')
  assert.equal(hint.formatCountdown('abc'), '00:00')
})

test('hintText：运行态与暂停态文案，暂停写「已暂停」', () => {
  const { hint } = loadClientModule()

  assert.equal(hint.hintText({ remainingMs: 32000 }, false), 'DSH 重启 00:32')
  assert.equal(hint.hintText({ remainingMs: 32000 }, true), 'DSH 重启 · 已暂停 00:32')
  assert.equal(hint.hintText({ remainingMs: 0 }, false), 'DSH 重启 00:00')
  assert.equal(hint.hintText({ remainingMs: null }, false), 'DSH 重启 · 等待会话空闲')
  assert.equal(hint.hintText({ remainingMs: null }, true), 'DSH 重启 · 已暂停 · 等待会话空闲')
  assert.equal(hint.hintText(null, false), 'DSH 重启 · 等待会话空闲')
})

test('hintTitle：多任务时补一句还有几个', () => {
  const { hint } = loadClientModule()

  assert.equal(hint.hintTitle(1), '点击打开重启面板')
  assert.equal(hint.hintTitle(0), '点击打开重启面板')
  assert.equal(hint.hintTitle(3), '点击打开重启面板，另有 2 个重启任务')
})

test('悬浮条：任务出现时自动展开；收起后显示最短倒计时，点击或按 Enter 再展开', async () => {
  const page = makePage()
  const state = {
    ok: true,
    phase: 'countdown',
    paused: false,
    busyCount: 0,
    tasks: [
      { id: 'late', sessionLabel: '会话 A', remainingMs: 90000, reason: '改完了' },
      { id: 'soon', sessionLabel: '会话 B', remainingMs: 32000, reason: '发版' },
    ],
  }
  const calls = []
  const mod = startClient(page, async (url, options) => {
    calls.push({ url, method: options?.method || 'GET' })
    const body = String(url).endsWith('/state') ? state : { ok: true }
    return { status: 200, text: async () => JSON.stringify(body) }
  })

  const cleanup = []
  mod.apply({ effect: (factory) => { cleanup.push(factory()) } })
  await sleep(30)

  const hint = page.document.getElementById('dsr-hint')
  const overlay = page.document.getElementById('dsr-overlay')
  assert.ok(hint)
  assert.equal(hint.attrs.role, 'status')
  assert.equal(hint.attrs['aria-live'], 'polite')
  assert.equal(hint.attrs.tabindex, '0')
  // 自动展开时悬浮条隐藏（同一时刻只有一个提示）
  assert.equal(overlay.hidden, false)
  assert.equal(hint.hidden, true)
  assert.equal(page.document.getElementById('dsr-badge'), null)

  // 收起弹窗 → 立刻显示最短的那个任务（32 秒），并提示还有 1 个
  const collapseButton = findNode(overlay, (node) => node.labelName === 'button' && node.textContent === '收起')
  assert.ok(collapseButton)
  collapseButton.listeners.click[0]()
  assert.equal(overlay.hidden, true)
  assert.equal(hint.hidden, false)
  assert.equal(hintLabel(hint), 'DSH 重启 00:32')
  assert.equal(hint.title, '点击打开重启面板，另有 1 个重启任务')
  assert.equal(hint.classList.contains('dsr-paused'), false)

  // 点悬浮条 → 重新展开，悬浮条让位
  hint.listeners.click[0]()
  assert.equal(overlay.hidden, false)
  assert.equal(hint.hidden, true)
  assert.ok(calls.some((item) => item.url.endsWith('/dialog-open') && item.method === 'POST'))

  // 键盘 Enter / Space 同样能打开
  collapseButton.listeners.click[0]()
  hint.listeners.keydown[0]({ key: 'Enter', preventDefault() {} })
  assert.equal(overlay.hidden, false)
  collapseButton.listeners.click[0]()
  hint.listeners.keydown[0]({ key: ' ', preventDefault() {} })
  assert.equal(overlay.hidden, false)

  // 暂停时换文案与颜色，倒计时保持暂停前的剩余时间
  collapseButton.listeners.click[0]()
  state.paused = true
  state.phase = 'paused'
  await sleep(500)
  assert.equal(hint.hidden, false)
  assert.equal(hintLabel(hint), 'DSH 重启 · 已暂停 00:32')
  assert.equal(hint.classList.contains('dsr-paused'), true)

  // 任务消失 → 悬浮条隐藏
  state.tasks = []
  await sleep(500)
  assert.equal(hint.hidden, true)

  for (const disposeFn of cleanup) disposeFn()
  assert.equal(page.document.getElementById('dsr-hint'), null)
})
