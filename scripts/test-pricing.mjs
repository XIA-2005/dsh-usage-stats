/**
 * 计费口径回归：把官方价格表与峰谷日历钉死，防止再次抄错价或漏掉法定节假日。
 *
 * 官方来源：
 * - 价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *   （deepseek-flash 命中 0.02/0.04、未命中 1/2、输出 4/8；
 *    deepseek-v4-pro 命中 0.15/0.30、未命中 4.5/9、输出 13.5/27；空闲价 = 高峰价的一半）
 * - 节假日：国务院办公厅《关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）
 *
 * 用法：node scripts/test-pricing.mjs（先 npm run build:host）
 */

import { costOf, isPeak, resolvePrice } from '../lib/pricing.js'

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  → ${detail}`}`)
  if (!ok) fails.push(label)
}

/** 北京时间的某个时刻 → epoch 毫秒（偏移 8 小时后用 UTC 构造）。 */
const beijing = (y, m, d, hour, minute = 0) => Date.UTC(y, m - 1, d, hour - 8, minute)

/** 一组官方单价：单位 CNY / 百万 token，[空闲时段, 高峰时段]。 */
const table = (hit, miss, out) => JSON.stringify({ hit, miss, out })

console.log('[1] 官方价表逐行核对（CNY / 百万 token，[空闲, 高峰]）')
const FLASH = table([0.02, 0.04], [1, 2], [4, 8])
const PRO = table([0.15, 0.3], [4.5, 9], [13.5, 27])
const cases = [
  ['deepseek-flash', FLASH, 'deepseek-flash'],
  ['deepseek-v4-flash', FLASH, 'deepseek-v4-flash'],
  ['deepseek-v4-flash-vision-exp', FLASH, 'deepseek-v4-flash-vision-exp'],
  ['apigoto/deepseek-flash', FLASH, 'deepseek-flash'],
  ['DeepSeek-Flash', FLASH, 'deepseek-flash'],
  ['deepseek-v4-pro', PRO, 'deepseek-v4-pro'],
  ['deepseek-pro', PRO, 'deepseek-pro'],
]
for (const [model, expected, rule] of cases) {
  const got = resolvePrice(model)
  check(`${model.padEnd(28)} 命中 ${rule}`, JSON.stringify(got.table) === expected && got.rule === rule,
    `rule=${got.rule} table=${JSON.stringify(got.table)}`)
}

console.log('\n[2] 未收录 / 已下架的历史模型必须显式暴露（不给假数字）')
for (const model of ['gpt-5', 'claude-opus', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-v3', 'deepseek-r1', '(unknown)', '']) {
  const got = resolvePrice(model)
  check(`${JSON.stringify(model).padEnd(22)} rule = null`, got.rule === null, `rule=${got.rule}`)
}

console.log('\n[3] 空闲价 = 高峰价的一半（官方声明，逐行自检）')
for (const [model, expected] of [['deepseek-flash', JSON.parse(FLASH)], ['deepseek-v4-pro', JSON.parse(PRO)]]) {
  const t = resolvePrice(model).table
  const half = t.hit[0] * 2 === t.hit[1] && t.miss[0] * 2 === t.miss[1] && t.out[0] * 2 === t.out[1]
  check(`${model} 三档都满足 空闲×2 = 高峰`, half, JSON.stringify(t))
  check(`${model} 与官方数字一致`, JSON.stringify(t) === JSON.stringify(expected))
}

console.log('\n[4] 峰谷日历（高峰 = 周一至周五、非节假日、9–12 / 14–18 点）')
const calendar = [
  ['2026-10-08 周四 10:00（普通工作日上班时段）', beijing(2026, 10, 8, 10), true],
  ['2026-10-08 周四 12:30（午休）', beijing(2026, 10, 8, 12, 30), false],
  ['2026-10-08 周四 14:30（下午峰时）', beijing(2026, 10, 8, 14, 30), true],
  ['2026-10-08 周四 19:00（下班后）', beijing(2026, 10, 8, 19), false],
  ['2026-10-05 周一 10:00（国庆假期中的工作日 → 空闲）', beijing(2026, 10, 5, 10), false],
  ['2026-10-01 周四 10:00（国庆首日 → 空闲）', beijing(2026, 10, 1, 10), false],
  ['2026-10-08 周四 10:00（假期后首个工作日 → 高峰）', beijing(2026, 10, 8, 10), true],
  ['2026-10-10 周六 10:00（调休上班日，按官方措辞仍空闲）', beijing(2026, 10, 10, 10), false],
  ['2026-09-25 周五 10:00（中秋假期 → 空闲）', beijing(2026, 9, 25, 10), false],
  ['2026-09-24 周四 10:00（中秋前一日 → 高峰）', beijing(2026, 9, 24, 10), true],
  ['2026-09-19 周六 10:00（普通周末 → 空闲）', beijing(2026, 9, 19, 10), false],
  ['2026-02-17 周二 10:00（春节假期 → 空闲）', beijing(2026, 2, 17, 10), false],
  ['2026-05-04 周一 10:00（劳动节假期 → 空闲）', beijing(2026, 5, 4, 10), false],
  ['2026-08-15 周六 10:00（2026-08-23 之前的周末，按当时规则 → 高峰）', beijing(2026, 8, 15, 10), true],
  ['2026-08-29 周六 10:00（2026-08-23 起周末转空闲）', beijing(2026, 8, 29, 10), false],
  ['非有限时间戳（按空闲处理）', Number.NaN, false],
]
for (const [label, ms, expected] of calendar) {
  const got = isPeak(ms)
  check(label, got === expected, `isPeak=${got} 期望 ${expected}`)
}

console.log('\n[5] 费用算例（每百万 token，空闲时段）')
const usage = (cacheRead, miss, out) => ({ inputTokens: miss, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: out })
const valley = beijing(2026, 10, 8, 10) // 注意：10-08 10:00 是高峰，算例用峰谷各算一次
const offpeak = beijing(2026, 10, 8, 20)
const near = (a, b) => Math.abs(a - b) < 1e-9
check('flash 1M 缓存命中 @空闲 = ¥0.02', near(costOf(usage(1e6, 0, 0), 'deepseek-flash', offpeak), 0.02),
  `¥${costOf(usage(1e6, 0, 0), 'deepseek-flash', offpeak)}`)
check('flash 1M 缓存命中 @高峰 = ¥0.04', near(costOf(usage(1e6, 0, 0), 'deepseek-flash', valley), 0.04),
  `¥${costOf(usage(1e6, 0, 0), 'deepseek-flash', valley)}`)
check('flash 1M 未命中输入 @空闲 = ¥1', near(costOf(usage(0, 1e6, 0), 'deepseek-flash', offpeak), 1))
check('flash 1M 输出 @空闲 = ¥4', near(costOf(usage(0, 0, 1e6), 'deepseek-flash', offpeak), 4))
check('pro 1M 缓存命中 @空闲 = ¥0.15', near(costOf(usage(1e6, 0, 0), 'deepseek-v4-pro', offpeak), 0.15))
check('pro 1M 输出 @高峰 = ¥27', near(costOf(usage(0, 0, 1e6), 'deepseek-v4-pro', valley), 27))
check('国庆假期中的工作日按空闲计价（flash 1M 命中 = ¥0.02）',
  near(costOf(usage(1e6, 0, 0), 'deepseek-flash', beijing(2026, 10, 5, 10)), 0.02))

console.log(`\n===== 结果：${fails.length === 0 ? '全部通过 ✅' : `${fails.length} 项失败 ❌`} =====`)
if (fails.length > 0) console.log(fails.map((item) => ` - ${item}`).join('\n'))
process.exitCode = fails.length === 0 ? 0 : 1
