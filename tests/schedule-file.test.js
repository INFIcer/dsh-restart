// schedule.json 合并测试：全部在临时目录里造文件，不碰真实宿主状态。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareWakeSchedule } from '../lib/schedule-file.js'
import { wakeTextMaxLength } from '../lib/constants.js'

function 临时目录(t) {
  const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-schedule-'))
  t.after(() => {
    try { fs.rmSync(目录, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return 目录
}

function 写文件(目录, 内容) {
  const 文件 = path.join(目录, 'schedule.json')
  fs.writeFileSync(文件, typeof 内容 === 'string' ? 内容 : JSON.stringify(内容, null, 2))
  return 文件
}

const 固定Id = () => 'fixed-id'

test('合并唤醒事件：只追加目标条目，其它任务原样保留', (t) => {
  const 目录 = 临时目录(t)
  const 原文档 = {
    version: 3,
    tables: {
      tasks: {
        已有任务: {
          sessionId: 'session-old',
          record: { id: '已有任务', kind: 'after', prompt: '旧提醒', scheduledAt: '2026-01-01T00:00:00.000Z' },
          status: 'active',
        },
      },
      sessions: { 'session-old': { title: '旧会话' } },
    },
    nested: { 保留: true },
  }
  const 文件 = 写文件(目录, 原文档)
  const 结果 = prepareWakeSchedule({
    scheduleFile: 文件,
    events: [{ sessionId: 'session-new', prompt: '重启好了', afterSeconds: 15 }],
    now: Date.parse('2026-02-01T00:00:00.000Z'),
    idFactory: 固定Id,
  })
  assert.equal(结果.ok, true)
  assert.deepEqual(结果.added, ['schedule-fixed-id'])

  const 写入后 = JSON.parse(fs.readFileSync(文件, 'utf8'))
  assert.equal(写入后.version, 3)
  assert.deepEqual(写入后.tables.sessions, 原文档.tables.sessions)
  assert.deepEqual(写入后.tables.tasks['已有任务'], 原文档.tables.tasks['已有任务'])

  const 新任务 = 写入后.tables.tasks['schedule-fixed-id']
  assert.equal(新任务.sessionId, 'session-new')
  assert.equal(新任务.status, 'active')
  assert.equal(新任务.record.prompt, '重启好了')
  assert.equal(新任务.record.kind, 'after')
  assert.equal(新任务.record.scheduledAt, '2026-02-01T00:00:15.000Z')
})

test('合并唤醒事件：写前备份 .bak/.base，写完留 .pending', (t) => {
  const 目录 = 临时目录(t)
  const 原文 = JSON.stringify({ tables: { tasks: {} } }, null, 2)
  const 文件 = 写文件(目录, 原文)
  const 结果 = prepareWakeSchedule({
    scheduleFile: 文件,
    events: [{ sessionId: 's1', prompt: '好' }],
    idFactory: 固定Id,
  })
  assert.equal(结果.ok, true)
  assert.deepEqual(fs.readFileSync(结果.backupFile), Buffer.from(原文))
  assert.deepEqual(fs.readFileSync(结果.baseFile), Buffer.from(原文))
  const pending = JSON.parse(fs.readFileSync(结果.pendingFile, 'utf8'))
  assert.ok(pending.tables.tasks['schedule-fixed-id'])
  // 备份文件不能和合并结果一样，否则脚本侧的「原文件没被改过」判断失效。
  assert.notDeepEqual(fs.readFileSync(结果.backupFile), fs.readFileSync(文件))
})

test('合并唤醒事件：坏 JSON 拒绝且原文件一字不动', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = 写文件(目录, '{"tables": {oops')
  const 原字节 = fs.readFileSync(文件)
  const 结果 = prepareWakeSchedule({ scheduleFile: 文件, events: [{ sessionId: 's1' }] })
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'bad_json')
  assert.deepEqual(fs.readFileSync(文件), 原字节)
  assert.equal(fs.existsSync(文件 + '.bak'), false)
})

test('合并唤醒事件：tables.tasks 不是对象时拒绝且不覆盖', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = 写文件(目录, { tables: { tasks: [1, 2] } })
  const 原字节 = fs.readFileSync(文件)
  const 结果 = prepareWakeSchedule({ scheduleFile: 文件, events: [{ sessionId: 's1' }] })
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'bad_shape')
  assert.deepEqual(fs.readFileSync(文件), 原字节)
})

test('合并唤醒事件：文件不存在时不替宿主造空壳', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'schedule.json')
  const 结果 = prepareWakeSchedule({ scheduleFile: 文件, events: [{ sessionId: 's1' }] })
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'missing_file')
  assert.equal(fs.existsSync(文件), false)
})

test('合并唤醒事件：没有会话的事件被忽略，全空时不动文件', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = 写文件(目录, { tables: { tasks: {} } })
  const 原字节 = fs.readFileSync(文件)
  const 结果 = prepareWakeSchedule({ scheduleFile: 文件, events: [{ sessionId: '  ' }] })
  assert.equal(结果.ok, true)
  assert.deepEqual(结果.added, [])
  assert.deepEqual(fs.readFileSync(文件), 原字节)
})

test('合并唤醒事件：时间戳为 0 时按 0 计算，不回落成当前时间', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = 写文件(目录, { tables: { tasks: {} } })
  const 结果 = prepareWakeSchedule({
    scheduleFile: 文件,
    events: [{ sessionId: 's1', afterSeconds: 15 }],
    now: 0,
    idFactory: 固定Id,
  })
  assert.equal(结果.ok, true)
  const 写入后 = JSON.parse(fs.readFileSync(文件, 'utf8'))
  assert.equal(写入后.tables.tasks['schedule-fixed-id'].record.scheduledAt, '1970-01-01T00:00:15.000Z')
})

test('合并唤醒事件：写入的 prompt 受长度上限约束', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = 写文件(目录, { tables: { tasks: {} } })
  const 结果 = prepareWakeSchedule({
    scheduleFile: 文件,
    events: [{ sessionId: 's1', prompt: 'x'.repeat(wakeTextMaxLength + 100) }],
    idFactory: 固定Id,
  })
  assert.equal(结果.ok, true)
  const 写入后 = JSON.parse(fs.readFileSync(文件, 'utf8'))
  const 任务 = 写入后.tables.tasks['schedule-fixed-id']
  assert.equal(任务.record.prompt.length, wakeTextMaxLength)
})
