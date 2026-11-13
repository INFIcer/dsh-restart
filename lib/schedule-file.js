// 往宿主的 storages/schedule.json 里追加唤醒事件。
//
// 安全边界：
//  - 只在内存里给 tables.tasks 增加条目，其余字段原样保留；
//  - 写前把原文件字节备份成 .bak，写临时文件再 rename，绝不直接截断原文件；
//  - 写完回读校验目标条目还在，校验失败用备份回滚；
//  - 另存 .base（写入前的原文件）与 .pending（合并结果），供重启脚本在
//    DSH 全部退出后判断是否还能安全替换。
//
// 为什么不在触发时依赖 PowerShell 做这件事：PS 5.1 的 ConvertTo-Json 会把
// 整个文档重排、重格式化时间串，等于用插件理解的形状覆盖宿主状态。

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureDir, removeFile } from './fsutil.js'
import { normalizeText } from './text.js'
import { wakeTextMaxLength } from './constants.js'

/** 原样读出文件字节；不存在时返回 null。 */
function readBytes(file) {
  try {
    return fs.readFileSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** 原子替换：同目录临时文件 + rename。失败时清掉临时文件并把错误抛给调用方。 */
function writeAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    ensureDir(path.dirname(file))
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      removeFile(tmp)
    } catch {
      /* 临时文件可能没建出来 */
    }
    throw error
  }
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** 组装单条唤醒任务，结构与宿主 schedule.json 的 task 一致。 */
function buildWakeTask(event, nowMs, idFactory) {
  const afterSeconds = Number(event.afterSeconds) > 0 ? Math.round(Number(event.afterSeconds)) : 15
  const id = `schedule-${idFactory()}`
  const due = new Date(nowMs + afterSeconds * 1000).toISOString()
  return {
    id,
    sessionId: String(event.sessionId || ''),
    prompt: normalizeText(event.prompt, wakeTextMaxLength),
    afterSeconds,
    record: {
      id,
      kind: 'after',
      title: String(event.title || '重启完成唤醒'),
      prompt: normalizeText(event.prompt, wakeTextMaxLength),
      afterSeconds,
      scheduledAt: due,
    },
    task: {
      sessionId: String(event.sessionId || ''),
      record: null,
      status: 'active',
    },
  }
}

/**
 * 把唤醒事件合并进 schedule.json。
 * @returns {{ok:true,added:string[],file:string,backupFile:string,pendingFile:string,baseFile:string,mergedText:string}|{ok:false,code:string,error:string}}
 */
export function prepareWakeSchedule({ scheduleFile, events = [], now = Date.now(), idFactory = randomUUID } = {}) {
  const file = String(scheduleFile || '').trim()
  if (!file) return { ok: false, code: 'no_file', error: '缺少 schedule.json 路径' }
  const eventList = (Array.isArray(events) ? events : []).filter((item) => item && String(item.sessionId || '').trim())
  if (eventList.length === 0) {
    return { ok: true, added: [], file, backupFile: `${file}.bak`, pendingFile: `${file}.pending`, baseFile: `${file}.base`, mergedText: '' }
  }

  let raw = null
  try {
    raw = readBytes(file)
  } catch (error) {
    return { ok: false, code: 'read_failed', error: String(error?.message || error) }
  }
  if (raw == null) {
    // 宿主还没有 schedule.json：不替它造一个空壳，唤醒只能放弃。
    return { ok: false, code: 'missing_file', error: `找不到 ${file}` }
  }
  const rawText = raw.toString('utf8').replace(/^\uFEFF/, '')

  let doc
  try {
    doc = JSON.parse(rawText)
  } catch (error) {
    return { ok: false, code: 'bad_json', error: `schedule.json 不是合法 JSON：${error?.message || error}` }
  }
  if (!isPlainObject(doc)) {
    return { ok: false, code: 'bad_shape', error: 'schedule.json 顶层不是对象' }
  }
  if (doc.tables == null) doc.tables = {}
  if (!isPlainObject(doc.tables)) {
    return { ok: false, code: 'bad_shape', error: 'schedule.json 的 tables 不是对象' }
  }
  if (doc.tables.tasks == null) doc.tables.tasks = {}
  if (!isPlainObject(doc.tables.tasks)) {
    return { ok: false, code: 'bad_shape', error: 'schedule.json 的 tables.tasks 不是对象' }
  }

  const makeId = typeof idFactory === 'function' ? idFactory : randomUUID
  const added = []
  const expected = new Map()
  // 0 是合法时间戳（测试用假时钟），不能用 `|| Date.now()` 兜底。
  const baseMs = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  for (const event of eventList) {
    const task = buildWakeTask(event, baseMs, makeId)
    task.task.record = task.record
    doc.tables.tasks[task.id] = task.task
    added.push(task.id)
    expected.set(task.id, task)
  }

  const mergedText = JSON.stringify(doc, null, 2)
  const mergedBytes = Buffer.from(mergedText, 'utf8')
  const backupFile = `${file}.bak`
  const pendingFile = `${file}.pending`
  const baseFile = `${file}.base`

  // 先备份原文件字节；备份失败就不写，避免无退路。
  try {
    writeAtomic(backupFile, raw)
    writeAtomic(baseFile, raw)
  } catch (error) {
    return { ok: false, code: 'backup_failed', error: String(error?.message || error) }
  }

  try {
    writeAtomic(file, mergedBytes)
  } catch (error) {
    return { ok: false, code: 'write_failed', error: String(error?.message || error) }
  }

  // 回读校验：JSON 可解析、新增条目还在、关键字段没丢。
  let readBack = null
  try {
    readBack = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    readBack = null
  }
  const verified =
    isPlainObject(readBack) &&
    isPlainObject(readBack.tables) &&
    isPlainObject(readBack.tables.tasks) &&
    added.every((id) => {
      const entry = readBack.tables.tasks[id]
      const expectedEntry = expected.get(id)
      return (
        isPlainObject(entry) &&
        entry.status === 'active' &&
        isPlainObject(entry.record) &&
        entry.record.prompt === expectedEntry.record.prompt
      )
    })
  if (!verified) {
    try {
      writeAtomic(file, raw)
    } catch {
      try {
        fs.copyFileSync(backupFile, file)
      } catch {
        /* 回滚也失败时只能保留现场，交给 .bak */
      }
    }
    return { ok: false, code: 'verify_failed', error: '写入后校验失败，已回滚原文件' }
  }

  try {
    writeAtomic(pendingFile, mergedBytes)
  } catch (error) {
    // 原文件已经合并成功，pending 只是给脚本用的二次保障；写不进去不致命。
  }

  return { ok: true, added, file, backupFile, pendingFile, baseFile, mergedText }
}
