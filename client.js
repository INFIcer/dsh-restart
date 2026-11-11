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

const 路由前缀 = '/dsh-restart'
const 轮询毫秒 = 400
const 鼠标节流毫秒 = 200
const 鼠标恢复毫秒 = 1000
const 遮罩ID = 'dsr-overlay'
const 徽标ID = 'dsr-badge'
const 样式ID = 'dsr-style'

var 已装配 = false

/** 造元素的小工具：属性都用 textContent，避免把会话标题当 HTML 解析（防 XSS）。 */
function 元素(标签, 类名, 文本) {
  const 节点 = document.createElement(标签)
  if (类名) 节点.className = 类名
  if (文本 != null) 节点.textContent = String(文本)
  return 节点
}

function 注入样式() {
  if (document.getElementById(样式ID)) return
  const 样式 = document.createElement('style')
  样式.id = 样式ID
  样式.textContent = `
#${遮罩ID}{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(8,10,16,.42);backdrop-filter:blur(2px);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;}
#${遮罩ID}[hidden],#${徽标ID}[hidden]{display:none !important;}
#${遮罩ID} .dsr-card{width:min(560px,calc(100vw - 48px));max-height:min(70vh,640px);overflow:auto;border-radius:14px;
  background:#1b1e26;color:#e8eaf0;box-shadow:0 24px 64px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08);}
#${遮罩ID} .dsr-head{display:flex;align-items:center;gap:10px;padding:16px 18px 10px;}
#${遮罩ID} .dsr-title{font-size:16px;font-weight:600;flex:1;}
#${遮罩ID} .dsr-phase{font-size:12px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.08);color:#c9d3e6;}
#${遮罩ID} .dsr-phase.dsr-warn{background:rgba(255,186,66,.16);color:#ffcf7a;}
#${遮罩ID} .dsr-tip{padding:0 18px 10px;color:#9aa4b6;font-size:12px;}
#${遮罩ID} .dsr-list{list-style:none;margin:0;padding:0 12px 6px;}
#${遮罩ID} .dsr-row{display:flex;align-items:flex-start;gap:10px;padding:10px 8px;border-top:1px solid rgba(255,255,255,.06);}
#${遮罩ID} .dsr-row:first-child{border-top:none;}
#${遮罩ID} .dsr-who{font-weight:600;color:#dbe4f5;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#${遮罩ID} .dsr-why{color:#8d97a9;font-size:12px;word-break:break-word;}
#${遮罩ID} .dsr-main{flex:1;min-width:0;}
#${遮罩ID} .dsr-sec{font-variant-numeric:tabular-nums;font-size:18px;font-weight:600;color:#7ee0a8;white-space:nowrap;}
#${遮罩ID} .dsr-sec.dsr-paused{color:#ffcf7a;}
#${遮罩ID} .dsr-sec.dsr-waiting{font-size:13px;color:#9aa4b6;font-weight:500;}
#${遮罩ID} .dsr-btn{cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e8eaf0;
  border-radius:8px;padding:5px 10px;font-size:12px;white-space:nowrap;}
#${遮罩ID} .dsr-btn:hover{background:rgba(255,255,255,.12);}
#${遮罩ID} .dsr-btn.dsr-danger:hover{background:rgba(255,90,90,.18);border-color:rgba(255,90,90,.4);}
#${遮罩ID} .dsr-foot{display:flex;align-items:center;gap:10px;padding:12px 18px 16px;color:#8d97a9;font-size:12px;}
#${遮罩ID} .dsr-foot .dsr-spacer{flex:1;}
#${遮罩ID} .dsr-session{color:#6f7a8d;font-size:11px;}
#${徽标ID}{position:fixed;top:14px;right:16px;z-index:2147483000;cursor:pointer;display:flex;align-items:center;gap:6px;
  padding:6px 10px;border-radius:999px;background:rgba(24,28,38,.92);color:#e8eaf0;border:1px solid rgba(255,255,255,.12);
  box-shadow:0 8px 24px rgba(0,0,0,.35);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;}
#${徽标ID} .dsr-dot{width:8px;height:8px;border-radius:50%;background:#7ee0a8;}
#${徽标ID}.dsr-paused .dsr-dot{background:#ffcf7a;}
`
  ;(document.head || document.documentElement).appendChild(样式)
}

function 取遮罩() {
  let 遮罩 = document.getElementById(遮罩ID)
  if (遮罩) return 遮罩
  遮罩 = 元素('div')
  遮罩.id = 遮罩ID
  遮罩.hidden = true
  遮罩.setAttribute('role', 'dialog')
  遮罩.setAttribute('aria-label', 'DSH 重启倒计时')
  ;(document.body || document.documentElement).appendChild(遮罩)
  return 遮罩
}

function 取徽标() {
  let 徽标 = document.getElementById(徽标ID)
  if (徽标) return 徽标
  徽标 = 元素('button')
  徽标.id = 徽标ID
  徽标.type = 'button'
  徽标.hidden = true
  ;(document.body || document.documentElement).appendChild(徽标)
  return 徽标
}

/** 状态文案。 */
function 阶段文案(状态) {
  const 阶段 = String(状态?.phase || 'idle')
  if (阶段 === 'waiting') return `等待中（还有 ${Number(状态?.busyCount) || 0} 个会话在跑）`
  if (阶段 === 'countdown') return `倒计时中${状态?.paused ? '（已暂停）' : ''}`
  if (阶段 === 'paused') return '已暂停'
  if (阶段 === 'firing') return '正在重启…'
  return '空闲'
}

function 剩余文案(任务, 状态) {
  if (!任务 || 任务.remainingMs == null) return { 文本: 等待中, 类: 'dsr-waiting' }
  const 秒 = Math.max(0, Math.ceil(Number(任务.remainingMs) / 1000))
  const 暂停 = 状态?.paused === true || String(状态?.phase) === 'paused'
  return { 文本: `${秒} 秒`, 类: 暂停 ? 'dsr-paused' : '' }
}

// ———————————————————————— 与宿主通信 ————————————————————————

async function 请求(路径, 选项) {
  try {
    const 响应 = await fetch(`${路由前缀}${路径}`, {
      method: 选项?.method || 'GET',
      headers: 选项?.body ? { 'content-type': 'application/json' } : undefined,
      body: 选项?.body ? JSON.stringify(选项.body) : undefined,
      cache: 'no-store',
    })
    const 文本 = await 响应.text()
    try {
      return JSON.parse(文本)
    } catch {
      return { ok: false, error: `返回不是 JSON（HTTP ${响应.status}）` }
    }
  } catch (错误) {
    return { ok: false, error: String(错误?.message || 错误) }
  }
}

// ———————————————————————— 渲染 ————————————————————————

const 界面 = {
  打开: false,
  /** 上一次快照，用于判断任务从无到有 */
  上次快照: null,
  上次任务数: 0,
  /** 是否已经为这一批任务发过 dialog-open */
  已请求抬秒: false,
  /** 正在取消中的任务 id，避免重复点 */
  取消中: new Set(),
  /** 「立即重启」的二次确认状态：点一次变成确认，3 秒不点自动复原 */
  立即确认: false,
  立即确认定时器: null,
  立即中: false,
  错误: '',
}

function 收起() {
  界面.打开 = false
  const 遮罩 = document.getElementById(遮罩ID)
  if (遮罩) 遮罩.hidden = true
}

function 展开(状态) {
  const 遮罩 = 取遮罩()
  const 徽标 = 取徽标()
  界面.打开 = true
  遮罩.hidden = false
  徽标.hidden = true
  // 打开瞬间请宿主把不足 5 秒的任务抬回 5 秒（每次都请求，宿主自己幂等）。
  void 请求('/dialog-open', { method: 'POST' }).then((结果) => {
    if (结果?.快照) 画(结果.快照)
  })
  if (状态) 画(状态)
}

function 画(状态) {
  const 遮罩 = 取遮罩()
  const 徽标 = 取徽标()
  const 任务们 = Array.isArray(状态?.tasks) ? 状态.tasks : []
  const 有任务 = 任务们.length > 0

  if (!有任务) {
    遮罩.hidden = true
    徽标.hidden = true
    界面.打开 = false
    界面.上次任务数 = 0
    界面.已请求抬秒 = false
    return
  }

  // 有任务但界面被收起了 → 显示徽标；从未展开过 → 自动展开并请求抬秒。
  if (!界面.打开) {
    徽标.hidden = false
    徽标.classList.toggle('dsr-paused', 状态?.paused === true)
    徽标.textContent = ''
    const 点 = 元素('span', 'dsr-dot')
    const 文 = 元素('span', null, `重启 ${剩余最短文案(状态)}`)
    徽标.appendChild(点)
    徽标.appendChild(文)
  } else {
    徽标.hidden = true
  }

  if (界面.上次任务数 === 0 && !界面.打开) {
    // 任务从无到有：自动展开（展开里会 POST dialog-open）。
    展开(状态)
    return
  }
  界面.上次任务数 = 任务们.length

  // —— 重画卡片 ——
  const 卡片 = 元素('div', 'dsr-card')
  const 头 = 元素('div', 'dsr-head')
  头.appendChild(元素('div', 'dsr-title', 'DSH 重启倒计时'))
  const 阶段 = 元素('div', 'dsr-phase', 阶段文案(状态))
  if (状态?.paused === true || String(状态?.phase) === 'paused') 阶段.classList.add('dsr-warn')
  头.appendChild(阶段)
  卡片.appendChild(头)

  const 提示 = 元素(
    'div',
    'dsr-tip',
    状态?.paused === true || String(状态?.phase) === 'paused'
      ? '已暂停：鼠标在动时倒计时不走，停下 1 秒后自动继续。'
      : '鼠标一移动，所有倒计时都会暂停；停 1 秒后自动恢复。',
  )
  卡片.appendChild(提示)

  const 列表 = 元素('ul', 'dsr-list')
  for (const 任务 of 任务们) {
    const 行 = 元素('li', 'dsr-row')
    const 主 = 元素('div', 'dsr-main')
    const 头部行 = 元素('div')
    头部行.style.display = 'flex'
    头部行.style.gap = '8px'
    头部行.style.alignItems = 'baseline'
    头部行.appendChild(元素('span', 'dsr-who', 任务.sessionLabel || '未知会话'))
    const 会话短码 = String(任务.sessionId || '').replace(/^session-/, '').slice(0, 6)
    if (任务.sessionLabel && 会话短码) 头部行.appendChild(元素('span', 'dsr-session', `（${会话短码}）`))
    主.appendChild(头部行)
    const 说明 = 任务.reason || 任务.wakeText || '没有备注'
    主.appendChild(元素('div', 'dsr-why', 说明))
    行.appendChild(主)

    const 剩余 = 剩余文案(任务, 状态)
    const 秒 = 元素('div', `dsr-sec ${剩余.类}`.trim(), 剩余.文本)
    行.appendChild(秒)
    if (状态?.paused === true || String(状态?.phase) === 'paused') {
      行.appendChild(元素('span', 'dsr-session', '已暂停'))
    }

    const 取消按钮 = 元素('button', 'dsr-btn dsr-danger', 界面.取消中.has(任务.id) ? '取消中…' : '取消')
    取消按钮.type = 'button'
    取消按钮.disabled = 界面.取消中.has(任务.id)
    取消按钮.addEventListener('click', () => {
      界面.取消中.add(任务.id)
      取消按钮.disabled = true
      取消按钮.textContent = '取消中…'
      void 请求('/cancel', { method: 'POST', body: { taskId: 任务.id } }).then((结果) => {
        界面.取消中.delete(任务.id)
        if (!结果?.ok) {
          界面.错误 = String(结果?.error || '取消失败')
        }
        void 轮询一次()
      })
    })
    行.appendChild(取消按钮)
    列表.appendChild(行)
  }
  卡片.appendChild(列表)

  const 脚 = 元素('div', 'dsr-foot')
  脚.appendChild(元素('span', null, 界面.错误 || '每个任务都能单独取消；取消会给你发一条反馈。'))
  const 撑 = 元素('span', 'dsr-spacer')
  脚.appendChild(撑)
  const 立即按钮 = 元素(
    'button',
    'dsr-btn dsr-danger',
    界面.立即中 ? '重启中…' : 界面.立即确认 ? '再点一次：立即重启' : '立即重启',
  )
  立即按钮.type = 'button'
  立即按钮.disabled = 界面.立即中
  立即按钮.title = '跳过等待和倒计时，马上重启；会中断正在运行的会话，重启后会话会被唤醒。'
  立即按钮.addEventListener('click', () => {
    if (界面.立即中) return
    if (!界面.立即确认) {
      界面.立即确认 = true
      if (界面.立即确认定时器) clearTimeout(界面.立即确认定时器)
      界面.立即确认定时器 = setTimeout(() => {
        界面.立即确认 = false
        界面.立即确认定时器 = null
        画(界面.上次快照)
      }, 3000)
      画(界面.上次快照)
      return
    }
    if (界面.立即确认定时器) {
      clearTimeout(界面.立即确认定时器)
      界面.立即确认定时器 = null
    }
    界面.立即确认 = false
    界面.立即中 = true
    立即按钮.textContent = '重启中…'
    立即按钮.disabled = true
    void 请求('/now', { method: 'POST' }).then((结果) => {
      if (!结果 || 结果.ok !== true) {
        界面.立即中 = false
        界面.立即确认 = false
        界面.错误 = String(结果?.error || '立即重启失败')
        画(界面.上次快照)
      }
    })
  })
  脚.appendChild(立即按钮)
  const 收起按钮 = 元素('button', 'dsr-btn', '收起')
  收起按钮.type = 'button'
  收起按钮.addEventListener('click', () => 收起())
  脚.appendChild(收起按钮)
  卡片.appendChild(脚)

  遮罩.textContent = ''
  遮罩.appendChild(卡片)
}

function 剩余最短文案(状态) {
  const 剩余 = Number(状态?.nearestRemainingSeconds)
  if (Number.isFinite(剩余)) return `${Math.max(0, Math.ceil(剩余))}s`
  return 阶段文案(状态)
}

// ———————————————————————— 轮询 ————————————————————————

let 轮询定时器 = null
let 连续失败 = 0

async function 轮询一次() {
  const 状态 = await 请求('/state')
  if (!状态 || 状态.ok !== true) {
    连续失败 += 1
    if (连续失败 === 3) {
      界面.错误 = `连不上宿主（${String(状态?.error || '未知错误')}）`
    }
    return
  }
  连续失败 = 0
  界面.错误 = ''
  界面.上次快照 = 状态
  画(状态)
}

function 开始轮询() {
  if (轮询定时器) return
  void 轮询一次()
  轮询定时器 = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    void 轮询一次()
  }, 轮询毫秒)
}

// ———————————————————————— 鼠标暂停 ————————————————————————

let 上次暂停请求 = 0
let 恢复定时器 = null

function 有任务在跑() {
  const 快照 = 界面.上次快照
  return Boolean(快照 && Array.isArray(快照.tasks) && 快照.tasks.length > 0)
}

function 鼠标动了() {
  if (!有任务在跑()) return
  const 现在 = Date.now()
  // 暂停状态在宿主侧生效（真的不减剩余时间），客户端每 200ms 才发一次。
  if (现在 - 上次暂停请求 >= 鼠标节流毫秒) {
    上次暂停请求 = 现在
    void 请求('/pause', { method: 'POST' })
  }
  if (恢复定时器) clearTimeout(恢复定时器)
  恢复定时器 = setTimeout(() => {
    恢复定时器 = null
    void 请求('/resume', { method: 'POST' }).then(() => {
      void 轮询一次()
    })
  }, 鼠标恢复毫秒)
}

function 挂鼠标监听() {
  document.addEventListener('mousemove', 鼠标动了, { passive: true })
  // 窗口失焦/切后台时不该一直暂停着。
  window.addEventListener('blur', () => {
    if (恢复定时器) {
      clearTimeout(恢复定时器)
      恢复定时器 = null
    }
    void 请求('/resume', { method: 'POST' })
  })
}

// ———————————————————————— 入口 ————————————————————————

function apply(ctx) {
  try {
    if (已装配) return
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    已装配 = true
    注入样式()
    取遮罩()
    const 徽标 = 取徽标()
    徽标.addEventListener('click', () => {
      const 快照 = 界面.上次快照
      展开(快照)
    })
    挂鼠标监听()
    开始轮询()

    // 插件卸载时停掉轮询（拿不到 effect 也没关系，setInterval 不会影响功能）。
    try {
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          if (轮询定时器) clearInterval(轮询定时器)
          轮询定时器 = null
        }, 'dsh-restart-plugin-client: poll')
      }
    } catch {
      /* 忽略 */
    }
  } catch (错误) {
    try {
      console.warn('[dsh-restart-plugin] 客户端界面加载失败（已忽略）:', 错误)
    } catch {
      /* 忽略 */
    }
  }
}

var inject = []

// 浏览器里由 __ModuleLoader__ 调用 factory（客户端 bundle 是 classic script，
// 不能用 ESM export；注册必须发生在脚本执行时，否则宿主会认为该 bundle 没注册）。
const 模块 = { exports: {} }
模块.exports.apply = apply
模块.exports.inject = inject
模块.exports.name = 'dsh-restart-plugin'

try {
  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: 'dsh-restart-plugin',
      factory: () => 模块.exports,
    })
  }
} catch (错误) {
  try {
    console.warn('[dsh-restart-plugin] 注册客户端模块失败:', 错误)
  } catch {
    /* 忽略 */
  }
}
