/**
 * 账本状态与纯 fold：把一条会话事件折算进累计统计。
 *
 * 本模块无 IO、不读时钟（时间一律取自事件时间戳），host 实时链路与历史回填
 * 共用同一份逻辑，因此离线重放的数字与在线累计一致。
 *
 * 游标语义：`sessions[id].consumedSeq` 表示「已折叠 [0, consumedSeq)」。任何
 * 路径（实时 / 回填 / 补齐）折叠前都先做 `seq < consumedSeq` 的跳过判断，
 * 于是同一条事件被两条路径同时看到也只计一次。
 *
 * @module @dsh-external/dsh-usage-stats/fold
 */

import { costOf } from './pricing.js'

/** 四桶互斥 token 用量 + 估算费用。 */
export interface UsageTotals {
  /** 未缓存输入。 */
  uncachedInputTokens: number
  /** 缓存命中读取。 */
  cacheReadTokens: number
  /** 缓存写入。 */
  cacheWriteTokens: number
  /** 输出（已含思维链）。 */
  outputTokens: number
  /** 估算费用（CNY），逐次调用按当时峰谷价累加。 */
  costCny: number
}

/** 全局累计量。 */
export interface Totals extends UsageTotals {
  /** 计入统计的会话数。 */
  sessions: number
  /** 轮次数（按 step/end 的 turn 变化去重）。 */
  turns: number
  /** 步数。 */
  steps: number
  /** 工具调用总次数。 */
  toolCalls: number
}

/** 单个工具的统计。 */
export interface ToolStat {
  /** 调用次数。 */
  calls: number
  /** 累计耗时（毫秒，tool/call → tool/result 配对）。 */
  ms: number
}

/** 单日统计（北京时间日历日）。 */
export interface DayStat extends UsageTotals {
  /** 当日工具调用次数。 */
  toolCalls: number
  /** 当日模型调用次数。 */
  modelCalls: number
}

/** 单模型统计（用于核对费用口径：Pro 档单价是基价 3 倍）。 */
export interface ModelStat extends UsageTotals {
  /** 该模型的调用次数。 */
  calls: number
}

/** 单会话游标与元数据。 */
export interface SessionCursor {
  /** 下一个待折叠的逻辑 seq。 */
  consumedSeq: number
  /** 会话工作目录（来自存储在会话 header 的 cwd）。 */
  cwd?: string
  /** 会话创建时刻（epoch 毫秒）。 */
  createdAt?: number
  /** 最近一次计数的 turn，用于轮次去重。 */
  lastTurn?: number
  /** 会话来源（`root` / `subagent`）。 */
  origin?: string
  /** 该会话的用量汇总（用于「最贵的对话」排行；老账本可能没有）。 */
  usage?: UsageTotals
  /** 该会话的模型调用次数。 */
  modelCalls?: number
  /** 该会话的工具调用次数。 */
  toolCalls?: number
}

/** 回填进度。 */
export interface BackfillState {
  /** 是否已完成过一次全量回填。 */
  done: boolean
  /** 已扫描会话数。 */
  scanned: number
  /** 待扫描会话总数。 */
  total: number
  /** 本次回填开始时刻。 */
  startedAt?: number
  /** 本次回填结束时刻。 */
  finishedAt?: number
  /** 读取失败的会话数。 */
  errors: number
  /** 当前是否正在回填。 */
  running: boolean
  /** 最近读取失败的会话 id（最多 {@link FAILED_KEEP} 个）。 */
  failedSessions: string[]
}

/** 账本根状态。 */
export interface LedgerState {
  /** 结构版本。 */
  version: number
  /** 最近一次变更时刻（epoch 毫秒）。 */
  updatedAt: number
  totals: Totals
  /** 工具名 → 统计。 */
  tools: Record<string, ToolStat>
  /** 北京时间日历日 → 当日统计。 */
  days: Record<string, DayStat>
  /** 模型名 → 统计。 */
  models: Record<string, ModelStat>
  /** 会话 id → 游标。 */
  sessions: Record<string, SessionCursor>
  backfill: BackfillState
}

/** 当前账本结构版本。 */
export const LEDGER_VERSION = 1

/** 失败会话 id 的保留条数。 */
export const FAILED_KEEP = 20

/** 折叠所需的事件最小结构（SessionEvent 满足它）。 */
export interface FoldEvent {
  /** 会话内连续递增的逻辑序号。 */
  seq: number
  /** 事件时刻（epoch 毫秒）。 */
  time: number
  /** 事件类型。 */
  type: string
  /** 事件负载。 */
  data?: unknown
}

/** 挂起中的工具调用：会话 id → (callId → 工具名与派发时刻)。进程内、不上盘。 */
export type PendingCalls = Map<string, Map<string, { name: string; time: number }>>

/** 挂起表单会话上限，防止无结果的调用无限堆积。 */
const PENDING_LIMIT = 200

/** 空的用量桶。 */
export function emptyUsage(): UsageTotals {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costCny: 0 }
}

/** 空的单日统计。 */
export function emptyDay(): DayStat {
  return { ...emptyUsage(), toolCalls: 0, modelCalls: 0 }
}

/** 空的全局累计。 */
export function emptyTotals(): Totals {
  return { ...emptyUsage(), sessions: 0, turns: 0, steps: 0, toolCalls: 0 }
}

/** 一份全新的空账本。 */
export function emptyState(): LedgerState {
  return {
    version: LEDGER_VERSION,
    updatedAt: 0,
    totals: emptyTotals(),
    tools: {},
    days: {},
    models: {},
    sessions: {},
    backfill: { done: false, scanned: 0, total: 0, errors: 0, running: false, failedSessions: [] },
  }
}

/**
 * 就地清空账本（保留对象引用，让已持有它的调用方继续有效）。
 *
 * 用于「重建统计」：口径变化（如定价表调整、新增维度）后需要从零重放历史，
 * 而游标一旦推进就不会回头，所以只能清空重扫。
 * @param state - 待清空的账本状态。
 */
export function resetState(state: LedgerState): void {
  const fresh = emptyState()
  state.version = fresh.version
  state.updatedAt = Date.now()
  state.totals = fresh.totals
  state.tools = {}
  state.days = {}
  state.models = {}
  state.sessions = {}
  state.backfill = fresh.backfill
}

/**
 * 北京时间日历日键。
 * @param ms - epoch 毫秒。
 * @returns `YYYY-MM-DD`；非有限值归入 `unknown`。
 */
export function dayKey(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown'
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 取（必要时建立）会话游标；首次见到某会话时计入会话数。
 * @param state - 账本状态（就地更新）。
 * @param sessionId - 会话 id。
 * @returns 该会话的游标对象（可变引用）。
 */
export function cursorOf(state: LedgerState, sessionId: string): SessionCursor {
  let cursor = state.sessions[sessionId]
  if (cursor === undefined) {
    cursor = { consumedSeq: 0 }
    state.sessions[sessionId] = cursor
    state.totals.sessions += 1
  }
  return cursor
}

/** 读取非负有限数，其余归零。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 就地累加一次调用的用量与费用。 */
function addUsage(
  target: UsageTotals,
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  cost: number,
): void {
  target.uncachedInputTokens += input
  target.cacheReadTokens += cacheRead
  target.cacheWriteTokens += cacheWrite
  target.outputTokens += output
  target.costCny += cost
}

/** 取（必要时建立）该会话的挂起表。 */
function pendingFor(pending: PendingCalls, sessionId: string): Map<string, { name: string; time: number }> {
  let table = pending.get(sessionId)
  if (table === undefined) {
    table = new Map()
    pending.set(sessionId, table)
  }
  return table
}

/** 把事件负载当对象读取（非对象一律按空对象处理）。 */
function payload(event: FoldEvent): Record<string, unknown> {
  const data = event.data
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
}

/** 从 tool/result 负载里取配对的 callId。 */
function resultCallId(data: Record<string, unknown>): string | undefined {
  const message = data.message
  if (message === null || typeof message !== 'object') return undefined
  const source = (message as Record<string, unknown>).source
  if (source === null || typeof source !== 'object') return undefined
  const callId = (source as Record<string, unknown>).callId
  return callId === undefined || callId === null ? undefined : String(callId)
}

/** 从 assistant/message 负载里取模型名。 */
function resultModel(data: Record<string, unknown>): string {
  const message = data.message
  if (message === null || typeof message !== 'object') return '(unknown)'
  const source = (message as Record<string, unknown>).source
  if (source === null || typeof source !== 'object') return '(unknown)'
  const model = (source as Record<string, unknown>).model
  return typeof model === 'string' && model !== '' ? model : '(unknown)'
}

/**
 * 把一条事件折叠进账本（就地更新 `state`），并推进该会话游标。
 *
 * 已折叠过的事件（`seq < consumedSeq`）直接忽略，因此实时链路与回填路径
 * 可以安全地重叠工作；未识别的事件类型不改变任何计数。
 * @param state - 账本状态（就地更新）。
 * @param sessionId - 事件所属会话 id。
 * @param event - 会话事件。
 * @param pending - 进程内挂起表（tool/call → tool/result 配对用）。
 * @returns 该事件是否被本次调用折叠（false = 重复或空操作）。
 */
export function applyEvent(
  state: LedgerState,
  sessionId: string,
  event: FoldEvent,
  pending: PendingCalls,
): boolean {
  const cursor = cursorOf(state, sessionId)
  const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1
  // 游标去重：两条路径（实时 / 回填）看到同一事件时只计一次。
  if (seq >= 0 && seq < cursor.consumedSeq) return false

  const data = payload(event)
  const ms = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0

  switch (event.type) {
    case 'tool/call': {
      const raw = data.name
      const name = typeof raw === 'string' && raw !== '' ? raw : '(unknown)'
      const stat = (state.tools[name] ??= { calls: 0, ms: 0 })
      stat.calls += 1
      state.totals.toolCalls += 1
      cursor.toolCalls = (cursor.toolCalls ?? 0) + 1
      const day = (state.days[dayKey(ms)] ??= emptyDay())
      day.toolCalls += 1
      const callId = data.callId
      if (callId !== undefined && callId !== null) {
        const table = pendingFor(pending, sessionId)
        table.set(String(callId), { name, time: ms })
        while (table.size > PENDING_LIMIT) {
          const oldest = table.keys().next()
          if (oldest.done === true) break
          table.delete(oldest.value)
        }
      }
      break
    }
    case 'tool/result': {
      const callId = resultCallId(data)
      if (callId === undefined) break
      const table = pending.get(sessionId)
      const dispatched = table?.get(callId)
      if (table === undefined || dispatched === undefined) break
      table.delete(callId)
      const stat = (state.tools[dispatched.name] ??= { calls: 0, ms: 0 })
      stat.ms += Math.max(0, ms - dispatched.time)
      break
    }
    case 'assistant/message': {
      const raw = data.usage
      if (raw === null || typeof raw !== 'object') break
      const usage = raw as Record<string, unknown>
      const input = num(usage.inputTokens)
      const cacheRead = num(usage.cacheReadTokens)
      const cacheWrite = num(usage.cacheWriteTokens)
      const output = num(usage.outputTokens)
      if (input + cacheRead + cacheWrite + output === 0) break
      const model = resultModel(data)
      const cost = costOf(
        { inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output },
        model,
        ms,
      )
      addUsage(state.totals, input, cacheRead, cacheWrite, output, cost)
      const day = (state.days[dayKey(ms)] ??= emptyDay())
      addUsage(day, input, cacheRead, cacheWrite, output, cost)
      day.modelCalls += 1
      const stat = (state.models[model] ??= { ...emptyUsage(), calls: 0 })
      stat.calls += 1
      addUsage(stat, input, cacheRead, cacheWrite, output, cost)
      // 会话自身的用量：用于回答「哪个对话最贵」。
      addUsage((cursor.usage ??= emptyUsage()), input, cacheRead, cacheWrite, output, cost)
      cursor.modelCalls = (cursor.modelCalls ?? 0) + 1
      break
    }
    case 'step/end': {
      state.totals.steps += 1
      const turn = data.turn
      if (typeof turn === 'number' && Number.isFinite(turn) && turn !== cursor.lastTurn) {
        state.totals.turns += 1
        cursor.lastTurn = turn
      }
      break
    }
    default:
      break
  }

  if (seq >= 0 && seq + 1 > cursor.consumedSeq) cursor.consumedSeq = seq + 1
  return true
}
