/**
 * 零依赖 WebSocket（RFC 6455）最小实现，同时提供服务端 accept 与客户端 connect。
 *
 * 只覆盖 DSH Web UI 需要的能力：文本/二进制帧、ping/pong、close、分片接收、掩码校验。
 * 不支持 permessage-deflate（不协商即不压缩，语义安全）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

export function acceptKey(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

/** 增量帧解析器：push(chunk) → [{opcode, payload, fin, rsv}]。 */
export class FrameParser {
  constructor({ maxPayload = 64 * 1024 * 1024, expectMasked = null } = {}) {
    this.buffer = Buffer.alloc(0)
    this.maxPayload = maxPayload
    this.expectMasked = expectMasked
    this.fragments = []
    this.fragmentOpcode = null
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    const messages = []
    for (;;) {
      if (this.buffer.length < 2) break
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const rsv = first & 0x70
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (rsv !== 0) throw new Error('RSV 位必须为 0（不支持扩展协商）')
      if (this.expectMasked === true && !masked) throw new Error('客户端帧必须掩码')
      if (this.expectMasked === false && masked) throw new Error('服务端帧不应掩码')
      if (length === 126) {
        if (this.buffer.length < offset + 2) break
        length = this.buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) break
        const big = this.buffer.readBigUInt64BE(offset)
        if (big > BigInt(this.maxPayload)) throw new Error(`WS 帧过大: ${big}`)
        length = Number(big)
        offset += 8
      }
      if (length > this.maxPayload) throw new Error(`WS 帧过大: ${length}`)
      let maskKey = null
      if (masked) {
        if (this.buffer.length < offset + 4) break
        maskKey = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) break
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      this.buffer = this.buffer.subarray(offset + length)
      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3]
      }
      if (opcode === OPCODE.PING || opcode === OPCODE.PONG || opcode === OPCODE.CLOSE) {
        messages.push({ opcode, payload, fin: true })
        continue
      }
      if (opcode === OPCODE.CONTINUATION) {
        if (this.fragmentOpcode === null) throw new Error('非法 continuation 帧')
        this.fragments.push(payload)
        const total = this.fragments.reduce((sum, part) => sum + part.length, 0)
        if (total > this.maxPayload) throw new Error('WS 分片消息过大')
        if (fin) {
          messages.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) })
          this.fragments = []
          this.fragmentOpcode = null
        }
        continue
      }
      if (fin) {
        messages.push({ opcode, payload })
      } else {
        this.fragmentOpcode = opcode
        this.fragments = [payload]
      }
    }
    return messages
  }
}

export function encodeFrame({ opcode, payload, fin = true, mask = false }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '')
  const header = []
  header.push((fin ? 0x80 : 0) | (opcode & 0x0f))
  const maskBit = mask ? 0x80 : 0
  if (body.length < 126) {
    header.push(maskBit | body.length)
  } else if (body.length < 65536) {
    header.push(maskBit | 126, body.length >> 8, body.length & 0xff)
  } else {
    header.push(maskBit | 127)
    const lengthHeader = Buffer.alloc(8)
    lengthHeader.writeBigUInt64BE(BigInt(body.length))
    header.push(...lengthHeader)
  }
  const head = Buffer.from(header)
  if (!mask) return Buffer.concat([head, body])
  const key = randomBytes(4)
  const masked = Buffer.from(body)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i & 3]
  return Buffer.concat([head, key, masked])
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, { role, maxPayload = 64 * 1024 * 1024, leftover = Buffer.alloc(0) }) {
    super()
    this.socket = socket
    this.role = role
    this.closed = false
    this.parser = new FrameParser({ maxPayload, expectMasked: role === 'server' })
    socket.setNoDelay?.(true)
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => this.#finish(1006, 'socket closed'))
    socket.on('error', (error) => {
      this.emit('error', error)
      this.#finish(1006, 'socket error')
    })
    if (leftover.length > 0) this.#onData(leftover)
  }

  #onData(chunk) {
    if (this.closed) return
    let messages
    try {
      messages = this.parser.push(chunk)
    } catch (error) {
      this.emit('error', error)
      this.close(1002, 'protocol error')
      return
    }
    for (const message of messages) {
      if (message.opcode === OPCODE.CLOSE) {
        const code = message.payload.length >= 2 ? message.payload.readUInt16BE(0) : 1005
        this.#finish(code, message.payload.subarray(2).toString('utf8'))
        return
      }
      if (message.opcode === OPCODE.PING) {
        this.#write({ opcode: OPCODE.PONG, payload: message.payload })
        this.emit('ping', message.payload)
        continue
      }
      if (message.opcode === OPCODE.PONG) {
        this.emit('pong', message.payload)
        continue
      }
      this.emit('message', message.payload, message.opcode === OPCODE.TEXT)
    }
  }

  #write({ opcode, payload }) {
    if (this.closed || !this.socket.writable) return false
    try {
      this.socket.write(encodeFrame({ opcode, payload, mask: this.role === 'client' }))
      return true
    } catch {
      return false
    }
  }

  sendText(text) {
    return this.#write({ opcode: OPCODE.TEXT, payload: Buffer.from(String(text), 'utf8') })
  }

  sendBinary(buffer) {
    return this.#write({ opcode: OPCODE.BINARY, payload: buffer })
  }

  ping(payload = Buffer.alloc(0)) {
    return this.#write({ opcode: OPCODE.PING, payload })
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    const reasonBuffer = Buffer.from(reason, 'utf8').subarray(0, 123)
    const payload = Buffer.alloc(2 + reasonBuffer.length)
    payload.writeUInt16BE(code, 0)
    reasonBuffer.copy(payload, 2)
    this.#write({ opcode: OPCODE.CLOSE, payload })
    setTimeout(() => this.#finish(code, reason), 200).unref?.()
  }

  #finish(code, reason) {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.end()
    } catch {}
    this.emit('close', code, reason)
  }
}

/** 服务端：把已 upgrade 的 socket 包装成连接。 */
export function acceptUpgrade(req, socket, head = Buffer.alloc(0), options = {}) {
  const key = req.headers['sec-websocket-key']
  if (!key || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return null
  }
  const protocol = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((part) => part.trim()).filter(Boolean)
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(String(key))}`,
  ]
  if (protocol.length > 0) lines.push(`Sec-WebSocket-Protocol: ${protocol[0]}`)
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  return new WebSocketConnection(socket, { role: 'server', ...options, leftover: head })
}

/** 客户端：带自定义头（Cookie/Origin）连接上游 WS。 */
export function connectWebSocket(target, { headers = {}, timeoutMs = 15_000, maxPayload } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(target)
    } catch {
      reject(new Error(`WS 地址非法: ${target}`))
      return
    }
    const secure = url.protocol === 'wss:' || url.protocol === 'https:'
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port || (secure ? 443 : 80))
    const key = randomBytes(16).toString('base64')
    const options = { host, port, servername: secure ? host : undefined }
    const socket = secure ? tlsConnect(options) : netConnect(options)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('WS 握手超时'))
    }, timeoutMs)
    const defaults = {
      Host: url.host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    }
    // 大小写无关合并，且不允许调用方覆盖握手必需头（避免重复 Host 触发 400）
    const merged = new Map()
    for (const [name, value] of Object.entries(defaults)) merged.set(name.toLowerCase(), [name, value])
    for (const [name, value] of Object.entries(headers ?? {})) {
      const key = name.toLowerCase()
      if (key === 'sec-websocket-key' || key === 'sec-websocket-version' || value === undefined || value === null) continue
      merged.set(key, [name, value])
    }
    const headerLines = [...merged.values()].map(([name, value]) => `${name}: ${value}`)
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`)
    })
    let pending = Buffer.alloc(0)
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk])
      const split = pending.indexOf('\r\n\r\n')
      if (split === -1) {
        if (pending.length > 64 * 1024) {
          settled = true
          clearTimeout(timer)
          socket.destroy()
          reject(new Error('WS 握应头过大'))
        }
        return
      }
      socket.removeListener('data', onData)
      const head = pending.subarray(0, split).toString('latin1')
      const rest = pending.subarray(split + 4)
      const statusLine = head.split('\r\n')[0] ?? ''
      if (!/^HTTP\/1\.1 101/u.test(statusLine)) {
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(new Error(`WS 升级失败: ${statusLine}`))
        return
      }
      const expected = acceptKey(key)
      const acceptHeader = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1]
      if (acceptHeader && acceptHeader !== expected) {
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(new Error('WS 握手校验失败（Sec-WebSocket-Accept 不匹配）'))
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(new WebSocketConnection(socket, { role: 'client', maxPayload, leftover: rest }))
    }
    socket.on('data', onData)
    socket.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}