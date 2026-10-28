/**
 * 碎碎念自测：把最新的 widget.js 注入桌宠页 → 触发一次 whisper 气泡 → 观察冒/停/消失
 * 用法：node tools/test-whisper.mjs
 *
 * 为什么要自己注入：插件主体跑在 DSH 进程里，改完要重启 DSH 才生效。
 * 这个脚本直接走 CDP 覆盖页面里的旧 widget，用来单独验收气泡行为。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attach } from '../lib/cdp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const src = fs.readFileSync(path.join(root, 'lib', 'widget.js'), 'utf8')

const info = await attach((t) => !/#\/[a-z0-9_-]+/i.test(String((t && t.url) || '')), 9222)
if (!info) {
  console.log('没找到桌宠页面（CDP 9222）')
  process.exit(1)
}
const { session } = info
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const probe = () =>
  session.eval(
    '(function(){var e=document.getElementById("dshw-whisper");' +
      'return e?JSON.stringify({cls:e.className,text:(e.textContent||"").slice(0,24),op:getComputedStyle(e).opacity}):"none"})()',
    { timeoutMs: 20000 }
  )

try {
  // 1) 覆盖注入新版 widget（先删实例，绕开 mounted 守卫）
  const inj = await session.eval(
    '(function(){try{delete window.__DSHW_PET__}catch(e){window.__DSHW_PET__=undefined};' +
      src +
      '\n;return (window.__DSHW_PET__&&window.__DSHW_PET__.version)||"(no instance)"})()',
    { timeoutMs: 60000 }
  )
  console.log('注入后版本:', inj)
  await sleep(600)

  // 2) 触发一次碎碎念（holdMs 4000：约 4 秒后自己消失）
  const fired = await session.eval(
    'String(window.__DSHW_PET__.notify({kind:"whisper",text:"碎碎念测试：今晚也要早点睡",holdMs:4000}))',
    { timeoutMs: 20000 }
  )
  console.log('notify 返回:', fired)

  await sleep(500)
  console.log('T+0.5s :', await probe())
  await sleep(2500)
  console.log('T+3.0s :', await probe())
  await sleep(2000)
  console.log('T+5.0s :', await probe()) // 已过 holdMs，应处于淡出/已清空
  await sleep(1500)
  console.log('T+6.5s :', await probe())
} finally {
  session.close()
}
