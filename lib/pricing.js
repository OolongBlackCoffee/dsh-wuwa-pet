/**
 * DeepSeek 计价表（自算路）
 *
 * 口径与 dsh-whale-widget 完全一致，保证「桌宠弹的金额」和「小鲸鱼记的账」对得上：
 *   - 价目：元 / 百万 token，[空闲时段价, 高峰时段价]
 *   - 高峰：北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00
 *           周末、法定节假日全天一律空闲价（2026-08-23 / 2026-09-19 两条官方规则）
 *   - 计费口径：cacheReadTokens 按命中价、inputTokens 按未命中价、
 *               outputTokens 按输出价（DSH 的 outputTokens 已含 reasoningTokens，不重复累加）
 *
 * 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 2026-09-10 起 Flash 降价：0.02 / 1 / 4（高峰翻倍）；Pro 为 Flash 三倍价。
 */

// Flash（正式模型名 deepseek-flash = DeepSeek-V4.1-Flash）
const FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
// Pro（= Flash 的 3 倍）
const PRO = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

export const PRICING = {
  'deepseek-flash': FLASH,
  'deepseek-v4-flash': FLASH,
  'deepseek-v4-flash-vision-exp': FLASH,
  'deepseek-v4-pro': PRO,
  _default: FLASH,
}

/** 按模型名子串匹配价目（最长键优先，避免 'pro' 误伤别的模型），认不出就按 Flash 价 */
export function priceFor(model) {
  const m = String(model || '').toLowerCase()
  const keys = Object.keys(PRICING).filter((k) => k !== '_default').sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

/**
 * 一轮（或一条消息）的金额。
 * @param {object} o
 * @param {string} o.model  模型名（可空，空则按 Flash 价）
 * @param {number} [o.cache]  缓存命中 token
 * @param {number} [o.input]  未命中输入 token
 * @param {number} [o.output] 输出 token（含 reasoning）
 * @param {boolean} o.peak   是否高峰时段
 * @returns {number} 人民币元
 */
export function costOf({ model, cache = 0, input = 0, output = 0, peak = false } = {}) {
  const p = priceFor(model)
  const i = peak ? 1 : 0
  const c = Number(cache) || 0
  const n = Number(input) || 0
  const q = Number(output) || 0
  const yuan = (c / 1e6) * p.hit[i] + (n / 1e6) * p.miss[i] + (q / 1e6) * p.out[i]
  // 保留到 1e-9（与 whale 的 1e-8 定点记账同量级，避免累加误差滚雪球）
  return Math.round(yuan * 1e9) / 1e9
}

/** 该模型是否认得出来（认不出就走 _default 价，界面上可以提示一句） */
export function priceKnown(model) {
  const m = String(model || '').toLowerCase()
  return Object.keys(PRICING).some((k) => k !== '_default' && m.indexOf(k) !== -1)
}
