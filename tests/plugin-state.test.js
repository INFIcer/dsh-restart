// 插件启用设置保护：快照、修剪、写回、开机校验。全部用临时目录，不碰真实 profile。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  comparePluginState,
  createPluginSnapshot,
  formatBackupStamp,
  formatSnapshotStamp,
  isPluginBackupName,
  isSnapshotDirName,
  prunePluginBackups,
  prunePluginSnapshots,
  readBundleNames,
  readDisabledLines,
  resolveProfileDir,
  restorePluginSnapshot,
  summarizePluginDiff,
  verifyPluginStateAfterBoot,
} from '../lib/plugin-state.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-plugin-state-'))
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return dir
}

const manifestText = (bundles) =>
  JSON.stringify({ name: 'desktop-profile', dsh: { profile: { bundles } } }, null, 2) + '\n'

const patchText = (disabled) => ['# 用户手写补丁', 'plugins:', '  - id: some-plugin', `    disabled: ${disabled}`, ''].join('\n')

/** 造一份临时 profile：package.json + cordis.patch.yml。 */
function makeProfile(root, options = {}) {
  const profileDir = path.join(root, 'profiles', 'desktop')
  fs.mkdirSync(profileDir, { recursive: true })
  // null 表示"这个文件不存在"，所以不能用 ?? 合并（null 会被当成缺省值）。
  const manifest = Object.hasOwn(options, 'manifest') ? options.manifest : manifestText(options.bundles ?? ['alpha', 'beta'])
  const patch = Object.hasOwn(options, 'patch') ? options.patch : patchText(options.disabled ?? true)
  if (manifest !== null) fs.writeFileSync(path.join(profileDir, 'package.json'), manifest)
  if (patch !== null) fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch)
  return { profileDir, manifest, patch, snapshotsRoot: path.join(root, 'plugin-snapshots') }
}

// ———————————————————————— 快照 ————————————————————————

test('快照：两个文件按字节写入快照目录', (t) => {
  const root = tempDir(t)
  const { profileDir, manifest, patch, snapshotsRoot } = makeProfile(root)
  const now = Date.parse('2026-11-12T22:21:00.123Z')

  const result = createPluginSnapshot({ profileDir, snapshotsRoot, now })

  assert.equal(result.ok, true)
  assert.equal(result.dir, path.join(snapshotsRoot, '2026-11-12T22-21-00-123Z'))
  assert.equal(result.profileDir, profileDir)
  assert.deepEqual(result.files, ['package.json', 'cordis.patch.yml'])
  assert.equal(result.createdAt, '2026-11-12T22:21:00.123Z')
  assert.equal(fs.readFileSync(path.join(result.dir, 'package.json'), 'utf8'), manifest)
  assert.equal(fs.readFileSync(path.join(result.dir, 'cordis.patch.yml'), 'utf8'), patch)
})

test('快照：超过 5 份时删最旧的整目录，非快照目录不碰', (t) => {
  const root = tempDir(t)
  const { profileDir, snapshotsRoot } = makeProfile(root)
  const base = Date.parse('2026-11-12T22:00:00.000Z')
  for (let index = 0; index < 7; index += 1) {
    assert.equal(createPluginSnapshot({ profileDir, snapshotsRoot, now: base + index * 1000 }).ok, true)
  }
  fs.mkdirSync(path.join(snapshotsRoot, 'not-a-snapshot'))

  const names = fs.readdirSync(snapshotsRoot).sort()
  assert.equal(names.filter(isSnapshotDirName).length, 5)
  assert.ok(names.includes('not-a-snapshot'))
  assert.ok(!names.includes('2026-11-12T22-00-00-000Z'))
  assert.ok(!names.includes('2026-11-12T22-00-01-000Z'))
  assert.ok(names.includes('2026-11-12T22-00-06-000Z'))
})

test('快照：package.json 不是合法 JSON 时既不快照也不抛', (t) => {
  const root = tempDir(t)
  const { profileDir, snapshotsRoot } = makeProfile(root, { manifest: '{"dsh": ' })
  const result = createPluginSnapshot({ profileDir, snapshotsRoot, now: Date.now() })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_json')
  assert.equal(fs.existsSync(snapshotsRoot), false)
})

test('快照：profile 目录不存在时安全跳过', (t) => {
  const root = tempDir(t)
  const result = createPluginSnapshot({
    profileDir: path.join(root, 'missing-profile'),
    snapshotsRoot: path.join(root, 'plugin-snapshots'),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'missing_profile')
  assert.equal(fs.existsSync(path.join(root, 'plugin-snapshots')), false)
})

test('快照：两个文件都不在时跳过；只剩补丁时只快照补丁', (t) => {
  const root = tempDir(t)
  const empty = makeProfile(root, { manifest: null, patch: null })
  assert.equal(createPluginSnapshot({ profileDir: empty.profileDir, snapshotsRoot: empty.snapshotsRoot }).code, 'missing_files')

  const root2 = tempDir(t)
  const onlyPatch = makeProfile(root2, { manifest: null })
  const result = createPluginSnapshot({ profileDir: onlyPatch.profileDir, snapshotsRoot: onlyPatch.snapshotsRoot })
  assert.equal(result.ok, true)
  assert.deepEqual(result.files, ['cordis.patch.yml'])
})

test('快照目录名只含文件名安全字符，且按名字排序等于按时间排序', () => {
  const first = formatSnapshotStamp(Date.parse('2026-11-12T22:21:00.123Z'))
  const second = formatSnapshotStamp(Date.parse('2026-11-12T22:21:01.456Z'))
  assert.equal(first, '2026-11-12T22-21-00-123Z')
  assert.ok(!first.includes(':'))
  assert.ok(!first.includes('.'))
  assert.ok(first < second)
  assert.ok(isSnapshotDirName(first))
  assert.ok(!isSnapshotDirName('plugin-snapshots'))
})

// ———————————————————————— 写回 ————————————————————————

test('写回：覆盖被改写的文件，当前内容另存 .bak-restart-<时间戳>', (t) => {
  const root = tempDir(t)
  const { profileDir, manifest, patch, snapshotsRoot } = makeProfile(root)
  const snapshot = createPluginSnapshot({ profileDir, snapshotsRoot, now: Date.parse('2026-11-12T22:21:00.123Z') })
  fs.writeFileSync(path.join(profileDir, 'package.json'), manifestText(['alpha', 'beta', 'intruder']))
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchText(false))

  const result = restorePluginSnapshot({
    snapshotDir: snapshot.dir,
    profileDir,
    now: Date.parse('2026-11-12T22:30:00.000Z'),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.restored, ['package.json', 'cordis.patch.yml'])
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), manifest)
  assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), patch)
  assert.equal(result.backups.length, 2)
  const manifestBackup = path.join(profileDir, 'package.json.bak-restart-20261112-223000-000')
  assert.equal(fs.readFileSync(manifestBackup, 'utf8'), manifestText(['alpha', 'beta', 'intruder']))
  assert.ok(isPluginBackupName('package.json', path.basename(manifestBackup)))
})

test('写回：内容一致时不动文件也不产生备份', (t) => {
  const root = tempDir(t)
  const { profileDir, snapshotsRoot } = makeProfile(root)
  const snapshot = createPluginSnapshot({ profileDir, snapshotsRoot, now: Date.now() })
  const result = restorePluginSnapshot({ snapshotDir: snapshot.dir, profileDir, now: Date.now() })
  assert.equal(result.ok, true)
  assert.deepEqual(result.unchanged, ['package.json', 'cordis.patch.yml'])
  assert.deepEqual(result.restored, [])
  assert.deepEqual(result.backups, [])
})

test('写回：最多保留 3 份自己的备份，别的插件备份不删', (t) => {
  const root = tempDir(t)
  const { profileDir, snapshotsRoot } = makeProfile(root)
  const snapshotDir = path.join(snapshotsRoot, '2026-11-12T22-21-00-123Z')
  fs.mkdirSync(snapshotDir, { recursive: true })
  fs.copyFileSync(path.join(profileDir, 'package.json'), path.join(snapshotDir, 'package.json'))
  const foreign = path.join(profileDir, 'package.json.bak-restart-plugin-20261111-223651')
  fs.writeFileSync(foreign, 'other plugin backup')

  const base = Date.parse('2026-11-12T22:30:00.000Z')
  for (let index = 0; index < 6; index += 1) {
    fs.writeFileSync(path.join(profileDir, 'package.json'), `{"changed": ${index}}`)
    restorePluginSnapshot({ snapshotDir, profileDir, now: base + index * 1000 })
  }

  const ours = fs
    .readdirSync(profileDir)
    .filter((name) => isPluginBackupName('package.json', name))
    .sort()
  assert.equal(ours.length, 3)
  assert.ok(ours.every((name) => name > 'package.json.bak-restart-20261112-223002'))
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'other plugin backup')
})

test('写回：目标文件被删掉时直接重建，不需要备份', (t) => {
  const root = tempDir(t)
  const { profileDir, manifest, snapshotsRoot } = makeProfile(root)
  const snapshot = createPluginSnapshot({ profileDir, snapshotsRoot, now: Date.now() })
  fs.rmSync(path.join(profileDir, 'package.json'))
  const result = restorePluginSnapshot({ snapshotDir: snapshot.dir, profileDir, now: Date.now() })
  assert.equal(result.ok, true)
  assert.ok(result.restored.includes('package.json'))
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), manifest)
})

test('写回：快照目录不存在时只报错，不抛', (t) => {
  const root = tempDir(t)
  const { profileDir } = makeProfile(root)
  const result = restorePluginSnapshot({ snapshotDir: path.join(root, 'nope'), profileDir })
  assert.equal(result.ok, false)
  assert.match(result.error, /快照目录/)
})

// ———————————————————————— 启动后比较 ————————————————————————

test('比较：内容一致时 consistent，无 bundles / disabled 变化', (t) => {
  const root = tempDir(t)
  const { profileDir, snapshotsRoot } = makeProfile(root)
  const snapshot = createPluginSnapshot({ profileDir, snapshotsRoot, now: Date.now() })
  const result = comparePluginState({ snapshotDir: snapshot.dir, profileDir })
  assert.equal(result.ok, true)
  assert.equal(result.consistent, true)
  assert.deepEqual(result.differing, [])
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.bundleDiff, { added: [], removed: [] })
  assert.equal(result.patchDiff.disabledChanged, false)
})

test('比较：bundles 增删与 disabled 翻转都能摘要出来', (t) => {
  const root = tempDir(t)
  const { profileDir, snapshotsRoot } = makeProfile(root, { bundles: ['alpha', 'beta', 'gamma'], disabled: true })
  const snapshot = createPluginSnapshot({ profileDir, snapshotsRoot, now: Date.now() })
  fs.writeFileSync(path.join(profileDir, 'package.json'), manifestText(['alpha', 'gamma', 'intruder']))
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchText(false))

  const result = comparePluginState({ snapshotDir: snapshot.dir, profileDir })
  assert.equal(result.consistent, false)
  assert.deepEqual(result.differing, ['package.json', 'cordis.patch.yml'])
  assert.deepEqual(result.bundleDiff.added, ['intruder'])
  assert.deepEqual(result.bundleDiff.removed, ['beta'])
  assert.equal(result.patchDiff.disabledChanged, true)

  const summary = summarizePluginDiff(result)
  assert.match(summary, /新增 \[intruder\]/)
  assert.match(summary, /移除 \[beta\]/)
  assert.match(summary, /disabled 行有变化/)
})

test('比较：目标文件缺失算不一致，并列为 missing', (t) => {
  const root = tempDir(t)
  const { profileDir, snapshotsRoot } = makeProfile(root)
  const snapshot = createPluginSnapshot({ profileDir, snapshotsRoot, now: Date.now() })
  fs.rmSync(path.join(profileDir, 'cordis.patch.yml'))
  const result = comparePluginState({ snapshotDir: snapshot.dir, profileDir })
  assert.equal(result.consistent, false)
  assert.deepEqual(result.missing, ['cordis.patch.yml'])
})

test('开机校验：一致时不重写、不备份', (t) => {
  const root = tempDir(t)
  const { profileDir, snapshotsRoot } = makeProfile(root)
  const snapshot = createPluginSnapshot({ profileDir, snapshotsRoot, now: Date.now() })
  const before = fs.statSync(path.join(profileDir, 'package.json')).mtimeMs
  const result = verifyPluginStateAfterBoot({ snapshotDir: snapshot.dir, profileDir, now: Date.now() })
  assert.equal(result.ok, true)
  assert.equal(result.consistent, true)
  assert.equal(result.restored, false)
  assert.equal(fs.statSync(path.join(profileDir, 'package.json')).mtimeMs, before)
})

test('开机校验：被改写时二次恢复并回到快照内容', (t) => {
  const root = tempDir(t)
  const { profileDir, manifest, snapshotsRoot } = makeProfile(root)
  const snapshot = createPluginSnapshot({ profileDir, snapshotsRoot, now: Date.now() })
  fs.writeFileSync(path.join(profileDir, 'package.json'), manifestText(['alpha', 'beta', 'intruder']))

  const result = verifyPluginStateAfterBoot({ snapshotDir: snapshot.dir, profileDir, now: Date.now() })
  assert.equal(result.ok, true)
  assert.equal(result.restored, true)
  assert.equal(result.consistent, true)
  assert.deepEqual(result.before.bundleDiff.added, ['intruder'])
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), manifest)
})

test('开机校验：没有快照时报错但不抛', (t) => {
  const root = tempDir(t)
  const { profileDir } = makeProfile(root)
  const result = verifyPluginStateAfterBoot({ snapshotDir: path.join(root, 'none'), profileDir })
  assert.equal(result.ok, false)
  assert.equal(result.consistent, false)
  assert.equal(result.restored, false)
})

// ———————————————————————— profile 定位与文本小工具 ————————————————————————

test('定位 profile：显式参数优先，其次 DSH_PROFILE_DIR，再 DSH_PROFILE 拼家目录', (t) => {
  const root = tempDir(t)
  const explicit = resolveProfileDir({ profileDir: path.join(root, 'a'), env: { DSH_PROFILE_DIR: path.join(root, 'b') } })
  assert.equal(explicit.dir, path.resolve(root, 'a'))
  assert.equal(explicit.source, 'option')

  const fromEnv = resolveProfileDir({ env: { DSH_PROFILE_DIR: path.join(root, 'b'), DSH_PROFILE: 'other' }, homeDir: root })
  assert.equal(fromEnv.dir, path.resolve(root, 'b'))
  assert.equal(fromEnv.source, 'env')

  const fromName = resolveProfileDir({ env: { DSH_PROFILE: 'desktop' }, homeDir: root })
  assert.equal(fromName.dir, path.join(root, 'profiles', 'desktop'))
  assert.equal(fromName.source, 'profile')
})

test('定位 profile：都没给时探 profiles 下唯一目录，找不到就安全失败', (t) => {
  const root = tempDir(t)
  makeProfile(root)
  const probed = resolveProfileDir({ env: {}, homeDir: root })
  assert.equal(probed.ok, true)
  assert.equal(probed.dir, path.join(root, 'profiles', 'desktop'))

  const emptyRoot = tempDir(t)
  const missing = resolveProfileDir({ env: {}, homeDir: emptyRoot })
  assert.equal(missing.ok, false)
  assert.equal(missing.dir, '')
})

test('文本小工具：读 bundles、读 disabled 行、格式化时间戳', () => {
  assert.deepEqual(readBundleNames(Buffer.from(manifestText(['a', 'b']))), ['a', 'b'])
  assert.equal(readBundleNames(Buffer.from('not json')), null)
  assert.deepEqual(readDisabledLines(Buffer.from('# disabled: true\n    disabled: false\n')), ['disabled: false'])
  assert.equal(formatBackupStamp(Date.parse('2026-11-12T22:30:00.000Z')), '20261112-223000-000')
})

test('修剪：只删本插件命名的快照目录与备份文件', (t) => {
  const root = tempDir(t)
  const snapshotsRoot = path.join(root, 'plugin-snapshots')
  fs.mkdirSync(snapshotsRoot)
  for (const name of ['2026-11-12T22-00-00-000Z', '2026-11-12T22-00-01-000Z', '2026-11-12T22-00-02-000Z']) {
    fs.mkdirSync(path.join(snapshotsRoot, name))
  }
  fs.mkdirSync(path.join(snapshotsRoot, 'foreign-dir'))
  assert.deepEqual(prunePluginSnapshots(snapshotsRoot, 1), ['2026-11-12T22-00-00-000Z', '2026-11-12T22-00-01-000Z'])
  assert.deepEqual(fs.readdirSync(snapshotsRoot).sort(), ['2026-11-12T22-00-02-000Z', 'foreign-dir'])
  assert.deepEqual(prunePluginSnapshots(path.join(root, 'nope'), 1), [])

  const profileDir = path.join(root, 'profile')
  fs.mkdirSync(profileDir)
  fs.writeFileSync(path.join(profileDir, 'package.json.bak-restart-20261112-223000-000'), '1')
  fs.writeFileSync(path.join(profileDir, 'package.json.bak-restart-20261112-223001-000'), '2')
  fs.writeFileSync(path.join(profileDir, 'package.json.bak-restart-plugin-20261111-223651'), '3')
  assert.deepEqual(prunePluginBackups(profileDir, 'package.json', 1), ['package.json.bak-restart-20261112-223000-000'])
  assert.equal(fs.existsSync(path.join(profileDir, 'package.json.bak-restart-plugin-20261111-223651')), true)
})
