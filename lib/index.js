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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfill, scanSession } from './backfill.js';
import { DETAIL_KEEP_DAYS, applyEvent, countDaysMissingDetail, cursorOf, dayKey, emptyDay, emptyUsage, pruneDetail, resetState, } from './fold.js';
import { LedgerStore, loadLedger } from './ledger.js';
import { isPricedModel, parsePriceOverrides, priceOverrideCount, setPriceOverrides } from './pricing.js';
/** Cordis 插件名。 */
export const name = '@dsh-external/dsh-usage-stats';
/**
 * `webServer` 是硬依赖（面板本身就需要 Web）；`sessionPersistence` 不在此列，
 * 缺失时降级为「仅统计本次启动后的数据」而不是让插件挂起。
 */
export const inject = ['webServer'];
/** 面板与面板 API 共用的路由前缀。 */
const API_PREFIX = '/dsh-usage-stats/api';
/** 账本文件名（放在 DSH_HOME 下，node_modules 可能只读或被清理）。 */
const LEDGER_FILE = '.dsh-usage-stats.json';
/**
 * 单价覆盖文件名（与账本同目录）。
 *
 * 官方名之外的中转别名、或与官方不同价的渠道，写这个文件即可，不必改代码重编译。
 * 形状见 {@link parsePriceOverrides}。
 */
const PRICE_FILE = '.dsh-usage-stats.prices.json';
/** 缺口补齐期间允许缓存的实时事件条数上限（防御异常会话把内存吃光）。 */
const REPAIR_QUEUE_LIMIT = 20_000;
/** 近 N 天趋势的默认窗口。 */
const DEFAULT_DAYS = 14;
/** 工具排行默认条数。 */
const DEFAULT_TOP = 12;
/** 取请求头（大小写不敏感；数组取首值）。 */
function headerOf(headers, name) {
    if (headers === undefined)
        return undefined;
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== name)
            continue;
        if (typeof value === 'string')
            return value;
        if (Array.isArray(value))
            return value[0];
        return undefined;
    }
    return undefined;
}
/** Host 头是否指向本机（回环地址 / localhost / IPv6 回环）。 */
function isLoopbackAuthority(host) {
    let url;
    try {
        url = new URL(`http://${host}`);
    }
    catch {
        return false;
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1')
        return true;
    // 整个 127/8 都是回环；DSH 也把部署推导出的局域网 IP 视为可信，这里不猜，交给官方层。
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}
/**
 * 插件路由的准入判断：优先复用官方鉴权，缺失时降级为本地 Host/Origin 围栏。
 *
 * 为什么需要它：`webServer.register` 注册的路由**绕过**了官方 `/api` 通道的
 * 准入（Host 围栏防 DNS rebinding、Origin/`sec-fetch-site` 防跨站、签名 cookie
 * 防未登录）。插件自己注册路由就必须自己补上这一层，否则任意 loopback 页面都能
 * 用 `no-cors` 简单请求触发清空账本这类副作用。
 * @param connection - `ctx.connection`（缺失时为 undefined）。
 * @param req - 原始请求。
 * @returns 拒绝状态码；允许通行时为 undefined。
 */
function routeRejection(connection, req) {
    const headers = req.headers ?? {};
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
        try {
            return connection.requestRejection({ headers });
        }
        catch {
            // 官方层异常时退回本地围栏，绝不放行。
        }
    }
    const host = headerOf(headers, 'host');
    // 无 Host（HTTP/1.0 或畸形请求）一律拒绝：Host 是 rebinding 唯一伪造不了的字段。
    if (host === undefined || !isLoopbackAuthority(host))
        return 403;
    if (headerOf(headers, 'sec-fetch-site') === 'cross-site')
        return 403;
    const origin = headerOf(headers, 'origin');
    if (origin === undefined)
        return undefined;
    try {
        return new URL(origin).host === new URL(`http://${host}`).host ? undefined : 403;
    }
    catch {
        return 403;
    }
}
/** 写 JSON 响应。 */
function sendJson(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
}
/** 取整数查询参数。 */
function intParam(url, key, fallback, min, max) {
    const raw = url.searchParams.get(key);
    if (raw === null)
        return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, value));
}
/**
 * 生成趋势序列，按时间升序。
 * @param state - 账本。
 * @param range - 天数；`'all'` 表示账本里**实际有数据**的全部日历日（不补零）。
 * @param now - 当前时刻（epoch 毫秒）。
 * @returns 面板柱状图使用的日序列。
 */
function trendDays(state, range, now) {
    if (range === 'all') {
        return Object.keys(state.days)
            .sort()
            .map((key) => ({ date: key, ...state.days[key] }));
    }
    const out = [];
    for (let offset = range - 1; offset >= 0; offset -= 1) {
        const key = dayKey(now - offset * 86_400_000);
        const day = state.days[key];
        out.push(day === undefined ? { date: key, ...emptyDay() } : { date: key, ...day });
    }
    return out;
}
/**
 * 读取并校验 `YYYY-MM-DD` 查询参数。
 * @param url - 请求 URL。
 * @param key - 参数名。
 * @returns 合法日期串；缺失或格式错误时为 undefined。
 */
function dateParam(url, key) {
    const raw = url.searchParams.get(key);
    if (raw === null || !/^\d{4}-\d{2}-\d{2}$/.test(raw))
        return undefined;
    return raw;
}
/** 明细端点里工具 / 会话列表的条数上限。 */
const DETAIL_TOP = 20;
/**
 * 生成某日期区间的按天明细（交互式饼图与「选中某日」联动的数据源）。
 *
 * 只返回**实际有数据**的日期；工具与会话各取 Top {@link DETAIL_TOP}
 * （按次数 / 按费用），模型通常只有个位数因此全量返回。
 * @param state - 账本。
 * @param from - 起始日历日（含），`YYYY-MM-DD`。
 * @param to - 结束日历日（含）。
 * @param dshHome - DSH 主目录（用于读会话标题）。
 * @returns 明细视图。
 */
function detailView(state, from, to, dshHome) {
    const dates = new Set();
    for (const table of [state.dayModels, state.dayTools, state.daySessions]) {
        for (const key of Object.keys(table))
            if (key >= from && key <= to)
                dates.add(key);
    }
    const days = [...dates].sort().map((date) => {
        const models = Object.entries(state.dayModels[date] ?? {})
            .map(([model, stat]) => ({ model, ...stat }))
            .sort((left, right) => right.costCny - left.costCny);
        const tools = Object.entries(state.dayTools[date] ?? {})
            .map(([name, stat]) => ({ name, calls: stat.calls, ms: Math.round(stat.ms) }))
            .sort((left, right) => right.calls - left.calls || right.ms - left.ms)
            .slice(0, DETAIL_TOP);
        const sessions = Object.entries(state.daySessions[date] ?? {})
            .map(([id, usage]) => ({
            id,
            title: readSessionTitle(dshHome, id) ?? null,
            origin: state.sessions[id]?.origin ?? 'root',
            usage,
        }))
            .sort((left, right) => right.usage.costCny - left.usage.costCny)
            .slice(0, DETAIL_TOP);
        return { date, models, tools, sessions };
    });
    return { ok: true, from, to, days };
}
/** 会话标题缓存：避免每次轮询都读盘。 */
const titleCache = new Map();
/**
 * 读取会话标题（用于把「哪个对话最贵」说成人话）。
 *
 * 标题由官方 `session-projection-cache` 落盘在
 * `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val`。
 * 这是对官方缓存布局的**只读、防御性**依赖：读不到就返回 undefined，面板退回显示
 * cwd + 短 id，绝不影响统计本身。
 * @param dshHome - DSH 主目录。
 * @param sessionId - 会话 id。
 * @returns 标题；无标题或读取失败时为 undefined。
 */
function readSessionTitle(dshHome, sessionId) {
    const cached = titleCache.get(sessionId);
    if (cached !== undefined)
        return cached ?? undefined;
    let title = null;
    try {
        const file = path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const value = parsed.record?.rows?.title?.val;
        if (typeof value === 'string' && value !== '')
            title = value;
    }
    catch {
        title = null;
    }
    titleCache.set(sessionId, title);
    if (titleCache.size > 500) {
        const oldest = titleCache.keys().next();
        if (oldest.done !== true)
            titleCache.delete(oldest.value);
    }
    return title ?? undefined;
}
/** 组装面板所需的完整视图。 */
function summaryView(state, options) {
    const totalCalls = state.totals.toolCalls;
    const detailMissingDays = countDaysMissingDetail(state);
    // 费用口径的自证：价表未收录的模型当前按基价兜底，金额不可信，必须让用户看见。
    const unpricedModels = Object.keys(state.models)
        .filter((model) => !isPricedModel(model))
        .sort();
    const ranked = Object.entries(state.tools)
        .map(([toolName, stat]) => ({ name: toolName, calls: stat.calls, ms: Math.round(stat.ms) }))
        .sort((left, right) => right.calls - left.calls || right.ms - left.ms);
    const tools = ranked.slice(0, options.top).map((entry) => ({
        ...entry,
        share: totalCalls > 0 ? entry.calls / totalCalls : 0,
    }));
    const models = Object.entries(state.models)
        .map(([model, stat]) => ({ model, ...stat }))
        .sort((left, right) => right.costCny - left.costCny || right.calls - left.calls);
    // 「最贵的对话」：按估算费用降序，回答「钱花在哪个对话上」。
    const sessions = Object.entries(state.sessions)
        .map(([id, cursor]) => ({
        id,
        cwd: cursor.cwd ?? '',
        createdAt: cursor.createdAt ?? 0,
        origin: cursor.origin ?? 'root',
        modelCalls: cursor.modelCalls ?? 0,
        toolCalls: cursor.toolCalls ?? 0,
        usage: cursor.usage ?? emptyUsage(),
    }))
        .filter((row) => row.usage.costCny > 0 || row.modelCalls > 0)
        .sort((left, right) => right.usage.costCny - left.usage.costCny)
        .slice(0, options.top)
        .map((row) => ({ ...row, title: readSessionTitle(options.dshHome, row.id) ?? null }));
    return {
        ok: true,
        generatedAt: options.now,
        totals: state.totals,
        tools,
        models,
        sessions,
        toolKinds: ranked.length,
        days: trendDays(state, options.range, options.now),
        backfill: state.backfill,
        meta: {
            persistenceAvailable: options.persistenceAvailable,
            ledgerFile: options.ledgerFile,
            writeError: options.writeError ?? null,
            updatedAt: state.updatedAt,
            sessionCount: Object.keys(state.sessions).length,
            // 按天明细是后加的字段：老账本里没有，需要提示用户点一次「重建统计」。
            // 用逐日比对而非「明细表是否为空」，否则升级当天的实时明细会掩盖历史缺失。
            detailMissingDays,
            detailMissing: state.totals.sessions > 0 && detailMissingDays > 0,
            // 费用可信度：未收录模型按基价兜底，面板据此提示「金额仅供参考」。
            unpricedModels,
            priceFile: options.priceFile,
            priceOverrides: options.priceOverrides,
            priceFileError: options.priceFileError ?? null,
        },
    };
}
/**
 * 挂载插件：账本 + 实时链路 + 回填调度 + HTTP API。
 * @param ctx - cordis 上下文。
 */
export function apply(ctx) {
    const dshHome = process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh');
    const ledgerFile = path.join(dshHome, LEDGER_FILE);
    const loaded = loadLedger(ledgerFile);
    const store = new LedgerStore(ledgerFile, loaded.state);
    const pending = new Map();
    const log = (message) => {
        try {
            ctx.logger?.info?.(`[usage-stats] ${message}`);
        }
        catch {
            // 日志失败不影响统计。
        }
    };
    const warn = (message) => {
        try {
            ctx.logger?.warn?.(`[usage-stats] ${message}`);
        }
        catch {
            // 同上。
        }
    };
    if (loaded.notice !== undefined)
        warn(loaded.notice);
    if (!loaded.loaded)
        store.touch();
    // ---- 单价覆盖 ---------------------------------------------------------
    // 与官方不同价的渠道（中转站）不改代码就能接上：读 %DSH_HOME%/.dsh-usage-stats.prices.json。
    const priceFile = path.join(dshHome, PRICE_FILE);
    let priceFileError;
    try {
        if (fs.existsSync(priceFile)) {
            const parsed = parsePriceOverrides(JSON.parse(fs.readFileSync(priceFile, 'utf8')));
            setPriceOverrides(parsed.rules);
            if (parsed.problems.length > 0)
                priceFileError = parsed.problems.join('；');
            log(`已加载单价覆盖：${parsed.rules.length} 条规则${parsed.problems.length > 0 ? `（跳过 ${parsed.problems.length} 条）` : ''}`);
        }
        else {
            setPriceOverrides([]);
        }
    }
    catch (error) {
        priceFileError = String(error);
        setPriceOverrides([]);
        warn(`单价覆盖文件解析失败，改用内置价表：${String(error)}`);
    }
    const persistence = ctx.get('sessionPersistence');
    const connection = ctx.get('connection');
    const deps = { persistence, state: store.state, pending, onProgress: () => store.touch(), log: warn };
    // ---- 实时链路 ---------------------------------------------------------
    /**
     * 正在补齐缺口的会话 → 补齐期间到达的实时事件（按序缓存，补齐结束后重放）。
     *
     * 为什么必须「先补齐、后折叠」：`applyEvent` 会把游标推过缺口。旧实现先折叠
     * 再 `catchUp()`，补齐路径从**已经推过的游标**开始读，缺口永远读不回来
     * （实测：同一份日志全量回填得 62 次工具调用，中途接入只得 8 次）。
     * 因此缺口会话上不再直接折叠实时事件，而是全部入队；补齐（从原游标续读到
     * 末尾）结束后按序重放这些事件，`seq < consumedSeq` 的去重保证恰好计一次。
     */
    const repairing = new Map();
    /** 在飞的补齐任务（rebuild 前必须等它们收尾，否则会与清空后的重放互相污染）。 */
    const repairs = new Set();
    const startRepair = (sessionId) => {
        if (persistence === undefined || repairing.has(sessionId))
            return;
        repairing.set(sessionId, []);
        const task = scanSession(deps, sessionId)
            .then((folded) => {
            if (folded > 0)
                store.touch();
        })
            .catch((error) => warn(`补齐会话 ${sessionId} 失败：${String(error)}`))
            .finally(() => {
            const queued = repairing.get(sessionId) ?? [];
            repairing.delete(sessionId);
            let changed = false;
            for (const event of queued)
                if (applyEvent(store.state, sessionId, event, pending))
                    changed = true;
            if (changed)
                store.touch();
        });
        repairs.add(task);
        void task.finally(() => repairs.delete(task));
    };
    ctx.effect(() => ctx.on('session/event', (...args) => {
        const session = args[0];
        const event = args[1];
        const sessionId = session?.id;
        if (typeof sessionId !== 'string' || sessionId === '')
            return;
        if (event === undefined || typeof event.type !== 'string')
            return;
        const foldable = event;
        // 补齐进行中：只入队，等续读结束后按序重放（绝不先推进游标）。
        const queue = repairing.get(sessionId);
        if (queue !== undefined) {
            if (queue.length < REPAIR_QUEUE_LIMIT)
                queue.push(foldable);
            else
                warn(`会话 ${sessionId} 补齐期间事件过多，已丢弃超出 ${REPAIR_QUEUE_LIMIT} 条的部分`);
            return;
        }
        // 缺口判断必须在折叠之前：正常情况事件的 seq 恰好等于游标。
        const seq = typeof event.seq === 'number' ? event.seq : -1;
        const gapAhead = seq >= 0 && seq > cursorOf(store.state, sessionId).consumedSeq;
        // 注入发生在会话中途时，游标与实时事件之间存在缺口 —— 先补它，本次事件一并入队。
        if (gapAhead && persistence !== undefined) {
            startRepair(sessionId);
            repairing.get(sessionId)?.push(foldable);
            return;
        }
        const changed = applyEvent(store.state, sessionId, foldable, pending);
        if (changed)
            store.touch();
    }), 'usage-stats: live session events');
    ctx.effect(() => ctx.on('session/disposed', (...args) => {
        const session = args[0];
        const sessionId = session?.id;
        if (typeof sessionId === 'string' && sessionId !== '')
            pending.delete(sessionId);
    }), 'usage-stats: session cleanup');
    // ---- 回填调度 ---------------------------------------------------------
    /** 正在进行的扫描；同一时刻只允许一个。 */
    let scanning;
    /**
     * 排队一次后台扫描。
     *
     * 串行化是硬要求：`rebuild` 必须「先等旧扫描收尾 → 清空账本 → 重新全量」，
     * 否则旧扫描会在清空之后继续写它的进度与计数，把新账本搅成半截状态
     * （实测过：rebuild 被进行中的启动扫描吞掉，只剩 5 个会话）。
     * @param options - `onlyMissing` 只扫账本里没有的会话；`rebuild` 清空后从头重放。
     * @returns 本次扫描的 Promise 与「前面是否还有扫描在跑」。
     */
    const requestScan = (options) => {
        const previous = scanning;
        const queued = previous !== undefined;
        let promise;
        promise = (async () => {
            if (previous !== undefined)
                await previous.catch(() => undefined);
            if (options.rebuild) {
                // 在飞的缺口补齐同样在写账本：先等它们收尾再清空，否则两边互相污染。
                if (repairs.size > 0)
                    await Promise.allSettled([...repairs]);
                resetState(store.state);
                pending.clear();
                store.touch();
            }
            return backfill(deps, { onlyMissing: options.onlyMissing });
        })()
            .then((result) => {
            store.flush();
            const outcome = result;
            log(`回填完成：扫描 ${outcome.scanned}/${outcome.total} 个会话，折叠 ${outcome.events} 条事件，失败 ${outcome.errors} 个`);
            return result;
        })
            .catch((error) => {
            store.state.backfill.running = false;
            warn(`回填失败：${String(error)}`);
            return undefined;
        })
            .finally(() => {
            if (scanning === promise)
                scanning = undefined;
        });
        scanning = promise;
        return { promise, queued };
    };
    // 首次运行全量回填；此后只补账本里没有的新会话（增量、秒级完成）。
    //
    // 判据只看 `done`：早先还带了 `scanned === 0`，而**增量扫描扫到 0 个新会话时会把
    // scanned 写成 0**，于是每次重载都被误判成「首次运行」，把全部会话重读一遍
    // （游标续读，数字不会错，但会话多时纯属白读盘）。`done` 为 false 时（全新账本、
    // 账本损坏重建、persistence 曾经不可用）才走全量；此时 `onlyMissing` 也覆盖一切。
    const first = loaded.state.backfill.done !== true;
    setTimeout(() => {
        void requestScan({ onlyMissing: !first, rebuild: false }).promise;
    }, 0).unref?.();
    // ---- 按天明细裁剪 -----------------------------------------------------
    // 明细随天增长；定期丢弃超过 DETAIL_KEEP_DAYS 的部分（天汇总 days 永久保留）。
    ctx.effect(() => {
        const timer = setInterval(() => {
            const removed = pruneDetail(store.state, Date.now());
            if (removed > 0) {
                store.touch();
                log(`已裁剪 ${removed} 个过期按天明细条目（保留最近 ${DETAIL_KEEP_DAYS} 天）`);
            }
        }, 10 * 60_000);
        timer.unref?.();
        return () => clearInterval(timer);
    }, 'usage-stats: prune daily details');
    // ---- HTTP API ---------------------------------------------------------
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
            void (async () => {
                try {
                    // 先过准入：插件路由绕过了官方 /api 通道，必须自己补上 Host/Origin
                    // 围栏与浏览器鉴权，否则任意 loopback 页面都能 no-cors 触发 /rescan。
                    const rejection = routeRejection(connection, req);
                    if (rejection !== undefined) {
                        sendJson(res, rejection, { ok: false, error: rejection === 401 ? '未通过浏览器鉴权' : '请求来源不被信任' });
                        return;
                    }
                    const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1');
                    const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;
                    if (route === '' || route === '/' || route === '/summary') {
                        // range=all 表示全部时间；否则按天数（上限放宽到 400，覆盖 90 天档与更长窗口）。
                        const range = url.searchParams.get('range') === 'all' ? 'all' : intParam(url, 'days', DEFAULT_DAYS, 1, 400);
                        const top = intParam(url, 'top', DEFAULT_TOP, 1, 200);
                        sendJson(res, 200, summaryView(store.state, {
                            range,
                            top,
                            now: Date.now(),
                            dshHome,
                            persistenceAvailable: persistence !== undefined,
                            ledgerFile,
                            writeError: store.lastError,
                            priceFile,
                            priceOverrides: priceOverrideCount(),
                            priceFileError,
                        }));
                        return;
                    }
                    if (route === '/days') {
                        // 明细按需拉取（不进主轮询）：交互流畅，又不让 3 秒轮询背上几十 KB。
                        const now = Date.now();
                        const to = dateParam(url, 'to') ?? dayKey(now);
                        const from = dateParam(url, 'from') ?? dayKey(now - 13 * 86_400_000);
                        sendJson(res, 200, detailView(store.state, from, to, dshHome));
                        return;
                    }
                    if (route === '/rescan') {
                        if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
                            sendJson(res, 405, { ok: false, error: 'rescan 需要 POST' });
                            return;
                        }
                        // rebuild=1：清空账本从零重放。改口径或新增统计维度后必须重建，
                        // 因为游标只前进不回头，增量扫描不会为历史补算新维度。
                        const rebuild = url.searchParams.get('rebuild') === '1';
                        const scheduled = requestScan({ onlyMissing: false, rebuild });
                        void scheduled.promise;
                        sendJson(res, 200, {
                            ok: true,
                            started: true,
                            rebuild,
                            queued: scheduled.queued,
                            sessionCount: Object.keys(store.state.sessions).length,
                        });
                        return;
                    }
                    sendJson(res, 404, { ok: false, error: `未知路由 ${route}` });
                }
                catch (error) {
                    sendJson(res, 500, { ok: false, error: String(error) });
                }
            })();
        },
    }), 'usage-stats: api routes');
    // ---- 卸载即净 ---------------------------------------------------------
    ctx.effect(() => () => {
        store.flush();
        store.dispose();
        pending.clear();
        repairing.clear();
        titleCache.clear();
    }, 'usage-stats: flush ledger on dispose');
    log(`已加载（账本：${ledgerFile}，历史回填：${first ? '全量' : '增量'}，持久化服务：` +
        `${persistence === undefined ? '不可用' : '可用'}，路由鉴权：${connection === undefined ? '本地围栏（未找到 connection 服务）' : '官方 connection'}，` +
        `单价覆盖：${priceOverrideCount()} 条）`);
}
//# sourceMappingURL=index.js.map