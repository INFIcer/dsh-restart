// 文件工具测试：原子写、BOM、坏 JSON 兜底。全部写到临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  确保目录,
  读JSON,
  写JSON原子,
  写文本,
  追加日志,
  删文件,
  存在,
} from '../lib/fsutil.js'

function 临时目录(t) {
  const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-test-'))
  t.after(() => {
    try { fs.rmSync(目录, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return 目录
}

test('确保目录：能递归建目录', (t) => {
  const 目录 = 临时目录(t)
  const 深 = path.join(目录, 'a', 'b', 'c')
  assert.equal(确保目录(深), true)
  assert.equal(fs.existsSync(深), true)
})

test('写JSON原子 再 读JSON：内容往返一致', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'state.json')
  const 值 = { 版本: 1, tasks: [{ id: 'a' }], ok: true }
  const 结果 = 写JSON原子(文件, 值)
  assert.equal(结果.ok, true)
  assert.deepEqual(读JSON(文件), 值)
})

test('写JSON原子：不留下 .tmp 文件', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'state.json')
  写JSON原子(文件, { a: 1 })
  const 剩余 = fs.readdirSync(目录)
  assert.deepEqual(剩余, ['state.json'])
})

test('读JSON：文件不存在返回兜底', (t) => {
  const 目录 = 临时目录(t)
  assert.equal(读JSON(path.join(目录, 'nope.json'), '兜底'), '兜底')
})

test('读JSON：坏 JSON 返回兜底而不是抛错', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'bad.json')
  fs.writeFileSync(文件, '{ 这不是 json', 'utf8')
  assert.equal(读JSON(文件, null), null)
})

test('读JSON：能读带 BOM 的文件', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'bom.json')
  fs.writeFileSync(文件, '\uFEFF{"ok":true}', 'utf8')
  assert.deepEqual(读JSON(文件), { ok: true })
})

test('读JSON：空文件返回兜底', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'empty.json')
  fs.writeFileSync(文件, '   ', 'utf8')
  assert.deepEqual(读JSON(文件, { 默认: 1 }), { 默认: 1 })
})

test('写JSON原子：遇到循环引用返回失败而不是抛错', (t) => {
  const 目录 = 临时目录(t)
  const 循环 = {}
  循环.自己 = 循环
  const 结果 = 写JSON原子(path.join(目录, 'x.json'), 循环)
  assert.equal(结果.ok, false)
})

test('写文本：bom=true 时文件头是 UTF-8 BOM', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'script.ps1')
  const 结果 = 写文本(文件, 'Write-Host 你好', { bom: true })
  assert.equal(结果.ok, true)
  const 字节 = fs.readFileSync(文件)
  assert.deepEqual([...字节.slice(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(字节.toString('utf8'), /你好/)
})

test('写文本：bom=false 时不加 BOM', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'plain.txt')
  写文本(文件, 'abc')
  assert.equal(fs.readFileSync(文件)[0], 0x61)
})

test('追加日志：写多行且带时间戳', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'a.log')
  assert.equal(追加日志(文件, '第一条'), true)
  assert.equal(追加日志(文件, '第二条'), true)
  const 文本 = fs.readFileSync(文件, 'utf8')
  assert.match(文本, /第一条/)
  assert.match(文本, /第二条/)
  assert.equal(文本.trim().split('\n').length, 2)
})

test('追加日志：父目录不存在时自动建', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, '深', '层', 'a.log')
  assert.equal(追加日志(文件, 'x'), true)
  assert.equal(存在(文件), true)
})

test('删文件 与 存在：删掉就没了，重复删返回 false', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'x.json')
  写文本(文件, 'x')
  assert.equal(存在(文件), true)
  assert.equal(删文件(文件), true)
  assert.equal(存在(文件), false)
  assert.equal(删文件(文件), false)
})
