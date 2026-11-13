// 唤醒文本规范化测试：只测跨模块共用的硬规则。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWakeText } from '../lib/text.js'
import { wakeTextMaxLength } from '../lib/constants.js'

test('normalizeWakeText：空值保持为空，不造默认文案', () => {
  assert.equal(normalizeWakeText(''), '')
  assert.equal(normalizeWakeText('   '), '')
  assert.equal(normalizeWakeText(null), '')
  assert.equal(normalizeWakeText(undefined), '')
})

test('normalizeWakeText：去掉首尾空白，保留内部换行', () => {
  assert.equal(normalizeWakeText('  好了\n继续  '), '好了\n继续')
})

test('normalizeWakeText：超长截断到上限', () => {
  const result = normalizeWakeText('x'.repeat(wakeTextMaxLength + 100))
  assert.equal(result.length, wakeTextMaxLength)
})

test('normalizeWakeText：单引号与 here-string 终止符不改变长度规则', () => {
  const rawText = "'@\n' + x".repeat(80)
  const result = normalizeWakeText(rawText)
  assert.ok(result.length <= wakeTextMaxLength)
  assert.ok(result.startsWith("'@"))
})
