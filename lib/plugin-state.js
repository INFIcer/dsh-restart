// 重启前后保护 profile 里的插件启用设置。
//
// 为什么要做：重启本身不写插件配置，但重启链路上的其它步骤（例如 dsh plugin 的
// 对齐逻辑）可能把 profile 的 package.json / cordis.patch.yml 改回去，表现为
// "重启后非官方插件又被全部启用"。这里只做一道保险：重启前按字节快照，旧进程
// 退出后写回，新进程端口就绪后再核对一次。
//
// 为什么不解析 cordis.patch.yml：它是用户手写的 YAML（注释、缩进、锚点都算内容），
// 解析再序列化会悄悄改掉格式，所以补丁文件只按字节搬运；package.json 只在读快照时
// 校验能否 JSON.parse，用来判断这份快照是否可信。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  pluginBackupKeepCount,
  pluginBackupSuffix,
  pluginName,
  pluginSnapshotKeepCount,
  profileManifestFileName,
  profilePatchFileName,
} from './constants.js'
import { ensureDir, exists } from './fsutil.js'
import { resolveHome } from './script.js'

/** 快照/备份文件名里的时间戳格式：只含文件名安全字符，且按字典序等于按时间排序。 */
const snapshotNamePattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/

/** 受保护文件的顺序：先清单后补丁，快照、恢复、比较都按这个顺序。 */
export function protectedFileNames() {
  return [profileManifestFileName, profilePatchFileName]
}

/** 快照目录名：ISO 时间戳里的 ':' 与 '.' 在 Windows 文件名里非法，换成 '-'。 */
export function formatSnapshotStamp(now = Date.now()) {
  const ms = Number(now)
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  return date.toISOString().replace(/[:.]/g, '-')
}

/** 备份后缀里的时间戳：本地可读的 yyyyMMdd-HHmmss-SSS。 */
export function formatBackupStamp(now = Date.now()) {
  const ms = Number(now)
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  const iso = date.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${iso.slice(20, 23)}`
}

/** 判断一个目录名是不是本插件生成的快照目录（用于修剪，绝不误删别的目录）。 */
export function isSnapshotDirName(name) {
  return snapshotNamePattern.test(String(name || ''))
}

/** 判断文件名是不是本插件生成的恢复备份（用于修剪，别的插件的备份不碰）。 */
export function isPluginBackupName(fileName, name) {
  const base = String(fileName || '')
  if (!base) return false
  const expectedPrefix = `${base}${pluginBackupSuffix}`
  const actual = String(name || '')
  if (!actual.startsWith(expectedPrefix)) return false
  return /^\d{8}-\d{6}-\d{3}$/.test(actual.slice(expectedPrefix.length))
}

/** 插件自身根目录：probe 时用来判断哪个 profile 的 node_modules 链接到了本插件。 */
const pluginRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 解析当前 profile 目录。顺序：显式注入（测试/调用方）→ DSH_PROFILE_DIR →
 * DSH_PROFILE 拼家目录 → 扫描 profiles 目录。每一步都要求目录里有 package.json；
 * 拿不到唯一结果就返回 ok:false，调用方安全跳过，不当成错误。
 *
 * probe 的优先级：node_modules/dsh-restart-plugin 经 realpath 能指回本插件目录的
 * 候选（兼容 link: 安装）→ 多个都指回时优先 desktop → 都不指回时优先 desktop，
 * 否则只在候选唯一时采用。桌面端进程不设 DSH_PROFILE_DIR，这条信号用来区分
 * 同时存在的 desktop 与遗留 profile。
 */
export function resolveProfileDir(options = {}) {
  const env = options.env || {}
  const explicit = String(options.profileDir || '').trim()
  if (explicit) {
    const resolved = checkProfileDir(explicit, 'option')
    if (resolved) return resolved
  }

  const fromEnv = String(env.DSH_PROFILE_DIR || '').trim()
  if (fromEnv) {
    const resolved = checkProfileDir(fromEnv, 'env')
    if (resolved) return resolved
  }

  const homeDir = String(options.homeDir || '').trim() || resolveHome(env)
  const profileName = String(env.DSH_PROFILE || '').trim()
  if (profileName && !/[\\/]/.test(profileName) && profileName !== '.' && profileName !== '..') {
    const resolved = checkProfileDir(path.join(homeDir, 'profiles', profileName), 'profile')
    if (resolved) return resolved
  }

  const probed = probeProfileDir(homeDir, options.pluginRoot)
  if (probed) return { ok: true, dir: probed, source: 'probe' }
  return {
    ok: false,
    dir: '',
    source: 'none',
    error: '无法确定当前 profile 目录（缺少 DSH_PROFILE_DIR / DSH_PROFILE，profiles 下也没有可唯一确定的候选）',
  }
}

/** 目录里必须有 package.json 才算 profile；不合格返回 null，让调用方继续往下一优先级找。 */
function checkProfileDir(dir, source) {
  const resolved = path.resolve(dir)
  return exists(path.join(resolved, profileManifestFileName)) ? { ok: true, dir: resolved, source } : null
}

/** 真实路径：消解 link: 符号链接；读不到（没装、坏链）返回空串。 */
function realPathOrEmpty(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return ''
  }
}

function isPluginLinked(candidate, pluginRealRoot) {
  const linked = realPathOrEmpty(path.join(candidate, 'node_modules', pluginName))
  if (!linked || !pluginRealRoot) return false
  return process.platform === 'win32'
    ? linked.toLowerCase() === pluginRealRoot.toLowerCase()
    : linked === pluginRealRoot
}

/** 扫描 profiles 下带 package.json 的候选，按插件链接信号与 desktop 名字消歧。 */
function probeProfileDir(homeDir, pluginRoot) {
  try {
    const root = path.join(homeDir, 'profiles')
    const entries = fs.readdirSync(root, { withFileTypes: true })
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .filter((dir) => exists(path.join(dir, profileManifestFileName)))
    if (candidates.length === 0) return ''

    const pluginRealRoot = realPathOrEmpty(pluginRoot ? path.resolve(pluginRoot) : pluginRootDir)
    const linked = candidates.filter((dir) => isPluginLinked(dir, pluginRealRoot))
    const pool = linked.length > 0 ? linked : candidates
    const desktop = pool.find((dir) => path.basename(dir).toLowerCase() === 'desktop')
    if (desktop) return desktop
    return pool.length === 1 ? pool[0] : ''
  } catch {
    return ''
  }
}

/** 原子写字节：先写同目录临时文件再 rename，避免读到写了一半的配置。 */
function writeBytesAtomic(file, bytes) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 临时文件清理失败不影响主流程 */
    }
    throw error
  }
}

/** 读文件字节；不存在返回 null（用来区分"没这个文件"和"读失败"）。 */
function readBytesOrNull(file) {
  try {
    return fs.readFileSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** 从 package.json 字节里读 dsh.profile.bundles；格式不对返回 null（不猜）。 */
export function readBundleNames(bytes) {
  if (!bytes) return null
  try {
    const text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')
    const doc = JSON.parse(text)
    const bundles = doc?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return null
    return bundles.map((item) => String(item))
  } catch {
    return null
  }
}

/** 从 cordis.patch.yml 里挑出 disabled 相关行（只做文本比对，不解析 YAML）。 */
export function readDisabledLines(bytes) {
  if (!bytes) return []
  const text = Buffer.from(bytes).toString('utf8')
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/\bdisabled\s*:/i.test(line)) lines.push(line)
  }
  return Array.from(new Set(lines))
}

function diffLines(before, after) {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((line) => !beforeSet.has(line)),
    removed: before.filter((line) => !afterSet.has(line)),
    disabledChanged: before.join('\n') !== after.join('\n'),
  }
}

function byteEqual(a, b) {
  if (!a || !b) return a === b
  return Buffer.compare(a, b) === 0
}

/**
 * 快照 profile 里的两个文件。必须在强杀旧进程之前调用。
 *
 * 写进 snapshotsRoot/<时间戳>/，只保留最近 pluginSnapshotKeepCount 份。
 * 任何失败都只返回 ok:false 让调用方记日志，不删别的文件、不阻断重启。
 */
export function createPluginSnapshot(options = {}) {
  const log = options.log
  const now = options.now ?? Date.now()
  const profileDir = String(options.profileDir || '').trim()
  const snapshotsRoot = String(options.snapshotsRoot || '').trim()
  if (!profileDir || !snapshotsRoot) {
    return { ok: false, code: 'no_path', error: '缺少 profile 目录或快照目录' }
  }
  if (!exists(profileDir)) {
    return { ok: false, code: 'missing_profile', error: `找不到 profile 目录 ${profileDir}` }
  }

  // 先把所有要保护的文件读进内存并校验，再落盘：避免留下"缺 package.json"的半份快照。
  const payload = new Map()
  for (const fileName of protectedFileNames()) {
    let bytes
    try {
      bytes = readBytesOrNull(path.join(profileDir, fileName))
    } catch (error) {
      return { ok: false, code: 'read_failed', error: `读取 ${fileName} 失败：${error?.message || error}` }
    }
    if (!bytes) continue
    if (fileName === profileManifestFileName) {
      try {
        JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
      } catch (error) {
        return { ok: false, code: 'bad_json', error: `${fileName} 不是合法 JSON：${error?.message || error}` }
      }
    }
    payload.set(fileName, bytes)
  }
  if (payload.size === 0) {
    return { ok: false, code: 'missing_files', error: 'profile 里没有可快照的插件设置文件' }
  }

  const stamp = formatSnapshotStamp(now)
  let snapshotDir = path.join(snapshotsRoot, stamp)
  // 同一毫秒内重复快照（测试或手动连点）时加序号，避免覆盖上一份。
  for (let index = 1; exists(snapshotDir); index += 1) {
    snapshotDir = path.join(snapshotsRoot, `${stamp}-${index}`)
  }

  try {
    ensureDir(snapshotDir)
    for (const [fileName, bytes] of payload) {
      writeBytesAtomic(path.join(snapshotDir, fileName), bytes)
    }
  } catch (error) {
    log?.warn?.(`插件设置快照写入失败：${error?.message || error}`)
    return { ok: false, code: 'write_failed', error: `写快照失败：${error?.message || error}` }
  }

  const pruned = prunePluginSnapshots(snapshotsRoot, pluginSnapshotKeepCount)
  return {
    ok: true,
    dir: snapshotDir,
    profileDir,
    files: Array.from(payload.keys()),
    createdAt: new Date(now).toISOString(),
    pruned,
  }
}

/** 只删本插件命名的快照目录，按名字排序保留最新 keep 份。 */
export function prunePluginSnapshots(snapshotsRoot, keep = pluginSnapshotKeepCount) {
  const root = String(snapshotsRoot || '').trim()
  if (!root) return []
  try {
    const names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSnapshotDirName(entry.name))
      .map((entry) => entry.name)
      .sort()
    const limit = Math.max(0, Number(keep) || 0)
    const removed = names.slice(0, Math.max(0, names.length - limit))
    for (const name of removed) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
    }
    return removed
  } catch {
    return []
  }
}

/**
 * 把快照写回 profile。调用时机：旧进程全部退出后、拉起 DSH 之前。
 * 每覆盖一个被改过的文件，先把当前内容另存为 .bak-restart-<时间戳>。
 */
export function restorePluginSnapshot(options = {}) {
  const log = options.log
  const now = options.now ?? Date.now()
  const profileDir = String(options.profileDir || '').trim()
  const snapshotDir = String(options.snapshotDir || '').trim()
  const result = { ok: false, restored: [], unchanged: [], missing: [], backups: [], errors: [] }

  if (!profileDir || !snapshotDir || !exists(snapshotDir)) {
    result.error = '缺少快照目录或目标 profile 目录'
    return result
  }
  if (!exists(profileDir)) {
    result.error = `找不到 profile 目录 ${profileDir}`
    return result
  }

  for (const fileName of protectedFileNames()) {
    const source = path.join(snapshotDir, fileName)
    const target = path.join(profileDir, fileName)
    let snapshotBytes
    try {
      snapshotBytes = readBytesOrNull(source)
    } catch (error) {
      result.errors.push(`读取快照 ${fileName} 失败：${error?.message || error}`)
      continue
    }
    if (!snapshotBytes) {
      result.missing.push(fileName)
      continue
    }

    let currentBytes
    try {
      currentBytes = readBytesOrNull(target)
    } catch (error) {
      result.errors.push(`读取 ${fileName} 失败：${error?.message || error}`)
      continue
    }
    if (byteEqual(currentBytes, snapshotBytes)) {
      result.unchanged.push(fileName)
      continue
    }

    // 覆盖前先留底；留底失败就不覆盖，宁可这次不一致也不吞掉当前内容。
    if (currentBytes) {
      const backupFile = `${target}${pluginBackupSuffix}${formatBackupStamp(now)}`
      try {
        writeBytesAtomic(backupFile, currentBytes)
        prunePluginBackups(profileDir, fileName, pluginBackupKeepCount)
        result.backups.push(backupFile)
      } catch (error) {
        result.errors.push(`备份 ${fileName} 失败：${error?.message || error}`)
        continue
      }
    }

    try {
      writeBytesAtomic(target, snapshotBytes)
      result.restored.push(fileName)
    } catch (error) {
      result.errors.push(`写回 ${fileName} 失败：${error?.message || error}`)
    }
  }

  result.ok = result.errors.length === 0
  if (!result.ok) log?.warn?.(result.errors.join('；'))
  return result
}

/** 只删本插件自己那套备份，按时间保留最新 keep 份。 */
export function prunePluginBackups(profileDir, fileName, keep = pluginBackupKeepCount) {
  try {
    const names = fs
      .readdirSync(profileDir)
      .filter((name) => isPluginBackupName(fileName, name))
      .sort()
    const limit = Math.max(0, Number(keep) || 0)
    const removed = names.slice(0, Math.max(0, names.length - limit))
    for (const name of removed) fs.rmSync(path.join(profileDir, name), { force: true })
    return removed
  } catch {
    return []
  }
}

/**
 * 按字节比较快照与当前 profile；不一致时给出人能看懂的 diff 摘要
 * （bundles 增删了哪些名字、patch 的 disabled 行有没有变）。
 */
export function comparePluginState(options = {}) {
  const profileDir = String(options.profileDir || '').trim()
  const snapshotDir = String(options.snapshotDir || '').trim()
  if (!profileDir || !snapshotDir || !exists(snapshotDir)) {
    return { ok: false, code: 'missing_snapshot', error: '没有可比较的快照目录' }
  }
  if (!exists(profileDir)) {
    return { ok: false, code: 'missing_profile', error: `找不到 profile 目录 ${profileDir}` }
  }

  const differing = []
  const missing = []
  let compared = 0
  let manifestBefore = null
  let manifestAfter = null
  let patchBefore = null
  let patchAfter = null

  for (const fileName of protectedFileNames()) {
    let snapshotBytes
    try {
      snapshotBytes = readBytesOrNull(path.join(snapshotDir, fileName))
    } catch (error) {
      return { ok: false, code: 'read_failed', error: `读取快照 ${fileName} 失败：${error?.message || error}` }
    }
    if (!snapshotBytes) continue
    compared += 1
    let currentBytes
    try {
      currentBytes = readBytesOrNull(path.join(profileDir, fileName))
    } catch (error) {
      return { ok: false, code: 'read_failed', error: `读取 ${fileName} 失败：${error?.message || error}` }
    }
    if (!currentBytes) {
      missing.push(fileName)
      continue
    }
    if (!byteEqual(currentBytes, snapshotBytes)) differing.push(fileName)
    if (fileName === profileManifestFileName) {
      manifestBefore = snapshotBytes
      manifestAfter = currentBytes
    }
    if (fileName === profilePatchFileName) {
      patchBefore = snapshotBytes
      patchAfter = currentBytes
    }
  }

  const beforeBundles = readBundleNames(manifestBefore) || []
  const afterBundles = readBundleNames(manifestAfter) || []
  const beforeSet = new Set(beforeBundles)
  const afterSet = new Set(afterBundles)

  return {
    ok: true,
    consistent: compared > 0 && differing.length === 0 && missing.length === 0,
    compared,
    differing,
    missing,
    bundleDiff: {
      added: afterBundles.filter((name) => !beforeSet.has(name)),
      removed: beforeBundles.filter((name) => !afterSet.has(name)),
    },
    patchDiff: diffLines(readDisabledLines(patchBefore), readDisabledLines(patchAfter)),
  }
}

/** 重启后的校验：一致就返回；不一致再写回一次，并返回恢复前后的两份比较结果。 */
export function verifyPluginStateAfterBoot(options = {}) {
  const before = comparePluginState(options)
  if (!before.ok) {
    return { ok: false, consistent: false, restored: false, before, error: before.error }
  }
  if (before.consistent) {
    return { ok: true, consistent: true, restored: false, before }
  }
  const restore = restorePluginSnapshot(options)
  const after = comparePluginState(options)
  return {
    ok: after.ok === true,
    consistent: after.ok === true && after.consistent === true,
    restored: true,
    before,
    restore,
    after,
  }
}

function shortList(list, max = 6) {
  const items = Array.isArray(list) ? list : []
  if (items.length <= max) return items.join(', ')
  return `${items.slice(0, max).join(', ')} 等 ${items.length} 项`
}

/** 把比较结果压成一行日志用的中文摘要。 */
export function summarizePluginDiff(comparison) {
  const parts = []
  const bundleDiff = comparison?.bundleDiff || {}
  const added = bundleDiff.added || []
  const removed = bundleDiff.removed || []
  if (added.length === 0 && removed.length === 0) {
    parts.push('bundles 无增删')
  } else {
    parts.push(`bundles 新增 [${shortList(added)}]、移除 [${shortList(removed)}]`)
  }
  const patchDiff = comparison?.patchDiff || {}
  if (patchDiff.disabledChanged) {
    parts.push(
      `cordis.patch.yml 的 disabled 行有变化（+${(patchDiff.added || []).length}/-${(patchDiff.removed || []).length}）`
    )
  } else {
    parts.push('cordis.patch.yml 的 disabled 行无变化')
  }
  if (comparison?.missing?.length) parts.push(`缺失 [${shortList(comparison.missing)}]`)
  return parts.join('；')
}
