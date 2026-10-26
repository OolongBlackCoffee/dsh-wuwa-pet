/**
 * 离线自检：不启动 DSH，直接用假的 ctx 跑一遍插件的关键路径。
 *   node test-smoke.mjs
 */
import { readState, readLastEvent, isPeak, nextPeakChange, files } from './lib/ledger.js'
import { readFileSync, existsSync } from 'node:fs'
import { createBalanceReader } from './lib/balance.js'
import { createWaitTracker } from './lib/wait.js'
import plugin from './lib/index.js'

const line = (s) => console.log(s)
let failed = 0
const check = (name, cond, extra = '') => {
  line((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

line('== 账本 ==')
const st = readState({})
check('readState 有结果', !!st)
if (st.ok) {
  check('余额是数字', typeof st.balance === 'number', String(st.balance))
  check('今日已用是数字', typeof st.today === 'number', String(st.today))
  check('历史 7 天', st.history7.length === 7)
  check('峰谷块完整', !!st.peak && typeof st.peak.isPeak === 'boolean', st.peak && st.peak.label + ' / 距切换 ' + st.peak.nextChangeInSec + 's')
  check('轮次指纹', typeof st.turnFingerprint === 'number', String(st.turnFingerprint))
} else {
  line('  （账本还没生成，跳过字段检查）')
}
line('  账本: ' + files.USAGE_FILE)
const ev = readLastEvent()
line('  最新一轮: ' + (ev ? '¥' + Number(ev.cost).toFixed(4) + ' / ' + ev.tokens + ' tok / ' + ev.model : '无'))

line('== 峰谷 ==')
const now = Date.now()
check('isPeak 返回布尔', typeof isPeak(now) === 'boolean', String(isPeak(now)))
check('下次切换在未来', nextPeakChange(now) > now)

line('== 余额读数 ==')
// ① 宿主什么都没有 → 必须优雅失败，不能抛
const reader0 = createBalanceReader({ getContexts: () => [], ttlMs: 5000 })
const v0 = await reader0.get(true)
check('没有宿主服务时不抛错', v0 === null, String(reader0.lastError()))

// ② 只有账号登录态（本机真实情况）→ 走 account 路，充值 + 赠金相加
const fakeAccountCtx = {
  get: (n) =>
    n === 'deepseekAccount'
      ? {
          getBalance: async () => ({
            status: 'ready',
            value: [{ currency: 'CNY', balance: '20.5' }],
            bonusWallets: [{ currency: 'CNY', balance: '5.5' }],
          }),
        }
      : null,
}
const reader1 = createBalanceReader({ getContexts: () => [fakeAccountCtx], ttlMs: 5000 })
const v1 = await reader1.get(true)
check('账号路拿到余额', v1 && v1.balance === 26, v1 ? JSON.stringify(v1) : String(reader1.lastError()))
check('账号路来源标对', v1 && v1.source === 'account', v1 && v1.source)

// ③ 服务在 ctx 属性上（不是 get()）也要认出来
const propCtx = {
  get: () => null,
  deepseekAccount: {
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: 1 }], bonusWallets: [] }),
  },
}
const reader2 = createBalanceReader({ getContexts: () => [propCtx], ttlMs: 5000 })
const v2 = await reader2.get(true)
check('属性式服务也能读到', v2 && v2.balance === 1, v2 ? String(v2.balance) : String(reader2.lastError()))

// ④ 冷启动没服务、随后服务就绪 → force 重试必须能拿到
let lateCtxs = []
const reader3 = createBalanceReader({ getContexts: () => lateCtxs, ttlMs: 60000 })
await reader3.get(true)
lateCtxs = [fakeAccountCtx]
const v3 = await reader3.get(true)
check('服务晚到后能补上', v3 && v3.balance === 26, v3 ? String(v3.balance) : String(reader3.lastError()))

line('== 版本与资源一致性 ==')
{
  const injectSrc = readFileSync(new URL('./lib/inject.js', import.meta.url), 'utf8')
  const widgetSrc = readFileSync(new URL('./lib/widget.js', import.meta.url), 'utf8')
  const expected = (injectSrc.match(/WIDGET_VERSION\s*=\s*'([^']+)'/) || [])[1]
  const actual = (widgetSrc.match(/var VERSION\s*=\s*'([^']+)'/) || [])[1]
  check('inject.js 的 WIDGET_VERSION 与 widget.js 的 VERSION 一致', !!expected && expected === actual, expected + ' vs ' + actual)
  for (const f of ['turn-end.wav', 'ask.wav', 'approve.wav']) {
    const p = new URL('./assets/' + f, import.meta.url)
    check('提示音就位：' + f, existsSync(p))
  }
}

line('== 提问/授权挂起（纯逻辑） ==')
{
  const shown = []
  const cleared = []
  let clock = 1000
  const wt = createWaitTracker({
    onShow: (w) => shown.push(w),
    onClear: (i) => cleared.push(i),
    ttlMs: 5000,
    dedupeMs: 2500,
    now: () => clock,
  })
  const q = (id) => ({ type: 'tool/call', data: { name: 'ask_user_question', message: { callId: id } } })
  const r = (id) => ({ type: 'tool/result', data: { message: { callId: id } } })

  wt.handle('s1', q('c1'))
  check('tool/call(ask_user_question) → question', shown.length === 1 && shown[0].kind === 'question')
  wt.handle('s1', q('c1'))
  check('同一 callId 2.5s 内重复广播只弹一次', shown.length === 1)
  wt.handle('s2', { type: 'turn/end' })
  check('别的会话 turn/end 不清本会话挂起', wt.pending() && wt.pending().kind === 'question')
  wt.handle('s1', r('c1'))
  check('tool/result 按 callId 解除', wt.pending() === null && cleared.length === 1)

  wt.handle('s1', { type: 'approval/asked', data: { id: 'a1' } })
  check('approval/asked → approval', shown.length === 2 && shown[1].kind === 'approval')
  wt.handle('s1', { type: 'approval/answered', data: { id: 'a1' } })
  check('approval/* 解除', wt.pending() === null && cleared.length === 2)

  wt.handle('s1', { type: 'approval/asked', data: { id: 'a2' } })
  wt.handle('s1', { type: 'turn/start' })
  check('turn/start 清掉挂起', wt.pending() === null)
  wt.handle('s1', { type: 'approval/asked', data: { id: 'a3' } })
  clock += 6000
  check('超时自动收起', wt.expire() === true && wt.pending() === null)
}

line('== 插件装载（假 ctx） ==')
let dispose = null
const handlers = new Map()
const fakeCtx = {
  // cordis 的 ctx.get 是从当前 ctx 往上找，root 看不到子 ctx 注册的服务，
  // 所以这里必须走 inject —— smoke 里模拟「凭据服务已就绪但没配 key、账号服务缺失」
  get: () => ({
    resolve: async () => {
      throw new Error('smoke: 没有 key')
    },
  }),
  on: (name, fn) => {
    const list = handlers.get(name) || []
    list.push(fn)
    handlers.set(name, list)
    return () => {}
  },
}
const fakeRoot = {
  on: (name, fn) => {
    const list = handlers.get('root:' + name) || []
    list.push(fn)
    handlers.set('root:' + name, list)
    return () => {}
  },
  inject: (names, cb) => cb(fakeCtx),
  effect: (fn) => {
    dispose = fn()
  },
}
// 测试里关掉自动部署：它会在后台真去跑 PowerShell 改本机的 WuwaTappo.exe
plugin.apply(fakeRoot, { cdpPort: 9222, tickMs: 1500, idleTickMs: 2000, autoDeploy: false })
check('apply 后暴露诊断入口', !!globalThis.__DSH_WUWA_PET__)
check('子 ctx 上也订阅了 session/event', (handlers.get('session/event') || []).length > 0)
check('root 上也订阅了 session/event', (handlers.get('root:session/event') || []).length > 0)

// 拦截 notify，验证「assistant/message 攒 token → turn/end 弹泡」整条链
const pet = globalThis.__DSH_WUWA_PET__
const sent = []
pet.link.notify = async (p) => {
  sent.push(p)
  return true
}
const emit = (name, ...args) => {
  for (const fn of handlers.get(name) || []) fn(...args)
  for (const fn of handlers.get('root:' + name) || []) fn(...args)
}
const session = { id: 'smoke-session' }
const evMsg = { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 1000, outputTokens: 234 } } }
emit('session/event', session, evMsg)
emit('session/event', session, evMsg) // 同一事件对象重复投递 → 必须去重
const evEnd = { type: 'turn/end' }
emit('session/event', session, evEnd)
emit('session/event', session, evEnd)
await new Promise((r) => setTimeout(r, 2200))
check('轮次结束弹了一次泡（去重生效）', sent.length === 1, '实际 ' + sent.length + ' 次，' + JSON.stringify(sent[0]))
check('token 数聚合正确', sent[0] && sent[0].tokens === 1234, sent[0] ? String(sent[0].tokens) : '无')

// —— 提问/授权：走真实事件流，断言推到桌宠的 payload ——
sent.length = 0
const qCall = (id) => ({ type: 'tool/call', data: { name: 'ask_user_question', message: { callId: id } } })
emit('session/event', session, qCall('q1'))
emit('session/event', session, qCall('q1')) // 同一 id 重复广播：宿主编排可能重放
check('提问挂起 → 推 question 泡', sent.length === 1 && sent[0].kind === 'question' && sent[0].action === 'show', JSON.stringify(sent[0]))
emit('session/event', session, { type: 'tool/result', data: { message: { callId: 'q1' } } })
check('回答后 → 推 wait-clear', sent.length === 2 && sent[1].kind === 'wait-clear', JSON.stringify(sent[1]))
emit('session/event', session, { type: 'approval/asked', data: { id: 'a1' } })
check('授权挂起 → 推 approval 泡', sent.length === 3 && sent[2].kind === 'approval', JSON.stringify(sent[2]))
emit('session/event', session, { type: 'approval/answered', data: { id: 'a1' } })
check('授权完成 → 推 wait-clear', sent.length === 4 && sent[3].kind === 'wait-clear', JSON.stringify(sent[3]))
check('挂起状态已清空', pet.wait() === null)

await new Promise((r) => setTimeout(r, 1200))
const diag = globalThis.__DSH_WUWA_PET__.diagnostics()
line('  诊断: ' + JSON.stringify(diag.link))
check('链接器在跑', diag.link.running === true)
check('applyState 可序列化', !!JSON.stringify(diag, null, 0))

if (typeof dispose === 'function') dispose()
await new Promise((r) => setTimeout(r, 300))
const after = globalThis.__DSH_WUWA_PET__.link.debug()
check('卸载后停止', after.running === false)

line(failed === 0 ? '\n全部通过' : '\n有 ' + failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)
