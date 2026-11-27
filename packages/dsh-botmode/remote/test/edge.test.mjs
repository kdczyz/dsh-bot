import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { join } from 'node:path'
import { DEFAULTS } from '../src/config.mjs'
import { KeyRing, keyRingPath } from '../src/keys.mjs'
import { SessionStore } from '../src/sessions.mjs'
import { Upstream } from '../src/upstream.mjs'
import { createEdge } from '../src/proxy.mjs'
import { FRAME_CONTROL, FRAME_DATA, FrameDecoder, openFrame, sealFrame } from '../src/crypto.mjs'
import { connectWebSocket } from '../src/ws.mjs'
import { b64u, unb64u } from '../src/util.mjs'
import { E2EClient, startFakeUpstream, tempHome } from './helpers.mjs'

const noopLogger = { info() {}, warn() {}, error() {} }

let fake
let home
let keys
let sessions
let upstream
let edge
let base
let psk

before(async () => {
  fake = await startFakeUpstream()
  home = tempHome()
  const config = {
    ...structuredClone(DEFAULTS),
    home: home.dir,
    stateDir: join(home.dir, 'state'),
    logs: { ...DEFAULTS.logs, dir: join(home.dir, 'logs') },
    listen: { host: '127.0.0.1', port: 0 },
    public: { ...DEFAULTS.public, mode: 'none' },
    proxy: { ...DEFAULTS.proxy, appBridge: true },
    upstream: {
      ...DEFAULTS.upstream,
      mode: 'fixed',
      port: fake.port,
      launchToken: fake.token,
      discoverIntervalMs: 60_000,
    },
  }
  keys = new KeyRing({ statePath: keyRingPath(config.stateDir), logger: noopLogger })
  sessions = new SessionStore({ logger: noopLogger })
  upstream = new Upstream({ config, logger: noopLogger })
  await upstream.start()
  await upstream.waitReady({ timeoutMs: 5000 })
  edge = createEdge({ config, keys, sessions, upstream, logger: noopLogger })
  const address = await edge.listen()
  base = `http://127.0.0.1:${String(address.port)}`
  psk = keys.activePsk().psk
})

after(async () => {
  await edge.close()
  sessions.close()
  upstream.stop()
  await fake.close()
  home.cleanup()
})

test('health 端点公开可用', async () => {
  const response = await fetch(`${base}/__dsh/health`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.e2e, true)
  assert.equal(body.upstream, true)
})

test('未认证访问返回 401 解锁页并引用 shim', async () => {
  const response = await fetch(`${base}/`, { headers: { accept: 'text/html' } })
  assert.equal(response.status, 401)
  const html = await response.text()
  assert.equal(html.includes('/__dsh/shim.js'), true)
  assert.equal(html.includes('#k='), true)
})

test('API 未认证请求返回 JSON 401', async () => {
  const response = await fetch(`${base}/api/echo`, { headers: { accept: 'application/json' } })
  assert.equal(response.status, 401)
  const body = await response.json()
  assert.equal(body.error, 'unauthorized')
})

test('错误 PSK 无法绑定', async () => {
  const client = new E2EClient({ base, psk: b64u(Buffer.alloc(32, 1)) })
  await assert.rejects(client.bind(), (error) => error.status === 401)
})

test('握手挑战一次性消费，重放绑定失败', async () => {
  const challengeResponse = await fetch(`${base}/__dsh/handshake`)
  const challenge = await challengeResponse.json()
  assert.equal(challenge.v, 1)
  const replay = await fetch(`${base}/__dsh/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ v: 1, kid: challenge.kid, cpk: 'AAAA', nonce: challenge.nonce, proof: 'AAAA' }),
  })
  assert.equal(replay.status, 401)
  const second = await fetch(`${base}/__dsh/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ v: 1, kid: challenge.kid, cpk: 'AAAA', nonce: challenge.nonce, proof: 'AAAA' }),
  })
  assert.equal(second.status, 401)
})

test('加密 GET：路径、方法、cookie 注入与 header 清洗均正确', async () => {
  const client = new E2EClient({ base, psk })
  await client.bind()
  const result = await client.request({ method: 'GET', path: '/api/echo?x=1', headers: { 'x-test': 'a' } })
  assert.equal(result.status, 200)
  const payload = JSON.parse(result.body.toString('utf8'))
  assert.equal(payload.method, 'GET')
  assert.equal(payload.url, '/api/echo?x=1')
  assert.match(payload.cookie, /^dsh-auth-test=ok-\d+$/u)
  assert.equal(payload.origin.startsWith('http://127.0.0.1:'), true)
  assert.equal(result.headers['x-fake-host'].startsWith('127.0.0.1:'), true)
  assert.equal(result.headers['set-cookie'], undefined)
})

test('加密 POST：请求体送达并保持 content-type', async () => {
  const client = new E2EClient({ base, psk })
  await client.bind()
  const body = JSON.stringify({ hello: '世界' })
  const result = await client.request({
    method: 'POST',
    path: '/api/echo',
    headers: { 'content-type': 'application/json' },
    body,
  })
  assert.equal(result.status, 200)
  const payload = JSON.parse(result.body.toString('utf8'))
  assert.equal(payload.body, body)
})

test('加密 SSE：分块响应完整解密', async () => {
  const client = new E2EClient({ base, psk })
  await client.bind()
  const result = await client.request({ method: 'GET', path: '/sse' })
  assert.equal(result.status, 200)
  assert.equal(result.headers['content-type'], 'text/event-stream')
  const text = result.body.toString('utf8')
  assert.equal(text.includes('data: one'), true)
  assert.equal(text.includes('data: two'), true)
  assert.equal(text.includes('data: three'), true)
})

test('帧重放被拒绝', async () => {
  const client = new E2EClient({ base, psk })
  await client.bind()
  const frame = client.frame(FRAME_DATA, Buffer.from(JSON.stringify(client.envelope({ path: '/api/echo' }))))
  const first = await client.post(frame)
  assert.equal(first.status, 200)
  await client.readResponse(first)
  const second = await client.post(frame)
  assert.equal(second.status, 400)
  const body = await second.json()
  assert.equal(body.error, 'no_data_frame')
})

test('会话 cookie 可访问静态页且注入 shim', async () => {
  const client = new E2EClient({ base, psk })
  await client.bind()
  const response = await fetch(`${base}/`, { headers: { cookie: client.cookie, accept: 'text/html' } })
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.equal(html.includes('fake dsh'), true)
  assert.equal(html.includes('/__dsh/shim.js'), true)
  assert.equal(html.indexOf('/__dsh/shim.js') < html.indexOf('<body>'), true)
})

test('静态资源未认证返回 401（不泄露上游页面）', async () => {
  const response = await fetch(`${base}/`, { headers: { accept: 'text/html' } })
  assert.equal(response.status, 401)
  const html = await response.text()
  assert.equal(html.includes('fake dsh'), false)
})

test('加密 WebSocket 桥：握手、目标路径、双向帧', async () => {
  const client = new E2EClient({ base, psk })
  await client.bind()
  const wsUrl = `${base.replace('http://', 'ws://')}/__dsh/ws`
  const socket = await connectWebSocket(wsUrl, {
    headers: { cookie: client.cookie, origin: base },
  })
  const received = []
  socket.on('message', (payload, isText) => {
    if (isText) return
    const frames = decoder.push(payload)
    for (const frame of frames) {
      const opened = openFrame({
        key: client.keys.s2c,
        sid: unb64u(client.sid),
        frame,
        aadExtra: Buffer.from('s2c'),
      })
      received.push(opened)
    }
  })
  const decoder = new FrameDecoder()

  const init = client.wsMessage(FRAME_CONTROL, Buffer.from(JSON.stringify({ t: 'init', p: '/ws' })))
  socket.sendBinary(init)
  await new Promise((resolve) => setTimeout(resolve, 150))

  const payload = Buffer.concat([Buffer.from([0x1]), Buffer.from('ping')])
  socket.sendBinary(client.wsMessage(FRAME_DATA, payload))
  await new Promise((resolve) => setTimeout(resolve, 250))

  const dataFrames = received.filter((item) => item.type === FRAME_DATA)
  assert.equal(dataFrames.length >= 1, true)
  const echo = dataFrames[0].plaintext
  assert.equal(echo[0], 0x1)
  assert.equal(echo.subarray(1).toString('utf8'), 'echo:ping')
  socket.close(1000, 'done')
})

test('PSK 轮换后旧会话收到 renew 元数据', async () => {
  const client = new E2EClient({ base, psk })
  await client.bind()
  const first = await client.request({ path: '/api/echo' })
  assert.equal(first.status, 200)
  const session = sessions.get(client.sid)
  assert.ok(session)
  const next = keys.rotatePsk(Date.now(), { force: true })
  sessions.setRenewal(session, next)
  const second = await client.request({ path: '/api/echo' })
  assert.equal(second.status, 200)
  assert.ok(second.meta.renew)
  assert.equal(second.meta.renew.kid, next.kid)
  assert.equal(second.meta.renew.psk, next.psk)
})

test('legacy 明文通道默认关闭', async () => {
  const token = keys.issueLegacyToken()
  const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  assert.equal(response.status, 401)
})

test('跨站 Origin 被拒绝', async () => {
  const client = new E2EClient({ base, psk })
  await client.bind()
  const frame = client.frame(FRAME_DATA, Buffer.from(JSON.stringify(client.envelope({ path: '/api/echo' }))))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(frame.length)
  const response = await fetch(`${base}/__dsh/e2e`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      origin: 'https://evil.example',
      cookie: client.cookie,
    },
    body: Buffer.concat([length, frame]),
  })
  assert.equal(response.status, 403)
})

test('上游 401 触发 cookie 自动重取', async () => {
  const before = upstream.info.bootstraps
  await upstream.onUnauthorized()
  assert.equal(upstream.info.bootstraps > before, true)
  const client = new E2EClient({ base, psk })
  await client.bind()
  const result = await client.request({ path: '/api/echo' })
  assert.equal(result.status, 200)
})

test('App 直连通道：?token= 兑换 dsh-auth cookie 并拿到索引页', async () => {
  const token = keys.appToken()
  const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  assert.equal(response.status, 303)
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.equal(setCookie.startsWith('dsh-auth-relay='), true)
  const cookie = setCookie.split(';')[0]
  const index = await fetch(`${base}/`, { headers: { cookie, accept: 'text/html' } })
  assert.equal(index.status, 200)
  const html = await index.text()
  assert.equal(html.includes('fake dsh'), true)
  assert.equal(html.includes('/__dsh/shim.js'), false, 'plain/appBridge HTML must not inject E2E shim.js')
})

test('App 直连通道：cookie 可升级 /api/remote.mux 并收发帧', async () => {
  const token = keys.appToken()
  const exchange = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0]
  const socket = await connectWebSocket(`${base.replace('http://', 'ws://')}/api/remote.mux`, {
    headers: { cookie, origin: base },
  })
  const messages = []
  socket.on('message', (payload, isText) => messages.push({ text: payload.toString('utf8'), isText }))
  socket.sendText('hello-app')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(messages.length >= 1, true)
  assert.equal(messages[0].text, 'echo:hello-app')
  socket.close(1000, 'done')
})

test('加密链接的 PSK 被当成 token 时给出明确原因', async () => {
  const response = await fetch(`${base}/?token=${keys.activePsk().psk}`, { redirect: 'manual' })
  assert.equal(response.status, 401)
  const body = await response.json()
  assert.equal(body.error, 'e2e_link_requires_browser')
})

test('App 直连 token 无效时 401', async () => {
  const response = await fetch(`${base}/?token=not-a-token`, { redirect: 'manual' })
  assert.equal(response.status, 401)
  const body = await response.json()
  assert.equal(body.error, 'bad_token')
})
