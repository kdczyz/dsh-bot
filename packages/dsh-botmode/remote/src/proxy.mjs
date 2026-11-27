/**
 * 边缘代理：Cloudflare 隧道唯一入口。
 *
 * 三条通道：
 *   1) /__dsh/*        —— 握手、绑定、端到端加密数据面、shim 分发；
 *   2) 已认证静态通道  —— SPA 外壳与静态资源（经 relay 注入上游 cookie 后转发）；
 *   3) /__dsh/ws      —— 加密 WebSocket 桥，承载 DSH 实时流。
 *
 * 安全边界：Cloudflare 只能看到 path 前缀、密文与体积；Access 凭证 / DSH launch token /
 * 上游会话 cookie 全部只在浏览器↔relay 的加密通道内，或以 fragment（#k=）形式从不离开浏览器。
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FRAME_CLOSE,
  FRAME_CONTROL,
  FRAME_DATA,
  FrameDecoder,
  deriveKeys,
  encodeLengthPrefixed,
  newSessionId,
  openFrame,
  sealFrame,
  sharedSecret,
  verifyBindProof,
} from './crypto.mjs'
import { b64u, unb64u } from './util.mjs'
import { acceptUpgrade, connectWebSocket } from './ws.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHIM_PATH = join(__dirname, 'shim.js')

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
])

const STRIP_RESPONSE = new Set(['set-cookie', 'content-length', 'content-encoding', 'transfer-encoding', 'connection'])

const DROP_REQUEST = new Set([
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-warp-tag-id',
  'cdn-loop',
  'true-client-ip',
  'cf-access-jwt-assertion',
  'cf-access-authenticated-user-email',
])

const E2E_PREFIX = '/__dsh'
const SESSION_COOKIE = 'dshr_sid'
// App 直连通道的 cookie 必须用 dsh-auth- 前缀：Android 客户端的 CookieJar 只持久化该前缀
const PLAIN_COOKIE = 'dsh-auth-relay'
const PLAIN_COOKIE_ALIASES = ['dsh-auth-relay', 'dshr_plain']

const nullLogger = { info() {}, warn() {}, error() {} }

export function createEdge({ config, keys, sessions, upstream, logger = nullLogger, shimSource = null }) {
  const stats = { startedAt: Date.now(), requests: 0, e2e: 0, ws: 0, bytesIn: 0, bytesOut: 0, errors: 0, rejected: 0 }
  const shim = shimSource ?? readFileSync(SHIM_PATH, 'utf8')
  const shimBuild = createHash('sha256').update(shim).digest('hex').slice(0, 12)
  const plainSessions = new Map()
  const sessions_ttl = config.e2e.sessionTtlHours * 3_600_000

  const server = http.createServer((req, res) => {
    stats.requests += 1
    route(req, res).catch((error) => {
      stats.errors += 1
      logger.error('request failed', { url: req.url, error: String(error?.message ?? error) })
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
      if (!res.writableEnded) res.end('relay error\n')
    })
  })

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((error) => {
      stats.errors += 1
      logger.error('upgrade failed', { url: req.url, error: String(error?.message ?? error) })
      try {
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      } catch {}
    })
  })

  // ───────────────────────────── 路由 ─────────────────────────────

  async function route(req, res) {
    const url = new URL(normalizePath(req.url), 'http://relay.invalid')
    if (url.pathname === `${E2E_PREFIX}/health`) return sendJson(res, 200, healthPayload())
    if (url.pathname === `${E2E_PREFIX}/shim.js`) return sendShim(req, res)

    if (config.e2e.enabled) {
      if (url.pathname === `${E2E_PREFIX}/handshake`) return handleHandshake(req, res)
      if (url.pathname === `${E2E_PREFIX}/bind`) return handleBind(req, res)
      if (url.pathname === `${E2E_PREFIX}/e2e`) return handleE2E(req, res)
      if (url.pathname === `${E2E_PREFIX}/link`) return handleLink(req, res)
    }

    // 旧式 ?token= 链接（兼容 / 备用通道，默认关闭）
    if ((config.proxy.legacyToken || config.proxy.appBridge) && url.searchParams.has('token')) {
      return handleLegacyToken(req, res, url)
    }

    const session = sessionFromRequest(req)
    const plain = plainSessionFromRequest(req)
    if (!session && !plain) {
      if (wantsHtml(req)) return sendUnlockPage(req, res)
      stats.rejected += 1
      return sendJson(res, 401, { error: 'unauthorized', hint: 'open the link that contains #k=<key>' })
    }
    // 只有 E2E 加密会话（dshr_sid）才注入 shim.js；明文/App 直连通道（?token=）直接走普通 cookie，
    // 否则浏览器打开 App 链接时会被 shim.js 劫持 fetch 并报错「地址缺少 #k=<key> 访问密钥」。
    return proxyStatic(req, res, url, { injectE2eShim: Boolean(session && config.e2e.enabled) })
  }

  // ───────────────────────────── 会话 ─────────────────────────────

  function sessionFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie)
    const sid = cookies[SESSION_COOKIE]
    if (!sid) return null
    return sessions.get(sid)
  }

  function plainSessionFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie)
    for (const name of PLAIN_COOKIE_ALIASES) {
      const token = cookies[name]
      if (!token) continue
      const entry = plainSessions.get(token)
      if (entry && entry.expiresAt >= Date.now()) return entry
      plainSessions.delete(token)
    }
    return null
  }

  function cookieAttributes(req, maxAgeSeconds) {
    const secure = isSecureRequest(req)
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(maxAgeSeconds)}${secure ? '; Secure' : ''}`
  }

  function isSecureRequest(req) {
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
    if (proto === 'https') return true
    if (req.headers['cf-visitor']) {
      try {
        if (JSON.parse(String(req.headers['cf-visitor'])).scheme === 'https') return true
      } catch {}
    }
    return false
  }

  function bindSessionCookie(res, req, sid, ttlSeconds) {
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${sid}; ${cookieAttributes(req, ttlSeconds)}`)
  }

  function healthPayload() {
    return {
      ok: true,
      service: 'dsh-remote',
      e2e: config.e2e.enabled,
      version: 1,
      upstream: upstream.ready,
      sessions: sessions.size,
      ws: stats.ws,
      pskKid: keys.activePsk()?.kid ?? null,
      now: new Date().toISOString(),
    }
  }

  // ───────────────────────────── 握手 / 绑定 ─────────────────────────────

  function handleHandshake(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })
    const identity = keys.identity
    const challenge = sessions.issueChallenge(identity)
    sendJson(
      res,
      200,
      {
        v: 1,
        kid: challenge.kid,
        spk: challenge.spk,
        nonce: challenge.nonce,
        exp: challenge.expiresAt,
        algo: 'ECDH-P256+HKDF-SHA256+AES-256-GCM',
        sid_len: 16,
      },
      { 'cache-control': 'no-store' },
    )
  }

  async function handleBind(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (!sameOrigin(req)) return deny(res, 403, 'bad_origin')
    const body = await readJsonBody(req, 8 * 1024)
    if (!body || body.v !== 1) return sendJson(res, 400, { error: 'bad_request' })
    const { kid, cpk, nonce, proof } = body
    if (typeof kid !== 'string' || typeof cpk !== 'string' || typeof nonce !== 'string' || typeof proof !== 'string') {
      return sendJson(res, 400, { error: 'bad_request' })
    }
    const challenge = sessions.consumeChallenge(nonce, kid)
    if (!challenge) return deny(res, 401, 'challenge_expired')
    const identity = keys.identityById(kid) ?? keys.identity
    const proofBuffer = unb64u(proof)
    let matched = null
    for (const candidate of keys.candidates()) {
      if (verifyBindProof(candidate.psk, { kid, spk: identity.spki, cpk, nonce: challenge.nonce, proof: proofBuffer })) {
        matched = candidate
        break
      }
    }
    if (!matched) {
      stats.rejected += 1
      logger.warn('bind rejected: bad proof', { kid, remote: clientAddr(req) })
      return deny(res, 401, 'bad_proof')
    }
    let secret
    try {
      secret = sharedSecret(identity.privateJwk, cpk)
    } catch (error) {
      return sendJson(res, 400, { error: 'bad_public_key', detail: String(error?.message ?? error) })
    }
    const sidBuffer = newSessionId()
    const sid = b64u(sidBuffer)
    const derived = deriveKeys({
      secret,
      salt: unb64u(challenge.nonce),
      kid,
      spk: identity.spki,
      cpk,
      sessionId: sidBuffer,
    })
    const session = sessions.create({
      sid: sidBuffer,
      kid,
      keys: derived,
      pskKid: matched.kid,
      remote: clientAddr(req),
      userAgent: req.headers['user-agent'] ?? null,
    })
    bindSessionCookie(res, req, sid, Math.floor(sessions_ttl / 1000))
    logger.info('session bound', { sid: `${sid.slice(0, 8)}…`, kid, pskKid: matched.kid, remote: session.remote })
    sendJson(
      res,
      200,
      {
        v: 1,
        sid,
        ttl: Math.floor(sessions_ttl / 1000),
        renewAfter: Math.floor((sessions_ttl * 0.7) / 1000),
        pskKid: matched.kid,
      },
      { 'cache-control': 'no-store' },
    )
  }

  // ───────────────────────────── 加密数据面 ─────────────────────────────

  async function handleE2E(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    const session = sessionFromRequest(req)
    if (!session) return deny(res, 401, 'no_session')
    if (!sameOrigin(req)) return deny(res, 403, 'bad_origin')
    stats.e2e += 1

    const body = await readBody(req, config.proxy.maxBodyBytes)
    stats.bytesIn += body.length
    const decoder = new FrameDecoder({ maxFrameBytes: config.e2e.maxFrameBytes })
    let frames
    try {
      frames = decoder.push(body)
    } catch (error) {
      return deny(res, 400, 'bad_frame', String(error?.message ?? error))
    }
    if (frames.length === 0) return deny(res, 400, 'empty_body')

    const requests = []
    for (const frame of frames) {
      if (!session.c2sWindow.allows(frame.readUInt32BE(2))) continue
      let opened
      try {
        opened = openFrame({ key: session.keys.c2s, sid: session.sid, frame, aadExtra: Buffer.from('c2s') })
      } catch (error) {
        stats.rejected += 1
        return deny(res, 400, 'decrypt_failed', String(error?.message ?? error))
      }
      if (!session.c2sWindow.accept(opened.seq)) continue
      if (opened.type !== FRAME_DATA) continue
      requests.push(opened.plaintext)
    }
    if (requests.length === 0) return deny(res, 400, 'no_data_frame')

    let envelope
    try {
      envelope = JSON.parse(Buffer.concat(requests).toString('utf8'))
    } catch {
      return deny(res, 400, 'bad_envelope')
    }
    if (!validateEnvelope(envelope)) return deny(res, 400, 'bad_envelope')

    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    const crypto = { session, seq: () => sessions.nextSeq(session), closed: false }
    const writeFrame = (type, plaintext) => {
      if (crypto.closed || res.writableEnded) return false
      const frame = sealFrame({
        key: session.keys.s2c,
        sid: session.sid,
        seq: crypto.seq(),
        type,
        plaintext,
        aadExtra: Buffer.from('s2c'),
      })
      const wire = encodeLengthPrefixed(frame)
      const ok = res.write(wire)
      stats.bytesOut += frame.length
      session.bytesOut += frame.length
      return ok
    }
    const finish = (control) => {
      if (crypto.closed) return
      try {
        if (control) writeFrame(FRAME_CLOSE, Buffer.from(JSON.stringify(control)))
      } finally {
        crypto.closed = true
        if (!res.writableEnded) res.end()
      }
    }
    res.on('close', () => {
      crypto.closed = true
    })

    await forwardToUpstream(envelope, {
      session,
      writeFrame,
      finish,
      res,
    })
  }

  function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return false
    const { m, p, h, b } = envelope
    if (typeof m !== 'string' || !/^[A-Z]+$/u.test(m)) return false
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > 8192) return false
    if (p.startsWith('//')) return false
    if (h !== undefined && (typeof h !== 'object' || h === null || Array.isArray(h))) return false
    if (h) {
      const names = Object.keys(h)
      if (names.length > 64) return false
      for (const name of names) {
        if (name.length > 128 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) return false
        const value = h[name]
        if (typeof value !== 'string' && !Array.isArray(value)) return false
      }
    }
    if (b !== undefined && b !== null && typeof b !== 'string') return false
    if (typeof b === 'string' && b.length > Math.ceil((config.proxy.maxBodyBytes * 4) / 3) + 8) return false
    return true
  }

  async function forwardToUpstream(envelope, { session, writeFrame, finish, res }) {
    const method = envelope.m
    const path = envelope.p
    const headers = scrubUpstreamHeaders(envelope.h ?? {}, { method })
    const bodyBuffer = typeof envelope.b === 'string' && envelope.b.length > 0 ? unb64u(envelope.b) : null

    const upstreamReq = http.request(
      {
        host: upstream.info.host,
        port: upstream.info.port,
        method,
        path,
        headers,
      },
      (upstreamRes) => {
        const responseHeaders = cleanResponseHeaders(upstreamRes.headers)
        const meta = { s: upstreamRes.statusCode ?? 502, h: responseHeaders }
        const renewal = sessions.takeRenewal(session, session.pskKid)
        if (renewal) meta.renew = renewal
        const primary = writeFrame(FRAME_CONTROL, Buffer.from(JSON.stringify(meta)))
        let closed = false
        const abort = () => {
          closed = true
          upstreamRes.destroy()
        }
        res.on('close', abort)
        if (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403) {
          upstream.onUnauthorized().catch((error) => logger.warn('upstream rebootstrap failed', { error: String(error?.message ?? error) }))
        }
        upstreamRes.on('data', (chunk) => {
          if (closed) return
          if (!writeFrame(FRAME_DATA, chunk)) {
            upstreamRes.pause()
            res.once('drain', () => upstreamRes.resume())
          }
          session.bytesIn += chunk.length
        })
        upstreamRes.on('end', () => {
          finish({ t: 'end' })
        })
        upstreamRes.on('error', (error) => {
          finish({ t: 'error', message: String(error?.message ?? error) })
        })
        if (!primary) upstreamRes.pause()
      },
    )
    upstreamReq.on('error', (error) => {
      stats.errors += 1
      writeFrame(FRAME_CONTROL, Buffer.from(JSON.stringify({ s: 502, h: { 'content-type': 'text/plain; charset=utf-8' } })))
      writeFrame(FRAME_DATA, Buffer.from(`upstream error: ${String(error?.message ?? error)}\n`))
      finish({ t: 'error', message: `upstream: ${String(error?.message ?? error)}` })
    })
    if (bodyBuffer) upstreamReq.end(bodyBuffer)
    else upstreamReq.end()
  }

  function handleLink(req, res) {
    const session = sessionFromRequest(req)
    if (!session) return deny(res, 401, 'no_session')
    const base = publicBaseUrl(req)
    const active = keys.activePsk()
    sendJson(res, 200, {
      link: keys.link(base),
      kid: active?.kid ?? null,
      expiresAt: active ? new Date(active.expiresAt).toISOString() : null,
      session: { sid: `${session.sidB64.slice(0, 8)}…`, kid: session.pskKid },
    })
  }

  // ───────────────────────────── 静态转发 ─────────────────────────────

  function proxyStatic(req, res, url, { retried = false, injectE2eShim = true } = {}) {
    const headers = scrubUpstreamHeaders(req.headers, { method: req.method, raw: true })
    const upstreamReq = http.request(
      {
        host: upstream.info.host,
        port: upstream.info.port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502
        if ((status === 401 || status === 403) && !retried && (req.method === 'GET' || req.method === 'HEAD')) {
          upstreamRes.resume()
          upstream
            .onUnauthorized()
            .then(() => proxyStatic(req, res, url, { retried: true, injectE2eShim }))
            .catch((error) => {
              stats.errors += 1
              if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
              if (!res.writableEnded) res.end(`upstream auth refresh failed: ${String(error?.message ?? error)}\n`)
            })
          return
        }
        if (status === 401 || status === 403) {
          upstream.onUnauthorized().catch((error) => logger.warn('upstream rebootstrap failed', { error: String(error?.message ?? error) }))
        }
        const outHeaders = cleanResponseHeaders(upstreamRes.headers)
        const contentType = String(outHeaders['content-type'] ?? '')
        const isHtml = contentType.includes('text/html')
        if (!isHtml || !injectE2eShim) {
          if (isHtml) outHeaders['cache-control'] = 'no-store'
          res.writeHead(status, outHeaders)
          upstreamRes.pipe(res)
          return
        }
        const chunks = []
        let size = 0
        upstreamRes.on('data', (chunk) => {
          size += chunk.length
          if (size > 8 * 1024 * 1024) {
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        upstreamRes.on('end', () => {
          const html = injectShim(Buffer.concat(chunks).toString('utf8'))
          delete outHeaders['content-length']
          outHeaders['cache-control'] = 'no-store'
          res.writeHead(status, outHeaders)
          res.end(html)
        })
      },
    )
    upstreamReq.on('error', (error) => {
      stats.errors += 1
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      if (!res.writableEnded) res.end(`upstream error: ${String(error?.message ?? error)}\n`)
    })
    res.on('close', () => {
      if (!upstreamReq.destroyed && !res.writableEnded) upstreamReq.destroy()
    })
    req.pipe(upstreamReq)
  }

  function injectShim(html) {
    if (!config.e2e.enabled || html.includes(E2E_PREFIX + '/shim.js')) return html
    const tag = `<script src="${E2E_PREFIX}/shim.js?v=${shimBuild}" data-dsh-remote="e2e"></script>`
    if (/<head[^>]*>/iu.test(html)) return html.replace(/<head[^>]*>/iu, (match) => `${match}${tag}`)
    return `${tag}${html}`
  }

  // ───────────────────────────── WebSocket 桥 ─────────────────────────────

  async function handleUpgrade(req, socket, head) {
    const url = new URL(normalizePath(req.url), 'http://relay.invalid')
    if (!url.pathname.startsWith(`${E2E_PREFIX}/`)) {
      // App / 明文通道：直通上游 WS（cookie 由 relay 注入）
      const plain = plainSessionFromRequest(req)
      if (!plain) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }
      if (!sameOrigin(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      await bridgePlainWebSocket(req, socket, head, `${url.pathname}${url.search}`)
      return
    }
    if (url.pathname !== `${E2E_PREFIX}/ws`) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    const session = sessionFromRequest(req)
    if (!session) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    if (!sameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const client = acceptUpgrade(req, socket, head, { maxPayload: config.e2e.maxFrameBytes })
    if (!client) return
    stats.ws += 1
    session.ws = client
    client.on('close', () => {
      if (session.ws === client) session.ws = null
    })
    bridgeWebSocket(session, client)
  }

  function bridgeWebSocket(session, client) {
    const decoder = new FrameDecoder({ maxFrameBytes: config.e2e.maxFrameBytes })
    let upstreamWs = null
    const queue = []
    let closed = false

    const sendControl = (obj) => {
      const frame = sealFrame({
        key: session.keys.s2c,
        sid: session.sid,
        seq: sessions.nextSeq(session),
        type: FRAME_CONTROL,
        plaintext: Buffer.from(JSON.stringify(obj)),
        aadExtra: Buffer.from('s2c'),
      })
      client.sendBinary(encodeLengthPrefixed(frame))
    }
    const sendData = (opcode, payload, type = FRAME_DATA) => {
      const plaintext = Buffer.concat([Buffer.from([opcode]), payload])
      const frame = sealFrame({
        key: session.keys.s2c,
        sid: session.sid,
        seq: sessions.nextSeq(session),
        type,
        plaintext,
        aadExtra: Buffer.from('s2c'),
      })
      client.sendBinary(encodeLengthPrefixed(frame))
    }
    const shutdown = (code = 1000, reason = 'relay closed') => {
      if (closed) return
      closed = true
      try {
        upstreamWs?.close(code, reason)
      } catch {}
      try {
        client.close(code, reason)
      } catch {}
    }

    const openUpstream = async (init) => {
      const targetPath = typeof init?.p === 'string' && init.p.startsWith('/') ? init.p : '/'
      const headers = scrubUpstreamHeaders(init?.h ?? {}, { method: 'GET', ws: true })
      const renewal = sessions.takeRenewal(session, session.pskKid)
      if (renewal) sendControl({ t: 'rotate', renew: renewal })
      const target = `ws://${upstream.info.host}:${upstream.info.port}${targetPath}`
      try {
        upstreamWs = await connectWebSocket(target, { headers, maxPayload: config.e2e.maxFrameBytes })
      } catch (error) {
        const msg = String(error?.message ?? error)
        if (/\b(401|403)\b/.test(msg)) {
          await upstream.onUnauthorized().catch(() => {})
          const retryHeaders = scrubUpstreamHeaders(init?.h ?? {}, { method: 'GET', ws: true })
          try {
            upstreamWs = await connectWebSocket(target, { headers: retryHeaders, maxPayload: config.e2e.maxFrameBytes })
          } catch (retryError) {
            logger.warn('upstream ws failed after reauth', { error: String(retryError?.message ?? retryError), target })
            sendControl({ t: 'error', message: `upstream ws: ${String(retryError?.message ?? retryError)}` })
            shutdown(1011, 'upstream failed')
            return
          }
        } else {
          logger.warn('upstream ws failed', { error: msg, target })
          sendControl({ t: 'error', message: `upstream ws: ${msg}` })
          shutdown(1011, 'upstream failed')
          return
        }
      }
      upstreamWs.on('message', (payload, isText) => {
        if (closed) return
        sendData(isText ? 0x1 : 0x2, payload)
      })
      upstreamWs.on('close', (code, reason) => {
        sendControl({ t: 'close', code, reason: String(reason ?? '') })
        shutdown(code === 1005 ? 1000 : code, String(reason ?? ''))
      })
      upstreamWs.on('error', (error) => {
        sendControl({ t: 'error', message: String(error?.message ?? error) })
      })
      upstreamWs.on('ping', (payload) => client.ping(payload))
      for (const item of queue.splice(0)) deliverUpstream(item)
    }

    const deliverUpstream = (message) => {
      if (!upstreamWs) {
        queue.push(message)
        return
      }
      if (message.opcode === 0x1) upstreamWs.sendText(message.payload)
      else upstreamWs.sendBinary(message.payload)
    }

    client.on('message', (payload, isText) => {
      if (closed) return
      if (isText) {
        // 明文控制帧只允许出现在上游就绪前；其它一律拒绝，避免绕过加密
        return
      }
      let frames
      try {
        frames = decoder.push(payload)
      } catch (error) {
        sendControl({ t: 'error', message: String(error?.message ?? error) })
        shutdown(1002, 'bad frame')
        return
      }
      for (const frame of frames) {
        if (!session.c2sWindow.allows(frame.readUInt32BE(2))) continue
        let opened
        try {
          opened = openFrame({ key: session.keys.c2s, sid: session.sid, frame, aadExtra: Buffer.from('c2s') })
        } catch (error) {
          sendControl({ t: 'error', message: 'decrypt failed' })
          shutdown(1002, 'decrypt failed')
          return
        }
        if (!session.c2sWindow.accept(opened.seq)) continue
        if (opened.type === FRAME_CONTROL) {
          let init
          try {
            init = JSON.parse(opened.plaintext.toString('utf8'))
          } catch {
            continue
          }
          if (init?.t === 'init' && !upstreamWs) openUpstream(init)
          else if (init?.t === 'ping') sendControl({ t: 'pong' })
          else if (init?.t === 'close') shutdown(1000, 'client closed')
          continue
        }
        if (opened.type === FRAME_DATA) {
          const opcode = opened.plaintext[0]
          deliverUpstream({ opcode, payload: opened.plaintext.subarray(1) })
        }
      }
    })

    client.on('close', () => shutdown(1000, 'client closed'))
    client.on('error', () => shutdown(1011, 'client error'))
  }

  /** App / 明文通道的 WS 直通：cookie 注入后把帧原样搬运，不做 L7 解析。 */
  async function bridgePlainWebSocket(req, socket, head, pathQuery) {
    const plainMaxPayload = Math.max(config.proxy.maxBodyBytes ?? 64 * 1024 * 1024, config.e2e.maxFrameBytes)
    const client = acceptUpgrade(req, socket, head, { maxPayload: plainMaxPayload })
    if (!client) return
    const headers = scrubUpstreamHeaders(req.headers, { method: 'GET', ws: true })
    const target = `ws://${upstream.info.host}:${String(upstream.info.port)}${pathQuery}`
    const queue = []
    let upstreamWs = null
    let closed = false
    const shutdown = (code = 1000, reason = 'relay closed') => {
      if (closed) return
      closed = true
      try {
        upstreamWs?.close(code, reason)
      } catch {}
      try {
        client.close(code, reason)
      } catch {}
    }
    client.on('message', (payload, isText) => {
      if (closed) return
      if (!upstreamWs) {
        queue.push({ payload, isText })
        return
      }
      if (isText) upstreamWs.sendText(payload)
      else upstreamWs.sendBinary(payload)
    })
    client.on('ping', (payload) => upstreamWs?.ping(payload))
    client.on('close', () => shutdown(1000, 'client closed'))
    client.on('error', (error) => {
      logger.warn('plain ws client error', { error: String(error?.message ?? error) })
      shutdown(1011, 'client error')
    })
    try {
      upstreamWs = await connectWebSocket(target, { headers, maxPayload: plainMaxPayload })
    } catch (error) {
      const msg = String(error?.message ?? error)
      if (/\b(401|403)\b/.test(msg)) {
        await upstream.onUnauthorized().catch(() => {})
        const retryHeaders = scrubUpstreamHeaders(req.headers, { method: 'GET', ws: true })
        const retryTarget = `ws://${upstream.info.host}:${String(upstream.info.port)}${pathQuery}`
        try {
          upstreamWs = await connectWebSocket(retryTarget, { headers: retryHeaders, maxPayload: plainMaxPayload })
        } catch (retryError) {
          stats.errors += 1
          logger.warn('plain ws upstream failed after reauth', { error: String(retryError?.message ?? retryError), target: retryTarget })
          shutdown(1011, 'upstream failed')
          return
        }
      } else {
        stats.errors += 1
        logger.warn('plain ws upstream failed', { error: msg, target })
        shutdown(1011, 'upstream failed')
        return
      }
    }
    stats.ws += 1
    upstreamWs.on('message', (payload, isText) => {
      if (closed) return
      if (isText) client.sendText(payload)
      else client.sendBinary(payload)
    })
    upstreamWs.on('close', (code, reason) => shutdown(code === 1005 ? 1000 : code, String(reason ?? '')))
    upstreamWs.on('error', (error) => {
      logger.warn('plain ws upstream error', { error: String(error?.message ?? error), target })
      shutdown(1011, 'upstream error')
    })
    upstreamWs.on('ping', (payload) => client.ping(payload))
    for (const item of queue.splice(0)) {
      if (item.isText) upstreamWs.sendText(item.payload)
      else upstreamWs.sendBinary(item.payload)
    }
  }

  // ───────────────────────────── 辅助 ─────────────────────────────

  function scrubUpstreamHeaders(input, { method, raw = false, ws = false } = {}) {
    const out = {}
    for (const [name, value] of Object.entries(input ?? {})) {
      const key = name.toLowerCase()
      if (HOP_BY_HOP.has(key) || DROP_REQUEST.has(key)) continue
      if (key === 'cookie' || key === 'authorization') continue
      if (value === undefined || value === null) continue
      out[key] = value
    }
    if (upstream.info.cookie) out.cookie = upstream.info.cookie
    out.host = `${upstream.info.host}:${String(upstream.info.port)}`
    out.origin = `http://${upstream.info.host}:${String(upstream.info.port)}`
    if (out.referer !== undefined) {
      try {
        const parsed = new URL(String(out.referer))
        out.referer = `http://${upstream.info.host}:${String(upstream.info.port)}${parsed.pathname}${parsed.search}`
      } catch {
        delete out.referer
      }
    }
    if (ws) {
      out.connection = 'Upgrade'
      out.upgrade = 'websocket'
    }
    if (!raw) delete out['accept-encoding']
    return out
  }

  function cleanResponseHeaders(headers) {
    const out = {}
    for (const [name, value] of Object.entries(headers ?? {})) {
      const key = name.toLowerCase()
      if (STRIP_RESPONSE.has(key)) continue
      if (value === undefined) continue
      out[key] = value
    }
    out['x-frame-options'] = 'DENY'
    out['referrer-policy'] = 'no-referrer'
    return out
  }

  function sameOrigin(req) {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const parsed = new URL(String(origin))
      const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
      return parsed.host === host
    } catch {
      return false
    }
  }

  function publicBaseUrl(req) {
    if (config.proxy.publicUrl) return config.proxy.publicUrl.replace(/\/+$/, '')
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `127.0.0.1:${String(config.listen.port)}`)
    const proto = isSecureRequest(req) ? 'https' : 'http'
    return `${proto}://${host}`
  }

  function wantsHtml(req) {
    const accept = String(req.headers.accept ?? '')
    return req.method === 'GET' && (accept.includes('text/html') || req.headers['sec-fetch-mode'] === 'navigate')
  }

  function clientAddr(req) {
    return String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '')
  }

  // ───────────────────────────── 页面 / 响应 ─────────────────────────────

  function sendShim(req, res) {
    // 不协商缓存：shim 是安全边界的一部分，升级后必须立即生效
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': Buffer.byteLength(shim),
      'cache-control': 'no-store, max-age=0',
      'x-shim-build': shimBuild,
      'x-content-type-options': 'nosniff',
    })
    res.end(shim)
  }

  function sendUnlockPage(req, res) {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Remote · 解锁</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111114;color:#e7e7ea;
font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:520px;padding:32px;border:1px solid #2a2a31;border-radius:16px;background:#17171c}
h1{margin:0 0 8px;font-size:18px;letter-spacing:.2px}
p{margin:0 0 12px;color:#9b9ba4}
code{background:#22222a;padding:2px 6px;border-radius:6px;color:#cfcfe6}
#state{margin-top:14px;font-size:13px;color:#8fb7ff;min-height:20px}
.fail{color:#ff9a9a !important}
</style></head>
<body><div class="card">
<h1>需要端到端加密密钥</h1>
<p>这个地址本身不含访问密钥。请使用完整链接打开：<code>https://…/#k=&lt;key&gt;</code></p>
<p>密钥只存在于地址的 <code>#</code> 片段中，浏览器不会把它发送给 Cloudflare。</p>
<div id="state">等待握手…</div>
</div>
<script src="/__dsh/shim.js" data-dsh-remote="unlock"></script>
</body></html>`
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    })
    res.end(html)
  }

  function sendJson(res, status, payload, extraHeaders = {}) {
    const body = Buffer.from(`${JSON.stringify(payload)}\n`)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      ...extraHeaders,
    })
    res.end(body)
  }

  function deny(res, status, code, detail = null) {
    sendJson(res, status, detail ? { error: code, detail } : { error: code })
  }

  async function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error(`请求体超过上限 ${limit}`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  async function readJsonBody(req, limit) {
    try {
      const raw = await readBody(req, limit)
      return JSON.parse(raw.toString('utf8'))
    } catch {
      return null
    }
  }

  async function handleLegacyToken(req, res, url) {
    const token = url.searchParams.get('token')
    keys.reload()
    const viaApp = config.proxy.appBridge && keys.verifyAppToken(token)
    const viaLegacy = config.proxy.legacyToken && keys.verifyLegacyToken(token)
    if (!viaApp && !viaLegacy) {
      stats.rejected += 1
      // 加密链接是 PSK 不是 token：给出可操作的原因，避免客户端只看到 401
      const looksEncrypted = keys.findPskByValue(token)
      return deny(res, 401, looksEncrypted ? 'e2e_link_requires_browser' : 'bad_token')
    }
    const sid = b64u(newSessionId())
    plainSessions.set(sid, { sid, createdAt: Date.now(), expiresAt: Date.now() + sessions_ttl, channel: viaApp ? 'app' : 'legacy' })
    res.setHeader('set-cookie', [
      `${PLAIN_COOKIE}=${sid}; ${cookieAttributes(req, Math.floor(sessions_ttl / 1000))}`,
      // 清除可能残留的旧 E2E 会话 cookie，避免浏览器切到明文 ?token= 通道后仍被注入 shim.js
      `${SESSION_COOKIE}=; ${cookieAttributes(req, 0)}`,
    ])
    res.writeHead(303, { location: './', 'cache-control': 'no-store' })
    res.end()
    if (viaApp) logger.info('app bridge session', { sid: sid.slice(0, 8), remote: clientAddr(req) })
  }

  return {
    server,
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.listen.port, config.listen.host, () => {
          server.removeListener('error', reject)
          resolve(server.address())
        })
      })
    },
    /** 主动向在线会话推送新 PSK（WS 控制帧）。 */
    pushRenewal(session, payload) {
      if (!session?.ws) return false
      const frame = sealFrame({
        key: session.keys.s2c,
        sid: session.sid,
        seq: sessions.nextSeq(session),
        type: FRAME_CONTROL,
        plaintext: Buffer.from(JSON.stringify({ t: 'rotate', renew: payload })),
        aadExtra: Buffer.from('s2c'),
      })
      return session.ws.sendBinary(frame)
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
    describe() {
      return {
        listen: server.address(),
        ...stats,
        sessions: sessions.size,
        plainSessions: plainSessions.size,
        e2e: config.e2e.enabled,
      }
    },
  }
}

/** Cloudflare/代理可能给出 `//path` 形式，统一成绝对路径。 */
function normalizePath(raw) {
  const value = typeof raw === 'string' && raw.length > 0 ? raw : '/'
  if (!value.startsWith('//')) return value
  return `/${value.slice(2)}`
}

function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string' || header === '') return out
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    const name = segment.slice(0, at).trim()
    const value = segment.slice(at + 1).trim()
    if (name) out[name] = value
  }
  return out
}