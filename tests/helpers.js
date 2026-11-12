// 测试公共工具：假时钟、假会话、假触发。测试里绝不真的重启。

import { RestartScheduler } from '../lib/scheduler.js'
import { EventEmitter } from 'node:events'

/** 可控假时钟。 */
export function makeClock(startAt = 0) {
  const clock = {
    value: startAt,
    now: () => clock.value,
    advance(ms) {
      clock.value += Number(ms) || 0
      return clock.value
    },
    setTo(timestamp) {
      clock.value = Number(timestamp) || 0
      return clock.value
    },
  }
  return clock
}

/**
 * 假的 setTimeout / clearTimeout：定时器只在 timers.advance() 时触发，不真等。
 * 同一拍里新排的定时器会继续跑到稳定，便于「轮询→再排下一拍」的用例。
 */
export function makeTimers(clock) {
  const queue = new Map()
  let nextId = 1
  return {
    setTimeout(fn, delayMs = 0) {
      const id = nextId
      nextId += 1
      queue.set(id, { fn, at: clock.value + Math.max(0, Number(delayMs) || 0) })
      return id
    },
    clearTimeout(id) {
      queue.delete(id)
    },
    /** 推进时钟并触发所有到期定时器；返回本次触发的数量。 */
    advance(ms = 0) {
      clock.advance(ms)
      let fired = 0
      for (let round = 0; round < 50; round += 1) {
        const due = [...queue.entries()]
          .filter(([, timer]) => timer.at <= clock.value)
          .sort((left, right) => left[1].at - right[1].at)
        if (due.length === 0) break
        for (const [id, timer] of due) {
          queue.delete(id)
          timer.fn()
          fired += 1
        }
      }
      return fired
    },
    pendingCount() {
      return queue.size
    },
  }
}

/**
 * 造一个注入了全部假依赖的调度器。
 * @param {object} options {clock, timers, busy, marker, state, onFire, injectOk}
 */
export function makeScheduler(options = {}) {
  const clock = options.clock || makeClock(0)
  const timers = options.timers || makeTimers(clock)
  const busy = { list: Array.isArray(options.busy) ? options.busy : [] }
  const record = {
    persist: [],
    inject: [],
    fire: [],
    marker: options.marker ?? null,
    log: [],
    bootConfirmed: [],
  }
  // 磁盘状态默认补上当前结构版本，避免每个用例都手写；显式传 version 时保留原值（测版本不兼容）。
  let stateOnDisk =
    options.state && typeof options.state === 'object' ? { version: 1, ...options.state } : options.state ?? null

  const scheduler = new RestartScheduler({
    now: () => clock.value,
    getBusySessions: () => busy.list,
    persist: (state) => {
      record.persist.push(state)
      stateOnDisk = state
    },
    load: () => stateOnDisk,
    readMarker: () => record.marker,
    onFire:
      options.onFire ||
      (async (payload) => {
        record.fire.push(payload)
        return {
          ok: true,
          scriptPath: 'C:\\fake\\restart.ps1',
          launcher: 'schtasks',
          wakeCount: (payload?.sessionIds || []).length,
        }
      }),
    injectToSession: (session, text, meta) => {
      record.inject.push({ session, text, meta })
      return options.injectOk !== false
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onBootConfirmed: () => record.bootConfirmed.push(clock.value),
    logger: {
      info: (...params) => record.log.push(['info', ...params]),
      warn: (...params) => record.log.push(['warn', ...params]),
      error: (...params) => record.log.push(['error', ...params]),
    },
  })

  return { scheduler, clock, timers, busy, record, getDiskState: () => stateOnDisk }
}

/** 安排一批"正在运行"的会话。 */
export function setBusy(context, sessionList = []) {
  context.busy.list = sessionList.map((session) => ({ sessionId: session, status: 'running' }))
}

/** 排队任务的简写。 */
export function scheduleTask(scheduler, override = {}) {
  return scheduler.scheduleTask({
    sessionId: 'session-a',
    sessionLabel: '会话 A',
    delaySeconds: 10,
    reason: '测试重启',
    ...override,
  })
}

/**
 * 假 spawn：按调用顺序返回预设行为。
 * 行为：{code, stdout, stderr, throwError, timedOut}
 */
export function makeFakeSpawn(behaviorList) {
  const calls = []
  const fn = (executable, params, options) => {
    const index = calls.length
    calls.push({ executable, params, options })
    const behavior = behaviorList[Math.min(index, behaviorList.length - 1)] || { code: 0 }
    const processRef = new EventEmitter()
    processRef.stdout = new EventEmitter()
    processRef.stderr = new EventEmitter()
    processRef.killed = false
    processRef.kill = () => {
      processRef.killed = true
      setImmediate(() => processRef.emit('close', null))
    }
    setImmediate(() => {
      if (processRef.killed) return
      if (behavior.throwError) {
        processRef.emit('error', new Error(behavior.throwError))
        return
      }
      if (behavior.timedOut) return
      if (behavior.stdout) processRef.stdout.emit('data', behavior.stdout)
      if (behavior.stderr) processRef.stderr.emit('data', behavior.stderr)
      processRef.emit('close', behavior.code ?? 0)
    })
    return processRef
  }
  fn.calls = calls
  return fn
}
