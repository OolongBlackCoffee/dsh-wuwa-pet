/**
 * 碎碎念：让本机 llama.cpp（llama-server，OpenAI 兼容接口）现写一句
 *
 * 设计要点：
 * - **不负责启停服务**。用了哪套本地模型由用户自己决定（工作区里的 local-ai 插件有
 *   local_ai_server 工具，或手动跑 llama-server）；这里只做「探活 → 生成 → 清洗」，
 *   服务没起就直接抛错，由调用方回退到本地台词池，绝不让桌宠卡住。
 * - **超时很短**：探活 1.5s、生成默认 20s，且 AbortController 兜底；超时即回退。
 * - **清洗严格**：模型爱加引号、爱写解释、爱带「（笑）」、爱重复上一句。这里统一去引号/
 *   去换行/去括号动作/截断到 30 字，不合格就返回空串（调用方回退池子）。
 */

/** 从 completions 端点推导 models 端点（http://host:port/v1/chat/completions → /v1/models） */
function modelsUrlOf(completionsUrl) {
  const u = String(completionsUrl || '')
  const i = u.indexOf('/v1/')
  if (i >= 0) return u.slice(0, i) + '/v1/models'
  return u.replace(/\/+$/, '') + '/models'
}

function withTimeout(ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, done: () => clearTimeout(timer) }
}

/**
 * 探活：GET /v1/models，返回第一个模型 id（可能为空串）。
 * 服务没起 → 抛错，由调用方决定回退。
 */
export async function probeModel(completionsUrl, timeoutMs = 1500) {
  const t = withTimeout(timeoutMs)
  try {
    const res = await fetch(modelsUrlOf(completionsUrl), { signal: t.signal })
    if (!res.ok) throw new Error(`models HTTP ${res.status}`)
    const data = await res.json()
    const list = Array.isArray(data && data.data) ? data.data : []
    if (!list.length) throw new Error('models empty')
    const id = list[0] && (list[0].id || list[0].name)
    return String(id || '')
  } finally {
    t.done()
  }
}

/** 默认人设：桌宠小鲸鱼，随口一句，20 字内 */
export const DEFAULT_PROMPT = [
  '你是一只住在 DeepSeek Harness 桌面角落的小鲸鱼桌宠，正在陪主人写代码。',
  '现在请随口说一句「碎碎念」，用来在桌面上冒个气泡。',
  '要求：中文；不超过 20 个字；口语化、有点可爱但别腻；可以是关心、吐槽、打气或单纯的自言自语；',
  '不要问句连篇；不要用 emoji；不要引号；不要解释你在做什么；只输出这一句话。',
].join('')

/**
 * 清洗模型输出：去代码块/引号/换行/括号动作，截断 30 字。
 * 不合格（空、过长、明显是解释）返回 ''。
 */
export function sanitizeLine(raw) {
  let s = String(raw == null ? '' : raw)
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/[\r\n]+/g, ' ')
  s = s.replace(/^[\s"'“”‘’「」『』]+/, '').replace(/[\s"'“”‘’「」『』]+$/, '')
  s = s.replace(/[（(][^（）()]{1,8}[）)]/g, '') // 「（笑）」「(小声)」这类动作
  s = s.replace(/^(碎碎念|我说|回应|回答)[：:]\s*/, '')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return ''
  if (s.length > 30) s = s.slice(0, 30).replace(/[，,、。.！!？?；;：:\s]+$/, '')
  // 明显是「抱歉/无法/作为AI」这类拒答或解释，直接丢弃
  if (/^(抱歉|对不起|作为一个|作为 AI|我无法|我不能)/i.test(s)) return ''
  return s
}

/**
 * 生成一句碎碎念。
 * @param {object} opt
 * @param {string} opt.url        OpenAI 兼容 completions 端点
 * @param {string} [opt.model]    模型 id，空则自动探测
 * @param {string} [opt.prompt]   自定义人设提示词
 * @param {number} [opt.timeoutMs] 生成超时，默认 20000
 * @param {string[]} [opt.recent] 最近说过的话，用于避免重复
 * @returns {Promise<string>} 清洗后的一句话；不合格返回 ''
 */
export async function generateWhisperLine(opt = {}) {
  const url = String(opt.url || '')
  if (!url) throw new Error('no url')
  const timeoutMs = Math.max(3000, Number(opt.timeoutMs) || 20000)
  const model = String(opt.model || '') || (await probeModel(url, 1500))
  if (!model) throw new Error('no model')

  const recent = (Array.isArray(opt.recent) ? opt.recent : []).filter(Boolean).slice(0, 5)
  const prompt = String(opt.prompt || '') || DEFAULT_PROMPT
  const userMsg = recent.length
    ? `刚才已经说过：${recent.join(' / ')}。换一句不一样的，同样不超过 20 字。`
    : '说一句吧。'

  const t = withTimeout(timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: t.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.95,
        top_p: 0.9,
        max_tokens: 64,
        stream: false,
      }),
    })
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`)
    const data = await res.json()
    const msg = data && data.choices && data.choices[0] && data.choices[0].message
    let content = msg ? (msg.content || '') : ''
    // 有些模型会把思考过程塞在 content 里（…<｜end▁of▁thinking｜> 之后才是答案），取最后一段
    const cut = content.lastIndexOf('<｜end▁of▁thinking｜>')
    if (cut >= 0) content = content.slice(cut + 8)
    content = content.replace(/<\/?think>/gi, ' ')
    return sanitizeLine(content)
  } finally {
    t.done()
  }
}
