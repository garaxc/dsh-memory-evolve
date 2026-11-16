/**
 * lib/sync/skills-mirror.js — 技能跨设备同步的镜像层。
 *
 * 与四条记忆轨的根本区别：记忆轨是「条目格式文件」，合并按 entryKey 做三元
 * 合并（merge.js）；技能是**任意深度的文件树**（SKILL.md + scripts/ + 资源），
 * 不能走 parseEntries／merge。因此技能同步拆成两层：
 *
 *   镜像层（本文件）：用户技能库与仓内 `skills/` 的双向复制，纯文件操作。
 *   传输层（worker）：把 `skills/` 当普通文件树 stage／commit／merge／push。
 *
 * 范围由清单决定，默认空清单＝不同步任何技能：
 *   - 第三方技能可从来源重装，塞进记忆仓只会撑大仓库；
 *   - 技能常被本机编辑，跨机覆盖会静默丢失改动；
 *   - 记忆仓 `.gitignore` 是 deny-all 白名单，放行任意技能树与该设计冲突。
 * 因此「机制常备、默认不生效」，由 `skills-sync.manifest.json` 显式点名。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'

/** 清单文件名（放在记忆仓根）。 */
export const MANIFEST_FILE = 'skills-sync.manifest.json'

/** 仓内技能树根目录。 */
export const REPO_SKILLS_DIR = 'skills'

/** 镜像时跳过的目录名（不属于技能内容）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store'])

/** 单个技能目录的字节上限（超限拒绝镜像，避免误拖大文件进仓）。 */
const MAX_SKILL_BYTES = 8 * 1024 * 1024

/** 技能名合法性：单段目录名，禁穿越与分隔符。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 读同步清单。
 * @param {string} repoDir - 记忆仓工作目录。
 * @returns {{root: string, skills: string[]}} root 为用户技能库绝对路径
 *   （清单可覆盖），skills 为要同步的技能名（去重、已校验）。
 */
export function readManifest(repoDir) {
  const file = join(repoDir, MANIFEST_FILE)
  const fallback = { root: join(homedir(), '.agents', 'skills'), skills: [] }
  if (!existsSync(file)) return fallback
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
  const skills = Array.isArray(parsed?.skills) ? parsed.skills.map((n) => String(n)).filter(validName) : []
  const root = typeof parsed?.root === 'string' && parsed.root.trim() !== '' ? parsed.root.trim() : fallback.root
  return { root, skills: [...new Set(skills)] }
}

/**
 * 写同步清单（不存在则创建，已存在则合并技能名）。
 * @param {string} repoDir - 记忆仓工作目录。
 * @param {{root?: string, skills: string[]}} manifest - 目标清单。
 * @returns {{ok: boolean, file: string}}
 */
export function writeManifest(repoDir, manifest) {
  const file = join(repoDir, MANIFEST_FILE)
  const names = [...new Set((manifest.skills ?? []).filter(validName))]
  const payload = { root: manifest.root ?? join(homedir(), '.agents', 'skills'), skills: names }
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return { ok: true, file }
}

/** 技能名是否可安全用作目录名。 */
export function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && name.length <= 64
}

/** 递归统计目录字节数（跳过 SKIP_DIRS）。 */
function dirBytes(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += dirBytes(p)
    else if (entry.isFile()) total += statSync(p).size
  }
  return total
}

/**
 * 本地技能库快照：返回清单内、本地确实存在的技能目录。
 * @param {string} skillRoot - 用户技能库目录。
 * @param {string[]} names - 清单技能名。
 * @returns {{present: string[], missing: string[], oversize: string[]}}
 */
export function inspectLocal(skillRoot, names) {
  const present = []
  const missing = []
  const oversize = []
  for (const name of names) {
    const dir = join(skillRoot, name)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      missing.push(name)
      continue
    }
    if (dirBytes(dir) > MAX_SKILL_BYTES) {
      oversize.push(name)
      continue
    }
    present.push(name)
  }
  return { present, missing, oversize }
}

/**
 * 出向镜像：用户技能库 → 仓内 `skills/`。
 *
 * 清单内的旧目录先整目录删除再复制，保证「仓内是本地快照」而不是增量叠加
 * （否则本地删掉的文件会永远留在仓里，越同步越脏）。清单外的目录不动。
 * @param {string} repoDir - 记忆仓工作目录。
 * @param {string} skillRoot - 用户技能库目录。
 * @param {string[]} names - 清单技能名。
 * @returns {{copied: string[], missing: string[], oversize: string[]}}
 */
export function mirrorOut(repoDir, skillRoot, names) {
  const repoSkills = join(repoDir, REPO_SKILLS_DIR)
  mkdirSync(repoSkills, { recursive: true })
  const { present, missing, oversize } = inspectLocal(skillRoot, names)
  for (const name of present) {
    const dest = join(repoSkills, name)
    rmSync(dest, { recursive: true, force: true })
    cpSync(join(skillRoot, name), dest, { recursive: true, filter: (src) => !SKIP_DIRS.has(src.split(sep).pop()) })
  }
  return { copied: present, missing, oversize }
}

/**
 * 入向镜像：仓内 `skills/` → 用户技能库。
 *
 * 保守策略——**只写本地不存在的技能**，本地已存在的记为 `kept-local` 不覆盖：
 * 技能是人工编辑资产，自动覆盖会静默丢掉本机改动，而冲突在没有三方基线的
 * 情况下无法可靠判定。真要对齐时，由调用方先显式删除本地目录再拉取。
 * @param {string} repoDir - 记忆仓工作目录。
 * @param {string} skillRoot - 用户技能库目录。
 * @param {string[]} names - 清单技能名（undefined 表示仓内全部）。
 * @returns {{written: string[], keptLocal: string[], valid: string[]}}
 */
export function mirrorIn(repoDir, skillRoot, names) {
  const repoSkills = join(repoDir, REPO_SKILLS_DIR)
  const written = []
  const keptLocal = []
  const valid = []
  if (!existsSync(repoSkills)) return { written, keptLocal, valid }
  const wanted = names === undefined
    ? readdirSync(repoSkills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : names
  for (const name of wanted) {
    if (!validName(name)) continue
    const src = join(repoSkills, name)
    if (!existsSync(src) || !statSync(src).isDirectory()) continue
    valid.push(name)
    const dest = join(skillRoot, name)
    if (existsSync(dest)) {
      keptLocal.push(name)
      continue
    }
    mkdirSync(skillRoot, { recursive: true })
    cpSync(src, dest, { recursive: true, filter: (p) => !SKIP_DIRS.has(p.split(sep).pop()) })
    written.push(name)
  }
  return { written, keptLocal, valid }
}

/**
 * 仓内技能树的相对路径清单（相对仓根，供 stage 使用）。
 * @param {string} repoDir - 记忆仓工作目录。
 * @returns {string[]} 形如 `skills/<name>/SKILL.md`；仓内无技能目录时为空。
 */
export function repoSkillPaths(repoDir) {
  const repoSkills = join(repoDir, REPO_SKILLS_DIR)
  if (!existsSync(repoSkills)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) out.push(relative(repoDir, p).split(sep).join('/'))
    }
  }
  walk(repoSkills)
  return out
}
