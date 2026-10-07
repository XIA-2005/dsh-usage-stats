/**
 * 账本持久化：加载、规整、原子写与防抖落盘。
 *
 * 落盘策略：内存是权威，变更后防抖 2 秒写一次；写盘走「临时文件 + rename」
 * 保证不会出现半截 JSON。文件损坏时备份原文件并以空账本重建，绝不因统计
 * 数据拖垮宿主。
 *
 * @module @dsh-external/dsh-usage-stats/ledger
 */
import { type LedgerState } from './fold.js';
/** 加载结果。 */
export interface LedgerLoadResult {
    /** 可用的账本状态（损坏时为全新空账本）。 */
    state: LedgerState;
    /** 需要向用户展示的提示（如「已备份损坏账本并重建」）。 */
    notice?: string;
    /** 是否从磁盘读到了既有账本。 */
    loaded: boolean;
}
/**
 * 把任意 JSON 值规整为合法账本状态；版本不符则整体丢弃重建。
 * @param raw - 解析后的 JSON 值。
 * @returns 可安全使用的账本状态。
 */
export declare function normalizeLedger(raw: unknown): LedgerState;
/**
 * 读取账本文件；不存在返回空账本，损坏则备份后重建。
 * @param file - 账本绝对路径。
 * @returns 加载结果（含给用户看的提示）。
 */
export declare function loadLedger(file: string): LedgerLoadResult;
/**
 * 账本写盘器：内存状态 + 防抖落盘 + 原子替换。
 *
 * 卸载与进程退出前调用 {@link flush}，保证最后一次统计不丢。
 */
export declare class LedgerStore {
    /** 账本文件路径。 */
    readonly file: string;
    /** 当前内存状态（调用方直接就地修改，然后 {@link touch}）。 */
    readonly state: LedgerState;
    /** 最近一次写盘失败的原因（成功后被清除）。 */
    private writeError;
    private timer;
    private dirty;
    constructor(file: string, state: LedgerState);
    /** 最近一次写盘失败原因；undefined 表示一切正常。 */
    get lastError(): string | undefined;
    /** 标记状态已变更，安排一次防抖落盘。 */
    touch(): void;
    /**
     * 立即落盘（卸载、重扫等需要确定性的时机调用）。
     * @returns 失败原因；undefined 表示已写入或本就无变更。
     */
    flush(): string | undefined;
    /** 取消待落盘定时器（不写盘；由 {@link flush} 负责最后一次写）。 */
    dispose(): void;
}
