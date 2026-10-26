/**
 * 桌宠链接器（插件宿主侧）
 *
 * 干三件事：
 *   1. 等 WuwaTappo 出现 → 通过 CDP(9222) 连上它的桌宠页；
 *   2. 往页面里注入 widget.js（页面重载 / 节点被清掉会自动补回来）；
 *   3. 每 tickMs 把最新状态推给页面，另有 notify() 用于「每轮结束」即时弹泡。
 *
 * 设计上刻意**不注册任何 HTTP 路由**：数据走 CDP 推过去，页面侧一个网络请求都不发，
 * 于是不用关心 DSH 的端口、不用处理跨源，也不用和别的插件抢路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attach } from './cdp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..')

/** 读一次注入脚本，进程内缓存 */
let widgetSource = ''
function readWidgetSource() {
  if (widgetSource) return widgetSource
  widgetSource = fs.readFileSync(path.join(__dirname, 'widget.js'), 'utf8')
  return widgetSource
}

/**
 * 页面侧版本号 —— **必须与 widget.js 里的 VERSION 一致**（self-check 会核对）。
 * 桌宠页面是长活的：DSH 重启不会重载它，所以插件升级后页面里还是旧版气泡，
 * 而 widget.js 开头的 `mounted` 守卫会让新版 eval 空转。靠这个版本号发现错配并自动重装。
 */
export const WIDGET_VERSION = '1.1.0'

/** 提示音转成 data URL：桌宠页面的 origin 是 tauri.localhost，走不了相对路径 */
const SOUND_FILES = {
  turn: 'turn-end.wav',
  question: 'ask.wav',
  approval: 'approve.wav',
}
const soundCache = new Map()
function readSoundDataUrl(kind) {
  const file = SOUND_FILES[kind]
  if (!file) return ''
  if (soundCache.has(kind)) return soundCache.get(kind)
  let v = ''
  try {
    const bytes = fs.readFileSync(path.join(PACKAGE_ROOT, 'assets', file))
    v = 'data:audio/wav;base64,' + bytes.toString('base64')
  } catch {
    v = ''
  }
  soundCache.set(kind, v)
  return v
}

/**
 * 只认桌宠本体页，别的路由（#/panel、#/toast、#/about、#/login…）一律排除。
 * 注意：判定函数收到的参数是 **target 对象**，不是 url 字符串 —— 上一版把它当字符串用，
 * String(target) === '[object Object]'，于是全都"匹配"到了列表第一个（#/about），
 * 注入进了一个看不见的窗口，表现就是「日志说注入成功、桌面啥也没有」。
 */
function isPetTarget(target) {
  const s = String((target && target.url) || '')
  if (/#\/[a-z0-9_-]+/i.test(s)) return false // #/about、#/panel、#/toast…
  return true // #/、#、或无 hash 的裸页面
}

export class PetLink {
  /**
   * @param {object} opts
   * @param {number} opts.port CDP 端口
   * @param {number} opts.tickMs 连上后的推送间隔
   * @param {number} opts.idleTickMs 没连上时的探测间隔
   * @param {() => object} opts.buildState 组装要推给页面的状态
   * @param {() => object} opts.getOptions 声音/时长等前端选项
   * @param {(...a:any[])=>void} [opts.log]
   */
  constructor({ port = 9222, tickMs = 2500, idleTickMs = 8000, buildState, getOptions, log } = {}) {
    this.port = port
    this.tickMs = Math.max(800, tickMs)
    this.idleTickMs = Math.max(1500, idleTickMs)
    this.buildState = buildState || (() => ({}))
    this.getOptions = getOptions || (() => ({}))
    this.log = log || (() => {})

    this.session = null
    this.stopped = true
    this.timer = null
    this.connected = false
    /** 上一次探测结果，用来只在状态翻转时打日志，避免刷屏 */
    this.lastProbe = null
    this.injectedCount = 0
    this.pushedCount = 0
    this.lastError = ''
    this.lastPushAt = 0
    /** 已成功注入的提示音种类（turn / question / approval） */
    this.soundsReady = []
    /** notify 串行队列：wait-clear 必须在随后的 turn 泡之前落地，否则顺序会错 */
    this.notifyChain = Promise.resolve()
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.loop()
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.close()
  }

  close() {
    if (this.session) {
      try {
        this.session.close()
      } catch {}
    }
    this.session = null
    this.connected = false
  }

  noteError(err) {
    const msg = String((err && err.message) || err).slice(0, 200)
    if (msg !== this.lastError) {
      this.lastError = msg
      this.log('连接出错：' + msg)
    }
  }

  async loop() {
    if (this.stopped) return
    let delay = this.tickMs
    try {
      if (!this.session) {
        const ok = await this.connect()
        delay = ok ? 200 : this.idleTickMs
      }
      if (this.session) {
        await this.pump()
      }
    } catch (err) {
      this.noteError(err)
      this.close()
      delay = this.idleTickMs
    }
    if (this.stopped) return
    this.timer = setTimeout(() => this.loop(), delay)
    this.timer.unref?.()
  }

  async connect() {
    let info = null
    try {
      info = await attach(isPetTarget, this.port)
    } catch (err) {
      // 端口没开 = 桌宠没启动 / 没打补丁，属于正常状态，不当作错误刷日志
      if (this.lastProbe !== 'offline') {
        this.lastProbe = 'offline'
        this.log('没连上桌宠（CDP ' + this.port + ' 未开放）——桌宠启动后会自动连上')
      }
      return false
    }
    if (!info) {
      if (this.lastProbe !== 'no-page') {
        this.lastProbe = 'no-page'
        this.log('调试端口开了，但还没出现桌宠页面，继续等')
      }
      return false
    }
    this.session = info.session
    this.targetUrl = info.target.url
    this.targetId = info.target.id
    this.connected = true
    this.lastProbe = 'online'
    this.lastError = ''
    this.log('已连上桌宠页面 ' + this.targetUrl)
    await this.inject()
    return true
  }

  /** 拆掉页面里的旧气泡（先停看门狗，再删所有节点，最后清全局对象） */
  async teardown() {
    if (!this.session) return false
    try {
      return await this.session.eval(
        '(function(){' +
          // 1) 停掉这一代（以及更早各代）的 MutationObserver / 定时器，否则它们会把旧节点挂回来
          'try{if(typeof window.__DSHW_PET_STOP__==="function")window.__DSHW_PET_STOP__()}catch(e){}' +
          // 2) 兜底：把所有残留节点都删掉（历史上可能已经叠了不止一个）
          'var ns=document.querySelectorAll("#dshw-root");for(var i=0;i<ns.length;i++){var n=ns[i];if(n.parentNode)n.parentNode.removeChild(n)}' +
          'var s=document.getElementById("dshw-style");if(s&&s.parentNode)s.parentNode.removeChild(s);' +
          'try{delete window.__DSHW_PET__}catch(e){window.__DSHW_PET__=undefined}' +
          'return document.querySelectorAll("#dshw-root").length' +
          '})()'
      )
    } catch {
      return false
    }
  }

  /**
   * 注入脚本 + 声音 + 选项；页面重载后靠这里恢复。
   * force=true 或页面里版本对不上时，先拆掉旧实例 —— 否则 widget.js 的 mounted 守卫会空转。
   */
  async inject(force = false) {
    if (!this.session) return false
    const ver = await this.session.eval(
      '(function(){var p=window.__DSHW_PET__;return p&&p.mounted?(p.version||"?"):""})()'
    )
    if (force || (ver && ver !== WIDGET_VERSION)) {
      this.log('页面里是旧版气泡 ' + (ver || '(无)') + '，先拆掉再注入 ' + WIDGET_VERSION)
      await this.teardown()
    }
    const src = readWidgetSource()
    await this.session.eval(src)
    const check = await this.session.eval(
      '(function(){var p=window.__DSHW_PET__;return JSON.stringify({t:typeof p,ver:p&&p.version,' +
        'href:location.href,host:document.querySelector(".cat-mainbox")?"yes":"no"})})()'
    )
    this.log('注入回读: ' + check)
    const sounds = {
      turn: readSoundDataUrl('turn'),
      question: readSoundDataUrl('question'),
      approval: readSoundDataUrl('approval'),
    }
    this.soundsReady = []
    // 声音/选项都做容错：页面里万一还是旧 API，也不能把整条链接搞断
    for (const [fn, arg] of [
      ['setSounds', sounds],
      ['setOptions', this.getOptions() || {}],
    ]) {
      try {
        await this.session.eval(
          '(function(){var p=window.__DSHW_PET__;if(!p||typeof p.' + fn + '!=="function")return 0;p.' +
            fn + '(' + JSON.stringify(arg) + ');return 1})()'
        )
        if (fn === 'setSounds') this.soundsReady = Object.keys(sounds).filter((k) => !!sounds[k])
      } catch (err) {
        this.log(fn + ' 失败（页面里可能是旧版气泡）：' + String((err && err.message) || err))
      }
    }
    this.injectedCount++
    this.log('气泡已注入（累计 ' + this.injectedCount + ' 次）')
    return true
  }

  async pump() {
    const state = this.buildState() || {}
    const json = JSON.stringify(state)
    // 一次往返同时完成「存活检查 + 推送」：返回 0 代表页面里的挂件没了（重载过）
    const alive = await this.session.eval(
      '(function(){var p=window.__DSHW_PET__;if(!p||!p.mounted)return 0;' +
        'try{p.applyState(' + json + ')}catch(e){return 0}return 1})()'
    )
    if (!alive) {
      await this.inject()
      const retry = await this.session.eval(
        '(function(){var p=window.__DSHW_PET__;if(!p||!p.mounted)return 0;' +
          'try{p.applyState(' + json + ')}catch(e){return 0}return 1})()'
      )
      if (!retry) return
    }
    this.pushedCount++
    this.lastPushAt = Date.now()
  }

  /**
   * 推一条气泡通知。payload 形如：
   *   { cost, tokens }                                  每轮消耗（默认）
   *   { kind: 'question' | 'approval', action: 'show' } 提问 / 授权挂起（气泡常驻）
   *   { kind: 'wait-clear' }                            用户已处理，收起挂起气泡
   * 串行执行：宿主可能连发 wait-clear + 消耗泡，反过来就会看到「已处理的提示又亮一下」。
   */
  notify(payload) {
    const run = () => this._notify(payload)
    this.notifyChain = this.notifyChain.then(run, run)
    return this.notifyChain
  }

  async _notify(payload) {
    if (!this.session) return false
    try {
      const json = JSON.stringify(payload || {})
      const r = await this.session.eval(
        '(function(){var p=window.__DSHW_PET__;if(!p||!p.mounted)return 0;p.notify(' + json + ');return 1})()'
      )
      return !!r
    } catch (err) {
      this.noteError(err)
      this.close()
      return false
    }
  }

  /** 供 DSH 侧诊断用 */
  debug() {
    return {
      port: this.port,
      connected: this.connected,
      injectedCount: this.injectedCount,
      pushedCount: this.pushedCount,
      lastPushAgoMs: this.lastPushAt ? Date.now() - this.lastPushAt : null,
      lastProbe: this.lastProbe,
      lastError: this.lastError,
      soundsReady: this.soundsReady,
      running: !this.stopped,
    }
  }
}
