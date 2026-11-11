// 宿主侧装配：HTTP 路由 + dsh_restart 工具 + 调度器心跳。
//
// 设计原则（主人要求）：
//  - Fail-open：任何环节出错都只记日志，绝不把 DSH 弄崩。
//  - 状态机全部在 lib/scheduler.js，这里只做「接线」，方便测试。
//  - 不注册任何 UI 槽位；界面由 client.js 用纯 DOM 画。

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  插件名,
  最小延迟秒,
  最大延迟秒,
  默认延迟秒,
  弹框最小剩余秒,
  鼠标暂停保持毫秒,
  调度心跳毫秒,
  唤醒延迟秒,
  计划任务名,
  状态文件名,
  路由前缀,
} from './constants.js'
import { 确保目录, 追加日志, 读JSON, 写JSON原子 } from './fsutil.js'
import { 回JSON, 读请求体, 方法允许 } from './http.js'
import { 重启调度器 } from './scheduler.js'
import {
  解析脚本路径,
  写入重启脚本,
  生成唤醒事件,
  插件根,
} from './script.js'
import { 启动脱离重启 } from './launcher.js'

export const name = 插件名
export const inject = ['webServer', 'agents', 'tools']

const 空日志 = { info() {}, warn() {}, error() {} }

/** 把任意值变成一句短文本（日志用）。 */
function 文本化(值) {
  if (值 instanceof Error) return 值.stack || 值.message || String(值)
  if (typeof 值 === 'string') return 值
  try {
    return JSON.stringify(值)
  } catch {
    return String(值)
  }
}

/** 造一个 fail-open 的日志器：写文件；error 另外打到控制台。 */
export function 造日志(文件, 控制台 = console) {
  const 写 = (级别, ...参数) => {
    const 正文 = 参数.map(文本化).join(' ')
    try {
      // 追加日志 自己会加时间戳和换行，这里只写级别和正文。
      追加日志(文件, `${级别.toUpperCase()} ${正文}`)
    } catch {
      /* fail-open：日志写不进去也不能崩 */
    }
    if (级别 === 'error') {
      try { 控制台?.error?.(`[${插件名}] ${正文}`) } catch { /* 忽略 */ }
    }
  }
  return {
    文件,
    info: (...参数) => 写('info', ...参数),
    warn: (...参数) => 写('warn', ...参数),
    error: (...参数) => 写('error', ...参数),
  }
}

/** 安全执行：同步/异步异常都吞掉记日志。 */
export function 安全(日志, 标签, 函数) {
  return (...参数) => {
    try {
      const 结果 = 函数(...参数)
      if (结果 && typeof 结果.then === 'function') {
        return 结果.catch((错误) => {
          日志?.error?.(`${标签} 失败`, 错误)
          return { ok: false, code: 'internal', hint: `${标签} 失败：${文本化(错误)}` }
        })
      }
      return 结果
    } catch (错误) {
      日志?.error?.(`${标签} 失败`, 错误)
      return { ok: false, code: 'internal', hint: `${标签} 失败：${文本化(错误)}` }
    }
  }
}

// ———————————————————————— 会话相关 ————————————————————————

/** 从工具 exec 里取调用者会话 id。 */
export function 解析调用会话(exec) {
  try {
    const 候选 = [
      exec?.agent?.session?.id,
      exec?.agent?.sessionId,
      exec?.agent?.id,
      exec?.sessionId,
      exec?.session?.id,
    ]
    for (const 项 of 候选) {
      const 值 = String(项 || '').trim()
      if (值) return 值
    }
  } catch {
    /* 忽略 */
  }
  return ''
}

/** 当前正在运行的会话列表；读不到就当空闲（否则任务永远排不上）。 */
export function 取忙碌会话(ctx, 日志) {
  try {
    const agents = ctx?.get?.('agents')
    if (!agents || typeof agents.list !== 'function') return []
    const 全部 = agents.list()
    if (!Array.isArray(全部)) return []
    const 结果 = []
    for (const agent of 全部) {
      if (!agent) continue
      const 状态 = String(agent.status || '')
      // 状态缺失时不当作忙，避免任务永远「等待中」。
      if (!状态 || 状态 === 'idle') continue
      const 会话 = String(agent.session?.id || agent.id || '').trim()
      if (!会话) continue
      结果.push({ id: String(agent.id || 会话), sessionId: 会话, status: 状态 })
    }
    return 结果
  } catch (错误) {
    日志?.warn?.('读取会话状态失败（按空闲处理）', 错误)
    return []
  }
}

/** 会话显示名：优先取会话标题，取不到就截断 id。 */
export function 会话标签(ctx, sessionId) {
  const 编号 = String(sessionId || '').trim()
  if (!编号) return ''
  try {
    const 标题服务 = ctx?.get?.('sessionTitle')
    if (标题服务 && typeof 标题服务.get === 'function') {
      // sessionTitle.get() 收的是 Session 对象，不是 id：先用 sessions / agents 换出会话。
      const 会话服务 = ctx?.get?.('sessions')
      const 会话 = 会话服务?.get?.(编号) ?? ctx?.get?.('agents')?.get?.(编号)?.session
      const 快照 = 会话 === undefined ? undefined : 标题服务.get(会话)
      const 标题 =
        typeof 快照 === 'string' ? String(快照).trim() : String(快照?.title ?? '').trim()
      if (标题) return 标题
    }
  } catch {
    /* 忽略 */
  }
  return 编号.replace(/^session-/, '').slice(0, 8)
}

/** 给会话注入一条 user 消息（会唤醒该会话）。返回是否送达。 */
export function 造注入函数(ctx, 日志) {
  return (sessionId, 文本, 元信息 = {}) => {
    const 编号 = String(sessionId || '').trim()
    const 正文 = String(文本 || '').trim()
    if (!编号 || !正文) return false
    try {
      const agents = ctx?.get?.('agents')
      const agent = agents && typeof agents.get === 'function' ? agents.get(编号) : null
      if (!agent || typeof agent.inject !== 'function') {
        日志?.warn?.(`会话 ${编号} 不在线，反馈消息没送达`)
        return false
      }
      agent.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: 正文 }],
        source: {
          kind: `${插件名}/feedback`,
          reason: String(元信息?.reason || 'restart-scheduler'),
          taskId: 元信息?.taskId ? String(元信息.taskId) : undefined,
        },
      })
      日志?.info?.(`已给会话 ${编号} 注入反馈`)
      return true
    } catch (错误) {
      日志?.warn?.(`给会话 ${编号} 注入反馈失败`, 错误)
      return false
    }
  }
}

// ———————————————————————— 路由 ————————————————————————

function 造回包(日志) {
  return (res, 状态码, 数据) => {
    try {
      回JSON(res, 状态码, 数据)
    } catch (错误) {
      日志?.warn?.('回包失败（连接可能已断开）', 错误)
    }
  }
}

// ———————————————————————— 工具 ————————————————————————

const 工具参数 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['schedule', 'cancel', 'status'],
      description: 'schedule=排一个重启任务；cancel=取消一个任务；status=查看所有任务。',
    },
    delaySeconds: {
      type: 'integer',
      minimum: 最小延迟秒,
      maximum: 最大延迟秒,
      description: `倒计时秒数，${最小延迟秒}~${最大延迟秒}，默认 ${默认延迟秒}。等所有会话空闲后才开始倒计时。`,
    },
    wakeText: {
      type: 'string',
      description: '重启完成后对调用会话说的话。不写就用默认文本。',
    },
    reason: {
      type: 'string',
      description: '这次重启的备注，显示在面板上，方便多个任务区分。',
    },
    taskId: {
      type: 'string',
      description: 'cancel 时要取消的任务 id（status 里能看到）。',
    },
  },
  required: ['action'],
}

const 工具输出 = {
  // 宽松 schema：返回字段会随动作变化，严格校验反而容易误报。
  schema: { type: 'object', additionalProperties: true },
  render: (_参数, 值) => [{ type: 'text', text: JSON.stringify(值, null, 2) }],
}

function 工具错误(信息, 建议) {
  return { ok: false, code: 'bad_request', error: 信息, hint: 建议 }
}

// ———————————————————————— 装配 ————————————————————————

/**
 * 装配插件（apply 的实际实现，测试直接调这个）。
 * @param {object} ctx 宿主插件上下文
 * @param {object} [选项] 测试可覆盖：状态文件/标记文件/脚本文件/日志文件/onFire/now/spawnImpl/心跳毫秒
 */
export function 装配(ctx, 选项 = {}) {
  const 路径集 = { ...解析脚本路径(process.env), 插件根, ...(选项.路径 || {}) }
  const 状态文件 = 选项.状态文件 || path.join(路径集.家目录, 状态文件名)
  const 日志文件 = 选项.日志文件 || path.join(路径集.插件根, 'restart-plugin.log')
  const 脚本文件 = 选项.脚本文件 || 路径集.脚本文件
  const 标记文件 = 选项.标记文件 || 路径集.标记文件

  try { 确保目录(path.dirname(状态文件)) } catch { /* 忽略 */ }
  try { 确保目录(path.dirname(日志文件)) } catch { /* 忽略 */ }

  const 日志 = 选项.日志 || 造日志(日志文件)
  const 回 = 造回包(日志)
  const 注入 = 选项.injectToSession || 造注入函数(ctx, 日志)

  let 清理函数们 = []
  let 已停止 = false

  const 触发重启 = async (载荷) => {
    if (typeof 选项.onFire === 'function') return 选项.onFire(载荷)
    const 事件 = 生成唤醒事件(
      (载荷?.tasks || []).map((任务) => ({
        sessionId: 任务.sessionId,
        wakeText: 任务.wakeText,
        afterSeconds: 唤醒延迟秒,
      })),
    )
    const 写脚本 = 写入重启脚本({
      脚本文件,
      家目录: 路径集.家目录,
      exe路径: 路径集.exe路径,
      日志文件: 路径集.日志文件,
      标记文件,
      任务名: 计划任务名,
      唤醒事件: 事件,
    })
    if (!写脚本.ok) {
      return { ok: false, code: 'script_failed', error: 写脚本.错误 || '写重启脚本失败' }
    }
    日志.info?.(`重启脚本已写入 ${写脚本.路径}（${写脚本.字节数} 字节，${写脚本.事件数} 个唤醒事件）`)
    const 启动 = await 启动脱离重启({
      scriptPath: 写脚本.路径,
      taskName: 计划任务名,
      spawnImpl: 选项.spawnImpl,
      now: 选项.now,
      日志: (级别, 信息) => 日志[级别 === 'error' ? 'error' : 'info']?.(信息),
    })
    if (!启动.ok) {
      return {
        ok: false,
        code: 'launch_failed',
        error: `计划任务启动失败（${启动.stage}）：${启动.error}`,
      }
    }
    return {
      ok: true,
      scriptPath: 写脚本.路径,
      launcher: 启动.launcher,
      taskName: 启动.taskName,
      wakeCount: 写脚本.事件数,
    }
  }

  const 调度器 = new 重启调度器({
    now: 选项.now,
    getBusySessions: () => 取忙碌会话(ctx, 日志),
    persist: (状态) => {
      // 状态文件原子写（先 .tmp 再 rename），见 fsutil 写JSON原子
      写JSON原子(状态文件, 状态)
    },
    load: () => 读JSON(状态文件, null),
    readMarker: () => 读JSON(标记文件, null),
    onFire: 触发重启,
    injectToSession: 注入,
    logger: 日志,
  })

  try {
    调度器.初始化()
  } catch (错误) {
    日志.error?.('调度器初始化失败（继续跑空状态）', 错误)
  }

  // ——— 开机汇报：上个实例是被本插件重启的，给排过任务的会话说一声 ———
  const 汇报句柄 = 排开机汇报(调度器, 注入, 日志, 选项)

  // ——— 心跳 ———
  const 心跳毫秒 = Number(选项.心跳毫秒) > 0 ? Number(选项.心跳毫秒) : 调度心跳毫秒
  try {
    调度器.启动(心跳毫秒)
    清理函数们.push(() => 调度器.停止())
  } catch (错误) {
    日志.error?.('启动心跳失败', 错误)
  }

  // ——— HTTP 路由 ———
  const 注册路由 = (子路径, 处理) => {
    const 完整路径 = `${路由前缀}${子路径}`
    try {
      if (!ctx?.webServer || typeof ctx.webServer.register !== 'function') {
        日志.warn?.(`webServer 不可用，跳过路由 ${完整路径}`)
        return
      }
      const 注册 = () =>
        ctx.webServer.register({
          kind: 'exact',
          path: 完整路径,
          handler: 安全(日志, `路由 ${完整路径}`, (req, res) => 处理(req, res)),
        })
      if (typeof ctx.effect === 'function') ctx.effect(注册, `dsh-restart-plugin: ${完整路径}`)
      else 注册()
    } catch (错误) {
      日志.error?.(`注册路由 ${完整路径} 失败`, 错误)
    }
  }

  注册路由('/state', (req, res) => {
    if (!方法允许(req, res, ['GET'])) return
    const 快照 = 调度器.快照()
    回(res, 200, {
      ...快照,
      服务端时间: new Date(调度器.now()).toISOString(),
      常量: {
        最小延迟秒,
        最大延迟秒,
        默认延迟秒,
        弹框最小剩余秒,
        鼠标暂停保持毫秒,
        唤醒延迟秒,
      },
    })
  })

  注册路由('/pause', async (req, res) => {
    if (!方法允许(req, res, ['POST'])) return
    const 结果 = 调度器.暂停('mouse')
    回(res, 200, { ...结果, 快照: 调度器.快照() })
  })

  注册路由('/resume', async (req, res) => {
    if (!方法允许(req, res, ['POST'])) return
    const 结果 = 调度器.恢复('mouse')
    回(res, 200, { ...结果, 快照: 调度器.快照() })
  })

  注册路由('/cancel', async (req, res) => {
    if (!方法允许(req, res, ['POST'])) return
    const 读取 = await 读请求体(req)
    const taskId = String(读取?.value?.taskId || '').trim()
    if (!taskId) {
      回(res, 400, { ok: false, code: 'bad_request', error: '缺少 taskId', hint: '面板取消要带任务 id。' })
      return
    }
    const 结果 = 调度器.取消任务(taskId, { source: 'panel' })
    if (!结果.ok) {
      回(res, 404, { ...结果, 快照: 调度器.快照() })
      return
    }
    回(res, 200, { ...结果, 快照: 调度器.快照() })
  })

  注册路由('/dialog-open', async (req, res) => {
    if (!方法允许(req, res, ['POST'])) return
    const 结果 = 调度器.打开对话框()
    回(res, 200, { ok: true, 提升任务: 结果.提升任务, 提升数量: 结果.提升数量, 快照: 结果.快照 })
  })

  注册路由('/now', async (req, res) => {
    if (!方法允许(req, res, ['POST'])) return
    const 结果 = await 调度器.立即重启({ source: 'panel' })
    if (!结果.ok) {
      回(res, 结果.code === 'firing' ? 409 : 400, { ...结果, 快照: 调度器.快照() })
      return
    }
    回(res, 200, { ...结果, 快照: 调度器.快照() })
  })

  // ——— 工具 ———
  const 工具 = 造工具(ctx, 调度器, 日志, 选项)
  try {
    if (ctx?.tools && typeof ctx.tools.register === 'function') {
      // 立即注册（与 dsh-fish-message / dsh-fish-service 一致）：放进 ctx.effect 会晚于
      // 宿主建立工具视图，注册失败又只落在宿主控制台，插件自己的日志里什么都看不到。
      const 摘工具 = ctx.tools.register(工具)
      if (typeof 摘工具 === 'function') 清理函数们.push(() => { try { 摘工具() } catch { /* 已卸载 */ } })
      日志.info?.(`dsh_restart 工具已注册（disposer=${typeof 摘工具}）`)
    } else {
      日志.warn?.('tools 服务不可用，dsh_restart 工具没注册上')
    }
  } catch (错误) {
    日志.error?.(`注册 dsh_restart 工具失败：${错误?.message || 错误}`)
  }

  // ——— 清理 ———
  const 停止 = () => {
    if (已停止) return
    已停止 = true
    try { 汇报句柄?.() } catch { /* 忽略 */ }
    for (const 清理 of 清理函数们.splice(0)) {
      try { 清理() } catch { /* 忽略 */ }
    }
  }
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => 停止, 'dsh-restart-plugin: cleanup')
    else if (typeof ctx?.on === 'function') ctx.on('dispose', 停止)
  } catch (错误) {
    日志.warn?.('注册清理函数失败', 错误)
  }

  日志.info?.(`插件已加载：状态文件 ${状态文件}，脚本 ${脚本文件}`)
  return { 调度器, 工具, 日志, 状态文件, 脚本文件, 标记文件, 停止 }
}

// ———————————————————————— 开机汇报 ————————————————————————

/**
 * 上个实例是插件触发的重启、并且标记文件确认已起来 → 给相关会话注入汇报。
 * 注入会唤醒会话，这是想要的（主人要求重启后唤醒/汇报）。
 */
function 排开机汇报(调度器, 注入, 日志, 选项 = {}) {
  try {
    const 记录 = 调度器.lastRestart
    if (!记录 || 记录.status !== 'restarted') return null
    if (记录.已汇报) return null
    const 会话们 = [...new Set((记录.sessionIds || []).map((项) => String(项 || '').trim()).filter(Boolean))]
    if (会话们.length === 0) {
      记录.已汇报 = true
      调度器.落盘()
      return null
    }
    const 文本 =
      `（重启调度）DSH 已重启完成（运行记录 ${String(记录.id || '')}）。` +
      `这次重启是由你排的 ${Array.isArray(记录.tasks) ? 记录.tasks.length : 0} 个任务触发的，已经全部执行完。`
    const 未送达 = new Set(会话们)
    const 重试间隔 = Number(选项.汇报重试毫秒) > 0 ? Number(选项.汇报重试毫秒) : 5000
    const 最多重试 = Number(选项.汇报重试次数) > 0 ? Number(选项.汇报重试次数) : 8
    let 次数 = 0
    let 定时器 = null

    const 尝试 = () => {
      for (const 会话 of [...未送达]) {
        if (注入(会话, 文本, { reason: 'restarted', taskId: 记录.id })) 未送达.delete(会话)
      }
      if (未送达.size === 0) {
        记录.已汇报 = true
        调度器.落盘()
        if (定时器) clearTimeout(定时器)
        定时器 = null
        日志.info?.('开机汇报已送达全部会话')
        return
      }
      次数 += 1
      if (次数 >= 最多重试) {
        记录.已汇报 = false
        记录.汇报未送达 = [...未送达]
        日志.warn?.(`开机汇报还有 ${未送达.size} 个会话没送达（已放弃重试）`)
        return
      }
      定时器 = setTimeout(尝试, 重试间隔)
      定时器.unref?.()
    }

    // 刚开机时会话可能还没加载完，稍等一拍再送。
    定时器 = setTimeout(尝试, Math.min(2000, 重试间隔))
    定时器.unref?.()
    日志.info?.(`待汇报重启完成：${会话们.length} 个会话`)
    return () => {
      if (定时器) clearTimeout(定时器)
      定时器 = null
    }
  } catch (错误) {
    日志.warn?.('安排开机汇报失败（不影响使用）', 错误)
    return null
  }
}

// ———————————————————————— 工具 ————————————————————————

function 造工具(ctx, 调度器, 日志, 选项 = {}) {
  const 执行 = async (参数 = {}, exec) => {
    const 动作 = String(参数?.action || '').trim()
    if (!动作) return 工具错误('缺少 action', '可用动作：schedule / cancel / status')

    if (动作 === 'status') {
      const 快照 = 调度器.快照()
      const 任务 = 快照.tasks.map((项) => ({
        ...项,
        排任务会话: 项.sessionLabel || 项.sessionId,
      }))
      const 提示 =
        任务.length === 0
          ? '现在没有任何重启任务。'
          : `共 ${任务.length} 个任务，阶段：${快照.phase}${快照.paused ? '（已暂停）' : ''}。`
      return {
        ok: true,
        action: 'status',
        phase: 快照.phase,
        暂停: 快照.paused,
        忙碌会话数: 快照.busyCount,
        任务,
        lastRestart: 快照.lastRestart,
        hint: 提示,
      }
    }

    if (动作 === 'schedule') {
      const 会话 = 解析调用会话(exec)
      const 结果 = 调度器.排任务({
        sessionId: 会话,
        sessionLabel: 会话标签(ctx, 会话),
        delaySeconds: 参数?.delaySeconds,
        wakeText: 参数?.wakeText,
        reason: 参数?.reason,
        source: 'tool',
      })
      const 快照 = 调度器.快照()
      const 排队说明 =
        快照.busyCount > 0
          ? `现在还有 ${快照.busyCount} 个会话在跑，任务先排队，等全部空闲才开始倒计时。`
          : '现在全部会话空闲，马上开始倒计时。'
      return {
        ok: true,
        action: 'schedule',
        task: 结果.任务,
        phase: 快照.phase,
        busyCount: 快照.busyCount,
        hint: `已排上：${结果.任务.delaySeconds} 秒后重启（${排队说明}）`,
        note: '倒计时开始后界面上会弹框；鼠标一移动就暂停，停 1 秒恢复；任何时候都能取消。',
      }
    }

    if (动作 === 'cancel') {
      const taskId = String(参数?.taskId || '').trim()
      if (!taskId) {
        const 快照 = 调度器.快照()
        if (快照.tasks.length === 0) return 工具错误('没有可取消的任务', '先用 status 看看。')
        return 工具错误(
          '缺少 taskId',
          `要用 taskId 指定取消哪个任务：${快照.tasks.map((项) => 项.id).join('、')}`,
        )
      }
      const 结果 = 调度器.取消任务(taskId, { source: 'tool' })
      if (!结果.ok) {
        return { ok: false, code: 'not_found', error: 结果.错误, 任务数: 结果.任务数 }
      }
      return {
        ok: true,
        action: 'cancel',
        task: 结果.任务,
        已投递反馈: 结果.已投递反馈,
        剩余任务数: 结果.剩余任务数,
        hint: 结果.已投递反馈
          ? '任务已取消，已给排任务的会话发了反馈（它会因此被唤醒，倒计时自动暂停）。'
          : '任务已取消，但排任务的会话当前不在线，反馈没送达。',
      }
    }

    return 工具错误(`不认识的动作 ${动作}`, '可用动作：schedule / cancel / status')
  }

  return {
    name: 'dsh_restart',
    description:
      '排 / 取消 / 查看 DSH 重启任务。schedule 让 DSH 在指定延迟后重启（所有会话空闲才开始倒计时，鼠标移动会暂停倒计时）。重启前会把唤醒事件写进 schedule.json，重启后自动唤醒排任务的会话。',
    parameters: 工具参数,
    output: 工具输出,
    execute: 执行,
  }
}

// ———————————————————————— 入口 ————————————————————————

/** DSH 插件入口：任何异常都吞掉，绝不影响宿主。 */
export function apply(ctx, 配置) {
  try {
    return 装配(ctx, 配置 || {})
  } catch (错误) {
    try {
      console.error(`[${插件名}] 插件加载失败（已忽略，不影响 DSH）:`, 错误)
    } catch {
      /* 忽略 */
    }
    return null
  }
}

// 供测试/调试：读状态文件。
export { 读JSON as 读状态文件 }
