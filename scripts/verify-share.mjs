/**
 * 分享可行性自检：把插件目录当成「别人 clone / 拷过去拿到的东西」，在**没有 node_modules、
 * 没有 DSH 源码检出**的裸 node 进程里验证它能不能真的跑起来。
 *
 * 用法：
 *   node scripts/verify-share.mjs [插件目录] [旧版产物目录]
 *   - 插件目录缺省为本仓库根目录；也可指向 `git clone` 到别处的副本
 *   - 旧版产物目录可选：给了就做 A/B，演示「client 未声明 inject」会怎样激活失败
 *
 * 覆盖的检查（每一条都对应一类「别人机器上才暴露」的分享故障）：
 *   1. host 模块在零依赖环境能否 import，导出契约是否完整
 *   2. apply() 挂载 + 实时折叠 + /summary /days /rescan 是否真的可用
 *   3. 路由鉴权围栏（无 connection 服务时降级为本地 Host/Origin 围栏）
 *   4. 单价覆盖文件生效、未收录模型被显式暴露
 *   5. client bundle 能否被前端 ModuleLoader 装载，并声明 inject = ['slots']
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TARGET = path.resolve(process.argv[2] ?? path.join(HERE, '..'))
const OLD_DIR = process.argv[3] === undefined ? '' : path.resolve(process.argv[3])

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  → ${detail}`}`)
  if (!ok) fails.push(label)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const makeHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))

/** 桩 persistence：list / open(id,'read').read(offset,length)。 */
function makePersistence(events) {
  return {
    async list() {
      return [{ id: 'S1', header: { cwd: 'C:/demo', createdAt: 1, origin: 'root' } }]
    },
    async open() {
      return {
        async read(offset = 0, length = 2000) {
          return { events: events.slice(offset, offset + length) }
        },
        async close() {},
      }
    },
  }
}

/** 桩 cordis ctx：只实现插件真正用到的面；**故意不给 connection**，验证降级围栏。 */
function makeCtx(warnings, persistence) {
  const routes = []
  const listeners = new Map()
  return {
    routes,
    listeners,
    get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
    on: (event, fn) => {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    logger: { info: () => {}, warn: (m) => warnings.push(String(m)) },
  }
}

/** 直接调路由 handler，返回 { status, body }。 */
function callRoute(ctx, { url, method = 'GET', headers }) {
  return new Promise((resolve, reject) => {
    const route = ctx.routes.find((r) => r.kind === 'prefix')
    if (route === undefined) {
      reject(new Error('插件没有注册路由'))
      return
    }
    let status = 0
    const res = {
      writeHead(code) {
        status = code
      },
      end(chunk) {
        resolve({ status, body: JSON.parse(String(chunk ?? '')) })
      },
    }
    route.handler({ url, method, headers }, res)
  })
}

const SAME_ORIGIN = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' }

/** 合成实时事件：3 次工具调用（含结果）、2 步 2 轮、3 条模型消息（含 1 个未收录模型）。 */
function liveEvents() {
  const t = Date.UTC(2026, 9, 8, 2, 0, 0)
  const list = [
    { type: 'tool/call', data: { name: 'edit', callId: 'a1' } },
    { type: 'tool/call', data: { name: 'pwsh', callId: 'a2' } },
    { type: 'tool/call', data: { name: 'read', callId: 'a3' } },
    { type: 'tool/result', data: { message: { source: { callId: 'a1' } } } },
    { type: 'tool/result', data: { message: { source: { callId: 'a2' } } } },
    { type: 'tool/result', data: { message: { source: { callId: 'a3' } } } },
    { type: 'step/end', data: { turn: 1 } },
    { type: 'step/end', data: { turn: 2 } },
    { type: 'assistant/message', data: { message: { source: { model: 'deepseek-flash' } }, usage: { inputTokens: 1000, cacheReadTokens: 90_000, cacheWriteTokens: 0, outputTokens: 500 } } },
    { type: 'assistant/message', data: { message: { source: { model: 'deepseek-v4-pro' } }, usage: { inputTokens: 2000, cacheReadTokens: 50_000, cacheWriteTokens: 0, outputTokens: 800 } } },
    { type: 'assistant/message', data: { message: { source: { model: 'gpt-5' } }, usage: { inputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 } } },
  ]
  return list.map((event, seq) => ({ seq, time: t + seq * 1000, ...event }))
}

const REACT_STUB = new Proxy({}, { get: () => () => null })

/** 在与前端 ModuleLoader 等价的沙箱里装载 client bundle，返回模块导出。 */
function loadClientBundle(source) {
  let spec = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          spec = value
        },
      },
    },
    require: (id) => (id === 'react' || id === 'react/jsx-runtime' ? REACT_STUB : {}),
    console,
    process: { env: {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return { spec, module: spec === null ? null : spec.factory(sandbox.require) }
}

/** 模拟 loader：只为模块**声明过**的服务提供 ctx（声明了 slots 才有 ctx.slots）。 */
function applyAsLoader(clientModule) {
  const declared = Array.isArray(clientModule.inject) ? clientModule.inject : []
  const registered = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  if (declared.includes('slots')) {
    ctx.slots = {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: (options) => {
        registered.push(options)
        return () => {}
      },
    }
  }
  try {
    clientModule.apply(ctx)
    return { ok: true, registered }
  } catch (error) {
    return { ok: false, error: String(error), registered }
  }
}

// ─────────────────────────────────────────────────────────────
console.log(`插件目录：${TARGET}`)
console.log(`lib/ 是否随包提供：${fs.existsSync(path.join(TARGET, 'lib/index.js'))}（分享时必须是 true，否则对方要先自行构建）`)

console.log('\n[1] 裸进程加载 host 模块（零 node_modules / 零 DSH 依赖）')
const mod = await import(pathToFileURL(path.join(TARGET, 'lib/index.js')).href)
check('导出 apply / name / inject', typeof mod.apply === 'function' && typeof mod.name === 'string' && Array.isArray(mod.inject),
  `name=${mod.name} inject=${JSON.stringify(mod.inject)}`)

console.log('\n[2] apply() 挂载 + 实时折叠 + HTTP 接口（无 connection 服务 → 本地围栏降级）')
const home1 = makeHome()
process.env.DSH_HOME = home1
const events = liveEvents()
const warnings = []
const ctx = makeCtx(warnings, makePersistence(events))
mod.apply(ctx)
check('注册了 /dsh-usage-stats/api 路由', ctx.routes.length === 1 && ctx.routes[0].path === '/dsh-usage-stats/api')
check('监听了 session/event', ctx.listeners.has('session/event'))

const emit = ctx.listeners.get('session/event')
for (const event of events) emit({ id: 'S1' }, event)

const summary = await callRoute(ctx, { url: '/dsh-usage-stats/api/summary?days=14&top=5', headers: SAME_ORIGIN })
check('GET /summary 同源 → 200', summary.status === 200, `status=${summary.status}`)
check('工具调用 = 3', summary.body.totals.toolCalls === 3, `实际 ${summary.body.totals.toolCalls}`)
check('轮次 = 2、步数 = 2', summary.body.totals.turns === 2 && summary.body.totals.steps === 2,
  `轮次 ${summary.body.totals.turns} / 步数 ${summary.body.totals.steps}`)
check('费用被算出（> 0）', summary.body.totals.costCny > 0, `¥${summary.body.totals.costCny.toFixed(4)}`)
const models = summary.body.models.map((row) => row.model).sort()
check('三个模型都记账', models.join(',') === 'deepseek-flash,deepseek-v4-pro,gpt-5', models.join(','))
check('未收录模型被显式暴露', JSON.stringify(summary.body.meta.unpricedModels) === '["gpt-5"]',
  JSON.stringify(summary.body.meta.unpricedModels))
check('账本落在 DSH_HOME 内', summary.body.meta.ledgerFile.startsWith(home1), summary.body.meta.ledgerFile)

const cross = await callRoute(ctx, { url: '/dsh-usage-stats/api/summary', headers: { ...SAME_ORIGIN, origin: 'http://evil.example' } })
check('跨站 Origin → 403', cross.status === 403, `status=${cross.status}`)
const noHost = await callRoute(ctx, { url: '/dsh-usage-stats/api/summary', headers: {} })
check('无 Host 头 → 403（防 DNS rebinding）', noHost.status === 403, `status=${noHost.status}`)
const rebuild = await callRoute(ctx, {
  url: '/dsh-usage-stats/api/rescan?rebuild=1',
  method: 'POST',
  headers: { ...SAME_ORIGIN, origin: 'http://evil.example' },
})
check('跨站 POST /rescan?rebuild=1 → 403', rebuild.status === 403, `status=${rebuild.status}`)
const rescan = await callRoute(ctx, { url: '/dsh-usage-stats/api/rescan', method: 'POST', headers: SAME_ORIGIN })
check('同源 POST /rescan → 200', rescan.status === 200 && rescan.body.ok === true, `status=${rescan.status}`)

await sleep(400)
const ledgerFile = path.join(home1, '.dsh-usage-stats.json')
check('账本已实际落盘', fs.existsSync(ledgerFile), ledgerFile)
if (fs.existsSync(ledgerFile)) {
  const disk = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
  check('落盘账本含 1 个会话', Object.keys(disk.sessions).length === 1, `sessions=${Object.keys(disk.sessions).length}`)
}
check('运行期无异常告警', warnings.filter((w) => !w.includes('补齐')).length === 0, warnings.join(' | ') || '（无）')

console.log('\n[3] 单价覆盖文件：不改代码就能接自己的渠道价')
const home2 = makeHome()
fs.writeFileSync(
  path.join(home2, '.dsh-usage-stats.prices.json'),
  JSON.stringify({ 'gpt-5': { hit: [1, 2], miss: [10, 20], out: [30, 60] } }),
  'utf8',
)
process.env.DSH_HOME = home2
const warnings2 = []
const ctx2 = makeCtx(warnings2, makePersistence(events))
mod.apply(ctx2)
for (const event of events) ctx2.listeners.get('session/event')({ id: 'S1' }, event)
const summary2 = await callRoute(ctx2, { url: '/dsh-usage-stats/api/summary', headers: SAME_ORIGIN })
check('覆盖规则数 = 1', summary2.body.meta.priceOverrides === 1, `实际 ${summary2.body.meta.priceOverrides}`)
check('gpt-5 不再是「未收录」', JSON.stringify(summary2.body.meta.unpricedModels) === '[]',
  JSON.stringify(summary2.body.meta.unpricedModels))
check('覆盖后费用高于内置兜底', summary2.body.totals.costCny > summary.body.totals.costCny,
  `覆盖 ¥${summary2.body.totals.costCny.toFixed(4)} vs 兜底 ¥${summary.body.totals.costCny.toFixed(4)}`)

console.log('\n[4] client bundle 能否被前端 ModuleLoader 装载（面板激活的前提）')
const { spec, module: clientModule } = loadClientBundle(fs.readFileSync(path.join(TARGET, 'lib/client.js'), 'utf8'))
check('投递了 ModuleLoader envelope', spec !== null && typeof spec.factory === 'function',
  spec === null ? '未调用 load()' : `id=${spec.id}`)
check('id 与包名一致', spec !== null && spec.id === '@dsh-external/dsh-usage-stats', spec?.id)
check("client 声明 inject = ['slots']（缺了它前端整页报 entry did not activate）",
  JSON.stringify(clientModule.inject) === '["slots"]', JSON.stringify(clientModule.inject))
check('client 导出 apply', typeof clientModule.apply === 'function')
check('host 声明 inject = [webServer]', JSON.stringify(mod.inject) === '["webServer"]', JSON.stringify(mod.inject))
check('client bundle 保留 register({ 字面形态（注入器预检用）',
  /register\(\{/.test(fs.readFileSync(path.join(TARGET, 'lib/client.js'), 'utf8')))

console.log('\n[5] A/B 对比：未声明 inject 的旧版 client 会激活失败')
if (OLD_DIR === '' || !fs.existsSync(path.join(OLD_DIR, 'lib/client.js'))) {
  console.log('  SKIP  未提供旧版产物目录（第二个参数）')
} else {
  const oldModule = loadClientBundle(fs.readFileSync(path.join(OLD_DIR, 'lib/client.js'), 'utf8')).module
  const oldRun = applyAsLoader(oldModule)
  check('旧版：未声明 inject → apply() 抛错（= 前端 entry did not activate）',
    oldRun.ok === false, oldRun.ok ? '竟然没抛错' : oldRun.error)
  const newRun = applyAsLoader(clientModule)
  check('新版：正常注册 settings.section', newRun.ok === true && newRun.registered.length === 1,
    newRun.ok ? `id=${newRun.registered[0]?.id} label=${newRun.registered[0]?.label?.()}` : newRun.error)
}

console.log(`\n===== 结果：${fails.length === 0 ? '全部通过 ✅（这份产物可以直接分享）' : `${fails.length} 项失败 ❌`} =====`)
if (fails.length > 0) console.log(fails.map((item) => ` - ${item}`).join('\n'))
process.exitCode = fails.length === 0 ? 0 : 1
