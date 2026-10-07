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
/** 四桶互斥 token 用量 + 估算费用。 */
export interface UsageTotals {
    /** 未缓存输入。 */
    uncachedInputTokens: number;
    /** 缓存命中读取。 */
    cacheReadTokens: number;
    /** 缓存写入。 */
    cacheWriteTokens: number;
    /** 输出（已含思维链）。 */
    outputTokens: number;
    /** 估算费用（CNY），逐次调用按当时峰谷价累加。 */
    costCny: number;
}
/** 全局累计量。 */
export interface Totals extends UsageTotals {
    /** 计入统计的会话数。 */
    sessions: number;
    /** 轮次数（按 step/end 的 turn 变化去重）。 */
    turns: number;
    /** 步数。 */
    steps: number;
    /** 工具调用总次数。 */
    toolCalls: number;
}
/** 单个工具的统计。 */
export interface ToolStat {
    /** 调用次数。 */
    calls: number;
    /** 累计耗时（毫秒，tool/call → tool/result 配对）。 */
    ms: number;
}
/** 单日统计（北京时间日历日）。 */
export interface DayStat extends UsageTotals {
    /** 当日工具调用次数。 */
    toolCalls: number;
    /** 当日模型调用次数。 */
    modelCalls: number;
}
/** 单模型统计（用于核对费用口径：Pro 档单价是基价 3 倍）。 */
export interface ModelStat extends UsageTotals {
    /** 该模型的调用次数。 */
    calls: number;
}
/** 单会话游标与元数据。 */
export interface SessionCursor {
    /** 下一个待折叠的逻辑 seq。 */
    consumedSeq: number;
    /** 会话工作目录（来自存储在会话 header 的 cwd）。 */
    cwd?: string;
    /** 会话创建时刻（epoch 毫秒）。 */
    createdAt?: number;
    /** 最近一次计数的 turn，用于轮次去重。 */
    lastTurn?: number;
    /** 会话来源（`root` / `subagent`）。 */
    origin?: string;
    /** 该会话的用量汇总（用于「最贵的对话」排行；老账本可能没有）。 */
    usage?: UsageTotals;
    /** 该会话的模型调用次数。 */
    modelCalls?: number;
    /** 该会话的工具调用次数。 */
    toolCalls?: number;
}
/** 回填进度。 */
export interface BackfillState {
    /** 是否已完成过一次全量回填。 */
    done: boolean;
    /** 已扫描会话数。 */
    scanned: number;
    /** 待扫描会话总数。 */
    total: number;
    /** 本次回填开始时刻。 */
    startedAt?: number;
    /** 本次回填结束时刻。 */
    finishedAt?: number;
    /** 读取失败的会话数。 */
    errors: number;
    /** 当前是否正在回填。 */
    running: boolean;
    /** 最近读取失败的会话 id（最多 {@link FAILED_KEEP} 个）。 */
    failedSessions: string[];
}
/** 账本根状态。 */
export interface LedgerState {
    /** 结构版本。 */
    version: number;
    /** 最近一次变更时刻（epoch 毫秒）。 */
    updatedAt: number;
    totals: Totals;
    /** 工具名 → 统计。 */
    tools: Record<string, ToolStat>;
    /** 北京时间日历日 → 当日统计。 */
    days: Record<string, DayStat>;
    /** 模型名 → 统计。 */
    models: Record<string, ModelStat>;
    /** 会话 id → 游标。 */
    sessions: Record<string, SessionCursor>;
    /**
     * 天 × 模型明细：`YYYY-MM-DD` → 模型名 → 统计。
     *
     * 面板的「按模型」饼图与选中日期后的联动需要它。只保留最近
     * {@link DETAIL_KEEP_DAYS} 天，超出由 {@link pruneDetail} 删除；
     * 天汇总 `days` 则永久保留。
     */
    dayModels: Record<string, Record<string, ModelStat>>;
    /** 天 × 工具明细：`YYYY-MM-DD` → 工具名 → { calls, ms }。 */
    dayTools: Record<string, Record<string, ToolStat>>;
    /** 天 × 会话明细：`YYYY-MM-DD` → 会话 id → 用量。 */
    daySessions: Record<string, Record<string, UsageTotals>>;
    backfill: BackfillState;
}
/** 当前账本结构版本。 */
export declare const LEDGER_VERSION = 1;
/** 失败会话 id 的保留条数。 */
export declare const FAILED_KEEP = 20;
/**
 * 按天明细（dayModels / dayTools / daySessions）的保留天数。
 *
 * 天汇总 `days` 永久保留；明细按天增长（实测约 3–5 KB/天），120 天约 0.5 MB，
 * 足够覆盖交互式图表的常用窗口，又不会让账本无限膨胀。
 */
export declare const DETAIL_KEEP_DAYS = 120;
/** 折叠所需的事件最小结构（SessionEvent 满足它）。 */
export interface FoldEvent {
    /** 会话内连续递增的逻辑序号。 */
    seq: number;
    /** 事件时刻（epoch 毫秒）。 */
    time: number;
    /** 事件类型。 */
    type: string;
    /** 事件负载。 */
    data?: unknown;
}
/** 挂起中的工具调用：会话 id → (callId → 工具名与派发时刻)。进程内、不上盘。 */
export type PendingCalls = Map<string, Map<string, {
    name: string;
    time: number;
}>>;
/** 空的用量桶。 */
export declare function emptyUsage(): UsageTotals;
/** 空的单日统计。 */
export declare function emptyDay(): DayStat;
/** 空的全局累计。 */
export declare function emptyTotals(): Totals;
/** 一份全新的空账本。 */
export declare function emptyState(): LedgerState;
/**
 * 就地清空账本（保留对象引用，让已持有它的调用方继续有效）。
 *
 * 用于「重建统计」：口径变化（如定价表调整、新增维度）后需要从零重放历史，
 * 而游标一旦推进就不会回头，所以只能清空重扫。
 * @param state - 待清空的账本状态。
 */
export declare function resetState(state: LedgerState): void;
/**
 * 北京时间日历日键。
 * @param ms - epoch 毫秒。
 * @returns `YYYY-MM-DD`；非有限值归入 `unknown`。
 */
export declare function dayKey(ms: number): string;
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
export declare function pruneDetail(state: LedgerState, now: number): number;
/**
 * 统计「有当日汇总、却没有任何按天明细」的天数。
 *
 * 按天明细是后加维度，插件升级后**当天就会立刻产生新明细**，因此不能用
 * 「明细表是否为空」判断历史缺失（会被当天的实时明细掩盖）—— 必须逐日比对。
 * @param state - 账本。
 * @returns 缺明细的天数（0 表示明细完整）。
 */
export declare function countDaysMissingDetail(state: LedgerState): number;
/**
 * 取（必要时建立）会话游标；首次见到某会话时计入会话数。
 * @param state - 账本状态（就地更新）。
 * @param sessionId - 会话 id。
 * @returns 该会话的游标对象（可变引用）。
 */
export declare function cursorOf(state: LedgerState, sessionId: string): SessionCursor;
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
export declare function applyEvent(state: LedgerState, sessionId: string, event: FoldEvent, pending: PendingCalls): boolean;
