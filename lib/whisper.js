/**
 * 碎碎念：本地台词池 + 节奏控制（宿主侧纯逻辑，不碰 DOM / 不发请求）
 *
 * 设计取舍（对照 dsh-pet 的碎碎念）：
 * - dsh-pet 用 ctx.llm 现生成一句（人设提示词 + 20 字以内 + 关推理），所以每条都不一样，
 *   但每说一句都要花一次 LLM 调用；本插件是「余额挂件」，绝大多数时间只是陪着，不值得为
 *   「随口一句」付 token —— 因此这里默认走**本地台词池**：零成本、零延迟、断网也能说。
 * - 想要 dsh-pet 那种「每次都新写一句」的效果，把 whisperUseLlm 打开即可（见 index.js 的
 *   pickWhisperLine 分支）：仍然复用同一套节奏与气泡，只把文本来源换掉。
 * - 节奏沿用 dsh-pet：默认周期 300s，气泡默认停留 9s（dsh-pet 的 BUBBLE_DURATION_MS 是 10s），
 *   到点自己淡出并移除节点 —— 不会「冒出来就固定在那」。
 */

/** 时段判定（本地时间，避免依赖时区库） */
function slotOf(now) {
  const h = new Date(now).getHours()
  if (h >= 5 && h < 10) return 'morning'
  if (h >= 10 && h < 18) return 'day'
  if (h >= 18 && h < 23) return 'evening'
  return 'night'
}

/**
 * 台词池。`when` 缺省 = 任何时段都能说；同一个 `when` 的句子会按权重均匀抽。
 * 全部控制在 20 字以内（对齐 dsh-pet 的「一句就好」）。
 */
export const WHISPER_LINES = [
  // —— 早上 ——
  { text: '早上好呀，今天也慢慢来', when: 'morning' },
  { text: '刚醒？先喝口水吧', when: 'morning' },
  { text: '早上的代码最好写', when: 'morning' },
  // —— 白天 ——
  { text: '写累了就抬头看看我', when: 'day' },
  { text: '需要我帮你算算这轮花多少吗', when: 'day' },
  { text: '思路卡住就先去走两圈', when: 'day' },
  { text: '我在这儿守着余额呢', when: 'day' },
  // —— 傍晚 ——
  { text: '天快黑了，记得吃饭', when: 'evening' },
  { text: '今天也辛苦了', when: 'evening' },
  // —— 深夜 ——
  { text: '夜深了，早点睡呀', when: 'night' },
  { text: '这个点还在写，真拼', when: 'night' },
  { text: '深夜的 token 也是钱哦', when: 'night' },
  // —— 任何时段 ——
  { text: '刚才在想什么呢', when: '' },
  { text: '尾巴有点痒，甩两下', when: '' },
  { text: '要不要歇五分钟', when: '' },
  { text: '今天想聊点什么', when: '' },
  { text: '我一直在这儿，不用管我', when: '' },
  { text: '这个功能写得挺妙的', when: '' },
  { text: '窗外好像起风了', when: '' },
  { text: '别急，慢慢来比较快', when: '' },
  { text: '喝口水，伸个懒腰', when: '' },
  { text: '有事就点我一下', when: '' },
  { text: '这条不算钱，随便听听', when: '' },
  { text: '嗯……让我想想', when: '' },
  { text: '你的代码今天也很乖', when: '' },
  { text: '要不要看看今天的用量', when: '' },
  { text: '我在数你的 token', when: '' },
  { text: '安静一会儿也挺好', when: '' },
  { text: '忙完记得起来动动', when: '' },
  { text: '小鲸鱼今天也想被摸', when: '' },
]

/** 备用台词（用户把 whisperLines 配成空数组时兜底，避免「开了开关却永远不说话」） */
const FALLBACK = '嗯……我在呢'

/** 台词池归一化：接受字符串数组或 {text, when} 数组；空/非法项丢弃 */
export function normalizeLines(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const it of input) {
    if (typeof it === 'string') {
      const t = it.trim()
      if (t) out.push({ text: t, when: '' })
      continue
    }
    if (it && typeof it === 'object' && typeof it.text === 'string') {
      const t = it.text.trim()
      if (t) out.push({ text: t, when: typeof it.when === 'string' ? it.when : '' })
    }
  }
  // 上限 200 条：再多就不是「碎碎念」而是弹幕了，也避免配置写炸
  return out.slice(0, 200)
}

/**
 * 挑一句。
 * @param {number} now 当前时间戳（决定时段）
 * @param {string} lastText 上一句（避免连续重复）
 * @param {Array} lines 台词池（已归一化；空则用内置池）
 * @returns {string}
 */
export function pickWhisperLine(now, lastText, lines) {
  const pool = Array.isArray(lines) && lines.length ? lines : WHISPER_LINES
  const slot = slotOf(now)
  // 时段专属的句子优先（同一条池子里混着任何时段的句子）
  const suited = pool.filter((l) => !l.when || l.when === slot)
  const list = suited.length ? suited : pool
  const candidates = list.filter((l) => l.text !== lastText)
  const use = candidates.length ? candidates : list
  if (!use.length) return FALLBACK
  return use[Math.floor(Math.random() * use.length)].text
}

/**
 * 下一次说话的间隔（毫秒）：基准 ±jitter 抖动，避免「整点打卡」的机械感。
 * @param {number} everyMs 基准周期
 * @param {number} jitter 抖动比例（0~0.9）
 */
export function whisperGapMs(everyMs, jitter) {
  const base = Math.max(20000, Number(everyMs) || 300000)
  const j = Math.max(0, Math.min(0.9, Number(jitter) || 0))
  const delta = base * j * (Math.random() * 2 - 1)
  return Math.max(20000, Math.round(base + delta))
}
