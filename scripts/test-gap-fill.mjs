/**
 * 回归脚本：中途启用（注入发生在会话中途）不得丢当次会话的前半段。
 *
 * 背景：实时链路与回填共用 `applyEvent` 的游标去重（`seq < consumedSeq` 跳过）。
 * 旧实现在 `applyEvent` **之后**才调 catchUp()，此时游标已被推过缺口，补齐路径
 * 从新游标开始读 —— 缺口永远补不回来。实测：同一份 342 条记录的日志，全量回填
 * 得 {62 次工具调用, 4 轮, 60 步}，中途接入只得 {8, 1, 8}。
 *
 * 本脚本用同一份合成日志跑三条路径并比对：
 *   A 全量回填               —— 基准
 *   B 新逻辑（先补齐再折叠） —— 必须与 A 完全一致
 *   C 旧逻辑（先折叠再补齐） —— 复现旧 bug（应当落后于 A）
 *
 * 用法：node scripts/test-gap-fill.mjs（先 npm run build:host）
 */

import { applyEvent, cursorOf, emptyState } from '../lib/fold.js'
import { scanSession } from '../lib/backfill.js'

/** 合成 342 条事件：62 次工具调用（含配对结果）、60 步、4 轮、158 条模型消息。 */
function makeEvents() {
  const events = []
  let seq = 0
  const push = (type, data) => events.push({ seq: seq++, time: Date.UTC(2026, 9, 1, 2, 0, 0) + seq * 1000, type, data })
  for (let i = 0; i < 62; i += 1) {
    push('tool/call', { name: 'edit', callId: `c${i}` })
    push('tool/result', { message: { source: { callId: `c${i}` } } })
  }
  for (let i = 0; i < 60; i += 1) push('step/end', { turn: Math.floor(i / 15) + 1 })
  for (let i = 0; i < 158; i += 1) {
    push('assistant/message', {
      message: { source: { model: 'deepseek-flash' } },
      usage: { inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 50 },
    })
  }
  return events
}

const EVENTS = makeEvents()

/** 假 persistence：`read(offset, length)` 按 seq 切片（seq 恰好是下标）。 */
const persistence = {
  async list() {
    return [{ id: 'S1', header: { cwd: '/tmp/x', createdAt: 1, origin: 'root' } }]
  },
  async open() {
    return {
      async read(offset = 0, length = 2000) {
        return { events: EVENTS.slice(offset, offset + length) }
      },
      async close() {},
    }
  },
}

/** 取三维读数（工具调用 / 轮次 / 步数）。 */
const read = (state) => ({
  toolCalls: state.totals.toolCalls,
  turns: state.totals.turns,
  steps: state.totals.steps,
  modelCalls: state.totals.sessions > 0 ? Object.values(state.sessions)[0].modelCalls : 0,
})

// A. 全量回填
const a = emptyState()
const pendingA = new Map()
await scanSession({ persistence, state: a, pending: pendingA }, 'S1', { cwd: '/tmp/x', createdAt: 1, origin: 'root' })
const full = read(a)

// B. 新逻辑：已折叠前 8 条（模拟注入前实时链路攒下的部分），随后 seq=300 的实时事件到达。
//    检测到缺口 → 先补齐（游标不动）→ 补齐结束后重放缓存的那条事件（游标去重）。
const b = emptyState()
const pendingB = new Map()
for (const event of EVENTS.slice(0, 8)) applyEvent(b, 'S1', event, pendingB)
const gapEvent = EVENTS[300]
const cursorBefore = cursorOf(b, 'S1').consumedSeq
await scanSession({ persistence, state: b, pending: pendingB }, 'S1')
applyEvent(b, 'S1', gapEvent, pendingB)
const fixed = { ...read(b), cursorBefore, gap: gapEvent.seq }

// C. 旧逻辑：先折叠实时事件（游标被推过缺口），再补齐 —— 缺口补不回来。
const c = emptyState()
const pendingC = new Map()
for (const event of EVENTS.slice(0, 8)) applyEvent(c, 'S1', event, pendingC)
applyEvent(c, 'S1', gapEvent, pendingC)
await scanSession({ persistence, state: c, pending: pendingC }, 'S1')
const legacy = read(c)

const fmt = (label, v) => `${label.padEnd(22)} 工具调用=${v.toolCalls}  轮次=${v.turns}  步数=${v.steps}  模型调用=${v.modelCalls}`
console.log(fmt('A 全量回填（基准）', full))
console.log(fmt('B 新逻辑（先补后折）', fixed))
console.log(fmt('C 旧逻辑（先折后补）', legacy))

const same = (x, y) => x.toolCalls === y.toolCalls && x.turns === y.turns && x.steps === y.steps && x.modelCalls === y.modelCalls
const ok = same(fixed, full)
console.log(`\n新逻辑与全量回填一致：${ok ? 'PASS' : 'FAIL'}`)
console.log(`旧逻辑确实丢历史：${!same(legacy, full) ? 'PASS（已复现 bug）' : 'FAIL（未复现，日志可能不具代表性）'}`)
process.exitCode = ok ? 0 : 1
