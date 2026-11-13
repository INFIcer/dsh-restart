// 开机自启动适配器测试：run 全部是假 runner，只记录命令，绝不读写真实注册表。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAutoStart,
  isNotFoundOutput,
  parseQueryOutput,
  quoteExecPath,
  sameCommand,
} from '../lib/autostart.js'
import { autoStartRunKey, autoStartValueName } from '../lib/constants.js'

const exe = 'D:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
const quotedExe = '"' + exe + '"'

function notFound() {
  return {
    ok: false,
    code: 1,
    stdout: '',
    stderr: 'ERROR: The system was unable to find the specified registry key or value.',
  }
}

function makeRegistry(initialCommand = null) {
  let command = initialCommand
  const calls = []
  async function run(itemName, args) {
    calls.push([itemName, args.slice()])
    if (args[0] === 'query') {
      if (command === null) return notFound()
      return {
        ok: true,
        code: 0,
        stdout: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    ' + autoStartValueName + '    REG_SZ    ' + command + '\r\n',
        stderr: '',
      }
    }
    if (args[0] === 'add') {
      command = args[args.indexOf('/d') + 1]
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'delete') {
      if (command === null) return notFound()
      command = null
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    return { ok: false, code: 2, stdout: '', stderr: 'unknown action' }
  }
  return { run, calls, getCommand: () => command, setCommand: (value) => { command = value } }
}

function makeAuto(runner, platform = 'win32') {
  return createAutoStart({ run: runner.run, execPath: exe, platform })
}

test('quoteExecPath：路径带引号，空值也不崩', () => {
  assert.equal(quoteExecPath(exe), quotedExe)
  assert.equal(quoteExecPath(''), '""')
  assert.equal(quoteExecPath(null), '""')
})

test('sameCommand：忽略大小写与首尾空白', () => {
  assert.equal(sameCommand(quotedExe, quotedExe.toUpperCase()), true)
  assert.equal(sameCommand('  ' + quotedExe + '  ', quotedExe), true)
  assert.equal(sameCommand(quotedExe, '"D:\\Other\\DeepSeek Harness.exe"'), false)
})

test('parseQueryOutput：取 REG_SZ 的值数据并去掉回车', () => {
  const text = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    DeepSeekHarness    REG_SZ    ' + quotedExe + '\r\n'
  assert.equal(parseQueryOutput(text), quotedExe)
  assert.equal(parseQueryOutput('nothing here'), null)
})

test('isNotFoundOutput：中英文报错都算不存在', () => {
  assert.equal(isNotFoundOutput('ERROR: The system was unable to find the specified registry key or value.'), true)
  assert.equal(isNotFoundOutput('错误: 系统找不到指定的注册表项或值。'), true)
  assert.equal(isNotFoundOutput('ERROR: Access is denied.'), false)
})

test('enable：写入 reg add 与带引号的当前路径', async () => {
  const registry = makeRegistry(null)
  const auto = makeAuto(registry)
  const result = await auto.enable()
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.present, true)
  assert.equal(result.command, quotedExe)
  assert.deepEqual(registry.calls[0], ['reg.exe', ['query', autoStartRunKey, '/v', autoStartValueName]])
  const addCall = registry.calls.find(([, args]) => args[0] === 'add')
  assert.deepEqual(addCall, [
    'reg.exe',
    ['add', autoStartRunKey, '/v', autoStartValueName, '/t', 'REG_SZ', '/d', quotedExe, '/f'],
  ])
})

test('enable：同值不重复写（幂等）', async () => {
  const registry = makeRegistry(quotedExe)
  const auto = makeAuto(registry)
  const result = await auto.enable()
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(registry.calls.some(([, args]) => args[0] === 'add'), false)
  assert.equal(registry.calls.length, 1)
})

test('enable：路径变化时更新成当前路径', async () => {
  const registry = makeRegistry('"D:\\Old\\DeepSeek Harness.exe"')
  const auto = makeAuto(registry)
  const result = await auto.enable()
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(registry.getCommand(), quotedExe)
  assert.equal(registry.calls.some(([, args]) => args[0] === 'add'), true)
})

test('disable：删除值并回读确认', async () => {
  const registry = makeRegistry(quotedExe)
  const auto = makeAuto(registry)
  const result = await auto.disable()
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.present, false)
  assert.equal(registry.getCommand(), null)
  assert.deepEqual(registry.calls.find(([, args]) => args[0] === 'delete'), [
    'reg.exe',
    ['delete', autoStartRunKey, '/v', autoStartValueName, '/f'],
  ])
})

test('disable：值本来就不存在时是幂等成功', async () => {
  const registry = makeRegistry(null)
  const auto = makeAuto(registry)
  const result = await auto.disable()
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.present, false)
  assert.equal(registry.calls.some(([, args]) => args[0] === 'delete'), false)
})

test('reconcile：开启与关闭分别走写入和删除', async () => {
  const enabled = makeRegistry(null)
  const enabledResult = await makeAuto(enabled).reconcile(true)
  assert.equal(enabledResult.ok, true)
  assert.equal(enabledResult.present, true)

  const disabled = makeRegistry(quotedExe)
  const disabledResult = await makeAuto(disabled).reconcile(false)
  assert.equal(disabledResult.ok, true)
  assert.equal(disabledResult.present, false)
  assert.equal(disabled.getCommand(), null)
})

test('失败：query 报错返回错误而不抛穿', async () => {
  const auto = createAutoStart({
    execPath: exe,
    platform: 'win32',
    run: async () => ({ ok: false, code: 5, stdout: '', stderr: 'ERROR: Access is denied.' }),
  })
  const result = await auto.reconcile(true)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'query-failed')
  assert.match(result.detail, /Access is denied/)
})

test('失败：写入失败返回 write-failed', async () => {
  const auto = createAutoStart({
    execPath: exe,
    platform: 'win32',
    run: async (itemName, args) =>
      args[0] === 'query'
        ? notFound()
        : { ok: false, code: 5, stdout: '', stderr: 'ERROR: Access is denied.' },
  })
  const result = await auto.enable()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'write-failed')
})

test('失败：删除失败返回 remove-failed', async () => {
  const auto = createAutoStart({
    execPath: exe,
    platform: 'win32',
    run: async (itemName, args) => {
      if (args[0] === 'query') {
        return {
          ok: true,
          code: 0,
          stdout: '    ' + autoStartValueName + '    REG_SZ    ' + quotedExe + '\r\n',
          stderr: '',
        }
      }
      return { ok: false, code: 5, stdout: '', stderr: 'ERROR: Access is denied.' }
    },
  })
  const result = await auto.disable()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'remove-failed')
})

test('失败：写入后回读不一致返回 verify-failed', async () => {
  const auto = createAutoStart({
    execPath: exe,
    platform: 'win32',
    run: async (itemName, args) => {
      if (args[0] === 'add') return { ok: true, code: 0, stdout: '', stderr: '' }
      return notFound()
    },
  })
  const result = await auto.enable()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'verify-failed')
  assert.equal(result.present, false)
})

test('失败：runner 抛异常也被接住', async () => {
  const auto = createAutoStart({
    execPath: exe,
    platform: 'win32',
    run: async () => {
      throw new Error('spawn failed')
    },
  })
  await assert.doesNotReject(async () => {
    const result = await auto.reconcile(false)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'query-failed')
  })
})

test('不支持平台：开启报错，关闭按无操作成功', async () => {
  const registry = makeRegistry(null)
  const auto = createAutoStart({ run: registry.run, execPath: exe, platform: 'linux' })
  const enabled = await auto.reconcile(true)
  assert.equal(enabled.ok, false)
  assert.equal(enabled.code, 'unsupported')
  const disabled = await auto.reconcile(false)
  assert.equal(disabled.ok, true)
  assert.equal(disabled.changed, false)
  assert.equal(registry.calls.length, 0)
})
