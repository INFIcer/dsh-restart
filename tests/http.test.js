// HTTP 小工具测试：假 req / 假 res，不启动服务器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { sendJson, readRequestBody, methodNotAllowed, checkRequestOrigin, requireSameOrigin } from '../lib/http.js'

function fakeResponse() {
  const res = {
    statusCode: null,
    head: {},
    body: '',
    setHeader(itemName, value) {
      res.head[String(itemName).toLowerCase()] = value
    },
    end(text) {
      res.body = String(text ?? '')
    },
  }
  return res
}

function fakeRequest(method = 'GET', body = '') {
  const request = Readable.from([Buffer.from(body)])
  request.method = method
  return request
}

test('回JSON：设置状态码与 JSON 头', () => {
  const res = fakeResponse()
  assert.equal(sendJson(res, 201, { ok: true }), true)
  assert.equal(res.statusCode, 201)
  assert.match(res.head['content-type'], /application\/json/)
  assert.equal(res.head['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(res.body), { ok: true })
})

test('回JSON：没有 res.end 时返回 false 不抛', () => {
  assert.equal(sendJson(null, 200, {}), false)
  assert.equal(sendJson({}, 200, {}), false)
})

test('回JSON：循环引用时回 500 而不是抛', () => {
  const res = fakeResponse()
  const circular = {}
  circular.self = circular
  sendJson(res, 200, circular)
  assert.equal(res.statusCode, 500)
  assert.match(res.body, /响应序列化失败/)
})

test('读请求体：解析正常 JSON', async () => {
  const result = await readRequestBody(fakeRequest('POST', '{"taskId":"restart-1"}'))
  assert.equal(result.ok, true)
  assert.equal(result.value.taskId, 'restart-1')
})

test('读请求体：空体返回空对象', async () => {
  const result = await readRequestBody(fakeRequest('POST', ''))
  assert.deepEqual(result, { ok: true, value: {} })
})

test('读请求体：坏 JSON 返回 bad_json', async () => {
  const result = await readRequestBody(fakeRequest('POST', '{oops'))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_json')
})

test('读请求体：超过上限返回 too_large', async () => {
  const result = await readRequestBody(fakeRequest('POST', 'x'.repeat(200)), 100)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'too_large')
})

test('读请求体：没有可读流时按空对象处理', async () => {
  const result = await readRequestBody({})
  assert.deepEqual(result, { ok: true, value: {} })
})

// ———————————————————————— 同源校验 ————————————————————————

function withOrigin(originHeader = {}) {
  return { headers: originHeader }
}

test('来源校验：没有请求头时放行（非浏览器调用）', () => {
  assert.equal(checkRequestOrigin({}).ok, true)
  assert.equal(checkRequestOrigin({ headers: {} }).ok, true)
})

test('来源校验：Origin 与 Host 同主机同端口放行', () => {
  assert.equal(
    checkRequestOrigin(withOrigin({ host: '127.0.0.1:13066', origin: 'http://127.0.0.1:13066' })).ok,
    true,
  )
})

test('来源校验：端口从请求头推导，不写死', () => {
  assert.equal(
    checkRequestOrigin(withOrigin({ host: '127.0.0.1:54321', origin: 'http://127.0.0.1:54321' })).ok,
    true,
  )
  assert.equal(
    checkRequestOrigin(withOrigin({ host: 'localhost:8080', origin: 'http://localhost:9999' })).ok,
    false,
  )
})

test('来源校验：Host 无端口时按来源自身协议的默认端口比对', () => {
  // Host 头不带端口时无法知道协议，只能按 Origin 的协议取默认端口（80/443），不能写死端口。
  assert.equal(checkRequestOrigin(withOrigin({ host: 'example.com', origin: 'https://example.com' })).ok, true)
  assert.equal(checkRequestOrigin(withOrigin({ host: 'example.com', origin: 'http://example.com' })).ok, true)
  assert.equal(checkRequestOrigin(withOrigin({ host: 'example.com', origin: 'https://example.com:8443' })).ok, false)
})

test('来源校验：Referer 与 Host 不同源时拒绝', () => {
  assert.equal(
    checkRequestOrigin(withOrigin({ host: '127.0.0.1:13066', referer: 'http://evil.example/x' })).ok,
    false,
  )
  assert.equal(
    checkRequestOrigin(withOrigin({ host: '127.0.0.1:13066', referer: 'http://127.0.0.1:13066/x' })).ok,
    true,
  )
})

test('来源校验：Origin=null 拒绝', () => {
  assert.equal(checkRequestOrigin(withOrigin({ host: '127.0.0.1:13066', origin: 'null' })).ok, false)
})

test('来源校验：Sec-Fetch-Site 只接受 same-origin / none', () => {
  assert.equal(
    checkRequestOrigin(withOrigin({ 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:13066', host: '127.0.0.1:13066' })).ok,
    false,
  )
  assert.equal(checkRequestOrigin(withOrigin({ 'sec-fetch-site': 'same-origin', host: '127.0.0.1:13066' })).ok, true)
  assert.equal(checkRequestOrigin(withOrigin({ 'sec-fetch-site': 'none' })).ok, true)
})

test('来源校验：缺 Host 时无法比对，拒绝', () => {
  assert.equal(checkRequestOrigin(withOrigin({ origin: 'http://127.0.0.1:13066' })).ok, false)
})

test('requireSameOrigin：拒绝时回 403 forbidden_origin', () => {
  const res = fakeResponse()
  const passed = requireSameOrigin(withOrigin({ host: '127.0.0.1:13066', origin: 'http://evil.example' }), res)
  assert.equal(passed, false)
  assert.equal(res.statusCode, 403)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'forbidden_origin')
  assert.match(body.hint, /同源/)
})

test('requireSameOrigin：同源时放行且不写响应', () => {
  const res = fakeResponse()
  assert.equal(
    requireSameOrigin(withOrigin({ host: '127.0.0.1:13066', origin: 'http://127.0.0.1:13066' }), res),
    true,
  )
  assert.equal(res.statusCode, null)
})

test('方法允许：匹配放行', () => {
  const res = fakeResponse()
  assert.equal(methodNotAllowed(fakeRequest('get'), res, ['GET']), true)
  assert.equal(res.statusCode, null)
})

test('方法允许：不匹配回 405 并带 allow 头', () => {
  const res = fakeResponse()
  assert.equal(methodNotAllowed(fakeRequest('DELETE'), res, ['GET', 'POST']), false)
  assert.equal(res.statusCode, 405)
  assert.equal(res.head.allow, 'GET, POST')
  assert.deepEqual(JSON.parse(res.body).code, 'method_not_allowed')
})
