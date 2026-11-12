// 宿主装配测试：用假 ctx（假 webServer / agents / tools / effect），
// 全部把状态文件指到临时目录，onFire 注入假实现——测试里绝不会真的重启。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  装配,
  注册重启提示,
  重启提示文本,
  解析调用会话,
  取忙碌会话,
  会话标签,
  apply,
} from '../lib/host.js'
import { 路由前缀, 默认延迟秒, 弹框最小剩余秒 } from '../lib/constants.js'
import { 读JSON } from '../lib/fsutil.js'
import { Readable } from 'node:stream'

function 临时目录(t) {
  const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-host-'))
  t.after(() => {
    try { fs.rmSync(目录, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return 目录
}

/** 假 res：收集状态码/头/体。 */
function 假响应() {
  const res = {
    statusCode: null,
    头: {},
    体: '',
    setHeader(名, 值) {
      res.头[String(名).toLowerCase()] = 值
    },
    end(文本) {
      res.体 = String(文本 ?? '')
    },
  }
  return res
}

/** 假 req：方法 + 可选 JSON 体（体是 Readable，能被 读请求体 正常消费）。 */
function 假请求(方法 = 'GET', 体 = null) {
  const 请求 = Readable.from([Buffer.from(体 == null ? '' : String(体))])
  请求.method = 方法
  return 请求
}

/**
 * 造假 ctx：
 *  - webServer.register 收集路由
 *  - tools.register 收集工具
 *  - effect 立即执行并收集 disposer
 *  - get('agents') / get('sessionTitle') 返回可配置的假服务
 */
function 造假ctx(选项 = {}) {
  const 路由 = []
  const 工具 = []
  const 清理 = []
  const 注入记录 = []
  const 错误日志 = []
  const 会话状态 = new Map(选项.会话状态 || [])
  const 标题 = 选项.标题 || {}

  const agents = {
    list: () => {
      const 列表 = []
      for (const [id, 状态] of 会话状态) {
        列表.push({ id: `agent-${id}`, session: { id }, status: 状态 })
      }
      return 列表
    },
    get: (id) => {
      if (!会话状态.has(id)) return null
      return {
        id: `agent-${id}`,
        session: { id },
        status: 会话状态.get(id),
        inject: (消息) => {
          注入记录.push({ 会话: id, 消息 })
          return true
        },
      }
    },
  }

  const 提示段 = []
  const 提示服务 = {
    section: (段) => {
      提示段.push(段)
      return () => {
        const 序号 = 提示段.indexOf(段)
        if (序号 >= 0) 提示段.splice(序号, 1)
      }
    },
  }

  const ctx = {
    路由,
    工具,
    清理,
    注入记录,
    提示段,
    提示服务,
    get: (名) => {
      if (名 === 'systemPrompt') return 选项.系统提示 === undefined ? 提示服务 : 选项.系统提示
      if (名 === 'agents') return 选项.agents === undefined ? agents : 选项.agents
      if (名 === 'sessions') {
        return {
          get: (id) => (会话状态.has(id) || 标题[id] ? { id } : undefined),
        }
      }
      if (名 === 'sessionTitle') return { get: (会话) => (会话 ? 标题[会话.id] || '' : '') }
      return undefined
    },
    webServer: {
      register: (定义) => {
        路由.push(定义)
        return () => {
          const 序号 = 路由.indexOf(定义)
          if (序号 >= 0) 路由.splice(序号, 1)
        }
      },
    },
    tools: {
      register: (定义) => {
        工具.push(定义)
        return () => {
          const 序号 = 工具.indexOf(定义)
          if (序号 >= 0) 工具.splice(序号, 1)
        }
      },
    },
    effect: (函数, 标签) => {
      try {
        const 结果 = 函数()
        if (typeof 结果 === 'function') 清理.push(结果)
      } catch (错误) {
        错误日志.push(错误)
      }
      return () => {}
    },
  }
  return ctx
}

/** 装配一套临时路径 + 假 onFire + 长心跳。 */
function 造插件(t, 覆盖 = {}) {
  const 目录 = 覆盖.目录 || 临时目录(t)
  const ctx = 覆盖.ctx || 造假ctx(覆盖.ctx选项)
  const 触发 = []
  const 选项 = {
    状态文件: path.join(目录, 'restart-scheduler.json'),
    日志文件: path.join(目录, 'restart-plugin.log'),
    脚本文件: path.join(目录, 'restart.ps1'),
    标记文件: path.join(目录, 'restart-scheduler-marker.json'),
    心跳毫秒: 600000,
    汇报重试毫秒: 10,
    onFire: async (载荷) => {
      触发.push(载荷)
      return { ok: true, scriptPath: 选项.脚本文件, launcher: 'schtasks', wakeCount: (载荷?.sessionIds || []).length }
    },
    ...覆盖.选项,
  }
  const 插件 = 装配(ctx, 选项)
  t.after(() => {
    try { 插件.停止() } catch { /* 忽略 */ }
  })
  return { 插件, ctx, 触发, 目录, 选项 }
}

function 取路由(ctx, 子路径) {
  return ctx.路由.find((项) => 项.path === `${路由前缀}${子路径}`)
}

async function 调路由(ctx, 子路径, req) {
  const 路由 = 取路由(ctx, 子路径)
  assert.notEqual(路由, undefined, `路由 ${子路径} 应已注册`)
  const res = 假响应()
  await 路由.handler(req, res)
  return res
}

function 取工具(ctx) {
  return ctx.工具.find((项) => 项.name === 'dsh_restart')
}

// ———————————————————————— 注册与契约 ————————————————————————

test('装配：注册 6 条 exact 路由', (t) => {
  const { ctx } = 造插件(t)
  const 路径 = ctx.路由.map((项) => 项.path).sort()
  assert.deepEqual(路径, [
    `${路由前缀}/cancel`,
    `${路由前缀}/dialog-open`,
    `${路由前缀}/now`,
    `${路由前缀}/pause`,
    `${路由前缀}/resume`,
    `${路由前缀}/state`,
  ])
  for (const 项 of ctx.路由) assert.equal(项.kind, 'exact')
})

test('路由 /now：没有任务时回 400 no_tasks', async (t) => {
  const { ctx } = 造插件(t)
  const res = await 调路由(ctx, '/now', 假请求('POST'))
  assert.equal(res.statusCode, 400)
  const 体 = JSON.parse(res.体)
  assert.equal(体.ok, false)
  assert.equal(体.code, 'no_tasks')
})

test('路由 /now：有任务时立刻触发并回空快照', async (t) => {
  const { ctx, 触发, 插件 } = 造插件(t)
  插件.调度器.排任务({ sessionId: 'session-a', delaySeconds: 600, reason: '按钮测试' })
  const res = await 调路由(ctx, '/now', 假请求('POST'))
  assert.equal(res.statusCode, 200)
  const 体 = JSON.parse(res.体)
  assert.equal(体.ok, true)
  assert.equal(体.立即, true)
  assert.equal(触发.length, 1)
  assert.equal(体.快照.tasks.length, 0)
})

test('装配：注册 dsh_restart 工具', (t) => {  const { ctx } = 造插件(t)
  const 工具 = 取工具(ctx)
  assert.notEqual(工具, undefined)
  assert.equal(工具.name, 'dsh_restart')
  assert.equal(工具.parameters.required[0], 'action')
  assert.deepEqual(工具.parameters.properties.action.enum, ['schedule', 'cancel', 'status'])
})

test('装配：工具 output 有宽松 schema 与 render', (t) => {
  const { ctx } = 造插件(t)
  const 工具 = 取工具(ctx)
  assert.equal(工具.output.schema.type, 'object')
  assert.equal(工具.output.schema.additionalProperties, true)
  const 渲染 = 工具.output.render({}, { ok: true })
  assert.equal(渲染[0].type, 'text')
  assert.match(渲染[0].text, /"ok": true/)
})

test('装配：心跳启动后停止能清掉定时器', (t) => {
  const { 插件 } = 造插件(t)
  assert.notEqual(插件.调度器.timer, null)
  插件.停止()
  assert.equal(插件.调度器.timer, null)
})

test('apply：ctx 为 null 也不抛（fail-open）', () => {
  assert.doesNotThrow(() => apply(null, {}))
})

// ———————————————————————— 工具：status ————————————————————————

test('工具 status：没有任务时给出空提示', async (t) => {
  const { ctx } = 造插件(t)
  const 结果 = await 取工具(ctx).execute({ action: 'status' })
  assert.equal(结果.ok, true)
  assert.deepEqual(结果.任务, [])
  assert.match(结果.hint, /没有任何重启任务/)
})

test('工具 status：列出多个任务', async (t) => {
  const { ctx } = 造插件(t, { 选项: { onFire: null } })
  const 工具 = 取工具(ctx)
  await 工具.execute({ action: 'schedule', delaySeconds: 10, reason: '甲' }, { agent: { session: { id: 'session-a' } } })
  await 工具.execute({ action: 'schedule', delaySeconds: 20, reason: '乙' }, { agent: { session: { id: 'session-b' } } })
  const 结果 = await 工具.execute({ action: 'status' })
  assert.equal(结果.ok, true)
  assert.equal(结果.任务.length, 2)
  assert.deepEqual(结果.任务.map((项) => 项.reason).sort(), ['甲', '乙'].sort())
  assert.match(结果.hint, /共 2 个任务/)
})

test('工具 status：显示暂停状态', async (t) => {
  const { ctx, 插件 } = 造插件(t)
  await 取工具(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  插件.调度器.暂停('mouse')
  const 结果 = await 取工具(ctx).execute({ action: 'status' })
  assert.equal(结果.暂停, true)
})

// ———————————————————————— 工具：schedule ————————————————————————

test('工具 schedule：记录调用会话与延迟', async (t) => {
  const { ctx } = 造插件(t)
  const 结果 = await 取工具(ctx).execute(
    { action: 'schedule', delaySeconds: 30, wakeText: '起来了', reason: '装插件' },
    { agent: { session: { id: 'session-abc' } } },
  )
  assert.equal(结果.ok, true)
  assert.equal(结果.action, 'schedule')
  assert.equal(结果.task.sessionId, 'session-abc')
  assert.equal(结果.task.delaySeconds, 30)
  assert.equal(结果.task.wakeText, '起来了')
  assert.match(结果.hint, /30 秒后重启/)
})

test('工具 schedule：不写延迟就用默认 60 秒', async (t) => {
  const { ctx } = 造插件(t)
  const 结果 = await 取工具(ctx).execute({ action: 'schedule' }, { agent: { id: 'session-x' } })
  assert.equal(结果.task.delaySeconds, 默认延迟秒)
})

test('工具 schedule：有其他会话在跑时提示先排队', async (t) => {
  const ctx = 造假ctx({ 会话状态: [['session-a', 'running'], ['session-b', 'running']] })
  const { 插件 } = 造插件(t, { ctx, 选项: { onFire: null } })
  const 结果 = await 取工具(ctx).execute({ action: 'schedule', delaySeconds: 15 }, { agent: { session: { id: 'session-a' } } })
  assert.equal(结果.phase, 'waiting')
  assert.equal(结果.busyCount, 2)
  assert.match(结果.hint, /排队/)
  assert.equal(插件.调度器.tasks.length, 1)
})

// ———————————————————————— 工具：cancel ————————————————————————

test('工具 cancel：没任务也没 taskId 时提示先 status', async (t) => {
  const { ctx } = 造插件(t)
  const 结果 = await 取工具(ctx).execute({ action: 'cancel' })
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'bad_request')
  assert.match(结果.hint, /status/)
})

test('工具 cancel：有任务没 taskId 时列出 id', async (t) => {
  const { ctx } = 造插件(t)
  const 工具 = 取工具(ctx)
  const 排 = await 工具.execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const 结果 = await 工具.execute({ action: 'cancel' })
  assert.equal(结果.ok, false)
  assert.match(结果.hint, new RegExp(排.task.id))
})

test('工具 cancel：taskId 不存在返回 not_found', async (t) => {
  const { ctx } = 造插件(t)
  const 结果 = await 取工具(ctx).execute({ action: 'cancel', taskId: 'restart-nope' })
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'not_found')
})

test('工具 cancel：取消成功并给会话注入反馈', async (t) => {
  const ctx = 造假ctx({ 会话状态: [['session-a', 'idle']] })
  const { ctx: 用ctx } = 造插件(t, { ctx })
  const 工具 = 取工具(用ctx)
  const 排 = await 工具.execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const 结果 = await 工具.execute({ action: 'cancel', taskId: 排.task.id }, { agent: { session: { id: 'session-a' } } })
  assert.equal(结果.ok, true)
  assert.equal(结果.已投递反馈, true)
  assert.equal(结果.剩余任务数, 0)
  assert.equal(用ctx.注入记录.length, 1)
  assert.equal(用ctx.注入记录[0].会话, 'session-a')
  assert.match(用ctx.注入记录[0].消息.content[0].text, /取消/)
})

test('工具 cancel：会话不在线时如实说反馈没送达', async (t) => {
  const { ctx } = 造插件(t)
  const 工具 = 取工具(ctx)
  const 排 = await 工具.execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-offline' } } })
  const 结果 = await 工具.execute({ action: 'cancel', taskId: 排.task.id })
  assert.equal(结果.ok, true)
  assert.equal(结果.已投递反馈, false)
  assert.match(结果.hint, /没送达/)
})

// ———————————————————————— 工具：参数校验 ————————————————————————

test('工具：缺少 action 返回 bad_request', async (t) => {
  const { ctx } = 造插件(t)
  const 结果 = await 取工具(ctx).execute({})
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'bad_request')
})

test('工具：未知 action 返回 bad_request', async (t) => {
  const { ctx } = 造插件(t)
  const 结果 = await 取工具(ctx).execute({ action: 'explode' })
  assert.equal(结果.ok, false)
  assert.match(结果.error, /不认识的动作/)
})

// ———————————————————————— 路由：state ————————————————————————

test('路由 state：GET 返回快照与常量', async (t) => {
  const { ctx } = 造插件(t)
  const res = await 调路由(ctx, '/state', 假请求('GET'))
  assert.equal(res.statusCode, 200)
  const 体 = JSON.parse(res.体)
  assert.equal(体.常量.弹框最小剩余秒, 弹框最小剩余秒)
  assert.equal(体.常量.默认延迟秒, 默认延迟秒)
  assert.equal(Array.isArray(体.tasks), true)
  assert.match(体.服务端时间, /^\d{4}-\d{2}-\d{2}T/)
})

test('路由 state：POST 回 405', async (t) => {
  const { ctx } = 造插件(t)
  const res = await 调路由(ctx, '/state', 假请求('POST'))
  assert.equal(res.statusCode, 405)
})

// ———————————————————————— 路由：pause / resume ————————————————————————

test('路由 pause：暂停后快照里 paused=true', async (t) => {
  const { ctx } = 造插件(t)
  await 取工具(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const res = await 调路由(ctx, '/pause', 假请求('POST'))
  assert.equal(res.statusCode, 200)
  const 体 = JSON.parse(res.体)
  assert.equal(体.已暂停, true)
})

test('路由 resume：恢复后 paused=false', async (t) => {
  const { ctx } = 造插件(t)
  await 取工具(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  await 调路由(ctx, '/pause', 假请求('POST'))
  const res = await 调路由(ctx, '/resume', 假请求('POST'))
  const 体 = JSON.parse(res.体)
  assert.equal(体.已暂停, false)
  assert.equal(体.变化, true)
})

test('路由 pause：GET 回 405', async (t) => {
  const { ctx } = 造插件(t)
  const res = await 调路由(ctx, '/pause', 假请求('GET'))
  assert.equal(res.statusCode, 405)
})

// ———————————————————————— 路由：cancel ————————————————————————

test('路由 cancel：缺 taskId 回 400', async (t) => {
  const { ctx } = 造插件(t)
  const res = await 调路由(ctx, '/cancel', 假请求('POST', '{}'))
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.体).code, 'bad_request')
})

test('路由 cancel：任务不存在回 404', async (t) => {
  const { ctx } = 造插件(t)
  const res = await 调路由(ctx, '/cancel', 假请求('POST', '{"taskId":"restart-none"}'))
  assert.equal(res.statusCode, 404)
})

test('路由 cancel：成功回 200 并注入反馈', async (t) => {
  const ctx = 造假ctx({ 会话状态: [['session-a', 'idle']] })
  const { ctx: 用ctx } = 造插件(t, { ctx })
  const 排 = await 取工具(用ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  const res = await 调路由(用ctx, '/cancel', 假请求('POST', JSON.stringify({ taskId: 排.task.id })))
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.体).已投递反馈, true)
  assert.equal(用ctx.注入记录.length, 1)
})

// ———————————————————————— 路由：dialog-open ————————————————————————

test('路由 dialog-open：剩余不足 5 秒的任务抬回 5 秒', async (t) => {
  const { ctx, 插件 } = 造插件(t)
  await 取工具(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  // 手工把任务剩余时间改成 2 秒，模拟倒计时快结束
  插件.调度器.tasks[0].remainingMs = 2000
  const res = await 调路由(ctx, '/dialog-open', 假请求('POST'))
  assert.equal(res.statusCode, 200)
  const 体 = JSON.parse(res.体)
  assert.equal(体.提升数量, 1)
  assert.equal(插件.调度器.tasks[0].remainingMs, 5000)
})

test('路由 dialog-open：≥5 秒的任务不动', async (t) => {
  const { ctx, 插件 } = 造插件(t)
  await 取工具(ctx).execute({ action: 'schedule', delaySeconds: 10 }, { agent: { session: { id: 'session-a' } } })
  插件.调度器.tasks[0].remainingMs = 8000
  const res = await 调路由(ctx, '/dialog-open', 假请求('POST'))
  const 体 = JSON.parse(res.体)
  assert.equal(体.提升数量, 0)
  assert.equal(插件.调度器.tasks[0].remainingMs, 8000)
})

// ———————————————————————— 持久化与开机恢复 ————————————————————————

test('装配：排任务后状态文件落盘且能读回', async (t) => {
  const { ctx, 插件 } = 造插件(t)
  await 取工具(ctx).execute({ action: 'schedule', delaySeconds: 25, reason: '持久化' }, { agent: { session: { id: 'session-a' } } })
  const 磁盘 = 读JSON(插件.状态文件)
  assert.notEqual(磁盘, null)
  assert.equal(磁盘.tasks.length, 1)
  assert.equal(磁盘.tasks[0].reason, '持久化')
})

test('装配：启动时从状态文件恢复任务', (t) => {
  const 目录 = 临时目录(t)
  const 状态文件 = path.join(目录, 'restart-scheduler.json')
  fs.writeFileSync(
    状态文件,
    JSON.stringify({
      版本: 1,
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
  const { 插件 } = 造插件(t, { 目录 })
  assert.equal(插件.调度器.tasks.length, 1)
  assert.equal(插件.调度器.tasks[0].id, 'restart-old')
  assert.equal(插件.调度器.tasks[0].remainingMs, 20000)
})

test('装配：上次重启已完成的记录会触发开机汇报', async (t) => {
  const 目录 = 临时目录(t)
  const ctx = 造假ctx({ 会话状态: [['session-a', 'idle']] })
  fs.writeFileSync(
    path.join(目录, 'restart-scheduler.json'),
    JSON.stringify({
      版本: 1,
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
        已汇报: false,
      },
    }),
    'utf8',
  )
  造插件(t, { ctx, 目录 })
  // 开机汇报延迟 10ms 后发出
  await new Promise((完成) => setTimeout(完成, 60))
  assert.equal(ctx.注入记录.length, 1)
  assert.match(ctx.注入记录[0].消息.content[0].text, /DSH 已重启完成/)
  const 磁盘 = 读JSON(path.join(目录, 'restart-scheduler.json'))
  assert.equal(磁盘.lastRestart.已汇报, true)
})

// ———————————————————————— 辅助函数 ————————————————————————

test('解析调用会话：按优先级取 session id', () => {
  assert.equal(解析调用会话({ agent: { session: { id: 's1' }, id: 'a1' } }), 's1')
  assert.equal(解析调用会话({ agent: { id: 'a1' } }), 'a1')
  assert.equal(解析调用会话({ sessionId: 's2' }), 's2')
  assert.equal(解析调用会话({}), '')
})

test('取忙碌会话：running 算忙，idle 与缺状态都不算', () => {
  const ctx = 造假ctx({
    会话状态: [
      ['session-a', 'running'],
      ['session-b', 'idle'],
      ['session-c', undefined],
    ],
  })
  const 忙碌 = 取忙碌会话(ctx, null)
  assert.deepEqual(忙碌.map((项) => 项.sessionId), ['session-a'])
})

test('取忙碌会话：没有 agents 服务时返回空（按空闲处理）', () => {
  assert.deepEqual(取忙碌会话({ get: () => undefined }, null), [])
})

test('会话标签：有标题用标题，没有就截 id', () => {
  const ctx = 造假ctx({ 标题: { 'session-abcdef123456': '修插件' } })
  assert.equal(会话标签(ctx, 'session-abcdef123456'), '修插件')
  assert.equal(会话标签(ctx, 'session-zzzzyyyyxxxx'), 'zzzzyyyy')
  assert.equal(会话标签(ctx, ''), '')
})

test('会话标签：sessionTitle 的 get 收会话对象，标题按 Session 换出来', () => {
  const ctx = 造假ctx({
    会话状态: [['session-live0001', 'running']],
    标题: { 'session-live0001': '大肥鱼聊天' },
  })
  assert.equal(会话标签(ctx, 'session-live0001'), '大肥鱼聊天')
})

test('会话标签：sessions 取不到时退回 agents 里的 session', () => {
  const agents = {
    get: (id) => (id === 'session-only-agent' ? { id: 'agent-x', session: { id } } : null),
  }
  const ctx = {
    get: (名) => {
      if (名 === 'agents') return agents
      if (名 === 'sessionTitle') return { get: (会话) => (会话.id === 'session-only-agent' ? '只有代理能拿到' : '') }
      return undefined
    },
  }
  assert.equal(会话标签(ctx, 'session-only-agent'), '只有代理能拿到')
})

// ———————————————————————— 系统提示（重启职责） ————————————————————————

/** 假日志：把每条记录收进数组，方便断言降级说明。 */
function 记录日志() {
  const 记录 = []
  const 收 = (级别) => (...参数) => { 记录.push({ 级别, 参数 }) }
  return { 记录, 日志: { info: 收('info'), warn: 收('warn'), error: 收('error') } }
}

test('系统提示：注入重启提示段，内容指向 dsh_restart', (t) => {
  const { ctx } = 造插件(t)
  assert.equal(ctx.提示段.length, 1)
  const 段 = ctx.提示段[0]
  assert.equal(段.name, 'dsh-restart-guidance')
  assert.equal(段.interpolate, false, '纯文本段要关掉 {{变量}} 插值')
  assert.equal(typeof 段.order, 'number')
  assert.equal(段.text, 重启提示文本)
  assert.match(段.text, /dsh_restart/)
  assert.match(段.text, /不要自己杀进程/)
  assert.match(段.text, /所有会话空闲/)
  // 不给具体的手动重启命令，也不写死端口/路径（插件会装在别人机器上）
  assert.doesNotMatch(段.text, /taskkill|Stop-Process|schtasks\s+\/create/i)
  assert.doesNotMatch(段.text, /[A-Za-z]:\\|\d+\.\d+\.\d+\.\d+|localhost:\d+/)
})

test('系统提示：systemPrompt 缺失时降级，工具照常注册', (t) => {
  const { 记录, 日志 } = 记录日志()
  const { ctx, 插件 } = 造插件(t, { ctx选项: { 系统提示: null }, 选项: { 日志 } })
  assert.equal(ctx.提示段.length, 0)
  assert.notEqual(取工具(ctx), undefined, 'dsh_restart 工具不受提示服务影响')
  assert.ok(插件, '装配不因缺服务而失败')
  assert.ok(
    记录.some((项) => 项.级别 === 'warn' && String(项.参数[0]).includes('systemPrompt')),
    '应在日志里说明降级原因',
  )
})

test('系统提示：读取服务本身抛错也不抛', () => {
  const { 记录, 日志 } = 记录日志()
  const 撤 = 注册重启提示({ get() { throw new Error('boom') } }, 日志)
  assert.equal(撤, null)
  assert.ok(记录.some((项) => 项.级别 === 'warn' && String(项.参数[0]).includes('boom')))
})

test('系统提示：重名注册说明已注入，按幂等跳过', (t) => {
  const { 记录, 日志 } = 记录日志()
  const 服务 = {
    section() {
      throw new Error('prompt section "dsh-restart-guidance" is already registered (for a per-agent override, register through that agent\'s agent.ctx instead)')
    },
  }
  const { ctx } = 造插件(t, { ctx选项: { 系统提示: 服务 }, 选项: { 日志 } })
  assert.equal(ctx.提示段.length, 0)
  assert.ok(记录.some((项) => 项.级别 === 'info' && String(项.参数[0]).includes('已注册')))
})

test('系统提示：注册抛别的错只记日志，不影响装配', (t) => {
  const { 记录, 日志 } = 记录日志()
  const 服务 = { section() { throw new Error('层已销毁') } }
  const { ctx } = 造插件(t, { ctx选项: { 系统提示: 服务 }, 选项: { 日志 } })
  assert.notEqual(取工具(ctx), undefined)
  assert.ok(记录.some((项) => 项.级别 === 'warn' && String(项.参数[0]).includes('层已销毁')))
})

test('系统提示：插件停止时撤销提示段', (t) => {
  const { ctx, 插件 } = 造插件(t)
  assert.equal(ctx.提示段.length, 1)
  插件.停止()
  assert.equal(ctx.提示段.length, 0, '停止后不应残留提示段')
})

