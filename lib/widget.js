/**
 * 桌宠气泡（页面侧，注入到 WuwaTappo 的桌宠页面里跑）
 *
 * 关键约束（上一轮实测结论，别再踩）：
 *   WuwaTappo 的主窗口虽是全屏分层窗口，但**真正参与桌面合成的只有 `.cat-mainbox`
 *   那一个方框**（随 petScale 缩放）。框外的 DOM 画得出来、页面自截图也有，
 *   可一旦合成到桌面就被裁掉 —— 所以所有 UI 必须留在框内，且不能用负偏移。
 *
 * 因此气泡做成「压在桌宠头顶透明区的一条横条」，宽度 calc(100% - 6px) 跟着缩放走，
 * 展开面板只占框内上半部分，不挡脸。
 *
 * 数据全由宿主（DSH 插件）用 CDP 推送过来，页面侧**不发一个网络请求**：
 *   window.__DSHW_PET__.applyState(state)      每 2.5 秒推一次
 *   window.__DSHW_PET__.notify({cost,tokens})  每轮结束时推一次
 *   window.__DSHW_PET__.notify({kind:'question'|'approval'})  提问/授权挂起，气泡常驻
 *   window.__DSHW_PET__.notify({kind:'wait-clear'})           用户已处理，收起
 *   window.__DSHW_PET__.setSounds({turn,question,approval})   注入时各给一次提示音
 */
;(function () {
  if (window.__DSHW_PET__ && window.__DSHW_PET__.mounted) return

  /**
   * 页面是长活的：DSH 重启、插件升级都不会重载它，所以同一个页面里可能先后跑过好几代脚本。
   * 旧一代的 MutationObserver / setInterval 会在节点被拆掉后**把旧节点重新挂回来**
   * （实测：连着重注入两次，页面上出现 3 个气泡，点击命中错的那一个）。
   * 因此每一代都把自己的清理函数登记到 window.__DSHW_PET_STOP__，并链式调用上一代的。
   */
  var PREV_STOP = typeof window.__DSHW_PET_STOP__ === 'function' ? window.__DSHW_PET_STOP__ : null
  var stopped = false
  var loopTimer = null

  function stopSelf() {
    if (stopped) return
    stopped = true
    try {
      clearInterval(loopTimer)
    } catch (e) {}
    try {
      clearInterval(tickTimer)
    } catch (e) {}
    try {
      clearTimeout(toastTimer)
    } catch (e) {}
    try {
      clearTimeout(waitTimer)
    } catch (e) {}
    try {
      mo.disconnect()
    } catch (e) {}
    try {
      if (el.root && el.root.parentNode) el.root.parentNode.removeChild(el.root)
    } catch (e) {}
  }

  window.__DSHW_PET_STOP__ = function () {
    if (PREV_STOP) {
      try {
        PREV_STOP()
      } catch (e) {}
    }
    stopSelf()
  }

  var VERSION = '1.2.0'
  var OFFLINE_AFTER_MS = 15000
  /** 挂起气泡的兜底寿命：宿主那边同样有 waitTtlMs，双保险 */
  var WAIT_MAX_MS = 180000

  var state = null
  var lastPushAt = 0
  var panelOpen = false
  var toastTimer = null
  /** 碎碎念：停留计时 + 淡出后清节点的计时（两个分开，避免淡出时被下一次覆盖） */
  var whisperTimer = null
  var whisperOutTimer = null
  var whisperShown = 0
  var whisperLast = ''
  var sounds = { turn: '', question: '', approval: '' }
  var audioByKind = {}
  var soundOn = true
  var volume = 0.55
  var toastMs = 5000
  var tickTimer = null
  var waitKind = null
  var waitTimer = null

  var CSS = [
    '.dshw-root{position:absolute;left:50%;top:1px;transform:translateX(-50%);',
    'z-index:2147483000;pointer-events:none;display:flex;flex-direction:column;align-items:center;',
    'width:calc(100% - 6px);font-family:"HarmonyOS Sans SC","Microsoft YaHei",system-ui,sans-serif}',
    '.dshw-root *{box-sizing:border-box}',
    '.dshw-bar{pointer-events:auto;display:flex;align-items:center;justify-content:center;gap:5px;',
    'height:22px;max-width:100%;padding:0 8px;border-radius:11px;overflow:hidden;',
    'background:rgba(255,255,255,.95);border:1px solid rgba(77,107,254,.28);',
    'box-shadow:0 2px 8px rgba(20,30,70,.18);font-size:11px;line-height:1;color:#1c2541;',
    'cursor:pointer;user-select:none;white-space:nowrap;transition:transform .14s ease}',
    '.dshw-bar:hover{transform:scale(1.03)}',
    '.dshw-bar:active{transform:scale(.97)}',
    '.dshw-whale{font-size:12px}',
    '.dshw-bal{font-weight:700;color:#4d6bfe;font-variant-numeric:tabular-nums}',
    '.dshw-sep{width:1px;height:9px;background:rgba(28,37,65,.16);flex:none}',
    '.dshw-sub{color:#5b6478;font-variant-numeric:tabular-nums}',
    '.dshw-dot{width:5px;height:5px;border-radius:50%;background:#22c55e;flex:none}',
    '.dshw-dot.peak{background:#f59e0b}',
    '.dshw-dim .dshw-bal{color:#98a1b3}',
    '.dshw-err{color:#dc2626;font-size:10px}',

    '.dshw-panel{pointer-events:auto;display:none;width:100%;padding:7px 8px;border-radius:12px;',
    'background:rgba(255,255,255,.97);border:1px solid rgba(77,107,254,.24);',
    'box-shadow:0 6px 18px rgba(20,30,70,.24);color:#1c2541;font-size:10px;line-height:1.25}',
    '.dshw-panel.open{display:block}',
    '.dshw-ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px}',
    '.dshw-title{font-weight:600;font-size:10px;display:flex;align-items:center;gap:3px}',
    '.dshw-x{cursor:pointer;color:#98a1b3;font-size:11px;line-height:1;padding:0 2px}',
    '.dshw-x:hover{color:#1c2541}',
    '.dshw-row{display:flex;align-items:center;justify-content:space-between;color:#5b6478}',
    '.dshw-row b{color:#1c2541;font-variant-numeric:tabular-nums;font-weight:700}',
    '.dshw-big{font-size:15px;font-weight:700;color:#4d6bfe;font-variant-numeric:tabular-nums;letter-spacing:-.3px}',
    '.dshw-big small{font-size:9px;font-weight:500;color:#8a93a6;margin-left:3px;letter-spacing:0}',
    '.dshw-bars{display:flex;align-items:flex-end;gap:2px;height:22px;margin:4px 0 2px}',
    '.dshw-barcol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}',
    '.dshw-barcol i{display:block;width:100%;border-radius:2px 2px 0 0;background:linear-gradient(180deg,#8aa0ff,#4d6bfe);min-height:2px}',
    '.dshw-days{display:flex;gap:2px}',
    '.dshw-days span{flex:1;text-align:center;font-size:7px;color:#a5adbd;transform:scale(.9);white-space:nowrap}',
    '.dshw-foot{margin-top:3px;font-size:8px;color:#a5adbd;display:flex;justify-content:space-between}',

    '.dshw-toast{pointer-events:none;display:none;align-items:center;justify-content:center;',
    'height:22px;max-width:100%;padding:0 9px;border-radius:11px;overflow:hidden;',
    'background:rgba(28,37,65,.94);color:#fff;font-size:10px;white-space:nowrap;',
    'box-shadow:0 3px 10px rgba(0,0,0,.3)}',
    '.dshw-toast.show{display:flex}',
    '.dshw-toast b{color:#aebfff;font-variant-numeric:tabular-nums}',
    // 提问/授权挂起：换成琥珀色 + 呼吸光晕，和「每轮消耗」一眼区分开
    '.dshw-toast.wait{background:linear-gradient(90deg,#d97706,#f59e0b);animation:dshw-wait 1.6s ease-in-out infinite}',
    '.dshw-toast.wait b{color:#fff8e1;font-weight:700}',
    '@keyframes dshw-wait{0%,100%{box-shadow:0 3px 10px rgba(0,0,0,.3)}50%{box-shadow:0 0 0 4px rgba(245,158,11,.34)}}',

    // 碎碎念：独立的一只小气泡（不复用消耗泡/挂起泡的节点，否则会互相挤掉）——
    // 出现时淡入 + 轻轻上浮，到点自己淡出并清空，绝不常驻。
    '.dshw-whisper{pointer-events:auto;position:relative;display:none;max-width:92%;margin:3px 0 2px;',
    'padding:5px 10px;border-radius:11px;background:rgba(255,255,255,.97);',
    'border:1px solid rgba(77,107,254,.36);box-shadow:0 3px 10px rgba(20,30,70,.2);',
    'color:#1c2541;font-size:10.5px;line-height:1.35;text-align:center;white-space:pre-wrap;',
    'opacity:0;transform:translateY(6px);transition:opacity .26s ease,transform .26s ease;',
    'will-change:opacity,transform;cursor:pointer}',
    '.dshw-whisper.show{display:block;opacity:1;transform:translateY(0)}',
    '.dshw-whisper.out{display:block;opacity:0;transform:translateY(-5px);',
    'transition:opacity .34s ease,transform .34s ease}',
    '.dshw-whisper::after{content:"";position:absolute;left:50%;bottom:-5px;width:8px;height:8px;',
    'transform:translateX(-50%) rotate(45deg);background:rgba(255,255,255,.97);',
    'border-right:1px solid rgba(77,107,254,.36);border-bottom:1px solid rgba(77,107,254,.36)}',
  ].join('\n')

  function money(v) {
    if (v === null || v === undefined || isNaN(v)) return '—'
    return Number(v).toFixed(2)
  }
  function tok(v) {
    if (!v) return '0'
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
    return String(v)
  }
  function pad(n) {
    return String(n).padStart(2, '0')
  }
  function hhmmss(sec) {
    if (sec === null || sec === undefined) return '—'
    sec = Math.max(0, Math.round(sec))
    var h = Math.floor(sec / 3600)
    var m = Math.floor((sec % 3600) / 60)
    var s = sec % 60
    return h > 0 ? pad(h) + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s)
  }

  function playSound(kind) {
    if (!soundOn) return
    kind = kind || 'turn'
    var url = sounds[kind] || ''
    if (!url) return
    try {
      var a = audioByKind[kind]
      if (!a) {
        a = new Audio(url)
        audioByKind[kind] = a
      }
      a.volume = Math.max(0, Math.min(1, volume))
      a.currentTime = 0
      var p = a.play()
      if (p && p.catch) p.catch(function () {})
    } catch (e) {}
  }

  var el = {}

  function build() {
    var style = document.getElementById('dshw-style')
    if (!style) {
      style = document.createElement('style')
      style.id = 'dshw-style'
      document.head.appendChild(style)
    }
    style.textContent = CSS

    var root = document.createElement('div')
    root.className = 'dshw-root'
    root.id = 'dshw-root'
    root.innerHTML =
      '<div class="dshw-panel" id="dshw-panel">' +
      '<div class="dshw-ph"><div class="dshw-title">🐋 小鲸鱼</div><div class="dshw-x" id="dshw-x">✕</div></div>' +
      '<div class="dshw-row"><span class="dshw-big" id="dshw-p-bal">—<small>余额</small></span><b id="dshw-p-today">—</b></div>' +
      '<div class="dshw-row" style="margin-top:2px"><span id="dshw-p-peaklabel">时段</span><b id="dshw-p-peak">—</b></div>' +
      '<div class="dshw-bars" id="dshw-p-bars"></div>' +
      '<div class="dshw-days" id="dshw-p-days"></div>' +
      '<div class="dshw-foot"><span id="dshw-p-week">近7天 —</span><span id="dshw-p-turns">0 轮</span></div>' +
      '</div>' +
      '<div class="dshw-toast" id="dshw-toast"></div>' +
      '<div class="dshw-whisper" id="dshw-whisper"></div>' +
      '<div class="dshw-bar" id="dshw-bar">' +
      '<span class="dshw-whale">🐋</span>' +
      '<span class="dshw-bal" id="dshw-c-bal">连接中</span>' +
      '<span class="dshw-sep"></span>' +
      '<span class="dshw-sub" id="dshw-c-today">今日 —</span>' +
      '<span class="dshw-dot" id="dshw-c-dot"></span>' +
      '</div>'

    el.root = root
    el.bar = root.querySelector('#dshw-bar')
    el.panel = root.querySelector('#dshw-panel')
    el.toast = root.querySelector('#dshw-toast')
    el.whisper = root.querySelector('#dshw-whisper')
    el.cBal = root.querySelector('#dshw-c-bal')
    el.cToday = root.querySelector('#dshw-c-today')
    el.cDot = root.querySelector('#dshw-c-dot')
    el.pBal = root.querySelector('#dshw-p-bal')
    el.pToday = root.querySelector('#dshw-p-today')
    el.pPeakLabel = root.querySelector('#dshw-p-peaklabel')
    el.pPeak = root.querySelector('#dshw-p-peak')
    el.pBars = root.querySelector('#dshw-p-bars')
    el.pDays = root.querySelector('#dshw-p-days')
    el.pWeek = root.querySelector('#dshw-p-week')
    el.pTurns = root.querySelector('#dshw-p-turns')

    el.bar.addEventListener('click', function (e) {
      e.stopPropagation()
      e.preventDefault()
      panelOpen = !panelOpen
      el.panel.classList.toggle('open', panelOpen)
      el.bar.style.display = panelOpen ? 'none' : 'flex'
      render()
    })
    root.querySelector('#dshw-x').addEventListener('click', function (e) {
      e.stopPropagation()
      panelOpen = false
      el.panel.classList.remove('open')
      el.bar.style.display = 'flex'
    })
    // 碎碎念：点一下可以提前收起（不想看就随时赶走）
    if (el.whisper) {
      el.whisper.addEventListener('click', function (e) {
        e.stopPropagation()
        hideWhisper()
      })
    }
    // 桌宠自己是可拖动的：不拦的话在气泡上按住会把整只桌宠拖走
    ;['click', 'pointerdown', 'mousedown', 'dblclick', 'contextmenu'].forEach(function (t) {
      root.addEventListener(t, function (e) {
        e.stopPropagation()
      })
    })
  }

  function mountPoint() {
    // 只认 .cat-mainbox：它是唯一真正参与桌面合成的容器
    return (
      document.querySelector('.cat-mainbox') ||
      document.querySelector('.pet-dock-content') ||
      document.querySelector('.pet-dock')
    )
  }

  /**
   * 清掉**别人**留下的气泡节点。
   * 老一代（v1.0.0 及以前）没有 STOP 机制，它的看门狗会把自己的节点反复挂回来 ——
   * 新版只能一遍遍把它删掉（每次间隔 1.5s 级别的拉锯，视觉上不可见）。
   */
  var lastSweep = 0
  function sweepStrays(force) {
    var now = Date.now()
    if (!force && now - lastSweep < 1000) return
    lastSweep = now
    try {
      var ns = document.querySelectorAll('#dshw-root')
      for (var i = 0; i < ns.length; i++) {
        var n = ns[i]
        if (n !== el.root && n.parentNode) n.parentNode.removeChild(n)
      }
    } catch (e) {}
  }

  function ensureMounted() {
    if (stopped) return false
    if (!el.root) build()
    var host = mountPoint()
    if (!host) return false
    if (el.root.parentElement !== host) host.appendChild(el.root)
    sweepStrays(true)
    return true
  }

  function render() {
    if (!el.root) return
    if (!state || !state.ok) {
      el.cBal.className = 'dshw-err'
      el.cBal.textContent = state && state.ok === false ? '未读到账本' : '连接中'
      el.cToday.textContent = ''
      el.cDot.style.display = 'none'
      if (panelOpen) el.pBal.innerHTML = '—<small>余额</small>'
      return
    }
    var offline = lastPushAt > 0 && Date.now() - lastPushAt > OFFLINE_AFTER_MS
    el.root.classList.toggle('dshw-dim', offline)

    el.cBal.className = 'dshw-bal'
    el.cDot.style.display = ''
    var bal = state.balance
    el.cBal.textContent = bal === null || bal === undefined ? '未观测' : '¥' + money(bal)
    el.cToday.textContent = '今日 ¥' + money(state.today)
    el.cDot.className = 'dshw-dot' + (state.peak && state.peak.isPeak ? ' peak' : '')

    if (!panelOpen) return
    el.pBal.innerHTML = (bal === null || bal === undefined ? '—' : '¥' + money(bal)) + '<small>余额</small>'
    el.pToday.textContent = '今日 ¥' + money(state.today)
    el.pPeakLabel.textContent = (state.peak ? state.peak.label : '时段') + ' · 距切换'
    el.pPeak.textContent = state.peak ? hhmmss(state.peak.nextChangeInSec) : '—'

    var h = state.history7 || []
    var max = Math.max.apply(
      null,
      h.map(function (d) {
        return d.cost || 0
      }).concat([0.01])
    )
    var sum = state.week !== undefined ? state.week : h.reduce(function (a, d) {
      return a + (d.cost || 0)
    }, 0)
    el.pWeek.textContent = '近7天 ¥' + money(sum)
    el.pTurns.textContent = (state.turnsToday || 0) + ' 轮'
    el.pBars.innerHTML = h
      .map(function (d) {
        var pct = Math.max(6, Math.round(((d.cost || 0) / max) * 100))
        return '<div class="dshw-barcol" title="' + d.day + ' ¥' + money(d.cost) + '"><i style="height:' + pct + '%"></i></div>'
      })
      .join('')
    el.pDays.innerHTML = h
      .map(function (d) {
        return '<span>' + String(d.day).slice(8) + '</span>'
      })
      .join('')
  }

  /**
   * @param {string} html
   * @param {number} ms 0 = 不自动收起（挂起气泡用）
   * @param {string} [cls] 额外样式（'wait'）
   */
  function showToast(html, ms, cls) {
    if (!el.toast) return
    el.toast.className = 'dshw-toast' + (cls ? ' ' + cls : '') + ' show'
    el.toast.innerHTML = html
    el.bar.style.display = 'none'
    clearTimeout(toastTimer)
    if (!ms || ms <= 0) return
    toastTimer = setTimeout(hideToast, ms)
  }

  function hideToast() {
    clearTimeout(toastTimer)
    if (!el.toast) return
    el.toast.className = 'dshw-toast'
    if (!panelOpen && el.bar) el.bar.style.display = 'flex'
  }

  /**
   * 碎碎念：冒一只小气泡，停留 holdMs 后自己淡出并清空。
   * 返回 false 表示「此刻不合适」，宿主据此改用更短的间隔重试（而不是白等一个周期）。
   * 不合适的场合：挂起气泡在（提问/授权）、面板展开、用户正在输入框里打字。
   */
  function showWhisper(text, holdMs) {
    if (!el.whisper) return false
    var t = String(text == null ? '' : text).trim()
    if (!t) return false
    if (waitKind) return false
    if (panelOpen) return false
    var ae = document.activeElement
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return false
    clearTimeout(whisperTimer)
    clearTimeout(whisperOutTimer)
    whisperLast = t
    whisperShown++
    el.whisper.textContent = '🐋 ' + t
    el.whisper.className = 'dshw-whisper'
    // 先让 display:block 生效（读取一次布局），下一帧再加 show，过渡才会真正播放
    void el.whisper.offsetWidth
    el.whisper.className = 'dshw-whisper show'
    var hold = Number(holdMs) > 0 ? Number(holdMs) : 9000
    whisperTimer = setTimeout(hideWhisper, hold)
    return true
  }

  /** 收起碎碎念：先淡出，动画结束再真正清空节点（否则内容会「啪」地消失） */
  function hideWhisper() {
    clearTimeout(whisperTimer)
    whisperTimer = null
    if (!el.whisper) return
    el.whisper.className = 'dshw-whisper out'
    clearTimeout(whisperOutTimer)
    whisperOutTimer = setTimeout(function () {
      if (!el.whisper) return
      el.whisper.className = 'dshw-whisper'
      el.whisper.textContent = ''
    }, 360)
  }

  /** 提问 / 授权：气泡常驻到用户处理完（或宿主/本地兜底超时） */
  function showWait(kind) {
    waitKind = kind
    var text = kind === 'approval' ? '🛡 <b>等你授权</b>' : '🙋 <b>等你回答</b>'
    showToast(text, 0, 'wait')
    // 挂起时余额条继续留着：22+22px 在框内放得下，别把常驻信息藏起来
    if (el.bar) el.bar.style.display = 'flex'
    playSound(kind)
    clearTimeout(waitTimer)
    waitTimer = setTimeout(function () {
      clearWait(true)
    }, WAIT_MAX_MS)
  }

  function clearWait() {
    if (!waitKind) return
    waitKind = null
    clearTimeout(waitTimer)
    if (el.toast && el.toast.className.indexOf('wait') >= 0) hideToast()
  }

  function tick() {
    if (!state || !state.ok) return
    if (state.peak && state.peak.nextChangeInSec > 0) state.peak.nextChangeInSec--
    if (panelOpen || (lastPushAt > 0 && Date.now() - lastPushAt < OFFLINE_AFTER_MS + 2000)) {
      if (panelOpen) render()
    }
  }

  var mo = new MutationObserver(function () {
    if (stopped) return
    sweepStrays(false)
    if (el.root && !document.contains(el.root)) ensureMounted()
  })

  function boot() {
    ensureMounted()
    try {
      mo.observe(document.body, { childList: true, subtree: true })
    } catch (e) {}
    loopTimer = setInterval(function () {
      if (stopped) return
      if (el.root && !document.contains(el.root)) ensureMounted()
      else sweepStrays(false)
    }, 1500)
    tickTimer = setInterval(tick, 1000)
    window.__DSHW_PET__.mounted = true
  }

  window.__DSHW_PET__ = {
    version: VERSION,
    mounted: false,
    startedAt: Date.now(),

    /** 宿主注入时先给提示音（base64 data URL，避免任何网络请求） */
    setSound: function (dataUrl) {
      sounds.turn = String(dataUrl || '')
    },
    setSounds: function (o) {
      o = o || {}
      for (var k in sounds) {
        if (typeof o[k] === 'string') sounds[k] = o[k]
      }
    },
    setOptions: function (o) {
      o = o || {}
      if (typeof o.soundOn === 'boolean') soundOn = o.soundOn
      if (typeof o.volume === 'number') volume = Math.max(0, Math.min(1, o.volume))
      if (typeof o.toastMs === 'number' && o.toastMs > 500) toastMs = o.toastMs
    },

    /** 宿主每 2.5 秒推一次 */
    applyState: function (s) {
      state = s || null
      lastPushAt = Date.now()
      if (ensureMounted()) render()
    },

    /** 通知分发：消耗泡 / 提问挂起 / 授权挂起 / 收起挂起 */
    notify: function (p) {
      if (!el.root) return
      p = p || {}
      if (p.kind === 'question' || p.kind === 'approval') {
        showWait(p.kind)
        return
      }
      if (p.kind === 'wait-clear') {
        clearWait()
        return
      }
      if (p.kind === 'whisper') {
        // 碎碎念：返回 true/false 让宿主知道「说没说成」，说不上就早点再试
        return showWhisper(p.text, p.holdMs)
      }
      var text = '本轮 <b>¥' + money(p.cost) + '</b> · ' + tok(p.tokens) + ' tok'
      if (!p.cost && p.tokens) text = '本轮 <b>' + tok(p.tokens) + ' tok</b>'
      showToast(text, toastMs)
      playSound('turn')
    },

    /** 自检：确认这台机器上 WebView2 允许无手势播放（Tauri 参数里带 autoplay-policy） */
    testSound: function (kind) {
      kind = kind || 'turn'
      if (!sounds[kind]) return Promise.resolve({ ok: false, reason: 'no-sound' })
      try {
        var a = new Audio(sounds[kind])
        a.volume = volume
        var p = a.play()
        if (p && p.then) {
          return p.then(function () {
            return { ok: true }
          }).catch(function (e) {
            return { ok: false, reason: String((e && e.name) || e) }
          })
        }
        return Promise.resolve({ ok: true })
      } catch (e) {
        return Promise.resolve({ ok: false, reason: String((e && e.message) || e) })
      }
    },

    state: function () {
      return state
    },
    open: function () {
      panelOpen = true
      if (el.panel) el.panel.classList.add('open')
      if (el.bar) el.bar.style.display = 'none'
      render()
    },
    close: function () {
      panelOpen = false
      if (el.panel) el.panel.classList.remove('open')
      if (el.bar) el.bar.style.display = 'flex'
    },
    debug: function () {
      return {
        version: VERSION,
        mounted: !!window.__DSHW_PET__.mounted,
        state: state,
        lastPushAgoMs: lastPushAt ? Date.now() - lastPushAt : null,
        host: el.root && el.root.parentElement ? el.root.parentElement.className : null,
        stopped: stopped,
        sounds: { turn: !!sounds.turn, question: !!sounds.question, approval: !!sounds.approval },
        waiting: waitKind,
        whisper: whisperLast ? { last: whisperLast, shown: whisperShown, cls: el.whisper ? el.whisper.className : '' } : { shown: 0 },
        toast: el.toast ? { cls: el.toast.className, html: el.toast.innerHTML, display: el.toast.style.display } : null,
      }
    },
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
