/** 小巧的 CDP 命令行：在桌宠页面上求值一段 JS
 *   node tools/cdp.mjs "<表达式>" [代码]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attach } from '../lib/cdp.js'

const expr = process.argv.slice(2).join(' ')
const info = await attach((t) => !/#\/[a-z0-9_-]+/i.test(String((t && t.url) || '')), 9222)
if (!info) {
  console.log(JSON.stringify({ error: '没找到桌宠页面' }))
  process.exit(1)
}
try {
  const v = await info.session.eval(expr)
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))
} catch (err) {
  console.log('求值失败: ' + (err && err.message))
} finally {
  info.session.close()
}
