// 调度状态机测试：假时钟 / 假会话 / 假触发，绝不真的重启。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RestartScheduler,
  normalizeDelaySeconds,
  generateTaskId,
  taskSummary,
  cancelFeedbackText,
  normalizeTaskList,
} from '../lib/scheduler.js'
import {
  defaultDelaySeconds,
  minDelaySeconds,
  maxDelaySeconds,
  dialogMinRemainingSeconds,
  restartConfirmTimeoutMs,
} from '../lib/constants.js'
import { makeScheduler, makeClock, setBusy, scheduleTask } from './helpers.js'

test('规范延迟秒：默认 60', () => {
  assert.equal(normalizeDelaySeconds(undefined), defaultDelaySeconds)
  assert.equal(normalizeDelaySeconds('abc'), defaultDelaySeconds)
})

test('规范延迟秒：低于 10 夹到 10', () => {
  assert.equal(normalizeDelaySeconds(1), minDelaySeconds)
  assert.equal(normalizeDelaySeconds(-100), minDelaySeconds)
})

test('规范延迟秒：高于 3600 夹到 3600', () => {
  assert.equal(normalizeDelaySeconds(999999), maxDelaySeconds)
})

test('规范延迟秒：四舍五入并保留合法值', () => {
  assert.equal(normalizeDelaySeconds(59.6), 60)
  assert.equal(normalizeDelaySeconds('120'), 120)
})

test('生成任务Id 带 restart- 前缀且不重复', () => {
  const firstId = generateTaskId()
  const secondId = generateTaskId()
  assert.match(firstId, /^restart-/)
  assert.notEqual(firstId, secondId)
})

test('任务摘要：未开始的任务 remaining 为 null、状态 waiting', () => {
  const summary = taskSummary({ id: 't', sessionId: 's', delaySeconds: 30, status: 'waiting', remainingMs: null })
  assert.equal(summary.started, false)
  assert.equal(summary.remainingMs, null)
  assert.equal(summary.remainingSeconds, null)
  assert.equal(summary.delaySeconds, 30)
})

test('任务摘要：倒计时中 remainingSeconds 向上取整', () => {
  const summary = taskSummary({ id: 't', sessionId: 's', delaySeconds: 30, remainingMs: 4200 })
  assert.equal(summary.started, true)
  assert.equal(summary.remainingSeconds, 5)
})

test('任务摘要：坏输入返回 null', () => {
  assert.equal(taskSummary(null), null)
  assert.equal(taskSummary('x'), null)
})

test('规范化任务列表：非数组返回空', () => {
  assert.deepEqual(normalizeTaskList(null), [])
  assert.deepEqual(normalizeTaskList({}), [])
})

test('规范化任务列表：丢掉坏任务、按 id 去重', () => {
  const result = normalizeTaskList([
    null,
    {},
    { id: 'a', sessionId: 's1', delaySeconds: 10 },
    { id: 'a', sessionId: 's2', delaySeconds: 10 },
    { id: 'b', sessionId: 's3', delaySeconds: 20, remainingMs: 3000 },
  ])
  assert.equal(result.length, 2)
  assert.equal(result[0].id, 'a')
  assert.equal(result[1].status, 'counting')
  assert.equal(result[1].remainingMs, 3000)
})

test('取消反馈文本：带前缀、剩余时间与备注', () => {
  const text = cancelFeedbackText({ remainingMs: 8000, reason: '测试' })
  assert.match(text, /（重启调度）/)
  assert.match(text, /8 秒/)
  assert.match(text, /测试/)
})

test('取消反馈文本：没开始倒计时时说清楚', () => {
  assert.match(cancelFeedbackText({ remainingMs: null }), /还没开始倒计时/)
})

test('排任务：默认进入 waiting', () => {
  const { scheduler } = makeScheduler()
  const result = scheduleTask(scheduler)
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'waiting')
  assert.equal(scheduler.snapshot().taskCount, 1)
  assert.equal(result.task.remainingMs, null)
})

test('等空闲：有会话在跑时排队等待，倒计时不走', async () => {
  const context = makeScheduler()
  setBusy(context, ['session-busy'])
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  assert.equal(context.scheduler.phase, 'waiting')
  assert.equal(context.scheduler.tasks[0].remainingMs, null)
  context.clock.advance(60000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.tasks[0].remainingMs, null)
})

test('全部空闲后才开始倒计时', async () => {
  const context = makeScheduler({ busy: [{ sessionId: 'session-busy', status: 'running' }] })
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  assert.equal(context.scheduler.phase, 'waiting')
  setBusy(context, [])
  await context.scheduler.tick()
  assert.equal(context.scheduler.phase, 'countdown')
  assert.equal(context.scheduler.tasks[0].remainingMs, 10000)
})

test('倒计时按流逝时间递减', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(3000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.tasks[0].remainingMs, 7000)
  context.clock.advance(2000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.tasks[0].remainingMs, 5000)
})

test('到点触发重启，并且只触发一次', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(10000)
  await context.scheduler.tick()
  assert.equal(context.record.fire.length, 1)
  assert.equal(context.scheduler.tasks.length, 0)
  assert.equal(context.scheduler.phase, 'firing')
  await context.scheduler.tick()
  assert.equal(context.record.fire.length, 1)
})

test('触发载荷带上任务与会话（去重）', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { sessionId: 's1', delaySeconds: 10 })
  scheduleTask(context.scheduler, { sessionId: 's1', delaySeconds: 10 })
  scheduleTask(context.scheduler, { sessionId: 's2', delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(10000)
  await context.scheduler.tick()
  const payload = context.record.fire[0]
  assert.equal(payload.tasks.length, 3)
  assert.deepEqual(payload.sessionIds.sort(), ['s1', 's2'])
})

test('多任务各自倒计时，最短的先到点并一起触发', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { sessionId: 's1', delaySeconds: 10 })
  scheduleTask(context.scheduler, { sessionId: 's2', delaySeconds: 30 })
  await context.scheduler.tick()
  assert.deepEqual(
    context.scheduler.tasks.map((task) => task.remainingMs),
    [10000, 30000],
  )
  context.clock.advance(10000)
  await context.scheduler.tick()
  assert.equal(context.record.fire.length, 1)
  assert.equal(context.record.fire[0].tasks.length, 2)
  assert.equal(context.scheduler.tasks.length, 0)
})

test('倒计时中新增任务也会开始自己的倒计时', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { sessionId: 's1', delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(2000)
  scheduleTask(context.scheduler, { sessionId: 's2', delaySeconds: 60 })
  await context.scheduler.tick()
  const remaining = context.scheduler.tasks.map((task) => task.remainingMs)
  assert.deepEqual(remaining, [8000, 60000])
})

test('取消任务会注入反馈（已送达）', async () => {
  const context = makeScheduler()
  const result = scheduleTask(context.scheduler)
  const cancelResult = context.scheduler.cancelTask(result.task.id, { source: 'panel' })
  assert.equal(cancelResult.ok, true)
  assert.equal(cancelResult.feedbackDelivered, true)
  assert.equal(context.record.inject.length, 1)
  assert.equal(context.record.inject[0].session, 'session-a')
  assert.match(context.record.inject[0].text, /已取消/)
})

test('取消最后一个任务后回到 idle', async () => {
  const context = makeScheduler()
  const result = scheduleTask(context.scheduler)
  context.scheduler.cancelTask(result.task.id)
  assert.equal(context.scheduler.phase, 'idle')
  assert.equal(context.scheduler.tasks.length, 0)
})

test('取消不存在的任务返回 not_found', () => {
  const { scheduler } = makeScheduler()
  const result = scheduler.cancelTask('restart-nope')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_found')
})

test('会话离线时取消反馈标记为未送达', () => {
  const context = makeScheduler({ injectOk: false })
  const result = scheduleTask(context.scheduler)
  const cancelResult = context.scheduler.cancelTask(result.task.id)
  assert.equal(cancelResult.ok, true)
  assert.equal(cancelResult.feedbackDelivered, false)
})

test('排队等待期间取消不会触发重启', async () => {
  const context = makeScheduler({ busy: [{ sessionId: 'busy', status: 'running' }] })
  const result = scheduleTask(context.scheduler)
  await context.scheduler.tick()
  context.scheduler.cancelTask(result.task.id)
  context.clock.advance(100000)
  await context.scheduler.tick()
  assert.equal(context.record.fire.length, 0)
})

test('暂停期间倒计时不再减少', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(1000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.tasks[0].remainingMs, 9000)
  context.scheduler.pause('mouse')
  context.clock.advance(500)
  context.scheduler.pause('mouse')
  context.clock.advance(500)
  await context.scheduler.tick()
  assert.equal(context.scheduler.phase, 'paused')
  assert.equal(context.scheduler.tasks[0].remainingMs, 9000)
})

test('暂停时即使时间过了很久也不触发', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  context.scheduler.pause('mouse')
  context.clock.advance(60000)
  await context.scheduler.tick()
  assert.equal(context.record.fire.length, 0)
  assert.equal(context.scheduler.tasks.length, 1)
})

test('停止移动 1 秒后自动恢复', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  context.scheduler.pause('mouse')
  context.clock.advance(1000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.paused, null)
  assert.equal(context.scheduler.phase, 'countdown')
})

test('恢复后继续倒计时，暂停的时间不补扣', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(1000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.tasks[0].remainingMs, 9000)
  context.scheduler.pause('mouse')
  context.clock.advance(5000)
  context.scheduler.resume('mouse')
  context.clock.advance(2000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.tasks[0].remainingMs, 7000)
})

test('暂停会刷新最近鼠标信号时间（连续移动不会提前恢复）', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(500)
  context.scheduler.pause('mouse')
  context.clock.advance(700)
  context.scheduler.pause('mouse')
  context.clock.advance(900)
  await context.scheduler.tick()
  assert.notEqual(context.scheduler.paused, null)
})

test('没有任务时暂停不生效', () => {
  const { scheduler } = makeScheduler()
  const result = scheduler.pause('mouse')
  assert.equal(result.paused, false)
  assert.equal(scheduler.paused, null)
})

test('打开对话框：剩余不足 5 秒抬回 5 秒', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(8000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.tasks[0].remainingMs, 2000)
  const result = context.scheduler.openDialog()
  assert.equal(result.raisedCount, 1)
  assert.equal(context.scheduler.tasks[0].remainingMs, dialogMinRemainingSeconds * 1000)
})

test('打开对话框：正好 5 秒不动', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(5000)
  await context.scheduler.tick()
  const result = context.scheduler.openDialog()
  assert.equal(result.raisedCount, 0)
  assert.equal(context.scheduler.tasks[0].remainingMs, 5000)
})

test('打开对话框：大于 5 秒不动', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 30 })
  await context.scheduler.tick()
  context.clock.advance(5000)
  await context.scheduler.tick()
  const result = context.scheduler.openDialog()
  assert.equal(result.raisedCount, 0)
  assert.equal(context.scheduler.tasks[0].remainingMs, 25000)
})

test('打开对话框：还没开始倒计时的任务不动', async () => {
  const context = makeScheduler({ busy: [{ sessionId: 'busy', status: 'running' }] })
  scheduleTask(context.scheduler)
  const result = context.scheduler.openDialog()
  assert.equal(result.raisedCount, 0)
  assert.equal(context.scheduler.tasks[0].remainingMs, null)
})

test('触发失败时 fail-open：清任务、记 fire-failed、给会话注入失败反馈', async () => {
  const context = makeScheduler({
    onFire: async () => {
      throw new Error('计划任务起不来')
    },
  })
  scheduleTask(context.scheduler, { sessionId: 's1', delaySeconds: 10 })
  await context.scheduler.tick()
  context.clock.advance(10000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.phase, 'idle')
  assert.equal(context.scheduler.tasks.length, 0)
  assert.equal(context.scheduler.lastRestart.status, 'fire-failed')
  assert.equal(context.scheduler.firing, false)
  assert.equal(context.record.inject.length, 1)
  assert.match(context.record.inject[0].text, /重启触发失败/)
})

test('触发成功会记录脚本路径与触发方式', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler)
  await context.scheduler.tick()
  context.clock.advance(10000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.lastRestart.status, 'firing')
  assert.equal(context.scheduler.lastRestart.fired, true)
  assert.equal(context.scheduler.lastRestart.scriptPath, 'C:\\fake\\restart.ps1')
  assert.equal(context.scheduler.lastRestart.launcher, 'schtasks')
})

test('初始化：从磁盘恢复任务', () => {
  const context = makeScheduler({
    state: {
      tasks: [
        { id: 'restart-a', sessionId: 's1', delaySeconds: 20, remainingMs: 7000 },
        { id: 'restart-b', sessionId: 's2', delaySeconds: 30 },
      ],
    },
  })
  context.scheduler.init()
  assert.equal(context.scheduler.tasks.length, 2)
  assert.equal(context.scheduler.tasks[0].remainingMs, 7000)
  assert.equal(context.scheduler.tasks[1].remainingMs, null)
  assert.equal(context.scheduler.phase, 'waiting')
})

test('初始化：旧版中文键状态文件仍能恢复任务', () => {
  // 旧版本把状态文件的键写成中文；升级后第一次启动必须还能读出来，否则排队任务会丢。
  const context = makeScheduler({
    state: {
      version: undefined,
      插件: 'dsh-restart-plugin',
      版本: 1,
      tasks: [{ id: 'restart-a', sessionId: 's1', delaySeconds: 30 }],
      lastRestart: { id: 'r1', status: 'restarted', 已汇报: true, 唤醒事件数: 2, 触发方式: 'schtasks' },
    },
  })
  context.scheduler.init()
  assert.equal(context.scheduler.stateIncompatible, false)
  assert.equal(context.scheduler.tasks.length, 1)
  assert.equal(context.scheduler.lastRestart.reported, true)
  assert.equal(context.scheduler.lastRestart.wakeCount, 2)
  assert.equal(context.scheduler.lastRestart.launcher, 'schtasks')
  assert.equal(context.getDiskState().version, 1)
})

test('初始化：有 restarted 标记时把上次重启记为已重启', () => {
  const context = makeScheduler({
    state: { tasks: [], lastRestart: { id: 'r1', status: 'firing', sessionIds: ['s1'] } },
    marker: { status: 'restarted', ready: true, ports: [6067] },
  })
  context.scheduler.init()
  assert.equal(context.scheduler.lastRestart.status, 'restarted')
  assert.equal(context.scheduler.lastRestart.ready, true)
  assert.equal(context.scheduler.bootRecord.confirmed, true)
})

test('初始化：标记是 started 时记为未确认', () => {
  const context = makeScheduler({
    state: { tasks: [], lastRestart: { id: 'r1', status: 'firing' } },
    marker: { status: 'started' },
  })
  context.scheduler.init()
  assert.equal(context.scheduler.lastRestart.status, 'restarted-unconfirmed')
})

test('初始化：没有标记时记为 unknown', () => {
  const context = makeScheduler({
    state: { tasks: [], lastRestart: { id: 'r1', status: 'firing' } },
    marker: null,
  })
  context.scheduler.init()
  assert.equal(context.scheduler.lastRestart.status, 'unknown')
})

test('初始化：标记 launch-failed 时保留失败原因', () => {
  const context = makeScheduler({
    state: { tasks: [], lastRestart: { id: 'r1', status: 'firing' } },
    marker: { status: 'launch-failed' },
  })
  context.scheduler.init()
  assert.equal(context.scheduler.lastRestart.status, 'launch-failed')
})

test('初始化：标记 restarted 但未就绪不算重启成功', () => {
  const context = makeScheduler({
    state: { tasks: [], lastRestart: { id: 'r1', status: 'firing' } },
    marker: { status: 'restarted', ready: false, ports: [] },
  })
  context.scheduler.init()
  assert.equal(context.scheduler.lastRestart.status, 'restarted-unconfirmed')
  assert.equal(context.scheduler.bootRecord.confirmed, false)
})

test('初始化：标记 stop-failed 时记为停不掉旧实例', () => {
  const context = makeScheduler({
    state: { tasks: [], lastRestart: { id: 'r1', status: 'firing' } },
    marker: { status: 'stop-failed' },
  })
  context.scheduler.init()
  assert.equal(context.scheduler.lastRestart.status, 'stop-failed')
})

test('初始化：状态文件版本不匹配时不恢复也不覆盖', () => {
  const state = { version: 0, tasks: [{ id: 'restart-a', sessionId: 's1', delaySeconds: 20 }] }
  const context = makeScheduler({ state })
  context.scheduler.init()
  assert.equal(context.scheduler.stateIncompatible, true)
  assert.equal(context.scheduler.tasks.length, 0)
  assert.equal(context.record.persist.length, 0)
  assert.equal(context.getDiskState().version, 0)
  assert.equal(context.getDiskState().tasks.length, 1)
})

test('重启确认：超时后复位 firing 并通知排过任务的会话', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler)
  await context.scheduler.fire(0)
  assert.equal(context.scheduler.firing, true)
  assert.equal(context.scheduler.lastRestart.firingStartedAt, 0)

  context.clock.advance(restartConfirmTimeoutMs)
  const result = await context.scheduler.tick()
  assert.equal(result.timedOut, true)
  assert.equal(context.scheduler.firing, false)
  assert.equal(context.scheduler.phase, 'idle')
  assert.equal(context.scheduler.lastRestart.status, 'firing-timeout')
  assert.equal(context.record.inject.length, 1)
  assert.match(context.record.inject[0].text, /重启确认超时/)
})

test('重启确认：未到超时仍保持 firing', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler)
  await context.scheduler.fire(0)
  context.clock.advance(restartConfirmTimeoutMs - 1)
  const result = await context.scheduler.tick()
  assert.equal(result.phase, 'firing')
  assert.equal(context.scheduler.firing, true)
})

test('落盘：倒计时中按间隔节流，不每次都写', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler)
  await context.scheduler.tick()
  const round = context.record.persist.length
  context.clock.advance(100)
  await context.scheduler.tick()
  assert.equal(context.record.persist.length, round)
  context.clock.advance(6000)
  await context.scheduler.tick()
  assert.ok(context.record.persist.length > round)
})

test('快照字段齐全，最近剩余时间正确', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler, { delaySeconds: 20 })
  scheduleTask(context.scheduler, { delaySeconds: 40 })
  await context.scheduler.tick()
  const snapshot = context.scheduler.snapshot()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.taskCount, 2)
  assert.equal(snapshot.busyCount, 0)
  assert.equal(snapshot.nearestRemainingMs, 20000)
  assert.equal(snapshot.nearestRemainingSeconds, 20)
  assert.equal(snapshot.tasks[0].sessionLabel, '会话 A')
})

test('重启中 getter 跟随 firing', async () => {
  const context = makeScheduler()
  assert.equal(context.scheduler.restarting, false)
  scheduleTask(context.scheduler)
  await context.scheduler.tick()
  context.clock.advance(10000)
  await context.scheduler.tick()
  assert.equal(context.scheduler.restarting, true)
})

test('没有任务时 tick 保持 idle', async () => {
  const context = makeScheduler()
  const result = await context.scheduler.tick()
  assert.equal(result.phase, 'idle')
  assert.equal(context.scheduler.phase, 'idle')
})

test('坏会话数据不会让调度器崩', async () => {
  const context = makeScheduler()
  context.busy.list = null
  scheduleTask(context.scheduler)
  const result = await context.scheduler.tick()
  assert.equal(result.ok, true)
  assert.equal(context.scheduler.tasks[0].remainingMs, 10000)
})

test('立即重启：有会话在跑也直接触发，不等空闲与倒计时', async () => {
  const context = makeScheduler()
  setBusy(context, ['session-a'])
  scheduleTask(context.scheduler, { sessionId: 'session-a' })
  await context.scheduler.tick()
  assert.equal(context.scheduler.phase, 'waiting')
  const result = await context.scheduler.restartNow()
  assert.equal(result.ok, true)
  assert.equal(result.immediate, true)
  assert.equal(context.record.fire.length, 1)
  assert.deepEqual(context.record.fire[0].sessionIds, ['session-a'])
  assert.equal(context.scheduler.tasks.length, 0)
})

test('立即重启：没有任务时拒绝', async () => {
  const context = makeScheduler()
  const result = await context.scheduler.restartNow()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_tasks')
})

test('立即重启：已经在重启时拒绝', async () => {
  const context = makeScheduler()
  scheduleTask(context.scheduler)
  context.scheduler.firing = true
  const result = await context.scheduler.restartNow()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'firing')
})

test('立即重启：触发失败时返回错误、清空任务并记 fire-failed', async () => {
  const context = makeScheduler({ onFire: async () => ({ ok: false, error: 'boom' }) })
  scheduleTask(context.scheduler)
  const result = await context.scheduler.restartNow()
  assert.equal(result.ok, false)
  assert.equal(context.scheduler.tasks.length, 0)
  assert.equal(context.scheduler.lastRestart.status, 'fire-failed')
})

test('时钟工具：假时钟可推进', () => {
  const clock = makeClock(1000)
  assert.equal(clock.now(), 1000)
  clock.advance(500)
  assert.equal(clock.now(), 1500)
})
