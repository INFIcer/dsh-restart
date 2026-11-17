// 宿主侧装配：HTTP 路由 + dsh_restart 工具 + 调度器心跳。
//
// 设计原则（用户要求）：
//  - Fail-open：任何环节出错都只记日志，绝不把 DSH 弄崩。
//  - 状态机全部在 lib/scheduler.js，这里只做「接线」，方便测试。
//  - 宿主不注册 UI 槽位；主界面由 client.js 用纯 DOM 画，设置项由 client.js 注册到插件页。

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  pluginName,
  minDelaySeconds,
  maxDelaySeconds,
  defaultDelaySeconds,
  dialogMinRemainingSeconds,
  inputPauseHoldMs,
  schedulerHeartbeatMs,
  wakeDelaySeconds,
  scheduledTaskName,
  stateFileName,
  busyTimeoutMs,
  routePrefix,
  pluginSnapshotDirName,
} from './constants.js'
import { ensureDir, appendLog, readJson, writeJsonAtomic } from './fsutil.js'
import { sendJson, readRequestBody, methodNotAllowed, requireSameOrigin } from './http.js'
import { RestartScheduler } from './scheduler.js'
import {
  resolveScriptPaths,
  writeRestartScript,
  buildWakeEvents,
  pluginRoot,
} from './script.js'
import { launchDetachedRestart, createTaskName } from './launcher.js'
import { prepareWakeSchedule } from './schedule-file.js'
import {
  createPluginSnapshot,
  resolveProfileDir,
  summarizePluginDiff,
  verifyPluginStateAfterBoot,
} from './plugin-state.js'
import { createAutoStart } from './autostart.js'
import { ConfigStore, buildConfigSchema } from './config.js'

export const name = pluginName
export const inject = ['webServer', 'agents', 'tools']

// schemastery 只在宿主提供时可用；本插件零依赖，拿不到就不导出 Config，插件照常加载。
let schemastery = null
try {
  schemastery = (await import('@deepseek-ai/schemastery')).default
} catch {
  /* 没有这个包 */
}
export const Config = schemastery ? buildConfigSchema(schemastery) : undefined

// 重启职责的提示段。systemPrompt 故意不放进 inject：它不是本插件的硬依赖，
// 缺了（旧版 DSH / 只装了本插件）也不能让插件整体挂起，走 ctx.get 拿到就用。
export const guidanceSectionName = 'dsh-restart-guidance'
export const guidanceSectionOrder = 2550
export const restartGuidanceText =
  '要重启 DSH（加载插件改动、让配置生效）时，用 dsh_restart 工具排期，不要自己杀进程或拼 schtasks 命令——手动重启会让本会话失联。重启会在所有会话空闲后倒计时执行。'

const silentLogger = { info() {}, warn() {}, error() {} }

/** 把启动项操作失败码翻成用户能照做的一句话；技术细节只进日志。 */
function autoStartErrorMessage(code) {
  if (code === 'unsupported') return '当前系统不支持开机自启动。'
  if (code === 'write-failed' || code === 'remove-failed') {
    return '没能修改系统启动项。请稍后重试；仍失败时检查安全软件是否拦截。'
  }
  if (code === 'query-failed' || code === 'parse-failed' || code === 'verify-failed') {
    return '没能确认启动项状态。请稍后重试；仍失败时检查系统启动项。'
  }
  return '开机自启动设置没能生效。请稍后重试。'
}

/** 测试可以注入完整适配器或只注入 runner；生产环境默认读写当前用户启动项。 */
function createAutoStartAdapter(supplied, pathSet) {
  if (supplied === false) return null
  if (supplied && typeof supplied.reconcile === 'function') return supplied
  const options = supplied && typeof supplied === 'object' ? supplied : {}
  return createAutoStart({
    run: options.run,
    execPath: options.execPath || pathSet?.exePath,
    platform: options.platform,
  })
}

/** 把任意值变成一句短文本（日志用）。 */
function toText(value) {
  if (value instanceof Error) return value.stack || value.message || String(value)
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 造一个 fail-open 的日志器：写文件；error 另外打到控制台。 */
export function makeLogger(file, consoleLike = console) {
  const writeLog = (level, ...params) => {
    const bodyText = params.map(toText).join(' ')
    try {
      // 追加日志 自己会加时间戳和换行，这里只写级别和正文。
      appendLog(file, `${level.toUpperCase()} ${bodyText}`)
    } catch {
      /* fail-open：日志写不进去也不能崩 */
    }
    if (level === 'error') {
      try { consoleLike?.error?.(`[${pluginName}] ${bodyText}`) } catch { /* 忽略 */ }
    }
  }
  return {
    file,
    info: (...params) => writeLog('info', ...params),
    warn: (...params) => writeLog('warn', ...params),
    error: (...params) => writeLog('error', ...params),
  }
}

/** 安全执行：同步/异步异常都吞掉记日志。 */
export function safeCall(log, label, fn) {
  return (...params) => {
    try {
      const result = fn(...params)
      if (result && typeof result.then === 'function') {
        return result.catch((error) => {
          log?.error?.(`${label} 失败`, error)
          return { ok: false, code: 'internal', hint: `${label} 失败：${toText(error)}` }
        })
      }
      return result
    } catch (error) {
      log?.error?.(`${label} 失败`, error)
      return { ok: false, code: 'internal', hint: `${label} 失败：${toText(error)}` }
    }
  }
}

// ———————————————————————— 会话相关 ————————————————————————

/** 从工具 exec 里取调用者会话 id。 */
export function resolveCallSession(exec) {
  try {
    const candidates = [
      exec?.agent?.session?.id,
      exec?.agent?.sessionId,
      exec?.agent?.id,
      exec?.sessionId,
      exec?.session?.id,
    ]
    for (const item of candidates) {
      const value = String(item || '').trim()
      if (value) return value
    }
  } catch {
    /* 忽略 */
  }
  return ''
}

/** 当前正在运行的会话列表；读不到就当空闲（否则任务永远排不上）。 */
export function getBusySessions(ctx, log) {
  try {
    const agents = ctx?.get?.('agents')
    if (!agents || typeof agents.list !== 'function') return []
    const all = agents.list()
    if (!Array.isArray(all)) return []
    const result = []
    for (const agent of all) {
      if (!agent) continue
      const state = String(agent.status || '')
      // 状态缺失时不当作忙，避免任务永远「等待中」。
      if (!state || state === 'idle') continue
      const session = String(agent.session?.id || agent.id || '').trim()
      if (!session) continue
      result.push({ id: String(agent.id || session), sessionId: session, status: state })
    }
    return result
  } catch (error) {
    log?.warn?.('读取会话状态失败（按空闲处理）', error)
    return []
  }
}

/**
 * 带超时的忙碌读取：会话状态可能永远卡在非 idle（工具挂起、状态泄漏），
 * 一直算忙会让重启永远等下去。持续忙碌超过上限后按空闲处理，并只告警一次。
 */
export function createBusyReader(ctx, log, options = {}) {
  const firstBusyAt = new Map()
  const warned = new Set()
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : busyTimeoutMs
  const readNow = typeof options.now === 'function' ? options.now : Date.now
  return function readBusySessions() {
    const now = Number(readNow())
    const all = getBusySessions(ctx, log)
    const online = new Set(all.map((item) => item.sessionId))
    for (const id of [...firstBusyAt.keys()]) if (!online.has(id)) firstBusyAt.delete(id)
    for (const id of [...warned]) if (!online.has(id)) warned.delete(id)
    const result = []
    for (const item of all) {
      const id = item.sessionId
      if (!firstBusyAt.has(id)) firstBusyAt.set(id, now)
      const elapsedMs = now - firstBusyAt.get(id)
      if (elapsedMs >= timeoutMs) {
        if (!warned.has(id)) {
          warned.add(id)
          log?.warn?.(`会话 ${id} 持续忙碌超过 ${Math.round(timeoutMs / 1000)} 秒，本次按空闲处理`)
        }
        continue
      }
      result.push(item)
    }
    return result
  }
}

/** 会话显示名：优先取会话标题，取不到就截断 id。 */
export function sessionLabel(ctx, sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return ''
  try {
    const titleService = ctx?.get?.('sessionTitle')
    if (titleService && typeof titleService.get === 'function') {
      // sessionTitle.get() 收的是 Session 对象，不是 id：先用 sessions / agents 换出会话。
      const sessionService = ctx?.get?.('sessions')
      const session = sessionService?.get?.(id) ?? ctx?.get?.('agents')?.get?.(id)?.session
      const snapshot = session === undefined ? undefined : titleService.get(session)
      const title =
        typeof snapshot === 'string' ? String(snapshot).trim() : String(snapshot?.title ?? '').trim()
      if (title) return title
    }
  } catch {
    /* 忽略 */
  }
  return id.replace(/^session-/, '').slice(0, 8)
}

/** 给会话注入一条 user 消息（会唤醒该会话）。返回是否送达。 */
export function makeInject(ctx, log) {
  return (sessionId, text, meta = {}) => {
    const id = String(sessionId || '').trim()
    const bodyText = String(text || '').trim()
    if (!id || !bodyText) return false
    try {
      const agents = ctx?.get?.('agents')
      const agent = agents && typeof agents.get === 'function' ? agents.get(id) : null
      if (!agent || typeof agent.inject !== 'function') {
        log?.warn?.(`会话 ${id} 不在线，反馈消息没送达`)
        return false
      }
      agent.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: bodyText }],
        source: {
          kind: `${pluginName}/feedback`,
          reason: String(meta?.reason || 'restart-scheduler'),
          taskId: meta?.taskId ? String(meta.taskId) : undefined,
        },
      })
      log?.info?.(`已给会话 ${id} 注入反馈`)
      return true
    } catch (error) {
      log?.warn?.(`给会话 ${id} 注入反馈失败`, error)
      return false
    }
  }
}

// ———————————————————————— 系统提示 ————————————————————————

/**
 * 把「重启走 dsh_restart」注册成系统提示段（全局、静态）。
 *
 * 用 ctx.get 读服务而不是顶层 inject：systemPrompt 不是本插件的硬依赖，
 * 服务不在就只记一条日志、插件照常工作。返回本段自己的撤销函数；
 * 同一上下文里重名注册会抛错，那只说明已经注入过（插件被重复 apply），
 * 捕获后跳过，保证幂等。
 */
export function registerGuidance(ctx, log = silentLogger) {
  const section = {
    name: guidanceSectionName,
    order: guidanceSectionOrder,
    // 纯文本段显式关掉 {{变量}} 插值：未知变量会让整次提示装配抛错。
    interpolate: false,
    text: restartGuidanceText,
  }
  let service
  try {
    service = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined
  } catch (error) {
    log.warn?.(`读取 systemPrompt 服务失败，跳过重启提示注入：${error?.message || error}`)
    return null
  }
  if (!service || typeof service.section !== 'function') {
    log.warn?.('systemPrompt 服务不可用（可能是旧版 DSH），跳过重启提示注入；dsh_restart 工具不受影响')
    return null
  }
  try {
    const dispose = service.section(section)
    log.info?.('重启提示已注入系统提示（重启走 dsh_restart）')
    return typeof dispose === 'function' ? dispose : null
  } catch (error) {
    const infoMessage = String(error?.message || error)
    if (infoMessage.includes('already registered')) {
      log.info?.(`提示段 ${guidanceSectionName} 已注册，跳过重复注入`)
    } else {
      log.warn?.(`注入重启提示失败：${infoMessage}`)
    }
    return null
  }
}

// ———————————————————————— 路由 ————————————————————————

function makeSendJson(log) {
  return (res, statusCode, data) => {
    try {
      sendJson(res, statusCode, data)
    } catch (error) {
      log?.warn?.('回包失败（连接可能已断开）', error)
    }
  }
}

// ———————————————————————— 工具 ————————————————————————

// 参数 schema 只能用宿主支持的子集：type/oneOf/properties/required/additionalProperties/items/
// enum/const 外加 description/title/default/examples。宿主把这份 schema 直接投成系统提示里的
// TypeScript 声明，遇到子集外的关键字（minimum、maximum 之类）会把整段参数类型降级成 unknown——
// 调用照旧不报错，所以只能从 schema 这一侧避开。范围限制写在 description 里，真正生效的是
// scheduler.js 的 normalizeDelaySeconds。
const toolArgs = {
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
      description: `倒计时秒数，${minDelaySeconds}~${maxDelaySeconds}，默认 ${defaultDelaySeconds}。等所有会话空闲后才开始倒计时。`,
    },
    wakeText: {
      type: 'string',
      description: '这次重启的意图，只显示在面板上，不会作为唤醒消息正文。',
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

const toolOutput = {
  // 宽松 schema：返回字段会随动作变化，严格校验反而容易误报。
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

function toolError(infoMessage, suggestion) {
  return { ok: false, code: 'bad_request', error: infoMessage, hint: suggestion }
}

// ———————————————————————— 装配 ————————————————————————

/**
 * 装配插件（apply 的实际实现，测试直接调这个）。
 * @param {object} ctx 宿主插件上下文
 * @param {object} [options] 测试可覆盖：stateFile/markerFile/scriptFile/logFile/onFire/now/spawnImpl/heartbeatMs
 * @param {object} [options.pluginState] 插件启用设置保护：profileDir/snapshotsRoot/env
 */
export function assemble(ctx, options = {}) {
  const pathSet = { ...resolveScriptPaths(process.env), pluginRoot, ...(options.filePath || {}) }
  const stateFile = options.stateFile || path.join(pathSet.homeDir, stateFileName)
  const logFile = options.logFile || path.join(pathSet.pluginRoot, 'restart-plugin.log')
  const scriptFile = options.scriptFile || pathSet.scriptFile
  const markerFile = options.markerFile || pathSet.markerFile

  try { ensureDir(path.dirname(stateFile)) } catch { /* 忽略 */ }
  try { ensureDir(path.dirname(logFile)) } catch { /* 忽略 */ }

  const log = options.log || makeLogger(logFile)
  const reply = makeSendJson(log)

  // ——— 插件启用设置保护：profile 只在这里定位一次 ———
  // 快照落在本插件状态目录旁边（<DSH 家目录>/plugin-snapshots），不往 profile 里塞东西。
  const pluginStateOptions = options.pluginState || {}
  const profileResolution = resolveProfileDir({
    profileDir: pluginStateOptions.profileDir,
    env: pluginStateOptions.env || process.env,
    homeDir: pathSet.homeDir,
  })
  const profileDir = profileResolution.ok ? profileResolution.dir : ''
  const pluginSnapshotsRoot =
    String(pluginStateOptions.snapshotsRoot || '').trim() || path.join(pathSet.homeDir, pluginSnapshotDirName)
  if (profileResolution.ok) {
    log.info?.(`插件启用设置保护已启用：profile=${profileDir}，快照根目录=${pluginSnapshotsRoot}`)
  } else {
    log.warn?.(`插件启用设置保护未启用（${profileResolution.error}），重启照常执行`)
  }
  const inject = options.injectToSession || makeInject(ctx, log)

  let cleanupFns = []
  let stopped = false

  // ——— 插件配置：文件 > 宿主传入 > 默认值 ———
  const configStore = options.configStore || new ConfigStore({ homeDir: pathSet.homeDir })
  let pluginConfig = configStore.get()
  try {
    pluginConfig = configStore.load(options.pluginConfig || {})
  } catch (error) {
    log.warn?.('读取插件配置失败，按默认值继续', error)
  }

  // ——— 开机自启动：启动时对齐一次，失败只记状态与日志 ———
  const autoStart = createAutoStartAdapter(options.autoStart, pathSet)
  const autoStartState = {
    enabled: false,
    configured: pluginConfig.autoStart === true,
    command: '',
    error: '',
    checkedAt: null,
    supported: autoStart ? autoStart.supported !== false : false,
  }
  const describeAutoStart = () => ({
    enabled: autoStartState.enabled === true,
    configured: autoStartState.configured === true,
    command: autoStartState.command || '',
    error: autoStartState.error || '',
    checkedAt: autoStartState.checkedAt,
    supported: autoStartState.supported === true,
  })
  const reconcileAutoStart = async () => {
    if (!autoStart) {
      autoStartState.error = '当前系统不支持开机自启动。'
      autoStartState.checkedAt = new Date().toISOString()
      return null
    }
    const desired = autoStartState.configured === true
    let result = null
    try {
      result = await autoStart.reconcile(desired)
    } catch (error) {
      result = { ok: false, code: 'internal', detail: String(error?.message || error) }
    }
    autoStartState.checkedAt = new Date().toISOString()
    if (result?.ok) {
      autoStartState.enabled = result.present === true
      autoStartState.command = result.command || ''
      autoStartState.error = ''
      if (result.changed) {
        log.info?.('开机自启动已' + (desired ? '开启' : '关闭') + '：' + (result.command || '无启动项'))
      }
    } else {
      if (typeof result?.present === 'boolean') autoStartState.enabled = result.present
      if (typeof result?.command === 'string') autoStartState.command = result.command
      autoStartState.error = autoStartErrorMessage(result?.code)
      log.warn?.('开机自启动同步失败：code=' + (result?.code || 'unknown') + ' detail=' + (result?.detail || ''))
    }
    return result
  }
  const autoStartReady = reconcileAutoStart()

  // ——— 系统提示：告诉 Agent「重启交给本插件」，别自己杀进程 ———
  if (options.guidance !== false) {
    const disposeGuidance = registerGuidance(ctx, log)
    if (typeof disposeGuidance === 'function') {
      cleanupFns.push(() => { try { disposeGuidance() } catch { /* 已卸载 */ } })
    }
  }

  const fireRestart = async (payload) => {
    if (typeof options.onFire === 'function') return options.onFire(payload)
    const event = buildWakeEvents(
      (payload?.tasks || []).map((task) => ({
        sessionId: task.sessionId,
        afterSeconds: wakeDelaySeconds,
      })),
      { runId: payload?.runId },
    )
    // 唤醒事件由 Node 合并成 .pending；脚本只会在 DSH 全关后、且原文件未被宿主改写时替换上去。
    // 合并失败不阻塞重启：唤醒可能丢，但重启本身仍要做。
    const nowMs = typeof options.now === 'function' ? Number(options.now()) : Date.now()
    const wakeSchedule = prepareWakeSchedule({
      scheduleFile: options.scheduleFilePath || path.join(pathSet.homeDir, 'storages', 'schedule.json'),
      events: event,
      now: nowMs,
    })
    if (!wakeSchedule.ok) {
      log.warn?.(`唤醒事件合并失败（${wakeSchedule.code}），重启继续，唤醒可能丢失`, wakeSchedule.error)
    }
    // 强杀旧进程之前先拍快照：此刻的文件内容就是用户原来的插件启用设置。
    const pluginSnapshot = createPluginSnapshot({
      profileDir: profileDir,
      snapshotsRoot: pluginSnapshotsRoot,
      now: nowMs,
      log: log,
    })
    if (pluginSnapshot.ok) {
      log.info?.(`插件启用设置快照已保存：${pluginSnapshot.dir}（${pluginSnapshot.files.join('、')}）`)
    } else {
      log.warn?.(`插件启用设置快照跳过（${pluginSnapshot.code}）：${pluginSnapshot.error}；重启继续`)
    }
    const taskName = createTaskName()
    const scriptResult = writeRestartScript({
      scriptFile,
      homeDir: pathSet.homeDir,
      exePath: pathSet.exePath,
      logFile: pathSet.logFile,
      markerFile,
      taskName,
      wakeEvents: event,
      profileDir: profileDir,
      pluginSnapshotDir: pluginSnapshot.ok ? pluginSnapshot.dir : '',
    })
    if (!scriptResult.ok) {
      return { ok: false, code: 'script_failed', error: scriptResult.error || '写重启脚本失败' }
    }
    log.info?.(`重启脚本已写入 ${scriptResult.filePath}（${scriptResult.byteCount} 字节，${scriptResult.eventCount} 个唤醒事件）`)
    const launch = await launchDetachedRestart({
      scriptPath: scriptResult.filePath,
      taskName: taskName,
      spawnImpl: options.spawnImpl,
      now: options.now,
      log: (level, infoMessage) => log[level === 'error' ? 'error' : 'info']?.(infoMessage),
    })
    if (!launch.ok) {
      return {
        ok: false,
        code: 'launch_failed',
        error: `计划任务启动失败（${launch.stage}）：${launch.error}`,
      }
    }
    return {
      ok: true,
      scriptPath: scriptResult.filePath,
      launcher: launch.launcher,
      taskName: launch.taskName,
      wakeCount: scriptResult.eventCount,
      // 交给调度器落盘；开机后据此校验插件启用设置有没有被改回去。
      pluginStateSnapshot: {
        ok: pluginSnapshot.ok,
        dir: pluginSnapshot.ok ? pluginSnapshot.dir : '',
        profileDir: profileDir,
        files: pluginSnapshot.ok ? pluginSnapshot.files : [],
        code: pluginSnapshot.ok ? undefined : pluginSnapshot.code,
        error: pluginSnapshot.ok ? undefined : pluginSnapshot.error,
      },
    }
  }

  const scheduler = new RestartScheduler({
    now: options.now,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    getBusySessions: createBusyReader(ctx, log, { now: options.now }),
    persist: (state) => {
      // 状态文件原子写（先 .tmp 再 rename），见 fsutil writeJsonAtomic
      writeJsonAtomic(stateFile, state)
    },
    load: () => readJson(stateFile, null),
    readMarker: () => readJson(markerFile, null),
    onFire: fireRestart,
    injectToSession: inject,
    logger: log,
  })

  try {
    scheduler.init()
  } catch (error) {
    log.error?.('调度器初始化失败（继续跑空状态）', error)
  }

  // ——— 开机校验：新实例起来后再比一次，被启动过程改写了就再写回 ———
  verifyPluginStateOnBoot(scheduler, log, {
    profileDir: profileDir,
    now: options.now,
  })

  // ——— 心跳 ———
  const heartbeatMs = Number(options.heartbeatMs) > 0 ? Number(options.heartbeatMs) : schedulerHeartbeatMs
  try {
    scheduler.launch(heartbeatMs)
    cleanupFns.push(() => scheduler.stop())
  } catch (error) {
    log.error?.('启动心跳失败', error)
  }

  // ——— HTTP 路由 ———
  const registerRoute = (subPath, handler) => {
    const fullPath = `${routePrefix}${subPath}`
    try {
      if (!ctx?.webServer || typeof ctx.webServer.register !== 'function') {
        log.warn?.(`webServer 不可用，跳过路由 ${fullPath}`)
        return
      }
      const register = () =>
        ctx.webServer.register({
          kind: 'exact',
          path: fullPath,
          handler: safeCall(log, `路由 ${fullPath}`, (req, res) => handler(req, res)),
        })
      if (typeof ctx.effect === 'function') ctx.effect(register, `dsh-restart: ${fullPath}`)
      else register()
    } catch (error) {
      log.error?.(`注册路由 ${fullPath} 失败`, error)
    }
  }

  registerRoute('/state', (req, res) => {
    if (!methodNotAllowed(req, res, ['GET'])) return
    const snapshot = scheduler.snapshot()
    reply(res, 200, {
      ...snapshot,
      serverTime: new Date(scheduler.now()).toISOString(),
      autoStart: describeAutoStart(),
      constants: {
        minDelaySeconds,
        maxDelaySeconds,
        defaultDelaySeconds,
        dialogMinRemainingSeconds,
        inputPauseHoldMs,
        wakeDelaySeconds,
      },
    })
  })

  registerRoute('/autostart', async (req, res) => {
    if (!methodNotAllowed(req, res, ['POST'])) return
    if (!requireSameOrigin(req, res)) return
    const bodyRead = await readRequestBody(req)
    const enabled = bodyRead?.value?.enabled
    if (typeof enabled !== 'boolean') {
      reply(res, 400, {
        ok: false,
        code: 'bad_request',
        error: '没有收到开关状态，请刷新页面后重试。',
        autoStart: describeAutoStart(),
      })
      return
    }
    if (!autoStart) {
      reply(res, 400, {
        ok: false,
        code: 'unsupported',
        error: '当前系统不支持开机自启动。',
        autoStart: describeAutoStart(),
      })
      return
    }
    let result = null
    try {
      result = await autoStart.reconcile(enabled)
    } catch (error) {
      result = { ok: false, code: 'internal', detail: String(error?.message || error) }
    }
    autoStartState.checkedAt = new Date().toISOString()
    if (typeof result?.present === 'boolean') autoStartState.enabled = result.present
    if (typeof result?.command === 'string') autoStartState.command = result.command
    if (!result?.ok) {
      autoStartState.error = autoStartErrorMessage(result?.code)
      log.warn?.('修改开机自启动失败：code=' + (result?.code || 'unknown') + ' detail=' + (result?.detail || ''))
      reply(res, 500, {
        ok: false,
        code: result?.code || 'failed',
        error: autoStartState.error,
        autoStart: describeAutoStart(),
      })
      return
    }
    autoStartState.enabled = result.present === true
    autoStartState.command = result.command || ''
    autoStartState.configured = enabled
    autoStartState.error = ''
    let saveError = ''
    try {
      configStore.save({ autoStart: enabled })
    } catch (error) {
      saveError = '启动项已改好，但设置没能保存；下次启动 DSH 时可能恢复原状。'
      autoStartState.error = saveError
      log.error?.('保存开机自启动设置失败', error)
    }
    reply(res, 200, {
      ok: saveError === '',
      changed: result.changed === true,
      error: saveError || undefined,
      autoStart: describeAutoStart(),
    })
  })

  registerRoute('/pause', async (req, res) => {
    if (!methodNotAllowed(req, res, ['POST'])) return
    if (!requireSameOrigin(req, res)) return
    const result = scheduler.pause('input')
    reply(res, 200, { ...result, snapshot: scheduler.snapshot() })
  })

  registerRoute('/resume', async (req, res) => {
    if (!methodNotAllowed(req, res, ['POST'])) return
    if (!requireSameOrigin(req, res)) return
    const result = scheduler.resume('input')
    reply(res, 200, { ...result, snapshot: scheduler.snapshot() })
  })

  registerRoute('/cancel', async (req, res) => {
    if (!methodNotAllowed(req, res, ['POST'])) return
    if (!requireSameOrigin(req, res)) return
    const bodyRead = await readRequestBody(req)
    const taskId = String(bodyRead?.value?.taskId || '').trim()
    if (!taskId) {
      reply(res, 400, { ok: false, code: 'bad_request', error: '缺少 taskId', hint: '面板取消要带任务 id。' })
      return
    }
    const result = scheduler.cancelTask(taskId, { source: 'panel' })
    if (!result.ok) {
      reply(res, 404, { ...result, snapshot: scheduler.snapshot() })
      return
    }
    reply(res, 200, { ...result, snapshot: scheduler.snapshot() })
  })

  registerRoute('/dialog-open', async (req, res) => {
    if (!methodNotAllowed(req, res, ['POST'])) return
    if (!requireSameOrigin(req, res)) return
    const result = scheduler.openDialog()
    reply(res, 200, { ok: true, raisedTasks: result.raisedTasks, raisedCount: result.raisedCount, snapshot: result.snapshot })
  })

  registerRoute('/now', async (req, res) => {
    if (!methodNotAllowed(req, res, ['POST'])) return
    if (!requireSameOrigin(req, res)) return
    const result = await scheduler.restartNow({ source: 'panel' })
    if (!result.ok) {
      // 与当前状态冲突（正在重启 / 还有会话在跑）用 409，参数或空任务用 400。
      const conflict = result.code === 'firing' || result.code === 'busy'
      reply(res, conflict ? 409 : 400, { ...result, snapshot: scheduler.snapshot() })
      return
    }
    reply(res, 200, { ...result, snapshot: scheduler.snapshot() })
  })

  // ——— 工具 ———
  const tool = makeTool(ctx, scheduler, log, options)
  try {
    if (ctx?.tools && typeof ctx.tools.register === 'function') {
      // 立即注册（与 dsh-fish-message / dsh-fish-service 一致）：放进 ctx.effect 会晚于
      // 宿主建立工具视图，注册失败又只落在宿主控制台，插件自己的日志里什么都看不到。
      const unregisterTool = ctx.tools.register(tool)
      if (typeof unregisterTool === 'function') cleanupFns.push(() => { try { unregisterTool() } catch { /* 已卸载 */ } })
      log.info?.(`dsh_restart 工具已注册（disposer=${typeof unregisterTool}）`)
    } else {
      log.warn?.('tools 服务不可用，dsh_restart 工具没注册上')
    }
  } catch (error) {
    log.error?.(`注册 dsh_restart 工具失败：${error?.message || error}`)
  }

  // ——— 清理 ———
  const stop = () => {
    if (stopped) return
    stopped = true
    for (const cleanup of cleanupFns.splice(0)) {
      try { cleanup() } catch { /* 忽略 */ }
    }
  }
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => stop, 'dsh-restart: cleanup')
    else if (typeof ctx?.on === 'function') ctx.on('dispose', stop)
  } catch (error) {
    log.warn?.('注册清理函数失败', error)
  }

  log.info?.(`插件已加载：状态文件 ${stateFile}，脚本 ${scriptFile}`)
  return {
    scheduler,
    tool,
    log,
    stateFile,
    scriptFile,
    markerFile,
    stop,
    configStore,
    autoStart,
    autoStartState,
    autoStartReady,
  }
}

/**
 * 重启后校验插件启用设置：新实例端口就绪、插件加载时，把 profile 与重启前的快照比一遍。
 * 不一致说明启动过程又改写了设置，照快照再写回一次；结果落进 lastRestart.pluginStateRestored。
 * 只在「本次重启确实拍过快照、且还没校验过」时执行，避免每次启动都重复核对。
 */
export function verifyPluginStateOnBoot(scheduler, log, options = {}) {
  const record = scheduler?.lastRestart
  if (!record || typeof record !== 'object') return null
  const snapshotInfo = record.pluginStateSnapshot
  if (!snapshotInfo || typeof snapshotInfo !== 'object') return null
  if (record.pluginStateRestored !== undefined && record.pluginStateRestored !== null) return null

  const nowMs = typeof options.now === 'function' ? Number(options.now()) : Date.now()
  const profileDir = String(snapshotInfo.profileDir || options.profileDir || '').trim()
  const snapshotDir = String(snapshotInfo.dir || '').trim()

  let result
  try {
    result =
      snapshotInfo.ok === true && snapshotDir && profileDir
        ? verifyPluginStateAfterBoot({ snapshotDir: snapshotDir, profileDir: profileDir, now: nowMs, log: log })
        : {
            ok: false,
            consistent: false,
            restored: false,
            error: String(snapshotInfo.error || '本次重启没有可用的插件设置快照'),
          }
  } catch (error) {
    result = { ok: false, consistent: false, restored: false, error: String(error?.message || error) }
  }

  const consistent = result.ok === true && result.consistent === true
  if (result.ok !== true) {
    log?.warn?.(`插件启用设置校验失败，无法确认重启后是否被改写：${result.error || '未知原因'}`)
  } else if (result.restored) {
    log?.warn?.(`插件启用设置被启动过程改写，已按快照恢复：${summarizePluginDiff(result.before)}`)
    if (!consistent) {
      log?.warn?.(`插件启用设置二次恢复后仍与快照不一致：${summarizePluginDiff(result.after)}`)
    }
  } else {
    log?.info?.('插件启用设置与重启前快照一致（package.json、cordis.patch.yml）')
  }

  scheduler.lastRestart = {
    ...record,
    pluginStateRestored: consistent,
    pluginStateCheckedAt: new Date(nowMs).toISOString(),
  }
  try {
    scheduler.persistState()
  } catch (error) {
    log?.warn?.('插件启用设置校验结果落盘失败', error)
  }
  return { ...result, pluginStateRestored: consistent }
}

// ———————————————————————— 工具 ————————————————————————

/** 最近一次重启的外部摘要：只留可核查的 id、状态、时间与错误。 */
function briefRestart(record) {
  if (!record || typeof record !== 'object') return null
  const brief = {
    id: String(record.id || ''),
    status: String(record.status || ''),
    firedAt: record.firedAt || null,
  }
  if (record.restartedAt) brief.restartedAt = record.restartedAt
  if (record.error) brief.error = String(record.error)
  return brief
}

function makeTool(ctx, scheduler, log, options = {}) {
  const execute = async (params = {}, exec) => {
    const action = String(params?.action || '').trim()
    if (!action) return toolError('缺少 action', '可用动作：schedule / cancel / status')

    if (action === 'status') {
      const snapshot = scheduler.snapshot()
      const tasks = snapshot.tasks.map((item) => ({
        id: item.id,
        session: item.sessionLabel || item.sessionId,
        status: item.status,
        remainingSeconds: item.remainingSeconds,
        createdAt: item.createdAt,
      }))
      return {
        ok: true,
        action: 'status',
        phase: snapshot.phase,
        paused: snapshot.paused,
        busyCount: snapshot.busyCount,
        taskCount: snapshot.taskCount,
        tasks: tasks,
        lastRestart: briefRestart(snapshot.lastRestart),
        now: new Date(snapshot.now).toISOString(),
      }
    }

    if (action === 'schedule') {
      const session = resolveCallSession(exec)
      const result = scheduler.scheduleTask({
        sessionId: session,
        sessionLabel: sessionLabel(ctx, session),
        delaySeconds: params?.delaySeconds,
        wakeText: params?.wakeText,
        reason: params?.reason,
        source: 'tool',
      })
      const snapshot = scheduler.snapshot()
      return {
        ok: true,
        action: 'schedule',
        taskId: result.task.id,
        phase: snapshot.phase,
        busyCount: snapshot.busyCount,
        remainingSeconds: result.task.remainingSeconds,
        createdAt: result.task.createdAt,
        hint: '可用 status 查看进度，cancel 取消。',
      }
    }

    if (action === 'cancel') {
      const taskId = String(params?.taskId || '').trim()
      if (!taskId) {
        const snapshot = scheduler.snapshot()
        if (snapshot.tasks.length === 0) return toolError('没有可取消的任务', '先用 status 看看。')
        return toolError(
          '缺少 taskId',
          `要用 taskId 指定取消哪个任务：${snapshot.tasks.map((item) => item.id).join('、')}`,
        )
      }
      const result = scheduler.cancelTask(taskId, { source: 'tool' })
      if (!result.ok) {
        return { ok: false, code: 'not_found', error: result.error, taskCount: result.taskCount }
      }
      return {
        ok: true,
        action: 'cancel',
        taskId: result.task.id,
        feedbackDelivered: result.feedbackDelivered,
        remainingTaskCount: result.remainingTaskCount,
        phase: scheduler.snapshot().phase,
      }
    }

    return toolError(`不认识的动作 ${action}`, '可用动作：schedule / cancel / status')
  }

  return {
    name: 'dsh_restart',
    description:
      '排 / 取消 / 查看 DSH 重启任务。schedule 让 DSH 在指定延迟后重启（所有会话空闲才开始倒计时，有输入会暂停倒计时）。重启后只通知排过任务的会话「重启已完成」，不复述备忘。',
    parameters: toolArgs,
    output: toolOutput,
    execute: execute,
  }
}

// ———————————————————————— 入口 ————————————————————————

/** DSH 插件入口：任何异常都吞掉，绝不影响宿主。 */
export function apply(ctx, config) {
  try {
    return assemble(ctx, { pluginConfig: config || {} })
  } catch (error) {
    try {
      console.error(`[${pluginName}] 插件加载失败（已忽略，不影响 DSH）:`, error)
    } catch {
      /* 忽略 */
    }
    return null
  }
}

// 供测试/调试：读状态文件。
export { readJson as readStateFile }
