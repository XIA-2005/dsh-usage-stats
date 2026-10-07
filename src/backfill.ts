/**
 * 历史回填：用官方 `sessionPersistence` 服务逐会话分页读取事件并折叠进账本。
 *
 * 为什么必须走官方服务：会话日志是 `session.jsonl.zstd`，物理上是**多个
 * zstd frame 串联**（header frame + 每批事件 frame）；Node 的
 * `zlib.createZstdDecompress` 解到第二帧就会抛 `ZSTD_error_prefix_unknown`。
 * 官方解码器才知道帧边界、torn tail 与格式迁移，自己解析必然踩坑。
 *
 * 增量语义：每个会话从账本的 `consumedSeq` 续读，已计过的部分不重扫。
 *
 * @module @dsh-external/dsh-usage-stats/backfill
 */

import { FAILED_KEEP, applyEvent, cursorOf, type LedgerState, type PendingCalls } from './fold.js'

/** 每次 read 的事件条数上限（大日志分页，避免一次性载入）。 */
const BATCH = 2000

/** 回填依赖（全部由 host 注入；本模块不做服务发现）。 */
export interface BackfillDeps {
  /** `ctx.get('sessionPersistence')`；缺失时为 undefined，回填整体跳过。 */
  persistence: PersistenceLike | undefined
  /** 账本状态（就地更新）。 */
  state: LedgerState
  /** 进程内挂起表。 */
  pending: PendingCalls
  /** 每扫完一个会话回调（用于进度展示与间歇落盘）。 */
  onProgress?: (() => void) | undefined
  /** 日志回调。 */
  log?: ((message: string) => void) | undefined
}

/** 会话快照的最小结构（官方 `SessionPersistenceSnapshot` 的宽松视图）。 */
export interface SessionSnapshotLike {
  id?: unknown
  revision?: unknown
  header?: { id?: unknown; cwd?: unknown; createdAt?: unknown; origin?: unknown } | undefined
}

/** 读句柄的最小结构（官方 `SessionHandle` 的宽松视图）。 */
export interface SessionHandleLike {
  read(offset?: number, length?: number): Promise<{ events?: readonly unknown[] } | undefined>
  close?(): Promise<void>
}

/** 持久化服务的最小结构。 */
export interface PersistenceLike {
  list(): Promise<readonly SessionSnapshotLike[]>
  open(id: string, access: 'read' | 'write'): Promise<SessionHandleLike>
}

/** 从会话 id 取安全字符串。 */
function idOf(entry: SessionSnapshotLike): string {
  const raw = entry.id ?? entry.header?.id
  return typeof raw === 'string' ? raw : ''
}

/** 事件是否为可折叠形状（有 type 字符串）。 */
function isFoldable(event: unknown): boolean {
  return event !== null && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string'
}

/**
 * 把一个会话的事件从账本游标处续读到末尾。
 * @param deps - 回填依赖。
 * @param id - 会话 id。
 * @param header - 该会话的 header（用于补 cwd/createdAt）。
 * @returns 本次折叠的事件条数。
 */
export async function scanSession(
  deps: BackfillDeps,
  id: string,
  header?: SessionSnapshotLike['header'],
): Promise<number> {
  const { persistence, state } = deps
  if (persistence === undefined) return 0
  const cursor = cursorOf(state, id)
  if (header !== undefined) {
    if (cursor.cwd === undefined && typeof header.cwd === 'string') cursor.cwd = header.cwd
    if (cursor.createdAt === undefined && typeof header.createdAt === 'number') cursor.createdAt = header.createdAt
    if (cursor.origin === undefined && typeof header.origin === 'string') cursor.origin = header.origin
  }
  const handle = await persistence.open(id, 'read')
  let folded = 0
  try {
    for (;;) {
      const result = await handle.read(cursor.consumedSeq, BATCH)
      const events = result?.events
      if (events === undefined || events.length === 0) break
      for (const event of events) {
        if (!isFoldable(event)) continue
        applyEvent(state, id, event as { seq: number; time: number; type: string; data?: unknown }, deps.pending)
        folded += 1
      }
      if (events.length < BATCH) break
    }
  } finally {
    await handle.close?.()
  }
  return folded
}

/**
 * 全量增量回填：列出所有已存会话，逐个续读到末尾。
 *
 * `onlyMissing` 为 true 时只处理账本里还没有记录的会话（用于启动时的快速
 * 补齐）；为 false 时对每个会话都做一次增量续读（用于「重新扫描」按钮）。
 * @param deps - 回填依赖。
 * @param options - `onlyMissing` 控制扫描范围。
 * @returns 扫描统计。
 */
export async function backfill(
  deps: BackfillDeps,
  options: { onlyMissing?: boolean } = {},
): Promise<{ scanned: number; total: number; errors: number; events: number }> {
  const { persistence, state } = deps
  state.backfill.running = true
  if (persistence === undefined) {
    state.backfill.running = false
    state.backfill.done = true
    return { scanned: 0, total: 0, errors: 0, events: 0 }
  }

  let entries: readonly SessionSnapshotLike[] = []
  try {
    entries = await persistence.list()
  } catch (error) {
    state.backfill.running = false
    deps.log?.(`列出会话失败：${String(error)}`)
    return { scanned: 0, total: 0, errors: 1, events: 0 }
  }

  const onlyMissing = options.onlyMissing === true
  const targets = entries.filter((entry) => {
    const id = idOf(entry)
    if (id === '') return false
    return onlyMissing ? state.sessions[id] === undefined : true
  })

  state.backfill.total = targets.length
  state.backfill.scanned = 0
  state.backfill.errors = 0
  state.backfill.failedSessions = []
  state.backfill.startedAt = Date.now()

  let scanned = 0
  let errors = 0
  let events = 0
  for (const entry of targets) {
    const id = idOf(entry)
    try {
      events += await scanSession(deps, id, entry.header)
      scanned += 1
    } catch (error) {
      errors += 1
      // 记下失败的会话 id：历史遗留格式或损坏的日志会走到这里，让面板能说明白。
      const failed = state.backfill.failedSessions
      if (!failed.includes(id)) {
        failed.push(id)
        while (failed.length > FAILED_KEEP) failed.shift()
      }
      deps.log?.(`扫描会话 ${id} 失败：${String(error)}`)
    }
    state.backfill.scanned = scanned
    state.backfill.errors = errors
    deps.onProgress?.()
  }

  state.backfill.running = false
  state.backfill.done = true
  state.backfill.finishedAt = Date.now()
  return { scanned, total: targets.length, errors, events }
}
