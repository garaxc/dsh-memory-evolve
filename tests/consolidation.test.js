// 整理期排重（2026-11-18）：会话内批量改写记忆时，快照不应逐步整份重发。
//
// 背景（实测）：一次整理会话积累了 42 份全量快照 / 3.1MB 文本，上下文涨到
// 717k。根因不是记忆太大，而是「每次写都变文本 → 宿主整份重发 → 以
// surfaceOp:'append' 永久留档」。本组用例钉住三件事：
//   1. 进入/退出各只发一份全量；
//   2. 整理期间渲染的文本**逐字节相同**（宿主才会短路，不再追加）；
//   3. daily/project 这类每轮写的快轨永远不触发整理态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, renderSnapshot } from '../lib/index.js'
import { MemoryStore } from '../lib/store.js'
import { consolidationTracker } from '../lib/consolidation.js'
import { setLocale } from '../lib/i18n.js'

setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'me-consolidation-'))
}

/** Deterministic clock the tests advance by hand. */
function clock(start = 1_000_000) {
  let value = start
  return { now: () => value, advance: (ms) => { value += ms } }
}

function agentOf(id = 'sessC') {
  return { session: { id, header: { cwd: '/p' } } }
}

const CONFIG = {
  consolidationGuard: true,
  consolidationWindowMs: 600_000,
  consolidationActiveMs: 300_000,
  consolidationWriteThreshold: 2,
  consolidationMaxHoldMs: 1_200_000,
}

test('consolidation: 窗口内两次写入进入整理期，静默后退出各发一次全量', () => {
  const time = clock()
  const tracker = consolidationTracker(null, () => CONFIG, time.now)
  const agent = agentOf()

  assert.equal(tracker.modeOf(agent), 'off', '无写入 → 正常注入')

  tracker.noteWrite(agent, 'memory')
  assert.equal(tracker.modeOf(agent), 'off', '一次写入未达阈值 → 仍是正常注入')

  tracker.noteWrite(agent, 'user')
  assert.equal(tracker.modeOf(agent), 'enter', '第二次写入 → 进入（本次带全量）')
  assert.equal(tracker.modeOf(agent), 'hold', '进入之后 → 静态静默')
  assert.equal(tracker.modeOf(agent), 'hold', '仍然静默')

  time.advance(CONFIG.consolidationActiveMs + 1)
  assert.equal(tracker.modeOf(agent), 'exit', '静默超时 → 退出（本次带全量）')
  assert.equal(tracker.modeOf(agent), 'off', '退出之后 → 正常注入')
})

test('consolidation: 快轨（daily/project）不参与判定', () => {
  const time = clock()
  const tracker = consolidationTracker(null, () => CONFIG, time.now)
  const agent = agentOf()
  for (let i = 0; i < 10; i += 1) {
    tracker.noteWrite(agent, 'daily')
    tracker.noteWrite(agent, 'project')
  }
  assert.equal(tracker.modeOf(agent), 'off', '每轮写入的 fast track 不得把会话锁进整理态')
})

test('consolidation: 开关关闭时恒为正常注入', () => {
  const time = clock()
  const tracker = consolidationTracker(null, () => ({ ...CONFIG, consolidationGuard: false }), time.now)
  const agent = agentOf()
  tracker.noteWrite(agent, 'memory')
  tracker.noteWrite(agent, 'memory')
  assert.equal(tracker.modeOf(agent), 'off')
})

test('consolidation: 长时间整理触发安全阀，放行一份全量', () => {
  const time = clock()
  const tracker = consolidationTracker(null, () => CONFIG, time.now)
  const agent = agentOf()
  tracker.noteWrite(agent, 'memory')
  tracker.noteWrite(agent, 'memory')
  assert.equal(tracker.modeOf(agent), 'enter')
  tracker.noteFull(agent)

  // 持续整理：不断写入让状态停在 on，但模型迟迟看不到正文。
  for (let elapsed = 0; elapsed < CONFIG.consolidationMaxHoldMs; elapsed += 60_000) {
    time.advance(60_000)
    tracker.noteWrite(agent, 'memory')
    const mode = tracker.modeOf(agent)
    assert.notEqual(mode, 'exit', '持续写入期间不应退出')
  }
  // 再推一步越过上限
  time.advance(60_000)
  tracker.noteWrite(agent, 'memory')
  assert.equal(tracker.modeOf(agent), 'pass', '超过 maxHold → 放行一份全量')
})

test('snapshot: 整理期只发静态提示，且两次渲染逐字节相同', () => {
  const dir = tempDir()
  try {
    const time = clock()
    const config = resolveConfig({ memoryDir: dir, ...CONFIG })
    const tracker = consolidationTracker(null, () => CONFIG, time.now)
    const store = new MemoryStore(dir, {
      ...config,
      onWrite: (target, agent) => tracker.noteWrite(agent, target),
    })
    const agent = agentOf('sessSnap')
    // 无写入时的正常全量（基线）
    const before = renderSnapshot(config, store, agent, undefined, null, null, tracker)
    assert.ok(!before.includes('记忆整理模式'), '无写入时走正常路径')

    store.add('memory', '一条全局记忆：锚点 ALPHA', agent)
    store.add('user', '一条用户事实：锚点 BETA', agent)

    // 两次写入已通过 onWrite 记入窗口 → 本次渲染即进入整理期
    const enter = renderSnapshot(config, store, agent, undefined, null, null, tracker)
    assert.ok(enter.includes('ALPHA'), '进入整理的那一步仍带全量（整理基线）')
    assert.ok(enter.includes('BETA'), '进入时用户档案也在基线里')
    assert.ok(enter.includes('记忆整理模式（已开启）'), '进入提示存在')

    // 整理进行中：正文消失，只剩静态提示
    const hold1 = renderSnapshot(config, store, agent, undefined, null, null, tracker)
    const hold2 = renderSnapshot(config, store, agent, undefined, null, null, tracker)
    assert.equal(hold1, hold2, '整理期两次渲染必须逐字节相同（宿主才会短路）')
    assert.ok(!hold1.includes('ALPHA'), '整理期不注入记忆正文')
    assert.ok(!hold1.includes('BETA'), '整理期不注入用户档案正文')
    assert.ok(hold1.includes('记忆整理模式（进行中）'), '整理期提示存在')
    assert.ok(hold1.includes('memory 工具'), '整理期提示指向权威读取方式')

    // 期间继续改写记忆：文本仍必须保持静态（否则排重失效）
    store.add('memory', '整理中新增的条目：锚点 GAMMA', agent)
    const hold3 = renderSnapshot(config, store, agent, undefined, null, null, tracker)
    assert.equal(hold3, hold1, '整理期继续写入不得改变注入文本')

    // 静默超时 → 退出，带整理后的终版全量
    time.advance(CONFIG.consolidationActiveMs + 1)
    const exit = renderSnapshot(config, store, agent, undefined, null, null, tracker)
    assert.ok(exit.includes('GAMMA'), '退出时注入整理后的终版（含新增条目）')
    assert.ok(exit.includes('记忆整理模式（已结束）'), '退出提示存在')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshot: 未装 tracker 时行为与旧版一致（兼容降级）', () => {
  const dir = tempDir()
  try {
    const config = resolveConfig({ memoryDir: dir, ...CONFIG })
    const store = new MemoryStore(dir, { onWrite: () => { throw new Error('must not run without tracker') } })
    const agent = agentOf('sessLegacy')
    store.add('memory', '兼容检查：锚点 DELTA', agent)
    const snap = renderSnapshot(config, store, agent)
    assert.ok(snap.includes('DELTA'), '无 tracker 仍走原全量路径')
    assert.ok(!snap.includes('记忆整理模式'), '无 tracker 不出现整理期文案')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
