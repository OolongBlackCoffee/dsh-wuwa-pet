/**
 * 账本读取层（插件宿主侧）
 *
 * 数据源就是 dsh-whale-widget 已经落盘的那几份文件，一个字节都不改写：
 *   $DSH_HOME/.dshw-usage.json   余额观测(lastBalance) + 每日已用(history) + 逐轮明细(events)
 *   $DSH_HOME/.dshw-turn.json    轮次序号
 *   $DSH_HOME/.dshw-size.json    挂件的显示设置（缩放）
 *
 * 为什么不自己按 usage 计费：whale 的定价表、缓存命中价、自定义模型单价、峰谷系数
 * 都在它自己的账本里算完并写进 events 了；重复实现一遍只会在「金额和小鲸鱼对不上」
 * 这种问题上翻车。这里只做「读」和「算时段」。
 *
 * 峰谷口径与 whale 同源：工作日 9:00–12:00、14:00–18:00（北京时间）为高峰，
 * 周末与法定节假日全天谷价。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const USAGE_FILE = path.join(DSH_HOME, '.dshw-usage.json')
export const TURN_FILE = path.join(DSH_HOME, '.dshw-turn.json')
export const SIZE_FILE = path.join(DSH_HOME, '.dshw-size.json')

// 2026 年法定节假日（放假即谷价）。每年 11 月国务院发布次年安排后需要补上下一年的日期。
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

const PEAK_HOURS = [[9, 12], [14, 18]]
const BJ_OFFSET = 8 * 3600 * 1000
const DAY_MS = 86400000

/** 北京时间日历视图（用 UTC 读取即为北京日历） */
const bjDate = (ts = Date.now()) => new Date(ts + BJ_OFFSET)

export function bjDayKey(ts = Date.now()) {
  return bjDate(ts).toISOString().slice(0, 10)
}

export function isPeak(ts = Date.now()) {
  const d = bjDate(ts)
  const dow = d.getUTCDay()
  if (dow === 0 || dow === 6) return false
  if (HOLIDAYS.has(d.toISOString().slice(0, 10))) return false
  const h = d.getUTCHours()
  return PEAK_HOURS.some(([a, b]) => h >= a && h < b)
}

/** 下一次峰谷切换的时刻（epoch ms），与 isPeak 完全同源 */
export function nextPeakChange(ts = Date.now()) {
  const cur = isPeak(ts)
  const dayStart = Math.floor((ts + BJ_OFFSET) / DAY_MS) * DAY_MS - BJ_OFFSET
  for (let d = 0; d <= 12; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = dayStart + d * DAY_MS + edge * 3600000
      if (cand <= ts + 1000) continue
      if (isPeak(cand) !== cur) return cand
    }
  }
  return null
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const toYuan = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1e6) / 1e6 : null)

/** 账本最新一条逐轮明细（每轮结算的金额与 token 都在这） */
export function readLastEvent() {
  const usage = readJson(USAGE_FILE)
  if (!usage) return null
  const events = Array.isArray(usage.events) ? usage.events : []
  return events.length ? events[events.length - 1] : null
}

/**
 * 组装前端要的状态。
 * @param {object} opts
 * @param {number|null} opts.balanceOverride 实时余额（拿到就用它，否则用账本观测值）
 * @param {string} opts.balanceSource 'apikey' | 'ledger' | 'none'
 */
export function readState(opts = {}) {
  const now = Date.now()
  const usage = readJson(USAGE_FILE)
  const turn = readJson(TURN_FILE)
  const size = readJson(SIZE_FILE) || {}
  const today = bjDayKey(now)

  if (!usage) {
    return {
      ok: false,
      reason: 'no-ledger',
      message: '还没读到小鲸鱼账本',
      hint: '打开一次带 dsh-whale-widget 的 DSH，账本就会写到 ' + USAGE_FILE,
      ts: now,
      peak: peakBlock(now),
    }
  }

  const history = usage.history || {}
  const events = Array.isArray(usage.events) ? usage.events : []

  // 最近 7 天（含今天，缺的天补 0，前端直接画柱状图）
  const history7 = []
  for (let i = 6; i >= 0; i--) {
    const key = bjDayKey(now - i * DAY_MS)
    history7.push({ day: key, cost: toYuan(history[key] || 0) || 0 })
  }

  const todayEvents = events.filter((e) => e && e.day === today)
  const models = new Map()
  for (const e of todayEvents) {
    const m = models.get(e.model) || { model: e.model, cost: 0, tokens: 0, turns: 0 }
    m.cost += Number(e.cost) || 0
    m.tokens += Number(e.tokens) || 0
    m.turns += 1
    models.set(e.model, m)
  }
  const lastEvent = events.length ? events[events.length - 1] : null

  const balanceOverride = typeof opts.balanceOverride === 'number' && isFinite(opts.balanceOverride)
    ? opts.balanceOverride
    : null
  const ledgerBalance = toYuan(usage.lastBalance)

  return {
    ok: true,
    ts: now,
    date: today,
    balance: balanceOverride !== null ? toYuan(balanceOverride) : ledgerBalance,
    balanceSource: balanceOverride !== null ? (opts.balanceSource || 'apikey') : (ledgerBalance !== null ? 'ledger' : 'none'),
    today: toYuan(history[today] ?? usage.todayUsage ?? 0) || 0,
    history7,
    week: toYuan(history7.reduce((a, d) => a + (d.cost || 0), 0)) || 0,
    peak: peakBlock(now),
    models: [...models.values()].map((m) => ({ ...m, cost: toYuan(m.cost) })).sort((a, b) => b.cost - a.cost),
    turnsToday: todayEvents.length,
    lastTurn: lastEvent
      ? {
          ts: lastEvent.ts,
          cost: toYuan(Number(lastEvent.cost) || 0) || 0,
          tokens: Number(lastEvent.tokens) || 0,
          model: lastEvent.model,
          day: lastEvent.day,
        }
      : null,
    /** 轮次指纹：账本追加新的一轮，这个值就变大 */
    turnFingerprint: lastEvent ? lastEvent.ts : 0,
    turnSeqFromFile: turn && typeof turn.seq === 'number' ? turn.seq : null,
    widgetScale: typeof size.scale === 'number' ? size.scale : 1,
  }
}

function peakBlock(now) {
  const peak = isPeak(now)
  const at = nextPeakChange(now)
  return {
    isPeak: peak,
    label: peak ? '峰时' : '谷时',
    nextChangeAt: at,
    nextChangeInSec: at ? Math.max(0, Math.round((at - now) / 1000)) : null,
  }
}

export const files = { USAGE_FILE, TURN_FILE, SIZE_FILE }
