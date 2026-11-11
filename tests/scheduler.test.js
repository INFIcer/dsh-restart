// 调度状态机测试：假时钟 / 假会话 / 假触发，绝不真的重启。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  重启调度器,
  规范延迟秒,
  生成任务Id,
  任务摘要,
  取消反馈文本,
  规范化任务列表,
} from '../lib/scheduler.js'
import { 默认延迟秒, 最小延迟秒, 最大延迟秒, 弹框最小剩余秒 } from '../lib/constants.js'
import { 造调度器, 造时钟, 设忙碌, 排任务 } from './helpers.js'

test('规范延迟秒：默认 60', () => {
  assert.equal(规范延迟秒(undefined), 默认延迟秒)
  assert.equal(规范延迟秒('abc'), 默认延迟秒)
})

test('规范延迟秒：低于 10 夹到 10', () => {
  assert.equal(规范延迟秒(1), 最小延迟秒)
  assert.equal(规范延迟秒(-100), 最小延迟秒)
})

test('规范延迟秒：高于 3600 夹到 3600', () => {
  assert.equal(规范延迟秒(999999), 最大延迟秒)
})

test('规范延迟秒：四舍五入并保留合法值', () => {
  assert.equal(规范延迟秒(59.6), 60)
  assert.equal(规范延迟秒('120'), 120)
})

test('生成任务Id 带 restart- 前缀且不重复', () => {
  const 一 = 生成任务Id()
  const 二 = 生成任务Id()
  assert.match(一, /^restart-/)
  assert.notEqual(一, 二)
})

test('任务摘要：未开始的任务 remaining 为 null、状态 waiting', () => {
  const 摘要 = 任务摘要({ id: 't', sessionId: 's', delaySeconds: 30, status: 'waiting', remainingMs: null })
  assert.equal(摘要.started, false)
  assert.equal(摘要.remainingMs, null)
  assert.equal(摘要.remainingSeconds, null)
  assert.equal(摘要.delaySeconds, 30)
})

test('任务摘要：倒计时中 remainingSeconds 向上取整', () => {
  const 摘要 = 任务摘要({ id: 't', sessionId: 's', delaySeconds: 30, remainingMs: 4200 })
  assert.equal(摘要.started, true)
  assert.equal(摘要.remainingSeconds, 5)
})

test('任务摘要：坏输入返回 null', () => {
  assert.equal(任务摘要(null), null)
  assert.equal(任务摘要('x'), null)
})

test('规范化任务列表：非数组返回空', () => {
  assert.deepEqual(规范化任务列表(null), [])
  assert.deepEqual(规范化任务列表({}), [])
})

test('规范化任务列表：丢掉坏任务、按 id 去重', () => {
  const 结果 = 规范化任务列表([
    null,
    {},
    { id: 'a', sessionId: 's1', delaySeconds: 10 },
    { id: 'a', sessionId: 's2', delaySeconds: 10 },
    { id: 'b', sessionId: 's3', delaySeconds: 20, remainingMs: 3000 },
  ])
  assert.equal(结果.length, 2)
  assert.equal(结果[0].id, 'a')
  assert.equal(结果[1].status, 'counting')
  assert.equal(结果[1].remainingMs, 3000)
})

test('取消反馈文本：带前缀、剩余时间与备注', () => {
  const 文本 = 取消反馈文本({ remainingMs: 8000, reason: '测试' })
  assert.match(文本, /（重启调度）/)
  assert.match(文本, /8 秒/)
  assert.match(文本, /测试/)
})

test('取消反馈文本：没开始倒计时时说清楚', () => {
  assert.match(取消反馈文本({ remainingMs: null }), /还没开始倒计时/)
})

test('排任务：默认进入 waiting', () => {
  const { 调度器 } = 造调度器()
  const 结果 = 排任务(调度器)
  assert.equal(结果.ok, true)
  assert.equal(结果.阶段, 'waiting')
  assert.equal(调度器.快照().taskCount, 1)
  assert.equal(结果.任务.remainingMs, null)
})

test('等空闲：有会话在跑时排队等待，倒计时不走', async () => {
  const 上下文 = 造调度器()
  设忙碌(上下文, ['session-busy'])
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.phase, 'waiting')
  assert.equal(上下文.调度器.tasks[0].remainingMs, null)
  上下文.时钟.走(60000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.tasks[0].remainingMs, null)
})

test('全部空闲后才开始倒计时', async () => {
  const 上下文 = 造调度器({ 忙碌: [{ sessionId: 'session-busy', status: 'running' }] })
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.phase, 'waiting')
  设忙碌(上下文, [])
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.phase, 'countdown')
  assert.equal(上下文.调度器.tasks[0].remainingMs, 10000)
})

test('倒计时按流逝时间递减', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(3000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.tasks[0].remainingMs, 7000)
  上下文.时钟.走(2000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.tasks[0].remainingMs, 5000)
})

test('到点触发重启，并且只触发一次', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(10000)
  await 上下文.调度器.tick()
  assert.equal(上下文.记录.触发.length, 1)
  assert.equal(上下文.调度器.tasks.length, 0)
  assert.equal(上下文.调度器.phase, 'firing')
  await 上下文.调度器.tick()
  assert.equal(上下文.记录.触发.length, 1)
})

test('触发载荷带上任务与会话（去重）', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { sessionId: 's1', delaySeconds: 10 })
  排任务(上下文.调度器, { sessionId: 's1', delaySeconds: 10 })
  排任务(上下文.调度器, { sessionId: 's2', delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(10000)
  await 上下文.调度器.tick()
  const 载荷 = 上下文.记录.触发[0]
  assert.equal(载荷.tasks.length, 3)
  assert.deepEqual(载荷.sessionIds.sort(), ['s1', 's2'])
})

test('多任务各自倒计时，最短的先到点并一起触发', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { sessionId: 's1', delaySeconds: 10 })
  排任务(上下文.调度器, { sessionId: 's2', delaySeconds: 30 })
  await 上下文.调度器.tick()
  assert.deepEqual(
    上下文.调度器.tasks.map((任务) => 任务.remainingMs),
    [10000, 30000],
  )
  上下文.时钟.走(10000)
  await 上下文.调度器.tick()
  assert.equal(上下文.记录.触发.length, 1)
  assert.equal(上下文.记录.触发[0].tasks.length, 2)
  assert.equal(上下文.调度器.tasks.length, 0)
})

test('倒计时中新增任务也会开始自己的倒计时', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { sessionId: 's1', delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(2000)
  排任务(上下文.调度器, { sessionId: 's2', delaySeconds: 60 })
  await 上下文.调度器.tick()
  const 剩余 = 上下文.调度器.tasks.map((任务) => 任务.remainingMs)
  assert.deepEqual(剩余, [8000, 60000])
})

test('取消任务会注入反馈（已送达）', async () => {
  const 上下文 = 造调度器()
  const 结果 = 排任务(上下文.调度器)
  const 取消 = 上下文.调度器.取消任务(结果.任务.id, { source: 'panel' })
  assert.equal(取消.ok, true)
  assert.equal(取消.已投递反馈, true)
  assert.equal(上下文.记录.注入.length, 1)
  assert.equal(上下文.记录.注入[0].会话, 'session-a')
  assert.match(上下文.记录.注入[0].文本, /已取消/)
})

test('取消最后一个任务后回到 idle', async () => {
  const 上下文 = 造调度器()
  const 结果 = 排任务(上下文.调度器)
  上下文.调度器.取消任务(结果.任务.id)
  assert.equal(上下文.调度器.phase, 'idle')
  assert.equal(上下文.调度器.tasks.length, 0)
})

test('取消不存在的任务返回 not_found', () => {
  const { 调度器 } = 造调度器()
  const 结果 = 调度器.取消任务('restart-nope')
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'not_found')
})

test('会话离线时取消反馈标记为未送达', () => {
  const 上下文 = 造调度器({ 注入成功: false })
  const 结果 = 排任务(上下文.调度器)
  const 取消 = 上下文.调度器.取消任务(结果.任务.id)
  assert.equal(取消.ok, true)
  assert.equal(取消.已投递反馈, false)
})

test('排队等待期间取消不会触发重启', async () => {
  const 上下文 = 造调度器({ 忙碌: [{ sessionId: 'busy', status: 'running' }] })
  const 结果 = 排任务(上下文.调度器)
  await 上下文.调度器.tick()
  上下文.调度器.取消任务(结果.任务.id)
  上下文.时钟.走(100000)
  await 上下文.调度器.tick()
  assert.equal(上下文.记录.触发.length, 0)
})

test('暂停期间倒计时不再减少', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(1000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.tasks[0].remainingMs, 9000)
  上下文.调度器.暂停('mouse')
  上下文.时钟.走(500)
  上下文.调度器.暂停('mouse')
  上下文.时钟.走(500)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.phase, 'paused')
  assert.equal(上下文.调度器.tasks[0].remainingMs, 9000)
})

test('暂停时即使时间过了很久也不触发', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.调度器.暂停('mouse')
  上下文.时钟.走(60000)
  await 上下文.调度器.tick()
  assert.equal(上下文.记录.触发.length, 0)
  assert.equal(上下文.调度器.tasks.length, 1)
})

test('停止移动 1 秒后自动恢复', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.调度器.暂停('mouse')
  上下文.时钟.走(1000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.paused, null)
  assert.equal(上下文.调度器.phase, 'countdown')
})

test('恢复后继续倒计时，暂停的时间不补扣', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(1000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.tasks[0].remainingMs, 9000)
  上下文.调度器.暂停('mouse')
  上下文.时钟.走(5000)
  上下文.调度器.恢复('mouse')
  上下文.时钟.走(2000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.tasks[0].remainingMs, 7000)
})

test('暂停会刷新最近鼠标信号时间（连续移动不会提前恢复）', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(500)
  上下文.调度器.暂停('mouse')
  上下文.时钟.走(700)
  上下文.调度器.暂停('mouse')
  上下文.时钟.走(900)
  await 上下文.调度器.tick()
  assert.notEqual(上下文.调度器.paused, null)
})

test('没有任务时暂停不生效', () => {
  const { 调度器 } = 造调度器()
  const 结果 = 调度器.暂停('mouse')
  assert.equal(结果.已暂停, false)
  assert.equal(调度器.paused, null)
})

test('打开对话框：剩余不足 5 秒抬回 5 秒', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(8000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.tasks[0].remainingMs, 2000)
  const 结果 = 上下文.调度器.打开对话框()
  assert.equal(结果.提升数量, 1)
  assert.equal(上下文.调度器.tasks[0].remainingMs, 弹框最小剩余秒 * 1000)
})

test('打开对话框：正好 5 秒不动', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(5000)
  await 上下文.调度器.tick()
  const 结果 = 上下文.调度器.打开对话框()
  assert.equal(结果.提升数量, 0)
  assert.equal(上下文.调度器.tasks[0].remainingMs, 5000)
})

test('打开对话框：大于 5 秒不动', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 30 })
  await 上下文.调度器.tick()
  上下文.时钟.走(5000)
  await 上下文.调度器.tick()
  const 结果 = 上下文.调度器.打开对话框()
  assert.equal(结果.提升数量, 0)
  assert.equal(上下文.调度器.tasks[0].remainingMs, 25000)
})

test('打开对话框：还没开始倒计时的任务不动', async () => {
  const 上下文 = 造调度器({ 忙碌: [{ sessionId: 'busy', status: 'running' }] })
  排任务(上下文.调度器)
  const 结果 = 上下文.调度器.打开对话框()
  assert.equal(结果.提升数量, 0)
  assert.equal(上下文.调度器.tasks[0].remainingMs, null)
})

test('触发失败时 fail-open：清任务、记 fire-failed、给会话注入失败反馈', async () => {
  const 上下文 = 造调度器({
    onFire: async () => {
      throw new Error('计划任务起不来')
    },
  })
  排任务(上下文.调度器, { sessionId: 's1', delaySeconds: 10 })
  await 上下文.调度器.tick()
  上下文.时钟.走(10000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.phase, 'idle')
  assert.equal(上下文.调度器.tasks.length, 0)
  assert.equal(上下文.调度器.lastRestart.status, 'fire-failed')
  assert.equal(上下文.调度器.firing, false)
  assert.equal(上下文.记录.注入.length, 1)
  assert.match(上下文.记录.注入[0].文本, /重启触发失败/)
})

test('触发成功会记录脚本路径与触发方式', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器)
  await 上下文.调度器.tick()
  上下文.时钟.走(10000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.lastRestart.status, 'firing')
  assert.equal(上下文.调度器.lastRestart.已触发, true)
  assert.equal(上下文.调度器.lastRestart.scriptPath, 'C:\\fake\\restart.ps1')
  assert.equal(上下文.调度器.lastRestart.触发方式, 'schtasks')
})

test('初始化：从磁盘恢复任务', () => {
  const 上下文 = 造调度器({
    状态: {
      tasks: [
        { id: 'restart-a', sessionId: 's1', delaySeconds: 20, remainingMs: 7000 },
        { id: 'restart-b', sessionId: 's2', delaySeconds: 30 },
      ],
    },
  })
  上下文.调度器.初始化()
  assert.equal(上下文.调度器.tasks.length, 2)
  assert.equal(上下文.调度器.tasks[0].remainingMs, 7000)
  assert.equal(上下文.调度器.tasks[1].remainingMs, null)
  assert.equal(上下文.调度器.phase, 'waiting')
})

test('初始化：有 restarted 标记时把上次重启记为已重启', () => {
  const 上下文 = 造调度器({
    状态: { tasks: [], lastRestart: { id: 'r1', status: 'firing', sessionIds: ['s1'] } },
    标记: { status: 'restarted', ready: true, ports: [6067] },
  })
  上下文.调度器.初始化()
  assert.equal(上下文.调度器.lastRestart.status, 'restarted')
  assert.equal(上下文.调度器.lastRestart.ready, true)
  assert.equal(上下文.调度器.已启动记录.confirmed, true)
})

test('初始化：标记是 started 时记为未确认', () => {
  const 上下文 = 造调度器({
    状态: { tasks: [], lastRestart: { id: 'r1', status: 'firing' } },
    标记: { status: 'started' },
  })
  上下文.调度器.初始化()
  assert.equal(上下文.调度器.lastRestart.status, 'restarted-unconfirmed')
})

test('初始化：没有标记时记为 unknown', () => {
  const 上下文 = 造调度器({
    状态: { tasks: [], lastRestart: { id: 'r1', status: 'firing' } },
    标记: null,
  })
  上下文.调度器.初始化()
  assert.equal(上下文.调度器.lastRestart.status, 'unknown')
})

test('初始化：标记 launch-failed 时保留失败原因', () => {
  const 上下文 = 造调度器({
    状态: { tasks: [], lastRestart: { id: 'r1', status: 'firing' } },
    标记: { status: 'launch-failed' },
  })
  上下文.调度器.初始化()
  assert.equal(上下文.调度器.lastRestart.status, 'launch-failed')
})

test('落盘：倒计时中按间隔节流，不每次都写', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器)
  await 上下文.调度器.tick()
  const 次数 = 上下文.记录.落盘.length
  上下文.时钟.走(100)
  await 上下文.调度器.tick()
  assert.equal(上下文.记录.落盘.length, 次数)
  上下文.时钟.走(6000)
  await 上下文.调度器.tick()
  assert.ok(上下文.记录.落盘.length > 次数)
})

test('快照字段齐全，最近剩余时间正确', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器, { delaySeconds: 20 })
  排任务(上下文.调度器, { delaySeconds: 40 })
  await 上下文.调度器.tick()
  const 快照 = 上下文.调度器.快照()
  assert.equal(快照.ok, true)
  assert.equal(快照.taskCount, 2)
  assert.equal(快照.busyCount, 0)
  assert.equal(快照.nearestRemainingMs, 20000)
  assert.equal(快照.nearestRemainingSeconds, 20)
  assert.equal(快照.tasks[0].sessionLabel, '会话 A')
})

test('重启中 getter 跟随 firing', async () => {
  const 上下文 = 造调度器()
  assert.equal(上下文.调度器.重启中, false)
  排任务(上下文.调度器)
  await 上下文.调度器.tick()
  上下文.时钟.走(10000)
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.重启中, true)
})

test('没有任务时 tick 保持 idle', async () => {
  const 上下文 = 造调度器()
  const 结果 = await 上下文.调度器.tick()
  assert.equal(结果.阶段, 'idle')
  assert.equal(上下文.调度器.phase, 'idle')
})

test('坏会话数据不会让调度器崩', async () => {
  const 上下文 = 造调度器()
  上下文.忙碌.列表 = null
  排任务(上下文.调度器)
  const 结果 = await 上下文.调度器.tick()
  assert.equal(结果.ok, true)
  assert.equal(上下文.调度器.tasks[0].remainingMs, 10000)
})

test('立即重启：有会话在跑也直接触发，不等空闲与倒计时', async () => {
  const 上下文 = 造调度器()
  设忙碌(上下文, ['session-a'])
  排任务(上下文.调度器, { sessionId: 'session-a' })
  await 上下文.调度器.tick()
  assert.equal(上下文.调度器.phase, 'waiting')
  const 结果 = await 上下文.调度器.立即重启()
  assert.equal(结果.ok, true)
  assert.equal(结果.立即, true)
  assert.equal(上下文.记录.触发.length, 1)
  assert.deepEqual(上下文.记录.触发[0].sessionIds, ['session-a'])
  assert.equal(上下文.调度器.tasks.length, 0)
})

test('立即重启：没有任务时拒绝', async () => {
  const 上下文 = 造调度器()
  const 结果 = await 上下文.调度器.立即重启()
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'no_tasks')
})

test('立即重启：已经在重启时拒绝', async () => {
  const 上下文 = 造调度器()
  排任务(上下文.调度器)
  上下文.调度器.firing = true
  const 结果 = await 上下文.调度器.立即重启()
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'firing')
})

test('立即重启：触发失败时返回错误、清空任务并记 fire-failed', async () => {
  const 上下文 = 造调度器({ onFire: async () => ({ ok: false, error: 'boom' }) })
  排任务(上下文.调度器)
  const 结果 = await 上下文.调度器.立即重启()
  assert.equal(结果.ok, false)
  assert.equal(上下文.调度器.tasks.length, 0)
  assert.equal(上下文.调度器.lastRestart.status, 'fire-failed')
})

test('时钟工具：假时钟可推进', () => {
  const 时钟 = 造时钟(1000)
  assert.equal(时钟.now(), 1000)
  时钟.走(500)
  assert.equal(时钟.now(), 1500)
})
