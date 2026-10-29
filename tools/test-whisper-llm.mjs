// 临时测试：直接调 lib/whisper-llm.js，验证本机 llama-server 能生成合格碎碎念
import { generateWhisperLine, probeModel, DEFAULT_PROMPT } from '../lib/whisper-llm.js'

const URL_ = 'http://127.0.0.1:8080/v1/chat/completions'

const t0 = Date.now()
const model = await probeModel(URL_)
console.log(`探活 OK，model=${model || '(空)'}，耗时 ${Date.now() - t0} ms`)

for (let i = 1; i <= 3; i++) {
  const t = Date.now()
  try {
    const line = await generateWhisperLine({
      url: URL_,
      model,
      prompt: '',
      timeoutMs: 25000,
      recent: [],
    })
    const ms = Date.now() - t
    console.log(`  [${i}] ${ms} ms → 「${line}」` + (line ? '' : '  ⚠️ 空（会回退池子）'))
  } catch (e) {
    console.log(`  [${i}] 失败：${e.message}`)
  }
}
