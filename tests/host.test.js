// 宿主装配测试：用假 ctx（假 webServer / agents / tools / effect），
// 全部把状态文件指到临时目录，onFire 注入假实现——测试里绝不会真的重启。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assemble,
  registerGuidance,
  restartGuidanceText,
  resolveCallSession,
  getBusySessions,
  createBusyReader,
  sessionLabel,
  apply,
} from '../lib/host.js'
import { routePrefix, defaultDelaySeconds, dialogMinRemainingSeconds } from '../lib/constants.js'
import { readJson } from '../lib/fsutil.js'
import { createPluginSnapshot } from '../lib/plugin-state.js'
import { makeFakeSpawn, makeClock, makeTimers } from './helpers.js'
import { Readable } from 'node:stream'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-host-'))
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return dir
}

/** 假 res：收集状态码/头/体。 */
function fakeResponse() {
  const res = {
    statusCode: null,
    head: {},
    body: '',
    setHeader(itemName, value) {
      res.head[String(itemName).toLowerCase()] = value
    },
    end(text) {
      res.body = String(text ?? '')
    },
  }
  return res
}

/** 假 req：方法 + 可选 JSON 体（体是 Readable，能被 读请求体 正常消费）+ 可选请求头。 */
function fakeRequest(method = 'GET', body = null, requestHeaders = null) {
  const request = Readable.from([Buffer.from(body == null ? '' : String(body))])
  request.method = method
  if (requestHeaders) request.headers = requestHeaders
  return request
}

/**
 * 造假 ctx：
 *  - webServer.register 收集路由
 *  - tools.register 收集工具
 *  - effect 立即执行并收集 disposer
 *  - get('agents') / get('sessionTitle') 返回可配置的假服务
 */
function makeFakeCtx(options = {}) {
  const route = []
  const tool = []
  const cleanup = []
  const injectLog = []
  const errorLog = []
  const sessionStates = new Map(options.sessionStates || [])
  const title = options.title || {}

  const agents = {
    list: () => {
      const list = []
      for (const [id, state] of sessionStates) {
        list.push({ id: `agent-${id}`, session: { id }, status: state })
      }
      return list
    },
    get: (id) => {
      if (!sessionStates.has(id)) return null
      return {
        id: `agent-${id}`,
        session: { id },
        status: sessionStates.get(id),
        inject: (message) => {
          injectLog.push({ session: id, message })
          return true
        },
      }
    },
  }

  const promptSections = []
  const promptService = {
    section: (section) => {
      promptSections.push(section)
      return () => {
        const index = promptSections.indexOf(section)
        if (index >= 0) promptSections.splice(index, 1)
      }
    },
  }

  const ctx = {
    route,
    tool,
    cleanup,
    injectLog,
    promptSections,
    promptService,
    get: (itemName) => {
      if (itemName === 'systemPrompt') return options.systemPromptService === undefined ? promptService : options.systemPromptService
      if (itemName === 'agents') return options.agents === undefined ? agents : options.agents
      if (itemName === 'sessions') {
        return {
          get: (id) => (sessionStates.has(id) || title[id] ? { id } : undefined),
        }
      }
      if (itemName === 'sessionTitle') return { get: (session) => (session ? title[session.id] || '' : '') }
      return undefined
    },
    webServer: {
      register: (definition) => {
        route.push(definition)
        return () => {
          const index = route.indexOf(definition)
          if (index >= 0) route.splice(index, 1)
        }
      },
    },
    tools: {
      register: (definition) => {
        tool.push(definition)
        return () => {
          const index = tool.indexOf(definition)
          if (index >= 0) tool.splice(index, 1)
        }
      },
    },
    effect: (fn, label) => {
      try {
        const result = fn()
        if (typeof result === 'function') cleanup.push(result)
      } catch (error) {
        errorLog.push(error)
      }
      return () => {}
    },
  }
  return ctx
}

/** 装配一套临时路径 + 假 onFire + 长心跳。 */
function makePlugin(t, override = {}) {
  const dir = override.dir || tempDir(t)
  const ctx = override.ctx || makeFakeCtx(override.ctxOptions)
  const fire = []
  const options = {
    stateFile: path.join(dir, 'restart-scheduler.json'),
    logFile: path.join(dir, 'restart-plugin.log'),
    scriptFile: path.join(dir, 'restart.ps1'),
    markerFile: path.join(dir, 'restart-scheduler-marker.json'),
    heartbeatMs: 600000,
    reportRetryMs: 10,
    // 插件启用设置一律指到临时目录，且清空 env，避免碰真实 profile 或真实 DSH_PROFILE_DIR。
    pluginState: {
      profileDir: path.join(dir, 'profile-settings'),
      snapshotsRoot: path.join(dir, 'plugin-snapshots'),
      env: {},
    },
    onFire: async (payload) => {
      fire.push(payload)
      return { ok: true, scriptPath: options.scriptFile, launcher: 'schtasks', wakeCount: (payload?.sessionIds || []).length }
    },
    ...override.options,
  }
  const plugin = assemble(ctx, options)
  t.after(() => {
    try { plugin.stop() } catch { /* 忽略 */ }
  })
  return { plugin, ctx, fire, dir, options }
}

function getRoute(ctx, subPath) {
  return ctx.route.find((item) => item.path === `${routePrefix}${subPath}`)
}

async function callRoute(ctx, subPath, req) {
  const route = getRoute(ctx, subPath)
  assert.notEqual(route, undefined, `路由 ${subPath} 应已注册`)
  const res = fakeResponse()
  await route.handler(req, res)
  return res
}

function getTool(ctx) {
  return ctx.tool.find((item) => item.name === 'dsh_restart')
}

// ———————————————————————— 注册与契约 ————————————————————————

test('装配：注册 6 条 exact 路由', (t) => {
  const { ctx } = makePlugin(t)
  const filePath = ctx.route.map((item) => item.path).sort()
  assert.deepEqual(filePath, [
    `${routePrefix}/cancel`,
    `${routePrefix}/dialog-open`,
    `${routePrefix}/now`,
    `${routePrefix}/pause`,
    `${routePrefix}/resume`,
    `${routePrefix}/state`,
  ])
  for (const item of ctx.route) assert.equal(item.kind, 'exact')
})

test('路由 /now：没有任务时回 400 no_tasks', async (t) => {
  const { ctx } = makePlugin(t)
  const res = await callRoute(ctx, '/now', fakeRequest('POST'))
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'no_tasks')
})

test('路由 /now：有任务时立刻触发并回空快照', async (t) => {
  const { ctx, fire, plugin } = makePlugin(t)
  plugin.scheduler.scheduleTask({ sessionId: 'session-a', delaySeconds: 600, reason: '按钮测试' })
  const res = await callRoute(ctx, '/now', fakeRequest('POST'))
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.immediate, true)
  assert.equal(fire.length, 1)
  assert.equal(body.snapshot.tasks.length, 0)
})

test('装配：注册 dsh_restart 工具', (t) => {  const { ctx } = makePlugin(t)
  const tool = getTool(ctx)
  assert.notEqual(tool, undefined)
  assert.equal(tool.name, 'dsh_restart')
  assert.equal(tool.parameters.required[0], 'action')
  assert.deepEqual(tool.parameters.properties.action.enum, ['schedule', 'cancel', 'status'])
})

test('装配：工具 output 有宽松 schema 与 render', (t) => {
  const { ctx } = makePlugin(t)
  const tool = getTool(ctx)
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, true)
  const rendered = tool.output.render({}, { ok: true })
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /"ok": true/)
})

test('装配：心跳启动后停止能清掉定时器', (t) => {
  const { plugin } = makePlugin(t)
  assert.notEqual(plugin.scheduler.timer, null)
  plugin.stop()
  assert.equal(plugin.scheduler.timer, null)
})

test('apply：ctx 为 null 也不抛（fail-open）', () => {
  assert.doesNotThrow(() => apply(null, {}))
})

// ———————————————————————— 工具：status ————————————————————————

test('工具 status：没有任务时给出空提示', async (t) => {
  const { ctx } = makePlugin(t)
  const result = await getTool(ctx).execute({ action: 'status' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.task, [])
  assert.match(result.hint, /没有任何重启任务/)
})

test('工具 status：列出多个任务', async (t) => {
  const { ctx } = makePlugin(t, { options: { onFire: null } })
  const tool = getTool(ctx)
  await tool.execute({ action: 'schedule', delaySeconds: 10, reason: '甲' }, { agent: { session: { id: 'session-a' } } })
  await tool.execute({ action: 'schedule', delaySeconds: 20, reason: '乙' }, { agent: { session: { id: 'session-b' } } })
  const result = await tool.execute({ action: 'status' })
  assert.equal(result.ok, true)
  assert.equal(result.task.length, 2)
  assert.deepEqual(result.task.map((item) => item.reason).sort(), ['甲', '乙'].sort())
  assert.match(result.hint, /共 2 个任务/)
})

test('工具 status：显示暂停状态', async (t) => {
  const { ctx, plugin } = makePlugin(t)
  await getTool(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  plugin.scheduler.pause('mouse')
  const result = await getTool(ctx).execute({ action: 'status' })
  assert.equal(result.pause, true)
})

// ———————————————————————— 工具：schedule ————————————————————————

test('工具 schedule：记录调用会话与延迟', async (t) => {
  const { ctx } = makePlugin(t)
  const result = await getTool(ctx).execute(
    { action: 'schedule', delaySeconds: 30, wakeText: '起来了', reason: '装插件' },
    { agent: { session: { id: 'session-abc' } } },
  )
  assert.equal(result.ok, true)
  assert.equal(result.action, 'schedule')
  assert.equal(result.task.sessionId, 'session-abc')
  assert.equal(result.task.delaySeconds, 30)
  assert.equal(result.task.wakeText, '起来了')
  assert.match(result.hint, /30 秒后重启/)
})

test('工具 schedule：不写延迟就用默认 60 秒', async (t) => {
  const { ctx } = makePlugin(t)
  const result = await getTool(ctx).execute({ action: 'schedule' }, { agent: { id: 'session-x' } })
  assert.equal(result.task.delaySeconds, defaultDelaySeconds)
})

test('工具 schedule：有其他会话在跑时提示先排队', async (t) => {
  const ctx = makeFakeCtx({ sessionStates: [['session-a', 'running'], ['session-b', 'running']] })
  const { plugin } = makePlugin(t, { ctx, options: { onFire: null } })
  const result = await getTool(ctx).execute({ action: 'schedule', delaySeconds: 15 }, { agent: { session: { id: 'session-a' } } })
  assert.equal(result.phase, 'waiting')
  assert.equal(result.busyCount, 2)
  assert.match(result.hint, /排队/)
  assert.equal(plugin.scheduler.tasks.length, 1)
})

// ———————————————————————— 工具：cancel ————————————————————————

test('工具 cancel：没任务也没 taskId 时提示先 status', async (t) => {
  const { ctx } = makePlugin(t)
  const result = await getTool(ctx).execute({ action: 'cancel' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_request')
  assert.match(result.hint, /status/)
})

test('工具 cancel：有任务没 taskId 时列出 id', async (t) => {
  const { ctx } = makePlugin(t)
  const tool = getTool(ctx)
  const scheduleCall = await tool.execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const result = await tool.execute({ action: 'cancel' })
  assert.equal(result.ok, false)
  assert.match(result.hint, new RegExp(scheduleCall.task.id))
})

test('工具 cancel：taskId 不存在返回 not_found', async (t) => {
  const { ctx } = makePlugin(t)
  const result = await getTool(ctx).execute({ action: 'cancel', taskId: 'restart-nope' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_found')
})

test('工具 cancel：取消成功并给会话注入反馈', async (t) => {
  const ctx = makeFakeCtx({ sessionStates: [['session-a', 'idle']] })
  const { ctx: useCtx } = makePlugin(t, { ctx })
  const tool = getTool(useCtx)
  const scheduleCall = await tool.execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const result = await tool.execute({ action: 'cancel', taskId: scheduleCall.task.id }, { agent: { session: { id: 'session-a' } } })
  assert.equal(result.ok, true)
  assert.equal(result.feedbackDelivered, true)
  assert.equal(result.remainingTaskCount, 0)
  assert.equal(useCtx.injectLog.length, 1)
  assert.equal(useCtx.injectLog[0].session, 'session-a')
  assert.match(useCtx.injectLog[0].message.content[0].text, /取消/)
})

test('工具 cancel：会话不在线时如实说反馈没送达', async (t) => {
  const { ctx } = makePlugin(t)
  const tool = getTool(ctx)
  const scheduleCall = await tool.execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-offline' } } })
  const result = await tool.execute({ action: 'cancel', taskId: scheduleCall.task.id })
  assert.equal(result.ok, true)
  assert.equal(result.feedbackDelivered, false)
  assert.match(result.hint, /没送达/)
})

// ———————————————————————— 工具：参数校验 ————————————————————————

test('工具：缺少 action 返回 bad_request', async (t) => {
  const { ctx } = makePlugin(t)
  const result = await getTool(ctx).execute({})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_request')
})

test('工具：未知 action 返回 bad_request', async (t) => {
  const { ctx } = makePlugin(t)
  const result = await getTool(ctx).execute({ action: 'explode' })
  assert.equal(result.ok, false)
  assert.match(result.error, /不认识的动作/)
})

// ———————————————————————— 路由：state ————————————————————————

test('路由 state：GET 返回快照与常量', async (t) => {
  const { ctx } = makePlugin(t)
  const res = await callRoute(ctx, '/state', fakeRequest('GET'))
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.constants.dialogMinRemainingSeconds, dialogMinRemainingSeconds)
  assert.equal(body.constants.defaultDelaySeconds, defaultDelaySeconds)
  assert.equal(Array.isArray(body.tasks), true)
  assert.match(body.serverTime, /^\d{4}-\d{2}-\d{2}T/)
})

test('路由 state：POST 回 405', async (t) => {
  const { ctx } = makePlugin(t)
  const res = await callRoute(ctx, '/state', fakeRequest('POST'))
  assert.equal(res.statusCode, 405)
})

// ———————————————————————— 路由：pause / resume ————————————————————————

test('路由 pause：暂停后快照里 paused=true', async (t) => {
  const { ctx } = makePlugin(t)
  await getTool(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const res = await callRoute(ctx, '/pause', fakeRequest('POST'))
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.paused, true)
})

test('路由 resume：恢复后 paused=false', async (t) => {
  const { ctx } = makePlugin(t)
  await getTool(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  await callRoute(ctx, '/pause', fakeRequest('POST'))
  const res = await callRoute(ctx, '/resume', fakeRequest('POST'))
  const body = JSON.parse(res.body)
  assert.equal(body.paused, false)
  assert.equal(body.changed, true)
})

test('路由 pause：GET 回 405', async (t) => {
  const { ctx } = makePlugin(t)
  const res = await callRoute(ctx, '/pause', fakeRequest('GET'))
  assert.equal(res.statusCode, 405)
})

// ———————————————————————— 路由：cancel ————————————————————————

// ———————————————————————— 路由：同源校验 ————————————————————————

test('路由 pause：伪造 Origin 被 403 拒绝且不改变状态', async (t) => {
  const { ctx, plugin } = makePlugin(t)
  await getTool(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const res = await callRoute(ctx, '/pause', fakeRequest('POST', null, {
    host: '127.0.0.1:13066',
    origin: 'http://evil.example',
    'sec-fetch-site': 'cross-site',
  }))
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).code, 'forbidden_origin')
  assert.equal(plugin.scheduler.paused, null)
})

test('路由 cancel：伪造 Origin 被 403 拒绝且任务不变', async (t) => {
  const { ctx, plugin } = makePlugin(t)
  const scheduleCall = await getTool(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const res = await callRoute(ctx, '/cancel', fakeRequest('POST', JSON.stringify({ taskId: scheduleCall.task.id }), {
    host: '127.0.0.1:13066',
    origin: 'http://evil.example',
  }))
  assert.equal(res.statusCode, 403)
  assert.equal(plugin.scheduler.tasks.length, 1)
})

test('路由 pause：同源请求通过（端口不写死）', async (t) => {
  const { ctx } = makePlugin(t)
  await getTool(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const res = await callRoute(ctx, '/pause', fakeRequest('POST', null, {
    host: '127.0.0.1:54321',
    origin: 'http://127.0.0.1:54321',
    'sec-fetch-site': 'same-origin',
  }))
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).paused, true)
})

test('路由 pause：非浏览器调用（无来源头）放行', async (t) => {
  const { ctx } = makePlugin(t)
  const res = await callRoute(ctx, '/pause', fakeRequest('POST', null, { host: '127.0.0.1:13066' }))
  assert.equal(res.statusCode, 200)
})

test('路由 pause：Sec-Fetch-Site 是 same-origin 但 Origin 跨站也拒', async (t) => {
  const { ctx } = makePlugin(t)
  const res = await callRoute(ctx, '/pause', fakeRequest('POST', null, {
    host: '127.0.0.1:13066',
    origin: 'http://127.0.0.1:13067',
    'sec-fetch-site': 'same-origin',
  }))
  assert.equal(res.statusCode, 403)
})

// ———————————————————————— 忙碌读取器 ————————————————————————

test('忙碌读取器：持续忙碌超过上限后按空闲处理且只告警一次', () => {
  let state = 'running'
  const ctx = { get: (itemName) => (itemName === 'agents' ? { list: () => [{ id: 'a1', session: { id: 's1' }, status: state }] } : undefined) }
  const warnings = []
  let now = 0
  const read = createBusyReader(ctx, { warn: (infoMessage) => warnings.push(infoMessage) }, { now: () => now, timeoutMs: 1000 })
  assert.equal(read().length, 1)
  now = 999
  assert.equal(read().length, 1)
  now = 1000
  assert.equal(read().length, 0)
  now = 2000
  assert.equal(read().length, 0)
  assert.equal(warnings.length, 1)
  // 会话真的空闲后，计时清零。
  state = 'idle'
  now = 3000
  assert.equal(read().length, 0)
  state = 'running'
  now = 3500
  assert.equal(read().length, 1)
})

test('路由 cancel：缺 taskId 回 400', async (t) => {
  const { ctx } = makePlugin(t)
  const res = await callRoute(ctx, '/cancel', fakeRequest('POST', '{}'))
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).code, 'bad_request')
})

test('路由 cancel：任务不存在回 404', async (t) => {
  const { ctx } = makePlugin(t)
  const res = await callRoute(ctx, '/cancel', fakeRequest('POST', '{"taskId":"restart-none"}'))
  assert.equal(res.statusCode, 404)
})

test('路由 cancel：成功回 200 并注入反馈', async (t) => {
  const ctx = makeFakeCtx({ sessionStates: [['session-a', 'idle']] })
  const { ctx: useCtx } = makePlugin(t, { ctx })
  const scheduleCall = await getTool(useCtx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const res = await callRoute(useCtx, '/cancel', fakeRequest('POST', JSON.stringify({ taskId: scheduleCall.task.id })))
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).feedbackDelivered, true)
  assert.equal(useCtx.injectLog.length, 1)
})

// ———————————————————————— 路由：dialog-open ————————————————————————

test('路由 dialog-open：剩余不足 5 秒的任务抬回 5 秒', async (t) => {
  const { ctx, plugin } = makePlugin(t)
  await getTool(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  // 手工把任务剩余时间改成 2 秒，模拟倒计时快结束
  plugin.scheduler.tasks[0].remainingMs = 2000
  const res = await callRoute(ctx, '/dialog-open', fakeRequest('POST'))
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.raisedCount, 1)
  assert.equal(plugin.scheduler.tasks[0].remainingMs, 5000)
})

test('路由 dialog-open：≥5 秒的任务不动', async (t) => {
  const { ctx, plugin } = makePlugin(t)
  await getTool(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  plugin.scheduler.tasks[0].remainingMs = 8000
  const res = await callRoute(ctx, '/dialog-open', fakeRequest('POST'))
  const body = JSON.parse(res.body)
  assert.equal(body.raisedCount, 0)
  assert.equal(plugin.scheduler.tasks[0].remainingMs, 8000)
})

// ———————————————————————— 持久化与开机恢复 ————————————————————————

test('装配：排任务后状态文件落盘且能读回', async (t) => {
  const { ctx, plugin } = makePlugin(t)
  await getTool(ctx).execute({ action: 'schedule', delaySeconds: 25, reason: '持久化' }, { agent: { session: { id: 'session-a' } } })
  const diskState = readJson(plugin.stateFile)
  assert.notEqual(diskState, null)
  assert.equal(diskState.tasks.length, 1)
  assert.equal(diskState.tasks[0].reason, '持久化')
})

test('装配：启动时从状态文件恢复任务', (t) => {
  const dir = tempDir(t)
  const stateFile = path.join(dir, 'restart-scheduler.json')
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'restart-old',
          sessionId: 'session-a',
          delaySeconds: 30,
          wakeText: '',
          reason: '旧的',
          remainingMs: 20000,
          status: 'counting',
          createdAt: new Date().toISOString(),
        },
      ],
      phase: 'countdown',
      paused: null,
      lastTickAt: null,
      lastRestart: null,
    }),
    'utf8',
  )
  const { plugin } = makePlugin(t, { dir })
  assert.equal(plugin.scheduler.tasks.length, 1)
  assert.equal(plugin.scheduler.tasks[0].id, 'restart-old')
  assert.equal(plugin.scheduler.tasks[0].remainingMs, 20000)
})

test('装配：上次重启已完成的记录会触发开机汇报', async (t) => {
  const dir = tempDir(t)
  const ctx = makeFakeCtx({ sessionStates: [['session-a', 'idle']] })
  fs.writeFileSync(
    path.join(dir, 'restart-scheduler.json'),
    JSON.stringify({
      version: 1,
      tasks: [],
      phase: 'idle',
      paused: null,
      lastTickAt: null,
      lastRestart: {
        id: 'restart-run-old',
        status: 'restarted',
        firedAt: new Date().toISOString(),
        tasks: [{ id: 'restart-old', sessionId: 'session-a' }],
        sessionIds: ['session-a'],
        reported: false,
      },
    }),
    'utf8',
  )
  makePlugin(t, { ctx, dir })
  // 开机汇报延迟 10ms 后发出
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 60))
  assert.equal(ctx.injectLog.length, 1)
  assert.match(ctx.injectLog[0].message.content[0].text, /DSH 已重启完成/)
  const diskState = readJson(path.join(dir, 'restart-scheduler.json'))
  assert.equal(diskState.lastRestart.reported, true)
})

test('装配：开机标记稍后才确认时补排开机汇报', async (t) => {
  const dir = tempDir(t)
  const ctx = makeFakeCtx({ sessionStates: [['session-a', 'idle']] })
  const clock = makeClock(0)
  const timers = makeTimers(clock)
  fs.writeFileSync(
    path.join(dir, 'restart-scheduler.json'),
    JSON.stringify({
      version: 1,
      tasks: [],
      phase: 'idle',
      paused: null,
      lastTickAt: null,
      lastRestart: {
        id: 'restart-run-race',
        status: 'firing',
        firedAt: new Date(0).toISOString(),
        sessionIds: ['session-a'],
        tasks: [{ id: 'restart-old', sessionId: 'session-a' }],
        fired: true,
      },
    }),
    'utf8',
  )
  fs.writeFileSync(path.join(dir, 'restart-scheduler-marker.json'), JSON.stringify({ status: 'launched' }), 'utf8')

  makePlugin(t, {
    ctx,
    dir,
    options: { now: clock.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  })

  // 启动时标记还没到终态：先保持 firing，不汇报。
  assert.equal(ctx.injectLog.length, 0)

  fs.writeFileSync(
    path.join(dir, 'restart-scheduler-marker.json'),
    JSON.stringify({ status: 'restarted', ready: true, pid: 32816, ports: [2829] }),
    'utf8',
  )
  timers.advance(600)

  // 汇报本身走真实定时器（reportRetryMs=10），等它送出。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 60))
  assert.equal(ctx.injectLog.length, 1)
  assert.match(ctx.injectLog[0].message.content[0].text, /DSH 已重启完成/)
  assert.equal(readJson(path.join(dir, 'restart-scheduler.json')).lastRestart.reported, true)
})

// ———————————————————————— 插件启用设置保护 ————————————————————————

/** 造一份 profile 与其重启前快照，返回原始字节。 */
function makeProfileFixture(t) {
  const dir = tempDir(t)
  const profileDir = path.join(dir, 'profile-settings')
  fs.mkdirSync(profileDir, { recursive: true })
  const manifest = `${JSON.stringify({ dsh: { profile: { bundles: ['alpha', 'beta'] } } }, null, 2)}\n`
  const patch = '- id: alpha\n  disabled: true\n'
  fs.writeFileSync(path.join(profileDir, 'package.json'), manifest, 'utf8')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch, 'utf8')
  const snapshot = createPluginSnapshot({
    profileDir,
    snapshotsRoot: path.join(dir, 'plugin-snapshots'),
    now: Date.now(),
  })
  assert.equal(snapshot.ok, true)
  return { dir, profileDir, manifest, patch, snapshot }
}

/** 写一份「上次重启已完成」的状态文件，让开机校验有据可依。 */
function seedRestartedState(dir, lastRestart) {
  fs.writeFileSync(
    path.join(dir, 'restart-scheduler.json'),
    JSON.stringify({ version: 1, tasks: [], phase: 'idle', paused: null, lastTickAt: null, lastRestart }),
    'utf8',
  )
}

/** 收集日志，断言某些 warn/info 确实出现过。 */
function makeRecordingLog() {
  const entries = []
  return {
    entries,
    log: {
      info: (...params) => entries.push(['info', params.join(' ')]),
      warn: (...params) => entries.push(['warn', params.join(' ')]),
      error: (...params) => entries.push(['error', params.join(' ')]),
    },
  }
}

test('开机校验：插件设置被启动过程改写时按快照写回并记 warn', (t) => {
  const fixture = makeProfileFixture(t)
  const { log, entries } = makeRecordingLog()
  seedRestartedState(fixture.dir, {
    id: 'restart-run-snapshot',
    status: 'restarted',
    firedAt: new Date().toISOString(),
    tasks: [],
    sessionIds: [],
    reported: true,
    pluginStateSnapshot: {
      ok: true,
      dir: fixture.snapshot.dir,
      profileDir: fixture.profileDir,
      files: fixture.snapshot.files,
    },
  })
  // 模拟 dsh plugin 的对齐逻辑：bundles 里塞进 intruder，disabled 被翻转。
  fs.writeFileSync(
    path.join(fixture.profileDir, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['alpha', 'beta', 'intruder'] } } }),
    'utf8',
  )
  fs.writeFileSync(path.join(fixture.profileDir, 'cordis.patch.yml'), '- id: alpha\n  disabled: false\n', 'utf8')

  makePlugin(t, {
    dir: fixture.dir,
    options: {
      log,
      pluginState: {
        profileDir: fixture.profileDir,
        snapshotsRoot: path.join(fixture.dir, 'plugin-snapshots'),
        env: {},
      },
    },
  })

  assert.equal(fs.readFileSync(path.join(fixture.profileDir, 'package.json'), 'utf8'), fixture.manifest)
  assert.equal(fs.readFileSync(path.join(fixture.profileDir, 'cordis.patch.yml'), 'utf8'), fixture.patch)
  const backup = fs.readdirSync(fixture.profileDir).filter((name) => name.includes('.bak-restart-'))
  assert.equal(backup.length, 2)
  const diskState = readJson(path.join(fixture.dir, 'restart-scheduler.json'))
  assert.equal(diskState.lastRestart.pluginStateRestored, true)
  assert.ok(entries.some(([level, message]) => level === 'warn' && /改写/.test(message)))
  assert.ok(entries.some(([level, message]) => level === 'warn' && /intruder/.test(message)))
})

test('开机校验：与快照一致时记 info、不改文件也不留备份', (t) => {
  const fixture = makeProfileFixture(t)
  const { log, entries } = makeRecordingLog()
  seedRestartedState(fixture.dir, {
    id: 'restart-run-clean',
    status: 'restarted',
    firedAt: new Date().toISOString(),
    tasks: [],
    sessionIds: [],
    reported: true,
    pluginStateSnapshot: {
      ok: true,
      dir: fixture.snapshot.dir,
      profileDir: fixture.profileDir,
      files: fixture.snapshot.files,
    },
  })

  makePlugin(t, {
    dir: fixture.dir,
    options: {
      log,
      pluginState: {
        profileDir: fixture.profileDir,
        snapshotsRoot: path.join(fixture.dir, 'plugin-snapshots'),
        env: {},
      },
    },
  })

  assert.equal(fs.readFileSync(path.join(fixture.profileDir, 'package.json'), 'utf8'), fixture.manifest)
  assert.equal(
    fs.readdirSync(fixture.profileDir).filter((name) => name.includes('.bak-restart-')).length,
    0,
  )
  const diskState = readJson(path.join(fixture.dir, 'restart-scheduler.json'))
  assert.equal(diskState.lastRestart.pluginStateRestored, true)
  assert.ok(entries.some(([level, message]) => level === 'info' && /一致/.test(message)))
})

test('开机校验：没有可用快照时记 warn、标记 false，且不动 profile', (t) => {
  const fixture = makeProfileFixture(t)
  const { log, entries } = makeRecordingLog()
  seedRestartedState(fixture.dir, {
    id: 'restart-run-missing',
    status: 'restarted',
    firedAt: new Date().toISOString(),
    tasks: [],
    sessionIds: [],
    reported: true,
    pluginStateSnapshot: {
      ok: false,
      dir: '',
      profileDir: fixture.profileDir,
      files: [],
      code: 'missing_profile',
      error: 'profile 目录不存在',
    },
  })
  const changed = JSON.stringify({ dsh: { profile: { bundles: ['alpha', 'beta', 'intruder'] } } })
  fs.writeFileSync(path.join(fixture.profileDir, 'package.json'), changed, 'utf8')

  makePlugin(t, {
    dir: fixture.dir,
    options: {
      log,
      pluginState: {
        profileDir: fixture.profileDir,
        snapshotsRoot: path.join(fixture.dir, 'plugin-snapshots'),
        env: {},
      },
    },
  })

  assert.equal(fs.readFileSync(path.join(fixture.profileDir, 'package.json'), 'utf8'), changed)
  const diskState = readJson(path.join(fixture.dir, 'restart-scheduler.json'))
  assert.equal(diskState.lastRestart.pluginStateRestored, false)
  assert.ok(entries.some(([level, message]) => level === 'warn' && /校验失败/.test(message)))
})

test('开机校验：已校验过的记录不再重复写回', (t) => {
  const fixture = makeProfileFixture(t)
  seedRestartedState(fixture.dir, {
    id: 'restart-run-done',
    status: 'restarted',
    firedAt: new Date().toISOString(),
    tasks: [],
    sessionIds: [],
    reported: true,
    pluginStateRestored: true,
    pluginStateSnapshot: {
      ok: true,
      dir: fixture.snapshot.dir,
      profileDir: fixture.profileDir,
      files: fixture.snapshot.files,
    },
  })
  const changed = JSON.stringify({ dsh: { profile: { bundles: ['alpha', 'beta', 'intruder'] } } })
  fs.writeFileSync(path.join(fixture.profileDir, 'package.json'), changed, 'utf8')

  makePlugin(t, {
    dir: fixture.dir,
    options: {
      pluginState: {
        profileDir: fixture.profileDir,
        snapshotsRoot: path.join(fixture.dir, 'plugin-snapshots'),
        env: {},
      },
    },
  })

  assert.equal(fs.readFileSync(path.join(fixture.profileDir, 'package.json'), 'utf8'), changed)
  const diskState = readJson(path.join(fixture.dir, 'restart-scheduler.json'))
  assert.equal(diskState.lastRestart.pluginStateRestored, true)
})

test('触发重启：强杀前先给插件设置拍快照并记进状态', async (t) => {
  const fixture = makeProfileFixture(t)
  const spawnImpl = makeFakeSpawn([{ code: 0 }, { code: 0 }])
  const { plugin } = makePlugin(t, {
    dir: fixture.dir,
    options: {
      onFire: null,
      spawnImpl,
      filePath: { homeDir: path.join(fixture.dir, 'home') },
      scheduleFilePath: path.join(fixture.dir, 'home', 'storages', 'schedule.json'),
      pluginState: {
        profileDir: fixture.profileDir,
        snapshotsRoot: path.join(fixture.dir, 'plugin-snapshots'),
        env: {},
      },
    },
  })
  plugin.scheduler.scheduleTask({
    sessionId: 'session-a',
    sessionLabel: '会话 A',
    delaySeconds: 10,
    reason: '测试',
  })
  await plugin.scheduler.fire(Date.now())

  const record = plugin.scheduler.lastRestart
  assert.equal(record.pluginStateSnapshot.ok, true)
  assert.ok(fs.existsSync(record.pluginStateSnapshot.dir))
  assert.deepEqual(fs.readdirSync(record.pluginStateSnapshot.dir).sort(), [
    'cordis.patch.yml',
    'package.json',
  ])
  assert.equal(spawnImpl.calls.length, 2)
  const diskState = readJson(path.join(fixture.dir, 'restart-scheduler.json'))
  assert.equal(diskState.lastRestart.pluginStateSnapshot.ok, true)
})

// ———————————————————————— 辅助函数 ————————————————————————

test('解析调用会话：按优先级取 session id', () => {
  assert.equal(resolveCallSession({ agent: { session: { id: 's1' }, id: 'a1' } }), 's1')
  assert.equal(resolveCallSession({ agent: { id: 'a1' } }), 'a1')
  assert.equal(resolveCallSession({ sessionId: 's2' }), 's2')
  assert.equal(resolveCallSession({}), '')
})

test('取忙碌会话：running 算忙，idle 与缺状态都不算', () => {
  const ctx = makeFakeCtx({
    sessionStates: [
      ['session-a', 'running'],
      ['session-b', 'idle'],
      ['session-c', undefined],
    ],
  })
  const busy = getBusySessions(ctx, null)
  assert.deepEqual(busy.map((item) => item.sessionId), ['session-a'])
})

test('取忙碌会话：没有 agents 服务时返回空（按空闲处理）', () => {
  assert.deepEqual(getBusySessions({ get: () => undefined }, null), [])
})

test('会话标签：有标题用标题，没有就截 id', () => {
  const ctx = makeFakeCtx({ title: { 'session-abcdef123456': '修插件' } })
  assert.equal(sessionLabel(ctx, 'session-abcdef123456'), '修插件')
  assert.equal(sessionLabel(ctx, 'session-zzzzyyyyxxxx'), 'zzzzyyyy')
  assert.equal(sessionLabel(ctx, ''), '')
})

test('会话标签：sessionTitle 的 get 收会话对象，标题按 Session 换出来', () => {
  const ctx = makeFakeCtx({
    sessionStates: [['session-live0001', 'running']],
    title: { 'session-live0001': '大肥鱼聊天' },
  })
  assert.equal(sessionLabel(ctx, 'session-live0001'), '大肥鱼聊天')
})

test('会话标签：sessions 取不到时退回 agents 里的 session', () => {
  const agents = {
    get: (id) => (id === 'session-only-agent' ? { id: 'agent-x', session: { id } } : null),
  }
  const ctx = {
    get: (itemName) => {
      if (itemName === 'agents') return agents
      if (itemName === 'sessionTitle') return { get: (session) => (session.id === 'session-only-agent' ? '只有代理能拿到' : '') }
      return undefined
    },
  }
  assert.equal(sessionLabel(ctx, 'session-only-agent'), '只有代理能拿到')
})

// ———————————————————————— 系统提示（重启职责） ————————————————————————

/** 假日志：把每条记录收进数组，方便断言降级说明。 */
function makeRecordingLogger() {
  const record = []
  const collect = (level) => (...params) => { record.push({ level, params }) }
  return { record, log: { info: collect('info'), warn: collect('warn'), error: collect('error') } }
}

test('系统提示：注入重启提示段，内容指向 dsh_restart', (t) => {
  const { ctx } = makePlugin(t)
  assert.equal(ctx.promptSections.length, 1)
  const section = ctx.promptSections[0]
  assert.equal(section.name, 'dsh-restart-guidance')
  assert.equal(section.interpolate, false, '纯文本段要关掉 {{变量}} 插值')
  assert.equal(typeof section.order, 'number')
  assert.equal(section.text, restartGuidanceText)
  assert.match(section.text, /dsh_restart/)
  assert.match(section.text, /不要自己杀进程/)
  assert.match(section.text, /所有会话空闲/)
  // 不给具体的手动重启命令，也不写死端口/路径（插件会装在别人机器上）
  assert.doesNotMatch(section.text, /taskkill|Stop-Process|schtasks\s+\/create/i)
  assert.doesNotMatch(section.text, /[A-Za-z]:\\|\d+\.\d+\.\d+\.\d+|localhost:\d+/)
})

test('系统提示：systemPrompt 缺失时降级，工具照常注册', (t) => {
  const { record, log } = makeRecordingLogger()
  const { ctx, plugin } = makePlugin(t, { ctxOptions: { systemPromptService: null }, options: { log } })
  assert.equal(ctx.promptSections.length, 0)
  assert.notEqual(getTool(ctx), undefined, 'dsh_restart 工具不受提示服务影响')
  assert.ok(plugin, '装配不因缺服务而失败')
  assert.ok(
    record.some((item) => item.level === 'warn' && String(item.params[0]).includes('systemPrompt')),
    '应在日志里说明降级原因',
  )
})

test('系统提示：读取服务本身抛错也不抛', () => {
  const { record, log } = makeRecordingLogger()
  const dispose = registerGuidance({ get() { throw new Error('boom') } }, log)
  assert.equal(dispose, null)
  assert.ok(record.some((item) => item.level === 'warn' && String(item.params[0]).includes('boom')))
})

test('系统提示：重名注册说明已注入，按幂等跳过', (t) => {
  const { record, log } = makeRecordingLogger()
  const service = {
    section() {
      throw new Error('prompt section "dsh-restart-guidance" is already registered (for a per-agent override, register through that agent\'s agent.ctx instead)')
    },
  }
  const { ctx } = makePlugin(t, { ctxOptions: { systemPromptService: service }, options: { log } })
  assert.equal(ctx.promptSections.length, 0)
  assert.ok(record.some((item) => item.level === 'info' && String(item.params[0]).includes('已注册')))
})

test('系统提示：注册抛别的错只记日志，不影响装配', (t) => {
  const { record, log } = makeRecordingLogger()
  const service = { section() { throw new Error('层已销毁') } }
  const { ctx } = makePlugin(t, { ctxOptions: { systemPromptService: service }, options: { log } })
  assert.notEqual(getTool(ctx), undefined)
  assert.ok(record.some((item) => item.level === 'warn' && String(item.params[0]).includes('层已销毁')))
})

test('系统提示：插件停止时撤销提示段', (t) => {
  const { ctx, plugin } = makePlugin(t)
  assert.equal(ctx.promptSections.length, 1)
  plugin.stop()
  assert.equal(ctx.promptSections.length, 0, '停止后不应残留提示段')
})

