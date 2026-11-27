import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { KeyRing, keyRingPath } from '../src/keys.mjs'
import { tempHome } from './helpers.mjs'

const noopLogger = { info() {}, warn() {}, error() {} }

function makeRing(home, overrides = {}) {
  return new KeyRing({ statePath: keyRingPath(join(home, 'state')), logger: noopLogger, ...overrides })
}

test('初始密钥环：有 active PSK，链接把密钥放在 fragment', () => {
  const home = tempHome()
  try {
    const ring = makeRing(home.dir)
    const active = ring.activePsk()
    assert.ok(active)
    assert.equal(active.psk.length >= 40, true)
    const link = ring.link('https://demo.trycloudflare.com/')
    assert.equal(link.startsWith('https://demo.trycloudflare.com/#k='), true)
    assert.equal(link.includes(active.psk), true)
    assert.equal(link.includes('?'), false)
    assert.ok(ring.identity.kid)
    assert.ok(ring.identity.spki)
  } finally {
    home.cleanup()
  }
})

test('PSK 轮换：旧密钥进入宽限窗口，仍可验证但不再是 active', () => {
  const home = tempHome()
  try {
    const ring = makeRing(home.dir, { graceMinutes: 30 })
    const first = ring.activePsk()
    const next = ring.rotatePsk(Date.now(), { force: true })
    assert.notEqual(next.kid, first.kid)
    assert.equal(ring.activePsk().kid, next.kid)
    const candidates = ring.candidates()
    assert.equal(candidates.some((item) => item.kid === first.kid), true)
    assert.equal(candidates.some((item) => item.kid === next.kid), true)
    assert.equal(ring.findPskByValue(first.psk).kid, first.kid)
  } finally {
    home.cleanup()
  }
})

test('轮换到期判定：25% 剩余寿命触发', () => {
  const home = tempHome()
  try {
    const ring = makeRing(home.dir, { rotateHours: 1 })
    const active = ring.activePsk()
    const lifetime = active.expiresAt - active.createdAt
    active.createdAt = Date.now() - lifetime * 0.8
    active.expiresAt = Date.now() + lifetime * 0.2
    assert.equal(ring.rotationDue(), true)
    active.expiresAt = Date.now() + lifetime * 0.9
    assert.equal(ring.rotationDue(), false)
  } finally {
    home.cleanup()
  }
})

test('reload：外部 CLI 轮换后长驻实例能装载新状态', async () => {
  const home = tempHome()
  try {
    const persistent = makeRing(home.dir)
    const before = persistent.activePsk().kid
    const cli = makeRing(home.dir)
    const rotated = cli.rotatePsk(Date.now(), { force: true })
    assert.equal(persistent.activePsk().kid, before)
    const changed = persistent.reload()
    assert.equal(changed, true)
    assert.equal(persistent.activePsk().kid, rotated.kid)
  } finally {
    home.cleanup()
  }
})

test('legacy token：签发、校验与过期', () => {
  const home = tempHome()
  try {
    const ring = makeRing(home.dir)
    const token = ring.issueLegacyToken()
    assert.equal(ring.verifyLegacyToken(token), true)
    assert.equal(ring.verifyLegacyToken('nope'), false)
    ring.state.legacy[0].expiresAt = Date.now() - 1
    assert.equal(ring.verifyLegacyToken(token), false)
  } finally {
    home.cleanup()
  }
})

test('relay 身份轮换保留上一代用于兼容', () => {
  const home = tempHome()
  try {
    const ring = makeRing(home.dir, { relayRotateHours: 1 })
    const first = ring.identity.kid
    const rotated = ring.rotateRelayIdentityIfDue(Date.now() + 3_600_000)
    assert.equal(rotated, true)
    assert.notEqual(ring.identity.kid, first)
    assert.equal(ring.identitiesForHandshake().length, 2)
  } finally {
    home.cleanup()
  }
})