/**
 * tests/skills-repo.test.js — 技能轨传输层端到端（裸仓模拟两台设备）。
 *
 * 钉住三条契约：
 *   1. 清单为空 → 整条链路跳过（机制常备、默认不生效）；
 *   2. A 推送 → B 拉取得到技能（跨设备真的通了）；
 *   3. B 本地已有的同名技能不被远端覆盖（本机优先）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSkillsSync } from '../lib/sync/skills-repo.js'
import { readManifest, writeManifest } from '../lib/sync/skills-mirror.js'

/** 跑 git，失败时带上 stderr。 */
function g(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

/** 建一个可作为记忆仓的目录（init + 一次空提交）。 */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main')
  g(dir, 'config', 'user.name', 'test')
  g(dir, 'config', 'user.email', 'test@example.com')
  g(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

/** 写一个技能目录。 */
function makeSkill(root, name, body) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}\n`, 'utf8')
  return dir
}

test('清单为空 → 跳过（不建分支、不动技能库）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-repo-empty-'))
  try {
    const repo = makeRepo(join(root, 'repo'))
    const skills = join(root, 'skills')
    mkdirSync(skills, { recursive: true })
    const res = await runSkillsSync({ memDir: repo })
    assert.equal(res.ok, true)
    assert.equal(res.skipped, 'empty-manifest')
    assert.throws(() => g(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/skills-global'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('A 推送 → B 拉取：技能跨设备到达', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-repo-e2e-'))
  try {
    const origin = join(root, 'origin.git')
    mkdirSync(origin, { recursive: true })
    g(origin, 'init', '-q', '--bare')

    const a = makeRepo(join(root, 'a'))
    g(a, 'remote', 'add', 'origin', origin)
    const skillsA = join(root, 'skills-a')
    mkdirSync(skillsA, { recursive: true })
    makeSkill(skillsA, 'alpha', 'from-device-a')
    writeManifest(a, { root: skillsA, skills: ['alpha'] })

    const pushRes = await runSkillsSync({ memDir: a, push: true })
    assert.equal(pushRes.ok, true, pushRes.message)
    assert.deepEqual(pushRes.copied, ['alpha'])
    assert.equal(pushRes.pushed, true)

    const b = makeRepo(join(root, 'b'))
    g(b, 'remote', 'add', 'origin', origin)
    const skillsB = join(root, 'skills-b')
    mkdirSync(skillsB, { recursive: true })
    writeManifest(b, { root: skillsB, skills: ['alpha'] })

    const pullRes = await runSkillsSync({ memDir: b })
    assert.equal(pullRes.ok, true, pullRes.message)
    assert.deepEqual(pullRes.pulled, ['alpha'], 'B 应从远端补入 alpha')
    assert.ok(existsSync(join(skillsB, 'alpha', 'SKILL.md')))
    assert.match(readFileSync(join(skillsB, 'alpha', 'SKILL.md'), 'utf8'), /from-device-a/)
    assert.equal(readManifest(b).skills.length, 1, '清单不被同步过程改写')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B 本地已有同名技能 → 保留本地版本（不覆盖人工编辑）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-repo-keep-'))
  try {
    const origin = join(root, 'origin.git')
    mkdirSync(origin, { recursive: true })
    g(origin, 'init', '-q', '--bare')

    const a = makeRepo(join(root, 'a'))
    g(a, 'remote', 'add', 'origin', origin)
    const skillsA = join(root, 'skills-a')
    mkdirSync(skillsA, { recursive: true })
    makeSkill(skillsA, 'alpha', 'remote-version')
    writeManifest(a, { root: skillsA, skills: ['alpha'] })
    assert.equal((await runSkillsSync({ memDir: a, push: true })).ok, true)

    const b = makeRepo(join(root, 'b'))
    g(b, 'remote', 'add', 'origin', origin)
    const skillsB = join(root, 'skills-b')
    mkdirSync(skillsB, { recursive: true })
    makeSkill(skillsB, 'alpha', 'local-version')
    writeManifest(b, { root: skillsB, skills: ['alpha'] })

    const res = await runSkillsSync({ memDir: b })
    assert.equal(res.ok, true, res.message)
    assert.deepEqual(res.keptLocal, ['alpha'])
    assert.deepEqual(res.pulled, [])
    assert.match(readFileSync(join(skillsB, 'alpha', 'SKILL.md'), 'utf8'), /local-version/,
      '本地已有技能不得被远端版本覆盖')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
