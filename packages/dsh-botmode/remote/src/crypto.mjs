/**
 * 端到端加密原语。
 *
 * 选型：ECDH P-256（WebCrypto 全平台可用）+ HKDF-SHA256 + AES-256-GCM。
 * 每个会话派生两把单向密钥（c2s / s2c），序号即 GCM nonce（12 字节 = 4 个 0 + 8 字节大端序号），
 * 密钥 + 单调序号保证 nonce 永不复用；AAD 绑定协议版本、帧类型与 sid，防止跨会话重放。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { b64u, sha256, unb64u } from './util.mjs'

export const PROTO_VERSION = 1
export const FRAME_VERSION = 1
export const FRAME_DATA = 1
export const FRAME_CONTROL = 2
export const FRAME_CLOSE = 3
export const KEY_LEN = 32
export const SID_LEN = 16
export const HEADER_LEN = 6
export const MAX_SEQ = 0xffffffff

const BIND_CONTEXT = 'dsh-remote/v1/bind'
const KEY_INFO_PREFIX = 'dsh-remote/v1/keys'

/** 生成长期（relay 身份）ECDH 密钥对，JWK 可直接落盘。 */
export function generateRelayIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pub = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const kid = sha256(spki).toString('hex').slice(0, 16)
  return { kid, publicJwk: pub, privateJwk: priv, spki: b64u(spki), createdAt: Date.now() }
}

export function importPublicDer(derB64) {
  return createPublicKey({ key: unb64u(derB64), format: 'der', type: 'spki' })
}

export function publicDerFromJwk(jwk) {
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  return b64u(key.export({ format: 'der', type: 'spki' }))
}

/** 客户端公钥 DER(base64url) → 共享密钥（P-256，32 字节）。 */
export function sharedSecret(privateJwk, clientPubDerB64) {
  const privateKey = createPrivateKey({ key: privateJwk, format: 'jwk' })
  const publicKey = importPublicDer(clientPubDerB64)
  return diffieHellman({ privateKey, publicKey })
}

export function deriveKeys({ secret, salt, kid, spk, cpk, sessionId }) {
  const info = Buffer.concat([
    Buffer.from(KEY_INFO_PREFIX),
    Buffer.from([0]),
    Buffer.from(kid, 'utf8'),
    Buffer.from(unb64u(spk)),
    Buffer.from(unb64u(cpk)),
    Buffer.from(sessionId),
  ])
  const okm = Buffer.from(hkdfSync('sha256', secret, salt, info, KEY_LEN * 2))
  return { c2s: okm.subarray(0, KEY_LEN), s2c: okm.subarray(KEY_LEN, KEY_LEN * 2) }
}

/** 客户端用 PSK 证明自己：HMAC(psk, "bind"|kid|spk|cpk|nonce)。 */
export function bindProof(psk, { kid, spk, cpk, nonce }) {
  return createHmac('sha256', normalizePsk(psk))
    .update(BIND_CONTEXT)
    .update('\0')
    .update(kid)
    .update('\0')
    .update(spk)
    .update('\0')
    .update(cpk)
    .update('\0')
    .update(unb64u(nonce))
    .digest()
}

export function verifyBindProof(psk, fields) {
  const expected = bindProof(psk, fields)
  const given = fields.proof
  if (!Buffer.isBuffer(given) || given.length !== expected.length) return false
  return timingSafeEqual(expected, given)
}

export function normalizePsk(psk) {
  if (Buffer.isBuffer(psk)) return psk
  if (typeof psk === 'string') return unb64u(psk)
  throw new TypeError('PSK 必须是 Buffer 或 base64url 字符串')
}

export function newSessionId() {
  return randomBytes(SID_LEN)
}

function nonceFor(seq) {
  const nonce = Buffer.alloc(12)
  nonce.writeUInt32BE(0, 0)
  nonce.writeUInt32BE(Math.floor(seq / 0x100000000) >>> 0, 4)
  nonce.writeUInt32BE(seq >>> 0, 8)
  return nonce
}

export function sealFrame({ key, sid, seq, type = FRAME_DATA, plaintext, aadExtra = null }) {
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) throw new RangeError(`非法序号 ${seq}`)
  const header = Buffer.alloc(HEADER_LEN)
  header[0] = FRAME_VERSION
  header[1] = type
  header.writeUInt32BE(seq, 2)
  const aad = aadExtra ? Buffer.concat([header, sid, aadExtra]) : Buffer.concat([header, sid])
  const cipher = createCipheriv('aes-256-gcm', key, nonceFor(seq), { authTagLength: 16 })
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([header, body, cipher.getAuthTag()])
}

export function openFrame({ key, sid, frame, aadExtra = null }) {
  if (!Buffer.isBuffer(frame) || frame.length < HEADER_LEN + 16) throw new Error('帧长度非法')
  if (frame[0] !== FRAME_VERSION) throw new Error(`帧版本不支持: ${frame[0]}`)
  const type = frame[1]
  const seq = frame.readUInt32BE(2)
  const header = frame.subarray(0, HEADER_LEN)
  const aad = aadExtra ? Buffer.concat([header, sid, aadExtra]) : Buffer.concat([header, sid])
  const tag = frame.subarray(frame.length - 16)
  const body = frame.subarray(HEADER_LEN, frame.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(seq), { authTagLength: 16 })
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()])
  return { seq, type, plaintext }
}

/** 长度前缀（u32 BE）分帧，便于流式传输与浏览器端增量解析。 */
export function encodeLengthPrefixed(frame) {
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(frame.length, 0)
  return Buffer.concat([prefix, frame])
}

export class FrameDecoder {
  constructor({ maxFrameBytes = 262_144 } = {}) {
    this.buffer = Buffer.alloc(0)
    this.maxFrameBytes = maxFrameBytes
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    const frames = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length > this.maxFrameBytes) throw new Error(`帧过大: ${length}`)
      if (this.buffer.length < 4 + length) break
      frames.push(this.buffer.subarray(4, 4 + length))
      this.buffer = this.buffer.subarray(4 + length)
    }
    return frames
  }
}

/**
 * 序号重放窗口：允许乱序（HTTP 并发），拒绝重复与过旧帧。
 */
export class ReplayWindow {
  constructor(size = 1024) {
    this.size = size
    this.top = -1
    this.bits = new Uint8Array(size)
  }

  /** 返回 true 表示可以接受，并同时登记。 */
  accept(seq) {
    if (!Number.isInteger(seq) || seq < 0) return false
    if (this.top < 0) {
      this.top = seq
      this.bits.fill(0)
      this.bits[0] = 1
      return true
    }
    if (seq > this.top) {
      const shift = seq - this.top
      if (shift >= this.size) {
        this.bits.fill(0)
      } else {
        this.bits.copyWithin(shift, 0, this.size - shift)
        this.bits.fill(0, 0, shift)
      }
      this.top = seq
      this.bits[0] = 1
      return true
    }
    const index = this.top - seq
    if (index >= this.size) return false
    if (this.bits[index] === 1) return false
    this.bits[index] = 1
    return true
  }

  /** 仅检查不登记（解密失败时不要污染窗口）。 */
  allows(seq) {
    if (!Number.isInteger(seq) || seq < 0) return false
    if (this.top < 0 || seq > this.top) return true
    const index = this.top - seq
    if (index >= this.size) return false
    return this.bits[index] === 0
  }
}

export function keyIdForJwk(jwk) {
  return sha256(Buffer.from(`${jwk.x ?? ''}.${jwk.y ?? ''}`)).toString('hex').slice(0, 16)
}