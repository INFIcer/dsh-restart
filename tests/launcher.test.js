// 计划任务启动器测试：全部用假 spawn，不会真的执行 schtasks。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTaskCommand,
  computeStartTime,
  buildScheduledTaskArgs,
  launchDetachedRestart,
} from '../lib/launcher.js'
import { scheduledTaskName } from '../lib/constants.js'
import { makeFakeSpawn } from './helpers.js'

test('构造任务命令行：普通路径不加引号', () => {
  const row = buildTaskCommand('E:\\dsh-restart-plugin\\restart.ps1')
  assert.match(row, /^powershell\.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File E:\\dsh-restart-plugin\\restart\.ps1$/)
  assert.doesNotMatch(row, /"/)
})

test('构造任务命令行：含空格的路径加双引号', () => {
  const row = buildTaskCommand('D:\\Program Files\\DSH\\restart.ps1')
  assert.match(row, /-File "D:\\Program Files\\DSH\\restart\.ps1"$/)
})

test('构造任务命令行：空参数不抛错', () => {
  assert.match(buildTaskCommand(undefined), /-File $/)
})

test('计算开始时间：默认往后推 2 分钟', () => {
  const base = new Date(2026, 0, 2, 10, 30, 0).getTime()
  assert.equal(computeStartTime(base), '10:32')
})

test('计算开始时间：跨小时正确进位', () => {
  const base = new Date(2026, 0, 2, 10, 59, 0).getTime()
  assert.equal(computeStartTime(base), '11:01')
})

test('计算开始时间：跨天回到 00:xx', () => {
  const base = new Date(2026, 0, 2, 23, 59, 0).getTime()
  assert.equal(computeStartTime(base), '00:01')
})

test('计算开始时间：非法值回落到当前时间', () => {
  const result = computeStartTime('不是数字')
  assert.match(result, /^\d{2}:\d{2}$/)
})

test('构造计划任务参数：create 与 run 的参数顺序正确', () => {
  const params = buildScheduledTaskArgs({ scriptPath: 'E:\\a b\\r.ps1', startTime: '10:32' })
  assert.equal(params.taskName, scheduledTaskName)
  assert.deepEqual(params.create.slice(0, 6), ['/Create', '/F', '/SC', 'ONCE', '/ST', '10:32'])
  assert.deepEqual(params.create.slice(6, 8), ['/TN', scheduledTaskName])
  assert.equal(params.create[8], '/TR')
  assert.match(params.create[9], /"E:\\a b\\r\.ps1"/)
  assert.deepEqual(params.run, ['/Run', '/TN', scheduledTaskName])
})

test('构造计划任务参数：可自定义任务名', () => {
  const params = buildScheduledTaskArgs({ taskName: '自定义', scriptPath: 'E:\\r.ps1', startTime: '01:02' })
  assert.equal(params.taskName, '自定义')
  assert.equal(params.create[7], '自定义')
})

test('启动脱离重启：两次 schtasks 都成功', async () => {
  const spawnImpl = makeFakeSpawn([{ code: 0 }, { code: 0 }])
  const result = await launchDetachedRestart({ scriptPath: 'E:\\dsh-restart-plugin\\restart.ps1', spawnImpl })
  assert.equal(result.ok, true)
  assert.equal(result.launcher, 'schtasks')
  assert.equal(result.taskName, scheduledTaskName)
  assert.equal(result.createCode, 0)
  assert.equal(result.runCode, 0)
  assert.equal(spawnImpl.calls.length, 2)
  assert.equal(spawnImpl.calls[0].executable, 'schtasks.exe')
  assert.equal(spawnImpl.calls[1].params[0], '/Run')
})

test('启动脱离重启：spawn 选项 windowsHide 且不 detached', async () => {
  const spawnImpl = makeFakeSpawn([{ code: 0 }, { code: 0 }])
  await launchDetachedRestart({ scriptPath: 'E:\\r.ps1', spawnImpl })
  for (const calls of spawnImpl.calls) {
    assert.equal(calls.options.windowsHide, true)
    assert.equal(calls.options.detached, undefined)
    assert.deepEqual(calls.options.stdio, ['ignore', 'pipe', 'pipe'])
  }
})

test('启动脱离重启：缺少脚本路径时 prepare 失败', async () => {
  const spawnImpl = makeFakeSpawn([{ code: 0 }])
  const result = await launchDetachedRestart({ spawnImpl })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'prepare')
  assert.equal(spawnImpl.calls.length, 0)
})

test('启动脱离重启：create 非零时停在 create', async () => {
  const spawnImpl = makeFakeSpawn([{ code: 1, stderr: '拒绝访问' }])
  const result = await launchDetachedRestart({ scriptPath: 'E:\\r.ps1', spawnImpl })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'create')
  assert.match(result.error, /退出码 1/)
  assert.match(result.stderr, /拒绝访问/)
  assert.equal(spawnImpl.calls.length, 1)
})

test('启动脱离重启：run 非零时停在 run', async () => {
  const spawnImpl = makeFakeSpawn([{ code: 0 }, { code: 2 }])
  const result = await launchDetachedRestart({ scriptPath: 'E:\\r.ps1', spawnImpl })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'run')
  assert.equal(spawnImpl.calls.length, 2)
})

test('启动脱离重启：spawn 抛错时 stage=exception', async () => {
  const spawnImpl = () => {
    throw new Error('找不到 schtasks')
  }
  const result = await launchDetachedRestart({ scriptPath: 'E:\\r.ps1', spawnImpl })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'create')
  assert.match(result.error, /找不到 schtasks/)
})

test('启动脱离重启：超时会杀掉子进程并报超时', async () => {
  const spawnImpl = makeFakeSpawn([{ timedOut: true }])
  const result = await launchDetachedRestart({ scriptPath: 'E:\\r.ps1', spawnImpl, timeoutMs: 30 })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'create')
  assert.match(result.error, /超时/)
  assert.equal(spawnImpl.calls.length, 1)
})

test('启动脱离重启：进程 error 事件被当成失败', async () => {
  const spawnImpl = makeFakeSpawn([{ throwError: 'ENOENT' }])
  const result = await launchDetachedRestart({ scriptPath: 'E:\\r.ps1', spawnImpl })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'create')
  assert.match(result.error, /ENOENT/)
})

test('启动脱离重启：日志回调收到两次 info', async () => {
  const log = []
  const spawnImpl = makeFakeSpawn([{ code: 0 }, { code: 0 }])
  await launchDetachedRestart({
    scriptPath: 'E:\\r.ps1',
    spawnImpl,
    log: (level, text) => log.push([level, text]),
  })
  assert.equal(log.length, 2)
  assert.equal(log[0][0], 'info')
})
