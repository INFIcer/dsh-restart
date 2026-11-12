// HTTP 小工具测试：假 req / 假 res，不启动服务器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { 回JSON, 读请求体, 方法允许, checkRequestOrigin, requireSameOrigin } from '../lib/http.js'

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

// ———————————————————————— 同源校验 ————————————————————————

function 带来源(来源头 = {}) {
  return { headers: 来源头 }
}

test('来源校验：没有请求头时放行（非浏览器调用）', () => {
  assert.equal(checkRequestOrigin({}).ok, true)
  assert.equal(checkRequestOrigin({ headers: {} }).ok, true)
})

test('来源校验：Origin 与 Host 同主机同端口放行', () => {
  assert.equal(
    checkRequestOrigin(带来源({ host: '127.0.0.1:13066', origin: 'http://127.0.0.1:13066' })).ok,
    true,
  )
})

test('来源校验：端口从请求头推导，不写死', () => {
  assert.equal(
    checkRequestOrigin(带来源({ host: '127.0.0.1:54321', origin: 'http://127.0.0.1:54321' })).ok,
    true,
  )
  assert.equal(
    checkRequestOrigin(带来源({ host: 'localhost:8080', origin: 'http://localhost:9999' })).ok,
    false,
  )
})

test('来源校验：Host 无端口时按来源自身协议的默认端口比对', () => {
  // Host 头不带端口时无法知道协议，只能按 Origin 的协议取默认端口（80/443），不能写死端口。
  assert.equal(checkRequestOrigin(带来源({ host: 'example.com', origin: 'https://example.com' })).ok, true)
  assert.equal(checkRequestOrigin(带来源({ host: 'example.com', origin: 'http://example.com' })).ok, true)
  assert.equal(checkRequestOrigin(带来源({ host: 'example.com', origin: 'https://example.com:8443' })).ok, false)
})

test('来源校验：Referer 与 Host 不同源时拒绝', () => {
  assert.equal(
    checkRequestOrigin(带来源({ host: '127.0.0.1:13066', referer: 'http://evil.example/x' })).ok,
    false,
  )
  assert.equal(
    checkRequestOrigin(带来源({ host: '127.0.0.1:13066', referer: 'http://127.0.0.1:13066/x' })).ok,
    true,
  )
})

test('来源校验：Origin=null 拒绝', () => {
  assert.equal(checkRequestOrigin(带来源({ host: '127.0.0.1:13066', origin: 'null' })).ok, false)
})

test('来源校验：Sec-Fetch-Site 只接受 same-origin / none', () => {
  assert.equal(
    checkRequestOrigin(带来源({ 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:13066', host: '127.0.0.1:13066' })).ok,
    false,
  )
  assert.equal(checkRequestOrigin(带来源({ 'sec-fetch-site': 'same-origin', host: '127.0.0.1:13066' })).ok, true)
  assert.equal(checkRequestOrigin(带来源({ 'sec-fetch-site': 'none' })).ok, true)
})

test('来源校验：缺 Host 时无法比对，拒绝', () => {
  assert.equal(checkRequestOrigin(带来源({ origin: 'http://127.0.0.1:13066' })).ok, false)
})

test('requireSameOrigin：拒绝时回 403 forbidden_origin', () => {
  const res = 假响应()
  const 通过 = requireSameOrigin(带来源({ host: '127.0.0.1:13066', origin: 'http://evil.example' }), res)
  assert.equal(通过, false)
  assert.equal(res.statusCode, 403)
  const 体 = JSON.parse(res.体)
  assert.equal(体.ok, false)
  assert.equal(体.code, 'forbidden_origin')
  assert.match(体.hint, /同源/)
})

test('requireSameOrigin：同源时放行且不写响应', () => {
  const res = 假响应()
  assert.equal(
    requireSameOrigin(带来源({ host: '127.0.0.1:13066', origin: 'http://127.0.0.1:13066' }), res),
    true,
  )
  assert.equal(res.statusCode, null)
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
