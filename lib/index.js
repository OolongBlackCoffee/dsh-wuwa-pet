/**
 * dsh-wuwa-pet —— DSH 插件宿主侧入口
 *
 * 把 dsh-whale-widget 的余额/用量能力接到 WuwaTappo 桌宠身上：
 * 气泡直接长在桌宠头顶（CDP 注入），余额/今日已用/峰谷倒计时/近 7 天实时推过去，
 * 每轮对话结束弹一条「本轮 ¥x · y tok」并响一声。
 *
 * 一条硬约束（前几轮实测得出，别再试）：
 *   WuwaTappo 真正参与桌面合成的只有 `.cat-mainbox` 那个方框，框外一律被裁；
 *   所以气泡只能画在框内的头顶透明区，且不能靠「窗口坐标 + 跟随」来定位（那条路更碎）。
 *   注入点放在 .cat-mainbox 里 ⇒ 桌宠被拖动、缩放时气泡自动跟着走，不用轮询坐标。
 *
 * 依赖策略：apply() 立即执行、不写对象级 inject。宿主服务（credentials / deepseekAccount）
 * 用 root.inject 拿**子 ctx**（root.get 永远拿不到），并且全程容错：拿不到就退回账本余额。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readState, readLastEvent, files, isPeak } from './ledger.js'
import { createBalanceReader } from './balance.js'
import { createWaitTracker } from './wait.js'
import { PetLink } from './inject.js'
import { costOf } from './pricing.js'
import { normalizeLines, pickWhisperLine, whisperGapMs } from './whisper.js'
import {
  appendTurn,
  summarize as summarizeSelf,
  seedFromWhale,
  reconcileHistory,
  repairToday,
  repairDays,
  setLastBalance,
  files as selfFiles,
} from './selfledger.js'

const LOG_PREFIX = '[wuwa-pet]'
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 插件加载时确保桌宠带着调试端口：端口已开就什么都不做，没开就静默跑一次部署脚本。
 * 场景是「官方更新把补丁冲掉」——以前要用户自己去双击 bat，现在装完/升级完自动修。
 * 失败时只记日志，不打扰用户（脚本自己会写 tools\deploy-cdp.log）。
 */
function ensureCdpDeployed(cfg, log) {
  const script = path.join(ROOT_DIR, 'tools', 'deploy-cdp.ps1')
  if (!fs.existsSync(script)) {
    log('自动部署跳过：找不到 tools/deploy-cdp.ps1')
    return
  }
  let child
  try {
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Quiet',
        '-Port',
        String(cfg.cdpPort),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (err) {
    log('自动部署启动失败：' + String((err && err.message) || err))
    return
  }
  let out = ''
  const collect = (d) => {
    if (out.length < 8000) out += String(d)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const timer = setTimeout(() => {
    try {
      child.kill()
    } catch {}
    log('自动部署超时（90s）已中止，可手动跑 tools\\一键部署CDP.bat')
  }, 90000)
  timer.unref?.()
  child.on('error', (err) => {
    clearTimeout(timer)
    log('自动部署失败：' + String((err && err.message) || err))
  })
  child.on('exit', (code) => {
    clearTimeout(timer)
    const tail = out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-2)
      .join(' | ')
    if (code === 0) log('自动部署 OK' + (tail ? '：' + tail : ''))
    else log('自动部署退出码 ' + code + (tail ? '：' + tail : '') + '（可手动跑 tools\\一键部署CDP.bat）')
  })
}

const DEFAULTS = {
  cdpPort: 9222,
  tickMs: 2500,
  idleTickMs: 8000,
  balanceTtlMs: 60000,
  notifyOnTurnEnd: true,
  soundOn: true,
  volume: 0.55,
  toastMs: 5000,
  muteSubagent: true,
  // 提问（ask_user_question）/ 授权（approval）挂起时也提醒：气泡常驻到用户处理完
  notifyOnWait: true,
  waitTtlMs: 180000,
  questionTool: 'ask_user_question',
  // 插件加载时自动跑一次 tools/deploy-cdp.ps1（官方更新后给 WuwaTappo 补调试端口）
  autoDeploy: true,
  // —— 碎碎念：时不时冒一句话，停一会儿自己消失（dsh-pet 同位功能，这里改成「本地台词池」实现）——
  whisperEnabled: true,
  whisperEveryMs: 300000,
  whisperHoldMs: 9000,
  whisperJitter: 0.25,
  // 台词池：不填就用 lib/whisper.js 里的内置池（按时段挑句，零成本）
  whisperLines: [],
}

function normalizeConfig(config) {
  const cfg = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (config[k] !== undefined && config[k] !== null) cfg[k] = config[k]
    }
  }
  cfg.cdpPort = Number(cfg.cdpPort) || DEFAULTS.cdpPort
  cfg.tickMs = Math.max(800, Number(cfg.tickMs) || DEFAULTS.tickMs)
  cfg.idleTickMs = Math.max(1500, Number(cfg.idleTickMs) || DEFAULTS.idleTickMs)
  cfg.balanceTtlMs = Math.max(10000, Number(cfg.balanceTtlMs) || DEFAULTS.balanceTtlMs)
  cfg.toastMs = Math.max(1000, Number(cfg.toastMs) || DEFAULTS.toastMs)
  cfg.waitTtlMs = Math.max(10000, Number(cfg.waitTtlMs) || DEFAULTS.waitTtlMs)
  cfg.questionTool = String(cfg.questionTool || DEFAULTS.questionTool)
  cfg.volume = Math.max(0, Math.min(1, Number(cfg.volume)))
  if (!isFinite(cfg.volume)) cfg.volume = DEFAULTS.volume
  cfg.soundOn = cfg.soundOn !== false
  cfg.notifyOnTurnEnd = cfg.notifyOnTurnEnd !== false
  cfg.notifyOnWait = cfg.notifyOnWait !== false
  cfg.muteSubagent = cfg.muteSubagent !== false
  cfg.autoDeploy = cfg.autoDeploy !== false
  cfg.whisperEnabled = cfg.whisperEnabled !== false
  cfg.whisperEveryMs = Math.max(20000, Number(cfg.whisperEveryMs) || DEFAULTS.whisperEveryMs)
  cfg.whisperHoldMs = Math.max(2000, Number(cfg.whisperHoldMs) || DEFAULTS.whisperHoldMs)
  cfg.whisperJitter = Math.max(0, Math.min(0.9, Number(cfg.whisperJitter)))
  if (!isFinite(cfg.whisperJitter)) cfg.whisperJitter = DEFAULTS.whisperJitter
  cfg.whisperLines = normalizeLines(cfg.whisperLines)
  return cfg
}

export default {
  name: 'dsh-wuwa-pet',

  apply(root, config) {
    const cfg = normalizeConfig(config)
    const disposers = []
    const log = (...args) => {
      try {
        console.log(LOG_PREFIX, ...args)
      } catch {}
    }

    // —— 随插件加载自动部署：桌宠没开调试端口就补上（官方更新会冲掉补丁）——
    if (cfg.autoDeploy) {
      try {
        ensureCdpDeployed(cfg, log)
      } catch (err) {
        log('自动部署异常：' + String((err && err.message) || err))
      }
    }

    // —— 自算账本：首次运行把 whale 的历史金额补进来（只做一次，之后各记各的）——
    let selfSeeded = false
    try {
      let whaleUsage = null
      try {
        whaleUsage = JSON.parse(fs.readFileSync(files.USAGE_FILE, 'utf8'))
      } catch {}
      selfSeeded = seedFromWhale(whaleUsage)
      if (selfSeeded) log('自算账本已从 whale 账本补一次历史 -> ' + selfFiles.SELF_FILE)
      const cut = repairDays()
      if (cut > 0) log('账本已按逐轮明细重算，抹掉历史虚高 ¥' + cut.toFixed(6))
    } catch (err) {
      log('自算账本 seed 跳过：' + String((err && err.message) || err))
    }

    // —— 宿主服务：拿子 ctx ——
    // ⚠️ 必须用 root.inject 拿到「能看到子服务的 ctx」：
    //    cordis 的 ctx.get(name) 从当前 ctx 往**上**找，root 在最顶层，
    //    子 ctx 注册的服务它看不见 —— 直接 root.get('credentials') 永远是 null。
    //    第一组服务清单与 dsh-whale-widget 完全一致（webServer/credentials/connection，本机齐备）；
    //    再挂两组只等单个服务的，防止某个服务缺席导致主回调永不触发。
    const hostCtxs = []
    const queuedCtxs = []
    /** 拿到子 ctx 后要做的额外事（订阅事件），在处理函数就绪后补绑 */
    let onCtxReady = null
    const addCtx = (ctx) => {
      if (!ctx || hostCtxs.includes(ctx)) return
      hostCtxs.push(ctx)
      if (onCtxReady) {
        try {
          onCtxReady(ctx)
        } catch {}
      } else {
        queuedCtxs.push(ctx)
      }
    }
    for (const deps of [['webServer', 'credentials', 'connection'], ['credentials'], ['deepseekAccount']]) {
      try {
        if (typeof root.inject === 'function') {
          root.inject(deps, (ctx) => {
            addCtx(ctx)
            log('宿主服务就绪：' + deps.join('+'))
            // 服务晚到是常态：就绪后立刻补一次，不用等下一个 TTL
            setTimeout(() => refreshBalance(true), 0).unref?.()
          })
        }
      } catch (err) {
        log('等待服务 [' + deps.join('+') + '] 失败：' + String((err && err.message) || err))
      }
    }

    const balance = createBalanceReader({ getContexts: () => hostCtxs, ttlMs: cfg.balanceTtlMs })
    let balanceValue = null
    let balanceError = ''
    let balanceSource = null

    async function refreshBalance(force = false) {
      const v = await balance.get(force).catch(() => null)
      if (v && typeof v.balance === 'number') {
        balanceValue = v.balance
        balanceSource = v.source || null
        balanceError = ''
        // 顺手把自己的兜底余额也存下（拿不到实时值时用）
        try {
          setLastBalance(v.balance)
        } catch {}
      } else {
        balanceError = balance.lastError() || ''
        // 拿不到实时余额不算错：账本里的 lastBalance 接着用
      }
      writeDiag()
    }

    // —— 诊断落盘：重启一次 DSH 很贵，把服务可见性和两条路的失败原因直接写文件 ——
    const DIAG_FILE = path.join(ROOT_DIR, 'runtime-diag.json')
    let linkRef = null
    /** writeDiag 会早于 waitTracker 创建被调用，先给一个安全的空实现 */
    let waitRef = () => null
    function writeDiag() {
      try {
        const payload = {
          at: new Date().toISOString(),
          host: { contexts: hostCtxs.length, probe: balance.inspect() },
          balance: { value: balanceValue, source: balanceSource, error: balanceError },
          wait: waitRef(),
          link: linkRef && typeof linkRef.debug === 'function' ? linkRef.debug() : null,
          self: (() => {
            try {
              const s = summarizeSelf()
              return {
                file: selfFiles.SELF_FILE,
                seeded: !!selfSeeded,
                seededFrom: s && s.seededFrom,
                today: s && s.today,
                week: s && s.week,
                turns: s && s.turns,
                lastTurn: s && s.lastTurn,
              }
            } catch {
              return null
            }
          })(),
          note: 'host.contexts=0 → 宿主服务完全没拿到；balance.error 里带两条路各自的失败原因；self 段是自算账本的实时快照',
        }
        fs.mkdirSync(ROOT_DIR, { recursive: true })
        fs.writeFileSync(DIAG_FILE, JSON.stringify(payload, null, 2), 'utf8')
      } catch {}
    }
    // 服务就绪有先后：前 40 秒多写几次，便于事后判断「没服务」还是「没登录」
    for (const ms of [2000, 6000, 15000, 40000]) {
      const t = setTimeout(writeDiag, ms)
      t.unref?.()
    }

    // —— 每轮结算 ——
    // 两条路：① whale 及时写了账本 → 用它的金额（口径一致）；② 没等到 → 用自己算的（pricing.js）。
    // 两条都写进自算账本，key = `sid:turn`，所以迟到的那条会原地修正而不是重复记账。
    const turnAggs = new Map() // sid -> { turn, tokens, cost, model, lastTs }
    const subagentSessions = new Set()
    let lastNotifiedTs = (() => {
      const e = readLastEvent()
      return e && e.ts ? e.ts : 0
    })()

    function buildState() {
      const s = readState({
        balanceOverride: balanceValue,
        balanceSource: balanceSource || 'ledger',
      })
      if (balanceError) s.balanceError = balanceError

      // —— 自算优先 ——
      // 金额/用量一律用自算账本（每轮都记，whale 在不在都一样准）；
      // whale 的账本只留作「历史 seed 来源」和余额兜底。
      try {
        const self = summarizeSelf()
        if (self && self.ok) {
          s.ok = true
          s.today = self.today
          s.history7 = self.history7
          s.week = self.week
          s.models = self.models
          s.turnsToday = self.turns
          s.lastTurn = self.lastTurn
          s.turnFingerprint = self.turnFingerprint
          s.costSource = 'self'
          s.selfSeededFrom = self.seededFrom || null
          if (typeof s.today === 'number') s.todayUsage = s.today
        }
      } catch (err) {
        s.costSource = 'ledger'
        s.costError = String((err && err.message) || err)
      }

      s.notify = cfg.notifyOnTurnEnd
      return s
    }

    async function fireTurn(turn, tokens) {
      const ok = await link.notify({ cost: turn, tokens })
      if (!ok) log('弹泡没送到（桌宠当前没连上）')
    }

    function settleTurn(sid, attempt = 0, quiet = false) {
      const agg = turnAggs.get(sid)
      const key = agg && isFinite(agg.turn) ? sid + ':' + agg.turn : ''

      const ev = readLastEvent()
      const ts = ev && ev.ts ? ev.ts : 0
      if (ts && ts > lastNotifiedTs) {
        lastNotifiedTs = ts
        turnAggs.delete(sid)
        const cost = Number(ev.cost) || 0
        const tokens = Number(ev.tokens) || 0
        // whale 的账目也记进自算账本（同 key 覆盖此前可能写入的自算值）
        try {
          appendTurn({ key, ts, model: ev.model || (agg && agg.model) || '', cost, tokens, src: 'whale' })
        } catch (err) {
          log('写自算账本失败（whale 路）：' + String((err && err.message) || err))
        }
        if (!quiet) fireTurn(cost, tokens)
        return
      }

      // 账本还没更新（whale 不在跑 / 还在写）→ 再等一次
      if (attempt < 1) {
        const t = setTimeout(() => settleTurn(sid, attempt + 1, quiet), 900)
        t.unref?.()
        return
      }

      // 仍没有 → 自算：这一轮按模型分别计价后累加
      turnAggs.delete(sid)
      if (!agg) return
      const cost = Number(agg.cost) || 0
      const tokens = Number(agg.tokens) || 0
      if (tokens <= 0 && cost <= 0) return
      try {
        appendTurn({ key, ts: agg.lastTs || Date.now(), model: agg.model || '', cost, tokens, src: 'self' })
      } catch (err) {
        log('写自算账本失败（自算路）：' + String((err && err.message) || err))
      }
      if (!quiet) fireTurn(cost, tokens)
    }

    function onTurnEnd(sid) {
      // 子代理（子会话）的 token 同样是真金白银，必须记进账本；
      // muteSubagent 只负责「不弹泡、不打扰」，不能连记账一起跳过。
      const isSub = cfg.muteSubagent && subagentSessions.has(String(sid))
      if (!cfg.notifyOnTurnEnd && !isSub) return
      const t = setTimeout(() => settleTurn(sid, 0, isSub), 260)
      t.unref?.()
    }

    function onAssistantMessage(sid, d) {
      const turn = Number(d && d.turn)
      const usage = d && d.usage
      if (!usage || !isFinite(turn)) return
      const input = Number(usage.inputTokens) || 0
      const cache = Number(usage.cacheReadTokens) || 0
      // DSH 的 outputTokens 已经包含 reasoningTokens（dsh-token-meter 有校验），不再单加
      const output = Number(usage.outputTokens) || 0
      const toks = input + cache + output
      const model = (d.message && d.message.source && d.message.source.model) || ''
      // 峰谷按「此刻」判定，与 whale 的记账时刻口径一致
      const peak = isPeak()
      const cost = costOf({ model, cache, input, output, peak })

      const agg = turnAggs.get(sid)
      if (!agg || agg.turn !== turn) {
        turnAggs.set(sid, { turn, tokens: toks, cost, model, lastTs: Date.now() })
      } else {
        agg.tokens += toks
        agg.cost = Math.round((agg.cost + cost) * 1e9) / 1e9
        if (model) agg.model = agg.model && agg.model !== model ? agg.model : model
        agg.lastTs = Date.now()
      }
    }

    // —— 桌宠链接器 ——
    const link = new PetLink({
      port: cfg.cdpPort,
      tickMs: cfg.tickMs,
      idleTickMs: cfg.idleTickMs,
      buildState,
      getOptions: () => ({ soundOn: cfg.soundOn, volume: cfg.volume, toastMs: cfg.toastMs }),
      log,
    })
    linkRef = link

    // —— 提问 / 授权挂起：这两件事没有 turn/end，只能自己盯事件 ——
    // 命中后让气泡**常驻**（不按 toastMs 自动消失），用户处理完（tool/result、approval/*、turn/end）
    // 再由宿主发 wait-clear 收起；同时有 waitTtlMs 兜底，防止用户直接关窗后气泡粘住。
    const waitTracker = createWaitTracker({
      questionTool: cfg.questionTool,
      ttlMs: cfg.waitTtlMs,
      onShow: (w) => {
        log('等待用户交互：' + w.kind + (w.id ? ' (' + w.id + ')' : ''))
        link.notify({ kind: w.kind, action: 'show' })
        writeDiag()
      },
      onClear: (info) => {
        link.notify({ kind: 'wait-clear', expired: !!info.expired })
        writeDiag()
      },
    })
    waitRef = () => waitTracker.pending()
    const waitTimer = setInterval(() => {
      waitTracker.expire()
    }, 15000)
    waitTimer.unref?.()

    // —— 事件订阅 ——
    // ⚠️ 同时订阅在 root 和「注入得到的子 ctx」上：whale 是订阅在子 ctx 上的，
    //    cordis 的 emit 到底冒不冒泡不该靠猜。两边都订，用事件对象去重，保证只处理一次。
    const seenEvents = new WeakSet()
    const seenSubagent = new WeakSet()

    function handleSessionEvent(session, event) {
      try {
        if (!event || typeof event !== 'object') return
        if (seenEvents.has(event)) return
        seenEvents.add(event)
        const sid = (session && session.id) || 'default'
        const type = event.type
        // 挂起跟踪放在前面：它要在 turn/end「清挂起」之后才轮到弹消耗泡，
        // 顺序错了会出现「先弹消耗、再弹等待」的错位。
        if (cfg.notifyOnWait) {
          try {
            waitTracker.handle(sid, event)
          } catch {}
        }
        if (type === 'turn/end') {
          onTurnEnd(sid)
          return
        }
        if (type === 'assistant/message') onAssistantMessage(sid, event.data)
      } catch (err) {
        // 事件处理里抛错会污染 DSH 的事件总线，一律吞掉
      }
    }

    function handleSubagent(info) {
      try {
        if (!info || typeof info !== 'object') return
        if (seenSubagent.has(info)) return
        seenSubagent.add(info)
        if (info.id) subagentSessions.add(String(info.id))
      } catch {}
    }

    function handleSessionDisposed(session) {
      try {
        if (session && session.id) turnAggs.delete(session.id)
      } catch {}
    }

    const boundCtxs = new WeakSet()
    function bindEvents(ctx) {
      if (!ctx || typeof ctx.on !== 'function' || boundCtxs.has(ctx)) return
      boundCtxs.add(ctx)
      const pairs = [
        ['session/event', handleSessionEvent],
        ['session/disposed', handleSessionDisposed],
        ['subagent/start', handleSubagent],
        ['subagent/end', handleSubagent],
      ]
      for (const [name, fn] of pairs) {
        try {
          const d = ctx.on(name, fn)
          if (typeof d === 'function') disposers.push(d)
        } catch (err) {
          log('订阅 ' + name + ' 失败：' + String((err && err.message) || err))
        }
      }
    }

    // 交付出去：先绑已经到手的子 ctx，之后到的从 onCtxReady 里绑
    onCtxReady = bindEvents
    for (const c of queuedCtxs.splice(0)) bindEvents(c)
    bindEvents(root)

    // —— 定时器：余额刷新 + whale 历史对账 + 桌宠推送 ——
    refreshBalance(true)
    const balanceTimer = setInterval(() => {
      refreshBalance(false)
    }, cfg.balanceTtlMs)
    balanceTimer.unref?.()

    // whale 若还在跑，它会继续把自己那本账补全（本进程是中途接管的），
    // 每 60 秒跟它对一次历史，只升不降，保证两边「今日已用」不会一直差一点。
    const reconcileTimer = setInterval(() => {
      try {
        const raw = fs.readFileSync(files.USAGE_FILE, 'utf8')
        const changed = reconcileHistory(JSON.parse(raw))
        if (changed) log('与 whale 账本对账：抬高 ' + changed + ' 天金额')
      } catch {}
    }, 60000)
    reconcileTimer.unref?.()

    // —— 碎碎念：到点挑一句推给桌宠，气泡自己停一会儿再消失 ——
    // 为什么用「短 tick + 自己算下一次时间」而不是一个大 setInterval：
    // ① 想加抖动（避免整点打卡）就必须每次重算间隔；
    // ② 摊上「挂起气泡/面板展开/正在输入」时页面会说 false，需要早点再试而不是白等一整个周期。
    const whisperStat = { shown: 0, skipped: 0, nextAt: 0, last: '' }
    let whisperTimer = null
    let whisperNextAt = 0
    const scheduleWhisper = (first) => {
      if (!cfg.whisperEnabled) return
      const gap = first ? Math.min(60000, Math.max(15000, cfg.whisperEveryMs / 4)) : whisperGapMs(cfg.whisperEveryMs, cfg.whisperJitter)
      whisperNextAt = Date.now() + gap
      whisperStat.nextAt = whisperNextAt
    }
    const whisperTick = async () => {
      if (!cfg.whisperEnabled) return
      if (Date.now() < whisperNextAt) return
      const text = pickWhisperLine(Date.now(), whisperStat.last, cfg.whisperLines)
      let ok = false
      try {
        ok = await link.notify({ kind: 'whisper', text, holdMs: cfg.whisperHoldMs })
      } catch {}
      if (ok) {
        whisperStat.shown++
        whisperStat.last = text
        scheduleWhisper(false)
      } else {
        // 此刻不方便说（挂起/面板/输入中）——35 秒后再看，别把一个周期等满
        whisperStat.skipped++
        whisperNextAt = Date.now() + 35000
        whisperStat.nextAt = whisperNextAt
      }
    }
    if (cfg.whisperEnabled) {
      scheduleWhisper(true)
      whisperTimer = setInterval(() => {
        whisperTick()
      }, 15000)
      whisperTimer.unref?.()
    }

    link.start()

    // 卸载时把定时器、CDP 连接、事件订阅全部收干净
    const disposeAll = () => {
      try {
        clearInterval(balanceTimer)
      } catch {}
      try {
        clearInterval(reconcileTimer)
      } catch {}
      try {
        clearInterval(waitTimer)
      } catch {}
      try {
        if (whisperTimer) clearInterval(whisperTimer)
      } catch {}
      try {
        link.stop()
      } catch {}
      for (const d of disposers) {
        try {
          d()
        } catch {}
      }
      disposers.length = 0
    }
    try {
      if (typeof root.effect === 'function') root.effect(() => disposeAll)
      else disposers.push(disposeAll)
    } catch {
      disposers.push(disposeAll)
    }

    // 给 DSH 控制台/开发者工具留一个诊断入口
    try {
      globalThis.__DSH_WUWA_PET__ = {
        config: cfg,
        link,
        balance: () => ({ value: balanceValue, source: balanceSource, error: balanceError }),
        state: buildState,
        wait: () => waitTracker.pending(),
        whisper: () => ({ enabled: cfg.whisperEnabled, every: cfg.whisperEveryMs, hold: cfg.whisperHoldMs, ...whisperStat }),
        files,
        self: () => summarizeSelf(),
        selfFile: selfFiles.SELF_FILE,
        diagFile: DIAG_FILE,
        diagnostics: () => ({
          config: cfg,
          link: link.debug(),
          balance: { value: balanceValue, source: balanceSource, error: balanceError },
          host: balance.inspect(),
          wait: waitTracker.pending(),
          ledger: files.USAGE_FILE,
          selfLedger: selfFiles.SELF_FILE,
          self: summarizeSelf(),
      costAudit: (() => {
        try {
          const us = JSON.parse(fs.readFileSync(files.USAGE_FILE, 'utf8'))
          const sObj = summarizeSelf()
          const wall = Number(us && us.todayUsage)
          const ev = Number(sObj.today) || 0
          return {
            todayEvents: ev,
            todayWalletDelta: isFinite(wall) ? Math.round(wall * 1e6) / 1e6 : null,
            diff: isFinite(wall) ? Math.round((wall - ev) * 1e6) / 1e6 : null,
            note: '钱包差额含子代理与其它窗口花费，故通常略大于逐轮合计；今日金额以逐轮为准',
          }
        } catch (err) {
          return { error: String((err && err.message) || err) }
        }
      })(),
          lastNotifiedTs,
        }),
      }
    } catch {}

    log(
      '已加载：CDP ' +
        cfg.cdpPort +
        ' · 自算账本 ' +
        selfFiles.SELF_FILE +
        ' · whale 账本 ' +
        files.USAGE_FILE +
        ' · 诊断 ' +
        DIAG_FILE,
    )
  },
}
