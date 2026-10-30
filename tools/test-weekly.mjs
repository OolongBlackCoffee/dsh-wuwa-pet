#!/usr/bin/env node
/**
 * 周报自测：不启动 DSH、不发气泡、不写文件，只用真实账本算一遍并打印。
 *
 * 用法：
 *   node tools/test-weekly.mjs
 *   node tools/test-weekly.mjs 2026-11-02        # 指定「今天」，验证周一边界
 */
import { weeklyStats, renderMarkdown } from '../lib/weekly.js'

const arg = process.argv[2]
const now = arg ? new Date(arg + 'T09:10:00').getTime() : Date.now()

console.log('今天:', new Date(now).toLocaleString('zh-CN', { hour12: false }))
const a = weeklyStats(now, 'rolling7')
const b = weeklyStats(now, 'lastWeek')

const line = (label, s) =>
  console.log(
    '  ' +
      label.padEnd(9) +
      '| ' +
      s.from +
      ' -> ' +
      s.to +
      ' | 合计 ¥' +
      s.total.toFixed(4) +
      ' · 前一周 ¥' +
      s.prevTotal.toFixed(4) +
      ' · ' +
      s.turns +
      ' 轮 · 活跃 ' +
      s.activeDays +
      ' 天 · mode=' +
      s.mode,
  )

line('滚动7天', a)
line('上一个自然周', b)

// 断言：lastWeek 必须正好是 7 天、且最后一天是「今天所在周的周一」的前一天
const okDays = b.days.length === 7
const last = new Date(b.to + 'T00:00:00')
const today = new Date(now)
const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate())
const wd = (today0.getDay() + 6) % 7
const thisMonday = new Date(today0.getTime() - wd * 86400000)
const expectTo = new Date(thisMonday.getTime() - 86400000)
const okTo = last.getDate() === expectTo.getDate() && last.getMonth() === expectTo.getMonth()

console.log('')
console.log('  断言：7 天', okDays ? '✓' : '✗', '· 结束日 = 本周一前一天', okTo ? '✓' : '✗')
console.log('')
console.log(renderMarkdown(b).split('\n').slice(0, 26).join('\n'))
process.exit(okDays && okTo ? 0 : 1)
