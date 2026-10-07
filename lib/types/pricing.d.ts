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
export declare const PEAK_HOURS: readonly (readonly [number, number])[];
/** 一个模型的三档单价：[谷时, 峰时]。 */
export interface PriceTable {
    /** 缓存命中输入（cacheRead）。 */
    readonly hit: readonly [number, number];
    /** 缓存未命中输入（未缓存输入 + 缓存写入）。 */
    readonly miss: readonly [number, number];
    /** 输出（已含思维链）。 */
    readonly out: readonly [number, number];
}
/**
 * 安装外部覆盖规则（覆盖优先于内置规则；重复调用整体替换）。
 * @param rules - 已按优先级排好序的 `[模型名子串, 价表]` 列表；空数组即清空。
 */
export declare function setPriceOverrides(rules: readonly (readonly [string, PriceTable])[]): void;
/** 当前生效的覆盖规则条数（面板用于说明费用口径来自文件）。 */
export declare function priceOverrideCount(): number;
/** 一次模型名的解析结果。 */
export interface PriceResolution {
    /** 生效的价表（未收录时为基价）。 */
    readonly table: PriceTable;
    /** 命中的规则子串；`null` = 未收录，当前按基价估算。 */
    readonly rule: string | null;
}
/**
 * 解析模型名对应的价表，并说明它是否被价表收录。
 *
 * 匹配顺序：外部覆盖规则 → 内置规则 → 基价（`rule: null`）。空名、`(unknown)`
 * 等占位模型名同样返回 `rule: null`，让「估算不准」这件事在面板上可见。
 * @param model - 模型名（如 `deepseek-v4-pro`、`deepseek-flash`）。
 * @returns 价表与命中的规则；未收录时规则为 null。
 */
export declare function resolvePrice(model: unknown): PriceResolution;
/**
 * 解析模型名对应的价表（只关心价格、不关心是否收录时用它）。
 * @param model - 模型名。
 * @returns 该模型的价表；未收录时返回基价。
 */
export declare function priceFor(model: unknown): PriceTable;
/**
 * 模型名是否被子串规则收录（未收录说明费用只是「基价兜底」，不可信）。
 * @param model - 模型名。
 * @returns 命中任一规则时为 true。
 */
export declare function isPricedModel(model: unknown): boolean;
/** 价格覆盖文件的解析结果。 */
export interface ParsedPriceOverrides {
    /** 解析出的规则（保持文件中键的声明顺序）。 */
    readonly rules: readonly (readonly [string, PriceTable])[];
    /** 被跳过的键及原因（不阻断加载，交由调用方记日志）。 */
    readonly problems: readonly string[];
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
export declare function parsePriceOverrides(raw: unknown): ParsedPriceOverrides;
/**
 * 判断某一时刻是否处于高峰时段。
 * @param ms - epoch 毫秒（事件时间戳）。
 * @returns 峰时为 true；非有限值一律 false（按谷价）。
 */
export declare function isPeak(ms: number): boolean;
/** 一次模型调用的用量桶（**互斥**计数：billed input = 前三者之和）。 */
export interface UsageSample {
    /** 未缓存输入。 */
    readonly inputTokens: number;
    /** 缓存命中读取。 */
    readonly cacheReadTokens: number;
    /** 缓存写入。 */
    readonly cacheWriteTokens: number;
    /** 输出（已含思维链，勿再加 reasoningTokens）。 */
    readonly outputTokens: number;
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
export declare function costOf(usage: UsageSample, model: unknown, ms: number): number;
