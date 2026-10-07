/**
 * @dsh-external/dsh-usage-stats —— 设置页「用量统计」面板（client 侧）。
 *
 * 构建：`npm run build:client`（tsdown → lib/client.js，ModuleLoader.load 注册）。
 *
 * 契约（照抄本机正在运行、已验证的 super-injector 设置页写法）：
 * - `export const inject = ['slots']`，否则 `ctx.slots` 未定义；
 * - `ctx.slots.register(options, component)` 的 component 是**第二个参数**，
 *   并且 register 要包在 `ctx.slots.inject(slotName, …)` 里；
 * - options 必须带 `name`（= slot 名），缺了会报 "slot undefined is not declared"。
 *
 * 数据流（两档，互不干扰）：
 * - **主轮询**（3 秒）拉 `/summary`：卡片、三张表、柱状图。选中日期后卡片与表格
 *   切到该日数据（来自明细），未选中时显示全局累计。
 * - **明细**（`/days`，按需 + 60 秒节流）：环形饼图与「选中某日」的数据源。
 *   交互本身（切维度、点图例、点柱子）不发请求，全部本地重绘。
 *
 * 交互状态（范围 / 选中日期 / 饼图维度 / 图例开关）都存在本闭包里，
 * 因此 3 秒轮询重绘不会把它们重置掉。
 *
 * @module @dsh-external/dsh-usage-stats/client
 */
/**
 * client 侧服务注入声明。
 *
 * 缺了它本模块的 fiber 不注入任何服务，`ctx.slots` 为 undefined，
 * `apply()` 里 `ctx.slots.inject(...)` 会抛 TypeError，前端整页报
 * `web boot: 1 entry did not activate / @dsh-external/dsh-usage-stats: failed`。
 */
export declare const inject: string[];
/**
 * 注册设置页分区。
 * @param ctx - client 上下文（含 slots 服务）。
 */
export declare function apply(ctx: {
    slots: {
        inject(name: string, callback: () => unknown): () => void;
        register(options: Record<string, unknown>, component: unknown): () => void;
    };
    effect(callback: () => unknown, label?: string): () => void;
}): void;
