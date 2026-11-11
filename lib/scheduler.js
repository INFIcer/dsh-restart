// 重启调度状态机（宿主侧，权威状态）。
//
// 规则（主人原话逐条落在这里）：
//  1. 多个会话可以各排各的任务，同时存在多个任务。
//  2. 有会话在运行时任务排队等待（phase='waiting'）；所有会话都空闲后才开始倒计时。
//  3. 鼠标移动让全部倒计时暂停（宿主侧真的不减剩余时间，重启不会被误触发）；
//     停止移动 1 秒后自动恢复。
//  4. 打开对话框的瞬间，剩余不足 5 秒的任务抬回 5 秒（≥5 秒的不动）。
//  5. 任意任务倒计时到 0 → 触发重启；同批任务一起进入唤醒事件。
//  6. 取消任务要删任务并给调用会话注入反馈（注入会唤醒会话 → 又变成有会话在跑 → 倒计时自动暂停）。
//
// 这里不碰文件、不碰 HTTP、不碰 PowerShell：全部通过注入的依赖做，
// 所以测试可以用假时钟 / 假会话 / 假触发，绝不真的重启。

import { randomUUID } from 'node:crypto'
import {
  默认延迟秒,
  最小延迟秒,
  最大延迟秒,
  弹框最小剩余秒,
  鼠标暂停保持毫秒,
  状态落盘间隔毫秒,
  默认唤醒文本,
  取消反馈前缀,
} from './constants.js'

const 空日志 = { info() {}, warn() {}, error() {} }

/** 生成任务 id：restart-<uuid>。 */
export function 生成任务Id() {
  return `restart-${randomUUID()}`
}

/** 延迟秒数规范化：非数字用兜底，再夹到 [10, 3600]。 */
export function 规范延迟秒(值, 兜底 = 默认延迟秒) {
  const 数 = Number(值)
  if (!Number.isFinite(数)) return 兜底
  const 整 = Math.round(数)
  if (整 < 最小延迟秒) return 最小延迟秒
  if (整 > 最大延迟秒) return 最大延迟秒
  return 整
}

function 取秒(毫秒) {
  return Math.max(0, Math.ceil(毫秒 / 1000))
}

/** 任务对外快照（给 HTTP 和工具用，不含内部字段）。 */
export function 任务摘要(任务) {
  if (!任务 || typeof 任务 !== 'object') return null
  const 有剩余 = 任务.remainingMs != null && Number.isFinite(Number(任务.remainingMs))
  return {
    id: String(任务.id || ''),
    sessionId: String(任务.sessionId || ''),
    sessionLabel: String(任务.sessionLabel || ''),
    reason: String(任务.reason || ''),
    wakeText: String(任务.wakeText || ''),
    delaySeconds: Number(任务.delaySeconds) || 默认延迟秒,
    status: String(任务.status || 'waiting'),
    started: 有剩余,
    remainingMs: 有剩余 ? Math.max(0, Math.round(Number(任务.remainingMs))) : null,
    remainingSeconds: 有剩余 ? 取秒(Number(任务.remainingMs)) : null,
    createdAt: 任务.createdAt || null,
  }
}

/** 取消任务时注入给会话的反馈文本。 */
export function 取消反馈文本(任务) {
  const 剩余 = 任务?.remainingMs != null ? 取秒(任务.remainingMs) : null
  const 位置 = 剩余 != null ? `（还剩约 ${剩余} 秒时取消）` : '（还没开始倒计时）'
  const 原因 = 任务?.reason ? `，备注：${任务.reason}` : ''
  return `${取消反馈前缀}你排的 DSH 重启任务已取消${位置}${原因}。不会重启了，不用管它。`
}

/** 把磁盘上读回来的任务列表整理成内部形状；坏数据直接丢。 */
export function 规范化任务列表(值) {
  if (!Array.isArray(值)) return []
  const 结果 = []
  for (const 原 of 值) {
    if (!原 || typeof 原 !== 'object') continue
    const id = typeof 原.id === 'string' ? 原.id.trim() : ''
    if (!id) continue
    if (结果.some((t) => t.id === id)) continue
    const 任务 = {
      id,
      sessionId: String(原.sessionId || ''),
      sessionLabel: String(原.sessionLabel || ''),
      delaySeconds: 规范延迟秒(原.delaySeconds),
      wakeText: String(原.wakeText || '').trim() || 默认唤醒文本,
      reason: String(原.reason || '').slice(0, 500),
      createdAt: typeof 原.createdAt === 'string' ? 原.createdAt : new Date().toISOString(),
      remainingMs: null,
      startedAt: null,
      status: 'waiting',
      source: String(原.source || 'restore'),
    }
    const 剩余 = Number(原.remainingMs)
    if (Number.isFinite(剩余) && 原.remainingMs != null) {
      任务.remainingMs = Math.max(1, 剩余)
      任务.startedAt = typeof 原.startedAt === 'number' ? 原.startedAt : null
      任务.status = 'counting'
    }
    结果.push(任务)
  }
  return 结果
}

/**
 * 重启调度器。
 *
 * 依赖（全部可注入，测试用假实现）：
 *  - now(): number                    当前毫秒时间戳
 *  - getBusySessions(): 数组           正在运行的会话；元素 { id, sessionId, status, sessionLabel? }
 *  - persist(state): void              状态落盘（原子写）
 *  - load(): state|null                开机读状态
 *  - readMarker(): object|null         重启脚本写的“已重启”标记
 *  - onFire(payload): Promise<结果>      到点触发重启（写脚本 + 脱离进程树拉起）
 *  - injectToSession(sessionId, 文本, 元信息): boolean   给会话注入反馈消息
 *  - logger                            日志
 */
export class 重启调度器 {
  constructor(依赖 = {}) {
    this.now = typeof 依赖.now === 'function' ? 依赖.now : () => Date.now()
    this.getBusySessions = 依赖.getBusySessions
    this.persist = 依赖.persist
    this.load = 依赖.load
    this.readMarker = 依赖.readMarker
    this.onFire = 依赖.onFire
    this.injectToSession = 依赖.injectToSession
    this.logger = 依赖.logger || 空日志

    /** @type {Array<object>} 当前任务（含已开始倒计时的） */
    this.tasks = []
    /** @type {{reason:string, at:number, lastSignalAt:number}|null} */
    this.paused = null
    /** idle | waiting | countdown | paused | firing */
    this.phase = 'idle'
    /** @type {object|null} 最近一次重启的记录（重启后靠它判断“已重启”） */
    this.lastRestart = null
    this.lastTickAt = null
    this.firing = false
    this.timer = null
    this.上次落盘 = null
    this.已启动记录 = null
    this.已初始化 = false
  }

  // ———————————————————————————— 启动 / 持久化 ————————————————————————————

  /** 开机：读盘 → 恢复任务 → 用标记文件确认上一条重启记录。 */
  初始化() {
    this.已初始化 = true
    let 原状态 = null
    try {
      原状态 = typeof this.load === 'function' ? this.load() : null
    } catch (错误) {
      this.logger.warn?.('读取状态文件失败', 错误)
    }
    if (原状态 && typeof 原状态 === 'object') {
      this.tasks = 规范化任务列表(原状态.tasks)
      this.lastRestart =
        原状态.lastRestart && typeof 原状态.lastRestart === 'object' ? 原状态.lastRestart : null
    }
    this.paused = null
    this.phase = this.tasks.length > 0 ? 'waiting' : 'idle'
    this.lastTickAt = this.now()
    this.上次落盘 = null

    const 启动记录 = {
      at: new Date(this.now()).toISOString(),
      restoredTasks: this.tasks.length,
      marker: null,
      confirmed: false,
    }

    if (this.lastRestart && this.lastRestart.status === 'firing') {
      let 标记 = null
      try {
        标记 = typeof this.readMarker === 'function' ? this.readMarker() : null
      } catch (错误) {
        this.logger.warn?.('读取重启标记失败', 错误)
      }
      const 标记状态 = 标记 && typeof 标记.status === 'string' ? 标记.status : ''
      启动记录.marker = 标记状态 || null
      if (标记状态 === 'launched' || 标记状态 === 'restarted') {
        this.lastRestart = {
          ...this.lastRestart,
          status: 'restarted',
          restartedAt: 标记.readyAt || 标记.launchedAt || 标记.at || null,
          ready: 标记.ready === true,
          ports: Array.isArray(标记.ports) ? 标记.ports : [],
          confirmedAt: new Date(this.now()).toISOString(),
        }
        启动记录.confirmed = true
      } else if (标记状态 === 'started') {
        // 脚本刚起了个头就没了；DSH 现在却活着 —— 记录为“未确认重启”，不猜。
        this.lastRestart = {
          ...this.lastRestart,
          status: 'restarted-unconfirmed',
          confirmedAt: new Date(this.now()).toISOString(),
        }
      } else if (标记状态 === 'launch-failed') {
        this.lastRestart = {
          ...this.lastRestart,
          status: 'launch-failed',
          error: String(标记.error || '重启脚本拉起 DSH 失败'),
          confirmedAt: new Date(this.now()).toISOString(),
        }
      } else {
        this.lastRestart = {
          ...this.lastRestart,
          status: 'unknown',
          confirmedAt: new Date(this.now()).toISOString(),
        }
      }
    }

    this.已启动记录 = 启动记录
    this.落盘()
    this.logger.info?.(
      `调度器初始化：恢复 ${this.tasks.length} 个任务，上次重启记录 ${this.lastRestart?.status || '无'}`,
    )
    return this.快照()
  }

  /** 序列化成落盘结构。 */
  序列化() {
    return {
      插件: 'dsh-restart-plugin',
      版本: 1,
      updatedAt: new Date(this.now()).toISOString(),
      phase: this.phase,
      paused: this.paused
        ? {
            reason: this.paused.reason,
            at: new Date(this.paused.at || this.now()).toISOString(),
            lastSignalAt: new Date(this.paused.lastSignalAt || this.now()).toISOString(),
          }
        : null,
      tasks: this.tasks.map((任务) => ({ ...任务 })),
      lastRestart: this.lastRestart,
      lastBoot: this.已启动记录,
    }
  }

  /** 落盘；force=false 时按 状态落盘间隔毫秒 节流。 */
  落盘(force = true) {
    const 现在 = this.now()
    if (force !== true && this.上次落盘 != null && 现在 - this.上次落盘 < 状态落盘间隔毫秒) {
      return false
    }
    this.上次落盘 = 现在
    try {
      this.persist?.(this.序列化())
      return true
    } catch (错误) {
      this.logger.warn?.('状态落盘失败', 错误)
      return false
    }
  }

  // ———————————————————————————— 查询 ————————————————————————————

  /** 读当前忙碌（运行中）的会话；读不到就当全空闲，避免卡死。 */
  读忙碌() {
    try {
      const 原始 = typeof this.getBusySessions === 'function' ? this.getBusySessions() : []
      if (!Array.isArray(原始)) return []
      const 结果 = []
      for (const 项 of 原始) {
        if (!项) continue
        const 会话 = String(项.sessionId || 项.id || '').trim()
        if (!会话) continue
        结果.push({
          id: String(项.id || 会话),
          sessionId: 会话,
          status: String(项.status || ''),
          sessionLabel: String(项.sessionLabel || ''),
        })
      }
      return 结果
    } catch (错误) {
      this.logger.warn?.('读取会话忙闲失败', 错误)
      return []
    }
  }

  /** 给 HTTP / 工具用的完整快照。 */
  快照() {
    const 忙碌 = this.读忙碌()
    const 任务 = this.tasks.map(任务摘要)
    const 有剩余 = 任务.filter((t) => t.remainingMs != null)
    const 最近剩余 = 有剩余.length ? Math.min(...有剩余.map((t) => t.remainingMs)) : null
    return {
      ok: true,
      插件: 'dsh-restart-plugin',
      phase: this.phase,
      paused: this.paused != null,
      pauseReason: this.paused?.reason || null,
      busyCount: 忙碌.length,
      busy: 忙碌,
      tasks: 任务,
      taskCount: 任务.length,
      nearestRemainingMs: 最近剩余,
      nearestRemainingSeconds: 最近剩余 == null ? null : 取秒(最近剩余),
      now: this.now(),
      lastRestart: this.lastRestart,
      lastBoot: this.已启动记录,
    }
  }

  // ———————————————————————————— 排任务 / 取消 ————————————————————————————

  /** 排一个新重启任务。 */
  排任务(参数 = {}) {
    const 现在 = this.now()
    const 任务 = {
      id: 生成任务Id(),
      sessionId: String(参数.sessionId || '').trim(),
      sessionLabel: String(参数.sessionLabel || '').trim(),
      delaySeconds: 规范延迟秒(参数.delaySeconds),
      wakeText: String(参数.wakeText || '').trim() || 默认唤醒文本,
      reason: String(参数.reason || '').trim().slice(0, 500),
      createdAt: new Date(现在).toISOString(),
      remainingMs: null,
      startedAt: null,
      status: 'waiting',
      source: String(参数.source || 'tool'),
    }
    this.tasks.push(任务)
    const 有倒计时 = this.tasks.some((项) => 项.remainingMs != null)
    if (!有倒计时) this.phase = 'waiting'
    // 已经在倒计时/暂停时不要把 lastTickAt 拉到现在，否则会丢掉上一拍的时间差。
    if (this.lastTickAt == null) this.lastTickAt = 现在
    this.落盘()
    this.logger.info?.(
      `排任务 ${任务.id}：${任务.delaySeconds} 秒，会话 ${任务.sessionId || '(未知)'}`,
    )
    return { ok: true, 任务: 任务摘要(任务), 阶段: this.phase, 任务数: this.tasks.length }
  }

  /**
   * 取消任务：删掉 + 给调用会话注入反馈（会唤醒它 → 倒计时自动停）。
   * 返回结果里带注入是否真的送达。
   */
  取消任务(taskId, 选项 = {}) {
    const 编号 = String(taskId || '').trim()
    const 序号 = this.tasks.findIndex((任务) => 任务.id === 编号)
    if (序号 < 0) {
      return {
        ok: false,
        code: 'not_found',
        错误: `没有任务 ${编号 || '(空)'}`,
        任务数: this.tasks.length,
      }
    }
    const [任务] = this.tasks.splice(序号, 1)
    任务.status = 'cancelled'
    const 反馈 = 取消反馈文本(任务)
    let 已投递 = false
    try {
      已投递 =
        typeof this.injectToSession === 'function'
          ? this.injectToSession(任务.sessionId, 反馈, { source: 'cancel', taskId: 任务.id, by: 选项.source }) === true
          : false
    } catch (错误) {
      this.logger.warn?.('取消反馈注入失败', 错误)
    }
    if (this.tasks.length === 0) {
      this.phase = 'idle'
      this.paused = null
    }
    this.lastTickAt = this.now()
    this.落盘()
    this.logger.info?.(`取消任务 ${任务.id}（反馈${已投递 ? '已投递' : '未投递'}）`)
    return {
      ok: true,
      任务: 任务摘要(任务),
      已投递反馈: 已投递,
      反馈文本: 反馈,
      剩余任务数: this.tasks.length,
      阶段: this.phase,
      来源: String(选项.source || 'panel'),
    }
  }

  // ———————————————————————————— 暂停 / 恢复 ————————————————————————————

  /** 暂停全部倒计时（鼠标移动时反复调用，刷新 lastSignalAt）。 */
  暂停(原因 = 'mouse') {
    const 现在 = this.now()
    const 标识 = String(原因 || 'mouse')
    if (this.tasks.length === 0) {
      return { ok: true, 已暂停: false, 跳过: '没有任务', 阶段: this.phase }
    }
    if (this.paused && this.paused.reason === 标识) {
      this.paused.lastSignalAt = 现在
      this.paused.信号数 = (this.paused.信号数 || 1) + 1
      return { ok: true, 已暂停: true, 阶段: this.phase, 原因: 标识 }
    }
    this.paused = { reason: 标识, at: 现在, lastSignalAt: 现在, 信号数: 1 }
    if (this.phase === 'countdown') this.phase = 'paused'
    this.lastTickAt = 现在
    this.落盘()
    this.logger.info?.('倒计时暂停：' + 标识)
    return { ok: true, 已暂停: true, 阶段: this.phase, 原因: 标识 }
  }

  /** 恢复倒计时（暂停期间的时间不会补扣）。 */
  恢复(原因 = 'mouse') {
    if (!this.paused) return { ok: true, 已暂停: false, 变化: false, 阶段: this.phase }
    const 原原因 = this.paused.reason
    this.paused = null
    this.lastTickAt = this.now()
    if (this.tasks.length === 0) this.phase = 'idle'
    else if (this.phase === 'paused') {
      this.phase = this.tasks.some((任务) => 任务.remainingMs != null) ? 'countdown' : 'waiting'
    }
    this.落盘()
    this.logger.info?.('倒计时恢复（原暂停原因：' + 原原因 + '）')
    return { ok: true, 已暂停: false, 变化: true, 原原因, 阶段: this.phase, 触发原因: String(原因 || 'mouse') }
  }

  /**
   * 打开对话框：剩余不足 5 秒的任务恢复成 5 秒（≥5 秒的不动，未开始的也不动）。
   */
  打开对话框() {
    const 现在 = this.now()
    const 提升 = []
    for (const 任务 of this.tasks) {
      if (任务.remainingMs == null) continue
      if (任务.remainingMs < 弹框最小剩余秒 * 1000) {
        任务.remainingMs = 弹框最小剩余秒 * 1000
        任务.bumpedAt = new Date(现在).toISOString()
        提升.push(任务.id)
      }
    }
    if (提升.length > 0) this.落盘()
    if (提升.length > 0) this.logger.info?.(`打开对话框：${提升.length} 个任务抬回 ${弹框最小剩余秒} 秒`)
    return { ok: true, 提升任务: 提升, 提升数量: 提升.length, 快照: this.快照() }
  }

  // ———————————————————————————— 心跳 / 触发 ————————————————————————————

  /**
   * 状态机心跳。宿主每 250ms 调一次；测试用假时钟手动调。
   * 顺序：自动恢复暂停 → 没任务收尾 → 有会话在跑就排队 → 暂停就停 → 全空闲才开始/继续倒计时 → 到点触发。
   */
  async tick() {
    if (this.firing) return { ok: true, 阶段: 'firing', 跳过: '正在重启' }
    const 现在 = this.now()
    try {
      // 鼠标暂停的兜底：客户端没了也能在 1 秒后自动恢复，重启不会被永久卡住。
      if (this.paused && 现在 - (this.paused.lastSignalAt || this.paused.at || 0) >= 鼠标暂停保持毫秒) {
        this.paused = null
        this.lastTickAt = 现在
        this.logger.info?.('鼠标暂停超时，自动恢复')
      }

      if (this.tasks.length === 0) {
        if (this.paused) this.paused = null
        if (this.phase !== 'idle') {
          this.phase = 'idle'
          this.落盘()
        }
        this.lastTickAt = 现在
        return { ok: true, 阶段: 'idle' }
      }

      const 忙碌 = this.读忙碌()
      if (忙碌.length > 0) {
        this.phase = 'waiting'
        this.lastTickAt = 现在
        return { ok: true, 阶段: 'waiting', 忙碌数: 忙碌.length }
      }

      if (this.paused) {
        if (this.phase !== 'paused') {
          this.phase = 'paused'
          this.落盘()
        }
        this.lastTickAt = 现在
        return { ok: true, 阶段: 'paused' }
      }

      const 上一阶段 = this.phase
      const 新开始 = []
      for (const 任务 of this.tasks) {
        if (任务.remainingMs == null) {
          任务.remainingMs = 任务.delaySeconds * 1000
          任务.startedAt = 现在
          任务.status = 'counting'
          新开始.push(任务)
        }
      }
      if (上一阶段 === 'countdown' && this.lastTickAt != null) {
        const 流逝 = Math.max(0, 现在 - this.lastTickAt)
        if (流逝 > 0) {
          for (const 任务 of this.tasks) {
            if (新开始.includes(任务)) continue
            任务.remainingMs -= 流逝
          }
        }
      }
      this.phase = 'countdown'
      this.lastTickAt = 现在

      const 到期 = this.tasks.filter((任务) => 任务.remainingMs <= 0)
      if (到期.length > 0) {
        await this.触发(现在)
        return { ok: true, 阶段: 'firing', 到期任务: 到期.map((任务) => 任务.id) }
      }

      this.落盘(上一阶段 !== 'countdown')
      return {
        ok: true,
        阶段: 'countdown',
        最近剩余毫秒: Math.min(...this.tasks.map((任务) => 任务.remainingMs)),
      }
    } catch (错误) {
      this.logger.error?.('调度心跳失败', 错误)
      return { ok: false, 错误: String(错误?.message || 错误) }
    }
  }

  /**
   * 到点触发：先把状态和触发记录落盘，再调用 onFire（写脚本 + schtasks 脱离进程树）。
   * onFire 失败不算世界末日：记 fire-failed、清任务、给会话注入失败反馈（fail-open）。
   */
  async 触发(现在) {
    this.firing = true
    this.phase = 'firing'
    const 触发任务 = this.tasks.map((任务) => ({ ...任务 }))
    this.tasks = []
    this.paused = null
    const 运行编号 = `restart-run-${randomUUID()}`
    const 会话编号 = [...new Set(触发任务.map((任务) => 任务.sessionId).filter(Boolean))]
    const 任务列表 = 触发任务.map(任务摘要)

    this.lastRestart = {
      id: 运行编号,
      status: 'firing',
      firedAt: new Date(现在).toISOString(),
      tasks: 任务列表,
      sessionIds: 会话编号,
    }
    this.落盘()
    this.logger.info?.(`倒计时到点，触发重启：${任务列表.length} 个任务 / ${会话编号.length} 个会话`)

    const 载荷 = {
      runId: 运行编号,
      firedAt: this.lastRestart.firedAt,
      tasks: 任务列表,
      sessionIds: 会话编号,
    }

    try {
      const 结果 = await this.onFire?.(载荷)
      if (结果 && 结果.ok === false) {
        throw Object.assign(new Error(String(结果.error || 结果.错误 || '触发重启失败')), {
          code: String(结果.code || 'fire_failed'),
        })
      }
      this.lastRestart = {
        ...this.lastRestart,
        status: 'firing',
        已触发: true,
        scriptPath: String(结果?.scriptPath || ''),
        触发方式: String(结果?.launcher || ''),
        唤醒事件数: Number(结果?.wakeCount || 0),
        触发完成时间: new Date(this.now()).toISOString(),
      }
      this.落盘()
      return { ok: true, 运行编号 }
    } catch (错误) {
      this.lastRestart = {
        ...this.lastRestart,
        status: 'fire-failed',
        error: String(错误?.message || 错误),
        failedAt: new Date(this.now()).toISOString(),
      }
      this.firing = false
      this.phase = 'idle'
      this.lastTickAt = this.now()
      const 失败文本 = `${取消反馈前缀}重启触发失败：${String(错误?.message || 错误)}。任务已清空，请手动重启或稍后再排。`
      for (const 会话 of 会话编号) {
        try {
          this.injectToSession?.(会话, 失败文本, { source: 'fire-failed' })
        } catch {
          /* fail-open */
        }
      }
      this.落盘()
      this.logger.error?.('触发重启失败（已吞掉，不影响 DSH）', 错误)
      return { ok: false, 错误: String(错误?.message || 错误) }
    }
  }

  /**
   * 有人值守时立即重启：跳过「等所有会话空闲」和剩余倒计时，直接把现有任务全部触发。
   * 脚本链路不变（写脚本 → schtasks 脱离进程树 → 清 cookie → 写唤醒事件 → WMI 拉起）。
   */
  async 立即重启(选项 = {}) {
    if (this.firing) return { ok: false, code: 'firing', 错误: '已经在重启中' }
    if (this.tasks.length === 0) {
      return { ok: false, code: 'no_tasks', 错误: '现在没有待执行的重启任务', 任务数: 0 }
    }
    const 任务数 = this.tasks.length
    this.logger.info?.(`立即重启：跳过等待与倒计时，马上执行（${任务数} 个任务）`)
    const 结果 = await this.触发(this.now())
    return { ...结果, 立即: true, 任务数, 触发者: String(选项.source || 'panel') }
  }

  /** 是否正在执行重启。 */
  get 重启中() {
    return this.firing
  }

  // ———————————————————————————— 定时器 ————————————————————————————

  /** 宿主里启动心跳（测试不用这个，手动 tick）。 */
  启动(间隔毫秒 = 250) {
    if (this.timer) return false
    this.timer = setInterval(() => {
      void this.tick()
    }, Math.max(50, Number(间隔毫秒) || 250))
    this.timer.unref?.()
    return true
  }

  /** 停止心跳。 */
  停止() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      return true
    }
    return false
  }
}
