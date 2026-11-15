// 客户端界面：主界面用纯 DOM；只有「开机自启动」设置项必须注册到插件页槽位。
//
// 为什么要纯 DOM：用户讨厌抢占官方槽位，纯 DOM 挂一个 fixed 遮罩是改动最小、
// 最不影响别的插件的方式（dsh-notify-me 已经证明这样能跑）。
// 设置项没有纯 DOM 的入口，只能按 DSH 的插件页约定注册 plugins.item 槽位。
//
// 职责：
//  - 每 400ms 轮询宿主 /dsh-restart/state，画模态框 / 左下悬浮条 / 倒计时；
//  - 有任务时自动展开，并 POST /dialog-open（宿主把 <5 秒的任务抬回 5 秒）；
//  - 弹窗收起时在左侧栏底部留一条悬浮条，显示最短的剩余倒计时，点击再展开；
//  - document 级输入事件（鼠标、键盘、滚轮、触摸）：节流 200ms 发 /pause；停止输入 1 秒发 /resume；
//  - 每个任务一个「取消」按钮 → POST /cancel；任务清空时自动隐藏。

const routePrefix = '/dsh-restart'
const pollMs = 400
const inputThrottleMs = 200
const inputResumeMs = 1000
const overlayId = 'dsr-overlay'
const hintId = 'dsr-hint'
const styleId = 'dsr-style'

// 任务还没开始倒计时时，剩余时间那一列显示的文字。因等待会话空闲而暂停时改显示「已暂停」。
const waitingText = '等待中'

// 悬浮条钉在左侧栏底部、用户头像行上方的那块空白里：左侧栏约 257px 宽、底部头像行约 44px 高，
// left 16px + bottom 60px 正好落在两者之间；侧栏变窄时靠 max-width 加省略号兜底。
const hintLeft = '16px'
const hintBottom = '60px'
const hintMaxWidth = '225px'

var assembled = false

// 设置项需要 React；主界面不依赖它。模块加载时由 __ModuleLoader__ 的 require 注入，
// 拿不到就只跳过设置项，倒计时面板照常工作。
var dsrReact = null

const settingsWrapStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '4px 0',
  fontSize: '13px',
  lineHeight: 1.5,
}
const settingsTitleStyle = { fontSize: '15px', fontWeight: 600 }
const settingsRowStyle = { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }
const settingsDimStyle = {
  color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, .6))',
  fontSize: '12px',
  wordBreak: 'break-all',
}
const settingsErrorStyle = { color: '#c0392b', fontSize: '12px' }
const settingsOkStyle = { color: 'var(--dsw-alias-state-business-primary, #2f8f5b)', fontSize: '12px' }

/** 插件页卡片摘要：只说这个插件能做什么。 */
function AutoStartCard(props) {
  if (props && props.view === 'summary') {
    return dsrReact.createElement('div', null, '登录 Windows 后自动启动 DSH。')
  }
  return dsrReact.createElement(AutoStartSettings, null)
}

/** 设置项本体：一个开关；状态从宿主读，改动立刻写回。 */
function AutoStartSettings() {
  const [state, setState] = dsrReact.useState({
    loading: true,
    loaded: false,
    configured: false,
    enabled: false,
    command: '',
    error: '',
    saving: false,
    saved: '',
  })

  dsrReact.useEffect(() => {
    let alive = true
    request('/state').then((body) => {
      if (!alive) return
      const info = body && body.autoStart && typeof body.autoStart === 'object' ? body.autoStart : null
      if (!info) {
        setState((previous) => ({
          ...previous,
          loading: false,
          loaded: false,
          error: '没能读取当前设置。请稍后重试。',
        }))
        return
      }
      setState({
        loading: false,
        loaded: true,
        configured: info.configured === true,
        enabled: info.enabled === true,
        command: typeof info.command === 'string' ? info.command : '',
        error: typeof info.error === 'string' ? info.error : '',
        saving: false,
        saved: '',
      })
    })
    return () => { alive = false }
  }, [])

  const onToggle = async (event) => {
    const next = Boolean(event && event.target && event.target.checked)
    setState((previous) => ({ ...previous, saving: true, error: '', saved: '' }))
    const body = await request('/autostart', { method: 'POST', body: { enabled: next } })
    if (body && body.ok) {
      const info = body.autoStart && typeof body.autoStart === 'object' ? body.autoStart : null
      setState({
        loading: false,
        loaded: true,
        configured: info ? info.configured === true : next,
        enabled: info ? info.enabled === true : next,
        command: info && typeof info.command === 'string' ? info.command : '',
        error: '',
        saving: false,
        saved: '设置已保存。',
      })
      return
    }
    const message =
      body && body.code && typeof body.error === 'string' ? body.error : '没能保存设置。请稍后重试。'
    setState((previous) => ({ ...previous, saving: false, error: message, saved: '' }))
  }

  let status = '已关闭'
  if (state.loading) status = '正在读取当前状态…'
  else if (state.saving) status = '正在保存…'
  else if (!state.loaded) status = '暂时读不到当前状态'
  else if (state.configured && !state.enabled) status = '已设置为开启，但启动项还没生效。'
  else if (!state.configured && state.enabled) status = '已设置为关闭，但启动项还在。'
  else if (state.enabled) status = '已开启'

  const children = [
    dsrReact.createElement('div', { key: 'title', style: settingsTitleStyle }, '开机自启动'),
    dsrReact.createElement(
      'label',
      { key: 'row', style: settingsRowStyle },
      dsrReact.createElement('input', {
        type: 'checkbox',
        checked: state.configured,
        disabled: state.loading || state.saving,
        onChange: onToggle,
      }),
      dsrReact.createElement('span', null, '登录 Windows 后自动启动 DSH。'),
    ),
    dsrReact.createElement('div', { key: 'status', style: settingsDimStyle }, status),
  ]
  if (state.enabled && state.command) {
    children.push(
      dsrReact.createElement('div', { key: 'command', style: settingsDimStyle }, '启动的程序：' + state.command),
    )
  }
  if (state.error) {
    children.push(dsrReact.createElement('div', { key: 'error', style: settingsErrorStyle, role: 'alert' }, state.error))
  }
  if (state.saved) {
    children.push(dsrReact.createElement('div', { key: 'saved', style: settingsOkStyle }, state.saved))
  }
  return dsrReact.createElement('div', { style: settingsWrapStyle }, children)
}

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
#${overlayId} .dsr-sec.dsr-waiting.dsr-paused{color:#ffcf7a;}
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
  // 点卡片外的空白处兜底收起：卡片内部的点击冒泡上来时 target 不是 overlay，不会误触发。
  overlay.addEventListener('click', (event) => {
    if (event?.target === overlay) collapse()
  })
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

/** 输入暂停：state.paused 为真或 phase 为 paused 时，所有任务的倒计时都停着。 */
function isPaused(state) {
  return state?.paused === true || String(state?.phase) === 'paused'
}

/**
 * 是否因为还有会话在跑而停在等待。这时既不倒计时也不该打扰人：只排队，不弹窗
 * （挡着正在干活的窗口），也不允许「立即重启」（会掐掉正在跑的回合）。
 */
function isHoldingForBusy(state) {
  if (String(state?.phase || '') === 'waiting') return true
  return (Number(state?.busyCount) || 0) > 0
}

/** 快照里的忙碌会话数；坏数据按 0 处理。 */
function busyCountOf(state) {
  return Math.max(0, Number(state?.busyCount) || 0)
}

/**
 * 倒计时停着的两个来源：还有会话在跑（排队等空闲）与用户有输入。
 * 界面上两者同等对待——同样写「已暂停」、同样用暂停色，只有原因说明不同。
 * 会话在跑优先：这时倒计时根本没在走，输入暂停与否都不影响剩余时间。
 */
function pauseCause(state) {
  if (isHoldingForBusy(state)) return 'busy'
  if (isPaused(state)) return 'input'
  return null
}

/** 暂停说明的完整句子：写清为什么停。弹窗顶部那行共用它。 */
function pauseTip(state) {
  const cause = pauseCause(state)
  if (cause === 'busy') {
    const count = busyCountOf(state)
    return count > 0
      ? `已暂停：还有 ${count} 个会话在跑，等它们都空闲后开始倒计时。`
      : '已暂停：还有会话在跑，等它们都空闲后开始倒计时。'
  }
  if (cause === 'input') return '已暂停：有鼠标或键盘操作，倒计时停住。'
  return '操作鼠标或键盘时，倒计时会暂停。'
}

/** 状态文案。暂停统一写「已暂停」，原因由 pauseTip 说明。 */
function phaseText(state) {
  const phase = String(state?.phase || 'idle')
  if (phase === 'firing') return '正在重启…'
  const cause = pauseCause(state)
  if (cause === 'busy') return '已暂停（等待会话空闲）'
  if (cause === 'input' || phase === 'paused') return '已暂停'
  if (phase === 'countdown') return '倒计时中'
  return '空闲'
}

function remainingText(task, state) {
  const cause = pauseCause(state)
  if (!task || task.remainingMs == null) {
    return cause
      ? { text: '已暂停', cssClass: 'dsr-waiting dsr-paused' }
      : { text: waitingText, cssClass: 'dsr-waiting' }
  }
  const seconds = Math.max(0, Math.ceil(Number(task.remainingMs) / 1000))
  return { text: `${seconds} 秒`, cssClass: cause ? 'dsr-paused' : '' }
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
  /**
   * 这一批任务还没自动弹过窗。任务出现时先记上，等真开始倒计时（不再有会话在跑）
   * 才兑现；用户自己开过或收过窗就作废，免得他刚关掉又被弹回来。
   */
  autoOpenPending: false,
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
  // 用户自己收起，就作废本批的自动展开。
  ui.autoOpenPending = false
  const overlay = document.getElementById(overlayId)
  if (overlay) overlay.hidden = true
  // 收起后立刻恢复悬浮条，不用等下一拍轮询。
  renderHint(ui.lastSnapshot, false)
}

/** 把整张卡片画进一个还没挂载的容器里；中途抛错只会抛给调用方，遮罩此时还没亮。 */
function buildCard(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : []
  const card = makeEl('div', 'dsr-card')
  const head = makeEl('div', 'dsr-head')
  head.appendChild(makeEl('div', 'dsr-title', 'DSH 重启倒计时'))
  const phase = makeEl('div', 'dsr-phase', phaseText(state))
  if (pauseCause(state)) phase.classList.add('dsr-warn')
  head.appendChild(phase)
  card.appendChild(head)

  const tip = makeEl('div', 'dsr-tip', pauseTip(state))
  card.appendChild(tip)

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
    if (pauseCause(state) && task.remainingMs != null) {
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
  const holding = isHoldingForBusy(state)
  const busyCount = busyCountOf(state)
  const nowButton = makeEl(
    'button',
    'dsr-btn dsr-danger',
    ui.nowRunning ? '重启中…' : ui.nowConfirm ? '再点一次：立即重启' : '立即重启',
  )
  nowButton.type = 'button'
  // 还有会话在跑时按钮不可点：宿主那边也会拒绝，这里先把入口关掉，别让人点进错误里。
  nowButton.disabled = ui.nowRunning || holding
  nowButton.title = holding
    ? (busyCount > 0 ? '还有 ' + busyCount + ' 个会话在跑' : '还有会话在跑') + '，等它们都空闲后才能立即重启'
    : '跳过等待和倒计时，马上重启；请先保存正在编辑的内容'
  nowButton.addEventListener('click', () => {
    if (ui.nowRunning || holding) return
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

  return card
}

/**
 * 原子地显示弹窗：先在 detached 容器里把卡片完整画完，成功后才清空并挂进遮罩、
 * 最后才取消 hidden。绘制抛错就保持收起，把可读错误交给悬浮条。
 */
function showOverlay(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : []
  try {
    const card = buildCard(state)
    const overlay = getOverlay()
    overlay.textContent = ''
    overlay.appendChild(card)
    overlay.hidden = false
    ui.open = true
    ui.lastTaskCount = tasks.length
    lastPaintError = ''
    // 弹窗顶替悬浮条：同一时刻只留一个提示。
    renderHint(null, true)
    return true
  } catch (error) {
    try {
      const overlay = getOverlay()
      overlay.hidden = true
      overlay.textContent = ''
    } catch {
      /* 忽略 */
    }
    ui.open = false
    // 归零后下一拍轮询会再试一次；失败期间悬浮条始终是重试入口。
    ui.lastTaskCount = 0
    ui.error = '重启面板绘制失败'
    const message = String(error?.message || error)
    if (lastPaintError !== message) {
      lastPaintError = message
      try {
        console.warn('[dsh-restart-plugin] 重启面板绘制失败（已收起，等待重试）:', error)
      } catch {
        /* 忽略 */
      }
    }
    renderHintError('面板绘制失败，点击重试')
    return false
  }
}

/** 拿到快照后真正打开弹窗；没有任务就保持收起。 */
function openFromSnapshot(snapshot) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  if (tasks.length === 0) {
    render(snapshot)
    return
  }
  // 面板已经露过一次面，这一批就不再自动弹。
  ui.autoOpenPending = false
  if (!showOverlay(snapshot)) return
  // 打开瞬间请宿主把不足 5 秒的任务抬回 5 秒（每次都请求，宿主自己幂等）。
  void request('/dialog-open', { method: 'POST' }).then((result) => {
    if (result?.snapshot) render(result.snapshot)
  })
}

function expand(state) {
  if (state) {
    openFromSnapshot(state)
    return
  }
  // 宿主快照还没回来 / 丢了：先把快照拿回来再画，绝不让遮罩抢先出现。
  void request('/state').then((snapshot) => {
    if (!snapshot || snapshot.ok !== true) {
      ui.error = `拿不到宿主状态（${String(snapshot?.error || '未知错误')}）`
      renderHintError('连不上宿主，点击重试')
      return
    }
    consecutiveFailures = 0
    ui.lastSnapshot = snapshot
    openFromSnapshot(snapshot)
  })
}

function render(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : []

  if (tasks.length === 0) {
    const overlay = document.getElementById(overlayId)
    if (overlay) {
      overlay.hidden = true
      overlay.textContent = ''
    }
    ui.open = false
    ui.lastTaskCount = 0
    ui.raisedRequested = false
    ui.autoOpenPending = false
    renderHint(state, false)
    return
  }

  // 任务从无到有：先记下「这一批还没自动弹过」，但此刻可能还有会话在跑，不能马上弹。
  if (ui.lastTaskCount === 0) ui.autoOpenPending = true
  ui.lastTaskCount = tasks.length
  // 弹窗收起时用左下悬浮条显示最短的剩余倒计时；展开时让位给弹窗。
  renderHint(state, ui.open)
  if (ui.open) {
    showOverlay(state)
    return
  }
  if (!ui.autoOpenPending) return
  // 只在真正开始倒计时后才自动展开一次：等待中的任务只留悬浮条，不挡人。
  // 展开失败会清空 lastTaskCount，下一拍当成「任务从无到有」重试。
  if (isHoldingForBusy(state)) return
  ui.autoOpenPending = false
  expand(state)
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
 * 悬浮条文案。暂停说「已暂停」，不写「挂起」；有输入和会话在跑都算暂停，文案一致。
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
  const paused = pauseCause(state) !== null
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

/** 悬浮条上的错误态：收起弹窗后仍然可点，点了就会重新取快照并再画一次。 */
function renderHintError(message) {
  const hint = getHint()
  const text = `DSH 重启 · ${message}`
  // 错误态每 400ms 会被重试路径再画一次：内容没变就别重建节点（aria-live 会重复播报）。
  if (ui.hintText === text && hint.hidden === false) {
    hint.title = '点击重试'
    return
  }
  ui.hintText = text
  ui.hintPaused = null
  hint.hidden = false
  hint.classList.remove('dsr-paused')
  hint.textContent = ''
  hint.appendChild(makeEl('span', 'dsr-dot'))
  hint.appendChild(makeEl('span', 'dsr-hint-text', text))
  hint.title = '点击重试'
}

// ———————————————————————— 轮询 ————————————————————————

let pollTimer = null
let consecutiveFailures = 0
/** 上一次绘制失败的错误文本，用来避免每 400ms 重复刷同一条 warn。 */
let lastPaintError = ''

async function pollOnce() {
  const state = await request('/state')
  if (!state || state.ok !== true) {
    consecutiveFailures += 1
    if (consecutiveFailures >= 3) {
      ui.error = `连不上宿主（${String(state?.error || '未知错误')}）`
      // 连续失败时别把用户锁在虚化遮罩里：收起弹窗，悬浮条继续当重试入口。
      if (ui.open) {
        collapse()
        renderHintError('连不上宿主，点击重试')
      }
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

// ———————————————————————— 输入暂停 ————————————————————————

let lastPauseRequestAt = 0
let resumeTimer = null

/**
 * 算作用户输入的事件：鼠标移动、鼠标按键、滚轮、触摸。键盘单独挂 onKeyDown，
 * 因为它还要处理 Esc。任何一种输入都说明人在用 DSH，这时重启不该在背后发生。
 */
const activityEventNames = ['mousemove', 'mousedown', 'wheel', 'touchstart', 'touchmove']

function hasRunningTasks() {
  const snapshot = ui.lastSnapshot
  return Boolean(snapshot && Array.isArray(snapshot.tasks) && snapshot.tasks.length > 0)
}

/**
 * 任何输入都走这里：节流发 /pause，停止输入 1 秒后发 /resume。
 * 暂停在宿主侧生效（真的不减剩余时间），所以这里只负责发信号。
 */
function onUserActivity() {
  if (!hasRunningTasks()) return
  const now = Date.now()
  if (now - lastPauseRequestAt >= inputThrottleMs) {
    lastPauseRequestAt = now
    void request('/pause', { method: 'POST' })
  }
  if (resumeTimer) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    void request('/resume', { method: 'POST' }).then(() => {
      void pollOnce()
    })
  }, inputResumeMs)
}

function onBlur() {
  // 窗口失焦/切后台时不该一直暂停着。
  if (resumeTimer) {
    clearTimeout(resumeTimer)
    resumeTimer = null
  }
  void request('/resume', { method: 'POST' })
}

/**
 * 键盘输入同样算活动；另外负责 Esc 兜底：弹窗开着时按 Esc 就收起，
 * 焦点在页面任何位置都生效。
 */
function onKeyDown(event) {
  onUserActivity()
  if (!ui.open) return
  if (event?.key !== 'Escape' && event?.key !== 'Esc') return
  collapse()
}

/** 返回卸载函数：dispose 时必须摘掉挂在 document/window 上的监听，否则重装会叠加多份。 */
function mountActivityListeners() {
  for (const eventName of activityEventNames) {
    document.addEventListener(eventName, onUserActivity, { passive: true })
  }
  document.addEventListener('keydown', onKeyDown)
  window.addEventListener('blur', onBlur)
  return function unmountActivityListeners() {
    for (const eventName of activityEventNames) {
      document.removeEventListener(eventName, onUserActivity, { passive: true })
    }
    document.removeEventListener('keydown', onKeyDown)
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
    const unmountActivityListeners = mountActivityListeners()
    startPolling()

    // 设置项只能注册到 DSH 的插件页槽位；主界面仍然不占任何槽位。
    let disposeCard = null
    let disposeSlots = null
    try {
      const slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (dsrReact && slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        const injected = slots.inject('plugins.item', () => {
          disposeCard = slots.register(
            { name: 'plugins.item', id: 'restart', order: 20, label: () => '重启' },
            AutoStartCard,
          )
          return disposeCard
        })
        disposeSlots = () => {
          if (typeof disposeCard === 'function') disposeCard()
          if (typeof injected === 'function' && injected !== disposeCard) injected()
        }
      }
    } catch (error) {
      try {
        console.warn('[dsh-restart-plugin] 注册设置项失败（已忽略）:', error)
      } catch {
        /* 忽略 */
      }
    }

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
              unmountActivityListeners()
              if (typeof disposeSlots === 'function') {
                try { disposeSlots() } catch { /* 已卸载 */ }
                disposeSlots = null
              }
              for (const id of [overlayId, hintId, styleId]) {
                const node = document.getElementById(id)
                if (node && node.parentNode) node.parentNode.removeChild(node)
              }
              ui.open = false
              ui.lastSnapshot = null
              ui.lastTaskCount = 0
              ui.autoOpenPending = false
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

// 设置项依赖 slots 服务；主界面本身不依赖任何宿主服务。
var inject = ['slots']

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
      factory: (require) => {
        try {
          dsrReact = require('react')
        } catch {
          dsrReact = null
        }
        return mod.exports
      },
    })
  }
} catch (error) {
  try {
    console.warn('[dsh-restart-plugin] 注册客户端模块失败:', error)
  } catch {
    /* 忽略 */
  }
}
