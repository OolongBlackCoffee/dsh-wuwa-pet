#!/usr/bin/env node
/**
 * 立刻生成一份「上一个自然周」的周报（不等周一），用于预览效果 / 补漏。
 *
 * 用法：
 *   node tools/gen-weekly.mjs            # 写到 ~/.dsh/wuwa-pet-reports/2026-W44.md
 *   node tools/gen-weekly.mjs --print    # 只打印，不写文件
 *   node tools/gen-weekly.mjs --week 2026-11-02   # 以指定日期为「今天」推算上一周
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { weeklyStats, renderMarkdown, isoWeekKey } from '../lib/weekly.js'

const argv = process.argv.slice(2)
const printOnly = argv.includes('--print')
const wi = argv.indexOf('--week')
const now = wi >= 0 && argv[wi + 1] ? new Date(argv[wi + 1] + 'T09:10:00').getTime() : Date.now()

const stats = weeklyStats(now, 'lastWeek')
if (!stats.ok) {
  console.error('账本还没数据：', stats.reason)
  process.exit(1)
}
const md = renderMarkdown(stats, { now })
if (printOnly) {
  console.log(md)
  process.exit(0)
}

const dir = path.join(os.homedir(), '.dsh', 'wuwa-pet-reports')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, isoWeekKey(new Date(now)) + '.md')
fs.writeFileSync(file, md, 'utf8')
console.log('已写入 ' + file)
console.log('  统计区间 ' + stats.from + ' ~ ' + stats.to + ' · 合计 ¥' + stats.total.toFixed(4) + ' · ' + stats.turns + ' 轮')
