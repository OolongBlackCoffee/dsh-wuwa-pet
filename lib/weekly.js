import fs from 'node:fs'
import path from 'node:path'
import { bjDayKey, DSH_HOME, SELF_FILE } from './selfledger.js'

const DAY_MS = 86400000
export const REPORTS_DIR = path.join(DSH_HOME, 'wuwa-pet-reports')

const round = (v) => Math.round((Number(v) || 0) * 1e9) / 1e9
const money = (v) => '¥' + (Math.round((Number(v) || 0) * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
const pct = (v) => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%'

/** 读自算账本的 days 段（只读，不改文件） */
export function readDays() {
  try {
    const o = JSON.parse(fs.readFileSync(SELF_FILE, 'utf8'))
    if (!o || typeof o !== 'object' || !o.days || typeof o.days !== 'object') return null
    const out = {}
    for (const [k, v] of Object.entries(o.days)) {
      if (!v || typeof v !== 'object') continue
      const models = {}
      for (const [m, mv] of Object.entries(v.models || {})) {
        if (!mv || typeof mv !== 'object') continue
        models[m] = { cost: round(mv.cost), tokens: Math.round(Number(mv.tokens) || 0), turns: Number(mv.turns) || 0 }
      }
      out[k] = {
        cost: round(v.cost),
        tokens: Math.round(Number(v.tokens) || 0),
        turns: Number(v.turns) || 0,
        models,
      }
    }
    return out
  } catch {
    return null
  }
}

/**
 * 过去 7 天（含今天）的用量统计 + 与上一个 7 天的环比。
 * @param {number} [now]
 */
export function weeklyStats(now = Date.now(), mode = 'rolling7') {
  const days = readDays()
  if (!days) return { ok: false, reason: '账本还没生成（还没有任何一轮被记账）' }

  // 窗口：rolling7 = 滚动 7 天（含今天）；lastWeek = 上一个完整自然周（周一~周日）
  // 本机时区就是 +08:00，直接用本地时间算周一，与 bjDayKey 口径一致。
  let curKeys = []
  let prevKeys = []
  if (mode === 'lastWeek') {
    const t = new Date(now)
    const today = new Date(t.getFullYear(), t.getMonth(), t.getDate())
    const wd = (today.getDay() + 6) % 7 // 周一=0 … 周日=6
    const lastMonday = new Date(today.getTime() - (wd + 7) * DAY_MS)
    const prevMonday = new Date(lastMonday.getTime() - 7 * DAY_MS)
    for (let i = 0; i < 7; i++) {
      curKeys.push(bjDayKey(lastMonday.getTime() + i * DAY_MS))
      prevKeys.push(bjDayKey(prevMonday.getTime() + i * DAY_MS))
    }
  } else {
    for (let i = 6; i >= 0; i--) curKeys.push(bjDayKey(now - i * DAY_MS))
    for (let i = 13; i >= 7; i--) prevKeys.push(bjDayKey(now - i * DAY_MS))
  }

  const cur = []
  for (const key of curKeys) {
    const row = days[key]
    cur.push({
      day: key,
      cost: round(row ? row.cost : 0),
      tokens: row ? row.tokens : 0,
      turns: row ? row.turns : 0,
      models: row ? row.models : {},
    })
  }

  let prevTotal = 0
  for (const key of prevKeys) {
    const row = days[key]
    if (row) prevTotal = round(prevTotal + row.cost)
  }

  const total = round(cur.reduce((a, d) => a + d.cost, 0))
  const turns = cur.reduce((a, d) => a + d.turns, 0)
  const tokens = cur.reduce((a, d) => a + d.tokens, 0)
  const activeDays = cur.filter((d) => d.turns > 0).length

  const modelMap = {}
  for (const d of cur) {
    for (const [m, v] of Object.entries(d.models)) {
      const row = (modelMap[m] = modelMap[m] || { model: m, cost: 0, tokens: 0, turns: 0 })
      row.cost = round(row.cost + v.cost)
      row.tokens += v.tokens
      row.turns += v.turns
    }
  }
  const models = Object.values(modelMap).sort((a, b) => b.cost - a.cost)

  const best = cur.reduce((a, d) => (d.cost > a.cost ? d : a), cur[0])

  return {
    ok: true,
    mode,
    from: cur[0].day,
    to: cur[cur.length - 1].day,
    days: cur,
    total,
    turns,
    tokens,
    activeDays,
    avg: activeDays > 0 ? round(total / activeDays) : 0,
    avgAll: round(total / 7),
    best: { day: best.day, cost: best.cost, turns: best.turns },
    models,
    prevTotal,
    delta: round(total - prevTotal),
    deltaPct: prevTotal > 0 ? (total - prevTotal) / prevTotal : 0,
    hasPrev: prevTotal > 0,
  }
}

/** ISO 周编号（2026-W44），用于周报文件名 */
export function isoWeekKey(d = new Date()) {
  const t0 = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t0.getUTCDay() || 7
  t0.setUTCDate(t0.getUTCDate() + 4 - day)
  const y0 = new Date(Date.UTC(t0.getUTCFullYear(), 0, 1))
  return t0.getUTCFullYear() + '-W' + String(Math.ceil(((t0 - y0) / 86400000 + 1) / 7)).padStart(2, '0')
}

const BAR = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']

/** 用方块给每天画一条迷你条形图（相对本周最大值） */
function barOf(cost, max) {
  if (!(max > 0) || !(cost > 0)) return ''
  const width = (cost / max) * 8
  const full = Math.floor(width)
  const frac = width - full
  return '█'.repeat(full) + (BAR[Math.round(frac * 8)] || '')
}

/**
 * 生成 markdown 周报。
 * @param {ReturnType<typeof weeklyStats>} s
 * @param {{ now?: number, version?: string }} [opts]
 */
export function renderMarkdown(s, opts = {}) {
  const now = opts.now || Date.now()
  if (!s || !s.ok) {
    return `# dsh-wuwa-pet 用量周报\n\n本周还没有可统计的数据${s && s.reason ? `（${s.reason}）` : ''}。\n`
  }

  const maxCost = Math.max(...s.days.map((d) => d.cost), 0)
  const lines = []
  lines.push(`# dsh-wuwa-pet 用量周报`)
  lines.push('')
  lines.push(`> ${s.from} ~ ${s.to}（生成于 ${new Date(now).toLocaleString('zh-CN', { hour12: false })}）`)
  lines.push('')
  lines.push(`**${s.mode === 'lastWeek' ? '上周' : '本周'}合计 ${money(s.total)}**，共 ${s.turns} 轮、约 ${(s.tokens / 1e6).toFixed(1)}M tokens（含缓存读取，计费以金额为准），活跃 ${s.activeDays} 天。`)
  lines.push('')
  if (s.hasPrev) {
    const arrow = s.delta >= 0 ? '📈' : '📉'
    const caveat = s.prevTotal < 1 ? '（上周数据不完整，仅供参考）' : ''
    lines.push(`${s.mode === 'lastWeek' ? '前一周' : '上周'} ${money(s.prevTotal)} → ${s.mode === 'lastWeek' ? '上周' : '本周'} ${money(s.total)}（${arrow} ${pct(s.deltaPct)}，${s.delta >= 0 ? '+' : ''}${money(s.delta)}）${caveat}`)
  } else {
    lines.push(`${s.mode === 'lastWeek' ? '前一周' : '上周'}没有记录，这是第一份可对比的周报。`)
  }
  lines.push('')

  lines.push('## 每天')
  lines.push('')
  lines.push('| 日期 | 金额 | 轮次 | 量 |')
  lines.push('| --- | ---: | ---: | --- |')
  for (const d of s.days) {
    lines.push(`| ${d.day.slice(5)} | ${d.cost ? money(d.cost) : '—'} | ${d.turns || 0} | ${barOf(d.cost, maxCost)} |`)
  }
  lines.push('')

  if (s.best.cost > 0) {
    lines.push('## 最烧钱的一天')
    lines.push('')
    lines.push(`**${s.best.day}**：${money(s.best.cost)}，${s.best.turns} 轮（占本周 ${Math.round((s.best.cost / s.total) * 100)}%）。`)
    lines.push('')
  }

  if (s.models.length) {
    lines.push('## 按模型')
    lines.push('')
    lines.push('| 模型 | 金额 | 占比 | 轮次 |')
    lines.push('| --- | ---: | ---: | ---: |')
    for (const m of s.models) {
      const share = s.total > 0 ? (m.cost / s.total) * 100 : 0
      lines.push(`| ${m.model} | ${money(m.cost)} | ${share.toFixed(1)}% | ${m.turns} |`)
    }
    const attributed = s.models.reduce((a, m) => a + m.cost, 0)
    const rest = Math.round((s.total - attributed) * 1e9) / 1e9
    if (rest > 0.0001) {
      const share = (rest / s.total) * 100
      lines.push(`| （历史导入，无模型明细） | ${money(rest)} | ${share.toFixed(1)}% | — |`)
    }
    lines.push('')
  }

  lines.push('## 怎么省')
  lines.push('')
  lines.push('- **多命中缓存**：输入未命中 ¥1/M、命中 ¥0.02/M（Flash，差 50 倍），同一段上下文连着问、少开新会话最省。')
  lines.push('- **避开高峰**：工作日 9:00–12:00、14:00–18:00 价格翻倍，能挪到晚上/周末就挪。')
  lines.push('- **子智能体也是钱**：`dsh-wuwa-pet` 会把子代理的轮次也记进来（可在配置里关掉记账但仍静音）。')
  lines.push('')
  lines.push(`<!-- dsh-wuwa-pet ${opts.version || ''} weekly report, days=${s.days.length} -->`)
  return lines.join('\n') + '\n'
}

/** ISO 周（周四定周的算法），用于文件名 */
export function weekKey(now = Date.now()) {
  const d = new Date(now)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNum + 3)
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThu.getUTCDay() + 6) % 7
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3)
  const week = 1 + Math.round((target - firstThu) / (7 * DAY_MS))
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function reportFile(now = Date.now()) {
  return path.join(REPORTS_DIR, `${weekKey(now)}.md`)
}

/**
 * 生成并写盘（幂等：同一天重复调用会覆盖同一份文件）。
 * @param {number} [now]
 * @param {{ version?: string }} [opts]
 */
export function saveWeeklyReport(now = Date.now(), opts = {}) {
  const stats = weeklyStats(now)
  const md = renderMarkdown(stats, { now, version: opts.version })
  const file = reportFile(now)
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true })
    fs.writeFileSync(file, md, 'utf8')
    return { ok: true, file, stats, markdown: md }
  } catch (e) {
    return { ok: false, file, stats, error: String((e && e.message) || e) }
  }
}

/** 本周周报文件是否已存在且非空 */
export function hasReportThisWeek(now = Date.now()) {
  try {
    const f = reportFile(now)
    const st = fs.statSync(f)
    return st.size > 0
  } catch {
    return false
  }
}

export const files = { REPORTS_DIR, SELF_FILE }
