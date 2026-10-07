/**
 * DeepSeek 定价表与峰谷时段判定 —— 仅用于「估算」费用，以官方账单为准。
 *
 * 单价单位：CNY / 百万 token。每档是 [谷时价, 峰时价]。
 * 峰时 = 北京时间工作日 9:00–12:00、14:00–18:00；2026-08-23 起周末全天谷价。
 * 调价时只改本文件。
 *
 * @module @dsh-external/dsh-usage-stats/pricing
 */

/** 高峰时段（北京时间、工作日；左闭右开的小时区间）。 */
export const PEAK_HOURS: readonly (readonly [number, number])[] = [
  [9, 12],
  [14, 18],
]

/** 周末全天谷价的生效时刻（epoch 秒）= 北京时间 2026-08-23 00:00。 */
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

/** 一个模型的三档单价：[谷时, 峰时]。 */
export interface PriceTable {
  /** 缓存命中输入（cacheRead）。 */
  readonly hit: readonly [number, number]
  /** 缓存未命中输入（未缓存输入 + 缓存写入）。 */
  readonly miss: readonly [number, number]
  /** 输出（已含思维链）。 */
  readonly out: readonly [number, number]
}

/** 基价（deepseek-v4-flash 档）。 */
const BASE_PRICE: PriceTable = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
/** Pro 档 = 基价 3 倍。 */
const PRO_PRICE: PriceTable = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

/** 模型名子串 → 价表，按声明顺序匹配，未知名按基价估算。 */
const PRICING: readonly (readonly [string, PriceTable])[] = [
  ['deepseek-v4-flash-vision-exp', BASE_PRICE],
  ['deepseek-v4-flash', BASE_PRICE],
  ['deepseek-v4-pro', PRO_PRICE],
  ['deepseek-chat', BASE_PRICE],
  ['deepseek-reasoner', BASE_PRICE],
]

/**
 * 解析模型名对应的价表。
 * @param model - 模型名（如 `deepseek-v4-pro`）；空值或未知名按基价。
 * @returns 该模型的价表。
 */
export function priceFor(model: unknown): PriceTable {
  const name = String(model ?? '').toLowerCase()
  for (const [key, table] of PRICING) if (name.includes(key)) return table
  return BASE_PRICE
}

/**
 * 判断某一时刻是否处于高峰时段。
 * @param ms - epoch 毫秒（事件时间戳）。
 * @returns 峰时为 true；非有限值一律 false（按谷价）。
 */
export function isPeak(ms: number): boolean {
  if (!Number.isFinite(ms)) return false
  const sec = Math.floor(ms / 1000)
  // 按 UTC 读法读北京日历：偏移 8 小时后 getUTC* 即北京时间字段。
  const beijing = new Date(sec * 1000 + 8 * 3600 * 1000)
  if (sec >= WEEKEND_VALLEY_FROM_SEC) {
    const day = beijing.getUTCDay()
    if (day === 0 || day === 6) return false
  }
  const hour = beijing.getUTCHours()
  for (const [start, end] of PEAK_HOURS) if (hour >= start && hour < end) return true
  return false
}

/** 一次模型调用的用量桶（**互斥**计数：billed input = 前三者之和）。 */
export interface UsageSample {
  /** 未缓存输入。 */
  readonly inputTokens: number
  /** 缓存命中读取。 */
  readonly cacheReadTokens: number
  /** 缓存写入。 */
  readonly cacheWriteTokens: number
  /** 输出（已含思维链，勿再加 reasoningTokens）。 */
  readonly outputTokens: number
}

/**
 * 估算一次模型调用的费用。
 *
 * 计价口径：`cacheRead × 命中价 + (未缓存输入 + 缓存写入) × 未命中价 + 输出 × 输出价`，
 * 峰谷由**事件自身时间戳**决定，因此历史回填也能还原当时的时段价。
 * @param usage - 该次调用的互斥用量桶。
 * @param model - 该次调用的模型名。
 * @param ms - 事件时间戳（epoch 毫秒）。
 * @returns 估算费用（CNY）。
 */
export function costOf(usage: UsageSample, model: unknown, ms: number): number {
  const price = priceFor(model)
  const tier = isPeak(ms) ? 1 : 0
  const billedInput = usage.inputTokens + usage.cacheWriteTokens
  return (
    (usage.cacheReadTokens * price.hit[tier] +
      billedInput * price.miss[tier] +
      usage.outputTokens * price.out[tier]) /
    1e6
  )
}
