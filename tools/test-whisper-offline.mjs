/**
 * 碎碎念气泡的离线验收：用 Edge headless 起一个空白页 → 注入 widget.js → 调 notify({kind:'whisper'})
 * → 在时间轴上采样气泡的 class / 文本 / opacity，确认「冒出 → 停留 → 自动消失」。
 *
 * 这样不依赖桌宠是否在跑（WuwaTappo 那个渲染进程有时被系统节流，Runtime.evaluate 会挂住）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { attach } from '../lib/cdp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const src = fs.readFileSync(path.join(root, 'lib', 'widget.js'), 'utf8')
const PORT = 9339
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const html = path.join(root, 'tools', '_whisper-harness.html')
fs.writeFileSync(
  html,
  '<!doctype html><html><head><meta charset="utf-8"><title>harness</title></head><body style="margin:0;width:900px;height:700px;background:#eef"><div id="app"><div class="cat-mainbox" style="position:relative;width:900px;height:700px"></div></div></body></html>',
  'utf8'
)

const proc = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join(process.env.TEMP || '.', 'edge-whisper-harness'),
    '--no-first-run',
    '--disable-gpu',
    '--window-size=900,700',
    'file:///' + html.replace(/\\/g, '/'),
  ],
  { stdio: 'ignore' }
)

let session = null
try {
  // 等调试端口起来
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => String(t.url).startsWith('file:'))
      if (page) break
    } catch {}
    await sleep(250)
  }
  const info = await attach((t) => String((t && t.url) || '').startsWith('file:'), PORT)
  if (!info) throw new Error('没连上 headless 页面')
  session = info.session

  const ver = await session.eval(
    '(function(){try{delete window.__DSHW_PET__}catch(e){};' + src + '\n;return (window.__DSHW_PET__&&window.__DSHW_PET__.version)||"(none)"})()',
    { timeoutMs: 30000 }
  )
  console.log('widget 版本:', ver)

  const probe = () =>
    session.eval(
      '(function(){var e=document.getElementById("dshw-whisper");if(!e)return"no-el";' +
        'return JSON.stringify({cls:e.className,text:(e.textContent||"").replace(/\\s+/g," ").trim().slice(0,20),op:getComputedStyle(e).opacity})})()',
      { timeoutMs: 15000 }
    )

  console.log('注入后      :', await probe())
  const fired = await session.eval(
    'String(window.__DSHW_PET__.notify({kind:"whisper",text:"碎碎念测试：今晚也要早点睡",holdMs:3000}))',
    { timeoutMs: 15000 }
  )
  console.log('notify 返回 :', fired)
  await sleep(500)
  console.log('T+0.5s      :', await probe())
  // 截一张图看视觉效果（气泡本体 + 小尾巴）
  try {
    const shot = await session.send('Page.captureScreenshot', { format: 'png' }, 15000)
    if (shot && shot.data) {
      const out = path.join(root, 'docs', 'screenshot-whisper.png')
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
      console.log('截图        :', out)
    }
  } catch (e) {
    console.log('截图失败    :', e && e.message)
  }
  await sleep(1500)
  console.log('T+2.0s      :', await probe())
  await sleep(2200)
  console.log('T+4.2s      :', await probe())
  await sleep(1200)
  console.log('T+5.4s      :', await probe())
} catch (e) {
  console.log('测试失败:', e && e.message)
} finally {
  try {
    session?.close()
  } catch {}
  try {
    proc.kill()
  } catch {}
  try {
    fs.unlinkSync(html)
  } catch {}
}
