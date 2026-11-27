import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteGateway, inspectLink, parseGatewayLink } from '../host/remote.js'

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'botmode-remote-'))
  mkdirSync(join(dir, 'state'), { recursive: true })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const LINK = 'https://unit-test-tunnel.trycloudflare.com/#k=ZhSqpB9V1fn9dUh4ZISA7c8IG-Oa4NfT7FniUB-VHYw'
const noopLogger = { info() {}, warn() {}, error() {} }

test('parseGatewayLink：fragment 密钥、query token 与非法输入', () => {
  const fragment = parseGatewayLink(LINK)
  assert.equal(fragment.origin, 'https://unit-test-tunnel.trycloudflare.com')
  assert.equal(fragment.key, 'ZhSqpB9V1fn9dUh4ZISA7c8IG-Oa4NfT7FniUB-VHYw')
  assert.equal(fragment.token, null)

  const query = parseGatewayLink('https://gw.example.com:8443/?token=abc123')
  assert.equal(query.origin, 'https://gw.example.com:8443')
  assert.equal(query.token, 'abc123')
  assert.equal(query.key, null)

  assert.equal(parseGatewayLink('not a url'), null)
  assert.equal(parseGatewayLink('ftp://x'), null)
  assert.equal(parseGatewayLink(''), null)
})

test('inspectLink：网关 / SSH / 缺凭证', () => {
  assert.deepEqual(
    { valid: inspectLink(LINK).valid, kind: inspectLink(LINK).kind, hasKey: inspectLink(LINK).hasKey },
    { valid: true, kind: 'gateway', hasKey: true },
  )
  assert.equal(inspectLink('ssh://me@10.0.0.5:22').kind, 'ssh')
  assert.equal(inspectLink('me@host.example:2222').kind, 'ssh')
  const bare = inspectLink('https://gw.example.com/#nothing')
  assert.equal(bare.valid, false)
  assert.equal(bare.reason, 'missing-credential')
  assert.equal(inspectLink('').reason, 'empty')
})

test('status：未启动时读不到 runtime，也不会崩', async () => {
  const home = tempHome()
  try {
    const gateway = new RemoteGateway({ home: home.dir, bin: '/nonexistent/dsh-remote.mjs', logger: noopLogger })
    const state = await gateway.status()
    assert.equal(state.running, false)
    assert.equal(state.healthy, false)
    assert.equal(state.link, null)
  } finally {
    home.cleanup()
  }
})

test('status：读取运行态、链接、token 与二维码', async () => {
  const home = tempHome()
  try {
    writeFileSync(join(home.dir, 'state', 'runtime.json'), JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      listen: { host: '127.0.0.1', port: 49123 },
      publicUrl: 'https://unit-test-tunnel.trycloudflare.com',
      link: LINK,
      pskKid: 'kid-123',
      tunnel: { mode: 'quick', state: 'running', url: 'https://unit-test-tunnel.trycloudflare.com', restarts: 0 },
    }))
    writeFileSync(join(home.dir, 'link.txt'), `${LINK}\n`)
    const gateway = new RemoteGateway({ home: home.dir, bin: '/nonexistent/dsh-remote.mjs', logger: noopLogger })
    const state = await gateway.status()
    assert.equal(state.running, true)
    assert.equal(state.healthy, false) // 没有真实 relay 在监听
    assert.equal(state.link, LINK)
    assert.equal(state.token, 'ZhSqpB9V1fn9dUh4ZISA7c8IG-Oa4NfT7FniUB-VHYw')
    assert.equal(state.keyKind, 'psk')
    assert.equal(state.pskKid, 'kid-123')
    assert.equal(state.tunnel.mode, 'quick')
    assert.equal(state.qrDataUrl.startsWith('data:image/svg+xml;base64,'), true)
    assert.equal(state.svg.startsWith('<svg'), true)
  } finally {
    home.cleanup()
  }
})

test('CLI 缺失时 up 立刻报错而不是挂住', async () => {
  const home = tempHome()
  try {
    const gateway = new RemoteGateway({
      home: home.dir,
      bin: join(home.dir, 'missing-cli.mjs'),
      logger: noopLogger,
    })
    await assert.rejects(gateway.up(), /失败/)
  } finally {
    home.cleanup()
  }
})

test('inspectLink 方法可直接给客户端调用', () => {
  const gateway = new RemoteGateway({ home: '/tmp', bin: '/nonexistent', logger: noopLogger })
  const result = gateway.inspectLink(LINK)
  assert.equal(result.valid, true)
  assert.equal(result.kind, 'gateway')
})

test('默认内置 dsh-remote CLI 开箱即用，且 recordUpstreamHintFromRequest 跳过 relay cookie', async () => {
  const { existsSync, readFileSync } = await import('node:fs')
  const home = tempHome()
  try {
    const gateway = new RemoteGateway({ home: home.dir, logger: noopLogger, useSystemd: false })
    assert.equal(gateway.bin.endsWith(join('remote', 'bin', 'dsh-remote.mjs')), true)
    assert.equal(existsSync(gateway.bin), true)

    // 只有 dsh-auth-relay 时应跳过（避免自循环）
    const skipped = await gateway.recordUpstreamHintFromRequest({
      socket: { localAddress: '::ffff:10.0.0.140', localPort: 3080 },
      headers: { cookie: 'dsh-auth-relay=self-loop-token' },
    })
    assert.equal(skipped, false)

    // 真实 dsh-auth-* cookie 应写入 upstream-hint.json
    const saved = await gateway.recordUpstreamHintFromRequest({
      socket: { localAddress: '::ffff:10.0.0.140', localPort: 3080 },
      headers: { cookie: 'dsh-auth-relay=ignored; dsh-auth-real=abc123' },
    })
    assert.equal(saved, true)
    const hint = JSON.parse(readFileSync(join(home.dir, 'state', 'upstream-hint.json'), 'utf8'))
    assert.equal(hint.host, '10.0.0.140')
    assert.equal(hint.port, 3080)
    assert.equal(hint.cookie, 'dsh-auth-real=abc123')
  } finally {
    home.cleanup()
  }
})