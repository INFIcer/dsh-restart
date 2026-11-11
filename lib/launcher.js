// 用 Windows 计划任务把重启脚本"弹出" DSH 进程树。
//
// 为什么不能直接 spawn PowerShell 后台跑：DSH 被杀时会连带杀掉它的子进程（Job Object），
// 脚本活不到拉起新实例。schtasks 一次性任务由任务计划程序服务启动，父进程不是 DSH，
// 所以 DSH 被杀不会波及它。
//
// 这里刻意不用 `powershell -Command "schtasks ..."`——那层嵌套引号在 Windows 上极易出错，
// 改为直接 spawn schtasks.exe：先 /Create 建一次性任务（2 分钟后触发），再 /Run 立刻触发。

import { spawn } from 'node:child_process'
import { 计划任务名 } from './constants.js'

/** 计划任务里跑的命令行（引号只在路径含空白或引号时才加）。 */
export function 构造任务命令行(scriptPath) {
  const 路径 = String(scriptPath || '')
  const 需要引号 = /[\s"]/u.test(路径)
  const 参数路径 = 需要引号 ? `"${路径.replace(/"/g, '\\"')}"` : 路径
  return `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${参数路径}`
}

/** 把毫秒时间戳换算成 schtasks /ST 需要的本地 'HH:mm'（默认往后推 2 分钟）。 */
export function 计算开始时间(现在毫秒, 提前毫秒 = 2 * 60 * 1000) {
  const 基准 = Number.isFinite(Number(现在毫秒)) ? Number(现在毫秒) : Date.now()
  const 提前 = Number.isFinite(Number(提前毫秒)) ? Number(提前毫秒) : 2 * 60 * 1000
  const 日期 = new Date(基准 + 提前)
  const 时 = String(日期.getHours()).padStart(2, '0')
  const 分 = String(日期.getMinutes()).padStart(2, '0')
  return `${时}:${分}`
}

/** 构造两次 schtasks 调用的参数数组，便于测试。 */
export function 构造计划任务参数({ taskName = 计划任务名, scriptPath, 开始时间 }) {
  const 名称 = String(taskName || 计划任务名)
  const 命令行 = 构造任务命令行(scriptPath)
  return {
    任务名: 名称,
    命令行,
    开始时间,
    create: ['/Create', '/F', '/SC', 'ONCE', '/ST', String(开始时间), '/TN', 名称, '/TR', 命令行],
    run: ['/Run', '/TN', 名称],
  }
}

function 执行一次(spawnImpl, 可执行, 参数, 超时毫秒) {
  return new Promise((完成) => {
    let 已结束 = false
    let 输出 = ''
    let 错误输出 = ''
    let 定时器 = null

    const 收尾 = (结果) => {
      if (已结束) return
      已结束 = true
      if (定时器) clearTimeout(定时器)
      完成(结果)
    }

    let 子进程
    try {
      子进程 = spawnImpl(可执行, 参数, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (错误) {
      收尾({ ok: false, code: null, error: String(错误?.message || 错误) })
      return
    }

    try {
      子进程?.stdout?.on?.('data', (块) => { 输出 += String(块) })
      子进程?.stderr?.on?.('data', (块) => { 错误输出 += String(块) })
      子进程?.on?.('error', (错误) => {
        收尾({ ok: false, code: null, error: String(错误?.message || 错误), stdout: 输出, stderr: 错误输出 })
      })
      子进程?.on?.('close', (码) => {
        收尾({
          ok: 码 === 0,
          code: 码,
          error: 码 === 0 ? '' : `schtasks 退出码 ${码}`,
          stdout: 输出,
          stderr: 错误输出,
        })
      })
    } catch (错误) {
      收尾({ ok: false, code: null, error: String(错误?.message || 错误) })
    }

    定时器 = setTimeout(() => {
      try { 子进程?.kill?.() } catch { /* 忽略 */ }
      收尾({ ok: false, code: null, error: 'schtasks 执行超时', stdout: 输出, stderr: 错误输出 })
    }, Number(超时毫秒) > 0 ? Number(超时毫秒) : 15000)
    if (typeof 定时器?.unref === 'function') 定时器.unref()
  })
}

/**
 * 触发"脱离进程树"的重启：建一次性计划任务并立刻运行。
 * 本函数只负责拉起脚本，不杀 DSH（杀进程在脚本里做，脚本自己会等 2 秒）。
 *
 * @returns {Promise<{ok:true,launcher:'schtasks',taskName:string,startTime:string,scriptPath:string,commandLine:string}|{ok:false,stage:string,error:string,code?:number|null}>}
 */
export async function 启动脱离重启({
  scriptPath,
  taskName = 计划任务名,
  spawnImpl = spawn,
  now = () => Date.now(),
  日志 = null,
  timeoutMs = 15000,
} = {}) {
  try {
    if (!scriptPath) return { ok: false, stage: 'prepare', error: '缺少重启脚本路径' }
    const 参数 = 构造计划任务参数({
      taskName,
      scriptPath,
      开始时间: 计算开始时间(now()),
    })

    const 建 = await 执行一次(spawnImpl, 'schtasks.exe', 参数.create, timeoutMs)
    日志?.('info', `schtasks create code=${建.code}`)
    if (!建.ok) {
      return { ok: false, stage: 'create', error: 建.error || 'schtasks /Create 失败', code: 建.code, stderr: 建.stderr }
    }

    const 跑 = await 执行一次(spawnImpl, 'schtasks.exe', 参数.run, timeoutMs)
    日志?.('info', `schtasks run code=${跑.code}`)
    if (!跑.ok) {
      return { ok: false, stage: 'run', error: 跑.error || 'schtasks /Run 失败', code: 跑.code, stderr: 跑.stderr }
    }

    return {
      ok: true,
      launcher: 'schtasks',
      taskName: 参数.任务名,
      startTime: 参数.开始时间,
      scriptPath: String(scriptPath),
      commandLine: 参数.命令行,
      createCode: 建.code,
      runCode: 跑.code,
    }
  } catch (错误) {
    return { ok: false, stage: 'exception', error: String(错误?.message || 错误) }
  }
}
