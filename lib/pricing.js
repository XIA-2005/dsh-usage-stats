/**
 * DeepSeek 定价表与峰谷时段判定 —— 仅用于「估算」费用，以官方账单为准。
 *
 * 单价单位：CNY / 百万 token。每档是 [空闲时段价, 高峰时段价]。
 *
 * 官方口径（https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ ，2026-10 核对）：
 * - `deepseek-flash`（DeepSeek-V4.1-Flash）与 `deepseek-v4-pro`（DeepSeek-V4-Pro-0813）；
 *   旧模型名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍可调用，**按 Flash 价计费**。
 * - 空闲时段价为高峰时段价的一半；高峰时段 = 北京时间**周一至周五（不含中国法定节假日）**
 *   9:00–12:00、14:00–18:00，其余时段（含周末与中国法定节假日全天）均为空闲时段。
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
export const PEAK_HOURS = [
    [9, 12],
    [14, 18],
];
/**
 * 「周末全天空闲」的生效时刻（epoch 秒）= 北京时间 2026-08-23 00:00。
 *
 * 官方页现在把周末整体列为空闲；这个时间点之前的历史按当时的规则（周末同样有峰谷）
 * 计价，因此回填历史时不会用新规则改写旧账。
 */
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000);
/**
 * 2026 年中国法定节假日（北京时间日历日，全天按空闲时段计价）。
 *
 * 来源：国务院办公厅《关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）。
 * **只覆盖 2026 年**：表外的年份退回「周一至周五 = 高峰」的规则；官方每年 11 月前后
 * 公布次年安排，届时把新年份补进来即可（改完点「重建统计」重算）。
 */
const HOLIDAYS = new Set([
    // 元旦：1月1日至3日
    '2026-01-01', '2026-01-02', '2026-01-03',
    // 春节：2月15日至23日
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    // 清明：4月4日至6日
    '2026-04-04', '2026-04-05', '2026-04-06',
    // 劳动节：5月1日至5日
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    // 端午：6月19日至21日
    '2026-06-19', '2026-06-20', '2026-06-21',
    // 中秋：9月25日至27日
    '2026-09-25', '2026-09-26', '2026-09-27',
    // 国庆：10月1日至7日
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]);
/**
 * 2026 年调休上班日（周末但按工作日上班）：1/4、2/14、2/28、5/9、9/20、10/10。
 *
 * 官方页把「周末」整体列为空闲时段，但没说清调休上班日怎么算（它名义上是工作日）。
 * 本插件按官方措辞的**字面**处理：周末一律空闲，调休日也不例外。
 * 若实际账单显示调休日按高峰计价，把 {@link MAKEUP_WORKDAYS_ARE_PEAK} 改成 true 即可。
 */
const MAKEUP_WORKDAYS = new Set([
    '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
]);
/** 调休上班日是否按高峰时段计价（默认 false = 按官方措辞的字面，周末含调休一律空闲）。 */
const MAKEUP_WORKDAYS_ARE_PEAK = false;
/**
 * Flash 档单价 = 官方 `deepseek-flash`：命中 0.02/0.04、未命中 1/2、输出 4/8。
 *
 * 历史教训：这里曾写成 0.05/0.1、1.5/3、4.5/9（整体偏高 1.125–2.5 倍），
 * 因为缓存命中价被记成 0.05 而不是 0.02，金额因此系统性高估。改价前务必对着
 * 官方页逐行抄，别按「大概是几倍」推算。
 */
const FLASH_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] };
/**
 * Pro 档单价 = 官方 `deepseek-v4-pro`：命中 0.15/0.30、未命中 4.5/9、输出 13.5/27。
 *
 * **显式写死，不再由 Flash 价乘系数推算**：Pro 相对 Flash 的倍率并不统一
 * （命中 7.5×、未命中 4.5×、输出 3.375×），任何「按倍数推」的写法迟早会错。
 */
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] };
/**
 * 内置价表规则：模型名子串（小写）→ 价表，**按声明顺序首个命中生效**。
 *
 * 只收录官方价格页明确列出的模型与官方说明的旧名；官方页已经不再列出的历史名
 * （`deepseek-chat` / `deepseek-reasoner` / `deepseek-v3` / `deepseek-r1` 等）**故意不收**：
 * 它们的现价无从核对，宁可让面板报「未收录价表」，也不要给一个看起来正常的假数字
 * —— 需要用的人可以在单价覆盖文件里自己补。
 */
const BUILTIN_RULES = [
    // 官方说明仍可调用、按 Flash 计费的旧名（更长者在前，避免被短规则截胡）
    ['deepseek-v4-flash-vision-exp', FLASH_PRICE],
    ['deepseek-v4-flash', FLASH_PRICE],
    // Pro 档
    ['deepseek-v4-pro', PRO_PRICE],
    ['deepseek-pro', PRO_PRICE],
    // 官方当前模型名
    ['deepseek-flash', FLASH_PRICE],
];
/** 外部覆盖规则（来自价格覆盖文件），优先于内置规则。 */
let overrideRules = [];
/**
 * 安装外部覆盖规则（覆盖优先于内置规则；重复调用整体替换）。
 * @param rules - 已按优先级排好序的 `[模型名子串, 价表]` 列表；空数组即清空。
 */
export function setPriceOverrides(rules) {
    overrideRules = rules;
}
/** 当前生效的覆盖规则条数（面板用于说明费用口径来自文件）。 */
export function priceOverrideCount() {
    return overrideRules.length;
}
/**
 * 未收录模型的兜底价 = Flash 档。
 *
 * 这仍是**猜测**（未知模型可能比 Flash 贵），所以它一定会带 `rule: null`，
 * 由面板提示「费用仅供参考」；不要指望这个数字准确。
 */
const FALLBACK_PRICE = FLASH_PRICE;
/**
 * 解析模型名对应的价表，并说明它是否被价表收录。
 *
 * 匹配顺序：外部覆盖规则 → 内置规则 → 兜底价（`rule: null`）。空名、`(unknown)`
 * 等占位模型名同样返回 `rule: null`，让「估算不准」这件事在面板上可见。
 * @param model - 模型名（如 `deepseek-v4-pro`、`deepseek-flash`）。
 * @returns 价表与命中的规则；未收录时规则为 null。
 */
export function resolvePrice(model) {
    const name = String(model ?? '').trim().toLowerCase();
    if (name === '' || name === '(unknown)')
        return { table: FALLBACK_PRICE, rule: null };
    for (const [key, table] of overrideRules)
        if (name.includes(key))
            return { table, rule: key };
    for (const [key, table] of BUILTIN_RULES)
        if (name.includes(key))
            return { table, rule: key };
    return { table: FALLBACK_PRICE, rule: null };
}
/**
 * 解析模型名对应的价表（只关心价格、不关心是否收录时用它）。
 * @param model - 模型名。
 * @returns 该模型的价表；未收录时返回兜底价（Flash 档）。
 */
export function priceFor(model) {
    return resolvePrice(model).table;
}
/**
 * 模型名是否被子串规则收录（未收录说明费用只是「兜底价」，不可信）。
 * @param model - 模型名。
 * @returns 命中任一规则时为 true。
 */
export function isPricedModel(model) {
    return resolvePrice(model).rule !== null;
}
/** 读一对非负有限数，形状不对返回 undefined。 */
function pair(value) {
    if (!Array.isArray(value) || value.length !== 2)
        return undefined;
    const [valley, peak] = value;
    if (typeof valley !== 'number' || typeof peak !== 'number')
        return undefined;
    if (!Number.isFinite(valley) || !Number.isFinite(peak))
        return undefined;
    if (valley < 0 || peak < 0)
        return undefined;
    return [valley, peak];
}
/**
 * 解析价格覆盖文件的内容。
 *
 * 期望形状（与账本同目录的 `.dsh-usage-stats.prices.json`）：
 * ```jsonc
 * {
 *   // 官方 deepseek-flash 现价（2026-10）：命中 0.02/0.04、未命中 1/2、输出 4/8
 *   "deepseek-flash": { "hit": [0.02, 0.04], "miss": [1, 2], "out": [4, 8] },
 *   // 中转站若与官方不同价，按自己的账单写；键序即优先级
 *   "apigoto/deepseek-pro": { "hit": [0.15, 0.3], "miss": [4.5, 9], "out": [13.5, 27] }
 * }
 * ```
 * 键是模型名子串（小写匹配），值是该模型的 `[空闲时段价, 高峰时段价]` 三档单价。键序即优先级。
 * 形状不合法的条目被跳过并记入 `problems`，**绝不**让一份坏文件阻断插件加载。
 * @param raw - `JSON.parse` 之后的值（任意）。
 * @returns 可用规则与被跳过的条目说明。
 */
export function parsePriceOverrides(raw) {
    const rules = [];
    const problems = [];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { rules, problems: ['覆盖文件顶层必须是「模型名 → 价表」的对象'] };
    }
    for (const [rawKey, value] of Object.entries(raw)) {
        const key = rawKey.trim().toLowerCase();
        if (key === '') {
            problems.push('存在空的模型名键');
            continue;
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            problems.push(`${rawKey}：价表必须是对象`);
            continue;
        }
        const entry = value;
        const hit = pair(entry['hit']);
        const miss = pair(entry['miss']);
        const out = pair(entry['out']);
        if (hit === undefined || miss === undefined || out === undefined) {
            problems.push(`${rawKey}：hit / miss / out 必须都是两个非负数字（[谷时, 峰时]）`);
            continue;
        }
        rules.push([key, { hit, miss, out }]);
    }
    return { rules, problems };
}
/**
 * 判断某一时刻是否处于高峰时段。
 *
 * 官方口径：高峰 = 北京时间**周一至周五（不含中国法定节假日）**的 9:00–12:00、
 * 14:00–18:00；其余时段（含周末与中国法定节假日全天）为空闲时段。
 * 因此判定顺序是：先看是否落在峰时小时区间内，再排除周末与节假日。
 * @param ms - epoch 毫秒（事件时间戳）。
 * @returns 峰时为 true；非有限值一律 false（按空闲时段价）。
 */
export function isPeak(ms) {
    if (!Number.isFinite(ms))
        return false;
    const sec = Math.floor(ms / 1000);
    // 按 UTC 读法读北京日历：偏移 8 小时后 getUTC* 即北京时间字段。
    const beijing = new Date(sec * 1000 + 8 * 3600 * 1000);
    const hour = beijing.getUTCHours();
    let inPeakHours = false;
    for (const [start, end] of PEAK_HOURS) {
        if (hour >= start && hour < end) {
            inPeakHours = true;
            break;
        }
    }
    if (!inPeakHours)
        return false;
    // 法定节假日全天空闲（表只覆盖 2026 年，见 HOLIDAYS）。
    const dayKey = beijing.toISOString().slice(0, 10);
    if (HOLIDAYS.has(dayKey))
        return false;
    const day = beijing.getUTCDay();
    const weekend = day === 0 || day === 6;
    // 2026-08-23 之前的历史按当时的规则（周末照常分峰谷）计价，避免用新规则改写旧账。
    if (weekend && sec >= WEEKEND_VALLEY_FROM_SEC) {
        return MAKEUP_WORKDAYS_ARE_PEAK && MAKEUP_WORKDAYS.has(dayKey);
    }
    return true;
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
export function costOf(usage, model, ms) {
    const price = priceFor(model);
    const tier = isPeak(ms) ? 1 : 0;
    const billedInput = usage.inputTokens + usage.cacheWriteTokens;
    return ((usage.cacheReadTokens * price.hit[tier] +
        billedInput * price.miss[tier] +
        usage.outputTokens * price.out[tier]) /
        1e6);
}
//# sourceMappingURL=pricing.js.map