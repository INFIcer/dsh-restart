// 开机自启动：读写当前用户登录启动项。
//
// 选 HKCU Run 而不是计划任务：不需要管理员权限；任务管理器的「启动」页能看到、
// 能禁用；用户登录时由系统触发；关闭时只要删掉这个值。计划任务需要更高权限，
// 而且会多出一条用户不熟悉的计划任务。
//
// 这个模块只负责注册表读写与比对，不抛异常：调用方（宿主 / 设置路由）拿到
// {ok:false, code, detail} 后决定怎么提示用户、怎么记日志。

import { spawn } from 'node:child_process'
import { autoStartRunKey, autoStartValueName } from './constants.js'

/** 给可执行文件路径加引号：路径里通常有空格，注册表命令必须按带引号的命令行解析。 */
export function quoteExecPath(execPath) {
  return '"' + String(execPath || '') + '"'
}

/** 判断两个启动命令是否是同一个：Windows 路径大小写不敏感，注册表可能返回多余空白。 */
export function sameCommand(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase()
}

function escapeRegExp(value) {
  return String(value || '').replace(/[{}.+*?^$()|[\]\\]/g, '\\$&')
}

/**
 * 从 reg query 输出里取值数据。
 * 行格式示例：    DeepSeekHarness    REG_SZ    "D:\...\DeepSeek Harness.exe"
 */
export function parseQueryOutput(text, valueName = autoStartValueName) {
  const pattern = new RegExp('^\\s*' + escapeRegExp(valueName) + '\\s+REG_SZ\\s+(.*)$', 'mi')
  const match = pattern.exec(String(text || ''))
  if (!match) return null
  return match[1].trim()
}

/** reg 在值不存在时的报错因系统语言不同而不同，统一按「不存在」处理。 */
export function isNotFoundOutput(text) {
  const value = String(text || '')
  return /unable to find|not find|cannot find|找不到|无法找到/i.test(value)
}

function normalizeResult(result) {
  const code = Number.isInteger(result?.code) ? result.code : result?.ok === true ? 0 : null
  return {
    ok: result?.ok === true || code === 0,
    code,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
  }
}

/** 默认 runner：直接拉起系统 reg.exe，不经过 PowerShell，避免多层引号转义。 */
function createRegRunner() {
  return (command, args) =>
    new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let child
      try {
        child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        finish({ ok: false, code: null, stdout: '', stderr: String(error?.message || error) })
        return
      }
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      child.once('error', (error) => {
        finish({ ok: false, code: null, stdout, stderr: String(error?.message || error) })
      })
      child.once('close', (code) => {
        finish({ ok: code === 0, code, stdout, stderr })
      })
    })
}

function fail(code, detail, desired, extra = {}) {
  return { ok: false, code, detail: String(detail || ''), desired, ...extra }
}

/**
 * 创建一个开机自启动适配器。
 * @param {object} [options]
 * @param {(command:string,args:string[])=>Promise<object>} [options.run] 可注入的命令执行器；测试用假的记录命令
 * @param {string} [options.execPath] 要启动的可执行文件；默认取当前 DSH 进程
 * @param {string} [options.platform] 平台；默认 process.platform
 */
export function createAutoStart(options = {}) {
  const run = typeof options.run === 'function' ? options.run : createRegRunner()
  const execPath = String(options.execPath || process.execPath || '')
  const platform = String(options.platform || process.platform)
  const supported = platform === 'win32' && execPath.length > 0
  const desiredCommand = supported ? quoteExecPath(execPath) : ''

  async function runReg(args) {
    try {
      return normalizeResult(await run('reg.exe', args))
    } catch (error) {
      return { ok: false, code: null, stdout: '', stderr: String(error?.message || error) }
    }
  }

  async function query() {
    if (!supported) {
      return fail('unsupported', '平台或可执行文件路径不可用', false, {
        supported: false,
        present: false,
        command: null,
      })
    }
    const result = await runReg(['query', autoStartRunKey, '/v', autoStartValueName])
    const output = result.stdout + '\n' + result.stderr
    if (result.ok) {
      const command = parseQueryOutput(output)
      if (command === null) return fail('parse-failed', output.trim(), false, { supported: true })
      return { ok: true, supported: true, present: true, command, desired: false }
    }
    // reg query 找不到值通常返回 1；输出可能被系统转成非 UTF-8 而看不出原文，
    // 所以退出码 1 也按「不存在」处理，后续写入/删除的回读校验会兜住真正的失败。
    if (result.code === 1 || isNotFoundOutput(output)) {
      return { ok: true, supported: true, present: false, command: null, desired: false }
    }
    return fail('query-failed', output.trim() || 'reg query 失败', false, { supported: true })
  }

  async function enable() {
    if (!supported) return fail('unsupported', '平台或可执行文件路径不可用', true, { supported: false })
    const current = await query()
    if (!current.ok) return { ...current, desired: true }
    if (current.present && sameCommand(current.command, desiredCommand)) {
      return {
        ok: true,
        supported: true,
        changed: false,
        present: true,
        command: current.command,
        desired: true,
      }
    }
    const write = await runReg(['add', autoStartRunKey, '/v', autoStartValueName, '/t', 'REG_SZ', '/d', desiredCommand, '/f'])
    if (!write.ok) {
      return fail('write-failed', (write.stderr || write.stdout).trim(), true, { supported: true })
    }
    const verified = await query()
    if (!verified.ok) {
      return fail('verify-failed', verified.detail, true, { supported: true, present: verified.present === true })
    }
    if (!verified.present || !sameCommand(verified.command, desiredCommand)) {
      return fail('verify-failed', '写入后回读的启动命令不一致', true, {
        supported: true,
        present: verified.present === true,
        command: verified.command || '',
      })
    }
    return {
      ok: true,
      supported: true,
      changed: true,
      present: true,
      command: verified.command,
      desired: true,
    }
  }

  async function disable() {
    if (!supported) {
      return { ok: true, supported: false, changed: false, present: false, command: null, desired: false }
    }
    const current = await query()
    if (!current.ok) return { ...current, desired: false }
    if (!current.present) {
      return { ok: true, supported: true, changed: false, present: false, command: null, desired: false }
    }
    const removed = await runReg(['delete', autoStartRunKey, '/v', autoStartValueName, '/f'])
    if (!removed.ok) {
      const output = removed.stderr + '\n' + removed.stdout
      if (!isNotFoundOutput(output)) {
        return fail('remove-failed', output.trim(), false, { supported: true })
      }
    }
    const verified = await query()
    if (!verified.ok) {
      return fail('verify-failed', verified.detail, false, { supported: true, present: verified.present === true })
    }
    if (verified.present) {
      return fail('verify-failed', '删除后启动项仍然存在', false, { supported: true, present: true, command: verified.command })
    }
    return { ok: true, supported: true, changed: true, present: false, command: null, desired: false }
  }

  /** 把启动项对齐到 enabled：开启就补齐/改成当前路径，关闭就删掉。 */
  async function reconcile(enabled) {
    const desired = enabled === true
    try {
      return desired ? await enable() : await disable()
    } catch (error) {
      return fail('internal', String(error?.message || error), desired)
    }
  }

  return {
    supported,
    execPath,
    desiredCommand,
    query,
    enable,
    disable,
    reconcile,
  }
}
