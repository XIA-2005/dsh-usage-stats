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
import { costOf } from './pricing.js';
/** 当前账本结构版本。 */
export const LEDGER_VERSION = 1;
/** 失败会话 id 的保留条数。 */
export const FAILED_KEEP = 20;
/**
 * 按天明细（dayModels / dayTools / daySessions）的保留天数。
 *
 * 天汇总 `days` 永久保留；明细按天增长（实测约 3–5 KB/天），120 天约 0.5 MB，
 * 足够覆盖交互式图表的常用窗口，又不会让账本无限膨胀。
 */
export const DETAIL_KEEP_DAYS = 120;
/** 挂起表单会话上限，防止无结果的调用无限堆积。 */
const PENDING_LIMIT = 200;
/** 空的用量桶。 */
export function emptyUsage() {
    return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costCny: 0 };
}
/** 空的单日统计。 */
export function emptyDay() {
    return { ...emptyUsage(), toolCalls: 0, modelCalls: 0 };
}
/** 空的全局累计。 */
export function emptyTotals() {
    return { ...emptyUsage(), sessions: 0, turns: 0, steps: 0, toolCalls: 0 };
}
/** 一份全新的空账本。 */
export function emptyState() {
    return {
        version: LEDGER_VERSION,
        updatedAt: 0,
        totals: emptyTotals(),
        tools: {},
        days: {},
        models: {},
        sessions: {},
        dayModels: {},
        dayTools: {},
        daySessions: {},
        backfill: { done: false, scanned: 0, total: 0, errors: 0, running: false, failedSessions: [] },
    };
}
/**
 * 就地清空账本（保留对象引用，让已持有它的调用方继续有效）。
 *
 * 用于「重建统计」：口径变化（如定价表调整、新增维度）后需要从零重放历史，
 * 而游标一旦推进就不会回头，所以只能清空重扫。
 * @param state - 待清空的账本状态。
 */
export function resetState(state) {
    const fresh = emptyState();
    state.version = fresh.version;
    state.updatedAt = Date.now();
    state.totals = fresh.totals;
    state.tools = {};
    state.days = {};
    state.models = {};
    state.sessions = {};
    state.dayModels = {};
    state.dayTools = {};
    state.daySessions = {};
    state.backfill = fresh.backfill;
}
/**
 * 北京时间日历日键。
 * @param ms - epoch 毫秒。
 * @returns `YYYY-MM-DD`；非有限值归入 `unknown`。
 */
export function dayKey(ms) {
    if (!Number.isFinite(ms))
        return 'unknown';
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
/**
 * 裁剪过期的按天明细（天汇总 `days` 不受影响）。
 *
 * 明细是「天 × 维度」的嵌套字典，按天线性增长。日历日键 `YYYY-MM-DD` 的
 * 字典序等价于时间序，因此这里直接用字符串比较丢弃早于
 * `now - DETAIL_KEEP_DAYS` 的整日条目。
 * @param state - 账本状态（就地裁剪）。
 * @param now - 当前时刻（epoch 毫秒）。
 * @returns 被删除的天条目数（三个明细表合计）。
 */
export function pruneDetail(state, now) {
    const cutoff = dayKey(now - DETAIL_KEEP_DAYS * 86_400_000);
    let removed = 0;
    for (const table of [state.dayModels, state.dayTools, state.daySessions]) {
        for (const key of Object.keys(table)) {
            if (key < cutoff) {
                delete table[key];
                removed += 1;
            }
        }
    }
    return removed;
}
/**
 * 统计「有当日汇总、却没有任何按天明细」的天数。
 *
 * 按天明细是后加维度，插件升级后**当天就会立刻产生新明细**，因此不能用
 * 「明细表是否为空」判断历史缺失（会被当天的实时明细掩盖）—— 必须逐日比对。
 * @param state - 账本。
 * @returns 缺明细的天数（0 表示明细完整）。
 */
export function countDaysMissingDetail(state) {
    let missing = 0;
    for (const key of Object.keys(state.days)) {
        if (state.dayModels[key] === undefined &&
            state.dayTools[key] === undefined &&
            state.daySessions[key] === undefined) {
            missing += 1;
        }
    }
    return missing;
}
/**
 * 取（必要时建立）会话游标；首次见到某会话时计入会话数。
 * @param state - 账本状态（就地更新）。
 * @param sessionId - 会话 id。
 * @returns 该会话的游标对象（可变引用）。
 */
export function cursorOf(state, sessionId) {
    let cursor = state.sessions[sessionId];
    if (cursor === undefined) {
        cursor = { consumedSeq: 0 };
        state.sessions[sessionId] = cursor;
        state.totals.sessions += 1;
    }
    return cursor;
}
/** 读取非负有限数，其余归零。 */
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
/** 就地累加一次调用的用量与费用。 */
function addUsage(target, input, cacheRead, cacheWrite, output, cost) {
    target.uncachedInputTokens += input;
    target.cacheReadTokens += cacheRead;
    target.cacheWriteTokens += cacheWrite;
    target.outputTokens += output;
    target.costCny += cost;
}
/** 取（必要时建立）该会话的挂起表。 */
function pendingFor(pending, sessionId) {
    let table = pending.get(sessionId);
    if (table === undefined) {
        table = new Map();
        pending.set(sessionId, table);
    }
    return table;
}
/** 把事件负载当对象读取（非对象一律按空对象处理）。 */
function payload(event) {
    const data = event.data;
    return data !== null && typeof data === 'object' ? data : {};
}
/** 从 tool/result 负载里取配对的 callId。 */
function resultCallId(data) {
    const message = data.message;
    if (message === null || typeof message !== 'object')
        return undefined;
    const source = message.source;
    if (source === null || typeof source !== 'object')
        return undefined;
    const callId = source.callId;
    return callId === undefined || callId === null ? undefined : String(callId);
}
/** 从 assistant/message 负载里取模型名。 */
function resultModel(data) {
    const message = data.message;
    if (message === null || typeof message !== 'object')
        return '(unknown)';
    const source = message.source;
    if (source === null || typeof source !== 'object')
        return '(unknown)';
    const model = source.model;
    return typeof model === 'string' && model !== '' ? model : '(unknown)';
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
export function applyEvent(state, sessionId, event, pending) {
    const cursor = cursorOf(state, sessionId);
    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1;
    // 游标去重：两条路径（实时 / 回填）看到同一事件时只计一次。
    if (seq >= 0 && seq < cursor.consumedSeq)
        return false;
    const data = payload(event);
    const ms = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0;
    switch (event.type) {
        case 'tool/call': {
            const raw = data.name;
            const name = typeof raw === 'string' && raw !== '' ? raw : '(unknown)';
            const stat = (state.tools[name] ??= { calls: 0, ms: 0 });
            stat.calls += 1;
            state.totals.toolCalls += 1;
            cursor.toolCalls = (cursor.toolCalls ?? 0) + 1;
            const date = dayKey(ms);
            const day = (state.days[date] ??= emptyDay());
            day.toolCalls += 1;
            // 天 × 工具：饼图「按工具」的按天数据源（耗时在 tool/result 侧累加）。
            const dayTool = ((state.dayTools[date] ??= {})[name] ??= { calls: 0, ms: 0 });
            dayTool.calls += 1;
            const callId = data.callId;
            if (callId !== undefined && callId !== null) {
                const table = pendingFor(pending, sessionId);
                table.set(String(callId), { name, time: ms });
                while (table.size > PENDING_LIMIT) {
                    const oldest = table.keys().next();
                    if (oldest.done === true)
                        break;
                    table.delete(oldest.value);
                }
            }
            break;
        }
        case 'tool/result': {
            const callId = resultCallId(data);
            if (callId === undefined)
                break;
            const table = pending.get(sessionId);
            const dispatched = table?.get(callId);
            if (table === undefined || dispatched === undefined)
                break;
            table.delete(callId);
            const elapsed = Math.max(0, ms - dispatched.time);
            const stat = (state.tools[dispatched.name] ??= { calls: 0, ms: 0 });
            stat.ms += elapsed;
            // 耗时归到 result 事件当日，与全局 tools.ms 完全同口径。
            const dayTool = ((state.dayTools[dayKey(ms)] ??= {})[dispatched.name] ??= { calls: 0, ms: 0 });
            dayTool.ms += elapsed;
            break;
        }
        case 'assistant/message': {
            const raw = data.usage;
            if (raw === null || typeof raw !== 'object')
                break;
            const usage = raw;
            const input = num(usage.inputTokens);
            const cacheRead = num(usage.cacheReadTokens);
            const cacheWrite = num(usage.cacheWriteTokens);
            const output = num(usage.outputTokens);
            if (input + cacheRead + cacheWrite + output === 0)
                break;
            const model = resultModel(data);
            const cost = costOf({ inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output }, model, ms);
            addUsage(state.totals, input, cacheRead, cacheWrite, output, cost);
            const date = dayKey(ms);
            const day = (state.days[date] ??= emptyDay());
            addUsage(day, input, cacheRead, cacheWrite, output, cost);
            day.modelCalls += 1;
            const stat = (state.models[model] ??= { ...emptyUsage(), calls: 0 });
            stat.calls += 1;
            addUsage(stat, input, cacheRead, cacheWrite, output, cost);
            // 天 × 模型：饼图「按模型」的按天数据源。
            const dayModel = ((state.dayModels[date] ??= {})[model] ??= { ...emptyUsage(), calls: 0 });
            dayModel.calls += 1;
            addUsage(dayModel, input, cacheRead, cacheWrite, output, cost);
            // 天 × 会话：选中某日时回答「那天是哪些对话在用」。
            addUsage(((state.daySessions[date] ??= {})[sessionId] ??= emptyUsage()), input, cacheRead, cacheWrite, output, cost);
            // 会话自身的用量：用于回答「哪个对话最贵」。
            addUsage((cursor.usage ??= emptyUsage()), input, cacheRead, cacheWrite, output, cost);
            cursor.modelCalls = (cursor.modelCalls ?? 0) + 1;
            break;
        }
        case 'step/end': {
            state.totals.steps += 1;
            const turn = data.turn;
            if (typeof turn === 'number' && Number.isFinite(turn) && turn !== cursor.lastTurn) {
                state.totals.turns += 1;
                cursor.lastTurn = turn;
            }
            break;
        }
        default:
            break;
    }
    if (seq >= 0 && seq + 1 > cursor.consumedSeq)
        cursor.consumedSeq = seq + 1;
    return true;
}
//# sourceMappingURL=fold.js.map