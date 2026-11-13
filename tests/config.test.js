// 插件配置读写测试：全部落在临时目录，不碰真实 DSH 家目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ConfigStore,
  configVersion,
  defaultConfig,
  normalizeConfig,
  resolveConfigPath,
  unwrapConfigValue,
} from '../lib/config.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function storeFor(t) {
  const dir = tempDir(t)
  return { dir, store: new ConfigStore({ filePath: path.join(dir, 'restart-config.json') }) }
}

test('defaultConfig：默认关闭，且每次返回新对象', () => {
  const first = defaultConfig()
  assert.deepEqual(first, { version: configVersion, autoStart: false })
  first.autoStart = true
  assert.equal(defaultConfig().autoStart, false)
})

test('resolveConfigPath：DSH_HOME 优先', () => {
  assert.equal(resolveConfigPath({ DSH_HOME: 'C:\\Temp\\dsh-home' }), path.join('C:\\Temp\\dsh-home', 'restart-config.json'))
  assert.match(resolveConfigPath({}), /restart-config\.json$/)
})

test('load：文件不存在时返回默认值', (t) => {
  const { store } = storeFor(t)
  assert.deepEqual(store.load(), { version: configVersion, autoStart: false })
  assert.deepEqual(store.get(), { version: configVersion, autoStart: false })
})

test('save：写入文件，重新加载后仍在', (t) => {
  const { dir, store } = storeFor(t)
  const saved = store.save({ autoStart: true })
  assert.equal(saved.autoStart, true)
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'restart-config.json'), 'utf8'))
  assert.deepEqual(onDisk, { version: configVersion, autoStart: true })

  const reloaded = new ConfigStore({ filePath: path.join(dir, 'restart-config.json') })
  assert.equal(reloaded.load().autoStart, true)
})

test('load：配置文件优先于宿主传入的插件配置', (t) => {
  const { dir, store } = storeFor(t)
  fs.writeFileSync(path.join(dir, 'restart-config.json'), JSON.stringify({ version: 1, autoStart: false }))
  assert.equal(store.load({ autoStart: true }).autoStart, false)
})

test('load：没有配置文件时使用宿主传入的插件配置', (t) => {
  const { store } = storeFor(t)
  assert.equal(store.load({ autoStart: true }).autoStart, true)
})

test('load：volatile 引用会被解包成实际值', (t) => {
  const { store } = storeFor(t)
  const ref = {
    get: () => true,
    [Symbol.for('cosmokit.volatile.write')]: () => {},
  }
  assert.equal(store.load({ autoStart: ref }).autoStart, true)
  assert.equal(unwrapConfigValue(ref), true)
})

test('normalizeConfig：只认布尔 true，字符串 true 仍算关闭', () => {
  assert.equal(normalizeConfig({ autoStart: 'true' }).autoStart, false)
  assert.equal(normalizeConfig({ autoStart: 1 }).autoStart, false)
  assert.equal(normalizeConfig({ autoStart: true }).autoStart, true)
  assert.equal(normalizeConfig({}).autoStart, false)
})

test('load：配置文件损坏时按默认值继续', (t) => {
  const { dir, store } = storeFor(t)
  fs.writeFileSync(path.join(dir, 'restart-config.json'), '{ not json')
  assert.deepEqual(store.load(), { version: configVersion, autoStart: false })
})

test('save：空补丁保留当前值', (t) => {
  const { store } = storeFor(t)
  store.save({ autoStart: true })
  assert.equal(store.save({}).autoStart, true)
})

test('save：目标目录不存在时自动创建', (t) => {
  const dir = tempDir(t)
  const store = new ConfigStore({ filePath: path.join(dir, 'nested', 'restart-config.json') })
  assert.equal(store.save({ autoStart: true }).autoStart, true)
  assert.equal(fs.existsSync(path.join(dir, 'nested', 'restart-config.json')), true)
})

test('get：返回副本，外部修改不影响内部状态', (t) => {
  const { store } = storeFor(t)
  const value = store.get()
  value.autoStart = true
  assert.equal(store.get().autoStart, false)
})
