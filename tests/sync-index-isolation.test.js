// 多轨共享 .git/index 的隔离回归（2026-11-18）。
//
// 事故形态（实测）：globalSync 按轨依次 spawn worker，每轨成功提交后都会
// `read-tree <本轨分支>` 把共享 index 设成本轨的树。当主工作区 checkout 的是
// 另一条轨（memory-global）时，MEMORY.md 就从 index 里消失：git status 显示
// 「staged 删除 + 未跟踪」，只差一次 commit 就会把记忆删掉。
//
// 修复：只有主工作区确实 checkout 了本轨分支时才重置 index。
// 本用例钉住两件事：
//   1. 非当前轨的 sync 不得改动共享 index（MEMORY.md 仍在 index 里）；
//   2. 当前轨的 sync 仍然重置 index（单轨仓库 git status 保持干净的原有行为）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureGlobalRepo } from '../lib/sync/repo.js'
import { runSync } from '../lib/sync/worker.js'
import { setLocale } from '../lib/i18n.js'

setLocale('zh')

const URL = 'https://example.com/shared-memories.git'

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

const skip = !gitAvailable()

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
  return String(r.stdout ?? '').trim()
}

/** 已初始化的全局记忆仓 + 裸 origin，HEAD 停在 memory-global。 */
async function setupRepo(root) {
  const bare = join(root, 'bare.git')
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '-q', '--bare', '-b', 'main'])
  const dir = join(root, 'mem')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '[2026-11-18 10:00] 全局事实 A\n')
  writeFileSync(join(dir, 'USER.md'), '[2026-11-18 09:00] 用户偏好 A\n')
  const init = await ensureGlobalRepo({ dir, url: URL })
  assert.equal(init.ok, true, 'ensureGlobalRepo 应成功')
  // 传输改到本地裸仓库（ensureGlobalRepo 的 origin 是假 URL）
  git(dir, ['remote', 'set-url', 'origin', bare])
  // 主工作区停在 memory-global：模拟生产里 HEAD 属于第一条轨
  git(dir, ['checkout', '-q', '-B', 'memory-global'])
  git(dir, ['add', '-f', 'MEMORY.md', '.gitattributes', '.gitignore', 'PROVENANCE'].filter((p) => {
    try { git(dir, ['ls-files', '--error-unmatch', p]); return false } catch { return true }
  }))
  // 提交（如无变更则允许失败）
  spawnSync('git', ['commit', '-q', '-m', 'baseline: memory-global'], { cwd: dir, encoding: 'utf8' })
  return { dir, bare }
}

test('多轨 index 隔离：非当前轨 sync 不得把 MEMORY.md 挤出 index', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-index-'))
  try {
    const { dir } = await setupRepo(root)
    // 前置：HEAD 在 memory-global，MEMORY.md 在 index 里
    assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']), 'memory-global')
    assert.ok(git(dir, ['ls-files']).split('\n').includes('MEMORY.md'), '前置：MEMORY.md 应在 index')

    // 记录 sync 前的 index 全貌（ensureGlobalRepo 首次提交已放过若干文件，
    // 判据是「非当前轨的 sync 不得改动它」，不是「只能是某几个文件」）
    const beforeIndex = git(dir, ['ls-files']).split('\n').sort()

    // 另一条轨（user-global）产生一次真实提交并推送
    writeFileSync(join(dir, 'USER.md'), '[2026-11-18 11:00] 用户偏好 B（新设备写入）\n')
    const r = await runSync({
      dir,
      remoteBranch: 'dsh-shared/user',
      localBranch: 'user-global',
      fileset: 'user-global',
      push: true,
    })
    assert.equal(r.ok, true, `user-global sync 应成功：${r.message ?? ''}`)
    assert.equal(r.committed, true, '应有新提交（内容已变更）')

    // 核心断言：HEAD 仍是 memory-global，MEMORY.md 仍在 index 里
    assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']), 'memory-global', 'HEAD 分支不得被移动')
    const tracked = git(dir, ['ls-files'])
    assert.ok(tracked.split('\n').includes('MEMORY.md'), '非当前轨 sync 后 MEMORY.md 必须仍在 index（否则 staged 删除会吞掉记忆）')
    // 更严的判据：index 集合逐项不变（既不丢当前轨文件，也不多出别的轨文件）
    assert.deepEqual(tracked.split('\n').sort(), beforeIndex, '非当前轨 sync 不得改动共享 index 的文件集合')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('当前轨 sync 仍重置 index（单轨干净行为不回退）', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-index-cur-'))
  try {
    const { dir } = await setupRepo(root)
    writeFileSync(join(dir, 'MEMORY.md'), '[2026-11-18 12:00] 全局事实 B（当前轨新增）\n')
    const r = await runSync({
      dir,
      remoteBranch: 'dsh-shared/memory-global',
      localBranch: 'memory-global',
      fileset: 'memory-global',
      push: true,
    })
    assert.equal(r.ok, true, `memory-global sync 应成功：${r.message ?? ''}`)
    assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']), 'memory-global')
    const tracked = git(dir, ['ls-files'])
    assert.ok(tracked.split('\n').includes('MEMORY.md'), '当前轨 sync 后 index 仍应指向本轨树')
    // 工作区与该轨树一致 → 无 staged 删除
    const staged = git(dir, ['diff', '--cached', '--name-status'])
    assert.ok(!/^D\tMEMORY\.md$/m.test(staged), '不得出现 MEMORY.md 的 staged 删除')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
