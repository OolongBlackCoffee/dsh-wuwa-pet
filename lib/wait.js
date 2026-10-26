/**
 * 「等待用户交互」跟踪器（纯逻辑，无 IO —— 便于离线自检）
 *
 * 为什么需要它：
 *   `ask_user_question` 是一次**挂起**的工具调用：模型发出后 DSH 追加 `tool/call`，
 *   然后卡住等你点；等待期间没有 `turn/end`，所以「每轮消耗」那条路完全覆盖不到
 *   这两个时刻。授权（`approval/asked`）同理。想在这两个瞬间提醒，只能自己盯事件。
 *
 * 事件契约（已用 dsh-whale-widget 的实现交叉核对）：
 *   tool/call      data.name === 'ask_user_question'  → 提问挂起
 *   tool/result    callId 相同                          → 提问解除
 *   approval/asked data.id                              → 授权挂起
 *   approval/*     data.id 相同                         → 授权解除
 *   turn/start | turn/end                               → 一律解除
 *
 * 只保留**最新一条**挂起：子代理不允许提问，授权并发极少，多会话队列没有收益。
 */

/** 从 tool/call、tool/result 的 payload 里挖 callId —— 字段位置随 DSH 版本漂，全都兜一遍 */
export function eventCallId(event) {
  try {
    const d = (event && event.data) || {}
    const msg = d.message || {}
    const list = Array.isArray(msg.content) ? msg.content : []
    for (const c of list) {
      if (c && (c.toolCallId || c.tool_call_id)) return String(c.toolCallId || c.tool_call_id)
    }
    if (msg && (msg.callId || msg.toolCallId || msg.tool_call_id)) {
      return String(msg.callId || msg.toolCallId || msg.tool_call_id)
    }
    return String(d.callId || d.call_id || d.toolCallId || d.id || '')
  } catch {
    return ''
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.questionTool] 提问工具名，默认 ask_user_question
 * @param {number} [opts.ttlMs] 挂起最长存活时间（防止用户直接关窗口后气泡一直挂着）
 * @param {number} [opts.dedupeMs] 同一 id 在这段时间内重复广播只算一次
 * @param {(pending:object)=>void} [opts.onShow]
 * @param {(info:object)=>void} [opts.onClear]
 * @param {()=>number} [opts.now]
 */
export function createWaitTracker({
  questionTool = 'ask_user_question',
  ttlMs = 180000,
  dedupeMs = 2500,
  onShow,
  onClear,
  now = () => Date.now(),
} = {}) {
  let pending = null
  /** kind:id -> 最后一次弹出时间，用于吃掉重复广播 */
  const recent = new Map()

  function shouldSkip(kind, id) {
    const t = recent.get(kind + ':' + id) || 0
    return t > 0 && now() - t < dedupeMs
  }

  function remember(kind, id) {
    recent.set(kind + ':' + id, now())
    if (recent.size > 200) {
      const cutoff = now() - ttlMs
      for (const [k, t] of recent) if (t < cutoff) recent.delete(k)
    }
  }

  function show(kind, id, sid) {
    const idv = String(id || '')
    if (shouldSkip(kind, idv)) return false
    remember(kind, idv)
    pending = { kind, id: idv, sid: String(sid || 'default'), at: now() }
    try {
      onShow && onShow({ ...pending })
    } catch {}
    return true
  }

  /** kind 给空 = 任意种类；id 给空 = 不看 id（授权并发极少，宁可按种类清） */
  function clear(kind, id, sid) {
    if (!pending) return false
    if (kind && pending.kind !== kind) return false
    if (sid && pending.sid !== String(sid)) return false
    if (id) {
      const idv = String(id)
      if (pending.id && idv !== pending.id) return false
    }
    const done = pending
    pending = null
    try {
      onClear && onClear({ ...done })
    } catch {}
    return true
  }

  function handle(sid, event) {
    let type = ''
    let data = {}
    try {
      type = String((event && event.type) || '')
      data = (event && event.data) || {}
    } catch {
      return false
    }
    if (!type) return false

    if (type === 'turn/start' || type === 'turn/end') {
      // 只清本会话的挂起，别被别的会话的轮次边界误伤
      return clear('', '', sid)
    }
    if (type === 'tool/call' && String(data.name || data.toolName || '') === questionTool) {
      return show('question', eventCallId(event), sid)
    }
    if (type === 'tool/result') {
      return clear('question', eventCallId(event), '')
    }
    if (type === 'approval/asked') {
      return show('approval', data.id, sid)
    }
    if (type.indexOf('approval/') === 0) {
      return clear('approval', data.id, '')
    }
    return false
  }

  return {
    handle,
    show,
    clear,
    /** 到点自动收起（宿主侧定时调） */
    expire() {
      if (!pending) return false
      if (now() - pending.at < ttlMs) return false
      const done = pending
      pending = null
      try {
        onClear && onClear({ ...done, expired: true })
      } catch {}
      return true
    },
    pending: () => (pending ? { ...pending } : null),
  }
}
