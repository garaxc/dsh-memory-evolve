# Handoff — 2026-11-18：多轨索引隔离 · 技能轨合并 · 整理期排重

接手的人先看这一页，再看三个 commit。

## 一句话

`globalSync` 按轨复用同一份 `.git/index`，把「单轨仓库的常识」带进了多轨仓库：一条轨同步成功会把索引设成自己的树，另一条轨的文件因此从索引里消失，**随时可能被下一次提交删掉**。同一天还修了技能轨「两条历史无共同祖先时 git 直接拒绝合并」。两处都已修，各有用例，其中一个用例做过「撤掉修复必红」的对照。

## 一、现场事故（已处理，可回滚）

`~/.dsh/memories` 的索引只剩 3 个文件：

```
$ git diff --cached --stat
 MEMORY-archive.md | 487 --------------------------
 MEMORY.md         | 467 ---------------------------
 2 files changed, 954 deletions(-)
```

MEMORY.md 与归档在索引里被判成删除、工作区里成了未跟踪文件。处置：

```bash
cp .git/index /tmp/memories-index-backup-<ts>   # 先备份
git read-tree HEAD                              # 只设索引，不动 HEAD 与工作区
git diff --stat                                 # 空 ⇒ 工作区与 HEAD 一致
git ls-files | grep MEMORY.md                   # 确认回到索引
```

其它轨的文件（`USER.md` / `TODOS-work.md` / `daily/` / `skills-sync.manifest.json`）在 `memory-global` 检出下仍显示未跟踪——**这是多轨共享工作区的正常形态，不是故障**。

## 二、根因与修法

### ① 非当前轨的 sync 不再碰共享索引

`lib/sync/worker.js`，提交成功后原本无条件：

```js
await runGit(dir, ['read-tree', lb])   // lb = refs/heads/<本轨>
```

它替代 `git reset` 是对的（reset 会连带移动 HEAD 分支指针，2026-11-06 实测 memory-global 被 daily-global 覆盖）。但它只解决了「分支指针」那一半：主工作区检出 A 轨时，B 轨的树占住索引，A 轨文件即从索引消失。

```js
const headBranch = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
if (headBranch.ok && headBranch.stdout.trim() === localBranch) {
  await runGit(dir, ['read-tree', lb])
}
```

单轨仓库（HEAD = main = lb）行为逐字节不变。

### ② 技能轨允许无共同祖先合并

`lib/sync/skills-repo.js`：

```js
git merge --no-edit -X ours FETCH_HEAD
→ fatal: refusing to merge unrelated histories
```

技能轨每台设备各自 init，两条历史没有共同祖先。症状不是「少一个技能」，而是**新设备第一次拉技能轨整条失败（已回滚）**，入向同步不可用。

```js
git merge --no-edit --allow-unrelated-histories -X ours FETCH_HEAD
```

`-X ours` 语义不变：双方都有的技能保本机版本；远端独有文件照常带入，`mirrorIn` 只补本地缺的。

### ③ 整理期排重（新增）

`lib/consolidation.js` + `lib/index.js` + `lib/store.js` + `lib/i18n.js`。

会话内整理记忆（review / 合并 / 去重 / 归档）时，`memory` / `user` / `key` 三轨每改一次，快照文本就变一次；宿主按「变化才注入」整份重发，并以 `surfaceOp: 'append'` 永久留档。实测一次整理会话累积 **42 份快照 / 3.1 MB / 上下文 717k**，其中约 490k 是**在线的过期副本**。

机制把「正在整理」当成显式状态：

```
off ──(窗口内慢轨写 ≥2 次)──▶ on   ：进入那一步发一份全量（基线）
 ▲                              │
 └────(静默超时 / 安全阀)────────┘   ：退出那一步发一份全量（终版）
        期间只发一段**静态**短提示（不含正文）
```

四条纪律（写进代码注释，因为最容易犯错的是第一条）：

1. 提示文案里不许放计数/时间/进度——一放进去文本就每步变，机制白做；
2. 只统计慢轨；`daily`/`project` 每轮都写，纳入判定会让会话永远锁在整理态；
3. 安全阀不可省（默认 20 分钟）：长整理会把模型弄成失明；起算点是「最后一次看到正文」；
4. 判定只读写入时间戳，不解析提示词。

量化（40 步连续整理，真实 `MEMORY.md`）：

```
关：2,365,565 字符 / 40 份含正文 / 40 次文本变化
开：  118,811 字符 /  2 份含正文 /  3 次变化     降幅 95.0%
```

配置项：`consolidationGuard`（默认开）、`consolidationWindowMs`、`consolidationActiveMs`、`consolidationWriteThreshold`、`consolidationMaxHoldMs`。

## 三、验收

```bash
# 两个新增套件
node --test tests/sync-index-isolation.test.js   # 2 例
node --test tests/consolidation.test.js          # 6 例

# 全量（update.test.js 依赖本机 git 默认分支 = main，需单独看）
node --test $(ls tests/*.test.js | grep -v update.test.js | tr '\n' ' ')
```

本机基线：**874 例 / 872 通过**；2 个失败是 `search-docs` 的 provider 探测，原因是本机缺 `rg`（ripgrep），与本次改动无关。

守卫可被打中的证据：把 `lib/sync/worker.js` 的改动 `git stash` 掉后，`sync-index-isolation` 第一例**必红**，恢复后必绿。

## 四、未完成 / 待决策

1. **四轨是否改独立 worktree**。`skills` 轨已经用独立 worktree + 镜像层；`memory/user/daily/todo` 仍共用主工作区与索引——① 的结构性来源就在这里。彻底解法是四轨各自 worktree，但会动一次 sync 装配，需要单独立项。
2. **`lib/sync/index.js` 与 `worker.js` 口径不一致**：`globalFilesetDirtySync` 用临时 `GIT_INDEX_FILE`（正确形态），worker 的 `read-tree` 用共享索引（本次已被判定条件收窄，但结构差异仍在）。
3. **技能目录脏数据**：`~/.agents/skills` 下有 9 个历史 `.zip` 与一个 `.DS_Store`（10-15 日遗留）。`SKIP_DIRS` 只拦目录级 `.DS_Store`，文件级未过滤。无害，可清或加镜像过滤。
4. **客户端加载未结论**：上一会话最后在查 `lib/client.js` 能否被宿主加载。已验 `lib/client.js` 存在（1.19 MB）、host 侧 `/memory-evolve/api/{badge,suggestions,archive}` 全 200；`/plugins` 路由需要会话鉴权，未能在命令行探到。要下结论得进 GUI 看记忆面板与控制台。

## 五、回滚点

| 对象 | 回滚方式 |
|---|---|
| 索引事故 | `/tmp/memories-index-backup-<ts>`（本次会话生成） |
| 代码 | 三个 commit 均可单独 revert；`consolidationGuard: false` 只关排重，不动 sync |
| 记忆仓提交 | 未动 `~/.dsh/memories` 的分支指针，只 `read-tree HEAD` 恢复索引 |
