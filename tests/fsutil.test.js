// 文件工具测试：原子写、BOM、坏 JSON 兜底。全部写到临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureDir,
  readJson,
  writeJsonAtomic,
  writeText,
  appendLog,
  removeFile,
  exists,
} from '../lib/fsutil.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-test-'))
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return dir
}

test('确保目录：能递归建目录', (t) => {
  const dir = tempDir(t)
  const deepDir = path.join(dir, 'a', 'b', 'c')
  assert.equal(ensureDir(deepDir), true)
  assert.equal(fs.existsSync(deepDir), true)
})

test('写JSON原子 再 读JSON：内容往返一致', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'state.json')
  const value = { version: 1, tasks: [{ id: 'a' }], ok: true }
  const result = writeJsonAtomic(file, value)
  assert.equal(result.ok, true)
  assert.deepEqual(readJson(file), value)
})

test('写JSON原子：不留下 .tmp 文件', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'state.json')
  writeJsonAtomic(file, { a: 1 })
  const remaining = fs.readdirSync(dir)
  assert.deepEqual(remaining, ['state.json'])
})

test('读JSON：文件不存在返回兜底', (t) => {
  const dir = tempDir(t)
  assert.equal(readJson(path.join(dir, 'nope.json'), '兜底'), '兜底')
})

test('读JSON：坏 JSON 返回兜底而不是抛错', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'bad.json')
  fs.writeFileSync(file, '{ 这不是 json', 'utf8')
  assert.equal(readJson(file, null), null)
})

test('读JSON：能读带 BOM 的文件', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'bom.json')
  fs.writeFileSync(file, '\uFEFF{"ok":true}', 'utf8')
  assert.deepEqual(readJson(file), { ok: true })
})

test('读JSON：空文件返回兜底', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'empty.json')
  fs.writeFileSync(file, '   ', 'utf8')
  assert.deepEqual(readJson(file, { defaultValue: 1 }), { defaultValue: 1 })
})

test('写JSON原子：遇到循环引用返回失败而不是抛错', (t) => {
  const dir = tempDir(t)
  const circular = {}
  circular.self = circular
  const result = writeJsonAtomic(path.join(dir, 'x.json'), circular)
  assert.equal(result.ok, false)
})

test('写文本：bom=true 时文件头是 UTF-8 BOM', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'script.ps1')
  const result = writeText(file, 'Write-Host 你好', { bom: true })
  assert.equal(result.ok, true)
  const bytes = fs.readFileSync(file)
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(bytes.toString('utf8'), /你好/)
})

test('写文本：bom=false 时不加 BOM', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'plain.txt')
  writeText(file, 'abc')
  assert.equal(fs.readFileSync(file)[0], 0x61)
})

test('追加日志：写多行且带时间戳', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'a.log')
  assert.equal(appendLog(file, '第一条'), true)
  assert.equal(appendLog(file, '第二条'), true)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /第一条/)
  assert.match(text, /第二条/)
  assert.equal(text.trim().split('\n').length, 2)
})

test('追加日志：父目录不存在时自动建', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, '深', '层', 'a.log')
  assert.equal(appendLog(file, 'x'), true)
  assert.equal(exists(file), true)
})

test('删文件 与 存在：删掉就没了，重复删返回 false', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'x.json')
  writeText(file, 'x')
  assert.equal(exists(file), true)
  assert.equal(removeFile(file), true)
  assert.equal(exists(file), false)
  assert.equal(removeFile(file), false)
})
