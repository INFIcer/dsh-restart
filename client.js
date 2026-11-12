// 客户端界面：纯 DOM（不注册任何官方槽位，不 require react）。
//
// 为什么要纯 DOM：主人讨厌抢占官方槽位，纯 DOM 挂一个 fixed 遮罩是改动最小、
// 最不影响别的插件的方式（dsh-notify-me 已经证明这样能跑）。
//
// 职责：
//  - 每 400ms 轮询宿主 /dsh-restart/state，画模态框 / 左下悬浮条 / 倒计时；
//  - 有任务时自动展开，并 POST /dialog-open（宿主把 <5 秒的任务抬回 5 秒）；
//  - 弹窗收起时在左侧栏底部留一条悬浮条，显示最短的剩余倒计时，点击再展开；
//  - document 级 mousemove：节流 200ms 发 /pause；停止移动 1 秒发 /resume；
//  - 每个任务一个「取消」按钮 → POST /cancel；任务清空时自动隐藏。

const routePrefix = '/dsh-restart'
const pollMs = 400
const mouseThrottleMs = 200
const mouseResumeMs = 1000
const overlayId = 'dsr-overlay'
const hintId = 'dsr-hint'
const styleId = 'dsr-style'

// 悬浮条钉在左侧栏底部、用户头像行上方的那块空白里：左侧栏约 257px 宽、底部头像行约 44px 高，
// left 16px + bottom 60px 正好落在两者之间；侧栏变窄时靠 max-width 加省略号兜底。
const hintLeft = '16px'
const hintBottom = '60px'
const hintMaxWidth = '225px'

var assembled = false

/** 造元素的小工具：属性都用 textContent，避免把会话标题当 HTML 解析（防 XSS）。 */
function makeEl(label, className, text) {
  const node = document.createElement(label)
  if (className) node.className = className
  if (text != null) node.textContent = String(text)
  return node
}

function injectStyles() {
  if (document.getElementById(styleId)) return
  const styleEl = document.createElement('style')
  styleEl.id = styleId
  styleEl.textContent = `
#${overlayId}{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(8,10,16,.42);backdrop-filter:blur(2px);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;}
#${overlayId}[hidden],#${hintId}[hidden]{display:none !important;}
#${overlayId} .dsr-card{width:min(560px,calc(100vw - 48px));max-height:min(70vh,640px);overflow:auto;border-radius:14px;
  background:#1b1e26;color:#e8eaf0;box-shadow:0 24px 64px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08);}
#${overlayId} .dsr-head{display:flex;align-items:center;gap:10px;padding:16px 18px 10px;}
#${overlayId} .dsr-title{font-size:16px;font-weight:600;flex:1;}
#${overlayId} .dsr-phase{font-size:12px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.08);color:#c9d3e6;}
#${overlayId} .dsr-phase.dsr-warn{background:rgba(255,186,66,.16);color:#ffcf7a;}
#${overlayId} .dsr-tip{padding:0 18px 10px;color:#9aa4b6;font-size:12px;}
#${overlayId} .dsr-list{list-style:none;margin:0;padding:0 12px 6px;}
#${overlayId} .dsr-row{display:flex;align-items:flex-start;gap:10px;padding:10px 8px;border-top:1px solid rgba(255,255,255,.06);}
#${overlayId} .dsr-row:first-child{border-top:none;}
#${overlayId} .dsr-who{font-weight:600;color:#dbe4f5;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#${overlayId} .dsr-why{color:#8d97a9;font-size:12px;word-break:break-word;}
#${overlayId} .dsr-main{flex:1;min-width:0;}
#${overlayId} .dsr-sec{font-variant-numeric:tabular-nums;font-size:18px;font-weight:600;color:#7ee0a8;white-space:nowrap;}
#${overlayId} .dsr-sec.dsr-paused{color:#ffcf7a;}
#${overlayId} .dsr-sec.dsr-waiting{font-size:13px;color:#9aa4b6;font-weight:500;}
#${overlayId} .dsr-btn{cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e8eaf0;
  border-radius:8px;padding:5px 10px;font-size:12px;white-space:nowrap;}
#${overlayId} .dsr-btn:hover{background:rgba(255,255,255,.12);}
#${overlayId} .dsr-btn.dsr-danger:hover{background:rgba(255,90,90,.18);border-color:rgba(255,90,90,.4);}
#${overlayId} .dsr-foot{display:flex;align-items:center;gap:10px;padding:12px 18px 16px;color:#8d97a9;font-size:12px;}
#${overlayId} .dsr-foot .dsr-spacer{flex:1;}
#${overlayId} .dsr-session{color:#6f7a8d;font-size:11px;}
#${hintId}{position:fixed;left:${hintLeft};bottom:${hintBottom};z-index:2147482999;cursor:pointer;
  display:flex;align-items:center;gap:8px;max-width:${hintMaxWidth};padding:6px 12px;border-radius:999px;
  background:rgba(24,28,38,.92);color:#e8eaf0;border:1px solid rgba(255,255,255,.12);
  box-shadow:0 8px 24px rgba(0,0,0,.35);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;}
#${hintId}:hover{background:rgba(38,44,58,.96);border-color:rgba(255,255,255,.22);}
#${hintId}:focus-visible{outline:2px solid #7ee0a8;outline-offset:2px;}
#${hintId} .dsr-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#7ee0a8;}
#${hintId}.dsr-paused .dsr-dot{background:#8d97a9;}
#${hintId} .dsr-hint-text{min-width:0;overflow:hidden;text-overflow:ellipsis;}
`
  ;(document.head || document.documentElement).appendChild(styleEl)
}

function getOverlay() {
  let overlay = document.getElementById(overlayId)
  if (overlay) return overlay
  overlay = makeEl('div')
  overlay.id = overlayId
  overlay.hidden = true
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', 'DSH 重启倒计时')
  ;(document.body || document.documentElement).appendChild(overlay)
  return overlay
}

/** 左下悬浮条：同一个元素既显示最短的剩余倒计时，也是重新打开弹窗的入口。 */
function getHint() {
  let hint = document.getElementById(hintId)
  if (hint) return hint
  hint = makeEl('div')
  hint.id = hintId
  hint.hidden = true
  hint.setAttribute('role', 'status')
  hint.setAttribute('aria-live', 'polite')
  hint.setAttribute('tabindex', '0')
  hint.title = '点击打开重启面板'
  ;(document.body || document.documentElement).appendChild(hint)
  return hint
}

/** 暂停是全局的：state.paused 为真或 phase 为 paused 时，所有任务的倒计时都停着。 */
function isPaused(state) {
  return state?.paused === true || String(state?.phase) === 'paused'
}

/** 状态文案。 */
function phaseText(state) {
  const phase = String(state?.phase || 'idle')
  if (phase === 'waiting') return `等待中（还有 ${Number(state?.busyCount) || 0} 个会话在跑）`
  if (phase === 'countdown') return `倒计时中${state?.paused ? '（已暂停）' : ''}`
  if (phase === 'paused') return '已暂停'
  if (phase === 'firing') return '正在重启…'
  return '空闲'
}

function remainingText(task, state) {
  if (!task || task.remainingMs == null) return { text: waitingText, cssClass: 'dsr-waiting' }
  const seconds = Math.max(0, Math.ceil(Number(task.remainingMs) / 1000))
  const pause = state?.paused === true || String(state?.phase) === 'paused'
  return { text: `${seconds} 秒`, cssClass: pause ? 'dsr-paused' : '' }
}

// ———————————————————————— 与宿主通信 ————————————————————————

async function request(filePath, options) {
  try {
    const response = await fetch(`${routePrefix}${filePath}`, {
      method: options?.method || 'GET',
      headers: options?.body ? { 'content-type': 'application/json' } : undefined,
      body: options?.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return { ok: false, error: `返回不是 JSON（HTTP ${response.status}）` }
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

// ———————————————————————— 渲染 ————————————————————————

const ui = {
  open: false,
  /** 上一次快照，用于判断任务从无到有 */
  lastSnapshot: null,
  lastTaskCount: 0,
  /** 是否已经为这一批任务发过 dialog-open */
  raisedRequested: false,
  /** 正在取消中的任务 id，避免重复点 */
  cancelling: new Set(),
  /** 「立即重启」的二次确认状态：点一次变成确认，3 秒不点自动复原 */
  nowConfirm: false,
  nowConfirmTimer: null,
  nowRunning: false,
  error: '',
  /** 悬浮条上一次画出的文案与暂停态，用来少碰 DOM（aria-live 每屏都重建会重复播报）。 */
  hintText: '',
  hintPaused: null,
}

function collapse() {
  ui.open = false
  const overlay = document.getElementById(overlayId)
  if (overlay) overlay.hidden = true
  // 收起后立刻恢复悬浮条，不用等下一拍轮询。
  renderHint(ui.lastSnapshot, false)
}

function expand(state) {
  const overlay = getOverlay()
  ui.open = true
  overlay.hidden = false
  // 弹窗顶替悬浮条：同一时刻只留一个提示。
  renderHint(null, true)
  // 打开瞬间请宿主把不足 5 秒的任务抬回 5 秒（每次都请求，宿主自己幂等）。
  void request('/dialog-open', { method: 'POST' }).then((result) => {
    if (result?.snapshot) render(result.snapshot)
  })
  if (state) render(state)
}

function render(state) {
  const overlay = getOverlay()
  const tasks = Array.isArray(state?.tasks) ? state.tasks : []
  const hasTasks = tasks.length > 0

  if (!hasTasks) {
    overlay.hidden = true
    ui.open = false
    ui.lastTaskCount = 0
    ui.raisedRequested = false
    renderHint(state, false)
    return
  }

  if (ui.lastTaskCount === 0 && !ui.open) {
    // 任务从无到有：自动展开（展开里会 POST dialog-open），悬浮条随之隐藏。
    expand(state)
    return
  }
  ui.lastTaskCount = tasks.length
  // 弹窗收起时用左下悬浮条显示最短的剩余倒计时；展开时让位给弹窗。
  renderHint(state, ui.open)

  // —— 重画卡片 ——
  const card = makeEl('div', 'dsr-card')
  const head = makeEl('div', 'dsr-head')
  head.appendChild(makeEl('div', 'dsr-title', 'DSH 重启倒计时'))
  const phase = makeEl('div', 'dsr-phase', phaseText(state))
  if (isPaused(state)) phase.classList.add('dsr-warn')
  head.appendChild(phase)
  card.appendChild(head)

  const hint = makeEl(
    'div',
    'dsr-tip',
    isPaused(state)
      ? '已暂停：鼠标在动时倒计时不走，停下 1 秒后自动继续。'
      : '鼠标一移动，所有倒计时都会暂停；停 1 秒后自动恢复。',
  )
  card.appendChild(hint)

  const list = makeEl('ul', 'dsr-list')
  for (const task of tasks) {
    const row = makeEl('li', 'dsr-row')
    const selfHost = makeEl('div', 'dsr-main')
    const headRow = makeEl('div')
    headRow.style.display = 'flex'
    headRow.style.gap = '8px'
    headRow.style.alignItems = 'baseline'
    headRow.appendChild(makeEl('span', 'dsr-who', task.sessionLabel || '未知会话'))
    const sessionShortId = String(task.sessionId || '').replace(/^session-/, '').slice(0, 6)
    if (task.sessionLabel && sessionShortId) headRow.appendChild(makeEl('span', 'dsr-session', `（${sessionShortId}）`))
    selfHost.appendChild(headRow)
    const description = task.reason || task.wakeText || '没有备注'
    selfHost.appendChild(makeEl('div', 'dsr-why', description))
    row.appendChild(selfHost)

    const remaining = remainingText(task, state)
    const seconds = makeEl('div', `dsr-sec ${remaining.cssClass}`.trim(), remaining.text)
    row.appendChild(seconds)
    if (isPaused(state)) {
      row.appendChild(makeEl('span', 'dsr-session', '已暂停'))
    }

    const cancelButton = makeEl('button', 'dsr-btn dsr-danger', ui.cancelling.has(task.id) ? '取消中…' : '取消')
    cancelButton.type = 'button'
    cancelButton.disabled = ui.cancelling.has(task.id)
    cancelButton.addEventListener('click', () => {
      ui.cancelling.add(task.id)
      cancelButton.disabled = true
      cancelButton.textContent = '取消中…'
      void request('/cancel', { method: 'POST', body: { taskId: task.id } }).then((result) => {
        ui.cancelling.delete(task.id)
        if (!result?.ok) {
          ui.error = String(result?.error || '取消失败')
        }
        void pollOnce()
      })
    })
    row.appendChild(cancelButton)
    list.appendChild(row)
  }
  card.appendChild(list)

  const foot = makeEl('div', 'dsr-foot')
  foot.appendChild(makeEl('span', null, ui.error || '每个任务都能单独取消；取消会给你发一条反馈。'))
  const spacer = makeEl('span', 'dsr-spacer')
  foot.appendChild(spacer)
  const nowButton = makeEl(
    'button',
    'dsr-btn dsr-danger',
    ui.nowRunning ? '重启中…' : ui.nowConfirm ? '再点一次：立即重启' : '立即重启',
  )
  nowButton.type = 'button'
  nowButton.disabled = ui.nowRunning
  nowButton.title = '跳过等待和倒计时，马上重启；会中断正在运行的会话，重启后会话会被唤醒。'
  nowButton.addEventListener('click', () => {
    if (ui.nowRunning) return
    if (!ui.nowConfirm) {
      ui.nowConfirm = true
      if (ui.nowConfirmTimer) clearTimeout(ui.nowConfirmTimer)
      ui.nowConfirmTimer = setTimeout(() => {
        ui.nowConfirm = false
        ui.nowConfirmTimer = null
        render(ui.lastSnapshot)
      }, 3000)
      render(ui.lastSnapshot)
      return
    }
    if (ui.nowConfirmTimer) {
      clearTimeout(ui.nowConfirmTimer)
      ui.nowConfirmTimer = null
    }
    ui.nowConfirm = false
    ui.nowRunning = true
    nowButton.textContent = '重启中…'
    nowButton.disabled = true
    void request('/now', { method: 'POST' }).then((result) => {
      if (!result || result.ok !== true) {
        ui.nowRunning = false
        ui.nowConfirm = false
        ui.error = String(result?.error || '立即重启失败')
        render(ui.lastSnapshot)
      }
    })
  })
  foot.appendChild(nowButton)
  const collapseButton = makeEl('button', 'dsr-btn', '收起')
  collapseButton.type = 'button'
  collapseButton.addEventListener('click', () => collapse())
  foot.appendChild(collapseButton)
  card.appendChild(foot)

  overlay.textContent = ''
  overlay.appendChild(card)
}

// ———————————————————————— 悬浮条 ————————————————————————
//
// 下面四个是纯函数（入参出参都不碰 DOM），单测直接调；renderHint 只负责把它们的结果画出来。

/** 任务的剩余毫秒；还没开始倒计时的任务是 null（宿主在等所有会话空闲）。 */
function remainingOf(task) {
  if (!task || task.remainingMs == null) return null
  const ms = Number(task.remainingMs)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, ms)
}

/**
 * 从任务列表里挑剩余时间最短的那个。
 * 规则：
 *  - 有 remainingMs 的按数值比较；暂停时宿主保留的是暂停前的剩余时间，不清零，所以排序不变；
 *  - 还没开始倒计时的（remainingMs 为 null）排在所有倒计时任务之后；
 *  - 全都还没开始倒计时时取第一个，也就是最早排的那个。
 */
function pickShortestTask(tasks) {
  if (!Array.isArray(tasks)) return null
  let best = null
  let bestMs = null
  for (const task of tasks) {
    if (!task) continue
    const ms = remainingOf(task)
    if (best === null) {
      best = task
      bestMs = ms
      continue
    }
    if (ms !== null && (bestMs === null || ms < bestMs)) {
      best = task
      bestMs = ms
    }
  }
  return best
}

/**
 * 倒计时文本：<1 小时用 mm:ss，≥1 小时用 h:mm:ss，到 0 停在 00:00。
 * 秒数向上取整：剩 1ms 也该显示 00:01，而不是提前一秒归零。
 */
function formatCountdown(remainingMs) {
  const totalSeconds = Math.ceil(Number(remainingMs) / 1000)
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '00:00'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value) => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(minutes)}:${pad(seconds)}`
}

/**
 * 悬浮条文案。暂停说「已暂停」，不写「挂起」。
 * 还没开始倒计时时没有剩余时间，用「等待会话空闲」代替时间。
 */
function hintText(task, paused) {
  const ms = remainingOf(task)
  if (ms === null) return paused ? 'DSH 重启 · 已暂停 · 等待会话空闲' : 'DSH 重启 · 等待会话空闲'
  return paused ? `DSH 重启 · 已暂停 ${formatCountdown(ms)}` : `DSH 重启 ${formatCountdown(ms)}`
}

/** 悬浮条的 title：说明点下去会发生什么；多任务时补一句还有几个。 */
function hintTitle(taskCount) {
  const others = Math.max(0, Number(taskCount) - 1)
  if (!Number.isFinite(others) || others === 0) return '点击打开重启面板'
  return `点击打开重启面板，另有 ${others} 个重启任务`
}

/**
 * 悬浮条唯一的更新入口：render / collapse / expand 都走这里，页面上始终只有一个提示元素。
 * open 为真（弹窗展开）时一律隐藏；任务为空时也隐藏。
 */
function renderHint(state, open) {
  const hint = getHint()
  const tasks = Array.isArray(state?.tasks) ? state.tasks : []
  const task = open ? null : pickShortestTask(tasks)
  if (!task) {
    hint.hidden = true
    ui.hintText = ''
    ui.hintPaused = null
    return
  }
  const paused = isPaused(state)
  const text = hintText(task, paused)
  hint.hidden = false
  if (ui.hintText !== text || ui.hintPaused !== paused) {
    ui.hintText = text
    ui.hintPaused = paused
    hint.classList.toggle('dsr-paused', paused)
    hint.textContent = ''
    hint.appendChild(makeEl('span', 'dsr-dot'))
    hint.appendChild(makeEl('span', 'dsr-hint-text', text))
  }
  hint.title = hintTitle(tasks.length)
}

// ———————————————————————— 轮询 ————————————————————————

let pollTimer = null
let consecutiveFailures = 0

async function pollOnce() {
  const state = await request('/state')
  if (!state || state.ok !== true) {
    consecutiveFailures += 1
    if (consecutiveFailures === 3) {
      ui.error = `连不上宿主（${String(state?.error || '未知错误')}）`
    }
    return
  }
  consecutiveFailures = 0
  ui.error = ''
  ui.lastSnapshot = state
  render(state)
}

function startPolling() {
  if (pollTimer) return
  void pollOnce()
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    void pollOnce()
  }, pollMs)
}

// ———————————————————————— 鼠标暂停 ————————————————————————

let lastPauseRequestAt = 0
let resumeTimer = null

function hasRunningTasks() {
  const snapshot = ui.lastSnapshot
  return Boolean(snapshot && Array.isArray(snapshot.tasks) && snapshot.tasks.length > 0)
}

function onMouseMove() {
  if (!hasRunningTasks()) return
  const now = Date.now()
  // 暂停状态在宿主侧生效（真的不减剩余时间），客户端每 200ms 才发一次。
  if (now - lastPauseRequestAt >= mouseThrottleMs) {
    lastPauseRequestAt = now
    void request('/pause', { method: 'POST' })
  }
  if (resumeTimer) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    void request('/resume', { method: 'POST' }).then(() => {
      void pollOnce()
    })
  }, mouseResumeMs)
}

function onBlur() {
  // 窗口失焦/切后台时不该一直暂停着。
  if (resumeTimer) {
    clearTimeout(resumeTimer)
    resumeTimer = null
  }
  void request('/resume', { method: 'POST' })
}

/** 返回卸载函数：dispose 时必须摘掉挂在 document/window 上的监听，否则重装会叠加多份。 */
function mountMouseListeners() {
  document.addEventListener('mousemove', onMouseMove, { passive: true })
  window.addEventListener('blur', onBlur)
  return function unmountMouseListeners() {
    document.removeEventListener('mousemove', onMouseMove, { passive: true })
    window.removeEventListener('blur', onBlur)
  }
}

// ———————————————————————— 入口 ————————————————————————

function apply(ctx) {
  try {
    if (assembled) return
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    assembled = true
    injectStyles()
    getOverlay()
    const hint = getHint()
    // 整条都可点；键盘上 Enter / Space 与点击等价（div 没有 button 的原生行为）。
    hint.addEventListener('click', () => expand(ui.lastSnapshot))
    hint.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
      event.preventDefault()
      expand(ui.lastSnapshot)
    })
    const unmountMouseListeners = mountMouseListeners()
    startPolling()

    // 插件卸载时把自己加的东西全部撤掉：定时器、全局监听、注入的节点，并复位装配标记，
    // 这样同一个页面里重新 apply 能干净地再装一次。
    try {
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            try {
              if (pollTimer) clearInterval(pollTimer)
              pollTimer = null
              if (resumeTimer) clearTimeout(resumeTimer)
              resumeTimer = null
              if (ui.nowConfirmTimer) clearTimeout(ui.nowConfirmTimer)
              ui.nowConfirmTimer = null
              unmountMouseListeners()
              for (const id of [overlayId, hintId, styleId]) {
                const node = document.getElementById(id)
                if (node && node.parentNode) node.parentNode.removeChild(node)
              }
              ui.lastSnapshot = null
              ui.lastTaskCount = 0
              ui.raisedRequested = false
              ui.cancelling.clear()
              ui.nowConfirm = false
              ui.nowRunning = false
              ui.error = ''
              ui.hintText = ''
              ui.hintPaused = null
              assembled = false
            } catch {
              /* 忽略 */
            }
          },
          'dsh-restart-plugin-client: dispose',
        )
      }
    } catch {
      /* 忽略 */
    }
  } catch (error) {
    try {
      console.warn('[dsh-restart-plugin] 客户端界面加载失败（已忽略）:', error)
    } catch {
      /* 忽略 */
    }
  }
}

var inject = []

// 浏览器里由 __ModuleLoader__ 调用 factory（客户端 bundle 是 classic script，
// 不能用 ESM export；注册必须发生在脚本执行时，否则宿主会认为该 bundle 没注册）。
const mod = { exports: {} }
mod.exports.apply = apply
mod.exports.inject = inject
mod.exports.name = 'dsh-restart-plugin'
// 纯函数导出：单测直接调用；浏览器里没有别的消费方。
mod.exports.hint = { pickShortestTask, formatCountdown, hintText, hintTitle }

try {
  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: 'dsh-restart-plugin',
      factory: () => mod.exports,
    })
  }
} catch (error) {
  try {
    console.warn('[dsh-restart-plugin] 注册客户端模块失败:', error)
  } catch {
    /* 忽略 */
  }
}
