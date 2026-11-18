/**
 * lib/sync/skills-repo.js — 技能轨的传输层（用户技能库 ↔ 共享记忆仓）。
 *
 * 为什么独立于四轨：记忆轨用 `runSync`（条目三元合并、临时 index 双父提交），
 * 技能是任意深度文件树，条目合并对它无效。这里改成**独立工作树 + 标准 git**：
 *
 *   1. 为技能轨开一个 linked worktree（不切主仓 HEAD，主工作树与其他四轨零干扰）；
 *   2. 出向镜像：清单内技能整目录复制进 worktree 的 `skills/`；
 *   3. 正常 `git add/commit`；
 *   4. `git fetch` + `git merge -X ours` 合远端（**本机优先**：技能是人工资产，
 *      自动覆盖会静默丢改动；要取远端版本，删掉本地目录再同步一次）；
 *   5. 入向镜像：把 merge 后 worktree 里**本地还没有的**技能补回技能库；
 *   6. `push` 仅在显式要求时执行（与四轨同一纪律：推送要人点头）；
 *   7. 移除 worktree。
 *
 * 清单为空时整条链路跳过——机制常备、默认不生效。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { mirrorIn, mirrorOut, readManifest, REPO_SKILLS_DIR } from './skills-mirror.js'

const exec = promisify(execFile)

/** 技能轨本地分支名。 */
export const SKILLS_LOCAL_BRANCH = 'skills-global'

/** 技能轨远端分支名（`git push origin HEAD:dsh-shared/skills`）。 */
export const SKILLS_REMOTE_BRANCH = 'dsh-shared/skills'

/**
 * 在指定仓库目录跑一条 git 命令。
 * @param {string} cwd - 执行目录（仓库或其 worktree）。
 * @param {string[]} args - git 参数。
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number}>}
 */
async function git(cwd, args) {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, stdout: String(stdout), stderr: String(stderr), code: 0 }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
      code: typeof error?.code === 'number' ? error.code : 1,
    }
  }
}

/** 分支是否已存在。 */
async function branchExists(repoDir, branch) {
  const r = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return r.ok
}

/**
 * 同步技能轨。
 * @param {object} p - 参数。
 * @param {string} p.memDir - 共享记忆仓目录（含 `skills-sync.manifest.json`）。
 * @param {boolean} [p.push=false] - 是否推送远端（需调用方已取得用户同意）。
 * @param {string} [p.worktreeDir] - 自定义 worktree 路径（测试用）。
 * @returns {Promise<{ok: boolean, skipped?: string, message: string, copied?: string[],
 *   pulled?: string[], keptLocal?: string[], pushed?: boolean, commit?: string}>}
 */
export async function runSkillsSync({ memDir, push = false, worktreeDir }) {
  const manifest = readManifest(memDir)
  if (manifest.skills.length === 0) {
    return { ok: true, skipped: 'empty-manifest', message: '技能同步清单为空（skills-sync.manifest.json 未点名任何技能）' }
  }

  const wt = worktreeDir ?? join(tmpdir(), `dsh-skills-sync-${process.pid}-${Date.now()}`)
  const hadBranch = await branchExists(memDir, SKILLS_LOCAL_BRANCH)
  if (!hadBranch) {
    // 用 ORIG_HEAD 之外的孤立起点：直接建空分支（工作树里随后被镜像内容填满）
    const created = await git(memDir, ['branch', SKILLS_LOCAL_BRANCH])
    if (!created.ok) return { ok: false, message: `建技能轨分支失败：${created.stderr.trim()}` }
  }
  const added = await git(memDir, ['worktree', 'add', wt, SKILLS_LOCAL_BRANCH])
  if (!added.ok) {
    return { ok: false, message: `创建技能轨工作树失败：${added.stderr.trim().split('\n')[0]}` }
  }

  try {
    // 出向镜像：本地技能库 → worktree/skills/
    //
    // 不要整棵清空 REPO_SKILLS_DIR：清单是跨机共享的，本机缺失的清单项
    // 仍需留在仓里等另一台机推上来。整棵 rm + `-X ours` 合并会把「本机没有」
    // 当成「要删除」，于是后同步的那台机静默抹掉前一台刚推的技能。
    // mirrorOut 自己会对本机 present 的目录逐个 rmSync，覆盖语义已足够。
    mkdirSync(join(wt, REPO_SKILLS_DIR), { recursive: true })
    const out = mirrorOut(wt, manifest.root, manifest.skills)

    // 提交（`-f` 绕过 deny-all 白名单：技能树是显式放行对象）
    const add = await git(wt, ['add', '-f', '--', REPO_SKILLS_DIR])
    if (!add.ok) return { ok: false, message: `stage 技能树失败：${add.stderr.trim().split('\n')[0]}`, copied: out.copied }
    const dirty = await git(wt, ['status', '--porcelain', '--', REPO_SKILLS_DIR])
    let commit = ''
    if (dirty.ok && dirty.stdout.trim() !== '') {
      const c = await git(wt, ['commit', '-q', '-m', `chore(skills): 同步 ${out.copied.length} 个技能（${out.copied.join(', ')}）`])
      if (!c.ok) return { ok: false, message: `提交技能树失败：${c.stderr.trim().split('\n')[0]}`, copied: out.copied }
      const head = await git(wt, ['rev-parse', '--short', 'HEAD'])
      commit = head.ok ? head.stdout.trim() : ''
    }

    // 合远端（本机优先）；远端不存在＝首次推送场景，跳过
    let pulled = []
    let keptLocal = []
    const fetch = await git(wt, ['fetch', '-q', 'origin', SKILLS_REMOTE_BRANCH])
    if (fetch.ok) {
      const merge = await git(wt, ['merge', '--no-edit', '-X', 'ours', 'FETCH_HEAD'])
      if (!merge.ok) {
        await git(wt, ['merge', '--abort'])
        return { ok: false, message: `合并远端技能失败（已回滚）：${merge.stderr.trim().split('\n')[0]}`, copied: out.copied, commit }
      }
      const back = mirrorIn(wt, manifest.root, manifest.skills)
      pulled = back.written
      keptLocal = back.keptLocal
    }

    let pushed = false
    if (push) {
      const p = await git(wt, ['push', '-q', 'origin', `HEAD:${SKILLS_REMOTE_BRANCH}`])
      if (!p.ok) return { ok: false, message: `推送技能轨失败：${p.stderr.trim().split('\n')[0]}`, copied: out.copied, pulled, keptLocal, commit }
      pushed = true
    }

    const parts = [`技能轨：${out.copied.length} 个出向`]
    if (out.missing.length > 0) parts.push(`${out.missing.length} 个清单项本地缺失（${out.missing.join(', ')}）`)
    if (pulled.length > 0) parts.push(`${pulled.length} 个从远端补入（${pulled.join(', ')}）`)
    if (keptLocal.length > 0) parts.push(`${keptLocal.length} 个本地已存在未覆盖（${keptLocal.join(', ')}）`)
    if (commit !== '') parts.push(`提交 ${commit}`)
    parts.push(pushed ? '已推送' : '未推送（加 --push 才上远端）')
    return { ok: true, message: parts.join('，'), copied: out.copied, pulled, keptLocal, pushed, commit }
  } finally {
    await git(memDir, ['worktree', 'remove', '--force', wt])
    if (existsSync(wt)) rmSync(wt, { recursive: true, force: true })
  }
}

/** 技能库默认根（导出给调用方拼清单用）。 */
export const DEFAULT_SKILL_ROOT = join(homedir(), '.agents', 'skills')
