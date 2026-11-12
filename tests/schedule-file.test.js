// schedule.json 合并测试：全部在临时目录里造文件，不碰真实宿主状态。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareWakeSchedule } from '../lib/schedule-file.js'
import { wakeTextMaxLength } from '../lib/constants.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-schedule-'))
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return dir
}

function writeFile(dir, content) {
  const file = path.join(dir, 'schedule.json')
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return file
}

const fixedId = () => 'fixed-id'

test('合并唤醒事件：只追加目标条目，其它任务原样保留', (t) => {
  const dir = tempDir(t)
  const originalDoc = {
    version: 3,
    tables: {
      tasks: {
        existingTask: {
          sessionId: 'session-old',
          record: { id: '已有任务', kind: 'after', prompt: '旧提醒', scheduledAt: '2026-01-01T00:00:00.000Z' },
          status: 'active',
        },
      },
      sessions: { 'session-old': { title: '旧会话' } },
    },
    nested: { kept: true },
  }
  const file = writeFile(dir, originalDoc)
  const result = prepareWakeSchedule({
    scheduleFile: file,
    events: [{ sessionId: 'session-new', prompt: '重启好了', afterSeconds: 15 }],
    now: Date.parse('2026-02-01T00:00:00.000Z'),
    idFactory: fixedId,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, ['schedule-fixed-id'])

  const afterWrite = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(afterWrite.version, 3)
  assert.deepEqual(afterWrite.tables.sessions, originalDoc.tables.sessions)
  assert.deepEqual(afterWrite.tables.tasks['已有任务'], originalDoc.tables.tasks['已有任务'])

  const newTask = afterWrite.tables.tasks['schedule-fixed-id']
  assert.equal(newTask.sessionId, 'session-new')
  assert.equal(newTask.status, 'active')
  assert.equal(newTask.record.prompt, '重启好了')
  assert.equal(newTask.record.kind, 'after')
  assert.equal(newTask.record.scheduledAt, '2026-02-01T00:00:15.000Z')
})

test('合并唤醒事件：写前备份 .bak/.base，写完留 .pending', (t) => {
  const dir = tempDir(t)
  const rawText = JSON.stringify({ tables: { tasks: {} } }, null, 2)
  const file = writeFile(dir, rawText)
  const result = prepareWakeSchedule({
    scheduleFile: file,
    events: [{ sessionId: 's1', prompt: '好' }],
    idFactory: fixedId,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(fs.readFileSync(result.backupFile), Buffer.from(rawText))
  assert.deepEqual(fs.readFileSync(result.baseFile), Buffer.from(rawText))
  const pending = JSON.parse(fs.readFileSync(result.pendingFile, 'utf8'))
  assert.ok(pending.tables.tasks['schedule-fixed-id'])
  // 备份文件不能和合并结果一样，否则脚本侧的「原文件没被改过」判断失效。
  assert.notDeepEqual(fs.readFileSync(result.backupFile), fs.readFileSync(file))
})

test('合并唤醒事件：坏 JSON 拒绝且原文件一字不动', (t) => {
  const dir = tempDir(t)
  const file = writeFile(dir, '{"tables": {oops')
  const originalBytes = fs.readFileSync(file)
  const result = prepareWakeSchedule({ scheduleFile: file, events: [{ sessionId: 's1' }] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_json')
  assert.deepEqual(fs.readFileSync(file), originalBytes)
  assert.equal(fs.existsSync(file + '.bak'), false)
})

test('合并唤醒事件：tables.tasks 不是对象时拒绝且不覆盖', (t) => {
  const dir = tempDir(t)
  const file = writeFile(dir, { tables: { tasks: [1, 2] } })
  const originalBytes = fs.readFileSync(file)
  const result = prepareWakeSchedule({ scheduleFile: file, events: [{ sessionId: 's1' }] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_shape')
  assert.deepEqual(fs.readFileSync(file), originalBytes)
})

test('合并唤醒事件：文件不存在时不替宿主造空壳', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'schedule.json')
  const result = prepareWakeSchedule({ scheduleFile: file, events: [{ sessionId: 's1' }] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'missing_file')
  assert.equal(fs.existsSync(file), false)
})

test('合并唤醒事件：没有会话的事件被忽略，全空时不动文件', (t) => {
  const dir = tempDir(t)
  const file = writeFile(dir, { tables: { tasks: {} } })
  const originalBytes = fs.readFileSync(file)
  const result = prepareWakeSchedule({ scheduleFile: file, events: [{ sessionId: '  ' }] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, [])
  assert.deepEqual(fs.readFileSync(file), originalBytes)
})

test('合并唤醒事件：时间戳为 0 时按 0 计算，不回落成当前时间', (t) => {
  const dir = tempDir(t)
  const file = writeFile(dir, { tables: { tasks: {} } })
  const result = prepareWakeSchedule({
    scheduleFile: file,
    events: [{ sessionId: 's1', afterSeconds: 15 }],
    now: 0,
    idFactory: fixedId,
  })
  assert.equal(result.ok, true)
  const afterWrite = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(afterWrite.tables.tasks['schedule-fixed-id'].record.scheduledAt, '1970-01-01T00:00:15.000Z')
})

test('合并唤醒事件：写入的 prompt 受长度上限约束', (t) => {
  const dir = tempDir(t)
  const file = writeFile(dir, { tables: { tasks: {} } })
  const result = prepareWakeSchedule({
    scheduleFile: file,
    events: [{ sessionId: 's1', prompt: 'x'.repeat(wakeTextMaxLength + 100) }],
    idFactory: fixedId,
  })
  assert.equal(result.ok, true)
  const afterWrite = JSON.parse(fs.readFileSync(file, 'utf8'))
  const task = afterWrite.tables.tasks['schedule-fixed-id']
  assert.equal(task.record.prompt.length, wakeTextMaxLength)
})
