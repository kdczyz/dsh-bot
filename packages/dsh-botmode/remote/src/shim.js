/*
 * dsh-remote 浏览器端 shim（classic script，必须先于应用模块执行）。
 *
 * 职责：
 *   1) 从 URL fragment（#k=…，不会发送给 Cloudflare）读取 PSK；
 *   2) ECDH P-256 握手 + HMAC 证明 → 建立 relay 会话；
 *   3) 劫持同源 fetch / WebSocket / EventSource，把业务数据封装为 AES-256-GCM 密文帧；
 *   4) 处理密钥轮换（响应元数据或 WS 控制帧回传新 PSK）。
 *
 * 不拦截：静态资源（由 SPA 自行按普通方式加载）与 /__dsh/* 自身的控制面请求。
 */
(() => {
  'use strict'
  if (window.__DSH_REMOTE_SHIM__) return
  window.__DSH_REMOTE_SHIM__ = { version: 1 }

  const E2E_PREFIX = '/__dsh'
  const E2E_ENDPOINT = `${E2E_PREFIX}/e2e`
  const WS_ENDPOINT = `${E2E_PREFIX}/ws`
  const HANDSHAKE_ENDPOINT = `${E2E_PREFIX}/handshake`
  const BIND_ENDPOINT = `${E2E_PREFIX}/bind`
  const PSK_STORAGE = 'dshr.psk'
  const SID_STORAGE = 'dshr.sid'
  const FRAME_DATA = 1
  const FRAME_CONTROL = 2
  const FRAME_CLOSE = 3
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  try {
    if (new URLSearchParams(location.search).has('dsh_debug')) sessionStorage.setItem('dshr.debug', '1')
    window.__DSH_REMOTE_DEBUG__ = sessionStorage.getItem('dshr.debug') === '1'
  } catch {}

  const state = {
    psk: null,
    pskKid: null,
    sid: null,
    keys: null,
    bindReady: null,
    seq: 0,
    handshakes: 0,
  }

  // ───────────────────────── base64url ─────────────────────────

  function b64u(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < view.length; i += chunk) {
      binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk))
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
  }

  function unb64u(text) {
    const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '==='.slice((normalized.length + 3) % 4)
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
    return out
  }

  function concatBytes(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }

  function textBytes(text) {
    return encoder.encode(String(text))
  }

  function readHashPsk() {
    const hash = String(location.hash || '').replace(/^#/u, '')
    if (!hash) return null
    for (const part of hash.split('&')) {
      const at = part.indexOf('=')
      if (at === -1) continue
      const name = part.slice(0, at)
      if (name !== 'k' && name !== 'key' && name !== 'psk') continue
      const value = decodeURIComponent(part.slice(at + 1))
      if (/^[A-Za-z0-9_-]{20,}$/u.test(value)) return value
    }
    return null
  }

  function currentPsk() {
    if (state.psk) return state.psk
    const fromHash = readHashPsk()
    if (fromHash) {
      state.psk = fromHash
      try { sessionStorage.setItem(PSK_STORAGE, fromHash) } catch {}
      try { localStorage.setItem(PSK_STORAGE, fromHash) } catch {}
      return fromHash
    }
    try {
      const stored = sessionStorage.getItem(PSK_STORAGE) || localStorage.getItem(PSK_STORAGE)
      if (stored) {
        state.psk = stored
        try { sessionStorage.setItem(PSK_STORAGE, stored) } catch {}
        return stored
      }
    } catch {}
    return null
  }

  function storePsk(psk, kid) {
    state.psk = psk
    if (kid) state.pskKid = kid
    try { sessionStorage.setItem(PSK_STORAGE, psk) } catch {}
    try { localStorage.setItem(PSK_STORAGE, psk) } catch {}
  }

  function report(message, isError = false) {
    const el = document.getElementById('state')
    if (!el) return
    el.textContent = message
    el.classList.toggle('fail', isError)
  }

  // ───────────────────────── 帧编解码 ─────────────────────────

  let cachedAes = { c2s: null, s2c: null }

  async function aesKey(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }

  async function loadKeys(c2sRaw, s2cRaw) {
    cachedAes = { c2s: await aesKey(c2sRaw), s2c: await aesKey(s2cRaw) }
    state.keys = { c2s: c2sRaw, s2c: s2cRaw }
  }

  function counterNonce(seq) {
    const nonce = new Uint8Array(12)
    const view = new DataView(nonce.buffer)
    view.setUint32(0, 0)
    view.setBigUint64(4, BigInt(seq))
    return nonce
  }

  async function seal(type, plaintext, direction = 'c2s') {
    const seq = state.seq
    state.seq += 1
    const header = new Uint8Array(6)
    header[0] = 1
    header[1] = type
    new DataView(header.buffer).setUint32(2, seq)
    const aad = concatBytes(header, unb64u(state.sid), textBytes(direction))
    const key = direction === 'c2s' ? cachedAes.c2s : cachedAes.s2c
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: counterNonce(seq), additionalData: aad, tagLength: 128 },
      key,
      plaintext,
    )
    return concatBytes(header, new Uint8Array(ciphertext))
  }

  async function open(frame) {
    if (frame.length < 6 + 16) throw new Error('帧过短')
    if (frame[0] !== 1) throw new Error(`帧版本不支持: ${frame[0]}`)
    const type = frame[1]
    const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2)
    const header = frame.subarray(0, 6)
    const aad = concatBytes(header, unb64u(state.sid), textBytes('s2c'))
    const ciphertext = frame.subarray(6)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: counterNonce(seq), additionalData: aad, tagLength: 128 },
      cachedAes.s2c,
      ciphertext,
    )
    return { type, seq, plaintext: new Uint8Array(plaintext) }
  }

  function lengthPrefixed(frame) {
    const out = new Uint8Array(4 + frame.length)
    new DataView(out.buffer).setUint32(0, frame.length)
    out.set(frame, 4)
    return out
  }

  class FrameReader {
    constructor() {
      this.buffer = new Uint8Array(0)
      this.consumed = 0
    }

    push(chunk) {
      if (chunk && chunk.length) {
        const merged = new Uint8Array(this.buffer.length + chunk.length)
        merged.set(this.buffer)
        merged.set(chunk, this.buffer.length)
        this.buffer = merged
      }
      if (this.buffer.length < 4) return null
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0)
      if (length > 8 * 1024 * 1024) throw new Error(`帧过大: ${length}`)
      if (this.buffer.length < 4 + length) return null
      const frame = this.buffer.slice(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      return frame
    }

    get pending() {
      return this.buffer.length
    }
  }

  // ───────────────────────── 握手 / 绑定 ─────────────────────────

  async function bind() {
    const psk = currentPsk()
    if (!psk) throw new Error('地址缺少 #k=<key> 访问密钥')
    const handshake = await rawFetch(HANDSHAKE_ENDPOINT, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    if (!handshake.ok) throw new Error(`握手失败: HTTP ${String(handshake.status)}`)
    const challenge = await handshake.json()
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const clientPub = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
    const serverPub = await crypto.subtle.importKey(
      'spki',
      unb64u(challenge.spk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPub }, keyPair.privateKey, 256))
    const pskBytes = unb64u(psk)
    const hmacKey = await crypto.subtle.importKey('raw', pskBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const proofInput = concatBytes(
      textBytes('dsh-remote/v1/bind'),
      new Uint8Array([0]),
      textBytes(challenge.kid),
      new Uint8Array([0]),
      textBytes(challenge.spk),
      new Uint8Array([0]),
      textBytes(b64u(clientPub)),
      new Uint8Array([0]),
      unb64u(challenge.nonce),
    )
    const proof = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, proofInput))

    const response = await rawFetch(BIND_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        kid: challenge.kid,
        cpk: b64u(clientPub),
        nonce: challenge.nonce,
        proof: b64u(proof),
      }),
    })
    if (response.status === 401) throw new Error('访问密钥被拒绝（可能已轮换，请使用最新链接）')
    if (!response.ok) throw new Error(`绑定失败: HTTP ${String(response.status)}`)
    const result = await response.json()
    state.sid = result.sid
    state.pskKid = result.pskKid ?? null
    try {
      sessionStorage.setItem(SID_STORAGE, result.sid)
    } catch {}

    const sidBytes = unb64u(result.sid)
    const info = concatBytes(
      textBytes('dsh-remote/v1/keys'),
      new Uint8Array([0]),
      textBytes(challenge.kid),
      unb64u(challenge.spk),
      clientPub,
      sidBytes,
    )
    const hkdfKey = await crypto.subtle.importKey('raw', shared, { name: 'HKDF' }, false, ['deriveBits'])
    const okm = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: unb64u(challenge.nonce), info },
        hkdfKey,
        512,
      ),
    )
    await loadKeys(okm.slice(0, 32), okm.slice(32, 64))
    state.handshakes += 1
    return result
  }

  function ensureSession() {
    if (state.keys && state.sid) return Promise.resolve()
    if (state.bindReady) return state.bindReady
    state.bindReady = bind()
      .catch((error) => {
        state.bindReady = null
        throw error
      })
      .then((result) => {
        state.bindReady = null
        return result
      })
    return state.bindReady
  }

  function rawFetch(input, init) {
    return originalFetch(input, init)
  }

  /** 401 → 重新绑定一次并重试。 */
  async function withSession(fn) {
    await ensureSession()
    try {
      return await fn()
    } catch (error) {
      if (error && error.__dshUnauthorized) {
        state.keys = null
        state.sid = null
        await ensureSession()
        return fn()
      }
      throw error
    }
  }

  // ───────────────────────── fetch ─────────────────────────

  const originalFetch = window.fetch.bind(window)
  const originalWebSocket = window.WebSocket
  const originalEventSource = window.EventSource

  function applyRenew(payload) {
    if (!payload || typeof payload.psk !== 'string') return
    storePsk(payload.psk, payload.kid)
    state.pskKid = payload.kid ?? state.pskKid
  }

  async function readRequestBody(request) {
    if (request.method === 'GET' || request.method === 'HEAD') return { bytes: null, contentType: null }
    if (!request.body) return { bytes: null, contentType: request.headers.get('content-type') }
    const buffer = await request.arrayBuffer()
    return { bytes: new Uint8Array(buffer), contentType: request.headers.get('content-type') }
  }

  function headersToObject(headers) {
    const out = {}
    headers.forEach((value, name) => {
      const key = name.toLowerCase()
      if (key === 'content-length' || key === 'connection' || key === 'host' || key === 'cookie') return
      if (key.startsWith('x-dsh-')) return
      out[key] = value
    })
    return out
  }

  async function e2eFetch(request) {
    const url = new URL(request.url)
    return withSession(async () => {
      const { bytes, contentType } = await readRequestBody(request)
      const headers = headersToObject(request.headers)
      if (contentType) headers['content-type'] = contentType
      const envelope = {
        v: 1,
        m: request.method,
        p: `${url.pathname}${url.search}`,
        h: headers,
        b: bytes && bytes.length > 0 ? b64u(bytes) : null,
      }
      const frame = await seal(FRAME_DATA, textBytes(JSON.stringify(envelope)), 'c2s')
      const response = await rawFetch(E2E_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/octet-stream' },
        body: lengthPrefixed(frame),
        signal: request.signal,
      })
      if (response.status === 401) {
        const error = new Error('relay session expired')
        error.__dshUnauthorized = true
        throw error
      }
      if (!response.ok || !response.body) throw new Error(`relay HTTP ${String(response.status)}`)

      const reader = response.body.getReader()
      const frames = new FrameReader()
      let meta = null
      let closed = false

      const pullFrame = async () => {
        for (;;) {
          const ready = frames.push(null)
          if (ready) return ready
          const { value, done } = await reader.read()
          if (done) return null
          const parsed = frames.push(value)
          if (parsed) return parsed
          const frame = frames.push(null)
          if (frame) return frame
        }
      }

      const first = await pullFrame()
      if (!first) throw new Error('relay 未返回响应帧')
      const opened = await open(first)
      if (opened.type !== FRAME_CONTROL) throw new Error('响应缺少元数据帧')
      meta = JSON.parse(decoder.decode(opened.plaintext))
      if (meta.renew) applyRenew(meta.renew)
      if (meta.t === 'error') throw new Error(meta.message || 'relay error')

      const stream = new ReadableStream({
        async pull(controller) {
          if (closed) return
          for (;;) {
            const frame = await pullFrame()
            if (!frame) {
              closed = true
              controller.close()
              return
            }
            const item = await open(frame)
            if (item.type === FRAME_DATA) {
              controller.enqueue(item.plaintext)
              return
            }
            if (item.type === FRAME_CONTROL) {
              try {
                const control = JSON.parse(decoder.decode(item.plaintext))
                if (control.renew) applyRenew(control.renew)
                if (control.t === 'error') {
                  closed = true
                  controller.error(new Error(control.message || 'relay error'))
                  return
                }
              } catch {}
              continue
            }
            if (item.type === FRAME_CLOSE) {
              closed = true
              controller.close()
              return
            }
          }
        },
        cancel(reason) {
          closed = true
          try {
            reader.cancel(reason)
          } catch {}
        },
      })

      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(meta.h || {})) {
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
        else if (value !== undefined && value !== null) responseHeaders.set(name, String(value))
      }
      return new Response(request.method === 'HEAD' ? null : stream, {
        status: meta.s,
        statusText: '',
        headers: responseHeaders,
      })
    })
  }

  window.fetch = function shimFetch(input, init) {
    let request
    try {
      request = new Request(input, init)
    } catch {
      return originalFetch(input, init)
    }
    let url
    try {
      url = new URL(request.url, location.href)
    } catch {
      return originalFetch(input, init)
    }
    if (url.origin !== location.origin) return originalFetch(input, init)
    if (url.pathname.startsWith(E2E_PREFIX) || request.method === 'OPTIONS') return originalFetch(input, init)
    return e2eFetch(request)
  }

  // ───────────────────────── WebSocket ─────────────────────────

  class RemoteWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    constructor(url, protocols) {
      super()
      this.url = String(url)
      this.protocol = ''
      this.readyState = RemoteWebSocket.CONNECTING
      this.binaryType = 'blob'
      this.onopen = null
      this.onmessage = null
      this.onerror = null
      this.onclose = null
      this.#target = new URL(this.url, location.href)
      this.#protocols = protocols
      this.#queue = []
      this.#init()
    }

    #target
    #socket = null
    #queue = []
    #ready = false
    #reader = new FrameReader()
    #closed = false
    #chain = Promise.resolve()
    #protocols

    async #init() {
      try {
        await ensureSession()
      } catch (error) {
        this.#fail(error)
        return
      }
      const wsUrl = new URL(WS_ENDPOINT, location.href)
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new originalWebSocket(wsUrl.href, this.#protocols)
      this.#socket = socket
      socket.binaryType = 'arraybuffer'
      socket.onopen = async () => {
        try {
          const init = {
            t: 'init',
            p: `${this.#target.pathname}${this.#target.search}`,
            h: { origin: location.origin },
          }
          const frame = await seal(FRAME_CONTROL, textBytes(JSON.stringify(init)), 'c2s')
          socket.send(lengthPrefixed(frame))
          this.#ready = true
          this.readyState = RemoteWebSocket.OPEN
          this.#emit('open', new Event('open'))
          for (const item of this.#queue.splice(0)) this.send(item.data)
        } catch (error) {
          this.#fail(error)
        }
      }
      socket.onmessage = (event) => {
        this.#chain = this.#chain.then(() => this.#onData(event.data)).catch((error) => this.#fail(error))
      }
      socket.onerror = () => this.#fail(new Error('relay WebSocket error'))
      socket.onclose = (event) => this.#finish(event.code, event.reason)
    }

    #emit(type, event) {
      const handler = this[`on${type}`]
      if (typeof handler === 'function') {
        try {
          handler.call(this, event)
        } catch (error) {
          console.error('[dsh-remote] ws handler error', error)
        }
      }
      this.dispatchEvent(event)
    }

    #fail(error) {
      if (this.#closed) return
      this.#closed = true
      this.readyState = RemoteWebSocket.CLOSED
      const event = new Event('error')
      event.error = error
      event.message = String(error?.message ?? error)
      this.#emit('error', event)
      this.#finish(1006, 'relay error')
    }

    #finish(code, reason) {
      if (this.readyState === RemoteWebSocket.CLOSED) return
      this.#closed = true
      this.readyState = RemoteWebSocket.CLOSED
      const event = new CloseEvent('close', { code, reason: String(reason ?? ''), wasClean: code !== 1006 })
      this.#emit('close', event)
    }

    async #onData(data) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(await data.arrayBuffer())
      const queue = []
      try {
        const first = this.#reader.push(bytes)
        if (first) queue.push(first)
        for (;;) {
          const next = this.#reader.push(null)
          if (!next) break
          queue.push(next)
        }
      } catch (error) {
        this.#fail(error)
        return
      }
      for (const frame of queue) {
        await this.#handleFrame(frame)
        if (this.#closed) return
      }
    }

    async #handleFrame(frame) {
      let opened
      try {
        opened = await open(frame)
      } catch (error) {
        this.#fail(error)
        return
      }
      if (opened.type === FRAME_CONTROL) {
        try {
          const control = JSON.parse(decoder.decode(opened.plaintext))
          if (control.renew) applyRenew(control.renew)
          if (control.t === 'close') this.#finish(control.code ?? 1000, control.reason ?? '')
          if (control.t === 'error') this.#fail(new Error(control.message || 'relay error'))
        } catch {}
        return
      }
      if (opened.type !== FRAME_DATA) return
      const opcode = opened.plaintext[0]
      const payload = opened.plaintext.slice(1)
      let value
      if (opcode === 0x1) value = decoder.decode(payload)
      else if (this.binaryType === 'arraybuffer') value = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
      else value = new Blob([payload])
      this.#emit('message', new MessageEvent('message', { data: value }))
    }

    send(data) {
      if (this.readyState === RemoteWebSocket.CONNECTING || !this.#ready) {
        this.#queue.push({ data })
        return
      }
      if (this.readyState !== RemoteWebSocket.OPEN) throw new Error('WebSocket 已关闭')
      let opcode = 0x1
      let payload
      if (typeof data === 'string') {
        payload = textBytes(data)
      } else if (data instanceof Blob) {
        opcode = 0x2
        data.arrayBuffer().then((buffer) => this.#sendBinary(new Uint8Array(buffer)))
        return
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        opcode = 0x2
        payload = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      } else {
        opcode = 0x1
        payload = textBytes(String(data))
      }
      this.#sendBinary(payload, opcode)
    }

    #sendBinary(payload, opcode = 0x2) {
      const plaintext = concatBytes(new Uint8Array([opcode]), payload)
      seal(FRAME_DATA, plaintext, 'c2s')
        .then((frame) => this.#socket && this.#socket.readyState === 1 && this.#socket.send(lengthPrefixed(frame)))
        .catch((error) => this.#fail(error))
    }

    close(code = 1000, reason = '') {
      if (this.readyState === RemoteWebSocket.CLOSED || this.readyState === RemoteWebSocket.CLOSING) return
      this.readyState = RemoteWebSocket.CLOSING
      const socket = this.#socket
      if (socket && socket.readyState === 1) {
        seal(FRAME_CONTROL, textBytes(JSON.stringify({ t: 'close' })), 'c2s')
          .then((frame) => socket.send(lengthPrefixed(frame)))
          .catch(() => {})
      }
      setTimeout(() => {
        try {
          socket?.close(code, reason)
        } catch {}
        this.#finish(code, reason)
      }, 50)
    }
  }

  RemoteWebSocket.prototype.CONNECTING = 0
  RemoteWebSocket.prototype.OPEN = 1
  RemoteWebSocket.prototype.CLOSING = 2
  RemoteWebSocket.prototype.CLOSED = 3

  const wsStats = { shimmed: 0, passthrough: 0, lastUrl: null, lastError: null }
  window.WebSocket = function shimWebSocket(url, protocols) {
    try {
      const target = new URL(String(url), location.href)
      wsStats.lastUrl = target.href
      // ws:/wss: 与 http:/https: 的 origin 不同，需按 host 比较
      const sameHost = target.host === location.host
      const httpish = ['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)
      if (sameHost && httpish && !target.pathname.startsWith(E2E_PREFIX)) {
        wsStats.shimmed += 1
        return new RemoteWebSocket(url, protocols)
      }
    } catch (error) {
      wsStats.lastError = String(error?.message ?? error)
    }
    wsStats.passthrough += 1
    return new originalWebSocket(url, protocols)
  }
  window.WebSocket.prototype = originalWebSocket.prototype
  Object.assign(window.WebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  })

  // ───────────────────────── EventSource ─────────────────────────

  class RemoteEventSource extends EventTarget {
    constructor(url, options = {}) {
      super()
      this.url = String(url)
      this.readyState = 0
      this.onmessage = null
      this.onerror = null
      this.onopen = null
      this.#options = options
      this.#start()
    }

    #options
    #controller = null
    #buffer = ''

    async #start() {
      const target = new URL(this.url, location.href)
      try {
        this.#controller = new AbortController()
        const response = await window.fetch(target.href, {
          method: 'GET',
          headers: { accept: 'text/event-stream', ...(this.#options.headers || {}) },
          signal: this.#controller.signal,
          cache: 'no-store',
        })
        if (!response.ok || !response.body) throw new Error(`EventSource HTTP ${String(response.status)}`)
        this.readyState = 1
        this.dispatchEvent(new Event('open'))
        const reader = response.body.getReader()
        const textDecoder = new TextDecoder()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          this.#buffer += textDecoder.decode(value, { stream: true })
          let index
          while ((index = this.#buffer.indexOf('\n\n')) !== -1) {
            const chunk = this.#buffer.slice(0, index)
            this.#buffer = this.#buffer.slice(index + 2)
            this.#dispatchChunk(chunk)
          }
        }
        this.readyState = 2
      } catch (error) {
        if (this.#controller?.signal.aborted) return
        this.readyState = 2
        const event = new Event('error')
        event.message = String(error?.message ?? error)
        this.dispatchEvent(event)
      }
    }

    #dispatchChunk(chunk) {
      let event = 'message'
      let data = ''
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += `${line.slice(5).trim()}\n`
      }
      if (data.endsWith('\n')) data = data.slice(0, -1)
      const message = new MessageEvent(event, { data })
      const handler = this[`on${event}`]
      if (typeof handler === 'function') handler.call(this, message)
      this.dispatchEvent(message)
    }

    close() {
      this.readyState = 2
      this.#controller?.abort()
    }
  }

  if (originalEventSource) {
    window.EventSource = function shimEventSource(url, options) {
      try {
        const target = new URL(String(url), location.href)
        if (target.origin === location.origin && !target.pathname.startsWith(E2E_PREFIX)) {
          return new RemoteEventSource(url, options)
        }
      } catch {}
      return new originalEventSource(url, options)
    }
    window.EventSource.prototype = originalEventSource.prototype
  }

  // ───────────────────────── 启动 ─────────────────────────

  async function boot() {
    const psk = currentPsk()
    if (document.getElementById('state')) {
      if (!psk) {
        report('缺少 #k=<key> 访问密钥，请用完整链接打开。', true)
        return
      }
      report('正在建立端到端加密会话…')
      try {
        await ensureSession()
        report('已解锁，正在进入…')
        location.replace('/')
      } catch (error) {
        report(`解锁失败：${String(error?.message ?? error)}`, true)
      }
      return
    }
    if (!psk) return
    ensureSession().catch((error) => {
      console.warn('[dsh-remote] session failed', error)
    })
  }

  window.__DSH_REMOTE__ = {
    state,
    version: 1,
    wsStats,
    bind: ensureSession,
    pskKid: () => state.pskKid,
    handshakes: () => state.handshakes,
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()