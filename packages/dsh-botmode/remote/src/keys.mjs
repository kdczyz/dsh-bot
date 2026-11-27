/**
 * 密钥环：relay 长期身份（ECDH P-256）+ 对外访问密钥（PSK）+ 兼容用明文 token。
 *
 * 轮换语义：
 *   - active PSK 到期前 rotate() 生成新 active；旧 PSK 进入 grace 窗口继续可验证；
 *   - grace 结束后旧 PSK 失效，已建立会话不受影响（会话密钥独立于 PSK）；
 *   - 新 PSK 通过已加密的会话回传（会话内 renew 帧 + 响应元数据），浏览器自动续期。
 */
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { b64u, randomBytes, randomToken, readJson, safeEqual, writeJsonAtomic } from './util.mjs'
import { generateRelayIdentity, normalizePsk } from './crypto.mjs'

const ROTATE_HOURS = 12
const GRACE_MINUTES = 60

export class KeyRing {
  constructor({ statePath, logger, rotateHours = ROTATE_HOURS, graceMinutes = GRACE_MINUTES, relayRotateHours = 24 }) {
    this.statePath = statePath
    this.logger = logger
    this.rotateHours = rotateHours
    this.graceMinutes = graceMinutes
    this.relayRotateHours = relayRotateHours
    this.state = this.#load()
    this.stateMtimeMs = this.#stateMtime()
  }

  #stateMtime() {
    try {
      return statSync(this.statePath).mtimeMs
    } catch {
      return 0
    }
  }

  /** 外部（CLI rotate）改动后重新装载，避免长驻进程覆盖。 */
  reload() {
    const mtime = this.#stateMtime()
    if (mtime === this.stateMtimeMs) return false
    this.state = this.#load()
    this.stateMtimeMs = mtime
    return true
  }

  #load() {
    const raw = readJson(this.statePath, null)
    if (raw && Array.isArray(raw.psks) && Array.isArray(raw.identities) && raw.identities.length > 0) {
      return raw
    }
    const identity = generateRelayIdentity()
    const state = { version: 1, identities: [identity], psks: [], legacy: [], createdAt: Date.now() }
    const psk = this.#mintPsk(Date.now())
    state.psks.push(psk)
    writeJsonAtomic(this.statePath, state)
    return state
  }

  #mintPsk(now) {
    return {
      kid: randomBytes(6).toString('hex'),
      psk: randomToken(32),
      createdAt: now,
      expiresAt: now + this.rotateHours * 3_600_000,
      graceUntil: null,
      retiredAt: null,
    }
  }

  save() {
    writeJsonAtomic(this.statePath, this.state)
    this.stateMtimeMs = this.#stateMtime()
  }

  get identity() {
    return this.state.identities[this.state.identities.length - 1]
  }

  identityById(kid) {
    return this.state.identities.find((item) => item.kid === kid) ?? null
  }

  /** 已停用但仍可用于握手（旧会话续期）的身份，保留一份。 */
  identitiesForHandshake() {
    return this.state.identities.slice(-2)
  }

  rotateRelayIdentityIfDue(now = Date.now()) {
    const current = this.identity
    if (now - current.createdAt < this.relayRotateHours * 3_600_000) return false
    const next = generateRelayIdentity()
    this.state.identities = [...this.state.identities.slice(-1), next]
    this.save()
    this.logger?.info?.('relay identity rotated', { kid: next.kid })
    return true
  }

  activePsk() {
    const now = Date.now()
    return this.state.psks.find((item) => !item.retiredAt && item.expiresAt > now) ?? null
  }

  /** 需要主动续期（剩余寿命不足 1/4）时返回 true。 */
  rotationDue(now = Date.now()) {
    const active = this.activePsk()
    if (!active) return true
    const lifetime = active.expiresAt - active.createdAt
    return now > active.expiresAt - lifetime / 4
  }

  rotatePsk(now = Date.now(), { force = false } = {}) {
    const active = this.activePsk()
    if (active && !force && !this.rotationDue(now)) return active
    if (active) {
      active.retiredAt = now
      active.graceUntil = now + this.graceMinutes * 60_000
    }
    const next = this.#mintPsk(now)
    this.state.psks.push(next)
    // 只保留 active + grace 内的条目
    this.state.psks = this.state.psks.filter((item) => !item.graceUntil || item.graceUntil > now)
    this.save()
    this.logger?.info?.('psk rotated', {
      kid: next.kid,
      retired: active?.kid ?? null,
      graceUntil: active?.graceUntil ? new Date(active.graceUntil).toISOString() : null,
    })
    return next
  }

  /** 供绑定校验：active + grace 内的所有 PSK。 */
  candidates(now = Date.now()) {
    return this.state.psks.filter((item) => !item.retiredAt || (item.graceUntil ?? 0) > now)
  }

  findPskByValue(value) {
    const normalized = normalizePsk(value)
    for (const item of this.state.psks) {
      if (safeEqual(normalized, normalizePsk(item.psk))) return item
    }
    return null
  }

  /** App 直连令牌：长期复用，避免每次打开弹窗都轮换导致已连接设备失效。 */
  appToken(now = Date.now(), ttlDays = 30) {
    const existing = this.state.legacy.find((item) => item.kind === 'app' && item.expiresAt > now)
    if (existing) return existing.token
    const token = randomToken(32)
    this.state.legacy = this.state.legacy.filter((item) => item.expiresAt > now)
    this.state.legacy.push({ kind: 'app', token, createdAt: now, expiresAt: now + ttlDays * 86_400_000 })
    this.save()
    return token
  }

  /** 轮换 App 直连令牌（旧令牌立即失效，已连接客户端需要重新扫码）。 */
  rotateAppToken(now = Date.now(), ttlDays = 30) {
    this.state.legacy = this.state.legacy.filter((item) => item.kind !== 'app')
    const token = randomToken(32)
    this.state.legacy.push({ kind: 'app', token, createdAt: now, expiresAt: now + ttlDays * 86_400_000 })
    this.save()
    return token
  }

  verifyAppToken(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length === 0) return false
    return this.state.legacy.some(
      (item) => item.kind === 'app' && item.expiresAt > now && safeEqual(Buffer.from(item.token), Buffer.from(token)),
    )
  }

  issueLegacyToken(now = Date.now(), ttlHours = 24) {
    const token = randomToken(32)
    this.state.legacy.push({ token, createdAt: now, expiresAt: now + ttlHours * 3_600_000 })
    this.state.legacy = this.state.legacy.filter((item) => item.expiresAt > now)
    this.save()
    return token
  }

  verifyLegacyToken(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length === 0) return false
    return this.state.legacy.some((item) => item.expiresAt > now && safeEqual(Buffer.from(item.token), Buffer.from(token)))
  }

  /** 对外链接：密钥放在 fragment，浏览器不会把它发给 Cloudflare。 */
  link(publicUrl) {
    const base = String(publicUrl ?? '').replace(/\/+$/, '')
    const active = this.activePsk()
    return active ? `${base}/#k=${active.psk}` : `${base}/`
  }

  legacyLink(publicUrl) {
    const base = String(publicUrl ?? '').replace(/\/+$/, '')
    const token = this.issueLegacyToken()
    return `${base}/?token=${token}`
  }

  /** 给 Android 客户端扫码用的明文握手链接（`?token=`）。 */
  appLink(publicUrl) {
    const base = String(publicUrl ?? '').replace(/\/+$/, '')
    return `${base}/?token=${this.appToken()}`
  }

  describe() {
    const active = this.activePsk()
    return {
      path: this.statePath,
      relayKid: this.identity.kid,
      pskKid: active?.kid ?? null,
      pskExpiresAt: active ? new Date(active.expiresAt).toISOString() : null,
      psks: this.state.psks.map((item) => ({
        kid: item.kid,
        createdAt: new Date(item.createdAt).toISOString(),
        expiresAt: new Date(item.expiresAt).toISOString(),
        graceUntil: item.graceUntil ? new Date(item.graceUntil).toISOString() : null,
      })),
      legacyTokens: this.state.legacy.length,
    }
  }
}

export function keyRingPath(stateDir) {
  return join(stateDir, 'keyring.json')
}

export function pskFingerprint(psk) {
  return b64u(Buffer.from(psk)).slice(0, 8)
}