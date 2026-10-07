/**
 * @dsh-external/dsh-usage-stats —— DSH 用量与工具调用统计（host 侧）。
 *
 * 职责：
 * 1. 账本：`%DSH_HOME%/.dsh-usage-stats.json`，跨重启累计；
 * 2. 实时：监听 `session/event`，把 tool/call、tool/result、assistant/message、
 *    step/end 折叠进账本（游标去重，seq 跳跃时自动补齐）；
 * 3. 回填：首次启用时用官方 `sessionPersistence` 分页读取全部历史会话；
 * 4. 供数：`/dsh-usage-stats/api/summary` 与 `/rescan`，由设置页面板消费。
 *
 * 运行时只依赖 node 内置模块 —— DSH 服务一律经 `ctx` 取用，不 import 任何
 * `@deepseek-ai/*` 值（类型导入会被编译期擦除），因此插件在任何 profile 下
 * 都不会因缺依赖而挂起。
 *
 * @module @dsh-external/dsh-usage-stats
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { backfill, scanSession, type PersistenceLike } from './backfill.js'
import {
  applyEvent,
  cursorOf,
  dayKey,
  emptyDay,
  emptyUsage,
  resetState,
  type DayStat,
  type LedgerState,
  type PendingCalls,
} from './fold.js'
import { LedgerStore, loadLedger } from './ledger.js'

/** Cordis 插件名。 */
export const name = '@dsh-external/dsh-usage-stats'

/**
 * `webServer` 是硬依赖（面板本身就需要 Web）；`sessionPersistence` 不在此列，
 * 缺失时降级为「仅统计本次启动后的数据」而不是让插件挂起。
 */
export const inject = ['webServer']

/** 面板与面板 API 共用的路由前缀。 */
const API_PREFIX = '/dsh-usage-stats/api'

/** 账本文件名（放在 DSH_HOME 下，node_modules 可能只读或被清理）。 */
const LEDGER_FILE = '.dsh-usage-stats.json'

/** 近 N 天趋势的默认窗口。 */
const DEFAULT_DAYS = 14

/** 工具排行默认条数。 */
const DEFAULT_TOP = 12

/** 供面板使用的单日视图。 */
interface DayView extends DayStat {
  date: string
}

/** host 上下文的最小视图（不 import cordis 类型，保持零值依赖）。 */
interface HostContext {
  get(name: string): unknown
  on(event: string, listener: (...args: unknown[]) => void): () => void
  effect(callback: () => unknown, label?: string): () => void
  webServer: {
    register(options: { kind: 'prefix' | 'exact'; path: string; handler: (req: HttpRequest, res: HttpResponse) => unknown }): () => void
  }
  logger?: { info?: (message: string) => void; warn?: (message: string) => void } | undefined
}

/** 最小 HTTP 请求视图。 */
interface HttpRequest {
  url?: string
  method?: string
}

/** 最小 HTTP 响应视图。 */
interface HttpResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

/** 写 JSON 响应。 */
function sendJson(res: HttpResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 取整数查询参数。 */
function intParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 生成近 N 天序列（含今天；缺失日补零），按时间升序。 */
function recentDays(state: LedgerState, count: number, now: number): DayView[] {
  const out: DayView[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const key = dayKey(now - offset * 86_400_000)
    const day = state.days[key]
    out.push(day === undefined ? { date: key, ...emptyDay() } : { date: key, ...day })
  }
  return out
}

/** 会话标题缓存：避免每次轮询都读盘。 */
const titleCache = new Map<string, string | null>()

/**
 * 读取会话标题（用于把「哪个对话最贵」说成人话）。
 *
 * 标题由官方 `session-projection-cache` 落盘在
 * `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val`。
 * 这是对官方缓存布局的**只读、防御性**依赖：读不到就返回 undefined，面板退回显示
 * cwd + 短 id，绝不影响统计本身。
 * @param dshHome - DSH 主目录。
 * @param sessionId - 会话 id。
 * @returns 标题；无标题或读取失败时为 undefined。
 */
function readSessionTitle(dshHome: string, sessionId: string): string | undefined {
  const cached = titleCache.get(sessionId)
  if (cached !== undefined) return cached ?? undefined
  let title: string | null = null
  try {
    const file = path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { record?: { rows?: { title?: { val?: unknown } } } }
    const value = parsed.record?.rows?.title?.val
    if (typeof value === 'string' && value !== '') title = value
  } catch {
    title = null
  }
  titleCache.set(sessionId, title)
  if (titleCache.size > 500) {
    const oldest = titleCache.keys().next()
    if (oldest.done !== true) titleCache.delete(oldest.value)
  }
  return title ?? undefined
}

/** 组装面板所需的完整视图。 */
function summaryView(
  state: LedgerState,
  options: {
    days: number
    top: number
    now: number
    dshHome: string
    persistenceAvailable: boolean
    ledgerFile: string
    writeError?: string | undefined
  },
): unknown {
  const totalCalls = state.totals.toolCalls
  const ranked = Object.entries(state.tools)
    .map(([toolName, stat]) => ({ name: toolName, calls: stat.calls, ms: Math.round(stat.ms) }))
    .sort((left, right) => right.calls - left.calls || right.ms - left.ms)
  const tools = ranked.slice(0, options.top).map((entry) => ({
    ...entry,
    share: totalCalls > 0 ? entry.calls / totalCalls : 0,
  }))
  const models = Object.entries(state.models)
    .map(([model, stat]) => ({ model, ...stat }))
    .sort((left, right) => right.costCny - left.costCny || right.calls - left.calls)
  // 「最贵的对话」：按估算费用降序，回答「钱花在哪个对话上」。
  const sessions = Object.entries(state.sessions)
    .map(([id, cursor]) => ({
      id,
      cwd: cursor.cwd ?? '',
      createdAt: cursor.createdAt ?? 0,
      origin: cursor.origin ?? 'root',
      modelCalls: cursor.modelCalls ?? 0,
      toolCalls: cursor.toolCalls ?? 0,
      usage: cursor.usage ?? emptyUsage(),
    }))
    .filter((row) => row.usage.costCny > 0 || row.modelCalls > 0)
    .sort((left, right) => right.usage.costCny - left.usage.costCny)
    .slice(0, options.top)
    .map((row) => ({ ...row, title: readSessionTitle(options.dshHome, row.id) ?? null }))
  return {
    ok: true,
    generatedAt: options.now,
    totals: state.totals,
    tools,
    models,
    sessions,
    toolKinds: ranked.length,
    days: recentDays(state, options.days, options.now),
    backfill: state.backfill,
    meta: {
      persistenceAvailable: options.persistenceAvailable,
      ledgerFile: options.ledgerFile,
      writeError: options.writeError ?? null,
      updatedAt: state.updatedAt,
      sessionCount: Object.keys(state.sessions).length,
    },
  }
}

/**
 * 挂载插件：账本 + 实时链路 + 回填调度 + HTTP API。
 * @param ctx - cordis 上下文。
 */
export function apply(ctx: HostContext): void {
  const dshHome = process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh')
  const ledgerFile = path.join(dshHome, LEDGER_FILE)
  const loaded = loadLedger(ledgerFile)
  const store = new LedgerStore(ledgerFile, loaded.state)
  const pending: PendingCalls = new Map()
  const log = (message: string): void => {
    try {
      ctx.logger?.info?.(`[usage-stats] ${message}`)
    } catch {
      // 日志失败不影响统计。
    }
  }
  const warn = (message: string): void => {
    try {
      ctx.logger?.warn?.(`[usage-stats] ${message}`)
    } catch {
      // 同上。
    }
  }

  if (loaded.notice !== undefined) warn(loaded.notice)
  if (!loaded.loaded) store.touch()

  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  const deps = { persistence, state: store.state, pending, onProgress: (): void => store.touch(), log: warn }

  // ---- 实时链路 ---------------------------------------------------------
  /** 正在补齐的会话（防止 seq 跳跃反复触发并发读）。 */
  const catching = new Set<string>()

  const catchUp = (sessionId: string): void => {
    if (persistence === undefined || catching.has(sessionId)) return
    catching.add(sessionId)
    void scanSession(deps, sessionId)
      .then((folded) => {
        if (folded > 0) store.touch()
      })
      .catch((error: unknown) => warn(`补齐会话 ${sessionId} 失败：${String(error)}`))
      .finally(() => catching.delete(sessionId))
  }

  ctx.effect(
    () =>
      ctx.on('session/event', (...args: unknown[]) => {
        const session = args[0] as { id?: unknown } | undefined
        const event = args[1] as { seq?: unknown; time?: unknown; type?: unknown } | undefined
        const sessionId = session?.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (event === undefined || typeof event.type !== 'string') return
        // 缺口判断必须在折叠之前：正常情况事件的 seq 恰好等于游标。
        const seq = typeof event.seq === 'number' ? event.seq : -1
        const gapAhead = seq >= 0 && seq > cursorOf(store.state, sessionId).consumedSeq
        const changed = applyEvent(
          store.state,
          sessionId,
          event as { seq: number; time: number; type: string; data?: unknown },
          pending,
        )
        if (changed) store.touch()
        // 注入发生在会话中途时，游标与实时事件之间存在缺口 —— 补齐它。
        if (gapAhead) catchUp(sessionId)
      }),
    'usage-stats: live session events',
  )

  ctx.effect(
    () =>
      ctx.on('session/disposed', (...args: unknown[]) => {
        const session = args[0] as { id?: unknown } | undefined
        const sessionId = session?.id
        if (typeof sessionId === 'string' && sessionId !== '') pending.delete(sessionId)
      }),
    'usage-stats: session cleanup',
  )

  // ---- 回填调度 ---------------------------------------------------------
  /** 正在进行的扫描；同一时刻只允许一个。 */
  let scanning: Promise<unknown> | undefined

  /**
   * 排队一次后台扫描。
   *
   * 串行化是硬要求：`rebuild` 必须「先等旧扫描收尾 → 清空账本 → 重新全量」，
   * 否则旧扫描会在清空之后继续写它的进度与计数，把新账本搅成半截状态
   * （实测过：rebuild 被进行中的启动扫描吞掉，只剩 5 个会话）。
   * @param options - `onlyMissing` 只扫账本里没有的会话；`rebuild` 清空后从头重放。
   * @returns 本次扫描的 Promise 与「前面是否还有扫描在跑」。
   */
  const requestScan = (options: { onlyMissing: boolean; rebuild: boolean }): { promise: Promise<unknown>; queued: boolean } => {
    const previous = scanning
    const queued = previous !== undefined
    let promise: Promise<unknown> | undefined
    promise = (async (): Promise<unknown> => {
      if (previous !== undefined) await previous.catch(() => undefined)
      if (options.rebuild) {
        resetState(store.state)
        pending.clear()
        store.touch()
      }
      return backfill(deps, { onlyMissing: options.onlyMissing })
    })()
      .then((result) => {
        store.flush()
        const outcome = result as { scanned: number; total: number; events: number; errors: number }
        log(
          `回填完成：扫描 ${outcome.scanned}/${outcome.total} 个会话，折叠 ${outcome.events} 条事件，失败 ${outcome.errors} 个`,
        )
        return result
      })
      .catch((error: unknown) => {
        store.state.backfill.running = false
        warn(`回填失败：${String(error)}`)
        return undefined
      })
      .finally(() => {
        if (scanning === promise) scanning = undefined
      })
    scanning = promise
    return { promise, queued }
  }

  // 首次运行全量回填；此后只补账本里没有的新会话（增量、秒级完成）。
  const first = loaded.state.backfill.done !== true || loaded.state.backfill.scanned === 0
  setTimeout(() => {
    void requestScan({ onlyMissing: !first, rebuild: false }).promise
  }, 0).unref?.()

  // ---- HTTP API ---------------------------------------------------------
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req: HttpRequest, res: HttpResponse): void => {
          void (async (): Promise<void> => {
            try {
              const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
              const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname
              if (route === '' || route === '/' || route === '/summary') {
                const days = intParam(url, 'days', DEFAULT_DAYS, 1, 120)
                const top = intParam(url, 'top', DEFAULT_TOP, 1, 200)
                sendJson(
                  res,
                  200,
                  summaryView(store.state, {
                    days,
                    top,
                    now: Date.now(),
                    dshHome,
                    persistenceAvailable: persistence !== undefined,
                    ledgerFile,
                    writeError: store.lastError,
                  }),
                )
                return
              }
              if (route === '/rescan') {
                if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
                  sendJson(res, 405, { ok: false, error: 'rescan 需要 POST' })
                  return
                }
                // rebuild=1：清空账本从零重放。改口径或新增统计维度后必须重建，
                // 因为游标只前进不回头，增量扫描不会为历史补算新维度。
                const rebuild = url.searchParams.get('rebuild') === '1'
                const scheduled = requestScan({ onlyMissing: false, rebuild })
                void scheduled.promise
                sendJson(res, 200, {
                  ok: true,
                  started: true,
                  rebuild,
                  queued: scheduled.queued,
                  sessionCount: Object.keys(store.state.sessions).length,
                })
                return
              }
              sendJson(res, 404, { ok: false, error: `未知路由 ${route}` })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error) })
            }
          })()
        },
      }),
    'usage-stats: api routes',
  )

  // ---- 卸载即净 ---------------------------------------------------------
  ctx.effect(
    () => () => {
      store.flush()
      store.dispose()
      pending.clear()
    },
    'usage-stats: flush ledger on dispose',
  )

  log(`已加载（账本：${ledgerFile}，历史回填：${first ? '全量' : '增量'}，持久化服务：${persistence === undefined ? '不可用' : '可用'}）`)
}