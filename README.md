# @dsh-external/dsh-usage-stats

DeepSeek Harness 的**用量与工具调用统计**插件：在 Web 设置页新增「用量统计」分区，展示
累计 token 用量（四桶）、估算费用（¥）、会话 / 轮次 / 步数、**按工具名的调用次数与耗时排行榜**、
按模型分布、以及近 14 天的按天趋势。

首次启用时**回填全部历史会话**，之后实时增量累计，跨重启不丢。

## 安装

**仓库里直接带 `lib/` 构建产物** —— clone 下来即可注入，不需要 DSH 源码检出、npm 安装或任何构建步骤：

```bash
git clone https://github.com/XIA-2005/dsh-usage-stats.git
# 注入器环境（运行时注入、免重启、卸载即净）：
#   dev_inject_plugin <本目录>
# 或走官方装配：
#   plugin_manager install_bundle <本目录>
```

只有改了 `src/` 才需要重新构建；**改完请把 `lib/` 一起提交**，否则别人拉到的是旧代码：

```bash
npm install --ignore-scripts   # 只装 typescript / @types/node / tsdown（DSH 包是 optional peer，不会去 registry 拉）
npm run build                  # host: tsc → lib/；client: tsdown → lib/client.js
```

有 DSH 源码检出时也可以复用它的工具链：`export DSH_CHECKOUT=/path/to/deepseek-harness && npm run build`。

## 功能

| 区块 | 内容 |
| --- | --- |
| 总览卡片 | 总 tokens、估算费用 ¥、会话 / 轮次（另附步数）、工具调用总次数（另附工具种类数） |
| token 构成 | 未缓存输入 / 缓存读取 / 缓存写入 / 输出 四桶的绝对值、占比与条形图 |
| 工具调用排行 | Top N（默认 12）：调用次数、占比条、按 `tool/call → tool/result` 配对的累计耗时 |
| 按模型 | 每个模型的调用次数、缓存读、输出、费用 —— 也是费用口径的自证（单价见下方官方价格表） |
| 最贵的对话 | 按估算费用降序的会话排行（标题 / 创建日 / tokens / 费用），直接回答「钱花在哪个对话上」 |
| **用量趋势（可交互）** | 7 / 14 / 30 / 90 天 / 全部 窗口切换；柱子 hover 出浮层，**点击选中某天**（再点取消） |
| **构成分析（交互饼图）** | 环形图 4 个维度：token 构成 / 按模型 / 按工具 / 按对话；hover 扇区外移高亮 + 环心显示占比，点图例可隐藏某项 |
| 操作 | 刷新、增量扫描、重建统计（清空账本从头重放） |

**点柱子选中某天 → 全板块联动**：总览卡片、token 构成、三张表、饼图全部切到那一天，顶部出现「已选
2026-08-15 ✕」可一键取消；柱状图该柱高亮。选中态、窗口、饼图维度、图例开关都会在 3 秒轮询刷新后保持。

## 交互式图表

- **窗口**：7 / 14 / 30 / 90 天 / 全部（`全部` = 账本里所有有数据的日期，卡片与表格也随之切换口径）。
- **环形图**：hover 时被指扇区沿角平分线外移、其余降到 35% 透明度，环心显示「名称 / 占比 · 数值」；
  点击图例项隐藏/显示该扇区（隐藏状态按维度分别记忆）。
- **四个维度的取值口径**：token 构成 = 四桶互斥计数；按模型 = 该视角下各模型的**估算费用**；
  按工具 = **调用次数**（取前 8，其余并入「其他」）；按对话 = **费用**（取前 6，其余并入「其他」）。
- **实现**：纯 DOM + 手写 SVG（`src/client/chart.ts`），**不引入任何图表库** —— client bundle 由 tsdown
  打进 `lib/client.js`，第三方图表库会让体积成倍增长，而这里只需要一根柱子和一段圆弧。

## 数据来源与统计口径

- **实时**：监听 `session/event`，折叠以下事件
  - `tool/call` → 按 `name` 计次；`callId` 记入挂起表
  - `tool/result` → 与挂起配对，耗时累加到该工具名下
  - `assistant/message` → `usage` 四桶累加 + 按 `message.source.model` 计价
  - `step/end` → 步数；`turn` 变化计一轮
- **历史**：经官方 `ctx.sessionPersistence` 服务（`list` → `open(id,'read')` → 分页 `read`）逐会话续读。
  会话日志是 `session.jsonl.zstd`，物理上为**多个 zstd frame 串联**（header frame + 每批事件 frame），
  Node 的 `createZstdDecompress` 解到第二帧即报 `ZSTD_error_prefix_unknown` —— 因此必须走官方解码器，
  插件不做任何自解析。
- **token 四桶互斥**：`inputTokens`（未缓存输入）、`cacheReadTokens`、`cacheWriteTokens` 三者相加才是
  计费输入；`reasoningTokens` 已包含在 `outputTokens` 内，**不重复计入**。
- **费用为估算**：`cacheRead × 命中价 + (未缓存输入 + 缓存写入) × 未命中价 + 输出 × 输出价`，
  峰谷按**事件自身时间戳**判定，因此历史回填也能还原当时的时段价。
- **单价按官方价格页逐行抄写**（[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，2026-10 核对），
  单位 CNY / 百万 token，每行是 `[空闲时段, 高峰时段]`：

  | 模型 | 缓存命中 | 缓存未命中 | 输出 |
  | --- | --- | --- | --- |
  | `deepseek-flash`（V4.1-Flash） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
  | `deepseek-v4-pro`（V4-Pro-0813） | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

  **不要按倍数推算**：Pro 相对 Flash 的倍率并不统一（命中 7.5×、未命中 4.5×、输出 3.375×），
  历史版本正是把 Flash 缓存命中记成 0.05（应为 0.02）导致系统性高估，同时"Pro = 基价 ×3"又碰巧凑对。
  `scripts/test-pricing.mjs` 把这两张表钉死，改价时它会逐行报错。
- **峰谷时段**：高峰 = 北京时间**周一至周五（不含中国法定节假日）**9:00–12:00、14:00–18:00；
  其余时段（含周末与法定节假日全天）为空闲，空闲价为高峰价的一半。
  插件内置 **2026 年法定节假日表**（国办发明电〔2025〕7号），因此像 10 月 5 日（国庆假期中的周一）
  这类日期按空闲计价，而不是按普通工作日。表**只覆盖 2026 年**，跨年需要补新表。
  2026-08-23 之前的周末按当时规则（照常分峰谷）计价，不用新规则改写旧账。
- **模型名按子串匹配**：官方名 `deepseek-flash` / `deepseek-v4-pro`、官方说明按 Flash 计费的旧名
  `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`、中转短名 `deepseek-pro`，带渠道前缀
  （如 `apigoto/deepseek-flash`）同样命中。
- **官方页已下架的历史模型名（`deepseek-chat` / `deepseek-reasoner` / `deepseek-v3` / `deepseek-r1`）故意不收录**：
  现价无从核对，宁可报「未收录价表」也不给一个看起来正常的假数字；需要的话用下面的覆盖文件自己补。
- **没被价表收录的模型不再静默按兜底价**：`/summary` 的 `meta.unpricedModels` 会列出它们，
  面板顶部直接提示「费用仅供参考」，避免把兜底价（Flash 档）当成真实价格。
- **要接自己的单价**（中转站与官方不同价）：写一份 `%DSH_HOME%/.dsh-usage-stats.prices.json`，
  覆盖规则优先于内置规则，**不改代码、不重编译**，写好后点一次「重建统计」按新价重算历史：

  ```jsonc
  {
    // 键 = 模型名子串（小写匹配），值 = [空闲时段价, 高峰时段价] 三档单价（CNY / 百万 token）
    "deepseek-flash": { "hit": [0.02, 0.04], "miss": [1, 2], "out": [4, 8] },
    "apigoto/deepseek-pro": { "hit": [0.15, 0.3], "miss": [4.5, 9], "out": [13.5, 27] }
  }
  ```

  形状不合法或解析失败**不会阻断插件**：坏条目被跳过、原因进 `meta.priceFileError`，面板照常统计。
  内置价表在 `src/pricing.ts` 的 `BUILTIN_RULES`，调价改那里（然后点「重建统计」）。

- **按天明细**（天 × 模型 / 天 × 工具 / 天 × 会话）在折叠时一并写入，是交互式饼图与「选中某天」的数据源；
  只保留最近 120 天（`DETAIL_KEEP_DAYS`），更早的只留天汇总 `days`。
- **子代理会话**计入总量（它们真实消耗 token）。
- **去重**：每个会话维护 `consumedSeq` 游标，实时链路与回填路径在折叠前统一做 `seq < consumedSeq` 跳过，
  因此两条路径重叠工作也只计一次。
- **中途启用不丢前半段**：注入发生在会话中途时，实时事件的 `seq` 会跳跃（跳过的部分是插件加载前
  已经写进日志的事件）。此时**先补齐、后折叠**：缺口会话上不再直接折叠实时事件，而是把它们按序
  缓存，从原游标续读到末尾补齐后再重放（游标去重保证恰好一次）。
  反过来做（先折叠、再补齐）会把游标推过缺口，补齐路径从新游标开始读，缺口永远补不回来 ——
  `scripts/test-gap-fill.mjs` 用同一份合成日志对比两种顺序：全量回填与「先补后折」都是
  `{62 次工具调用, 4 轮, 60 步}`，而「先折后补」只剩 `{4, 0, 0}`。

## 实测样例：为什么要按对话看（本机）

上线「最贵的对话」后立刻定位到一个反直觉现象：`deepseek-v4-pro` 共 1811 次调用，其中 **1514 次来自同一个
对话** ——「预推免系统自动填报工具构思」（2026-08-15，645M tokens、2178 次工具调用，约 **¥196**），
即 **82% 的费用来自一个 8 月的长会话**，而不是"到处都在用 pro"；榜上其余对话基本都跑在 flash 档。

同一维度还暴露出模型名随时间变化：8 月是 `deepseek-v4-pro`，9 月混用 `deepseek-v4-flash`，10 月是
`deepseek-flash`。三者各自按子串规则匹配价表，无需改代码；若官方再调价或改名，改 `src/pricing.ts`
后点「重建统计」即可按新价重算全部历史。

## 已知限制

- 只统计 `assistant/message` 已结算的用量；被重试废弃的 `assistant/attempt` 不计入（官方投影会计入，
  所以本插件数字可能比官方投影**略小**）。实测交叉校验（全量重建后）：本插件 829.0M vs 官方投影缓存
  828.9M，差 **+0.02%**（差异来自快照时点）。
- **会话标题**取自官方 `session-projection-cache` 的
  `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` → `record.rows.title.val`，是**只读、防御性**
  依赖：读不到就退回显示 cwd + 短 id，不影响统计本身。
- 读取失败的会话会被跳过并在面板提示（本地历史遗留的旧命名格式目录实测有 1 个）。
- 工具耗时依赖 `tool/call` 与 `tool/result` 在同一进程生命周期内配对；进程重启会丢失未配对的挂起项
  （仅影响极少数跨重启的长任务耗时，次数计数不受影响）。
- 账本损坏时自动备份为 `.dsh-usage-stats.corrupt-<时间戳>.json` 并从零重建。
- 单价为公开定价的估算值，**以官方账单为准**。
- **按天明细不追溯**：`dayModels` / `dayTools` / `daySessions` 是 v0.1.0 新增维度，历史不会自动补算 ——
  面板会提示「按天明细缺失 N 天」，点一次「重建统计」即可补齐（重放全部会话，约 30 秒）。

## 账本

`%DSH_HOME%/.dsh-usage-stats.json`（默认 `~/.dsh/.dsh-usage-stats.json`），内存为权威、变更后防抖 2 秒
原子落盘（临时文件 + rename）；卸载与重载前强制 flush。

```jsonc
{
  "version": 1,
  "totals": { "uncachedInputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0,
              "outputTokens": 0, "costCny": 0, "sessions": 0, "turns": 0, "steps": 0, "toolCalls": 0 },
  "tools":  { "<工具名>": { "calls": 0, "ms": 0 } },
  "days":   { "YYYY-MM-DD": { /* 四桶 + costCny + toolCalls + modelCalls */ } },
  "dayModels":   { "YYYY-MM-DD": { "<模型名>": { /* 四桶 + costCny + calls */ } } },
  "dayTools":    { "YYYY-MM-DD": { "<工具名>": { "calls": 0, "ms": 0 } } },
  "daySessions": { "YYYY-MM-DD": { "<会话 id>": { /* 四桶 + costCny */ } } },
  "models": { "<模型名>": { /* 四桶 + costCny + calls */ } },
  "sessions": { "<会话 id>": { "consumedSeq": 0, "cwd": "...", "lastTurn": 0, "origin": "root",
                               "usage": { /* 四桶 + costCny */ }, "modelCalls": 0, "toolCalls": 0 } },
  "backfill": { "done": true, "scanned": 0, "total": 0, "errors": 0, "running": false, "failedSessions": [] }
}
```

## HTTP API

前缀 `/dsh-usage-stats/api`（由插件在 host 侧注册）：

**鉴权**：路由复用官方 `ctx.connection.requestRejection`（Host/Origin 围栏 + 浏览器签名 cookie），
即插件自己注册的路由也过一遍官方 `/api` 通道那套准入 —— 回环地址的外部页面、跨站 `no-cors`
简单请求都会被 **403**（来源不可信）或 **401**（未通过浏览器鉴权）挡掉。找不到 `connection`
服务时（非 Web profile）降级为本地 Host/Origin 围栏。面板用 `credentials: 'same-origin'` 取数。

- `GET /summary?days=14&top=12` → `{ ok, generatedAt, totals, tools[], models[], sessions[], toolKinds, days[], backfill, meta }`
  - `days` 上限 400；`range=all` 返回账本里**所有有数据的日期**（不补零）
  - `meta.detailMissing` / `meta.detailMissingDays`：有当日汇总却缺明细的天数（升级后提示重建用）
  - `meta.unpricedModels`：价表未收录、当前按兜底价（Flash 档）估算的模型名（费用不可信的自证）
  - `meta.priceFile` / `meta.priceOverrides` / `meta.priceFileError`：单价覆盖文件的路径、生效条数与错误
- `GET /days?from=YYYY-MM-DD&to=YYYY-MM-DD` → 按天明细
  `{ ok, from, to, days[{ date, models[], tools[], sessions[] }] }`（工具/会话各取 Top 20）。
  面板只在窗口或选中日期变化时按需拉取（60 秒节流），**不跟 3 秒主轮询**。
- `POST /rescan` → 增量扫描（补齐账本中尚无记录的会话）
- `POST /rescan?rebuild=1` → 清空账本后从头重放（改定价 / 新增统计维度后使用）

## 构建、注入与自检

```bash
# A. 免检出（推荐）：只用本地 devDependencies
npm install --ignore-scripts     # typescript / @types/node / tsdown；DSH 包是 optional peer，不会去 registry 拉
npm run build                    # host + client 一起构建

# B. 有 DSH 源码检出：复用检出里的工具链
export DSH_CHECKOUT=/path/to/deepseek-harness
npm run build
```

`npm run build` = `scripts/build.sh`（host：`tsc` → `lib/`）+ `scripts/build-client.sh`（client：`tsdown` →
`lib/client.js`）。两个脚本都先找本地 `node_modules/.bin`，再退回 `$DSH_CHECKOUT`，两条路径都不用额外配置。
host 源码只 import `node:*`，因此**不再需要**旧版那套 cordis / dsh-tools / dsh-llm / schemastery 的
junction 链接 —— 那正是别人机器上最容易装不上的一环。

注入器环境下：`dev_build_plugin <本目录>` → `dev_inject_plugin <本目录>`（运行时注入，免重启，卸载即净）。

自检（**分享前建议都跑一遍**，两个脚本都只读产物、写在临时 DSH_HOME 里）：

```bash
npm run verify:share    # 把当前产物当成「别人拿到的东西」：零依赖装载 host + client 激活 + 鉴权围栏 + 单价覆盖
npm run test:pricing    # 官方价表逐行核对 + 峰谷日历（含法定节假日）
npm run test:gap-fill   # 中途启用不丢历史（见「数据来源与统计口径」）
```

`verify:share` 也可以指向别处的副本：`node scripts/verify-share.mjs /path/to/clone`；
再给第二个参数（旧版产物目录）就会做 A/B，演示「client 未声明 `inject` 时 `apply()` 抛
TypeError → 前端整页报 `entry did not activate`」这条分享杀手。

> `lib/client/index.js` 是 tsc 的中间产物（类型声明用），**真正的 client 入口是 `lib/client.js`**。
> `lib/` 是**有意提交**的构建产物：分享出去的形态是 GitHub 仓库，clone 即可注入，对方不需要 DSH 源码
> 检出、npm 安装或任何构建（改完 `src/` 记得 `npm run build` 并把 `lib/` 一起提交）。

## 开发要点（踩过的坑）

- client 侧 `ctx.slots.register(options, component)` 的 **component 是第二个参数**，且要包在
  `ctx.slots.inject('<slot>', …)` 里、`options.name` 必须是已知 slot 名（这里用 `settings.section`）。
- 注入器的预检用字面形态 `register({` 校验 slot 名，写成 `register(\n  {` 会被误判为「缺合法 name」而阻断注入。
- host 侧**不 import 任何 `@deepseek-ai/*` 值**（只用 `ctx` 取服务），因此不依赖 profile 里的包解析，
  任何 profile 下都不会因缺依赖而挂起；`sessionPersistence` 缺失时自动降级为「仅统计本次启动后的数据」。
- SVG 扇区做 hover 放大要用 `translate`（沿角平分线外移），**不要用 `scale`** —— SVG 元素默认以用户
  坐标系原点为变换基准，直接缩放会让扇区飞出可视区；环心文本用绝对定位 HTML 覆盖层，比 `<text>` 好排版。
- 单个扇区占 100% 时不能用单段 `A` 弧（起终点重合会不渲染），要走两段半弧。
- 交互状态（窗口 / 选中日期 / 饼图维度 / 图例开关）必须存在组件闭包里：3 秒轮询会重绘 DOM，
  存在 DOM 或每次重建都会丢。
- 「明细是否缺失」不能用「明细表是否为空」判断：升级后**当天就会产生新明细**，历史缺失会被掩盖 ——
  要逐日比对「有汇总但无任何明细」的天数（`countDaysMissingDetail`）。
- **自己注册的 Web 路由必须自己补鉴权**：`ctx.webServer.register` 绕过官方 `/api` 通道的准入
  （Host 围栏防 DNS rebinding、`sec-fetch-site`/Origin 防跨站、签名 cookie 防未登录）。插件路由要显式
  调 `ctx.get('connection').requestRejection({ headers })`，前端 fetch 带上 `credentials: 'same-origin'`；
  否则任意 loopback 页面都能用 `no-cors` 简单请求 POST 一个 `?rebuild=1` 把账本清空。
  找不到 `connection` 服务时降级为本地 Host/Origin 围栏（`routeRejection`）。
- **缺口补齐的顺序不能反**：`applyEvent` 会推进游标，任何「先折叠、后补齐」的写法都会让补齐从新游标
  开始读，缺口永久丢失。正确做法是缺口会话上先补齐（游标不动）、期间实时事件只入队、补齐后重放。
- **未收录模型要显式暴露**：静默按兜底价估算会把「估算不准」伪装成正常数字 —— 面板必须能看出
  哪些模型的金额只是兜底（`meta.unpricedModels`），否则费用这一栏就是不可证伪的。
