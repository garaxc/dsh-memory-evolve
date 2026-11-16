/**
 * tests/skills-mirror.test.js — 技能镜像层（lib/sync/skills-mirror.js）。
 *
 * 钉住三条契约：
 *   1. 清单缺失＝不同步任何技能（机制常备、默认不生效）；
 *   2. 出向镜像是**整目录替换**，本地删掉的文件不会留在仓里；
 *   3. 入向镜像保守——本地已有的技能一律 keptLocal，不覆盖人工编辑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  MANIFEST_FILE,
  mirrorIn,
  mirrorOut,
  readManifest,
  repoSkillPaths,
  validName,
  writeManifest,
} from '../lib/sync/skills-mirror.js'

/** 建一个临时目录树。 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'skills-mirror-'))
  const repo = join(root, 'repo')
  const skills = join(root, 'skills')
  mkdirSync(repo, { recursive: true })
  mkdirSync(skills, { recursive: true })
  return { root, repo, skills, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 写一个技能目录（SKILL.md + 可选辅助文件）。 */
function makeSkill(skillRoot, name, body = 'body') {
  const dir = join(skillRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}\n`, 'utf8')
  return dir
}

test('清单缺失时默认空清单（不同步任何技能）', () => {
  const sb = sandbox()
  try {
    const m = readManifest(sb.repo)
    assert.deepEqual(m.skills, [])
    assert.ok(m.root.endsWith('.agents/skills'))
  } finally {
    sb.cleanup()
  }
})

test('清单读写往返，非法技能名被丢弃', () => {
  const sb = sandbox()
  try {
    writeManifest(sb.repo, { root: sb.skills, skills: ['alpha', '../escape', 'a/b', 'beta', 'alpha'] })
    assert.ok(existsSync(join(sb.repo, MANIFEST_FILE)))
    const raw = JSON.parse(readFileSync(join(sb.repo, MANIFEST_FILE), 'utf8'))
    assert.deepEqual(raw.skills, ['alpha', 'beta'], '非法名（穿越/分隔符）必须被丢弃，合法名去重保留')
    const m = readManifest(sb.repo)
    assert.deepEqual(m.skills, ['alpha', 'beta'])
    assert.equal(m.root, sb.skills)
  } finally {
    sb.cleanup()
  }
})

test('validName 拒绝穿越、分隔符与超长名', () => {
  for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(65)]) {
    assert.equal(validName(bad), false, `应拒绝 ${JSON.stringify(bad)}`)
  }
  for (const ok of ['memory-consolidate', 'a', 'A1.b_c-d']) {
    assert.equal(validName(ok), true, `应接受 ${JSON.stringify(ok)}`)
  }
})

test('出向镜像是整目录替换：本地删掉的文件不会留在仓里', () => {
  const sb = sandbox()
  try {
    const dir = makeSkill(sb.skills, 'alpha')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'run.sh'), 'echo one\n', 'utf8')

    const first = mirrorOut(sb.repo, sb.skills, ['alpha'])
    assert.deepEqual(first.copied, ['alpha'])
    assert.ok(existsSync(join(sb.repo, 'skills', 'alpha', 'scripts', 'run.sh')))

    rmSync(join(dir, 'scripts', 'run.sh'))
    mirrorOut(sb.repo, sb.skills, ['alpha'])
    assert.equal(existsSync(join(sb.repo, 'skills', 'alpha', 'scripts', 'run.sh')), false,
      '本地删除后仓内旧文件必须消失，否则越同步越脏')
  } finally {
    sb.cleanup()
  }
})

test('出向镜像跳过清单外技能，缺技能报 missing', () => {
  const sb = sandbox()
  try {
    makeSkill(sb.skills, 'alpha')
    makeSkill(sb.skills, 'other')
    const out = mirrorOut(sb.repo, sb.skills, ['alpha', 'gone'])
    assert.deepEqual(out.copied, ['alpha'])
    assert.deepEqual(out.missing, ['gone'])
    assert.equal(existsSync(join(sb.repo, 'skills', 'other')), false, '清单外技能不得进仓')
  } finally {
    sb.cleanup()
  }
})

test('入向镜像保守：本地已有则 keptLocal，不覆盖本机改动', () => {
  const sb = sandbox()
  try {
    makeSkill(sb.repo + '/../mirror-src', 'alpha') // 占位，实际用下面直接写仓
    mkdirSync(join(sb.repo, 'skills', 'alpha'), { recursive: true })
    writeFileSync(join(sb.repo, 'skills', 'alpha', 'SKILL.md'), 'remote-version\n', 'utf8')
    mkdirSync(join(sb.repo, 'skills', 'beta'), { recursive: true })
    writeFileSync(join(sb.repo, 'skills', 'beta', 'SKILL.md'), 'beta-remote\n', 'utf8')

    makeSkill(sb.skills, 'alpha', 'local-edit')
    const res = mirrorIn(sb.repo, sb.skills, ['alpha', 'beta'])
    assert.deepEqual(res.written, ['beta'])
    assert.deepEqual(res.keptLocal, ['alpha'])
    assert.match(readFileSync(join(sb.skills, 'alpha', 'SKILL.md'), 'utf8'), /local-edit/,
      '本地已存在的技能不得被仓内版本覆盖')
    assert.match(readFileSync(join(sb.skills, 'beta', 'SKILL.md'), 'utf8'), /beta-remote/)
  } finally {
    sb.cleanup()
  }
})

test('repoSkillPaths 递归列出仓内技能文件（相对仓根）', () => {
  const sb = sandbox()
  try {
    makeSkill(sb.skills, 'alpha')
    const dir = join(sb.skills, 'alpha')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'a.mjs'), 'export {}\n', 'utf8')
    mirrorOut(sb.repo, sb.skills, ['alpha'])
    const paths = repoSkillPaths(sb.repo).sort()
    assert.deepEqual(paths, [
      'skills/alpha/SKILL.md',
      'skills/alpha/scripts/a.mjs',
    ])
  } finally {
    sb.cleanup()
  }
})

test('仓内无技能目录时 repoSkillPaths 返回空数组', () => {
  const sb = sandbox()
  try {
    assert.deepEqual(repoSkillPaths(sb.repo), [])
  } finally {
    sb.cleanup()
  }
})
