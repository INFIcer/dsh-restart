// 重启调度状态机（宿主侧，权威状态）。
//
// 调度规则：
//  1. 多个会话可以各排各的任务，同时存在多个任务。
//  2. 有会话在运行时任务排队等待（phase='waiting'）；所有会话都空闲后才开始倒计时。
//  3. 任何输入让全部倒计时暂停（宿主侧真的不减剩余时间，重启不会被误触发）；
//     停止输入 1 秒后自动恢复。
//  4. 打开对话框的瞬间，剩余不足 5 秒的任务抬回 5 秒（≥5 秒的不动）。
//  5. 任意任务倒计时到 0 → 触发重启；同批任务一起进入唤醒事件。
//  6. 取消任务要删任务并给调用会话注入反馈（注入会唤醒会话 → 又变成有会话在跑 → 倒计时自动暂停）。
//
// 这里不碰文件、不碰 HTTP、不碰 PowerShell：全部通过注入的依赖做，
// 所以测试可以用假时钟 / 假会话 / 假触发，绝不真的重启。

import { randomUUID } from 'node:crypto'
import {
  stateVersion,
  defaultDelaySeconds,
  minDelaySeconds,
  maxDelaySeconds,
  dialogMinRemainingSeconds,
  inputPauseHoldMs,
  statePersistIntervalMs,
  restartConfirmTimeoutMs,
  bootMarkerPollIntervalMs,
  cancelFeedbackPrefix,
} from './constants.js'
import { normalizeWakeText } from './text.js'

const silentLogger = { info() {}, warn() {}, error() {} }

/** 生成任务 id：restart-<uuid>。 */
export function generateTaskId() {
  return `restart-${randomUUID()}`
}

/** 延迟秒数规范化：非数字用兜底，再夹到 [10, 3600]。 */
export function normalizeDelaySeconds(value, fallback = defaultDelaySeconds) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  const rounded = Math.round(numeric)
  if (rounded < minDelaySeconds) return minDelaySeconds
  if (rounded > maxDelaySeconds) return maxDelaySeconds
  return rounded
}

function toSeconds(ms) {
  return Math.max(0, Math.ceil(ms / 1000))
}

/** 任务对外快照（给 HTTP 和工具用，不含内部字段）。 */
export function taskSummary(task) {
  if (!task || typeof task !== 'object') return null
  const hasRemaining = task.remainingMs != null && Number.isFinite(Number(task.remainingMs))
  return {
    id: String(task.id || ''),
    sessionId: String(task.sessionId || ''),
    sessionLabel: String(task.sessionLabel || ''),
    reason: String(task.reason || ''),
    wakeText: String(task.wakeText || ''),
    delaySeconds: Number(task.delaySeconds) || defaultDelaySeconds,
    status: String(task.status || 'waiting'),
    started: hasRemaining,
    remainingMs: hasRemaining ? Math.max(0, Math.round(Number(task.remainingMs))) : null,
    remainingSeconds: hasRemaining ? toSeconds(Number(task.remainingMs)) : null,
    createdAt: task.createdAt || null,
  }
}

/**
 * 重启记录里的任务快照：去掉重启意图文本。
 *
 * 意图文本只服务于面板展示；重启记录会长期落盘，再存一份既重复又会让
 * 唤醒消息与用户的备忘纠缠，所以历史记录里不保留。
 */
export function historyTaskSummary(task) {
  const summary = taskSummary(task)
  if (!summary) return null
  delete summary.wakeText
  return summary
}

/**
 * 读旧状态文件时摘掉重启记录里的意图文本。
 * 老版本把它当唤醒正文存过一份，现在只认运行 id 与结果；字段留着会在下次落盘时被重写回去。
 */
function stripRestartWakeText(record) {
  if (!record || typeof record !== 'object') return null
  const next = { ...record }
  delete next.wakeText
  if (Array.isArray(next.tasks)) {
    next.tasks = next.tasks.map((task) => {
      if (!task || typeof task !== 'object') return task
      const copy = { ...task }
      delete copy.wakeText
      return copy
    })
  }
  return next
}

/** 取消任务时注入给会话的反馈文本。 */
export function cancelFeedbackText(task) {
  const remaining = task?.remainingMs != null ? toSeconds(task.remainingMs) : null
  const position = remaining != null ? `（还剩约 ${remaining} 秒时取消）` : '（还没开始倒计时）'
  const reason = task?.reason ? `，备注：${task.reason}` : ''
  return `${cancelFeedbackPrefix}你排的 DSH 重启任务已取消${position}${reason}。不会重启了，不用管它。`
}

/** 把磁盘上读回来的任务列表整理成内部形状；坏数据直接丢。 */
export function normalizeTaskList(value) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const rawItem of value) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const id = typeof rawItem.id === 'string' ? rawItem.id.trim() : ''
    if (!id) continue
    if (result.some((t) => t.id === id)) continue
    const task = {
      id,
      sessionId: String(rawItem.sessionId || ''),
      sessionLabel: String(rawItem.sessionLabel || ''),
      delaySeconds: normalizeDelaySeconds(rawItem.delaySeconds),
      wakeText: normalizeWakeText(rawItem.wakeText),
      reason: String(rawItem.reason || '').slice(0, 500),
      createdAt: typeof rawItem.createdAt === 'string' ? rawItem.createdAt : new Date().toISOString(),
      remainingMs: null,
      startedAt: null,
      status: 'waiting',
      source: String(rawItem.source || 'restore'),
    }
    const remaining = Number(rawItem.remainingMs)
    if (Number.isFinite(remaining) && rawItem.remainingMs != null) {
      task.remainingMs = Math.max(1, remaining)
      task.startedAt = typeof rawItem.startedAt === 'number' ? rawItem.startedAt : null
      task.status = 'counting'
    }
    result.push(task)
  }
  return result
}

/**
 * 旧版状态文件用中文键落盘；升级后要能继续恢复排队任务，所以读盘时把旧键归一成新键。
 * 只读兼容：写回一律用新键，旧键不再产生。
 */
function normalizeLegacyState(rawState) {
  if (!rawState || typeof rawState !== 'object') return rawState
  const state = { ...rawState }
  const alias = (target, key, legacyKey) => {
    if (target[key] == null && target[legacyKey] != null) target[key] = target[legacyKey]
  }
  alias(state, 'plugin', '插件')
  alias(state, 'version', '版本')
  if (state.lastRestart && typeof state.lastRestart === 'object') {
    const record = { ...state.lastRestart }
    alias(record, 'fired', '已触发')
    alias(record, 'launcher', '触发方式')
    alias(record, 'wakeCount', '唤醒事件数')
    alias(record, 'firedCompletedAt', '触发完成时间')
    alias(record, 'reported', '已汇报')
    alias(record, 'reportUndelivered', '汇报未送达')
    state.lastRestart = record
  }
  return state
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
 *  - injectToSession(sessionId, text, meta): boolean   给会话注入反馈消息
 *  - logger                            日志
 */
export class RestartScheduler {
  constructor(deps = {}) {
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now()
    this.getBusySessions = deps.getBusySessions
    this.persist = deps.persist
    this.load = deps.load
    this.readMarker = deps.readMarker
    this.onFire = deps.onFire
    this.injectToSession = deps.injectToSession
    this.logger = deps.logger || silentLogger
    // 轮询定时器可注入：测试用假时钟推进，不真等 500ms。
    this.setTimer = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout
    this.clearTimer = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout
    this.markerPollTimer = null
    this.markerPollStartedAt = null

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
    this.lastPersistAt = null
    this.bootRecord = null
    this.initialized = false
    /** 状态文件版本不符：不恢复、不覆盖，保留原文件等人工处理。 */
    this.stateIncompatible = false
  }

  // ———————————————————————————— 启动 / 持久化 ————————————————————————————

  /** 开机：读盘 → 恢复任务 → 用标记文件确认上一条重启记录。 */
  init() {
    this.initialized = true
    let rawState = null
    try {
      rawState = typeof this.load === 'function' ? this.load() : null
    } catch (error) {
      this.logger.warn?.('读取状态文件失败', error)
    }
    rawState = normalizeLegacyState(rawState)
    if (rawState && typeof rawState === 'object') {
      if (Number(rawState.version) !== stateVersion) {
        // 结构版本不符时绝不覆盖：旧文件留着，用户还能手动看 / 回滚。
        this.stateIncompatible = true
        this.logger.error?.(
          `状态文件版本不兼容（文件 ${String(rawState.version)}，期望 ${stateVersion}），本次不恢复也不覆盖`,
        )
      } else {
        // 意图文本只服务当前进程的面板展示：旧状态里残留的那份可能被当成唤醒正文写过，
        // 读回来既不再发送也不显示，避免同一段备忘在升级前后有两种语义。
        this.tasks = normalizeTaskList(rawState.tasks).map((task) => ({ ...task, wakeText: '' }))
        this.lastRestart = stripRestartWakeText(rawState.lastRestart)
      }
    }
    this.paused = null
    this.phase = this.tasks.length > 0 ? 'waiting' : 'idle'
    this.lastTickAt = this.now()
    this.lastPersistAt = null

    const bootEntry = {
      at: new Date(this.now()).toISOString(),
      restoredTasks: this.tasks.length,
      marker: null,
      confirmed: false,
    }
    this.bootRecord = bootEntry

    if (this.lastRestart && this.lastRestart.status === 'firing') {
      const marker = this.readBootMarker()
      bootEntry.marker = this.markerStatus(marker) || null
      if (this.isMarkerTerminal(marker)) {
        // 标记已经到终态：开机当场定案。
        this.applyMarkerResult(marker)
      } else {
        // 新实例先起来、脚本几秒后才把标记改成 restarted；只读一次会把成功误判成未确认。
        // 所以先记下启动现场，再在确认上限内有限轮询。
        this.markerPollStartedAt = this.now()
        this.armMarkerPoll()
      }
    }

    this.persistState()
    this.logger.info?.(
      `调度器初始化：恢复 ${this.tasks.length} 个任务，上次重启记录 ${this.lastRestart?.status || '无'}`,
    )
    return this.snapshot()
  }

  // ———————————————————————— 标记确认 ————————————————————————

  /** 读一次重启标记；读失败按没有标记处理。 */
  readBootMarker() {
    try {
      return typeof this.readMarker === 'function' ? this.readMarker() : null
    } catch (error) {
      this.logger.warn?.('读取重启标记失败', error)
      return null
    }
  }

  /** 标记里的状态字符串；缺失时返回空串。 */
  markerStatus(marker) {
    return marker && typeof marker.status === 'string' ? marker.status : ''
  }

  /**
   * 标记是否已经能定案：
   *  - restarted 且 ready=true：脚本已确认新实例端口可连；
   *  - stop-failed / launch-failed：脚本明确失败。
   * restarted 但还没 ready 说明脚本还在探端口，必须继续等。
   */
  isMarkerTerminal(marker) {
    const markerStatus = this.markerStatus(marker)
    if (markerStatus === 'restarted') return marker.ready === true
    return markerStatus === 'stop-failed' || markerStatus === 'launch-failed'
  }

  /**
   * 把标记结果写进 lastRestart / bootRecord。
   * 非终态标记只会在轮询超时时走到这里，按旧兜底归类：launched/started/restarted 未就绪
   * 记为 restarted-unconfirmed，没有可识别状态记为 unknown。
   */
  applyMarkerResult(marker) {
    const markerStatus = this.markerStatus(marker)
    const confirmedAt = new Date(this.now()).toISOString()
    this.bootRecord = this.bootRecord || {
      at: confirmedAt,
      restoredTasks: this.tasks.length,
      marker: null,
      confirmed: false,
    }
    this.bootRecord.marker = markerStatus || null
    this.bootRecord.confirmed = false
    if (markerStatus === 'restarted' && marker.ready === true) {
      // 只有「脚本确认新实例端口可连」才算重启成功；launched / ready=false 都只是拉起、未确认。
      this.lastRestart = {
        ...(this.lastRestart || {}),
        status: 'restarted',
        restartedAt: marker.readyAt || marker.launchedAt || marker.at || null,
        ready: true,
        pid: Number(marker.pid) || null,
        ports: Array.isArray(marker.ports) ? marker.ports : [],
        confirmedAt,
      }
      this.bootRecord.confirmed = true
    } else if (markerStatus === 'stop-failed') {
      this.lastRestart = {
        ...(this.lastRestart || {}),
        status: 'stop-failed',
        error: '旧实例没有停掉，已放弃拉起新实例',
        confirmedAt,
      }
    } else if (markerStatus === 'launched' || markerStatus === 'restarted' || markerStatus === 'started') {
      // 脚本刚起了个头就没了；DSH 现在却活着 —— 记录为“未确认重启”，不猜。
      this.lastRestart = {
        ...(this.lastRestart || {}),
        status: 'restarted-unconfirmed',
        confirmedAt,
      }
    } else if (markerStatus === 'launch-failed') {
      this.lastRestart = {
        ...(this.lastRestart || {}),
        status: 'launch-failed',
        error: String(marker.error || '重启脚本拉起 DSH 失败'),
        confirmedAt,
      }
    } else {
      this.lastRestart = {
        ...(this.lastRestart || {}),
        status: 'unknown',
        confirmedAt,
      }
    }
    return this.lastRestart?.status || null
  }

  /** 排下一次标记轮询；已有定时器先取消，避免重复轮询。 */
  armMarkerPoll() {
    this.clearMarkerPoll()
    if (this.markerPollStartedAt == null) this.markerPollStartedAt = this.now()
    const timer = this.setTimer(() => this.pollMarkerOnce(), bootMarkerPollIntervalMs)
    this.markerPollTimer = timer
    try {
      timer?.unref?.()
    } catch {
      /* 忽略 */
    }
  }

  /** 取消标记轮询。 */
  clearMarkerPoll() {
    if (this.markerPollTimer != null) {
      this.clearTimer(this.markerPollTimer)
      this.markerPollTimer = null
    }
  }

  /**
   * 轮询一拍：重读标记 → 终态就定案 → 没到上限就继续排下一拍 → 超时按兜底收尾。
   * 只处理 lastRestart.status === 'firing' 的记录，避免已经定案后又被旧标记改写。
   */
  pollMarkerOnce() {
    this.markerPollTimer = null
    if (!this.lastRestart || this.lastRestart.status !== 'firing') {
      this.markerPollStartedAt = null
      return
    }
    const marker = this.readBootMarker()
    const markerStatus = this.markerStatus(marker)
    if (this.bootRecord) this.bootRecord.marker = markerStatus || null

    if (this.isMarkerTerminal(marker)) {
      const status = this.applyMarkerResult(marker)
      this.markerPollStartedAt = null
      this.persistState()
      this.logger.info?.(`重启标记已到终态：${status || 'unknown'}`)
      return
    }

    const startedAt = Number(this.markerPollStartedAt)
    if (Number.isFinite(startedAt) && this.now() - startedAt >= restartConfirmTimeoutMs) {
      const status = this.applyMarkerResult(marker)
      this.markerPollStartedAt = null
      this.persistState()
      this.logger.warn?.(`重启标记确认超时（${restartConfirmTimeoutMs} ms），按 ${status || 'unknown'} 收尾`)
      return
    }
    this.armMarkerPoll()
  }

  /** 序列化成落盘结构。 */
  serialize() {
    return {
      plugin: 'dsh-restart-plugin',
      version: stateVersion,
      updatedAt: new Date(this.now()).toISOString(),
      phase: this.phase,
      paused: this.paused
        ? {
            reason: this.paused.reason,
            at: new Date(this.paused.at || this.now()).toISOString(),
            lastSignalAt: new Date(this.paused.lastSignalAt || this.now()).toISOString(),
          }
        : null,
      tasks: this.tasks.map((task) => ({ ...task })),
      lastRestart: this.lastRestart,
      lastBoot: this.bootRecord,
    }
  }

  /** 落盘；force=false 时按 状态落盘间隔毫秒 节流。 */
  persistState(force = true) {
    if (this.stateIncompatible) return false
    const now = this.now()
    if (force !== true && this.lastPersistAt != null && now - this.lastPersistAt < statePersistIntervalMs) {
      return false
    }
    this.lastPersistAt = now
    try {
      this.persist?.(this.serialize())
      return true
    } catch (error) {
      this.logger.warn?.('状态落盘失败', error)
      return false
    }
  }

  // ———————————————————————————— 查询 ————————————————————————————

  /** 读当前忙碌（运行中）的会话；读不到就当全空闲，避免卡死。 */
  readBusy() {
    try {
      const rawList = typeof this.getBusySessions === 'function' ? this.getBusySessions() : []
      if (!Array.isArray(rawList)) return []
      const result = []
      for (const item of rawList) {
        if (!item) continue
        const session = String(item.sessionId || item.id || '').trim()
        if (!session) continue
        result.push({
          id: String(item.id || session),
          sessionId: session,
          status: String(item.status || ''),
          sessionLabel: String(item.sessionLabel || ''),
        })
      }
      return result
    } catch (error) {
      this.logger.warn?.('读取会话忙闲失败', error)
      return []
    }
  }

  /** 给 HTTP / 工具用的完整快照。 */
  snapshot() {
    const busy = this.readBusy()
    const task = this.tasks.map(taskSummary)
    const hasRemaining = task.filter((t) => t.remainingMs != null)
    const nearestRemaining = hasRemaining.length ? Math.min(...hasRemaining.map((t) => t.remainingMs)) : null
    return {
      ok: true,
      plugin: 'dsh-restart-plugin',
      phase: this.phase,
      paused: this.paused != null,
      pauseReason: this.paused?.reason || null,
      busyCount: busy.length,
      busy: busy,
      tasks: task,
      taskCount: task.length,
      nearestRemainingMs: nearestRemaining,
      nearestRemainingSeconds: nearestRemaining == null ? null : toSeconds(nearestRemaining),
      now: this.now(),
      lastRestart: this.lastRestart,
      lastBoot: this.bootRecord,
      stateIncompatible: this.stateIncompatible,
    }
  }

  // ———————————————————————————— 排任务 / 取消 ————————————————————————————

  /** 排一个新重启任务。 */
  scheduleTask(params = {}) {
    const now = this.now()
    const task = {
      id: generateTaskId(),
      sessionId: String(params.sessionId || '').trim(),
      sessionLabel: String(params.sessionLabel || '').trim(),
      delaySeconds: normalizeDelaySeconds(params.delaySeconds),
      wakeText: normalizeWakeText(params.wakeText),
      reason: String(params.reason || '').trim().slice(0, 500),
      createdAt: new Date(now).toISOString(),
      remainingMs: null,
      startedAt: null,
      status: 'waiting',
      source: String(params.source || 'tool'),
    }
    this.tasks.push(task)
    const hasCountdown = this.tasks.some((item) => item.remainingMs != null)
    if (!hasCountdown) this.phase = 'waiting'
    // 已经在倒计时/暂停时不要把 lastTickAt 拉到现在，否则会丢掉上一拍的时间差。
    if (this.lastTickAt == null) this.lastTickAt = now
    this.persistState()
    this.logger.info?.(
      `排任务 ${task.id}：${task.delaySeconds} 秒，会话 ${task.sessionId || '(未知)'}`,
    )
    return { ok: true, task: taskSummary(task), phase: this.phase, taskCount: this.tasks.length }
  }

  /**
   * 取消任务：删掉 + 给调用会话注入反馈（会唤醒它 → 倒计时自动停）。
   * 返回结果里带注入是否真的送达。
   */
  cancelTask(taskId, options = {}) {
    const id = String(taskId || '').trim()
    const index = this.tasks.findIndex((task) => task.id === id)
    if (index < 0) {
      return {
        ok: false,
        code: 'not_found',
        error: `没有任务 ${id || '(空)'}`,
        taskCount: this.tasks.length,
      }
    }
    const [task] = this.tasks.splice(index, 1)
    task.status = 'cancelled'
    const feedback = cancelFeedbackText(task)
    let delivered = false
    try {
      delivered =
        typeof this.injectToSession === 'function'
          ? this.injectToSession(task.sessionId, feedback, { source: 'cancel', taskId: task.id, by: options.source }) === true
          : false
    } catch (error) {
      this.logger.warn?.('取消反馈注入失败', error)
    }
    if (this.tasks.length === 0) {
      this.phase = 'idle'
      this.paused = null
    }
    this.lastTickAt = this.now()
    this.persistState()
    this.logger.info?.(`取消任务 ${task.id}（反馈${delivered ? '已投递' : '未投递'}）`)
    return {
      ok: true,
      task: taskSummary(task),
      feedbackDelivered: delivered,
      feedbackText: feedback,
      remainingTaskCount: this.tasks.length,
      phase: this.phase,
      source: String(options.source || 'panel'),
    }
  }

  // ———————————————————————————— 暂停 / 恢复 ————————————————————————————

  /** 暂停全部倒计时（有输入时反复调用，刷新 lastSignalAt）。 */
  pause(reason = 'input') {
    const now = this.now()
    const signalKey = String(reason || 'input')
    if (this.tasks.length === 0) {
      return { ok: true, paused: false, skipped: '没有任务', phase: this.phase }
    }
    if (this.paused && this.paused.reason === signalKey) {
      this.paused.lastSignalAt = now
      this.paused.signalCount = (this.paused.signalCount || 1) + 1
      return { ok: true, paused: true, phase: this.phase, reason: signalKey }
    }
    this.paused = { reason: signalKey, at: now, lastSignalAt: now, signalCount: 1 }
    if (this.phase === 'countdown') this.phase = 'paused'
    this.lastTickAt = now
    this.persistState()
    this.logger.info?.('倒计时暂停：' + signalKey)
    return { ok: true, paused: true, phase: this.phase, reason: signalKey }
  }

  /** 恢复倒计时（暂停期间的时间不会补扣）。 */
  resume(reason = 'input') {
    if (!this.paused) return { ok: true, paused: false, changed: false, phase: this.phase }
    const previousReason = this.paused.reason
    this.paused = null
    this.lastTickAt = this.now()
    if (this.tasks.length === 0) this.phase = 'idle'
    else if (this.phase === 'paused') {
      this.phase = this.tasks.some((task) => task.remainingMs != null) ? 'countdown' : 'waiting'
    }
    this.persistState()
    this.logger.info?.('倒计时恢复（原暂停原因：' + previousReason + '）')
    return { ok: true, paused: false, changed: true, previousReason, phase: this.phase, triggerReason: String(reason || 'input') }
  }

  /**
   * 打开对话框：剩余不足 5 秒的任务恢复成 5 秒（≥5 秒的不动，未开始的也不动）。
   */
  openDialog() {
    const now = this.now()
    const raised = []
    for (const task of this.tasks) {
      if (task.remainingMs == null) continue
      if (task.remainingMs < dialogMinRemainingSeconds * 1000) {
        task.remainingMs = dialogMinRemainingSeconds * 1000
        task.bumpedAt = new Date(now).toISOString()
        raised.push(task.id)
      }
    }
    if (raised.length > 0) this.persistState()
    if (raised.length > 0) this.logger.info?.(`打开对话框：${raised.length} 个任务抬回 ${dialogMinRemainingSeconds} 秒`)
    return { ok: true, raisedTasks: raised, raisedCount: raised.length, snapshot: this.snapshot() }
  }

  // ———————————————————————————— 心跳 / 触发 ————————————————————————————

  /**
   * 状态机心跳。宿主每 250ms 调一次；测试用假时钟手动调。
   * 顺序：自动恢复暂停 → 没任务收尾 → 有会话在跑就排队 → 暂停就停 → 全空闲才开始/继续倒计时 → 到点触发。
   */
  async tick() {
    if (this.firing) {
      // 重启确认必须有上限：脚本可能被杀、计划任务可能没跑起来，否则 firing 会永久卡住。
      const current = this.now()
      const startedAt = Number(this.lastRestart?.firingStartedAt)
      if (Number.isFinite(startedAt) && current - startedAt >= restartConfirmTimeoutMs) {
        this.firing = false
        this.phase = 'idle'
        this.lastRestart = {
          ...(this.lastRestart || {}),
          status: 'firing-timeout',
          timedOutAt: new Date(current).toISOString(),
          error: '等待新实例确认超时',
        }
        const sessionIds = Array.isArray(this.lastRestart.sessionIds) ? this.lastRestart.sessionIds : []
        for (const session of sessionIds) {
          try {
            await this.injectToSession?.(
              session,
              `（重启调度）重启确认超时：${Math.round(restartConfirmTimeoutMs / 1000)} 秒内没等到新实例就绪。已自动复位，可以重新排任务。`,
            )
          } catch (error) {
            this.logger.warn?.('注入重启超时提示失败', error)
          }
        }
        this.persistState()
        this.logger.error?.('重启确认超时，已复位 firing')
        return { ok: true, phase: 'idle', timedOut: true }
      }
      return { ok: true, phase: 'firing', skipped: '正在重启' }
    }
    const now = this.now()
    try {
      // 输入暂停的兜底：客户端没了也能在 1 秒后自动恢复，重启不会被永久卡住。
      if (this.paused && now - (this.paused.lastSignalAt || this.paused.at || 0) >= inputPauseHoldMs) {
        this.paused = null
        this.lastTickAt = now
        this.logger.info?.('输入暂停超时，自动恢复')
      }

      if (this.tasks.length === 0) {
        if (this.paused) this.paused = null
        if (this.phase !== 'idle') {
          this.phase = 'idle'
          this.persistState()
        }
        this.lastTickAt = now
        return { ok: true, phase: 'idle' }
      }

      const busy = this.readBusy()
      if (busy.length > 0) {
        this.phase = 'waiting'
        this.lastTickAt = now
        return { ok: true, phase: 'waiting', busyCount: busy.length }
      }

      if (this.paused) {
        if (this.phase !== 'paused') {
          this.phase = 'paused'
          this.persistState()
        }
        this.lastTickAt = now
        return { ok: true, phase: 'paused' }
      }

      const previousPhase = this.phase
      const newStarted = []
      for (const task of this.tasks) {
        if (task.remainingMs == null) {
          task.remainingMs = task.delaySeconds * 1000
          task.startedAt = now
          task.status = 'counting'
          newStarted.push(task)
        }
      }
      if (previousPhase === 'countdown' && this.lastTickAt != null) {
        const elapsed = Math.max(0, now - this.lastTickAt)
        if (elapsed > 0) {
          for (const task of this.tasks) {
            if (newStarted.includes(task)) continue
            task.remainingMs -= elapsed
          }
        }
      }
      this.phase = 'countdown'
      this.lastTickAt = now

      const expired = this.tasks.filter((task) => task.remainingMs <= 0)
      if (expired.length > 0) {
        await this.fire(now)
        return { ok: true, phase: 'firing', expiredTaskIds: expired.map((task) => task.id) }
      }

      this.persistState(previousPhase !== 'countdown')
      return {
        ok: true,
        phase: 'countdown',
        nearestRemainingMs: Math.min(...this.tasks.map((task) => task.remainingMs)),
      }
    } catch (error) {
      this.logger.error?.('调度心跳失败', error)
      return { ok: false, error: String(error?.message || error) }
    }
  }

  /**
   * 到点触发：先把状态和触发记录落盘，再调用 onFire（写脚本 + schtasks 脱离进程树）。
   * onFire 失败不算世界末日：记 fire-failed、清任务、给会话注入失败反馈（fail-open）。
   */
  async fire(now) {
    this.firing = true
    this.phase = 'firing'
    const firingTasks = this.tasks.map((task) => ({ ...task }))
    this.tasks = []
    this.paused = null
    const runId = `restart-run-${randomUUID()}`
    const sessionIds = [...new Set(firingTasks.map((task) => task.sessionId).filter(Boolean))]
    const taskList = firingTasks.map(historyTaskSummary)

    this.lastRestart = {
      id: runId,
      status: 'firing',
      firedAt: new Date(now).toISOString(),
      firingStartedAt: now,
      tasks: taskList,
      sessionIds: sessionIds,
    }
    this.persistState()
    this.logger.info?.(`倒计时到点，触发重启：${taskList.length} 个任务 / ${sessionIds.length} 个会话`)

    const payload = {
      runId: runId,
      firedAt: this.lastRestart.firedAt,
      tasks: taskList,
      sessionIds: sessionIds,
    }

    try {
      const result = await this.onFire?.(payload)
      if (result && result.ok === false) {
        throw Object.assign(new Error(String(result.error || result.error || '触发重启失败')), {
          code: String(result.code || 'fire_failed'),
        })
      }
      this.lastRestart = {
        ...this.lastRestart,
        status: 'firing',
        fired: true,
        scriptPath: String(result?.scriptPath || ''),
        launcher: String(result?.launcher || ''),
        wakeCount: Number(result?.wakeCount || 0),
        // 重启前拍的插件设置快照：开机后据此校验并（必要时）再恢复一次。
        ...(result?.pluginStateSnapshot ? { pluginStateSnapshot: result.pluginStateSnapshot } : {}),
        firedCompletedAt: new Date(this.now()).toISOString(),
      }
      this.persistState()
      return { ok: true, runId }
    } catch (error) {
      this.lastRestart = {
        ...this.lastRestart,
        status: 'fire-failed',
        error: String(error?.message || error),
        failedAt: new Date(this.now()).toISOString(),
      }
      this.firing = false
      this.phase = 'idle'
      this.lastTickAt = this.now()
      const failureText = `${cancelFeedbackPrefix}重启触发失败：${String(error?.message || error)}。任务已清空，请手动重启或稍后再排。`
      for (const session of sessionIds) {
        try {
          this.injectToSession?.(session, failureText, { source: 'fire-failed' })
        } catch {
          /* fail-open */
        }
      }
      this.persistState()
      this.logger.error?.('触发重启失败（已吞掉，不影响 DSH）', error)
      return { ok: false, error: String(error?.message || error) }
    }
  }

  /**
   * 有人值守时立即重启：跳过剩余倒计时，直接把现有任务全部触发。
   * 还有会话在跑时拒绝：那等于掐掉正在跑的回合，跟「排一个不等待的任务」没区别，而面板上没有别的确认可依赖。
   * 脚本链路不变（写脚本 → schtasks 脱离进程树 → 清 cookie → 写唤醒事件 → WMI 拉起）。
   */
  async restartNow(options = {}) {
    if (this.firing) return { ok: false, code: 'firing', error: '已经在重启中' }
    if (this.tasks.length === 0) {
      return { ok: false, code: 'no_tasks', error: '现在没有待执行的重启任务', taskCount: 0 }
    }
    const taskCount = this.tasks.length
    const busy = this.readBusy()
    if (busy.length > 0) {
      return {
        ok: false,
        code: 'busy',
        error: '还有 ' + busy.length + ' 个会话在跑，等它们空闲后才能立即重启',
        busyCount: busy.length,
        busy,
        taskCount,
      }
    }
    this.logger.info?.(`立即重启：跳过等待与倒计时，马上执行（${taskCount} 个任务）`)
    const result = await this.fire(this.now())
    return { ...result, immediate: true, taskCount, triggeredBy: String(options.source || 'panel') }
  }

  /** 是否正在执行重启。 */
  get restarting() {
    return this.firing
  }

  // ———————————————————————————— 定时器 ————————————————————————————

  /** 宿主里启动心跳（测试不用这个，手动 tick）。 */
  launch(intervalMs = 250) {
    if (this.timer) return false
    this.timer = setInterval(() => {
      void this.tick()
    }, Math.max(50, Number(intervalMs) || 250))
    this.timer.unref?.()
    return true
  }

  /** 停止心跳与标记轮询（插件卸载时必须全部停掉）。 */
  stop() {
    let stopped = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      stopped = true
    }
    if (this.markerPollTimer != null) {
      this.clearTimer(this.markerPollTimer)
      this.markerPollTimer = null
      stopped = true
    }
    this.markerPollStartedAt = null
    return stopped
  }
}
