/**
 * 极简 CDP 客户端（零依赖）
 *
 * Node 没有内建 WebSocket 客户端，为了一个气泡挂件去装依赖不值得，
 * 所以这里实现 RFC6455 里 CDP 用得到的那部分：文本帧、分片、ping/pong、close。
 */
import net from 'node:net'
import crypto from 'node:crypto'

class WsClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragOpcode = 0
    this.onmessage = null
    this.onclose = null
    this.closed = false
    socket.on('data', (d) => this._onData(d))
    socket.on('close', () => {
      this.closed = true
      this.onclose && this.onclose()
    })
    socket.on('error', () => {
      this.closed = true
      this.onclose && this.onclose()
    })
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this._readFrame()
      if (!frame) break
      const { opcode, payload, fin } = frame
      if (opcode === 0x9) {
        this._write(0xa, payload) // ping → pong
        continue
      }
      if (opcode === 0x8) {
        try {
          this.socket.end()
        } catch {}
        continue
      }
      if (opcode === 0x0) {
        this.fragments.push(payload)
        if (fin) {
          const all = Buffer.concat(this.fragments)
          this.fragments = []
          this.onmessage && this.onmessage(all.toString('utf8'))
        }
        continue
      }
      if (fin) {
        this.onmessage && this.onmessage(payload.toString('utf8'))
      } else {
        this.fragOpcode = opcode
        this.fragments = [payload]
      }
    }
  }

  _readFrame() {
    const b = this.buffer
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (b.length < offset + 2) return null
      len = b.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (b.length < offset + 8) return null
      len = Number(b.readBigUInt64BE(offset))
      offset += 8
    }
    let mask
    if (masked) {
      if (b.length < offset + 4) return null
      mask = b.subarray(offset, offset + 4)
      offset += 4
    }
    if (b.length < offset + len) return null
    const payload = Buffer.from(b.subarray(offset, offset + len))
    if (masked && mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    }
    this.buffer = b.subarray(offset + len)
    return { fin, opcode, payload }
  }

  _write(opcode, payload) {
    if (this.closed) return
    const len = payload.length
    const mask = crypto.randomBytes(4)
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
    let header
    if (len < 126) {
      header = Buffer.alloc(6)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | len
      mask.copy(header, 2)
    } else if (len < 65536) {
      header = Buffer.alloc(8)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
      mask.copy(header, 4)
    } else {
      header = Buffer.alloc(14)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
      mask.copy(header, 10)
    }
    try {
      this.socket.write(Buffer.concat([header, masked]))
    } catch {}
  }

  send(text) {
    this._write(0x1, Buffer.from(text, 'utf8'))
  }

  close() {
    try {
      this._write(0x8, Buffer.alloc(0))
      this.socket.end()
    } catch {}
  }
}

/** 连一个 ws:// URL，返回 WsClient */
export function connectWs(wsUrl, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl)
    const key = crypto.randomBytes(16).toString('base64')
    const socket = net.connect(Number(u.port), u.hostname)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('CDP websocket 连接超时'))
    }, timeoutMs)

    let handshakeDone = false
    const onData = (chunk) => {
      if (handshakeDone) return
      const text = chunk.toString('latin1')
      const end = text.indexOf('\r\n\r\n')
      if (end < 0) return
      clearTimeout(timer)
      handshakeDone = true
      socket.removeListener('data', onData)
      if (!/^HTTP\/1\.1 101/.test(text)) {
        socket.destroy()
        reject(new Error('CDP 握手失败: ' + text.split('\r\n')[0]))
        return
      }
      const rest = chunk.subarray(Buffer.byteLength(text.slice(0, end + 4), 'latin1'))
      const ws = new WsClient(socket)
      if (rest.length) ws._onData(rest)
      resolve(ws)
    }
    socket.on('data', onData)
    socket.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    socket.write(
      `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Origin: http://127.0.0.1:${u.port}\r\n\r\n`
    )
  })
}

/** 一个 CDP 会话：id 自增、按 id 回包、支持事件订阅 */
export class CdpSession {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    ws.onmessage = (text) => {
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        return
      }
      if (msg.method) {
        const set = this.listeners.get(msg.method)
        if (set) for (const fn of set) fn(msg.params)
      }
    }
    ws.onclose = () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已断开'))
      this.pending.clear()
    }
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, timeoutMs)
      timer.unref?.()
    })
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(fn)
  }

  /** 在页面里求值，返回 JS 值（JSON 可序列化） */
  async eval(expression, { awaitPromise = true, timeoutMs = 10000 } = {}) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise, userGesture: true },
      timeoutMs
    )
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error('页面求值异常: ' + (d.exception?.description || d.text))
    }
    return r && r.result ? r.result.value : undefined
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/** 拿到所有可调试页面（含 webview target） */
export async function listTargets(port = 9222, timeoutMs = 1500) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
  return res.json()
}

/**
 * 挑一个页面并连上。
 * @param {string|((t:any)=>boolean)} match url 子串，或自定义判定函数
 */
export async function attach(match = '', port = 9222) {
  const targets = await listTargets(port)
  const pick = typeof match === 'function' ? match : (t) => String(t.url || '').includes(match)
  const pages = targets.filter((t) => t.type === 'page' && pick(t))
  if (!pages.length) return null
  const ws = await connectWs(pages[0].webSocketDebuggerUrl)
  const session = new CdpSession(ws)
  try {
    await session.send('Runtime.enable')
  } catch {}
  return { session, target: pages[0] }
}
