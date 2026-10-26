/**
 * 自算账本（插件自己的，不依赖 dsh-whale-widget）
 *
 * 落盘：$DSH_HOME/.wuwa-pet-usage.json（默认 ~/.dsh/.wuwa-pet-usage.json）
 *
 * 为什么要自己记：
 *   whale 的账本是「余额观测 + 逐轮事件」，它必须一直开着才不断档。
 *   本插件用它只是想要「今日已用 / 近 7 天 / 每轮金额」，这些其实从 DSH 的
 *   assistant/message 事件（usage 里的 inputTokens / cacheReadTokens / outputTokens）
 *   配上官方价目就能自己算准。于是这里独立记一份，whale 在不在都能出数。
 *
 * 三条约束：
 *   1. 只写自己的文件，绝不碰 whale 的 .dshw-*.json；
 *   2. 首次运行若发现 whale 账本存在而自己没有，做一次性 seed（历史天数 + 已有事件），
 *      避免升级后「今日已用」从 0 开始；
 *   3. 文件坏了大不了重建，读写全程容错，绝不因为记账把插件搞挂。
 *
 * 幂等：每条记录带 key（`sid:turn`）。whale 写账本有延迟，先自算、后收到 whale 的
 * 同一条事件时，用 key 原地修正而不是再记一笔——否则会重复计费。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const SELF_FILE = path.join(DSH_HOME, '.wuwa-pet-usage.json')

const VERSION = 1
const MAX_EVENTS = 500
const MAX_DAYS = 60
const BJ_OFFSET = 8 * 3600 * 1000
const DAY_MS = 86400000

export function bjDayKey(ts = Date.now()) {
  return new Date(ts + BJ_OFFSET).toISOString().slice(0, 10)
}

const round = (v) => Math.round((Number(v) || 0) * 1e9) / 1e9
const dayRow = (state, day) => (state.days[day] = state.days[day] || { cost: 0, tokens: 0, turns: 0, models: {} })

const empty = () => ({
  version: VERSION,
  seededFrom: null,
  seededAt: null,
  lastBalance: null,
  days: {}, // 'YYYY-MM-DD' -> { cost, tokens, turns, models: { model: {cost,tokens,turns} } }
  events: [], // [{ key, ts, day, model, cost, tokens, src }]
})

function readRaw() {
  try {
    const o = JSON.parse(fs.readFileSync(SELF_FILE, 'utf8'))
    if (!o || typeof o !== 'object') return null
    const s = empty()
    s.seededFrom = o.seededFrom ?? null
    s.seededAt = o.seededAt ?? null
    s.lastBalance = typeof o.lastBalance === 'number' ? o.lastBalance : null
    if (o.days && typeof o.days === 'object') {
      for (const [k, v] of Object.entries(o.days)) {
        if (!v || typeof v !== 'object') continue
        const models = {}
        for (const [m, mv] of Object.entries(v.models || {})) {
          if (!mv || typeof mv !== 'object') continue
          models[m] = { cost: round(mv.cost), tokens: Math.round(Number(mv.tokens) || 0), turns: Number(mv.turns) || 0 }
        }
        s.days[k] = { cost: round(v.cost), tokens: Math.round(Number(v.tokens) || 0), turns: Number(v.turns) || 0, models }
      }
    }
    if (Array.isArray(o.events)) s.events = o.events.filter((e) => e && typeof e === 'object')
    return s
  } catch {
    return null
  }
}

function writeRaw(state) {
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true })
    const tmp = SELF_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
    fs.renameSync(tmp, SELF_FILE)
    return true
  } catch {
    return false
  }
}

function prune(state, now = Date.now()) {
  const cut = bjDayKey(now - MAX_DAYS * DAY_MS)
  for (const k of Object.keys(state.days)) if (k < cut) delete state.days[k]
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS)
  return state
}

/** 按增量修改某天的聚合（cost/tokens/turns 可正可负） */
function bump(state, day, model, dCost, dTokens, dTurns) {
  const row = dayRow(state, day)
  row.cost = round(row.cost + dCost)
  row.tokens += dTokens
  row.turns += dTurns
  const mkey = model || '未知'
  const mrow = (row.models[mkey] = row.models[mkey] || { cost: 0, tokens: 0, turns: 0 })
  mrow.cost = round(mrow.cost + dCost)
  mrow.tokens += dTokens
  mrow.turns += dTurns
  if (mrow.turns <= 0 && mrow.tokens <= 0 && !mrow.cost) delete row.models[mkey]
}

/**
 * 记/改一轮。key 相同则原地修正（whale 迟到的事件覆盖自算值），否则新增一笔。
 * @param {object} o
 * @param {string} [o.key]   `sid:turn`
 * @param {number} [o.ts]
 * @param {string} [o.model]
 * @param {number} [o.cost]
 * @param {number} [o.tokens]
 * @param {'self'|'whale'} [o.src]
 */
export function appendTurn({ key = '', ts = Date.now(), model = '', cost = 0, tokens = 0, src = 'self' } = {}) {
  const state = readRaw() || empty()
  const day = bjDayKey(ts)
  const c = round(cost)
  const t = Math.round(Number(tokens) || 0)

  const idx = key ? state.events.findIndex((e) => e.key === key) : -1
  if (idx >= 0) {
    const old = state.events[idx]
    const oldDay = old.day || bjDayKey(old.ts)
    bump(state, oldDay, old.model, -round(old.cost), -(Math.round(Number(old.tokens) || 0)), -1)
    bump(state, day, model, c, t, 1)
    state.events[idx] = { key, ts, day, model: model || '未知', cost: c, tokens: t, src }
    writeRaw(prune(state, ts))
    return { day, cost: c, tokens: t, updated: true }
  }

  bump(state, day, model, c, t, 1)
  state.events.push({ key, ts, day, model: model || '未知', cost: c, tokens: t, src })
  writeRaw(prune(state, ts))
  return { day, cost: c, tokens: t, updated: false }
}

export function hasTurn(key) {
  if (!key) return false
  const state = readRaw()
  return !!state && state.events.some((e) => e.key === key)
}

export function setLastBalance(value) {
  const state = readRaw() || empty()
  state.lastBalance = typeof value === 'number' && isFinite(value) ? round(value) : null
  writeRaw(state)
}

/**
 * 首次运行从 whale 账本 seed（只做一次）。
 * @param {object} whaleUsage .dshw-usage.json 的内容
 * @returns {boolean} 是否真的 seed 了
 */
export function seedFromWhale(whaleUsage) {
  const state = readRaw() || empty()
  if (state.seededFrom) return false
  if (!whaleUsage || typeof whaleUsage !== 'object') return false
  const history = whaleUsage.history && typeof whaleUsage.history === 'object' ? whaleUsage.history : {}
  const events = Array.isArray(whaleUsage.events) ? whaleUsage.events : []
  if (!Object.keys(history).length && !events.length) return false

  // 逐轮事件：补 token/模型，供「本轮 ¥x」初值使用
  for (const e of events.slice(-MAX_EVENTS)) {
    const ts = Number(e.ts) || 0
    if (!ts) continue
    const day = e.day || bjDayKey(ts)
    const cost = round(e.cost)
    const tokens = Math.round(Number(e.tokens) || 0)
    if (!cost && !tokens) continue
    state.events.push({ key: '', ts, day, model: e.model || '未知', cost, tokens, src: 'whale' })
    bump(state, day, e.model, cost, tokens, 1)
  }
  // 历史天数：whale 的 history[day] 是当日总花费，而 events 里也含同一天的明细
  // ⇒ 不能相加（会翻倍）。取两者较大值：events 完整时相等，events 被截断时用 history 兜底。
  for (const [day, cost] of Object.entries(history)) {
    const c = round(cost)
    if (!c) continue
    const row = dayRow(state, day)
    row.cost = Math.max(row.cost, c)
  }
  state.events.sort((a, b) => a.ts - b.ts)
  if (typeof whaleUsage.lastBalance === 'number' && isFinite(whaleUsage.lastBalance)) {
    state.lastBalance = round(whaleUsage.lastBalance)
  }
  state.seededFrom = 'whale'
  state.seededAt = Date.now()
  writeRaw(prune(state))
  return true
}

/**
 * 用 whale 的历史天数做一次「只升不降」的对账。
 * whale 的 history 是它自己按事件累加的当日总额：本进程中途接管、
 * 或 seed 时 whale 还没把今天补完，都会让自算值偏小 —— 这里取较大值抹平。
 * 只改金额，不动 token / 轮数（那两项 whale 不一定有）。
 * @param {object} whaleUsage .dshw-usage.json 的内容
 * @returns {number} 被抬高的天数
 */
export function reconcileHistory(whaleUsage) {
  const history = whaleUsage && whaleUsage.history
  if (!history || typeof history !== 'object') return 0
  const state = readRaw()
  if (!state) return 0
  let changed = 0
  for (const [day, v] of Object.entries(history)) {
    const c = round(v)
    if (!c) continue
    const row = dayRow(state, day)
    if (c > row.cost + 1e-9) {
      row.cost = c
      changed++
    }
  }
  if (changed) writeRaw(prune(state))
  return changed
}

/** 汇总成前端要的形状（与 ledger.js 的 readState 对齐） */
export function summarize(now = Date.now()) {
  const state = readRaw()
  if (!state) return { ok: false, turns: 0 }

  const history7 = []
  for (let i = 6; i >= 0; i--) {
    const k = bjDayKey(now - i * DAY_MS)
    history7.push({ day: k, cost: round((state.days[k] && state.days[k].cost) || 0) })
  }
  const today = bjDayKey(now)
  const row = state.days[today] || { cost: 0, tokens: 0, turns: 0, models: {} }
  const lastEvent = state.events.length ? state.events[state.events.length - 1] : null

  return {
    ok: true,
    turns: row.turns || 0,
    today: round(row.cost),
    week: round(history7.reduce((a, d) => a + d.cost, 0)),
    history7,
    models: Object.entries(row.models || {})
      .map(([model, v]) => ({ model, cost: round(v.cost), tokens: Math.round(v.tokens || 0), turns: Number(v.turns) || 0 }))
      .sort((a, b) => b.cost - a.cost),
    lastTurn: lastEvent
      ? { ts: lastEvent.ts, cost: round(lastEvent.cost), tokens: lastEvent.tokens, model: lastEvent.model, day: lastEvent.day }
      : null,
    turnFingerprint: lastEvent ? lastEvent.ts : 0,
    costSource: 'self',
    seededFrom: state.seededFrom,
  }
}

export function resetSelf() {
  try {
    fs.rmSync(SELF_FILE, { force: true })
    return true
  } catch {
    return false
  }
}

export const files = { SELF_FILE }
