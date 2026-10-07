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
 * 数据来自 host 的 `/dsh-usage-stats/api/summary`，每 3 秒轮询；DOM 只建一次，
 * 刷新时仅改文本与宽度，避免闪烁。
 *
 * @module @dsh-external/dsh-usage-stats/client
 */

import * as React from 'react'

/** host API 前缀（与 src/index.ts 的 API_PREFIX 一致）。 */
const API = '/dsh-usage-stats/api'

/** 轮询间隔。 */
const POLL_MS = 3000

/** 趋势窗口与排行条数。 */
const DAYS = 14
const TOP = 12

type SlotsLike = {
  inject(name: string, callback: () => unknown): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

type ClientContext = {
  slots: SlotsLike
  effect(callback: () => unknown, label?: string): () => void
}

/** 槽位注入声明：缺了 ctx.slots 不会被注入。 */
export const inject = ['slots']

/** 一条工具排行。 */
interface ToolRow {
  name: string
  calls: number
  ms: number
  share: number
}

/** 一条模型统计。 */
interface ModelRow {
  model: string
  calls: number
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  costCny: number
}

/** 一条会话用量排行。 */
interface SessionRow {
  id: string
  title: string | null
  cwd: string
  createdAt: number
  origin: string
  modelCalls: number
  toolCalls: number
  usage: {
    uncachedInputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
    costCny: number
  }
}

/** 一天的趋势数据。 */
interface DayRow {
  date: string
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  costCny: number
  toolCalls: number
  modelCalls: number
}

/** host 返回的汇总视图。 */
interface Summary {
  ok: boolean
  generatedAt: number
  totals: {
    uncachedInputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
    costCny: number
    sessions: number
    turns: number
    steps: number
    toolCalls: number
  }
  tools: ToolRow[]
  models: ModelRow[]
  sessions: SessionRow[]
  toolKinds: number
  days: DayRow[]
  backfill: { done: boolean; scanned: number; total: number; errors: number; running: boolean }
  meta: {
    persistenceAvailable: boolean
    ledgerFile: string
    writeError: string | null
    updatedAt: number
    sessionCount: number
  }
}

const STYLES = `
.dus-page{font-size:12px;line-height:1.5;padding:8px 2px 24px;max-width:860px;color:var(--theme-text,#ddd);font-family:inherit}
.dus-head{display:flex;align-items:center;gap:8px;margin:0 0 6px}
.dus-head h3{margin:0;font-size:13px;flex:1}
.dus-actions{display:flex;gap:6px}
.dus-btn{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer}
.dus-btn:hover{border-color:var(--theme-accent,#4a9eff);color:var(--theme-accent,#4a9eff)}
.dus-btn:disabled{opacity:.45;cursor:not-allowed}
.dus-status{margin:0 0 12px;color:var(--theme-text-secondary,#888);font-size:11px}
.dus-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:14px}
.dus-card{border:1px solid var(--theme-border,#333);border-radius:8px;padding:9px 11px;background:var(--theme-input-bg,rgba(255,255,255,.02))}
.dus-card-label{font-size:11px;color:var(--theme-text-secondary,#888)}
.dus-card-value{font-size:17px;font-weight:600;margin:2px 0 1px;font-variant-numeric:tabular-nums}
.dus-card-sub{font-size:10px;color:var(--theme-text-secondary,#888)}
.dus-section{margin:0 0 8px;font-size:12px;font-weight:600}
.dus-bucket{display:grid;grid-template-columns:76px 1fr 96px;align-items:center;gap:8px;margin-bottom:3px}
.dus-bucket-label{color:var(--theme-text-secondary,#999);font-size:11px}
.dus-track{height:8px;border-radius:4px;background:var(--theme-border,#2a2a2a);overflow:hidden}
.dus-fill{height:100%;border-radius:4px;background:var(--theme-accent,#4a9eff);transition:width .3s ease}
.dus-fill.hit{background:#2ecc71}
.dus-fill.write{background:#e67e22}
.dus-fill.out{background:#9b59b6}
.dus-bucket-value{text-align:right;font-variant-numeric:tabular-nums;font-size:11px}
.dus-table{width:100%;border-collapse:collapse;margin-bottom:14px}
.dus-table th{text-align:left;font-weight:500;font-size:10px;color:var(--theme-text-secondary,#888);padding:0 6px 4px 0;border-bottom:1px solid var(--theme-border,#333)}
.dus-table td{padding:4px 6px 4px 0;border-bottom:1px solid var(--theme-border,#222);font-variant-numeric:tabular-nums}
.dus-table td.name{font-family:ui-monospace,monospace;font-size:11px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-table td.num{text-align:right;width:78px}
.dus-table td.share{width:120px}
.dus-mini{height:6px;border-radius:3px;background:var(--theme-accent,#4a9eff);opacity:.75}
.dus-chart{display:flex;align-items:flex-end;gap:3px;height:92px;margin:2px 0 4px;border-bottom:1px solid var(--theme-border,#333);padding-bottom:1px}
.dus-bar{flex:1;min-height:2px;background:var(--theme-accent,#4a9eff);opacity:.65;border-radius:2px 2px 0 0}
.dus-bar.today{opacity:1}
.dus-axis{display:flex;gap:3px;font-size:9px;color:var(--theme-text-secondary,#888)}
.dus-axis span{flex:1;text-align:center;overflow:hidden;white-space:nowrap}
.dus-empty{color:var(--theme-text-secondary,#888);font-size:11px;padding:6px 0 12px}
.dus-warn{color:#f1c40f;font-size:11px;margin:0 0 8px}
`

/** 建元素助手。 */
function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (cls !== undefined) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** 千分位整数。 */
function fmtInt(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** token 缩写（K/M/B），完整值放 title。 */
function fmtTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(Math.round(value))
}

/** 费用（CNY），按量级选小数位。 */
function fmtCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '¥0'
  if (value < 0.01) return `¥${value.toFixed(4)}`
  if (value < 1) return `¥${value.toFixed(3)}`
  return `¥${value.toFixed(2)}`
}

/** 时长。 */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${Math.round(seconds - minutes * 60)}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes - hours * 60}m`
}

/** 百分比。 */
function fmtPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  const percent = ratio * 100
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(digits)}%`
}

/** 一行「标签 + 条 + 数值」的 token 构成行。 */
interface BucketRow {
  key: 'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'
  label: string
  cls: string
  fill: HTMLElement
  value: HTMLElement
}

/** 卡片：标题 + 主值 + 副值。 */
interface Card {
  node: HTMLElement
  value: HTMLElement
  sub: HTMLElement
}

/** 建一张卡片。 */
function makeCard(label: string): Card {
  const node = el('div', 'dus-card')
  const value = el('div', 'dus-card-value', '—')
  const sub = el('div', 'dus-card-sub', '')
  node.append(el('div', 'dus-card-label', label), value, sub)
  return { node, value, sub }
}

/** 面板组件：容器 + 命令式 DOM（避免为图表引入 react 生态依赖）。 */
function UsagePage(): unknown {
  const hostRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const root = hostRef.current
    if (root === null) return

    const style = el('style')
    style.textContent = STYLES
    const page = el('div', 'dus-page')

    const head = el('div', 'dus-head')
    const actions = el('div', 'dus-actions')
    const refreshButton = el('button', 'dus-btn', '刷新') as HTMLButtonElement
    const rescanButton = el('button', 'dus-btn', '增量扫描') as HTMLButtonElement
    const rebuildButton = el('button', 'dus-btn', '重建统计') as HTMLButtonElement
    rebuildButton.title = '清空账本并从头重放全部历史（改定价或新增统计维度后用，耗时较长）'
    actions.append(refreshButton, rescanButton, rebuildButton)
    head.append(el('h3', undefined, '用量统计'), actions)

    const status = el('p', 'dus-status', '加载中…')
    const warn = el('p', 'dus-warn', '')
    warn.style.display = 'none'

    // 总览卡片
    const cards = el('div', 'dus-cards')
    const cardTokens = makeCard('总 tokens')
    const cardCost = makeCard('估算费用')
    const cardSessions = makeCard('会话 / 轮次')
    const cardTools = makeCard('工具调用')
    cards.append(cardTokens.node, cardCost.node, cardSessions.node, cardTools.node)

    // token 构成
    const bucketSection = el('div')
    bucketSection.append(el('div', 'dus-section', 'token 构成'))
    const bucketRows: BucketRow[] = [
      { key: 'uncachedInputTokens', label: '未缓存输入', cls: '', fill: el('div', 'dus-fill'), value: el('div', 'dus-bucket-value', '0') },
      { key: 'cacheReadTokens', label: '缓存读取', cls: 'hit', fill: el('div', 'dus-fill hit'), value: el('div', 'dus-bucket-value', '0') },
      { key: 'cacheWriteTokens', label: '缓存写入', cls: 'write', fill: el('div', 'dus-fill write'), value: el('div', 'dus-bucket-value', '0') },
      { key: 'outputTokens', label: '输出', cls: 'out', fill: el('div', 'dus-fill out'), value: el('div', 'dus-bucket-value', '0') },
    ]
    for (const row of bucketRows) {
      const line = el('div', 'dus-bucket')
      const track = el('div', 'dus-track')
      track.append(row.fill)
      line.append(el('div', 'dus-bucket-label', row.label), track, row.value)
      bucketSection.append(line)
    }

    // 工具排行
    const toolsSection = el('div')
    toolsSection.append(el('div', 'dus-section', '工具调用排行'))
    const toolsEmpty = el('div', 'dus-empty', '暂无工具调用记录')
    const toolsTable = el('table', 'dus-table')
    const toolsHead = el('tr')
    for (const [text, cls] of [['工具', ''], ['次数', 'num'], ['占比', 'share'], ['总耗时', 'num']] as const) {
      const th = el('th', cls === '' ? undefined : cls, text)
      toolsHead.append(th)
    }
    const toolsBody = el('tbody')
    const toolsThead = el('thead')
    toolsThead.append(toolsHead)
    toolsTable.append(toolsThead, toolsBody)

    // 模型分布（也是费用口径的自证：Pro 档单价为基价 3 倍）
    const modelsSection = el('div')
    modelsSection.append(el('div', 'dus-section', '按模型'))
    const modelsEmpty = el('div', 'dus-empty', '暂无模型调用记录')
    const modelsTable = el('table', 'dus-table')
    const modelsHead = el('tr')
    for (const [text, cls] of [
      ['模型', ''],
      ['调用', 'num'],
      ['缓存读', 'num'],
      ['输出', 'num'],
      ['费用', 'num'],
    ] as const) {
      modelsHead.append(el('th', cls === '' ? undefined : cls, text))
    }
    const modelsThead = el('thead')
    modelsThead.append(modelsHead)
    const modelsBody = el('tbody')
    modelsTable.append(modelsThead, modelsBody)

    // 最贵的对话 —— 回答「钱到底花在哪个对话上」
    const sessionsSection = el('div')
    sessionsSection.append(el('div', 'dus-section', '最贵的对话'))
    const sessionsEmpty = el('div', 'dus-empty', '暂无会话用量记录')
    const sessionsTable = el('table', 'dus-table')
    const sessionsHead = el('tr')
    for (const [text, cls] of [
      ['对话', ''],
      ['创建', 'num'],
      ['tokens', 'num'],
      ['费用', 'num'],
    ] as const) {
      sessionsHead.append(el('th', cls === '' ? undefined : cls, text))
    }
    const sessionsThead = el('thead')
    sessionsThead.append(sessionsHead)
    const sessionsBody = el('tbody')
    sessionsTable.append(sessionsThead, sessionsBody)

    // 按天趋势
    const chartSection = el('div')
    chartSection.append(el('div', 'dus-section', `近 ${DAYS} 天 token 用量`))
    const chart = el('div', 'dus-chart')
    const axis = el('div', 'dus-axis')
    const chartSub = el('div', 'dus-card-sub', '')

    page.append(
      style,
      head,
      status,
      warn,
      cards,
      bucketSection,
      toolsSection,
      modelsSection,
      sessionsSection,
      chartSection,
    )
    toolsSection.append(toolsEmpty, toolsTable)
    modelsSection.append(modelsEmpty, modelsTable)
    sessionsSection.append(sessionsEmpty, sessionsTable)
    chartSection.append(chart, axis, chartSub)
    root.append(page)

    let disposed = false
    let timer = 0

    const renderTools = (tools: ToolRow[]): void => {
      toolsBody.textContent = ''
      if (tools.length === 0) {
        toolsEmpty.style.display = 'block'
        toolsTable.style.display = 'none'
        return
      }
      toolsEmpty.style.display = 'none'
      toolsTable.style.display = 'table'
      for (const tool of tools) {
        const tr = el('tr')
        const name = el('td', 'name', tool.name)
        name.title = tool.name
        const calls = el('td', 'num', fmtInt(tool.calls))
        const shareCell = el('td', 'share')
        const mini = el('div', 'dus-mini')
        mini.style.width = `${Math.max(2, Math.round(tool.share * 100))}%`
        shareCell.append(mini)
        const ms = el('td', 'num', fmtDuration(tool.ms))
        ms.title = `${fmtInt(tool.ms)} ms`
        tr.append(name, calls, shareCell, ms)
        toolsBody.append(tr)
      }
    }

    const renderSessions = (sessions: SessionRow[]): void => {
      sessionsBody.textContent = ''
      if (sessions.length === 0) {
        sessionsEmpty.style.display = 'block'
        sessionsTable.style.display = 'none'
        return
      }
      sessionsEmpty.style.display = 'none'
      sessionsTable.style.display = 'table'
      for (const row of sessions) {
        const tr = el('tr')
        const tokens =
          row.usage.uncachedInputTokens +
          row.usage.cacheReadTokens +
          row.usage.cacheWriteTokens +
          row.usage.outputTokens
        const folder = row.cwd === '' ? '' : (row.cwd.split(/[\\/]/).pop() ?? '')
        const label = row.title !== null && row.title !== '' ? row.title : `${folder} / ${row.id.slice(0, 8)}`
        const name = el('td', 'name', label)
        name.title = [
          row.title ?? '(无标题)',
          row.id,
          row.cwd,
          `${row.origin === 'subagent' ? '子代理会话' : '主会话'} · 模型调用 ${fmtInt(row.modelCalls)} 次 · 工具 ${fmtInt(row.toolCalls)} 次`,
        ].join('\n')
        const when = el('td', 'num', row.createdAt > 0 ? new Date(row.createdAt).toLocaleDateString('zh-CN') : '—')
        when.title = row.createdAt > 0 ? new Date(row.createdAt).toLocaleString('zh-CN') : ''
        const tok = el('td', 'num', fmtTokens(tokens))
        tok.title = fmtInt(tokens)
        const cost = el('td', 'num', fmtCost(row.usage.costCny))
        cost.title = `¥${row.usage.costCny}`
        tr.append(name, when, tok, cost)
        sessionsBody.append(tr)
      }
    }

    const renderModels = (models: ModelRow[]): void => {
      modelsBody.textContent = ''
      if (models.length === 0) {
        modelsEmpty.style.display = 'block'
        modelsTable.style.display = 'none'
        return
      }
      modelsEmpty.style.display = 'none'
      modelsTable.style.display = 'table'
      for (const row of models) {
        const tr = el('tr')
        const name = el('td', 'name', row.model)
        name.title = row.model
        const calls = el('td', 'num', fmtInt(row.calls))
        const cacheRead = el('td', 'num', fmtTokens(row.cacheReadTokens))
        cacheRead.title = `${fmtInt(row.cacheReadTokens)} 缓存读取`
        const output = el('td', 'num', fmtTokens(row.outputTokens))
        output.title = `${fmtInt(row.outputTokens)} 输出`
        const cost = el('td', 'num', fmtCost(row.costCny))
        cost.title = `¥${row.costCny}`
        tr.append(name, calls, cacheRead, output, cost)
        modelsBody.append(tr)
      }
    }

    const renderDays = (days: DayRow[]): void => {
      chart.textContent = ''
      axis.textContent = ''
      if (days.length === 0) return
      const totals = days.map((day) => day.uncachedInputTokens + day.cacheReadTokens + day.cacheWriteTokens + day.outputTokens)
      const max = Math.max(...totals, 1)
      const todayKey = days[days.length - 1]?.date
      days.forEach((day, index) => {
        const tokens = totals[index] ?? 0
        const bar = el('div', index === days.length - 1 ? 'dus-bar today' : 'dus-bar')
        bar.style.height = `${Math.max(2, Math.round((tokens / max) * 88))}px`
        bar.title = `${day.date}\n${fmtInt(tokens)} tokens（${fmtTokens(tokens)}）\n${fmtCost(day.costCny)} · 工具 ${fmtInt(day.toolCalls)} 次 · 模型调用 ${fmtInt(day.modelCalls)} 次`
        chart.append(bar)
        const label = el('span', undefined, day.date === todayKey ? '今天' : day.date.slice(5))
        axis.append(label)
      })
      const sum = totals.reduce((acc, value) => acc + value, 0)
      const cost = days.reduce((acc, day) => acc + day.costCny, 0)
      chartSub.textContent = `窗口合计 ${fmtInt(sum)} tokens（${fmtTokens(sum)}） · ${fmtCost(cost)}`
    }

    const render = (data: Summary): void => {
      const { totals, meta, backfill } = data
      const total = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens
      cardTokens.value.textContent = fmtTokens(total)
      cardTokens.value.title = `${fmtInt(total)} tokens`
      cardTokens.sub.textContent = `未缓存 ${fmtTokens(totals.uncachedInputTokens)} · 缓存读 ${fmtTokens(totals.cacheReadTokens)}`
      cardCost.value.textContent = fmtCost(totals.costCny)
      cardCost.value.title = `¥${totals.costCny}`
      cardCost.sub.textContent = '按峰谷时段估算，以账单为准'
      cardSessions.value.textContent = `${fmtInt(totals.sessions)} / ${fmtInt(totals.turns)}`
      cardSessions.sub.textContent = `步数 ${fmtInt(totals.steps)}`
      cardTools.value.textContent = fmtInt(totals.toolCalls)
      cardTools.sub.textContent = `${fmtInt(data.toolKinds)} 种工具`

      const peak = Math.max(totals.uncachedInputTokens, totals.cacheReadTokens, totals.cacheWriteTokens, totals.outputTokens, 1)
      for (const row of bucketRows) {
        const value = totals[row.key]
        row.fill.style.width = `${Math.max(value > 0 ? 1.5 : 0, (value / peak) * 100)}%`
        row.value.textContent = `${fmtTokens(value)} (${fmtPercent(total > 0 ? value / total : 0)})`
        row.value.title = fmtInt(value)
      }

      renderTools(data.tools)
      renderModels(data.models)
      renderSessions(data.sessions)
      renderDays(data.days)

      const progress = backfill.running
        ? ` · 回填中 ${fmtInt(backfill.scanned)}/${fmtInt(backfill.total)}`
        : backfill.done
          ? ` · 已回填 ${fmtInt(backfill.scanned)}/${fmtInt(backfill.total)}`
          : ''
      const time = new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })
      status.textContent = `${meta.persistenceAvailable ? '持久化服务可用' : '持久化服务不可用（仅统计本次启动）'}${progress} · 更新于 ${time}`
      status.title = `账本：${meta.ledgerFile}`

      const messages: string[] = []
      if (!meta.persistenceAvailable) messages.push('未找到会话持久化服务，历史回填不可用。')
      if (meta.writeError !== null) messages.push(`账本写入失败（统计仅在内存中，重启后丢失）：${meta.writeError}`)
      if (backfill.errors > 0) messages.push(`${backfill.errors} 个会话读取失败，已跳过。`)
      if (messages.length > 0) {
        warn.textContent = messages.join(' ')
        warn.style.display = 'block'
      } else {
        warn.style.display = 'none'
      }
    }

    const refresh = (): void => {
      void fetch(`${API}/summary?days=${DAYS}&top=${TOP}`, { headers: { accept: 'application/json' } })
        .then((response) => response.json() as Promise<Summary>)
        .then((data) => {
          if (disposed) return
          if (data.ok !== true) {
            status.textContent = '统计数据不可用'
            return
          }
          render(data)
        })
        .catch((error: unknown) => {
          if (disposed) return
          status.textContent = `加载失败：${String(error)}`
        })
    }

    refreshButton.addEventListener('click', () => refresh())
    const scan = (button: HTMLButtonElement, label: string, rebuild: boolean): void => {
      button.disabled = true
      button.textContent = '扫描中…'
      void fetch(`${API}/rescan${rebuild ? '?rebuild=1' : ''}`, { method: 'POST' })
        .then((response) => response.json())
        .then(() => {
          refresh()
        })
        .catch((error: unknown) => {
          status.textContent = `扫描失败：${String(error)}`
        })
        .finally(() => {
          button.disabled = false
          button.textContent = label
        })
    }
    rescanButton.addEventListener('click', () => scan(rescanButton, '增量扫描', false))
    rebuildButton.addEventListener('click', () => scan(rebuildButton, '重建统计', true))

    refresh()
    timer = window.setInterval(refresh, POLL_MS)

    return () => {
      disposed = true
      if (timer !== 0) window.clearInterval(timer)
    }
  }, [])

  return React.createElement('div', { ref: hostRef })
}

/**
 * 注册设置页分区。
 * @param ctx - client 上下文（含 slots 服务）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        // 注意：`register({` 必须紧邻 —— 注入器的预检用该字面形态校验 slot 名，
        // 换行写法（register(\n  {）会被误判为「缺合法 name」而阻断注入。
        ctx.slots.register({
          name: 'settings.section',
          id: 'usage-stats',
          order: 50,
          label: () => '用量统计',
        }, () => React.createElement(UsagePage)),
      ),
    'usage-stats: settings page',
  )
}
