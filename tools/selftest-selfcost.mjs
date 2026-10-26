/**
 * 自算链路自检（不需要 DSH、不需要 whale）
 *
 *   node tools/selftest-selfcost.mjs
 *
 * 覆盖：
 *   1. 价目表与 whale 口径逐项对齐（含高峰翻倍、Pro 三倍价）
 *   2. 混合 token 的金额与「手算」一致
 *   3. 自算账本的写入 / 同 key 覆盖（whale 迟到修正）/ 汇总
 *   4. 首次 seed：从 whale 账本补历史金额与事件
 *   5. 坏文件容错
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 先改 DSH_HOME，再动态 import（模块在加载时读取该环境变量）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuwa-selfcost-'))
process.env.DSH_HOME = tmp

const { costOf, priceFor } = await import('../lib/pricing.js')
const { appendTurn, summarize, seedFromWhale, resetSelf, reconcileHistory, files, bjDayKey } = await import('../lib/selfledger.js')

let pass = 0
let fail = 0
const eq = (name, actual, expected, tol = 1e-9) => {
  const ok =
    typeof expected === 'string'
      ? String(actual) === expected
      : Math.abs(Number(actual) - Number(expected)) <= tol
  if (ok) {
    pass++
    console.log(`  ✓ ${name}  = ${actual}`)
  } else {
    fail++
    console.log(`  ✗ ${name}  期望 ${expected}，实际 ${actual}`)
  }
}
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}

console.log('\n[1] 价目与 whale 同口径（元/百万 token，[空闲, 高峰]）')
const flash = priceFor('deepseek-v4.1-flash')
eq('Flash 缓存命中价（空闲）', flash.hit[0], 0.02)
eq('Flash 缓存命中价（高峰）', flash.hit[1], 0.04)
eq('Flash 未命中价（空闲）', flash.miss[0], 1)
eq('Flash 输出价（高峰）', flash.out[1], 8)
const pro = priceFor('deepseek-v4-pro')
eq('Pro 未命中价（空闲）', pro.miss[0], 4.5)
eq('Pro 输出价（高峰）', pro.out[1], 27)
eq('认不出的模型按 Flash 价', priceFor('some-unknown-model').out[0], 4)

console.log('\n[2] 金额计算')
// 纯命中 1M token，空闲 = 0.02；高峰 = 0.04
eq('1M 缓存命中（空闲）', costOf({ model: 'deepseek-flash', cache: 1e6, peak: false }), 0.02)
eq('1M 缓存命中（高峰）', costOf({ model: 'deepseek-flash', cache: 1e6, peak: true }), 0.04)
// 混合：200k 命中 + 300k 未命中 + 100k 输出，空闲
// 0.2*0.02 + 0.3*1 + 0.1*4 = 0.004 + 0.3 + 0.4 = 0.704
eq('混合 200k/300k/100k（空闲）', costOf({ model: 'deepseek-flash', cache: 2e5, input: 3e5, output: 1e5 }), 0.704)
// 同上但高峰：0.2*0.04 + 0.3*2 + 0.1*8 = 0.008 + 0.6 + 0.8 = 1.408
eq('混合 200k/300k/100k（高峰）', costOf({ model: 'deepseek-flash', cache: 2e5, input: 3e5, output: 1e5, peak: true }), 1.408)
// Pro 同混合空闲：0.2*0.15 + 0.3*4.5 + 0.1*13.5 = 0.03 + 1.35 + 1.35 = 2.73
eq('Pro 混合（空闲）', costOf({ model: 'deepseek-v4-pro', cache: 2e5, input: 3e5, output: 1e5 }), 2.73)
// 0 token 不产生金额
eq('零用量', costOf({ model: 'deepseek-flash' }), 0)

console.log('\n[3] 账本写入 / 同 key 覆盖')
resetSelf()
const now = Date.now()
const day = bjDayKey(now)
appendTurn({ key: 's1:1', ts: now, model: 'deepseek-v4.1-flash', cost: 0.5, tokens: 1000, src: 'self' })
let s = summarize(now)
eq('一轮后今日已用', s.today, 0.5)
eq('一轮后今日轮数', s.turns, 1)
eq('一轮后上周合计', s.week, 0.5)

// whale 迟到：同 key 用 whale 的金额修正，而不是再加一笔
appendTurn({ key: 's1:1', ts: now + 300, model: 'deepseek-v4.1-flash', cost: 0.62, tokens: 1234, src: 'whale' })
s = summarize(now)
eq('修正后今日已用（不是 1.12）', s.today, 0.62)
eq('修正后今日轮数仍为 1', s.turns, 1)
eq('修正后 token', s.lastTurn.tokens, 1234)

// 新 key 才新增
appendTurn({ key: 's1:2', ts: now + 600, model: 'deepseek-v4.1-flash', cost: 0.38, tokens: 800, src: 'self' })
s = summarize(now)
eq('两轮后今日已用', s.today, 1.0)
eq('两轮后轮数', s.turns, 2)
eq('近 7 天窗口长度', s.history7.length, 7)
eq('近 7 天最后一天是今天', s.history7[6].day, day)
ok('模型拆分存在', s.models.length >= 1, JSON.stringify(s.models[0]))

console.log('\n[4] 首次 seed（从 whale 账本）')
resetSelf()
const seeded = seedFromWhale({
  history: { '2026-10-25': 1.5, '2026-10-26': 2.0 },
  events: [
    { ts: now - 3600_000, day: '2026-10-26', model: 'deepseek-v4.1-flash', cost: 0.8, tokens: 5000 },
    { ts: now, day: '2026-10-26', model: 'deepseek-v4.1-flash', cost: 1.2, tokens: 9000 },
  ],
})
ok('seed 成功', seeded === true)
const seeded2 = seedFromWhale({ history: { '2026-10-26': 99 }, events: [] })
ok('seed 幂等（第二次返回 false）', seeded2 === false)
s = summarize(now)
ok('seed 后历史保留（>= 2.0）', s.today >= 2.0 && s.today < 3.0, '今日=' + s.today)
ok('seed 后事件带上来源', s.lastTurn && s.lastTurn.cost === 1.2, JSON.stringify(s.lastTurn))

console.log('\n[5] 容错')
fs.writeFileSync(files.SELF_FILE, '{ 这不是 JSON', 'utf8')
const broken = summarize(now)
ok('坏文件不抛异常', broken !== null)
appendTurn({ key: 's9:1', ts: now, model: '', cost: 0.1, tokens: 10, src: 'self' })
const recovered = summarize(now)
ok('坏文件后能重建', recovered.ok === true && recovered.today >= 0.1, '今日=' + recovered.today)

// —— 5) 与 whale 历史对账：只升不降 ——
console.log('\n[5] 与 whale 历史对账（只升不降）')
fs.rmSync(files.SELF_FILE, { force: true })
const todayKey = bjDayKey(now)
appendTurn({ key: 's10:1', ts: now, model: 'deepseek-flash', cost: 0.5, tokens: 1000, src: 'self' })
const raised = reconcileHistory({ history: { [todayKey]: 3.2, '2026-10-20': 9.9 } })
eq('抬高天数', raised, 2)
eq('今日被抬到 whale 的值', summarize(now).today, 3.2)
eq('历史天数也补上了', summarize(now).history7.find((d) => d.day === '2026-10-20').cost, 9.9)
eq('再对账不重复抬高', reconcileHistory({ history: { [todayKey]: 3.2 } }), 0)

fs.rmSync(tmp, { recursive: true, force: true })

console.log('\n' + (fail === 0 ? `全部通过：${pass} 项` : `失败 ${fail} 项 / 通过 ${pass} 项`))
process.exit(fail === 0 ? 0 : 1)
