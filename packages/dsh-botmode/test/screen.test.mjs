/**
 * Unit & integration tests for per-Bot virtual screen bridge, human takeover
 * suspension (`screenHelps`), and BotApi screen routes/commands.
 */
import assert from 'node:assert/strict'
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

    if (url.pathname === '/healthz') return send(200, { ok: true, bots: stateByBot.size })
    if (url.pathname === '/api/screens') {
      return send(200, { screens: [...stateByBot.values()], host: { available_mb: 8192 } })
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
      res.statusCode = 200
      res.setHeader('content-type', 'image/jpeg')
      res.end(tinyJpeg)
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
  if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true, bots: 0 }))
  if (req.url === '/api/screens') return res.end(JSON.stringify({ screens: [], host: { available_mb: 4096 } }))
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
