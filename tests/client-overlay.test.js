// 重启面板的遮罩显示与兜底交互：用 vm + 假 DOM 跑真实的 client.js。
// 覆盖三件事：快照没回来时不亮遮罩、绘制抛错时必须收起、遮罩的鼠标/键盘兜底收起。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makePage, startClient, findNode, sleep } from './fake-dom.js'

function responseFor(body) {
  return { status: 200, text: async () => JSON.stringify(body) }
}

function makeTask(overrides) {
  return { id: 'task-1', sessionId: 'session-abc123', sessionLabel: '会话 A', remainingMs: 9000, reason: '改完了', ...overrides }
}

function makeState(tasks) {
  return { ok: true, phase: 'countdown', paused: false, busyCount: 0, tasks }
}

/** 装配并等待第一拍轮询完成；返回清理函数。 */
async function mount(page, fetchImpl, waitMs = 50) {
  const mod = startClient(page, fetchImpl)
  const cleanup = []
  mod.apply({ effect: (factory) => { cleanup.push(factory()) } })
  await sleep(waitMs)
  return () => {
    for (const disposeFn of cleanup) disposeFn()
  }
}

function overlayOf(page) {
  return page.document.getElementById('dsr-overlay')
}

function hintOf(page) {
  return page.document.getElementById('dsr-hint')
}

test('还有会话在跑时不弹窗：只留悬浮条，点开后才画得出等待中的卡片', async () => {
  const page = makePage()
  const state = { ok: true, phase: 'waiting', paused: false, busyCount: 2, tasks: [makeTask({ remainingMs: null })] }
  const unmount = await mount(page, async (url) => responseFor(String(url).endsWith('/state') ? state : { ok: true }))

  const overlay = overlayOf(page)
  const hint = hintOf(page)
  // 等会话空闲期间不弹窗，只在左下角提示，别挡住正在干活的人。
  assert.equal(overlay.hidden, true)
  assert.equal(hint.hidden, false)
  // 等待会话空闲也算暂停：悬浮条与输入暂停同一种写法、同一个暂停色。
  assert.equal(hint.children[1].textContent, 'DSH 重启 · 已暂停 · 等待会话空闲')
  assert.equal(hint.classList.contains('dsr-paused'), true)

  // 手动点开才画卡片；等待中的任务按暂停态画（remainingMs 为 null 不抛错）。
  hint.listeners.click[0]()
  await sleep(30)
  assert.equal(overlay.hidden, false)
  const card = findNode(overlay, (node) => node.className === 'dsr-card')
  assert.ok(card)
  const badge = findNode(card, (node) => node.className === 'dsr-phase')
  assert.equal(badge.textContent, '已暂停（等待会话空闲）')
  assert.equal(badge.classList.contains('dsr-warn'), true)
  const tip = findNode(card, (node) => node.className === 'dsr-tip')
  assert.equal(tip.textContent, '已暂停：还有 2 个会话在跑，等它们都空闲后开始倒计时。')
  const waitingCell = findNode(card, (node) => String(node.className).includes('dsr-waiting'))
  assert.ok(waitingCell)
  assert.equal(waitingCell.textContent, '已暂停')
  assert.ok(String(waitingCell.className).includes('dsr-paused'), '等待中的暂停也要用暂停色')

  // 还有会话在跑时「立即重启」必须不可点，并说明原因。
  const nowButton = findNode(card, (node) => node.labelName === 'button' && node.textContent === '立即重启')
  assert.ok(nowButton)
  assert.equal(nowButton.disabled, true)
  assert.match(nowButton.title, /2 个会话在跑/)

  unmount()
})

test('倒计时途中会话变忙：倒计时停住，面板与悬浮条都改写成已暂停', async () => {
  const page = makePage()
  const state = makeState([makeTask({ remainingMs: 12000 })])
  const unmount = await mount(page, async (url) => responseFor(String(url).endsWith('/state') ? state : { ok: true }))

  const overlay = overlayOf(page)
  const hint = hintOf(page)
  assert.equal(overlay.hidden, false)
  const badge = findNode(overlay, (node) => node.className === 'dsr-phase')
  assert.equal(badge.textContent, '倒计时中')
  const runningTip = findNode(overlay, (node) => node.className === 'dsr-tip')
  assert.equal(runningTip.textContent, '操作鼠标或键盘时，倒计时会暂停。')

  // 有会话开始跑 → 宿主把 phase 打回 waiting，剩余时间冻结不动。
  state.phase = 'waiting'
  state.busyCount = 1
  await sleep(500)
  // 重新查节点：每次渲染都会重建卡片，之前抓到的引用已经脱离文档。
  const pausedBadge = findNode(overlay, (node) => node.className === 'dsr-phase')
  assert.equal(pausedBadge.textContent, '已暂停（等待会话空闲）')
  assert.equal(pausedBadge.classList.contains('dsr-warn'), true)
  const tip = findNode(overlay, (node) => node.className === 'dsr-tip')
  assert.equal(tip.textContent, '已暂停：还有 1 个会话在跑，等它们都空闲后开始倒计时。')
  const secondsCell = findNode(overlay, (node) => node.className === 'dsr-sec dsr-paused')
  assert.ok(secondsCell)
  assert.equal(secondsCell.textContent, '12 秒')
  // 秒数旁边补一句「已暂停」：颜色之外再给一个文字标记。
  assert.ok(findNode(overlay, (node) => node.textContent === '已暂停' && node.className === 'dsr-session'))

  // 收起后用悬浮条看：同样写已暂停，并写明还在等会话。
  const collapseButton = findNode(overlay, (node) => node.labelName === 'button' && node.textContent === '收起')
  collapseButton.listeners.click[0]()
  await sleep(500)
  assert.equal(hint.hidden, false)
  assert.equal(hint.children[1].textContent, 'DSH 重启 · 已暂停 00:12')
  assert.equal(hint.classList.contains('dsr-paused'), true)

  unmount()
})

test('输入暂停：面板徽标、说明与悬浮条都用同一套暂停写法', async () => {
  const page = makePage()
  const state = makeState([makeTask({ remainingMs: 9000 })])
  const unmount = await mount(page, async (url) => responseFor(String(url).endsWith('/state') ? state : { ok: true }))

  const overlay = overlayOf(page)
  const hint = hintOf(page)
  state.paused = true
  state.phase = 'paused'
  await sleep(500)
  const badge = findNode(overlay, (node) => node.className === 'dsr-phase')
  assert.equal(badge.textContent, '已暂停')
  const tip = findNode(overlay, (node) => node.className === 'dsr-tip')
  assert.equal(tip.textContent, '已暂停：有鼠标或键盘操作，倒计时停住。')

  const collapseButton = findNode(overlay, (node) => node.labelName === 'button' && node.textContent === '收起')
  collapseButton.listeners.click[0]()
  await sleep(500)
  assert.equal(hint.children[1].textContent, 'DSH 重启 · 已暂停 00:09')
  assert.equal(hint.classList.contains('dsr-paused'), true)

  unmount()
})

test('等待中排下的任务：会话空闲开始倒计时后自动弹一次，收起后不再弹回来', async () => {
  const page = makePage()
  const state = { ok: true, phase: 'waiting', paused: false, busyCount: 1, tasks: [makeTask({ remainingMs: null })] }
  const unmount = await mount(page, async (url) => responseFor(String(url).endsWith('/state') ? state : { ok: true }))

  const overlay = overlayOf(page)
  assert.equal(overlay.hidden, true)

  // 会话空闲、开始倒计时 → 这时才自动展开。
  state.phase = 'countdown'
  state.busyCount = 0
  state.tasks = [makeTask({ remainingMs: 12000 })]
  await sleep(500)
  assert.equal(overlay.hidden, false)
  const nowButton = findNode(overlay, (node) => node.labelName === 'button' && node.textContent === '立即重启')
  assert.ok(nowButton)
  assert.equal(nowButton.disabled, false)

  // 用户收起后，同一批任务不再自动弹回来。
  const collapseButton = findNode(overlay, (node) => node.labelName === 'button' && node.textContent === '收起')
  assert.ok(collapseButton)
  collapseButton.listeners.click[0]()
  await sleep(500)
  assert.equal(overlay.hidden, true)
  assert.equal(hintOf(page).hidden, false)

  unmount()
})

test('没有快照时点悬浮条：先取快照，拿到之前不显示遮罩', async () => {
  const page = makePage()
  const pending = []
  const unmount = await mount(
    page,
    async (url) => {
      if (!String(url).endsWith('/state')) return responseFor({ ok: true })
      return new Promise((fulfil) => { pending.push(() => fulfil(responseFor(makeState([makeTask()])))) })
    },
    0,
  )
  const overlay = overlayOf(page)
  const hint = hintOf(page)
  assert.equal(overlay.hidden, true)

  hint.listeners.click[0]()
  await sleep(30)
  // 快照请求还挂在半路：遮罩必须保持收起。
  assert.equal(overlay.hidden, true)

  for (const resolveRequest of pending) resolveRequest()
  await sleep(50)
  // 拿到快照后才画卡片；同时说明最开始的轮询也拿到了同一份快照。
  assert.equal(overlay.hidden, false)
  assert.ok(findNode(overlay, (node) => node.className === 'dsr-card'))

  unmount()
})

test('拿不到快照时点悬浮条：保持收起，悬浮条显示可读错误且仍可点', async () => {
  const page = makePage()
  let stateRequests = 0
  const unmount = await mount(page, async (url) => {
    if (!String(url).endsWith('/state')) return responseFor({ ok: true })
    stateRequests += 1
    return responseFor({ ok: false, error: '宿主没起来' })
  })

  const overlay = overlayOf(page)
  const hint = hintOf(page)
  assert.equal(overlay.hidden, true)

  hint.listeners.click[0]()
  await sleep(30)
  assert.equal(overlay.hidden, true)
  assert.equal(hint.hidden, false)
  assert.match(hint.textContent, /连不上宿主/)

  const before = stateRequests
  hint.listeners.click[0]()
  await sleep(30)
  assert.ok(stateRequests > before, '错误态下悬浮条仍应可点，点了会重新取快照')
  assert.equal(overlay.hidden, true)

  unmount()
})

test('渲染抛错时遮罩必须保持隐藏，悬浮条给出可读错误', async () => {
  const page = makePage()
  const state = makeState([makeTask()])
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args) }

  const mod = startClient(page, async (url) => responseFor(String(url).endsWith('/state') ? state : { ok: true }))
  const cleanup = []
  mod.apply({ effect: (factory) => { cleanup.push(factory()) } })

  // 装配完成后让卡片构建必失败（div 建不出来），模拟真实环境里 render 半路抛错。
  const originalCreateElement = page.document.createElement
  page.document.createElement = (label) => {
    if (label === 'div') throw new Error('createElement 坏了')
    return originalCreateElement(label)
  }

  try {
    // 多等几拍：绘制失败后每一拍都会重试，但遮罩绝不能被点亮。
    await sleep(500)

    const overlay = overlayOf(page)
    const hint = hintOf(page)
    assert.equal(overlay.hidden, true)
    assert.equal(overlay.children.length, 0)
    assert.equal(hint.hidden, false)
    assert.match(hint.textContent, /面板绘制失败/)
    assert.ok(warnings.some((args) => String(args[0]).includes('重启面板绘制失败')))
  } finally {
    page.document.createElement = originalCreateElement
    for (const disposeFn of cleanup) disposeFn()
    console.warn = originalWarn
  }
})

test('点遮罩空白处或按 Esc 收起；点卡片内部不收起', async () => {
  const page = makePage()
  const state = makeState([makeTask()])
  const unmount = await mount(page, async (url) => responseFor(String(url).endsWith('/state') ? state : { ok: true }))

  const overlay = overlayOf(page)
  const hint = hintOf(page)
  assert.equal(overlay.hidden, false)

  // 点卡片内部不应收起
  const card = findNode(overlay, (node) => node.className === 'dsr-card')
  overlay.listeners.click[0]({ target: card })
  assert.equal(overlay.hidden, false)

  // 点遮罩空白处收起，悬浮条接管
  overlay.listeners.click[0]({ target: overlay })
  assert.equal(overlay.hidden, true)
  assert.equal(hint.hidden, false)

  // 悬浮条重新打开后用 Esc 收起
  hint.listeners.click[0]()
  await sleep(20)
  assert.equal(overlay.hidden, false)
  page.docListeners.keydown[0]({ key: 'Escape' })
  assert.equal(overlay.hidden, true)
  assert.equal(hint.hidden, false)

  unmount()
})

test('连续三次请求失败时遮罩自动收起，悬浮条提示连不上宿主', async () => {
  const page = makePage()
  const state = makeState([makeTask()])
  let failing = false
  const unmount = await mount(page, async (url) => {
    if (!String(url).endsWith('/state')) return responseFor({ ok: true })
    return responseFor(failing ? { ok: false, error: '宿主没起来' } : state)
  })

  const overlay = overlayOf(page)
  const hint = hintOf(page)
  assert.equal(overlay.hidden, false)

  failing = true
  await sleep(1500)
  assert.equal(overlay.hidden, true)
  assert.equal(hint.hidden, false)
  assert.match(hint.textContent, /连不上宿主/)

  unmount()
})

test('页面切到后台不轮询，回到前台后继续按快照更新', async () => {
  const page = makePage()
  const state = makeState([makeTask()])
  let requests = 0
  const unmount = await mount(page, async (url) => {
    if (!String(url).endsWith('/state')) return responseFor({ ok: true })
    requests += 1
    return responseFor(state)
  })

  const overlay = overlayOf(page)
  assert.equal(overlay.hidden, false)

  page.document.hidden = true
  const backgroundRequests = requests
  await sleep(900)
  assert.equal(requests, backgroundRequests, '切到后台后不再轮询')

  state.tasks = []
  page.document.hidden = false
  await sleep(600)
  assert.equal(overlay.hidden, true)
  assert.equal(hintOf(page).hidden, true)

  unmount()
})
