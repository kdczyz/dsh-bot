/**
 * 握手挑战 + 加密会话存储。
 */
import { randomBytes } from 'node:crypto'
import { b64u, unb64u } from './util.mjs'
import { ReplayWindow, newSessionId } from './crypto.mjs'

export class SessionStore {
  constructor({ ttlMs = 12 * 3_600_000, challengeTtlMs = 120_000, logger } = {}) {
    this.ttlMs = ttlMs
    this.challengeTtlMs = challengeTtlMs
    this.logger = logger
    this.sessions = new Map()
    this.challenges = new Map()
    this.timer = setInterval(() => this.prune(), 60_000)
    this.timer.unref?.()
  }

  issueChallenge(identity) {
    const nonce = randomBytes(16)
    const record = {
      nonce: b64u(nonce),
      kid: identity.kid,
      spk: identity.spki,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.challengeTtlMs,
      used: false,
    }
    this.challenges.set(record.nonce, record)
    this.prune()
    return record
  }

  /** 单次消费：返回挑战记录或 null。 */
  consumeChallenge(nonceB64, kid) {
    const record = this.challenges.get(nonceB64)
    if (!record) return null
    if (record.used || record.expiresAt < Date.now()) {
      this.challenges.delete(nonceB64)
      return null
    }
    if (kid && record.kid !== kid) return null
    record.used = true
    this.challenges.delete(nonceB64)
    return record
  }

  create({ sid = newSessionId(), kid, keys, pskKid, remote = null, userAgent = null }) {
    const now = Date.now()
    const session = {
      sid,
      sidB64: b64u(sid),
      kid,
      pskKid,
      keys,
      c2sWindow: new ReplayWindow(1024),
      s2cSeq: 0,
      createdAt: now,
      lastSeen: now,
      expiresAt: now + this.ttlMs,
      renewKid: pskKid,
      remote,
      userAgent,
      ws: null,
      bytesIn: 0,
      bytesOut: 0,
    }
    this.sessions.set(session.sidB64, session)
    return session
  }

  get(sidB64, { touch = true } = {}) {
    const session = this.sessions.get(sidB64)
    if (!session) return null
    const now = Date.now()
    if (session.expiresAt < now) {
      this.sessions.delete(sidB64)
      return null
    }
    if (touch) session.lastSeen = now
    return session
  }

  getBySidBuffer(sid) {
    return this.get(b64u(sid))
  }

  delete(sidB64) {
    const session = this.sessions.get(sidB64)
    if (!session) return
    try {
      session.ws?.close?.(1000, 'session closed')
    } catch {}
    this.sessions.delete(sidB64)
  }

  setRenewal(session, next) {
    session.renewKid = next.kid
    session.renewPsk = next.psk
  }

  /** 取续期载荷；取过一次就清掉，避免每帧重复。 */
  takeRenewal(session, currentPskKid) {
    if (!session.renewPsk || session.renewKid === currentPskKid) return null
    const payload = { kid: session.renewKid, psk: session.renewPsk }
    session.renewPsk = null
    return payload
  }

  nextSeq(session) {
    const seq = session.s2cSeq
    if (seq > 0xffffffff) throw new Error('会话序号耗尽，需要重新握手')
    session.s2cSeq = seq + 1
    return seq
  }

  prune(now = Date.now()) {
    for (const [key, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(key)
    }
    for (const [key, record] of this.challenges) {
      if (record.expiresAt < now) this.challenges.delete(key)
    }
  }

  all() {
    return [...this.sessions.values()]
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      sid: session.sidB64,
      kid: session.kid,
      pskKid: session.pskKid,
      createdAt: new Date(session.createdAt).toISOString(),
      lastSeen: new Date(session.lastSeen).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      remote: session.remote,
      userAgent: session.userAgent,
      ws: Boolean(session.ws),
      bytesIn: session.bytesIn,
      bytesOut: session.bytesOut,
    }))
  }

  get size() {
    return this.sessions.size
  }

  close() {
    clearInterval(this.timer)
  }
}

export function sidFromHeader(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const raw = unb64u(value)
    return raw.length === 16 ? value : null
  } catch {
    return null
  }
}