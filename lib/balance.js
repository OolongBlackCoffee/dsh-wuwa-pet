/**
 * 余额读取（插件宿主侧）
 *
 * 三条路，按可靠性排序（与 dsh-whale-widget 同口径，别再自创）：
 *   ① 凭据里的 DEEPSEEK_API_KEY → 官方 /user/balance（实时）
 *   ② DSH 账号登录态 → ctx.get('deepseekAccount').getBalance()（实时；**本机用户走的是这条**，没配 API key）
 *   ③ 都不行 → 账本里的 lastBalance 兜底（whale 观测到的上一次值）
 *
 * ⚠️ 两个坑（都踩过）：
 *   - credentials / deepseekAccount 都是**子 ctx 的服务**，root.get(name) 永远拿不到，
 *     必须靠 root.inject([...], ctx => …) 拿到那个子 ctx；
 *   - 子 ctx 上服务既可能是属性（ctx.credentials）也可能是 getter（ctx.get('credentials')），
 *     两条都要试 —— 只试一条会出现「服务明明在，却报宿主没有凭据服务」。
 */

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const KEY_REF = 'DEEPSEEK_API_KEY'
const ACCOUNT_TIMEOUT_MS = 6000

/** 从 balance_infos 里挑一条：优先 CNY 且有钱的那条 */
function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null
  const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
  return (
    infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
    infos.find((x) => num(x) > 0) ||
    infos.find((x) => x && x.currency === 'CNY') ||
    infos[0]
  )
}

const numOrNull = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {object} opts
 * @param {() => any[]} opts.getContexts 返回候选子 ctx 列表（root.inject 拿到的）
 * @param {number} opts.ttlMs 缓存时长
 */
export function createBalanceReader({ getContexts, ttlMs = 60000 } = {}) {
  let cache = { at: 0, value: null, error: null, source: null }
  let inFlight = null
  /** 失败后的重试时间：宿主的服务可能晚几秒才就绪，不能因为一次失败就干等一整个 TTL */
  let retryAt = 0
  /** 诊断信息：写盘后可直接看出来卡在哪一步 */
  let diag = { at: 0, route: null, error: '', notes: [] }

  function contexts() {
    try {
      const list = getContexts ? getContexts() : []
      return Array.isArray(list) ? list.filter(Boolean) : []
    } catch {
      return []
    }
  }

  /** 在候选 ctx 上找一个服务：属性 / get(name) 都试一遍 */
  function findService(name) {
    const list = contexts()
    for (const ctx of list) {
      try {
        if (ctx[name]) return ctx[name]
      } catch {}
      try {
        if (typeof ctx.get === 'function') {
          const svc = ctx.get(name)
          if (svc) return svc
        }
      } catch {}
    }
    return null
  }

  // —— 路 ①：API key ——
  async function viaApiKey() {
    const svc = findService('credentials')
    if (!svc || typeof svc.resolve !== 'function') {
      throw Object.assign(new Error('宿主没有凭据服务'), { code: 'NO_CRED_SERVICE' })
    }
    let cred = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        cred = await svc.resolve(KEY_REF)
        break
      } catch (err) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 700))
          continue
        }
        throw Object.assign(
          new Error('凭据读取失败: ' + String((err && err.message) || err).slice(0, 120)),
          { code: 'CRED_ERROR' },
        )
      }
    }
    const key = cred && (cred.value || cred.secret || cred.key)
    if (!key) throw Object.assign(new Error('没有配置 DEEPSEEK_API_KEY'), { code: 'NO_KEY' })

    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw Object.assign(new Error('余额接口 HTTP ' + res.status), { code: 'HTTP_' + res.status })
    const data = await res.json()
    const info = pickBalanceInfo(data && data.balance_infos)
    const total = info ? Number(info.total_balance) : NaN
    if (!isFinite(total)) throw Object.assign(new Error('余额接口返回结构异常'), { code: 'BAD_SHAPE' })
    return {
      balance: total,
      currency: String(info.currency || 'CNY'),
      bonus: numOrNull(info.granted_balance),
      recharge: numOrNull(info.topped_up_balance),
      source: 'apikey',
    }
  }

  // —— 路 ②：DSH 账号登录态（本机用户实际走这条）——
  async function viaAccount() {
    const account = findService('deepseekAccount')
    if (!account || typeof account.getBalance !== 'function') {
      throw Object.assign(new Error('宿主没有账号服务'), { code: 'NO_ACCOUNT_SERVICE' })
    }
    const args = {
      version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
      locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
    const result = await Promise.race([
      account.getBalance(args),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('账号余额超时'), { code: 'ACCOUNT_TIMEOUT' })), ACCOUNT_TIMEOUT_MS),
      ),
    ])
    if (!result) throw Object.assign(new Error('未登录 DeepSeek 账号'), { code: 'NOT_LOGGED_IN' })
    if (result.status !== 'ready') {
      throw Object.assign(new Error('账号余额未就绪(' + String(result.status || 'unknown') + ')'), {
        code: 'ACCOUNT_NOT_READY',
      })
    }
    // 充值钱包为空、只有赠金 —— 必须算成功（whale v781 踩过的坑）
    const norm = (Array.isArray(result.value) ? result.value : []).filter((w) => w && numOrNull(w.balance) !== null)
    const bonus = (Array.isArray(result.bonusWallets) ? result.bonusWallets : []).filter(
      (w) => w && numOrNull(w.balance) !== null,
    )
    const all = norm.concat(bonus)
    if (all.length === 0) {
      throw Object.assign(new Error('账号没有余额钱包'), { code: 'NO_WALLET' })
    }
    const curOf = (w) => String((w && w.currency) || 'CNY').toUpperCase()
    const nonzero = all.filter((w) => Number(w.balance) > 0)
    const pick = nonzero.find((w) => curOf(w) === 'CNY') || nonzero[0] || all.find((w) => curOf(w) === 'CNY') || all[0]
    const currency = curOf(pick)
    const sumOf = (list) =>
      list.filter((w) => curOf(w) === currency).reduce((s, w) => s + Number(w.balance), 0)
    const recharge = sumOf(norm)
    const bonusSum = sumOf(bonus)
    return {
      balance: Number((recharge + bonusSum).toFixed(6)),
      currency,
      bonus: Number(bonusSum.toFixed(6)),
      recharge: Number(recharge.toFixed(6)),
      source: 'account',
    }
  }

  async function fetchOnce() {
    const notes = []
    let keyErr = null
    try {
      const v = await viaApiKey()
      diag = { ...diag, at: Date.now(), route: 'apikey', error: '', notes }
      return v
    } catch (err) {
      keyErr = err
      notes.push('API key 路：' + String((err && err.message) || err).slice(0, 120))
    }
    try {
      const v = await viaAccount()
      diag = { ...diag, at: Date.now(), route: 'account', error: '', notes }
      return v
    } catch (err) {
      notes.push('账号路：' + String((err && err.message) || err).slice(0, 120))
      diag = { ...diag, at: Date.now(), route: null, error: notes.join('；'), notes }
      throw Object.assign(new Error(notes.join('；')), { code: 'BOTH_FAILED', keyCode: keyErr && keyErr.code })
    }
  }

  return {
    /** 拿余额；失败返回 null（调用方用账本兜底），绝不抛 */
    async get(force = false) {
      const now = Date.now()
      if (!force && cache.value !== null && now - cache.at < ttlMs) return cache.value
      if (!force && now < retryAt) return cache.value
      if (inFlight) return inFlight
      inFlight = fetchOnce()
        .then((v) => {
          cache = { at: Date.now(), value: v, error: null, source: v.source }
          retryAt = 0
          return v
        })
        .catch((err) => {
          // 失败也记时间戳：成功后按 ttlMs 缓存，失败后 15 秒再试一次
          cache = { at: Date.now(), value: cache.value, error: String((err && err.message) || err).slice(0, 200), source: cache.source }
          retryAt = Date.now() + 15000
          return cache.value
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
    /** 不触发请求，只读当前缓存（给高频推送用） */
    peek() {
      return cache.value
    },
    lastError() {
      return cache.error
    },
    source() {
      return cache.source
    },
    /** 服务可见性快照：服务明明在却报缺失时，先看这个 */
    inspect() {
      const list = contexts()
      const seen = {}
      for (const name of ['credentials', 'deepseekAccount', 'webServer', 'connection']) {
        let kind = 'missing'
        for (const ctx of list) {
          try {
            if (ctx[name]) kind = 'prop'
          } catch {}
          if (kind === 'missing') {
            try {
              if (typeof ctx.get === 'function' && ctx.get(name)) kind = 'get'
            } catch {}
          }
          if (kind !== 'missing') break
        }
        seen[name] = kind
      }
      return { contexts: list.length, services: seen, ...diag }
    },
    diag() {
      return diag
    },
  }
}
