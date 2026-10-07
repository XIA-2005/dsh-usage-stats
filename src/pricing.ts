/**
 * DeepSeek 定价表与峰谷时段判定 —— 仅用于「估算」费用，以官方账单为准。
 *
 * 单价单位：CNY / 百万 token。每档是 [谷时价, 峰时价]。
 * 峰时 = 北京时间工作日 9:00–12:00、14:00–18:00；2026-08-23 起周末全天谷价。
 *
 * 模型名匹配是**子串**匹配（小写），因此官方名、中转站的别名、带渠道前缀的
 * 名字（如 `apigoto/deepseek-flash`）都能命中。内置规则覆盖不到的名字
 * **不再静默按基价**：{@link resolvePrice} 会返回 `rule: null` 标记「未收录」，
 * host 侧把它汇总进 `meta.unpricedModels`，面板据此提示。
 *
 * 要接自己的单价（例如中转站与官方不同价）：写一份
 * `%DSH_HOME%/.dsh-usage-stats.prices.json`（见 {@link parsePriceOverrides}），
 * 覆盖规则优先于内置规则，改完点「重建统计」按新价重算历史。
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

/** 基价（flash 档）。 */
const BASE_PRICE: PriceTable = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
/** Pro 档 = 基价 3 倍。 */
const PRO_PRICE: PriceTable = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

/**
 * 内置价表规则：模型名子串（小写）→ 价表，**按声明顺序首个命中生效**。
 *
 * 顺序是契约：档位后缀（`-pro` / `-flash`）必须排在其家族前缀（`deepseek-v4`）
 * 之前，否则 Pro 会被家族规则按基价吃掉。已知的官方名与常见中转别名都在这里：
 * 官方 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-chat` / `deepseek-reasoner`，
 * 中转站的 `deepseek-flash` / `deepseek-pro` / `deepseek-v3` / `deepseek-r1` 等。
 */
const BUILTIN_RULES: readonly (readonly [string, PriceTable])[] = [
  // 精确到档位的官方名（先于家族规则）
  ['deepseek-v4-flash-vision-exp', BASE_PRICE],
  ['deepseek-v4-pro', PRO_PRICE],
  ['deepseek-v4-flash', BASE_PRICE],
  // 中转 / 别名：deepseek-flash、deepseek-pro、apigoto 等渠道名
  ['deepseek-pro', PRO_PRICE],
  ['deepseek-flash', BASE_PRICE],
  // 官方老名与中转别名
  ['deepseek-chat', BASE_PRICE],
  ['deepseek-reasoner', BASE_PRICE],
  ['deepseek-r1', BASE_PRICE],
  // 家族兜底：只写了主版本号时按基价（Pro 已被上面的规则拦下）
  ['deepseek-v4', BASE_PRICE],
  ['deepseek-v3', BASE_PRICE],
]

/** 外部覆盖规则（来自价格覆盖文件），优先于内置规则。 */
let overrideRules: readonly (readonly [string, PriceTable])[] = []

/**
 * 安装外部覆盖规则（覆盖优先于内置规则；重复调用整体替换）。
 * @param rules - 已按优先级排好序的 `[模型名子串, 价表]` 列表；空数组即清空。
 */
export function setPriceOverrides(rules: readonly (readonly [string, PriceTable])[]): void {
  overrideRules = rules
}

/** 当前生效的覆盖规则条数（面板用于说明费用口径来自文件）。 */
export function priceOverrideCount(): number {
  return overrideRules.length
}

/** 一次模型名的解析结果。 */
export interface PriceResolution {
  /** 生效的价表（未收录时为基价）。 */
  readonly table: PriceTable
  /** 命中的规则子串；`null` = 未收录，当前按基价估算。 */
  readonly rule: string | null
}

/**
 * 解析模型名对应的价表，并说明它是否被价表收录。
 *
 * 匹配顺序：外部覆盖规则 → 内置规则 → 基价（`rule: null`）。空名、`(unknown)`
 * 等占位模型名同样返回 `rule: null`，让「估算不准」这件事在面板上可见。
 * @param model - 模型名（如 `deepseek-v4-pro`、`deepseek-flash`）。
 * @returns 价表与命中的规则；未收录时规则为 null。
 */
export function resolvePrice(model: unknown): PriceResolution {
  const name = String(model ?? '').trim().toLowerCase()
  if (name === '' || name === '(unknown)') return { table: BASE_PRICE, rule: null }
  for (const [key, table] of overrideRules) if (name.includes(key)) return { table, rule: key }
  for (const [key, table] of BUILTIN_RULES) if (name.includes(key)) return { table, rule: key }
  return { table: BASE_PRICE, rule: null }
}

/**
 * 解析模型名对应的价表（只关心价格、不关心是否收录时用它）。
 * @param model - 模型名。
 * @returns 该模型的价表；未收录时返回基价。
 */
export function priceFor(model: unknown): PriceTable {
  return resolvePrice(model).table
}

/**
 * 模型名是否被子串规则收录（未收录说明费用只是「基价兜底」，不可信）。
 * @param model - 模型名。
 * @returns 命中任一规则时为 true。
 */
export function isPricedModel(model: unknown): boolean {
  return resolvePrice(model).rule !== null
}

/** 价格覆盖文件的解析结果。 */
export interface ParsedPriceOverrides {
  /** 解析出的规则（保持文件中键的声明顺序）。 */
  readonly rules: readonly (readonly [string, PriceTable])[]
  /** 被跳过的键及原因（不阻断加载，交由调用方记日志）。 */
  readonly problems: readonly string[]
}

/** 读一对非负有限数，形状不对返回 undefined。 */
function pair(value: unknown): readonly [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const [valley, peak] = value as [unknown, unknown]
  if (typeof valley !== 'number' || typeof peak !== 'number') return undefined
  if (!Number.isFinite(valley) || !Number.isFinite(peak)) return undefined
  if (valley < 0 || peak < 0) return undefined
  return [valley, peak]
}

/**
 * 解析价格覆盖文件的内容。
 *
 * 期望形状（与账本同目录的 `.dsh-usage-stats.prices.json`）：
 * ```jsonc
 * {
 *   "deepseek-flash": { "hit": [0.05, 0.1], "miss": [1.5, 3.0], "out": [4.5, 9.0] },
 *   "apigoto/deepseek-pro": { "hit": [0.15, 0.3], "miss": [4.5, 9.0], "out": [13.5, 27.0] }
 * }
 * ```
 * 键是模型名子串（小写匹配），值是该模型的 `[谷时, 峰时]` 三档单价。键序即优先级。
 * 形状不合法的条目被跳过并记入 `problems`，**绝不**让一份坏文件阻断插件加载。
 * @param raw - `JSON.parse` 之后的值（任意）。
 * @returns 可用规则与被跳过的条目说明。
 */
export function parsePriceOverrides(raw: unknown): ParsedPriceOverrides {
  const rules: Array<readonly [string, PriceTable]> = []
  const problems: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { rules, problems: ['覆盖文件顶层必须是「模型名 → 价表」的对象'] }
  }
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase()
    if (key === '') {
      problems.push('存在空的模型名键')
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${rawKey}：价表必须是对象`)
      continue
    }
    const entry = value as Record<string, unknown>
    const hit = pair(entry['hit'])
    const miss = pair(entry['miss'])
    const out = pair(entry['out'])
    if (hit === undefined || miss === undefined || out === undefined) {
      problems.push(`${rawKey}：hit / miss / out 必须都是两个非负数字（[谷时, 峰时]）`)
      continue
    }
    rules.push([key, { hit, miss, out }])
  }
  return { rules, problems }
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
