/**
 * 面板展示层的数字与日期格式化。
 *
 * 纯函数、无 DOM 依赖，便于单独核对格式化口径。
 *
 * @module @dsh-external/dsh-usage-stats/client/format
 */
/** 千分位整数。 */
export declare function fmtInt(value: number): string;
/** token 缩写（K/M/B）；完整数值放元素的 title。 */
export declare function fmtTokens(value: number): string;
/** 费用（CNY），按量级选小数位。 */
export declare function fmtCost(value: number): string;
/** 时长。 */
export declare function fmtDuration(ms: number): string;
/** 百分比（0–1 输入）。 */
export declare function fmtPercent(ratio: number, digits?: number): string;
/**
 * 柱状图横轴的日期短标签。
 * @param date - `YYYY-MM-DD`。
 * @param todayKey - 今天的日历日键，用于显示「今天」。
 * @returns 今天显示「今天」，其余显示「MM-DD」。
 */
export declare function fmtDayLabel(date: string, todayKey: string): string;
/** 时间戳 → 本地日期（`2026-10-07`）；无效值回退 `—`。 */
export declare function fmtDate(ms: number): string;
/** 时间戳 → 本地日期时间串。 */
export declare function fmtDateTime(ms: number): string;
