/**
 * @dsh-external/dsh-usage-stats —— DSH 用量与工具调用统计（host 侧）。
 *
 * 职责：
 * 1. 账本：`%DSH_HOME%/.dsh-usage-stats.json`，跨重启累计；
 * 2. 实时：监听 `session/event`，把 tool/call、tool/result、assistant/message、
 *    step/end 折叠进账本（游标去重；seq 跳跃时**先补齐缺口、再折叠**，注入发生在
 *    会话中途也不会丢前半段）；
 * 3. 回填：首次启用时用官方 `sessionPersistence` 分页读取全部历史会话；
 * 4. 供数：`/dsh-usage-stats/api/summary` 与 `/rescan`，由设置页面板消费。
 *    路由复用官方 `ctx.connection.requestRejection`（Host/Origin 围栏 + 浏览器
 *    签名 cookie），因此不是「任何 loopback 页面都能 POST 一把」的裸路由。
 * 5. 单价：内置价表在 `./pricing.js`；要接中转站的不同单价，写
 *    `%DSH_HOME%/.dsh-usage-stats.prices.json` 覆盖（无需改代码/重编译）。
 *
 * 运行时只依赖 node 内置模块 —— DSH 服务一律经 `ctx` 取用，不 import 任何
 * `@deepseek-ai/*` 值（类型导入会被编译期擦除），因此插件在任何 profile 下
 * 都不会因缺依赖而挂起；`connection` 缺失时鉴权降级为本地 Host/Origin 围栏。
 *
 * @module @dsh-external/dsh-usage-stats
 */
/** Cordis 插件名。 */
export declare const name = "@dsh-external/dsh-usage-stats";
/**
 * `webServer` 是硬依赖（面板本身就需要 Web）；`sessionPersistence` 不在此列，
 * 缺失时降级为「仅统计本次启动后的数据」而不是让插件挂起。
 */
export declare const inject: string[];
/** host 上下文的最小视图（不 import cordis 类型，保持零值依赖）。 */
interface HostContext {
    get(name: string): unknown;
    on(event: string, listener: (...args: unknown[]) => void): () => void;
    effect(callback: () => unknown, label?: string): () => void;
    webServer: {
        register(options: {
            kind: 'prefix' | 'exact';
            path: string;
            handler: (req: HttpRequest, res: HttpResponse) => unknown;
        }): () => void;
    };
    logger?: {
        info?: (message: string) => void;
        warn?: (message: string) => void;
    } | undefined;
}
/** 最小 HTTP 请求视图。 */
interface HttpRequest {
    url?: string;
    method?: string;
    /** 原始请求头。鉴权（Host/Origin 围栏 + 签名 cookie）需要它。 */
    headers?: Record<string, string | readonly string[] | undefined>;
}
/** 最小 HTTP 响应视图。 */
interface HttpResponse {
    writeHead(status: number, headers: Record<string, string>): void;
    end(body?: string): void;
}
/**
 * 挂载插件：账本 + 实时链路 + 回填调度 + HTTP API。
 * @param ctx - cordis 上下文。
 */
export declare function apply(ctx: HostContext): void;
export {};
