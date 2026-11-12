// 用 Windows 计划任务把重启脚本"弹出" DSH 进程树。
//
// 为什么不能直接 spawn PowerShell 后台跑：DSH 被杀时会连带杀掉它的子进程（Job Object），
// 脚本活不到拉起新实例。schtasks 一次性任务由任务计划程序服务启动，父进程不是 DSH，
// 所以 DSH 被杀不会波及它。
//
// 这里刻意不用 `powershell -Command "schtasks ..."`——那层嵌套引号在 Windows 上极易出错，
// 改为直接 spawn schtasks.exe：先 /Create 建一次性任务（2 分钟后触发），再 /Run 立刻触发。

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { scheduledTaskName } from './constants.js'

/**
 * 每次重启用独立的计划任务名：多个 DSH 实例（不同 DSH_HOME）同时重启时，
 * 固定任务名会互相 /Create /F 覆盖、再互相 /Delete，导致对方脚本根本没跑起来。
 */
export function createTaskName() {
  return `${scheduledTaskName}-${randomUUID().slice(0, 8)}`
}

/** 计划任务里跑的命令行（引号只在路径含空白或引号时才加）。 */
export function buildTaskCommand(scriptPath) {
  const filePath = String(scriptPath || '')
  const needsQuotes = /[\s"]/u.test(filePath)
  const argPath = needsQuotes ? `"${filePath.replace(/"/g, '\\"')}"` : filePath
  return `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${argPath}`
}

/** 把毫秒时间戳换算成 schtasks /ST 需要的本地 'HH:mm'（默认往后推 2 分钟）。 */
export function computeStartTime(nowMs, leadMs = 2 * 60 * 1000) {
  const base = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const lead = Number.isFinite(Number(leadMs)) ? Number(leadMs) : 2 * 60 * 1000
  const date = new Date(base + lead)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** 构造两次 schtasks 调用的参数数组，便于测试。 */
export function buildScheduledTaskArgs({ taskName = scheduledTaskName, scriptPath, startTime }) {
  const nameText = String(taskName || scheduledTaskName)
  const commandLine = buildTaskCommand(scriptPath)
  return {
    taskName: nameText,
    commandLine,
    startTime,
    create: ['/Create', '/F', '/SC', 'ONCE', '/ST', String(startTime), '/TN', nameText, '/TR', commandLine],
    run: ['/Run', '/TN', nameText],
  }
}

function runOnce(spawnImpl, executable, params, timeoutMs) {
  return new Promise((resolvePromise) => {
    let ended = false
    let output = ''
    let errorOutput = ''
    let timer = null

    const finish = (result) => {
      if (ended) return
      ended = true
      if (timer) clearTimeout(timer)
      resolvePromise(result)
    }

    let childProcess
    try {
      childProcess = spawnImpl(executable, params, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ ok: false, code: null, error: String(error?.message || error) })
      return
    }

    try {
      childProcess?.stdout?.on?.('data', (chunk) => { output += String(chunk) })
      childProcess?.stderr?.on?.('data', (chunk) => { errorOutput += String(chunk) })
      childProcess?.on?.('error', (error) => {
        finish({ ok: false, code: null, error: String(error?.message || error), stdout: output, stderr: errorOutput })
      })
      childProcess?.on?.('close', (code) => {
        finish({
          ok: code === 0,
          code: code,
          error: code === 0 ? '' : `schtasks 退出码 ${code}`,
          stdout: output,
          stderr: errorOutput,
        })
      })
    } catch (error) {
      finish({ ok: false, code: null, error: String(error?.message || error) })
    }

    timer = setTimeout(() => {
      try { childProcess?.kill?.() } catch { /* 忽略 */ }
      finish({ ok: false, code: null, error: 'schtasks 执行超时', stdout: output, stderr: errorOutput })
    }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000)
    if (typeof timer?.unref === 'function') timer.unref()
  })
}

/**
 * 触发"脱离进程树"的重启：建一次性计划任务并立刻运行。
 * 本函数只负责拉起脚本，不杀 DSH（杀进程在脚本里做，脚本自己会等 2 秒）。
 *
 * @returns {Promise<{ok:true,launcher:'schtasks',taskName:string,startTime:string,scriptPath:string,commandLine:string}|{ok:false,stage:string,error:string,code?:number|null}>}
 */
export async function launchDetachedRestart({
  scriptPath,
  taskName = scheduledTaskName,
  spawnImpl = spawn,
  now = () => Date.now(),
  log = null,
  timeoutMs = 15000,
} = {}) {
  try {
    if (!scriptPath) return { ok: false, stage: 'prepare', error: '缺少重启脚本路径' }
    const params = buildScheduledTaskArgs({
      taskName,
      scriptPath,
      startTime: computeStartTime(now()),
    })

    const create = await runOnce(spawnImpl, 'schtasks.exe', params.create, timeoutMs)
    log?.('info', `schtasks create code=${create.code}`)
    if (!create.ok) {
      return { ok: false, stage: 'create', error: create.error || 'schtasks /Create 失败', code: create.code, stderr: create.stderr }
    }

    const run = await runOnce(spawnImpl, 'schtasks.exe', params.run, timeoutMs)
    log?.('info', `schtasks run code=${run.code}`)
    if (!run.ok) {
      return { ok: false, stage: 'run', error: run.error || 'schtasks /Run 失败', code: run.code, stderr: run.stderr }
    }

    return {
      ok: true,
      launcher: 'schtasks',
      taskName: params.taskName,
      startTime: params.startTime,
      scriptPath: String(scriptPath),
      commandLine: params.commandLine,
      createCode: create.code,
      runCode: run.code,
    }
  } catch (error) {
    return { ok: false, stage: 'exception', error: String(error?.message || error) }
  }
}
