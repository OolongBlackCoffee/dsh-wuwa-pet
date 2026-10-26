/**
 * 开发用：只截「桌宠页面」自身的渲染（CDP Page.captureScreenshot），不截桌面合成结果。
 *
 * 用途：核对气泡相对桌宠的位置/尺寸。注意页面截图**不会**体现桌面合成时的裁剪，
 * 「框外被裁」这类问题必须靠整屏截图看（tools/shot.py）。
 *
 *   node tools/pageshot.mjs out.png [x y w h]
 */
import fs from 'node:fs'
import { attach } from '../lib/cdp.js'

const isPetTarget = (t) => !/#\/[a-z0-9_-]+/i.test(String((t && t.url) || ''))
const out = process.argv[2] || 'tools/_page.png'
const box = process.argv.slice(3, 7).map(Number)

const info = await attach(isPetTarget, 9222)
if (!info) {
  console.log('没找到桌宠页面')
  process.exit(1)
}
try {
  await info.session.send('Page.enable')
  const params = { format: 'png' }
  if (box.length === 4 && box.every((n) => isFinite(n))) {
    params.clip = { x: box[0], y: box[1], width: box[2], height: box[3], scale: 2 }
  }
  const r = await info.session.send('Page.captureScreenshot', params, 15000)
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'))
  console.log('saved ' + out)
} finally {
  info.session.close()
}
