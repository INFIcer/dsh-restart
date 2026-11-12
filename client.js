// 客户端界面：纯 DOM（不注册任何官方槽位，不 require react）。
//
// 为什么要纯 DOM：主人讨厌抢占官方槽位，纯 DOM 挂一个 fixed 遮罩是改动最小、
// 最不影响别的插件的方式（dsh-notify-me 已经证明这样能跑）。
//
// 职责：
//  - 每 400ms 轮询宿主 /dsh-restart/state，画模态框 / 收起徽标 / 倒计时；
//  - 有任务时自动展开，并 POST /dialog-open（宿主把 <5 秒的任务抬回 5 秒）；
//  - document 级 mousemove：节流 200ms 发 /pause；停止移动 1 秒发 /resume；
//  - 每个任务一个「取消」按钮 → POST /cancel；任务清空时自动隐藏。

const routePrefix = '/dsh-restart'
const pollMs = 400
const mouseThrottleMs = 200
const mouseResumeMs = 1000
const overlayId = 'dsr-overlay'
const badgeId = 'dsr-badge'
const styleId = 'dsr-style'

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
#${overlayId}[hidden],#${badgeId}[hidden]{display:none !important;}
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
#${badgeId}{position:fixed;top:14px;right:16px;z-index:2147483000;cursor:pointer;display:flex;align-items:center;gap:6px;
  padding:6px 10px;border-radius:999px;background:rgba(24,28,38,.92);color:#e8eaf0;border:1px solid rgba(255,255,255,.12);
  box-shadow:0 8px 24px rgba(0,0,0,.35);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;}
#${badgeId} .dsr-dot{width:8px;height:8px;border-radius:50%;background:#7ee0a8;}
#${badgeId}.dsr-paused .dsr-dot{background:#ffcf7a;}
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

function getBadge() {
  let badge = document.getElementById(badgeId)
  if (badge) return badge
  badge = makeEl('button')
  badge.id = badgeId
  badge.type = 'button'
  badge.hidden = true
  ;(document.body || document.documentElement).appendChild(badge)
  return badge
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
}

function collapse() {
  ui.open = false
  const overlay = document.getElementById(overlayId)
  if (overlay) overlay.hidden = true
}

function expand(state) {
  const overlay = getOverlay()
  const badge = getBadge()
  ui.open = true
  overlay.hidden = false
  badge.hidden = true
  // 打开瞬间请宿主把不足 5 秒的任务抬回 5 秒（每次都请求，宿主自己幂等）。
  void request('/dialog-open', { method: 'POST' }).then((result) => {
    if (result?.snapshot) render(result.snapshot)
  })
  if (state) render(state)
}

function render(state) {
  const overlay = getOverlay()
  const badge = getBadge()
  const tasks = Array.isArray(state?.tasks) ? state.tasks : []
  const hasTasks = tasks.length > 0

  if (!hasTasks) {
    overlay.hidden = true
    badge.hidden = true
    ui.open = false
    ui.lastTaskCount = 0
    ui.raisedRequested = false
    return
  }

  // 有任务但界面被收起了 → 显示徽标；从未展开过 → 自动展开并请求抬秒。
  if (!ui.open) {
    badge.hidden = false
    badge.classList.toggle('dsr-paused', state?.paused === true)
    badge.textContent = ''
    const dot = makeEl('span', 'dsr-dot')
    const labelEl = makeEl('span', null, `重启 ${shortestRemainingText(state)}`)
    badge.appendChild(dot)
    badge.appendChild(labelEl)
  } else {
    badge.hidden = true
  }

  if (ui.lastTaskCount === 0 && !ui.open) {
    // 任务从无到有：自动展开（展开里会 POST dialog-open）。
    expand(state)
    return
  }
  ui.lastTaskCount = tasks.length

  // —— 重画卡片 ——
  const card = makeEl('div', 'dsr-card')
  const head = makeEl('div', 'dsr-head')
  head.appendChild(makeEl('div', 'dsr-title', 'DSH 重启倒计时'))
  const phase = makeEl('div', 'dsr-phase', phaseText(state))
  if (state?.paused === true || String(state?.phase) === 'paused') phase.classList.add('dsr-warn')
  head.appendChild(phase)
  card.appendChild(head)

  const hint = makeEl(
    'div',
    'dsr-tip',
    state?.paused === true || String(state?.phase) === 'paused'
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
    if (state?.paused === true || String(state?.phase) === 'paused') {
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

function shortestRemainingText(state) {
  const remaining = Number(state?.nearestRemainingSeconds)
  if (Number.isFinite(remaining)) return `${Math.max(0, Math.ceil(remaining))}s`
  return phaseText(state)
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
    const badge = getBadge()
    badge.addEventListener('click', () => {
      const snapshot = ui.lastSnapshot
      expand(snapshot)
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
              for (const id of [overlayId, badgeId, styleId]) {
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
