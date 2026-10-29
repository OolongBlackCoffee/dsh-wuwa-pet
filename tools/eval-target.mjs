/** 在指定 url 结尾的桌宠页上求值：node tools/eval-target.mjs <expr> [urlSuffix] */
import { attach } from '../lib/cdp.js'

const expr = process.argv[2] || '1+1'
const suffix = process.argv[3] || '#/'

const info = await attach((t) => String((t && t.url) || '').endsWith(suffix), 9222)
if (!info) {
  console.log('没有匹配到目标（suffix=' + suffix + '）')
  process.exit(1)
}
console.log('目标:', String(info.target && info.target.url))
try {
  const v = await info.session.eval(expr, { timeoutMs: 25000 })
  console.log('结果:', typeof v === 'string' ? v : JSON.stringify(v))
} catch (e) {
  console.log('失败:', e && e.message)
} finally {
  try {
    info.session.close()
  } catch {}
}
