// 计划任务启动器测试：全部用假 spawn，不会真的执行 schtasks。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  构造任务命令行,
  计算开始时间,
  构造计划任务参数,
  启动脱离重启,
} from '../lib/launcher.js'
import { 计划任务名 } from '../lib/constants.js'
import { 造假spawn } from './helpers.js'

test('构造任务命令行：普通路径不加引号', () => {
  const 行 = 构造任务命令行('E:\\dsh-restart-plugin\\restart.ps1')
  assert.match(行, /^powershell\.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File E:\\dsh-restart-plugin\\restart\.ps1$/)
  assert.doesNotMatch(行, /"/)
})

test('构造任务命令行：含空格的路径加双引号', () => {
  const 行 = 构造任务命令行('D:\\Program Files\\DSH\\restart.ps1')
  assert.match(行, /-File "D:\\Program Files\\DSH\\restart\.ps1"$/)
})

test('构造任务命令行：空参数不抛错', () => {
  assert.match(构造任务命令行(undefined), /-File $/)
})

test('计算开始时间：默认往后推 2 分钟', () => {
  const 基准 = new Date(2026, 0, 2, 10, 30, 0).getTime()
  assert.equal(计算开始时间(基准), '10:32')
})

test('计算开始时间：跨小时正确进位', () => {
  const 基准 = new Date(2026, 0, 2, 10, 59, 0).getTime()
  assert.equal(计算开始时间(基准), '11:01')
})

test('计算开始时间：跨天回到 00:xx', () => {
  const 基准 = new Date(2026, 0, 2, 23, 59, 0).getTime()
  assert.equal(计算开始时间(基准), '00:01')
})

test('计算开始时间：非法值回落到当前时间', () => {
  const 结果 = 计算开始时间('不是数字')
  assert.match(结果, /^\d{2}:\d{2}$/)
})

test('构造计划任务参数：create 与 run 的参数顺序正确', () => {
  const 参数 = 构造计划任务参数({ scriptPath: 'E:\\a b\\r.ps1', 开始时间: '10:32' })
  assert.equal(参数.任务名, 计划任务名)
  assert.deepEqual(参数.create.slice(0, 6), ['/Create', '/F', '/SC', 'ONCE', '/ST', '10:32'])
  assert.deepEqual(参数.create.slice(6, 8), ['/TN', 计划任务名])
  assert.equal(参数.create[8], '/TR')
  assert.match(参数.create[9], /"E:\\a b\\r\.ps1"/)
  assert.deepEqual(参数.run, ['/Run', '/TN', 计划任务名])
})

test('构造计划任务参数：可自定义任务名', () => {
  const 参数 = 构造计划任务参数({ taskName: '自定义', scriptPath: 'E:\\r.ps1', 开始时间: '01:02' })
  assert.equal(参数.任务名, '自定义')
  assert.equal(参数.create[7], '自定义')
})

test('启动脱离重启：两次 schtasks 都成功', async () => {
  const spawnImpl = 造假spawn([{ code: 0 }, { code: 0 }])
  const 结果 = await 启动脱离重启({ scriptPath: 'E:\\dsh-restart-plugin\\restart.ps1', spawnImpl })
  assert.equal(结果.ok, true)
  assert.equal(结果.launcher, 'schtasks')
  assert.equal(结果.taskName, 计划任务名)
  assert.equal(结果.createCode, 0)
  assert.equal(结果.runCode, 0)
  assert.equal(spawnImpl.调用.length, 2)
  assert.equal(spawnImpl.调用[0].可执行, 'schtasks.exe')
  assert.equal(spawnImpl.调用[1].参数[0], '/Run')
})

test('启动脱离重启：spawn 选项 windowsHide 且不 detached', async () => {
  const spawnImpl = 造假spawn([{ code: 0 }, { code: 0 }])
  await 启动脱离重启({ scriptPath: 'E:\\r.ps1', spawnImpl })
  for (const 调用 of spawnImpl.调用) {
    assert.equal(调用.选项.windowsHide, true)
    assert.equal(调用.选项.detached, undefined)
    assert.deepEqual(调用.选项.stdio, ['ignore', 'pipe', 'pipe'])
  }
})

test('启动脱离重启：缺少脚本路径时 prepare 失败', async () => {
  const spawnImpl = 造假spawn([{ code: 0 }])
  const 结果 = await 启动脱离重启({ spawnImpl })
  assert.equal(结果.ok, false)
  assert.equal(结果.stage, 'prepare')
  assert.equal(spawnImpl.调用.length, 0)
})

test('启动脱离重启：create 非零时停在 create', async () => {
  const spawnImpl = 造假spawn([{ code: 1, stderr: '拒绝访问' }])
  const 结果 = await 启动脱离重启({ scriptPath: 'E:\\r.ps1', spawnImpl })
  assert.equal(结果.ok, false)
  assert.equal(结果.stage, 'create')
  assert.match(结果.error, /退出码 1/)
  assert.match(结果.stderr, /拒绝访问/)
  assert.equal(spawnImpl.调用.length, 1)
})

test('启动脱离重启：run 非零时停在 run', async () => {
  const spawnImpl = 造假spawn([{ code: 0 }, { code: 2 }])
  const 结果 = await 启动脱离重启({ scriptPath: 'E:\\r.ps1', spawnImpl })
  assert.equal(结果.ok, false)
  assert.equal(结果.stage, 'run')
  assert.equal(spawnImpl.调用.length, 2)
})

test('启动脱离重启：spawn 抛错时 stage=exception', async () => {
  const spawnImpl = () => {
    throw new Error('找不到 schtasks')
  }
  const 结果 = await 启动脱离重启({ scriptPath: 'E:\\r.ps1', spawnImpl })
  assert.equal(结果.ok, false)
  assert.equal(结果.stage, 'create')
  assert.match(结果.error, /找不到 schtasks/)
})

test('启动脱离重启：超时会杀掉子进程并报超时', async () => {
  const spawnImpl = 造假spawn([{ 超时: true }])
  const 结果 = await 启动脱离重启({ scriptPath: 'E:\\r.ps1', spawnImpl, timeoutMs: 30 })
  assert.equal(结果.ok, false)
  assert.equal(结果.stage, 'create')
  assert.match(结果.error, /超时/)
  assert.equal(spawnImpl.调用.length, 1)
})

test('启动脱离重启：进程 error 事件被当成失败', async () => {
  const spawnImpl = 造假spawn([{ 抛错: 'ENOENT' }])
  const 结果 = await 启动脱离重启({ scriptPath: 'E:\\r.ps1', spawnImpl })
  assert.equal(结果.ok, false)
  assert.equal(结果.stage, 'create')
  assert.match(结果.error, /ENOENT/)
})

test('启动脱离重启：日志回调收到两次 info', async () => {
  const 日志 = []
  const spawnImpl = 造假spawn([{ code: 0 }, { code: 0 }])
  await 启动脱离重启({
    scriptPath: 'E:\\r.ps1',
    spawnImpl,
    日志: (级别, 文本) => 日志.push([级别, 文本]),
  })
  assert.equal(日志.length, 2)
  assert.equal(日志[0][0], 'info')
})
