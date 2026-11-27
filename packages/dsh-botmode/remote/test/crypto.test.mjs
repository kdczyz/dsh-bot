import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac, diffieHellman } from 'node:crypto'
import {
  FRAME_CONTROL,
  FRAME_DATA,
  FrameDecoder,
  ReplayWindow,
  bindProof,
  deriveKeys,
  encodeLengthPrefixed,
  generateRelayIdentity,
  importPublicDer,
  openFrame,
  sealFrame,
  sharedSecret,
  verifyBindProof,
} from '../src/crypto.mjs'
import { b64u, unb64u } from '../src/util.mjs'
import { clientKeyPair } from './helpers.mjs'

test('ECDH 双方共享密钥一致，派生密钥一致', () => {
  const identity = generateRelayIdentity()
  const client = clientKeyPair()
  const serverSecret = sharedSecret(identity.privateJwk, client.spki)
  const clientSecret = diffieHellman({
    privateKey: client.privateKey,
    publicKey: importPublicDer(identity.spki),
  })
  assert.deepEqual(serverSecret, clientSecret)

  const sid = Buffer.from('0123456789abcdef')
  const salt = Buffer.alloc(16, 7)
  const serverKeys = deriveKeys({ secret: serverSecret, salt, kid: identity.kid, spk: identity.spki, cpk: client.spki, sessionId: sid })
  const clientKeys = deriveKeys({ secret: clientSecret, salt, kid: identity.kid, spk: identity.spki, cpk: client.spki, sessionId: sid })
  assert.deepEqual(serverKeys.c2s, clientKeys.c2s)
  assert.deepEqual(serverKeys.s2c, clientKeys.s2c)
  assert.notDeepEqual(serverKeys.c2s, serverKeys.s2c)
  assert.equal(serverKeys.c2s.length, 32)
})

test('绑定证明：错误 PSK/字段不通过', () => {
  const identity = generateRelayIdentity()
  const client = clientKeyPair()
  const fields = {
    kid: identity.kid,
    spk: identity.spki,
    cpk: client.spki,
    nonce: b64u(Buffer.alloc(16, 3)),
  }
  const psk = Buffer.alloc(32, 9)
  const proof = bindProof(psk, fields)
  assert.equal(verifyBindProof(psk, { ...fields, proof }), true)
  assert.equal(verifyBindProof(Buffer.alloc(32, 8), { ...fields, proof }), false)
  assert.equal(verifyBindProof(psk, { ...fields, nonce: b64u(Buffer.alloc(16, 4)), proof }), false)
  assert.equal(verifyBindProof(psk, { ...fields, proof: Buffer.alloc(32) }), false)
})

test('帧封解：双向、AAD 绑定、篡改检测', () => {
  const key = Buffer.alloc(32, 1)
  const other = Buffer.alloc(32, 2)
  const sid = Buffer.from('abcdefghijklmnop')
  const plaintext = Buffer.from('hello 世界'.repeat(10))
  const frame = sealFrame({ key, sid, seq: 7, type: FRAME_DATA, plaintext, aadExtra: Buffer.from('c2s') })
  const opened = openFrame({ key, sid, frame, aadExtra: Buffer.from('c2s') })
  assert.equal(opened.seq, 7)
  assert.equal(opened.type, FRAME_DATA)
  assert.deepEqual(opened.plaintext, plaintext)

  assert.throws(() => openFrame({ key: other, sid, frame, aadExtra: Buffer.from('c2s') }))
  assert.throws(() => openFrame({ key, sid, frame, aadExtra: Buffer.from('s2c') }))
  assert.throws(() => openFrame({ key, sid: Buffer.from('ponmlkjihgfedcba'), frame, aadExtra: Buffer.from('c2s') }))

  const tampered = Buffer.from(frame)
  tampered[10] ^= 0xff
  assert.throws(() => openFrame({ key, sid, frame: tampered, aadExtra: Buffer.from('c2s') }))
})

test('nonce 随序号变化，同明文不同密文', () => {
  const key = Buffer.alloc(32, 5)
  const sid = Buffer.alloc(16, 1)
  const plaintext = Buffer.from('same')
  const a = sealFrame({ key, sid, seq: 1, type: FRAME_CONTROL, plaintext })
  const b = sealFrame({ key, sid, seq: 2, type: FRAME_CONTROL, plaintext })
  assert.notDeepEqual(a.subarray(6), b.subarray(6))
})

test('流式解码：分片写入也能还原帧', () => {
  const frame1 = sealFrame({ key: Buffer.alloc(32, 1), sid: Buffer.alloc(16), seq: 0, type: FRAME_DATA, plaintext: Buffer.from('a') })
  const frame2 = sealFrame({ key: Buffer.alloc(32, 1), sid: Buffer.alloc(16), seq: 1, type: FRAME_DATA, plaintext: Buffer.from('b') })
  const stream = encodeLengthPrefixed(frame1).subarray(0, 9)
  const rest = Buffer.concat([encodeLengthPrefixed(frame1).subarray(9), encodeLengthPrefixed(frame2)])
  const decoder = new FrameDecoder()
  assert.deepEqual(decoder.push(stream), [])
  const out = decoder.push(rest)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], frame1)
  assert.deepEqual(out[1], frame2)
})

test('重放窗口：乱序接受、重复拒绝、越界拒绝', () => {
  const window = new ReplayWindow(8)
  assert.equal(window.accept(0), true)
  assert.equal(window.accept(0), false)
  assert.equal(window.accept(3), true)
  assert.equal(window.accept(2), true)
  assert.equal(window.accept(2), false)
  assert.equal(window.accept(1), true)
  assert.equal(window.accept(20), true)
  assert.equal(window.accept(1), false)
  assert.equal(window.accept(5), false)
  assert.equal(window.accept(19), true)
  assert.equal(window.accept(12), false)
  assert.equal(window.allows(20), false)
  assert.equal(window.allows(21), true)
})

test('FrameDecoder 拒绝超大帧', () => {
  const decoder = new FrameDecoder({ maxFrameBytes: 1024 })
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(4096)
  assert.throws(() => decoder.push(prefix))
})

test('错配 PSK 的 HMAC 与合法值不同', () => {
  const identity = generateRelayIdentity()
  const client = clientKeyPair()
  const fields = { kid: identity.kid, spk: identity.spki, cpk: client.spki, nonce: b64u(Buffer.alloc(16)) }
  const left = createHmac('sha256', Buffer.alloc(32, 1)).update(JSON.stringify(fields)).digest()
  const right = bindProof(Buffer.alloc(32, 1), fields)
  assert.notDeepEqual(left, right)
  assert.equal(unb64u(b64u(right)).length, 32)
})