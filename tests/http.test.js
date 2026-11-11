// HTTP 小工具测试：假 req / 假 res，不启动服务器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { 回JSON, 读请求体, 方法允许 } from '../lib/http.js'

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

function 假请求(方法 = 'GET', 体 = '') {
  const 请求 = Readable.from([Buffer.from(体)])
  请求.method = 方法
  return 请求
}

test('回JSON：设置状态码与 JSON 头', () => {
  const res = 假响应()
  assert.equal(回JSON(res, 201, { ok: true }), true)
  assert.equal(res.statusCode, 201)
  assert.match(res.头['content-type'], /application\/json/)
  assert.equal(res.头['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(res.体), { ok: true })
})

test('回JSON：没有 res.end 时返回 false 不抛', () => {
  assert.equal(回JSON(null, 200, {}), false)
  assert.equal(回JSON({}, 200, {}), false)
})

test('回JSON：循环引用时回 500 而不是抛', () => {
  const res = 假响应()
  const 循环 = {}
  循环.自己 = 循环
  回JSON(res, 200, 循环)
  assert.equal(res.statusCode, 500)
  assert.match(res.体, /响应序列化失败/)
})

test('读请求体：解析正常 JSON', async () => {
  const 结果 = await 读请求体(假请求('POST', '{"taskId":"restart-1"}'))
  assert.equal(结果.ok, true)
  assert.equal(结果.value.taskId, 'restart-1')
})

test('读请求体：空体返回空对象', async () => {
  const 结果 = await 读请求体(假请求('POST', ''))
  assert.deepEqual(结果, { ok: true, value: {} })
})

test('读请求体：坏 JSON 返回 bad_json', async () => {
  const 结果 = await 读请求体(假请求('POST', '{oops'))
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'bad_json')
})

test('读请求体：超过上限返回 too_large', async () => {
  const 结果 = await 读请求体(假请求('POST', 'x'.repeat(200)), 100)
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'too_large')
})

test('读请求体：没有可读流时按空对象处理', async () => {
  const 结果 = await 读请求体({})
  assert.deepEqual(结果, { ok: true, value: {} })
})

test('方法允许：匹配放行', () => {
  const res = 假响应()
  assert.equal(方法允许(假请求('get'), res, ['GET']), true)
  assert.equal(res.statusCode, null)
})

test('方法允许：不匹配回 405 并带 allow 头', () => {
  const res = 假响应()
  assert.equal(方法允许(假请求('DELETE'), res, ['GET', 'POST']), false)
  assert.equal(res.statusCode, 405)
  assert.equal(res.头.allow, 'GET, POST')
  assert.deepEqual(JSON.parse(res.体).code, 'method_not_allowed')
})
