/**
 * 测试工具：独立实现的 E2E 客户端（与浏览器 shim 同协议）+ 假上游 + 临时目录。
 */
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto'
import {
  FRAME_CONTROL,
  FRAME_DATA,
  FrameDecoder,
  deriveKeys,
  importPublicDer,
  openFrame,
  sealFrame,
  sharedSecret,
} from '../src/crypto.mjs'
import { b64u, randomToken, unb64u } from '../src/util.mjs'
import { acceptUpgrade } from '../src/ws.mjs'

export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function clientKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privateKey,
    spki: b64u(publicKey.export({ format: 'der', type: 'spki' })),
  }
}

/** 浏览器视角的握手 + 绑定。 */
export class E2EClient {
  constructor({ base, psk }) {
    this.base = base.replace(/\/+$/, '')
    this.psk = psk
    this.cookie = null
    this.sid = null
    this.keys = null
    this.c2sSeq = 0
    this.s2cSeen = new Set()
  }

  async bind() {
    const challenge = await (await fetch(`${this.base}/__dsh/handshake`)).json()
    const kp = clientKeyPair()
    const serverPub = importPublicDer(challenge.spk)
    const secret = diffieHellman({ privateKey: kp.privateKey, publicKey: serverPub })
    const proof = createHmac('sha256', unb64u(this.psk))
      .update('dsh-remote/v1/bind')
      .update('\0')
      .update(challenge.kid)
      .update('\0')
      .update(challenge.spk)
      .update('\0')
      .update(kp.spki)
      .update('\0')
      .update(unb64u(challenge.nonce))
      .digest()
    const response = await fetch(`${this.base}/__dsh/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.base },
      body: JSON.stringify({ v: 1, kid: challenge.kid, cpk: kp.spki, nonce: challenge.nonce, proof: b64u(proof) }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      const error = new Error(`bind failed: HTTP ${response.status}`)
      error.status = response.status
      error.body = body
      throw error
    }
    const raw = response.headers.get('set-cookie')
    if (raw) this.cookie = raw.split(';')[0]
    const result = await response.json()
    this.sid = result.sid
    const info = Buffer.concat([
      Buffer.from('dsh-remote/v1/keys'),
      Buffer.from([0]),
      Buffer.from(challenge.kid),
      unb64u(challenge.spk),
      unb64u(kp.spki),
      unb64u(result.sid),
    ])
    const okm = Buffer.from(hkdfSync('sha256', secret, unb64u(challenge.nonce), info, 64))
    this.keys = { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) }
    this.kid = challenge.kid
    return result
  }

  frame(type, plaintext, seq = this.nextSeq()) {
    return sealFrame({ key: this.keys.c2s, sid: unb64u(this.sid), seq, type, plaintext, aadExtra: Buffer.from('c2s') })
  }

  nextSeq() {
    const seq = this.c2sSeq
    this.c2sSeq += 1
    return seq
  }

  /** WS 通道上每条消息都是「长度前缀 + 加密帧」。 */
  wsMessage(type, plaintext) {
    const frame = this.frame(type, plaintext)
    const out = Buffer.alloc(4 + frame.length)
    out.writeUInt32BE(frame.length, 0)
    frame.copy(out, 4)
    return out
  }

  envelope({ method = 'GET', path = '/', headers = {}, body = null }) {
    return {
      v: 1,
      m: method,
      p: path,
      h: { accept: '*/*', ...headers },
      b: body ? Buffer.from(body).toString('base64url') : null,
    }
  }

  async request(options = {}) {
    const envelope = this.envelope(options)
    const frame = this.frame(FRAME_DATA, Buffer.from(JSON.stringify(envelope)))
    return this.readResponse(await this.post(frame))
  }

  async post(frame) {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(frame.length)
    return fetch(`${this.base}/__dsh/e2e`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        origin: this.base,
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: Buffer.concat([length, frame]),
    })
  }

  async readResponse(response) {
    if (response.status !== 200) {
      const text = await response.text()
      return { status: response.status, error: text, headers: {}, body: null, meta: null }
    }
    const decoder = new FrameDecoder()
    const frames = []
    const reader = response.body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      frames.push(...decoder.push(value))
    }
    let meta = null
    const chunks = []
    for (const frame of frames) {
      const { seq, type, plaintext } = openFrame({
        key: this.keys.s2c,
        sid: unb64u(this.sid),
        frame,
        aadExtra: Buffer.from('s2c'),
      })
      if (this.s2cSeen.has(seq)) throw new Error(`duplicate s2c seq ${seq}`)
      this.s2cSeen.add(seq)
      if (type === FRAME_CONTROL) meta = { ...(meta ?? {}), ...JSON.parse(plaintext.toString('utf8')) }
      else if (type === FRAME_DATA) chunks.push(plaintext)
    }
    return { status: meta?.s ?? null, headers: meta?.h ?? {}, meta, body: Buffer.concat(chunks) }
  }
}

/** 假上游：模拟 DSH web 的 token 交换、cookie 鉴权、SSE、WS、HTML。 */
export async function startFakeUpstream({ token = randomToken(24) } = {}) {
  let bootstraps = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake.invalid')
    if (url.pathname === '/' && url.searchParams.get('token')) {
      bootstraps += 1
      res.writeHead(303, {
        location: './',
        'set-cookie': `dsh-auth-test=ok-${String(bootstraps)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (url.pathname === '/') {
      if (!/dsh-auth-test=ok/u.test(String(req.headers.cookie ?? ''))) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized\n')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>fake dsh</title></head><body><div id="app"></div></body></html>')
      return
    }
    if (url.pathname === '/api/echo') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-fake-host': String(req.headers.host) })
        res.end(
          JSON.stringify({
            method: req.method,
            url: url.pathname + url.search,
            cookie: String(req.headers.cookie ?? ''),
            origin: String(req.headers.origin ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      })
      return
    }
    if (url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: one\n\n')
      setTimeout(() => res.write('data: two\n\n'), 10)
      setTimeout(() => {
        res.write('data: three\n\n')
        res.end()
      }, 20)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  })

  server.on('upgrade', (req, socket, head) => {
    const ws = acceptUpgrade(req, socket, head)
    if (!ws) return
    ws.on('message', (payload, isText) => {
      if (isText) ws.sendText(`echo:${payload.toString('utf8')}`)
      else ws.sendBinary(payload)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    token,
    get bootstraps() {
      return bootstraps
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}