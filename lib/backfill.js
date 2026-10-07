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
import { FAILED_KEEP, applyEvent, cursorOf } from './fold.js';
/** 每次 read 的事件条数上限（大日志分页，避免一次性载入）。 */
const BATCH = 2000;
/** 从会话 id 取安全字符串。 */
function idOf(entry) {
    const raw = entry.id ?? entry.header?.id;
    return typeof raw === 'string' ? raw : '';
}
/** 事件是否为可折叠形状（有 type 字符串）。 */
function isFoldable(event) {
    return event !== null && typeof event === 'object' && typeof event.type === 'string';
}
/**
 * 把一个会话的事件从账本游标处续读到末尾。
 * @param deps - 回填依赖。
 * @param id - 会话 id。
 * @param header - 该会话的 header（用于补 cwd/createdAt）。
 * @returns 本次折叠的事件条数。
 */
export async function scanSession(deps, id, header) {
    const { persistence, state } = deps;
    if (persistence === undefined)
        return 0;
    const cursor = cursorOf(state, id);
    if (header !== undefined) {
        if (cursor.cwd === undefined && typeof header.cwd === 'string')
            cursor.cwd = header.cwd;
        if (cursor.createdAt === undefined && typeof header.createdAt === 'number')
            cursor.createdAt = header.createdAt;
        if (cursor.origin === undefined && typeof header.origin === 'string')
            cursor.origin = header.origin;
    }
    const handle = await persistence.open(id, 'read');
    let folded = 0;
    try {
        for (;;) {
            const result = await handle.read(cursor.consumedSeq, BATCH);
            const events = result?.events;
            if (events === undefined || events.length === 0)
                break;
            for (const event of events) {
                if (!isFoldable(event))
                    continue;
                applyEvent(state, id, event, deps.pending);
                folded += 1;
            }
            if (events.length < BATCH)
                break;
        }
    }
    finally {
        await handle.close?.();
    }
    return folded;
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
export async function backfill(deps, options = {}) {
    const { persistence, state } = deps;
    state.backfill.running = true;
    if (persistence === undefined) {
        state.backfill.running = false;
        state.backfill.done = true;
        return { scanned: 0, total: 0, errors: 0, events: 0 };
    }
    let entries = [];
    try {
        entries = await persistence.list();
    }
    catch (error) {
        state.backfill.running = false;
        deps.log?.(`列出会话失败：${String(error)}`);
        return { scanned: 0, total: 0, errors: 1, events: 0 };
    }
    const onlyMissing = options.onlyMissing === true;
    const targets = entries.filter((entry) => {
        const id = idOf(entry);
        if (id === '')
            return false;
        return onlyMissing ? state.sessions[id] === undefined : true;
    });
    state.backfill.total = targets.length;
    state.backfill.scanned = 0;
    state.backfill.errors = 0;
    state.backfill.failedSessions = [];
    state.backfill.startedAt = Date.now();
    let scanned = 0;
    let errors = 0;
    let events = 0;
    for (const entry of targets) {
        const id = idOf(entry);
        try {
            events += await scanSession(deps, id, entry.header);
            scanned += 1;
        }
        catch (error) {
            errors += 1;
            // 记下失败的会话 id：历史遗留格式或损坏的日志会走到这里，让面板能说明白。
            const failed = state.backfill.failedSessions;
            if (!failed.includes(id)) {
                failed.push(id);
                while (failed.length > FAILED_KEEP)
                    failed.shift();
            }
            deps.log?.(`扫描会话 ${id} 失败：${String(error)}`);
        }
        state.backfill.scanned = scanned;
        state.backfill.errors = errors;
        deps.onProgress?.();
    }
    state.backfill.running = false;
    state.backfill.done = true;
    state.backfill.finishedAt = Date.now();
    return { scanned, total: targets.length, errors, events };
}
//# sourceMappingURL=backfill.js.map