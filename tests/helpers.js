// 测试公共工具：假时钟、假会话、假触发。测试里绝不真的重启。

import { 重启调度器 } from '../lib/scheduler.js'
import { EventEmitter } from 'node:events'

/** 可控假时钟。 */
export function 造时钟(起点 = 0) {
  const 时钟 = {
    值: 起点,
    now: () => 时钟.值,
    走(毫秒) {
      时钟.值 += Number(毫秒) || 0
      return 时钟.值
    },
    到(时间戳) {
      时钟.值 = Number(时间戳) || 0
      return 时钟.值
    },
  }
  return 时钟
}

/**
 * 造一个注入了全部假依赖的调度器。
 * @param {object} 选项 {时钟, 忙碌, 标记, 状态, onFire, 注入成功}
 */
export function 造调度器(选项 = {}) {
  const 时钟 = 选项.时钟 || 造时钟(0)
  const 忙碌 = { 列表: Array.isArray(选项.忙碌) ? 选项.忙碌 : [] }
  const 记录 = {
    落盘: [],
    注入: [],
    触发: [],
    标记: 选项.标记 ?? null,
    日志: [],
  }
  let 磁盘状态 = 选项.状态 ?? null

  const 调度器 = new 重启调度器({
    now: () => 时钟.值,
    getBusySessions: () => 忙碌.列表,
    persist: (状态) => {
      记录.落盘.push(状态)
      磁盘状态 = 状态
    },
    load: () => 磁盘状态,
    readMarker: () => 记录.标记,
    onFire:
      选项.onFire ||
      (async (载荷) => {
        记录.触发.push(载荷)
        return {
          ok: true,
          scriptPath: 'C:\\fake\\restart.ps1',
          launcher: 'schtasks',
          wakeCount: (载荷?.sessionIds || []).length,
        }
      }),
    injectToSession: (会话, 文本, 元信息) => {
      记录.注入.push({ 会话, 文本, 元信息 })
      return 选项.注入成功 !== false
    },
    logger: {
      info: (...参数) => 记录.日志.push(['info', ...参数]),
      warn: (...参数) => 记录.日志.push(['warn', ...参数]),
      error: (...参数) => 记录.日志.push(['error', ...参数]),
    },
  })

  return { 调度器, 时钟, 忙碌, 记录, 取磁盘状态: () => 磁盘状态 }
}

/** 安排一批"正在运行"的会话。 */
export function 设忙碌(上下文, 会话列表 = []) {
  上下文.忙碌.列表 = 会话列表.map((会话) => ({ sessionId: 会话, status: 'running' }))
}

/** 排队任务的简写。 */
export function 排任务(调度器, 覆盖 = {}) {
  return 调度器.排任务({
    sessionId: 'session-a',
    sessionLabel: '会话 A',
    delaySeconds: 10,
    reason: '测试重启',
    ...覆盖,
  })
}

/**
 * 假 spawn：按调用顺序返回预设行为。
 * 行为：{code, stdout, stderr, 抛错, 超时, 结束后杀}
 */
export function 造假spawn(行为列表) {
  const 调用 = []
  const 函数 = (可执行, 参数, 选项) => {
    const 序号 = 调用.length
    调用.push({ 可执行, 参数, 选项 })
    const 行为 = 行为列表[Math.min(序号, 行为列表.length - 1)] || { code: 0 }
    const 进程 = new EventEmitter()
    进程.stdout = new EventEmitter()
    进程.stderr = new EventEmitter()
    进程.killed = false
    进程.kill = () => {
      进程.killed = true
      setImmediate(() => 进程.emit('close', null))
    }
    setImmediate(() => {
      if (进程.killed) return
      if (行为.抛错) {
        进程.emit('error', new Error(行为.抛错))
        return
      }
      if (行为.超时) return
      if (行为.stdout) 进程.stdout.emit('data', 行为.stdout)
      if (行为.stderr) 进程.stderr.emit('data', 行为.stderr)
      进程.emit('close', 行为.code ?? 0)
    })
    return 进程
  }
  函数.调用 = 调用
  return 函数
}
