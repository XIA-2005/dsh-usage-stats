# @dsh-external/dsh-usage-stats

DeepSeek Harness 的**用量与工具调用统计**插件：在 Web 设置页新增「用量统计」分区，展示
累计 token 用量（四桶）、估算费用（¥）、会话 / 轮次 / 步数、**按工具名的调用次数与耗时排行榜**、
按模型分布、以及近 14 天的按天趋势。

首次启用时**回填全部历史会话**，之后实时增量累计，跨重启不丢。

## 安装

```bash
git clone https://github.com/XIA-2005/dsh-usage-stats.git
cd dsh-usage-stats
export DSH_CHECKOUT=/path/to/deepseek-harness   # 需要含 packages/ 与 node_modules/.bin/tsc 的源码检出
bash scripts/build.sh        # host：link 依赖 + tsc → lib/
npm run build:client         # client：tsdown → lib/client.js
```

构建完成后，在 DSH 注入器环境里 `dev_build_plugin <本目录>` → `dev_inject_plugin <本目录>`
即可（运行时注入，免重启，卸载即净）。

## 功能

| 区块 | 内容 |
| --- | --- |
| 总览卡片 | 总 tokens、估算费用 ¥、会话 / 轮次（另附步数）、工具调用总次数（另附工具种类数） |
| token 构成 | 未缓存输入 / 缓存读取 / 缓存写入 / 输出 四桶的绝对值、占比与条形图 |
| 工具调用排行 | Top N（默认 12）：调用次数、占比条、按 `tool/call → tool/result` 配对的累计耗时 |
| 按模型 | 每个模型的调用次数、缓存读、输出、费用 —— 也是费用口径的自证（Pro 档单价为基价 3 倍） |
| 最贵的对话 | 按估算费用降序的会话排行（标题 / 创建日 / tokens / 费用），直接回答「钱花在哪个对话上」 |
| 近 14 天趋势 | 每日 token 柱状图（hover 显示当日 token / 费用 / 工具次数 / 模型调用次数） |
| 操作 | 刷新、增量扫描（补齐新会话）、重建统计（清空账本从头重放） |

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
  峰谷按**事件自身时间戳**判定（工作日北京时间 9–12 点、14–18 点为峰时；2026-08-23 起周末全天谷价），
  因此历史回填也能还原当时的时段价。单价表集中在 `src/pricing.ts`，调价只改该文件，然后点「重建统计」。
- **子代理会话**计入总量（它们真实消耗 token）。
- **去重**：每个会话维护 `consumedSeq` 游标，实时链路与回填路径在折叠前统一做 `seq < consumedSeq` 跳过，
  因此两条路径重叠工作也只计一次；注入发生在会话中途时（`seq` 跳跃）会自动补齐缺口。

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
  "models": { "<模型名>": { /* 四桶 + costCny + calls */ } },
  "sessions": { "<会话 id>": { "consumedSeq": 0, "cwd": "...", "lastTurn": 0, "origin": "root",
                               "usage": { /* 四桶 + costCny */ }, "modelCalls": 0, "toolCalls": 0 } },
  "backfill": { "done": true, "scanned": 0, "total": 0, "errors": 0, "running": false, "failedSessions": [] }
}
```

## HTTP API

前缀 `/dsh-usage-stats/api`（由插件在 host 侧注册）：

- `GET /summary?days=14&top=12` → `{ ok, generatedAt, totals, tools[], models[], sessions[], toolKinds, days[], backfill, meta }`
- `POST /rescan` → 增量扫描（补齐账本中尚无记录的会话）
- `POST /rescan?rebuild=1` → 清空账本后从头重放（改定价 / 新增统计维度后使用）

## 构建与注入

```bash
export DSH_CHECKOUT=D:/deepseek-harness     # 需含 packages/ 与 node_modules/.bin/tsc 的源码检出
bash scripts/build.sh                        # host：link 依赖 + tsc → lib/
npm run build:client                         # client：tsdown → lib/client.js
```

注入器环境下：`dev_build_plugin <本目录>` → `dev_inject_plugin <本目录>`（运行时注入，免重启，卸载即净）。

> 注：`npm run build:client` 需要 tsdown 可解析；若插件目录未装，可直接调用检出里的
> `<DSH_CHECKOUT>/node_modules/.bin/tsdown`（在插件目录内执行）。
> `lib/client/index.js` 是 tsc 的中间产物（类型声明用），**真正的 client 入口是 `lib/client.js`**。

## 开发要点（踩过的坑）

- client 侧 `ctx.slots.register(options, component)` 的 **component 是第二个参数**，且要包在
  `ctx.slots.inject('<slot>', …)` 里、`options.name` 必须是已知 slot 名（这里用 `settings.section`）。
- 注入器的预检用字面形态 `register({` 校验 slot 名，写成 `register(\n  {` 会被误判为「缺合法 name」而阻断注入。
- host 侧**不 import 任何 `@deepseek-ai/*` 值**（只用 `ctx` 取服务），因此不依赖 profile 里的包解析，
  任何 profile 下都不会因缺依赖而挂起；`sessionPersistence` 缺失时自动降级为「仅统计本次启动后的数据」。
