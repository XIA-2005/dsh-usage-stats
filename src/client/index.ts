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

import * as React from 'react'

import { createBars, createDonut, type Bar, type BarsController, type DonutController, type Slice } from './chart.js'
import { fmtCost, fmtDateTime, fmtDuration, fmtInt, fmtPercent, fmtTokens } from './format.js'
import { STYLES, paletteColor } from './styles.js'

/** host API 前缀（与 src/index.ts 的 API_PREFIX 一致）。 */
const API = '/dsh-usage-stats/api'

/** 主轮询间隔。 */
const POLL_MS = 3000

/** 明细的重新拉取节流（明细较大，不跟着 3 秒轮询走）。 */
const DETAIL_TTL_MS = 60_000

/** 表格与排行的条数。 */
const TOP = 12

/** 饼图里「其他」归并前的最大扇区数。 */
const PIE_TOP_TOOLS = 8
const PIE_TOP_SESSIONS = 6

/** 四桶语义色（与条形图、图例保持一致）。 */
const BUCKET_COLORS = {
  uncachedInputTokens: '#4a9eff',
  cacheReadTokens: '#2ecc71',
  cacheWriteTokens: '#e67e22',
  outputTokens: '#9b59b6',
} as const

/** 「其他」项的固定色。 */
const OTHER_COLOR = '#7f8c8d'

type RangeKey = 7 | 14 | 30 | 90 | 'all'
type PieMode = 'tokens' | 'models' | 'tools' | 'sessions'

/** 范围按钮。 */
const RANGES: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: 7, label: '7 天' },
  { key: 14, label: '14 天' },
  { key: 30, label: '30 天' },
  { key: 90, label: '90 天' },
  { key: 'all', label: '全部' },
]

/** 饼图维度按钮。 */
const MODES: ReadonlyArray<{ key: PieMode; label: string }> = [
  { key: 'tokens', label: 'token 构成' },
  { key: 'models', label: '按模型' },
  { key: 'tools', label: '按工具' },
  { key: 'sessions', label: '按对话' },
]

/** 用量四桶 + 费用。 */
interface Usage {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  costCny: number
}

/** 工具排行行。 */
interface ToolRow {
  name: string
  calls: number
  ms: number
  share: number
}

/** 模型行。 */
interface ModelRow extends Usage {
  model: string
  calls: number
}

/** 会话行。 */
interface SessionRow {
  id: string
  title: string | null
  cwd: string
  createdAt: number
  origin: string
  modelCalls: number
  toolCalls: number
  usage: Usage
}

/** 单日趋势行。 */
interface DayRow extends Usage {
  date: string
  toolCalls: number
  modelCalls: number
}

/** `/summary` 响应。 */
interface Summary {
  ok: boolean
  generatedAt: number
  totals: Usage & { sessions: number; turns: number; steps: number; toolCalls: number }
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
    detailMissing: boolean
  }
}

/** `/days` 里的单日明细。 */
interface DayDetail {
  date: string
  models: Array<ModelRow>
  tools: Array<{ name: string; calls: number; ms: number }>
  sessions: Array<{ id: string; title: string | null; origin: string; usage: Usage }>
}

/** 聚合项（模型 / 工具 / 会话共用）。 */
interface Agg {
  key: string
  label: string
  usage: Usage
  calls: number
  ms: number
}

/** 建元素助手。 */
function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (cls !== undefined) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** 空用量。 */
function emptyUsage(): Usage {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costCny: 0 }
}

/** 累加用量（就地）。 */
function addUsage(target: Usage, source: Usage): void {
  target.uncachedInputTokens += source.uncachedInputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.outputTokens += source.outputTokens
  target.costCny += source.costCny
}

/** 四桶合计。 */
function usageTokens(usage: Usage): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
}

/** 北京日历日键（与 host 的 dayKey 同口径）。 */
function beijingDayKey(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 今天往前 n 天的北京日历日键。 */
function shiftDayKey(days: number): string {
  return beijingDayKey(Date.now() - days * 86_400_000)
}

/** 柱状图横轴标签抽稀步长。 */
function labelStep(count: number): number {
  if (count > 60) return 14
  if (count > 30) return 7
  if (count > 14) return 2
  return 1
}

/** 面板组件：容器 + 命令式 DOM（避免为图表引入 react 生态依赖）。 */
function UsagePage(): unknown {
  const hostRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const root = hostRef.current
    if (root === null) return

    // ---- 交互状态（轮询重绘不重置） -------------------------------------
    let range: RangeKey = 14
    let selectedDate: string | null = null
    let pieMode: PieMode = 'tokens'
    /** 图例开关：按维度分别记忆被隐藏的 key。 */
    const hidden = new Map<PieMode, Set<string>>()
    /** 已加载的按天明细。 */
    const details = new Map<string, DayDetail>()
    let detailsKey = ''
    let lastDetailAt = 0
    let detailError = ''
    let summary: Summary | null = null
    let disposed = false
    let pollTimer = 0

    // ---- DOM 骨架 -------------------------------------------------------
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
    /** 卡片：标题 + 主值 + 副值。 */
    const makeCard = (label: string): { node: HTMLElement; label: HTMLElement; value: HTMLElement; sub: HTMLElement } => {
      const node = el('div', 'dus-card')
      const labelNode = el('div', 'dus-card-label', label)
      const value = el('div', 'dus-card-value', '—')
      const sub = el('div', 'dus-card-sub', '')
      node.append(labelNode, value, sub)
      return { node, label: labelNode, value, sub }
    }
    const cardTokens = makeCard('总 tokens')
    const cardCost = makeCard('估算费用')
    const cardSessions = makeCard('会话 / 轮次')
    const cardTools = makeCard('工具调用')
    cards.append(cardTokens.node, cardCost.node, cardSessions.node, cardTools.node)

    // token 构成条
    const bucketSection = el('div')
    const bucketTitle = el('div', 'dus-section', 'token 构成')
    bucketSection.append(bucketTitle)
    const bucketRows = [
      { key: 'uncachedInputTokens', label: '未缓存输入', cls: '', fill: el('div', 'dus-fill'), value: el('div', 'dus-bucket-value', '0') },
      { key: 'cacheReadTokens', label: '缓存读取', cls: 'hit', fill: el('div', 'dus-fill hit'), value: el('div', 'dus-bucket-value', '0') },
      { key: 'cacheWriteTokens', label: '缓存写入', cls: 'write', fill: el('div', 'dus-fill write'), value: el('div', 'dus-bucket-value', '0') },
      { key: 'outputTokens', label: '输出', cls: 'out', fill: el('div', 'dus-fill out'), value: el('div', 'dus-bucket-value', '0') },
    ] as const
    for (const row of bucketRows) {
      const line = el('div', 'dus-bucket')
      const track = el('div', 'dus-track')
      track.append(row.fill)
      line.append(el('div', 'dus-bucket-label', row.label), track, row.value)
      bucketSection.append(line)
    }

    /** 建一张「标题 + 空态 + 表格」的板块。 */
    const makeTableSection = (
      title: string,
      emptyText: string,
      columns: ReadonlyArray<readonly [string, string]>,
    ): { section: HTMLElement; title: HTMLElement; empty: HTMLElement; table: HTMLElement; body: HTMLElement } => {
      const section = el('div')
      const titleNode = el('div', 'dus-section', title)
      const empty = el('div', 'dus-empty', emptyText)
      const table = el('table', 'dus-table')
      const thead = el('thead')
      const headRow = el('tr')
      for (const [text, cls] of columns) headRow.append(el('th', cls === '' ? undefined : cls, text))
      thead.append(headRow)
      const body = el('tbody')
      table.append(thead, body)
      section.append(titleNode, empty, table)
      return { section, title: titleNode, empty, table, body }
    }

    const toolsSection = makeTableSection('工具调用排行', '暂无工具调用记录', [
      ['工具', ''],
      ['次数', 'num'],
      ['占比', 'share'],
      ['总耗时', 'num'],
    ])
    const modelsSection = makeTableSection('按模型', '暂无模型调用记录', [
      ['模型', ''],
      ['调用', 'num'],
      ['缓存读', 'num'],
      ['输出', 'num'],
      ['费用', 'num'],
    ])
    const sessionsSection = makeTableSection('最贵的对话', '暂无会话用量记录', [
      ['对话', ''],
      ['创建', 'num'],
      ['tokens', 'num'],
      ['费用', 'num'],
    ])

    // 趋势区（范围切换 + 柱状图）
    const trendSection = el('div')
    const trendTitle = el('div', 'dus-section', '用量趋势')
    const trendControls = el('div', 'dus-row')
    const rangeSeg = el('div', 'dus-seg')
    const rangeButtons = new Map<RangeKey, HTMLButtonElement>()
    for (const item of RANGES) {
      const button = el('button', undefined, item.label) as HTMLButtonElement
      button.addEventListener('click', () => {
        if (range === item.key) return
        range = item.key
        selectedDate = null
        details.clear()
        detailsKey = ''
        paintRangeButtons()
        void loadDetails(true).then(() => paint())
        void loadSummary()
      })
      rangeButtons.set(item.key, button)
      rangeSeg.append(button)
    }
    const chip = el('div', 'dus-chip')
    const chipLabel = el('span', undefined, '')
    const chipClear = el('button', undefined, '×') as HTMLButtonElement
    chipClear.title = '取消选择，回到累计视图'
    chipClear.addEventListener('click', () => {
      selectedDate = null
      paint()
    })
    chip.append(chipLabel, chipClear)
    trendControls.append(rangeSeg, chip)
    const chart = el('div', 'dus-chart')
    const axis = el('div', 'dus-axis')
    const trendSub = el('div', 'dus-card-sub', '')
    trendSection.append(trendTitle, trendControls, chart, axis, trendSub)

    // 饼图区
    const pieSection = el('div')
    const pieTitle = el('div', 'dus-section', '构成分析')
    const pieControls = el('div', 'dus-row')
    const modeSeg = el('div', 'dus-seg')
    const modeButtons = new Map<PieMode, HTMLButtonElement>()
    for (const item of MODES) {
      const button = el('button', undefined, item.label) as HTMLButtonElement
      button.addEventListener('click', () => {
        if (pieMode === item.key) return
        pieMode = item.key
        paintPie()
      })
      modeButtons.set(item.key, button)
      modeSeg.append(button)
    }
    pieControls.append(modeSeg)
    const pieFlex = el('div', 'dus-pie-flex')
    const pieChart = el('div')
    const legend = el('ul', 'dus-legend')
    pieFlex.append(pieChart, legend)
    const pieSub = el('div', 'dus-pie-sub2', '')
    pieSection.append(pieTitle, pieControls, pieFlex, pieSub)

    page.append(
      style,
      head,
      status,
      warn,
      cards,
      bucketSection,
      toolsSection.section,
      modelsSection.section,
      sessionsSection.section,
      trendSection,
      pieSection,
    )
    root.append(page)

    // ---- 图表实例 -------------------------------------------------------
    const bars: BarsController = createBars(chart, axis, (key) => {
      selectedDate = selectedDate === key ? null : key
      paint()
    })
    const donut: DonutController = createDonut(pieChart, (slice) => {
      if (slice === null) {
        paintPieCenter()
        return
      }
      const slices = currentSlices()
      const total = slices.reduce((sum, item) => sum + Math.max(0, item.value), 0)
      donut.setCenter(slice.label, `${fmtPercent(total > 0 ? slice.value / total : 0)} · ${sliceDetailText(slice, total)}`)
    })

    // ---- 数据读取 -------------------------------------------------------
    const summaryUrl = (): string =>
      `${API}/summary?${range === 'all' ? 'range=all' : `days=${range}`}&top=${TOP}`

    const detailRangeKey = (): string => {
      const to = beijingDayKey(Date.now())
      if (range === 'all') return `${summary?.days[0]?.date ?? to}..${to}`
      return `${shiftDayKey(range - 1)}..${to}`
    }

    const loadSummary = async (): Promise<void> => {
      try {
        const response = await fetch(summaryUrl(), { headers: { accept: 'application/json' } })
        const data = (await response.json()) as Summary
        if (disposed) return
        if (data.ok !== true) {
          status.textContent = '统计数据不可用'
          return
        }
        summary = data
        // 选中的日期若已不在当前窗口内，自动取消选择。
        if (selectedDate !== null && !data.days.some((day) => day.date === selectedDate)) selectedDate = null
        paint()
      } catch (error) {
        if (!disposed) status.textContent = `加载失败：${String(error)}`
      }
    }

    const loadDetails = async (force: boolean): Promise<void> => {
      const key = detailRangeKey()
      if (!force && key === detailsKey && Date.now() - lastDetailAt < DETAIL_TTL_MS) return
      const [from, to] = key.split('..')
      try {
        const response = await fetch(`${API}/days?from=${from}&to=${to}`, { headers: { accept: 'application/json' } })
        const data = (await response.json()) as { ok?: boolean; days?: DayDetail[] }
        if (disposed) return
        if (data.ok !== true) {
          detailError = '明细接口返回异常'
          return
        }
        details.clear()
        for (const day of data.days ?? []) details.set(day.date, day)
        detailsKey = key
        lastDetailAt = Date.now()
        detailError = ''
      } catch (error) {
        detailError = String(error)
      }
    }

    // ---- 聚合 -----------------------------------------------------------
    /** 当前视角覆盖的日期集合：选中单日，或当前窗口内有数据的全部日期。 */
    const scopeDates = (): string[] => {
      if (selectedDate !== null) return [selectedDate]
      return (summary?.days ?? []).map((day) => day.date)
    }

    /** 当前视角的用量合计。 */
    const scopeUsage = (): { usage: Usage; toolCalls: number; modelCalls: number; turns: number; steps: number; sessions: number } => {
      if (selectedDate === null) {
        const totals = summary?.totals
        return {
          usage: totals ?? emptyUsage(),
          toolCalls: totals?.toolCalls ?? 0,
          modelCalls: 0,
          turns: totals?.turns ?? 0,
          steps: totals?.steps ?? 0,
          sessions: totals?.sessions ?? 0,
        }
      }
      const day = summary?.days.find((item) => item.date === selectedDate)
      const usage = emptyUsage()
      if (day !== undefined) addUsage(usage, day)
      return {
        usage,
        toolCalls: day?.toolCalls ?? 0,
        modelCalls: day?.modelCalls ?? 0,
        turns: 0,
        steps: 0,
        sessions: details.get(selectedDate)?.sessions.length ?? 0,
      }
    }

    /** 聚合当前视角的模型 / 工具 / 会话。 */
    const aggregate = (kind: PieMode): Agg[] => {
      const map = new Map<string, Agg>()
      for (const date of scopeDates()) {
        const detail = details.get(date)
        if (detail === undefined) continue
        if (kind === 'models') {
          for (const item of detail.models) {
            const cur = map.get(item.model) ?? { key: item.model, label: item.model, usage: emptyUsage(), calls: 0, ms: 0 }
            addUsage(cur.usage, item)
            cur.calls += item.calls
            map.set(item.model, cur)
          }
        } else if (kind === 'tools') {
          for (const item of detail.tools) {
            const cur = map.get(item.name) ?? { key: item.name, label: item.name, usage: emptyUsage(), calls: 0, ms: 0 }
            cur.calls += item.calls
            cur.ms += item.ms
            map.set(item.name, cur)
          }
        } else {
          for (const item of detail.sessions) {
            const label = item.title !== null && item.title !== '' ? item.title : item.id.slice(0, 12)
            const cur = map.get(item.id) ?? { key: item.id, label, usage: emptyUsage(), calls: 0, ms: 0 }
            addUsage(cur.usage, item.usage)
            cur.calls += 1
            map.set(item.id, cur)
          }
        }
      }
      const list = [...map.values()]
      if (kind === 'tools') list.sort((left, right) => right.calls - left.calls || right.ms - left.ms)
      else list.sort((left, right) => right.usage.costCny - left.usage.costCny)
      return list
    }

    /** 把聚合项切成饼图切片（含「其他」归并）与图例。 */
    const toSlices = (items: Agg[], kind: PieMode): Slice[] => {
      const valueOf = (item: Agg): number => (kind === 'tools' ? item.calls : item.usage.costCny)
      const top = kind === 'tools' ? PIE_TOP_TOOLS : PIE_TOP_SESSIONS
      const head = items.slice(0, kind === 'models' ? items.length : top)
      const rest = items.slice(head.length)
      const slices: Slice[] = head.map((item, index) => ({
        key: item.key,
        label: item.label,
        value: valueOf(item),
        color: paletteColor(index),
        detail: kind === 'tools' ? fmtDuration(item.ms) : fmtCost(item.usage.costCny),
      }))
      if (rest.length > 0) {
        const value = rest.reduce((sum, item) => sum + valueOf(item), 0)
        const ms = rest.reduce((sum, item) => sum + item.ms, 0)
        slices.push({
          key: '__other__',
          label: `其他 ${rest.length} 项`,
          value,
          color: OTHER_COLOR,
          detail: kind === 'tools' ? fmtDuration(ms) : fmtCost(rest.reduce((sum, item) => sum + item.usage.costCny, 0)),
        })
      }
      return slices.filter((slice) => slice.value > 0)
    }

    /** 当前维度的完整切片（含被图例隐藏的项，供环心占比计算）。 */
    const allSlices = (): Slice[] => {
      if (pieMode === 'tokens') {
        const usage = scopeUsage().usage
        return [
          { key: 'uncachedInputTokens', label: '未缓存输入', value: usage.uncachedInputTokens, color: BUCKET_COLORS.uncachedInputTokens },
          { key: 'cacheReadTokens', label: '缓存读取', value: usage.cacheReadTokens, color: BUCKET_COLORS.cacheReadTokens },
          { key: 'cacheWriteTokens', label: '缓存写入', value: usage.cacheWriteTokens, color: BUCKET_COLORS.cacheWriteTokens },
          { key: 'outputTokens', label: '输出（含思维链）', value: usage.outputTokens, color: BUCKET_COLORS.outputTokens },
        ].filter((slice) => slice.value > 0)
      }
      return toSlices(aggregate(pieMode), pieMode)
    }

    /** 应用图例开关后的切片（真正参与绘制）。 */
    const currentSlices = (): Slice[] => {
      const off = hidden.get(pieMode)
      if (off === undefined || off.size === 0) return allSlices()
      return allSlices().filter((slice) => !off.has(slice.key))
    }

    /** 扇区副文本（按维度换单位）。 */
    const sliceDetailText = (slice: Slice, total: number): string => {
      if (pieMode === 'tools') return `${fmtInt(slice.value)} 次${slice.detail !== undefined ? ` · ${slice.detail}` : ''}`
      if (pieMode === 'tokens') return fmtTokens(slice.value)
      return `${fmtCost(slice.value)}${slice.detail !== undefined ? ` · ${slice.detail}` : ''}`
    }

    // ---- 渲染 -----------------------------------------------------------
    const paintRangeButtons = (): void => {
      for (const [key, button] of rangeButtons) button.classList.toggle('on', key === range)
      for (const [key, button] of modeButtons) button.classList.toggle('on', key === pieMode)
      chip.style.display = selectedDate === null ? 'none' : 'inline-flex'
      chipLabel.textContent = selectedDate ?? ''
    }

    const scopeLabel = (): string => (selectedDate !== null ? selectedDate : range === 'all' ? '全部时间' : `近 ${range} 天`)

    const paintCards = (): void => {
      const scope = scopeUsage()
      const tokens = usageTokens(scope.usage)
      cardTokens.value.textContent = fmtTokens(tokens)
      cardTokens.value.title = `${fmtInt(tokens)} tokens`
      cardTokens.sub.textContent = selectedDate === null
        ? `未缓存 ${fmtTokens(scope.usage.uncachedInputTokens)} · 缓存读 ${fmtTokens(scope.usage.cacheReadTokens)}`
        : `模型调用 ${fmtInt(scope.modelCalls)} 次`
      cardCost.value.textContent = fmtCost(scope.usage.costCny)
      cardCost.value.title = `¥${scope.usage.costCny}`
      cardCost.sub.textContent = '按峰谷时段估算，以账单为准'
      cardSessions.value.textContent = selectedDate === null
        ? `${fmtInt(scope.sessions)} / ${fmtInt(scope.turns)}`
        : `${fmtInt(scope.sessions)} 个对话`
      cardSessions.sub.textContent = selectedDate === null ? `步数 ${fmtInt(scope.steps)}` : '当日参与的对话数'
      cardTools.value.textContent = fmtInt(scope.toolCalls)
      cardTools.sub.textContent = selectedDate === null ? `${fmtInt(summary?.toolKinds ?? 0)} 种工具` : '当日工具调用'
      for (const card of [cardTokens, cardCost, cardSessions, cardTools]) {
        card.label.title = scopeLabel()
      }
    }

    const paintBuckets = (): void => {
      const usage = scopeUsage().usage
      const total = usageTokens(usage)
      const peak = Math.max(usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens, 1)
      bucketTitle.textContent = `token 构成 · ${scopeLabel()}`
      for (const row of bucketRows) {
        const value = usage[row.key]
        row.fill.style.width = `${Math.max(value > 0 ? 1.5 : 0, (value / peak) * 100)}%`
        row.value.textContent = `${fmtTokens(value)} (${fmtPercent(total > 0 ? value / total : 0)})`
        row.value.title = fmtInt(value)
      }
    }

    const paintTools = (): void => {
      const detail = selectedDate !== null ? details.get(selectedDate) : undefined
      const rows: ToolRow[] = selectedDate !== null
        ? (detail?.tools ?? []).slice(0, TOP).map((item) => {
            const totalCalls = (detail?.tools ?? []).reduce((sum, tool) => sum + tool.calls, 0)
            return { name: item.name, calls: item.calls, ms: item.ms, share: totalCalls > 0 ? item.calls / totalCalls : 0 }
          })
        : (summary?.tools ?? [])
      toolsSection.title.textContent = `工具调用排行 · ${scopeLabel()}`
      toolsSection.body.textContent = ''
      if (rows.length === 0) {
        toolsSection.empty.style.display = 'block'
        toolsSection.table.style.display = 'none'
        return
      }
      toolsSection.empty.style.display = 'none'
      toolsSection.table.style.display = 'table'
      for (const tool of rows) {
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
        toolsSection.body.append(tr)
      }
    }

    const paintModels = (): void => {
      const detail = selectedDate !== null ? details.get(selectedDate) : undefined
      const rows: ModelRow[] = selectedDate !== null
        ? [...(detail?.models ?? [])].sort((left, right) => right.costCny - left.costCny)
        : (summary?.models ?? [])
      modelsSection.title.textContent = `按模型 · ${scopeLabel()}`
      modelsSection.body.textContent = ''
      if (rows.length === 0) {
        modelsSection.empty.style.display = 'block'
        modelsSection.table.style.display = 'none'
        return
      }
      modelsSection.empty.style.display = 'none'
      modelsSection.table.style.display = 'table'
      for (const row of rows) {
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
        modelsSection.body.append(tr)
      }
    }

    const paintSessions = (): void => {
      const detail = selectedDate !== null ? details.get(selectedDate) : undefined
      sessionsSection.title.textContent = `最贵的对话 · ${scopeLabel()}`
      sessionsSection.body.textContent = ''
      const rows: Array<{ label: string; tip: string; createdAt: number; tokens: number; cost: number }> =
        selectedDate !== null
          ? [...(detail?.sessions ?? [])]
              .sort((left, right) => right.usage.costCny - left.usage.costCny)
              .map((item) => ({
                label: item.title !== null && item.title !== '' ? item.title : item.id.slice(0, 12),
                tip: [item.title ?? '(无标题)', item.id, item.origin === 'subagent' ? '子代理会话' : '主会话'].join('\n'),
                createdAt: 0,
                tokens: usageTokens(item.usage),
                cost: item.usage.costCny,
              }))
          : (summary?.sessions ?? []).map((row) => ({
              label: row.title !== null && row.title !== '' ? row.title : `${row.cwd.split(/[\\/]/).pop() ?? ''} / ${row.id.slice(0, 8)}`,
              tip: [
                row.title ?? '(无标题)',
                row.id,
                row.cwd,
                `${row.origin === 'subagent' ? '子代理会话' : '主会话'} · 模型调用 ${fmtInt(row.modelCalls)} 次 · 工具 ${fmtInt(row.toolCalls)} 次`,
              ].join('\n'),
              createdAt: row.createdAt,
              tokens: usageTokens(row.usage),
              cost: row.usage.costCny,
            }))
      if (rows.length === 0) {
        sessionsSection.empty.style.display = 'block'
        sessionsSection.table.style.display = 'none'
        return
      }
      sessionsSection.empty.style.display = 'none'
      sessionsSection.table.style.display = 'table'
      for (const row of rows) {
        const tr = el('tr')
        const name = el('td', 'name', row.label)
        name.title = row.tip
        const when = el('td', 'num', row.createdAt > 0 ? fmtDateTime(row.createdAt).slice(0, 10) : '—')
        const tokens = el('td', 'num', fmtTokens(row.tokens))
        tokens.title = fmtInt(row.tokens)
        const cost = el('td', 'num', fmtCost(row.cost))
        cost.title = `¥${row.cost}`
        tr.append(name, when, tokens, cost)
        sessionsSection.body.append(tr)
      }
    }

    const paintTrend = (): void => {
      const days = summary?.days ?? []
      const todayKey = beijingDayKey(Date.now())
      const barsData: Bar[] = days.map((day) => {
        const tokens = usageTokens(day)
        return {
          key: day.date,
          value: tokens,
          today: day.date === todayKey,
          tooltip: `${day.date}\n${fmtInt(tokens)} tokens（${fmtTokens(tokens)}）\n${fmtCost(day.costCny)} · 工具 ${fmtInt(day.toolCalls)} 次 · 模型 ${fmtInt(day.modelCalls)} 次\n点击查看当天明细`,
        }
      })
      bars.update(barsData, selectedDate, labelStep(days.length))
      const sum = days.reduce((acc, day) => acc + usageTokens(day), 0)
      const cost = days.reduce((acc, day) => acc + day.costCny, 0)
      const window = range === 'all' ? '全部时间' : `近 ${range} 天`
      trendTitle.textContent = `用量趋势 · ${window}（点柱子选中某天，再点取消）`
      trendSub.textContent = `窗口合计 ${fmtInt(sum)} tokens（${fmtTokens(sum)}） · ${fmtCost(cost)}`
    }

    const paintPie = (): void => {
      const slices = currentSlices()
      const off = hidden.get(pieMode)
      for (const [key, button] of modeButtons) button.classList.toggle('on', key === pieMode)
      pieTitle.textContent = `构成分析 · ${scopeLabel()}`
      pieSub.textContent =
        pieMode === 'tokens'
          ? '按四桶拆分（互斥计数：billed input = 未缓存 + 缓存读 + 缓存写）'
          : pieMode === 'models'
            ? '按估算费用降序；点图例可隐藏某一项'
            : pieMode === 'tools'
              ? `按调用次数降序，取前 ${PIE_TOP_TOOLS} 项，其余归入「其他」`
              : `按费用降序，取前 ${PIE_TOP_SESSIONS} 个对话，其余归入「其他」`
      donut.update(slices, pieMode === 'tokens' ? '合计' : '当前视角', fmtTokens(slices.reduce((sum, slice) => sum + slice.value, 0)))
      paintPieCenter()
      legend.textContent = ''
      if (slices.length === 0) {
        const loading = detailError === '' && details.size === 0
        legend.append(el('li', 'dus-empty', loading ? '明细加载中…' : '当前视角暂无数据'))
        return
      }
      for (const slice of slices) {
        const item = el('li', off?.has(slice.key) === true ? 'off' : undefined)
        const swatch = el('span', 'sw')
        swatch.style.background = slice.color
        const name = el('span', 'nm', slice.label)
        name.title = slice.label
        const value =
          pieMode === 'tools'
            ? `${fmtInt(slice.value)} 次`
            : pieMode === 'tokens'
              ? fmtTokens(slice.value)
              : fmtCost(slice.value)
        const valueNode = el('span', 'vl', value)
        item.append(swatch, name, valueNode)
        item.title = `${slice.label}\n${value}${slice.detail !== undefined ? ` · ${slice.detail}` : ''}`
        item.addEventListener('click', () => {
          const set = hidden.get(pieMode) ?? new Set<string>()
          if (set.has(slice.key)) set.delete(slice.key)
          else set.add(slice.key)
          hidden.set(pieMode, set)
          paintPie()
        })
        legend.append(item)
      }
    }

    /** 环心默认文本（hover 时由回调临时覆盖）。 */
    const paintPieCenter = (): void => {
      const slices = currentSlices()
      const total = slices.reduce((sum, slice) => sum + slice.value, 0)
      const label = pieMode === 'tokens' ? 'tokens 合计' : pieMode === 'tools' ? '调用合计' : '费用合计'
      const value = pieMode === 'tools' ? `${fmtInt(total)} 次` : pieMode === 'tokens' ? fmtTokens(total) : fmtCost(total)
      donut.setCenter(label, value)
    }

    const paintStatus = (): void => {
      const meta = summary?.meta
      const backfill = summary?.backfill
      const progress =
        backfill === undefined
          ? ''
          : backfill.running
            ? ` · 回填中 ${fmtInt(backfill.scanned)}/${fmtInt(backfill.total)}`
            : backfill.done
              ? ` · 已回填 ${fmtInt(backfill.scanned)}/${fmtInt(backfill.total)}`
              : ''
      const time = summary === null ? '' : ` · 更新于 ${new Date(summary.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
      status.textContent = `${meta?.persistenceAvailable === true ? '持久化服务可用' : '持久化服务不可用（仅统计本次启动）'}${progress}${time}`
      status.title = meta === undefined ? '' : `账本：${meta.ledgerFile}`

      const messages: string[] = []
      if (meta?.persistenceAvailable === false) messages.push('未找到会话持久化服务，历史回填不可用。')
      if (meta !== undefined && meta.writeError !== null) messages.push(`账本写入失败（统计仅在内存中）：${meta.writeError}`)
      if (backfill !== undefined && backfill.errors > 0) messages.push(`${backfill.errors} 个会话读取失败，已跳过。`)
      if (detailError !== '') messages.push(`按天明细刷新失败：${detailError}`)
      if (meta?.detailMissing === true) {
        warn.textContent = `${messages.join(' ')} 按天明细缺失（升级后新增维度，历史不会自动补算）—— 点「重建统计」补全。`.trim()
        warn.style.display = 'block'
        return
      }
      warn.textContent = messages.join(' ')
      warn.style.display = messages.length > 0 ? 'block' : 'none'
    }

    /** 全量重绘（数据或交互状态变化时调用）。 */
    const paint = (): void => {
      if (summary === null) return
      paintRangeButtons()
      paintCards()
      paintBuckets()
      paintTools()
      paintModels()
      paintSessions()
      paintTrend()
      paintPie()
      paintStatus()
    }

    // ---- 操作按钮 -------------------------------------------------------
    const scan = (button: HTMLButtonElement, label: string, rebuild: boolean): void => {
      button.disabled = true
      button.textContent = '扫描中…'
      void fetch(`${API}/rescan${rebuild ? '?rebuild=1' : ''}`, { method: 'POST' })
        .then((response) => response.json())
        .then(() => {
          if (rebuild) {
            details.clear()
            detailsKey = ''
            selectedDate = null
          }
          return loadSummary().then(() => loadDetails(true)).then(() => paint())
        })
        .catch((error: unknown) => {
          status.textContent = `扫描失败：${String(error)}`
        })
        .finally(() => {
          button.disabled = false
          button.textContent = label
        })
    }
    refreshButton.addEventListener('click', () => {
      void loadSummary().then(() => loadDetails(true)).then(() => paint())
    })
    rescanButton.addEventListener('click', () => scan(rescanButton, '增量扫描', false))
    rebuildButton.addEventListener('click', () => scan(rebuildButton, '重建统计', true))

    // ---- 启动 -----------------------------------------------------------
    void loadSummary().then(() => loadDetails(true)).then(() => paint())
    pollTimer = window.setInterval(() => {
      void loadSummary().then(() => loadDetails(false)).then(() => paint())
    }, POLL_MS)

    return () => {
      disposed = true
      if (pollTimer !== 0) window.clearInterval(pollTimer)
      bars.dispose()
      donut.dispose()
    }
  }, [])

  return React.createElement('div', { ref: hostRef })
}

/**
 * 注册设置页分区。
 * @param ctx - client 上下文（含 slots 服务）。
 */
export function apply(ctx: {
  slots: {
    inject(name: string, callback: () => unknown): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  effect(callback: () => unknown, label?: string): () => void
}): void {
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
