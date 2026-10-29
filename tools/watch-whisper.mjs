/**
 * 盯一阵子，把碎碎念的「冒出 → 停留 → 消失」全过程抓下来（跑在真桌宠页上）
 * 用法：node tools/watch-whisper.mjs [最多等多少秒=150]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attach } from '../lib/cdp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const limitSec = Number(process.argv[2] || 150)

const info = await attach((t) => !/#\/[a-z0-9_-]+/i.test(String((t && t.url) || '')), 9222)
if (!info) {
  console.log('没找到桌宠页面')
  process.exit(1)
}
const { session } = info
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const read = () =>
  session.eval(
    '(function(){var p=window.__DSHW_PET__;var e=document.getElementById("dshw-whisper");' +
      'return JSON.stringify({ver:(p&&p.version)||"?",mounted:!!(p&&p.mounted),' +
      'cls:e?e.className:"no-el",text:e?(e.textContent||"").trim().slice(0,24):""})})()',
    { timeoutMs: 15000 }
  )

try {
  console.log('页面版本:', await read())
  const t0 = Date.now()
  let seenShown = false
  let shots = 0
  while ((Date.now() - t0) / 1000 < limitSec) {
    const raw = await read()
    const s = JSON.parse(raw)
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    const shown = /(^|\s)show(\s|$)/.test(s.cls)
    if (shown && !seenShown) {
      console.log(`+${secs}s 冒出来了: ${s.text}`)
      seenShown = true
      try {
        const shot = await session.send('Page.captureScreenshot', { format: 'png' }, 20000)
        if (shot && shot.data) {
          const out = path.join(root, 'docs', 'screenshot-whisper-live.png')
          fs.mkdirSync(path.dirname(out), { recursive: true })
          fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
          shots++
          console.log(`         截图: ${out}`)
        }
      } catch (e) {
        console.log('         截图失败:', e && e.message)
      }
    } else if (!shown && seenShown) {
      console.log(`+${secs}s 已消失（class="${s.cls}" text="${s.text}"）`)
      break
    }
    await sleep(4000)
  }
  if (!seenShown) console.log(`等了 ${limitSec}s 没等到气泡（可能刚重启、计时器还没到点）`)
  console.log('结束状态:', await read(), '截图数:', shots)
} finally {
  session.close()
}
