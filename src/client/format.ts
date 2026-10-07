/**
 * 面板展示层的数字与日期格式化。
 *
 * 纯函数、无 DOM 依赖，便于单独核对格式化口径。
 *
 * @module @dsh-external/dsh-usage-stats/client/format
 */

/** 千分位整数。 */
export function fmtInt(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** token 缩写（K/M/B）；完整数值放元素的 title。 */
export function fmtTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(Math.round(value))
}

/** 费用（CNY），按量级选小数位。 */
export function fmtCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '¥0'
  if (value < 0.01) return `¥${value.toFixed(4)}`
  if (value < 1) return `¥${value.toFixed(3)}`
  return `¥${value.toFixed(2)}`
}

/** 时长。 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${Math.round(seconds - minutes * 60)}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes - hours * 60}m`
}

/** 百分比（0–1 输入）。 */
export function fmtPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  const percent = ratio * 100
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(digits)}%`
}

/**
 * 柱状图横轴的日期短标签。
 * @param date - `YYYY-MM-DD`。
 * @param todayKey - 今天的日历日键，用于显示「今天」。
 * @returns 今天显示「今天」，其余显示「MM-DD」。
 */
export function fmtDayLabel(date: string, todayKey: string): string {
  if (date === todayKey) return '今天'
  return date.length >= 10 ? date.slice(5) : date
}

/** 时间戳 → 本地日期（`2026-10-07`）；无效值回退 `—`。 */
export function fmtDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 时间戳 → 本地日期时间串。 */
export function fmtDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}
