/**
 * 账本持久化：加载、规整、原子写与防抖落盘。
 *
 * 落盘策略：内存是权威，变更后防抖 2 秒写一次；写盘走「临时文件 + rename」
 * 保证不会出现半截 JSON。文件损坏时备份原文件并以空账本重建，绝不因统计
 * 数据拖垮宿主。
 *
 * @module @dsh-external/dsh-usage-stats/ledger
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  FAILED_KEEP,
  LEDGER_VERSION,
  emptyState,
  emptyTotals,
  emptyUsage,
  type BackfillState,
  type DayStat,
  type LedgerState,
  type ModelStat,
  type SessionCursor,
  type ToolStat,
  type Totals,
  type UsageTotals,
} from './fold.js'

/** 变更后的落盘延迟。 */
const FLUSH_DELAY_MS = 2000

/** 加载结果。 */
export interface LedgerLoadResult {
  /** 可用的账本状态（损坏时为全新空账本）。 */
  state: LedgerState
  /** 需要向用户展示的提示（如「已备份损坏账本并重建」）。 */
  notice?: string
  /** 是否从磁盘读到了既有账本。 */
  loaded: boolean
}

/** 读取非负有限数。 */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 规整用量桶。 */
function usage(raw: unknown): UsageTotals {
  const base = emptyUsage()
  if (raw === null || typeof raw !== 'object') return base
  const value = raw as Record<string, unknown>
  return {
    uncachedInputTokens: num(value.uncachedInputTokens),
    cacheReadTokens: num(value.cacheReadTokens),
    cacheWriteTokens: num(value.cacheWriteTokens),
    outputTokens: num(value.outputTokens),
    costCny: num(value.costCny),
  }
}

/** 规整全局累计。 */
function totals(raw: unknown): Totals {
  const base = emptyTotals()
  if (raw === null || typeof raw !== 'object') return base
  const value = raw as Record<string, unknown>
  return {
    ...usage(value),
    sessions: num(value.sessions),
    turns: num(value.turns),
    steps: num(value.steps),
    toolCalls: num(value.toolCalls),
  }
}

/** 规整单日统计表。 */
function days(raw: unknown): Record<string, DayStat> {
  const out: Record<string, DayStat> = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const day = value as Record<string, unknown>
    out[key] = { ...usage(day), toolCalls: num(day.toolCalls), modelCalls: num(day.modelCalls) }
  }
  return out
}

/** 规整工具统计表。 */
function tools(raw: unknown): Record<string, ToolStat> {
  const out: Record<string, ToolStat> = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const stat = value as Record<string, unknown>
    out[key] = { calls: num(stat.calls), ms: num(stat.ms) }
  }
  return out
}

/** 规整模型统计表。 */
function models(raw: unknown): Record<string, ModelStat> {
  const out: Record<string, ModelStat> = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const stat = value as Record<string, unknown>
    out[key] = { ...usage(stat), calls: num(stat.calls) }
  }
  return out
}

/**
 * 规整「天 → 子表」两层嵌套结构（按天明细表通用）。
 *
 * 任一层不是对象即整条跳过：按天明细是**后加的字段**，老账本里根本没有，
 * 这里必须容错成空表而不是让整个账本判定为损坏。
 * @param raw - 任意 JSON 值。
 * @param map - 叶子对象的规整函数。
 * @returns 合法的两层表。
 */
function mapDays<T>(raw: unknown, map: (value: Record<string, unknown>) => T): Record<string, Record<string, T>> {
  const out: Record<string, Record<string, T>> = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [date, dayValue] of Object.entries(raw as Record<string, unknown>)) {
    if (date === '' || dayValue === null || typeof dayValue !== 'object') continue
    const inner: Record<string, T> = {}
    for (const [key, value] of Object.entries(dayValue as Record<string, unknown>)) {
      if (key === '' || value === null || typeof value !== 'object') continue
      inner[key] = map(value as Record<string, unknown>)
    }
    out[date] = inner
  }
  return out
}

/** 规整天 × 模型表。 */
function dayModels(raw: unknown): Record<string, Record<string, ModelStat>> {
  return mapDays(raw, (stat) => ({ ...usage(stat), calls: num(stat.calls) }))
}

/** 规整天 × 工具表。 */
function dayTools(raw: unknown): Record<string, Record<string, ToolStat>> {
  return mapDays(raw, (stat) => ({ calls: num(stat.calls), ms: num(stat.ms) }))
}

/** 规整天 × 会话表。 */
function daySessions(raw: unknown): Record<string, Record<string, UsageTotals>> {
  return mapDays(raw, (stat) => usage(stat))
}

/** 规整会话游标表；丢弃没有有效 id 或负游标的行。 */
function sessions(raw: unknown): Record<string, SessionCursor> {
  const out: Record<string, SessionCursor> = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '' || value === null || typeof value !== 'object') continue
    const cursor = value as Record<string, unknown>
    const entry: SessionCursor = { consumedSeq: num(cursor.consumedSeq) }
    if (typeof cursor.cwd === 'string') entry.cwd = cursor.cwd
    if (typeof cursor.createdAt === 'number' && Number.isFinite(cursor.createdAt)) entry.createdAt = cursor.createdAt
    if (typeof cursor.lastTurn === 'number' && Number.isFinite(cursor.lastTurn)) entry.lastTurn = cursor.lastTurn
    if (typeof cursor.origin === 'string') entry.origin = cursor.origin
    if (cursor.usage !== null && typeof cursor.usage === 'object') entry.usage = usage(cursor.usage)
    if (typeof cursor.modelCalls === 'number' && Number.isFinite(cursor.modelCalls)) entry.modelCalls = cursor.modelCalls
    if (typeof cursor.toolCalls === 'number' && Number.isFinite(cursor.toolCalls)) entry.toolCalls = cursor.toolCalls
    out[key] = entry
  }
  return out
}

/** 规整回填进度。 */
function backfill(raw: unknown): BackfillState {
  if (raw === null || typeof raw !== 'object') return emptyState().backfill
  const value = raw as Record<string, unknown>
  const failed = Array.isArray(value.failedSessions)
    ? value.failedSessions.filter((id): id is string => typeof id === 'string').slice(0, FAILED_KEEP)
    : []
  const state: BackfillState = {
    done: value.done === true,
    scanned: num(value.scanned),
    total: num(value.total),
    errors: num(value.errors),
    running: false,
    failedSessions: failed,
  }
  if (typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)) state.startedAt = value.startedAt
  if (typeof value.finishedAt === 'number' && Number.isFinite(value.finishedAt)) state.finishedAt = value.finishedAt
  return state
}

/**
 * 把任意 JSON 值规整为合法账本状态；版本不符则整体丢弃重建。
 * @param raw - 解析后的 JSON 值。
 * @returns 可安全使用的账本状态。
 */
export function normalizeLedger(raw: unknown): LedgerState {
  if (raw === null || typeof raw !== 'object') return emptyState()
  const value = raw as Record<string, unknown>
  if (num(value.version) !== LEDGER_VERSION) return emptyState()
  return {
    version: LEDGER_VERSION,
    updatedAt: num(value.updatedAt),
    totals: totals(value.totals),
    tools: tools(value.tools),
    days: days(value.days),
    models: models(value.models),
    sessions: sessions(value.sessions),
    dayModels: dayModels(value.dayModels),
    dayTools: dayTools(value.dayTools),
    daySessions: daySessions(value.daySessions),
    backfill: backfill(value.backfill),
  }
}

/**
 * 读取账本文件；不存在返回空账本，损坏则备份后重建。
 * @param file - 账本绝对路径。
 * @returns 加载结果（含给用户看的提示）。
 */
export function loadLedger(file: string): LedgerLoadResult {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return { state: emptyState(), loaded: false }
    return { state: emptyState(), loaded: false, notice: `账本读取失败：${String(error)}` }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const state = normalizeLedger(parsed)
    if (state.updatedAt === 0 && state.totals.sessions === 0 && Object.keys(state.days).length === 0) {
      // 版本不符或空壳：保留文件但提示重建。
      return { state, loaded: false, notice: '账本版本不符或为空，已按当前版本重建。' }
    }
    return { state, loaded: true }
  } catch (error) {
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      fs.renameSync(file, backup)
    } catch {
      // 备份失败不阻断启动：仍以空账本继续，只是旧文件被覆盖。
    }
    return { state: emptyState(), loaded: false, notice: `账本损坏已备份为 ${path.basename(backup)}：${String(error)}` }
  }
}

/**
 * 账本写盘器：内存状态 + 防抖落盘 + 原子替换。
 *
 * 卸载与进程退出前调用 {@link flush}，保证最后一次统计不丢。
 */
export class LedgerStore {
  /** 账本文件路径。 */
  readonly file: string
  /** 当前内存状态（调用方直接就地修改，然后 {@link touch}）。 */
  readonly state: LedgerState
  /** 最近一次写盘失败的原因（成功后被清除）。 */
  private writeError: string | undefined
  private timer: NodeJS.Timeout | undefined
  private dirty = false

  constructor(file: string, state: LedgerState) {
    this.file = file
    this.state = state
  }

  /** 最近一次写盘失败原因；undefined 表示一切正常。 */
  get lastError(): string | undefined {
    return this.writeError
  }

  /** 标记状态已变更，安排一次防抖落盘。 */
  touch(): void {
    this.dirty = true
    this.state.updatedAt = Date.now()
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, FLUSH_DELAY_MS)
    // 统计不该拖住进程退出；防抖定时器是纯收尾工作。
    this.timer.unref?.()
  }

  /**
   * 立即落盘（卸载、重扫等需要确定性的时机调用）。
   * @returns 失败原因；undefined 表示已写入或本就无变更。
   */
  flush(): string | undefined {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty) return this.writeError
    this.dirty = false
    const tmp = `${this.file}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      fs.renameSync(tmp, this.file)
      this.writeError = undefined
    } catch (error) {
      this.dirty = true
      this.writeError = String(error)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // 临时文件清理失败无关紧要。
      }
    }
    return this.writeError
  }

  /** 取消待落盘定时器（不写盘；由 {@link flush} 负责最后一次写）。 */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
