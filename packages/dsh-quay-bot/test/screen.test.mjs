/**
 * Unit & integration tests for per-Bot virtual screen bridge, human takeover
 * suspension (`screenHelps`), and BotApi screen routes/commands.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BotStore } from '../host/store.js'
import { Approvals } from '../host/approvals.js'
import { ScreenBridge } from '../host/screen.js'
import { BotApi } from '../host/api.js'

const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])

// Mock BotScreen Gateway
function startMockGateway() {
  const stateByBot = new Map()
  const requests = []
  let locked423 = false
  let systemConfig = {
    enabled: true,
    disk_paths: ['/'],
    stream_interval_sec: 2.0,
    push_url: '',
    push_interval_sec: 0,
    has_push_token: false,
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    requests.push({ method: req.method, path: url.pathname, body: bodyText })

    const send = (status, data, headers = {}) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
      res.end(JSON.stringify(data))
    }

    if (url.pathname === '/healthz') {
      return send(200, {
        ok: true,
        api_version: 4,
        capabilities: ['ensure', 'tile_stream', 'xtest_input', 'ratio_coords', 'human_pause', 'system_info', 'host_system'],
        bots: stateByBot.size,
      })
    }
    if (url.pathname === '/api/screens') {
      return send(200, { screens: [...stateByBot.values()], host: { available_mb: 8192 } })
    }
    if (
      url.pathname === '/api/system'
      || url.pathname === '/api/system/info'
      || url.pathname === '/api/host'
      || url.pathname === '/api/host/info'
      || url.pathname === '/api/host/system'
      || url.pathname === '/api/sysinfo'
      || url.pathname === '/api/node/info'
    ) {
      const qDisk = url.searchParams.get('disk_path')
      const paths = qDisk ? qDisk.split(',').filter(Boolean) : systemConfig.disk_paths
      return send(200, {
        ok: true,
        source: 'gateway',
        hostname: 'mock-host',
        os: 'Linux',
        arch: 'x86_64',
        cgroup: false,
        available_mb: 8192,
        limit_mb: 16384,
        min_free_mb: 1024,
        blocker: null,
        cpu: { usage_percent: 23.4, cores: 4, load_avg: { '1m': 0.5, '5m': 0.4, '15m': 0.3 } },
        memory: { total_mb: 16384, used_mb: 8192, available_mb: 8192, usage_percent: 50.0 },
        disk: {
          path: paths[0] || '/',
          total_gb: 200,
          used_gb: 80,
          free_gb: 120,
          usage_percent: 40.0,
          mounts: paths.map(p => ({ path: p, total_gb: 200, used_gb: 80, free_gb: 120, usage_percent: 40.0, ok: true })),
        },
        uptime: { seconds: 90061, days: 1, hours: 1, minutes: 1, secs: 1, formatted: '1天 1小时 1分', formatted_en: '1d 1h 1m' },
        config: systemConfig,
      })
    }
    if (url.pathname === '/api/system/config' && req.method === 'GET') {
      return send(200, { ok: true, config: systemConfig })
    }
    if (url.pathname === '/api/system/config' && (req.method === 'PUT' || req.method === 'POST')) {
      const patch = bodyText ? JSON.parse(bodyText) : {}
      if (Array.isArray(patch.disk_paths)) systemConfig.disk_paths = patch.disk_paths
      if (typeof patch.push_url === 'string') systemConfig.push_url = patch.push_url
      if (patch.push_interval_sec !== undefined) systemConfig.push_interval_sec = Number(patch.push_interval_sec)
      if (patch.stream_interval_sec !== undefined) systemConfig.stream_interval_sec = Number(patch.stream_interval_sec)
      if (typeof patch.push_token === 'string') systemConfig.has_push_token = patch.push_token.length > 0
      return send(200, { ok: true, config: systemConfig })
    }
    if (url.pathname === '/api/system/push' && req.method === 'POST') {
      const body = bodyText ? JSON.parse(bodyText) : {}
      return send(200, { ok: true, url: body.url || systemConfig.push_url, status_code: 200, latency_ms: 4.2 })
    }
    if (url.pathname === '/api/system/stream' && req.method === 'GET') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ type: 'system', source: 'gateway', cpu: { usage_percent: 19.5, cores: 4 }, uptime: { seconds: 90062, formatted: '1天 1小时 1分' } })}\n\n`)
      res.end()
      return
    }

    const ensureMatch = /^\/api\/screens\/([^/]+)\/ensure$/.exec(url.pathname)
    if (ensureMatch && req.method === 'POST') {
      const botId = decodeURIComponent(ensureMatch[1])
      if (!stateByBot.has(botId)) {
        stateByBot.set(botId, {
          bot_id: botId,
          display: ':105',
          ws_port: 6105,
          state: 'STOPPED',
          healthy: false,
          epoch: 1,
          memory_bytes: 0,
        })
      }
      return send(200, { ...stateByBot.get(botId), agent_token: `tok_${botId}` })
    }

    const actionMatch = /^\/api\/screens\/([^/]+)\/(start|stop|freeze|thaw|takeover|release|brake|human_input)$/.exec(url.pathname)
    if (actionMatch && req.method === 'POST') {
      const botId = decodeURIComponent(actionMatch[1])
      const act = actionMatch[2]
      const cur = stateByBot.get(botId) || { bot_id: botId, display: ':105', ws_port: 6105, epoch: 1, memory_bytes: 1024 * 1024 * 24 }
      if (act === 'start' || act === 'thaw') {
        cur.healthy = true
        cur.state = 'AGENT_ACTIVE'
      } else if (act === 'stop') {
        cur.healthy = false
        cur.state = 'STOPPED'
      } else if (act === 'freeze') {
        cur.state = 'FROZEN'
      } else if (act === 'takeover') {
        cur.healthy = true
        cur.state = 'HUMAN_TAKEOVER'
        locked423 = true
      } else if (act === 'release') {
        cur.state = 'AGENT_ACTIVE'
        cur.epoch += 1
        locked423 = false
      } else if (act === 'brake') {
        cur.state = 'FROZEN'
      }
      stateByBot.set(botId, cur)
      if (act === 'takeover') {
        return send(200, { bot_id: botId, state: cur.state, token: 'htok_1', stream_url: `/vnc/${botId}/vnc.html` })
      }
      return send(200, cur)
    }

    const previewMatch = /^\/api\/screens\/([^/]+)\/preview$/.exec(url.pathname)
    if (previewMatch) {
      const etag = '"mock-preview-etag-1"'
      res.setHeader('etag', etag)
      res.setHeader('x-screen-width', '1280')
      res.setHeader('x-screen-height', '720')
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'image/jpeg')
      res.end(tinyJpeg)
      return
    }

    const streamMatch = /^\/api\/screens\/([^/]+)\/stream$/.exec(url.pathname)
    if (streamMatch) {
      const botId = decodeURIComponent(streamMatch[1])
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ type: 'meta', bot_id: botId, w: 1280, h: 720, state: 'HUMAN_TAKEOVER' })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'frame', seq: 1, full: true, w: 1280, h: 720, mime: 'image/jpeg', tiles: [{ x: 0, y: 0, w: 64, h: 64, d: tinyJpeg.toString('base64') }] })}\n\n`)
      res.end()
      return
    }

    const helpMatch = /^\/api\/agent\/([^/]+)\/request_help$/.exec(url.pathname)
    if (helpMatch && req.method === 'POST') {
      const botId = decodeURIComponent(helpMatch[1])
      const cur = stateByBot.get(botId) || { bot_id: botId }
      cur.state = 'NEED_HUMAN'
      cur.healthy = true
      stateByBot.set(botId, cur)
      return send(200, { ok: true, state: 'NEED_HUMAN' })
    }

    const clickMatch = /^\/api\/agent\/([^/]+)\/click$/.exec(url.pathname)
    if (clickMatch && req.method === 'POST') {
      if (locked423) {
        return send(423, { detail: 'Human in control', state: 'HUMAN_TAKEOVER', hint: '等待人类交还' })
      }
      return send(200, { ok: true, state: 'AGENT_ACTIVE', epoch: 2 })
    }

    const shotMatch = /^\/api\/agent\/([^/]+)\/screenshot$/.exec(url.pathname)
    if (shotMatch) {
      res.statusCode = 200
      res.setHeader('content-type', 'image/jpeg')
      res.setHeader('x-screen-width', '1280')
      res.setHeader('x-screen-height', '720')
      res.setHeader('x-screen-state', 'AGENT_ACTIVE')
      res.setHeader('x-lease-epoch', '2')
      res.end(tinyJpeg)
      return
    }

    const delMatch = /^\/api\/screens\/([^/]+)$/.exec(url.pathname)
    if (delMatch && req.method === 'DELETE') {
      const botId = decodeURIComponent(delMatch[1])
      stateByBot.delete(botId)
      return send(200, { deleted: botId })
    }

    send(404, { detail: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        setLocked: (v) => { locked423 = v },
        close: () => new Promise(r => server.close(r)),
      })
    })
  })
}

// Auto-spawn tests use a mock gateway; do not let them alter the host system.
const prevAutoInstallDeps = process.env.BOTSCREEN_AUTO_INSTALL_DEPS
process.env.BOTSCREEN_AUTO_INSTALL_DEPS = '0'

const dir = await mkdtemp(join(tmpdir(), 'botmode-screen-test-'))
const gw = await startMockGateway()

try {
  const store = new BotStore(dir)
  await store.load()
  const bot = { id: 'bot_a1b2c3d4e5', name: '自动化助手', role: 'Ops' }
  await store.mutate((s) => { s.bots.push(bot) })

  const approvals = new Approvals(store, console)
  const screen = new ScreenBridge({ approvals, logger: console, gatewayUrl: gw.url })

  // 1. Dynamic ensure + start
  const started = await screen.start(bot.id)
  assert.equal(started.bot_id, bot.id)
  assert.equal(started.state, 'AGENT_ACTIVE')

  // 2. requestHelp suspends until decideScreenHelp, then releases & returns fresh screenshot
  const helpPromise = screen.requestHelp(bot, { category: 'captcha', reason: '请输入图形验证码' })
  await new Promise(r => setTimeout(r, 30))
  const helps = approvals.listScreenHelps()
  assert.equal(helps.length, 1)
  assert.equal(helps[0].category, 'captcha')
  assert.ok(helps[0].previewDataUrl.startsWith('data:image/jpeg;base64,'))

  await approvals.decideScreenHelp(helps[0].id, 'release', '已过验证码')
  const helpResult = await helpPromise
  assert.equal(helpResult.ok, true)
  assert.equal(helpResult.released, true)
  assert.equal(helpResult.note, '已过验证码')
  assert.ok(Buffer.isBuffer(helpResult.screenshot?.buffer))

  // 3. 423 Locked auto-suspends and retries once human releases
  gw.setLocked(true)
  const clickPromise = screen.click(bot, { x: 100, y: 200 })
  await new Promise(r => setTimeout(r, 30))
  const lockedHelps = approvals.listScreenHelps()
  assert.equal(lockedHelps.length, 1)
  assert.equal(lockedHelps[0].category, 'human_takeover')
  gw.setLocked(false)
  await approvals.decideScreenHelp(lockedHelps[0].id, 'release', '交还')
  const clickResult = await clickPromise
  assert.equal(clickResult.ok, true)

  // 4. BotApi commands & publicState
  const api = new BotApi({
    ctx: { get: () => undefined },
    store,
    dispatcher: { status: () => ({ busy: {}, last: {} }), inRoom: () => false },
    rooms: { state: () => ({}) },
    routines: {},
    approvals,
    screen,
    logger: console,
  })
  const takeRes = await api.command({ type: 'screen.takeover', botId: bot.id })
  assert.equal(takeRes.state, 'HUMAN_TAKEOVER')
  assert.ok(takeRes.gateway_stream_url.startsWith(gw.url))

  // 4b. Fast HTTP screen/input & preview pointer headers via BotApi.handle
  const reqCountBefore = gw.requests.length
  const apiWithAuth = new BotApi({
    ctx: { get: (k) => (k === 'connection' ? { requestRejection: () => undefined } : undefined) },
    store,
    dispatcher: { status: () => ({ busy: {}, last: {} }), inRoom: () => false },
    rooms: { state: () => ({}) },
    routines: {},
    approvals,
    screen,
    logger: console,
  })
  const runApiReq = async ({ method = 'GET', url, headers = {}, body = '' }) => {
    const req = (async function* () { if (body) yield Buffer.from(body) })()
    req.method = method
    req.url = url
    req.headers = headers
    const outHeaders = {}
    const chunks = []
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader: (k, v) => { outHeaders[String(k).toLowerCase()] = String(v) },
      write: (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''))) },
      end: (chunk) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || '')))
        res.writableEnded = true
      },
    }
    await apiWithAuth.handle(req, res)
    return { status: res.statusCode, headers: outHeaders, body: Buffer.concat(chunks) }
  }
  for (const input of [
    { kind: 'mousedown', rx: 0.25, ry: 0.5, button: 1 },
    { kind: 'move_batch', normalized: true, points: [[0.3, 0.55], [0.4, 0.6]] },
    { kind: 'mouseup', rx: 0.4, ry: 0.6, button: 1 },
  ]) {
    const r = await runApiReq({
      method: 'POST',
      url: '/botmode/api/screen/input',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: bot.id, input }),
    })
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(r.body.toString('utf8')).ok, true)
  }
  const inputReqs = gw.requests.slice(reqCountBefore)
  assert.deepEqual(
    inputReqs.map(r => r.path),
    [
      `/api/screens/${bot.id}/human_input`,
      `/api/screens/${bot.id}/human_input`,
      `/api/screens/${bot.id}/human_input`,
    ],
  )
  assert.deepEqual(
    inputReqs.map(r => JSON.parse(r.body).kind),
    ['mousedown', 'move_batch', 'mouseup'],
  )
  assert.equal(JSON.parse(inputReqs[0].body).rx, 0.25)
  assert.equal(JSON.parse(inputReqs[1].body).normalized, true)

  const prevResp = await runApiReq({
    method: 'GET',
    url: `/botmode/api/screen/preview?botId=${encodeURIComponent(bot.id)}&cached=1&onlyCached=1`,
  })
  assert.equal(prevResp.status, 200)
  assert.equal(prevResp.headers['x-screen-width'], '1280')
  assert.equal(prevResp.headers['x-screen-height'], '720')
  assert.equal(prevResp.headers.etag, '"mock-preview-etag-1"')

  const prev304Resp = await runApiReq({
    method: 'GET',
    url: `/botmode/api/screen/preview?botId=${encodeURIComponent(bot.id)}&cached=1`,
    headers: { 'if-none-match': prevResp.headers.etag },
  })
  assert.equal(prev304Resp.status, 304)
  assert.equal(prev304Resp.headers.etag, '"mock-preview-etag-1"')
  assert.equal(prev304Resp.body.length, 0)

  const streamResp = await runApiReq({
    method: 'GET',
    url: `/botmode/api/screen/stream?botId=${encodeURIComponent(bot.id)}&fmt=jpeg`,
  })
  assert.equal(streamResp.status, 200)
  assert.ok(streamResp.headers['content-type'].includes('text/event-stream'))
  assert.ok(streamResp.body.toString('utf8').includes('"type":"frame"'))

  // 4c. System info (disk, memory, CPU, uptime) via gateway & configuration interface
  const sysInfoResp = await runApiReq({ method: 'GET', url: '/botmode/api/system' })
  assert.equal(sysInfoResp.status, 200)
  const sysInfoJson = JSON.parse(sysInfoResp.body.toString('utf8'))
  assert.equal(sysInfoJson.ok, true)
  assert.equal(sysInfoJson.system.available, true)
  assert.equal(sysInfoJson.system.source, 'gateway')
  assert.equal(sysInfoJson.system.cpu.usage_percent, 23.4)
  assert.equal(sysInfoJson.cpu.usage_percent, 23.4)
  assert.equal(sysInfoJson.hostname, 'mock-host')
  assert.equal(sysInfoJson.cgroup, false)
  assert.equal(sysInfoJson.system.memory.usage_percent, 50.0)
  assert.equal(sysInfoJson.system.disk.usage_percent, 40.0)
  assert.equal(sysInfoJson.system.uptime.formatted, '1天 1小时 1分')
  assert.equal(sysInfoJson.config.endpoints.hostInfo, '/botmode/api/system')
  assert.equal(sysInfoJson.config.endpoints.hostAlias, '/botmode/api/host/system')
  assert.equal(sysInfoJson.config.endpoints.gatewayInfo, `${gw.url}/api/system`)
  assert.equal(sysInfoJson.config.endpoints.gatewayAlias, `${gw.url}/api/host/system`)

  // All host/system alias routes must return 200 (never 404)
  for (const aliasPath of ['/botmode/api/system/info', '/botmode/api/host', '/botmode/api/host/info', '/botmode/api/host/system', '/botmode/api/sysinfo', '/botmode/api/node/info']) {
    const aliasResp = await runApiReq({ method: 'GET', url: aliasPath })
    assert.equal(aliasResp.status, 200, `${aliasPath} should return 200`)
    const aliasJson = JSON.parse(aliasResp.body.toString('utf8'))
    assert.equal(aliasJson.ok, true)
    assert.equal(aliasJson.hostname, 'mock-host')
    assert.equal(aliasJson.cpu.usage_percent, 23.4)
  }
  const hostStreamResp = await runApiReq({ method: 'GET', url: '/botmode/api/host/stream?interval=2' })
  assert.equal(hostStreamResp.status, 200)
  assert.ok(hostStreamResp.headers['content-type'].includes('text/event-stream'))
  assert.ok(hostStreamResp.body.toString('utf8').includes('"type":"system"'))

  const sysCfgPut = await runApiReq({
    method: 'PUT',
    url: '/botmode/api/system/config',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      diskPaths: ['/', '/data'],
      refreshIntervalSec: 3,
      pushUrl: 'http://127.0.0.1:9999/metrics',
      pushIntervalSec: 30,
      pushToken: 'secret-tok',
    }),
  })
  assert.equal(sysCfgPut.status, 200)
  const sysCfgJson = JSON.parse(sysCfgPut.body.toString('utf8'))
  assert.equal(sysCfgJson.ok, true)
  assert.equal(sysCfgJson.gatewaySynced, true)
  assert.deepEqual(sysCfgJson.config.diskPaths, ['/', '/data'])
  assert.equal(sysCfgJson.config.refreshIntervalSec, 3)
  assert.equal(sysCfgJson.config.pushUrl, 'http://127.0.0.1:9999/metrics')
  assert.equal(sysCfgJson.config.pushIntervalSec, 30)
  assert.equal(sysCfgJson.gatewayConfig.has_push_token, true)

  const sysCfgGet = await runApiReq({ method: 'GET', url: '/botmode/api/system/config' })
  assert.equal(sysCfgGet.status, 200)
  assert.deepEqual(JSON.parse(sysCfgGet.body.toString('utf8')).config.diskPaths, ['/', '/data'])

  const sysPushResp = await runApiReq({
    method: 'POST',
    url: '/botmode/api/system/push',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(sysPushResp.status, 200)
  assert.equal(JSON.parse(sysPushResp.body.toString('utf8')).result.url, 'http://127.0.0.1:9999/metrics')

  const sysStreamResp = await runApiReq({ method: 'GET', url: '/botmode/api/system/stream?interval=2' })
  assert.equal(sysStreamResp.status, 200)
  assert.ok(sysStreamResp.headers['content-type'].includes('text/event-stream'))
  assert.ok(sysStreamResp.body.toString('utf8').includes('"type":"system"'))

  // Verify BotStore persisted settings.system across reload
  const reloadedStore = new BotStore(dir)
  await reloadedStore.load()
  assert.deepEqual(reloadedStore.state.settings.system.diskPaths, ['/', '/data'])
  assert.equal(reloadedStore.state.settings.system.pushUrl, 'http://127.0.0.1:9999/metrics')
  assert.equal(reloadedStore.state.settings.system.pushIntervalSec, 30)

  // Verify command interface: system.info & system.config.save validation
  const cmdInfo = await api.command({ type: 'system.info', diskPath: '/var' })
  assert.equal(cmdInfo.system.disk.path, '/var')
  await assert.rejects(
    () => api.command({ type: 'system.config.save', config: { pushUrl: 'ftp://bad.example' } }),
    /http:\/\/ or https:\/\//,
  )

  const relRes = await api.command({ type: 'screen.release', botId: bot.id })
  assert.equal(relRes.state, 'AGENT_ACTIVE')

  // 5. Cleanup on purge
  const purged = await screen.purge(bot.id)
  assert.equal(purged.deleted, bot.id)

  // 6. Auto-spawn local BotScreen gateway on demand
  const freePort = await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
  const autoRoot = join(dir, 'auto-botscreen')
  await mkdir(join(autoRoot, 'botscreen'), { recursive: true })
  await writeFile(join(autoRoot, 'botscreen', '__main__.py'), '# placeholder\n')
  const pidFile = join(autoRoot, 'mock.pid')
  const mockPy = join(autoRoot, 'mock-python')
  await writeFile(
    mockPy,
    `#!/usr/bin/env node
const http = require('node:http')
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const port = Number(process.env.BOTSCREEN_PORT)
  const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true, api_version: 4, capabilities: ['ensure', 'tile_stream', 'system_info', 'host_system'], bots: 0 }))
  if (req.url === '/api/screens') return res.end(JSON.stringify({ screens: [], host: { available_mb: 4096, limit_mb: 8192, min_free_mb: 1024, blocker: null, hostname: 'auto-host', cpu: { usage_percent: 12.3, cores: 4 }, memory: { usage_percent: 50.0, total_mb: 8192, used_mb: 4096, available_mb: 4096 }, disk: { path: '/', usage_percent: 30.0, total_gb: 100, used_gb: 30, free_gb: 70 } } }))
  if (req.url.startsWith('/api/system') || req.url.startsWith('/api/host')) return res.end(JSON.stringify({ ok: true, source: 'gateway', hostname: 'auto-host', cpu: { usage_percent: 12.3, cores: 4 }, memory: { usage_percent: 50.0, total_mb: 8192, used_mb: 4096, available_mb: 4096 }, disk: { path: '/', usage_percent: 30.0, total_gb: 100, used_gb: 30, free_gb: 70 }, uptime: { seconds: 100, formatted: '1分 40秒' } }))
  if (req.url.includes('/ensure')) return res.end(JSON.stringify({ bot_id: 'bot_auto', state: 'STOPPED', healthy: false, agent_token: 'tok_auto', epoch: 0 }))
  res.statusCode = 404
  res.end(JSON.stringify({ detail: 'not found' }))
})
server.listen(port, '127.0.0.1')
`,
  )
  await chmod(mockPy, 0o755)
  const autoScreen = new ScreenBridge({
    approvals,
    logger: console,
    gatewayUrl: `http://127.0.0.1:${freePort}`,
    autoSpawn: true,
    botscreenRoot: autoRoot,
    pythonBin: mockPy,
    logDir: autoRoot,
  })
  assert.equal(autoScreen.canAutoStart(), true)
  try {
    const ensured = await autoScreen.ensure('bot_auto')
    assert.equal(ensured.bot_id, 'bot_auto')
    const listed = await autoScreen.listScreens()
    assert.equal(listed.available, true)
    assert.equal(listed.autoStartable, true)
  } finally {
    try {
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      if (pid > 0) process.kill(pid, 'SIGTERM')
    } catch (_e) { /* ignore */ }
  }

  // 7. Auto-replace outdated local gateway (v3 without system_info -> 404 on /api/system)
  const upgradePort = await new Promise((resolvePort, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolvePort(p))
    })
  })
  const staleScript = join(autoRoot, 'stale-botscreen.js')
  await writeFile(
    staleScript,
    `const http = require('node:http')
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true, api_version: 3, capabilities: ['ensure', 'tile_stream'], cgroup: false, bots: 1 }))
  if (req.url === '/api/screens') return res.end(JSON.stringify({ screens: [], host: { available_mb: 7049, limit_mb: 7964, min_free_mb: 1024, blocker: null } }))
  res.statusCode = 404
  res.end(JSON.stringify({ detail: 'Not Found' }))
})
server.listen(${upgradePort}, '127.0.0.1')
`,
  )
  const staleChild = spawn(process.execPath, [staleScript, 'botscreen'], { stdio: 'ignore', detached: true })
  staleChild.unref()
  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${upgradePort}/healthz`)
      if (r.ok) break
    } catch (_e) { /* wait */ }
    await new Promise(r => setTimeout(r, 100))
  }
  const upgradeScreen = new ScreenBridge({
    approvals,
    logger: console,
    gatewayUrl: `http://127.0.0.1:${upgradePort}`,
    autoSpawn: true,
    botscreenRoot: autoRoot,
    pythonBin: mockPy,
    logDir: autoRoot,
  })
  try {
    const healthBefore = await upgradeScreen.health()
    assert.equal(healthBefore.available, false)
    assert.equal(healthBefore.outdated, true)
    // Calling getSystemInfo directly must auto-upgrade the stale v3 gateway and succeed
    const upgradedSys = await upgradeScreen.getSystemInfo()
    assert.equal(upgradedSys.available, true)
    assert.equal(upgradedSys.hostname, 'auto-host')
    const healthAfter = await upgradeScreen.health()
    assert.equal(healthAfter.available, true)
  } finally {
    try { staleChild.kill('SIGTERM') } catch (_e) { /* already replaced */ }
    try {
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      if (pid > 0) process.kill(pid, 'SIGTERM')
    } catch (_e) { /* ignore */ }
  }

  // 8. Local gateway fallback vs remote gateway strict failure
  const deadLocalPort = await new Promise((resolvePort, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolvePort(p))
    })
  })
  const fallbackScreen = new ScreenBridge({
    approvals,
    logger: console,
    gatewayUrl: `http://127.0.0.1:${deadLocalPort}`,
    autoSpawn: false,
  })
  const fallbackApi = new BotApi({
    ctx: { get: (k) => (k === 'connection' ? { requestRejection: () => undefined } : undefined) },
    store,
    dispatcher: { status: () => ({ busy: {}, last: {} }), inRoom: () => false },
    rooms: { state: () => ({}) },
    routines: {},
    approvals,
    screen: fallbackScreen,
    logger: console,
  })
  const fallbackInfo = await fallbackApi.getSystemInfo()
  assert.equal(fallbackInfo.system.available, true)
  assert.equal(fallbackInfo.system.degraded, true)
  assert.equal(fallbackInfo.system.source, 'host-fallback')
  assert.equal(fallbackInfo.system.gatewayAvailable, false)
  assert.ok(fallbackInfo.system.cpu && Number.isFinite(fallbackInfo.system.cpu.usage_percent))
  assert.ok(fallbackInfo.system.memory && fallbackInfo.system.memory.total_mb > 0)
  assert.ok(fallbackInfo.system.disk && fallbackInfo.system.disk.total_gb > 0)

  // Remote gateway must NOT fabricate local host metrics on failure
  const remoteScreen = new ScreenBridge({
    approvals,
    logger: console,
    gatewayUrl: 'http://192.0.2.1:6200',
    autoSpawn: false,
  })
  const remoteApi = new BotApi({
    ctx: { get: () => undefined },
    store,
    dispatcher: { status: () => ({ busy: {}, last: {} }), inRoom: () => false },
    rooms: { state: () => ({}) },
    routines: {},
    approvals,
    screen: remoteScreen,
    logger: console,
  })
  const remoteInfo = await remoteApi.getSystemInfo({ timeoutMs: 200 })
  assert.equal(remoteInfo.system.available, false)
  assert.notEqual(remoteInfo.system.source, 'host-fallback')

  console.log('✓ screen.test.mjs all assertions passed')

  // Python bootstrap must seed pip from the vendored wheel even when the host
  // Python has neither pip nor ensurepip, and must not spawn bin/pip directly.
  const bootstrapRoot = await mkdtemp(join(tmpdir(), 'botmode-bootstrap-test-'))
  await mkdir(join(bootstrapRoot, 'vendor', 'pip'), { recursive: true })
  await writeFile(join(bootstrapRoot, 'vendor', 'pip', 'pip-25.1.1-py3-none-any.whl'), '')
  await writeFile(join(bootstrapRoot, 'vendor', 'pip', 'setuptools-78.1.1-py3-none-any.whl'), '')
  await mkdir(join(bootstrapRoot, 'botscreen'), { recursive: true })
  await writeFile(join(bootstrapRoot, 'botscreen', '__main__.py'), '')
  await writeFile(join(bootstrapRoot, 'botscreen', 'requirements.txt'), 'fastapi\n')
  const fakeVenv = join(bootstrapRoot, 'screen-venv')
  await mkdir(join(fakeVenv, 'bin'), { recursive: true })
  const fakePython = join(fakeVenv, 'bin', 'python')
  const bootstrapLog = join(bootstrapRoot, 'bootstrap.log')
  await writeFile(fakePython, `#!/bin/sh
printf '%s\n' "$*" >> "${bootstrapLog}"
case "$*" in
  *"import fastapi, uvicorn"*) exit 1 ;;
  *"sys.prefix != sys.base_prefix"*) exit 0 ;;
  *"-m pip install --no-index"*) touch "${bootstrapRoot}/pip-ready"; exit 0 ;;
  *"-m pip --version"*) if [ -f "${bootstrapRoot}/pip-ready" ]; then exit 0; fi; exit 1 ;;
  *"-m ensurepip"*) exit 1 ;;
  *"-m pip install -q -r"*) exit 0 ;;
esac
exit 0
`, { mode: 0o755 })
  const bootstrapScreen = new ScreenBridge({
    approvals,
    logger: console,
    gatewayUrl: 'http://127.0.0.1:35209',
    autoSpawn: true,
    botscreenRoot: bootstrapRoot,
    logDir: bootstrapRoot,
  })
  try {
    await bootstrapScreen.ensure('bot_bootstrap')
  } catch (_e) {
    // The mock gateway is intentionally absent; bootstrap runs before spawn.
  }
  const calls = await readFile(bootstrapLog, 'utf8')
  assert.match(calls, /-m ensurepip --upgrade/)
  assert.match(calls, /-m pip install --no-index/)
  assert.doesNotMatch(calls, /bin\/pip/)
  await rm(bootstrapRoot, { recursive: true, force: true })
} finally {
  await gw.close()
  await rm(dir, { recursive: true, force: true })
  if (prevAutoInstallDeps === undefined) delete process.env.BOTSCREEN_AUTO_INSTALL_DEPS
  else process.env.BOTSCREEN_AUTO_INSTALL_DEPS = prevAutoInstallDeps
}
