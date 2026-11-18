/**
 * Consolidation-window tracker (2026-11-18).
 *
 * Why this exists: writing memory inside a session (review passes, merges,
 * dedup, archive) used to make the rendered snapshot change on nearly every
 * step. DSH materialises a runtime-context reminder only when the rendered
 * text changes, and it appends that reminder with `surfaceOp: 'append'` — so
 * every change left a fresh full copy in history that was never removed. A
 * single session that consolidated memory therefore accumulated dozens of
 * full snapshots (measured: 42 copies / 3.1 MB of text / 717k context).
 *
 * The tracker turns "we are consolidating right now" into an explicit state:
 *
 *   off ──(writes within window reach threshold)──▶ on   (enter: one full copy)
 *    ▲                                              │
 *    └──────────(no write for activeMs)─────────────┘    (exit: one full copy)
 *
 * While `on`, the snapshot renders a short fixed notice instead of the memory
 * bodies, so the text stops changing and the host stops re-appending. The
 * notice is deliberately static (no counters, no timestamps): a changing
 * notice would defeat the whole point.
 *
 * Signals are write timestamps only — no guessing about intent, no prompt
 * parsing. Only the three slow tracks (memory / user / key) count: daily and
 * project are written every turn by design and must never enter this state.
 *
 * @module dsh-memory-evolve/consolidation
 */

/** Tracks retained per agent; oldest entries are dropped past this bound. */
const MAX_TRACKED_AGENTS = 256

/** Tracks whose writes mean "memory content is being reshaped". */
export const CONSOLIDATION_TRACKS = Object.freeze(['memory', 'user', 'key'])

/**
 * @param {object} ctx - plugin context (only used for lifecycle symmetry).
 * @param {() => object} getConfig - live runtime config reader.
 * @param {() => number} [now] - clock injection for tests.
 * @returns {object} tracker with `noteWrite`, `noteFull` and `modeOf`.
 */
export function consolidationTracker(ctx, getConfig, now = () => Date.now()) {
  /** @type {Map<string, {stamps: number[], lastWriteAt: number, lastFullAt: number, phase: 'on'|'off'}>} */
  const states = new Map()

  const settings = () => {
    const config = getConfig() ?? {}
    return {
      enabled: config.consolidationGuard !== false,
      windowMs: config.consolidationWindowMs ?? 600000,
      activeMs: config.consolidationActiveMs ?? 300000,
      threshold: config.consolidationWriteThreshold ?? 2,
      maxHoldMs: config.consolidationMaxHoldMs ?? 1200000,
    }
  }

  function stateOf(agent) {
    const id = agent?.id ?? agent?.session?.id ?? 'anonymous'
    let state = states.get(id)
    if (state === undefined) {
      if (states.size >= MAX_TRACKED_AGENTS) {
        const oldest = states.keys().next()
        if (!oldest.done) states.delete(oldest.value)
      }
      state = { stamps: [], lastWriteAt: 0, lastFullAt: 0, phase: 'off' }
      states.set(id, state)
    }
    return state
  }

  return {
    /**
     * Record one successful write to a slow memory track.
     * @param {object} [agent] - the writing agent (its id keys the state).
     * @param {string} [target] - memory track name; ignored unless tracked.
     */
    noteWrite(agent, target) {
      if (target !== undefined && !CONSOLIDATION_TRACKS.includes(target)) return
      const { enabled, windowMs } = settings()
      if (!enabled) return
      const state = stateOf(agent)
      const stamp = now()
      state.lastWriteAt = stamp
      state.stamps.push(stamp)
      while (state.stamps.length > 0 && stamp - state.stamps[0] > windowMs) state.stamps.shift()
    },

    /**
     * Record that a full snapshot was rendered and reached the model, so the
     * hold safety valve measures from the last time the model saw the bodies.
     * @param {object} [agent] - the rendered agent.
     */
    noteFull(agent) {
      stateOf(agent).lastFullAt = now()
    },

    /**
     * Resolve the injection mode for this rendering step. Deterministic: the
     * same state and clock always yield the same mode, so repeated renders in
     * one step cannot consume an event.
     * @param {object} [agent] - the rendering agent.
     * @returns {'off'|'enter'|'hold'|'exit'|'pass'} `enter`/`exit` carry one
     *   full copy, `hold` is the static notice, `pass` is the safety valve.
     */
    modeOf(agent) {
      const { enabled, windowMs, activeMs, threshold, maxHoldMs } = settings()
      const state = stateOf(agent)
      if (!enabled) {
        state.phase = 'off'
        return 'off'
      }
      const stamp = now()
      while (state.stamps.length > 0 && stamp - state.stamps[0] > windowMs) state.stamps.shift()
      const active = state.stamps.length >= threshold && stamp - state.lastWriteAt <= activeMs
      const previous = state.phase
      state.phase = active ? 'on' : 'off'
      if (active) {
        if (previous !== 'on') return 'enter'
        if (stamp - state.lastFullAt >= maxHoldMs) return 'pass'
        return 'hold'
      }
      return previous === 'on' ? 'exit' : 'off'
    },

    /** Test hook: forget one agent's window (no production caller). */
    reset(agent) {
      states.delete(agent?.id ?? agent?.session?.id ?? 'anonymous')
    },
  }
}
