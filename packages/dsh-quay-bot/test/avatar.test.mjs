/**
 * Unit & integration tests for custom/random Bot Avatars (Image-bot module),
 * `public-bot` 12-field schema compatibility, DSH Host `/botmode/api/avatar*`
 * transport endpoints, and BotScreen gateway avatar sync.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BotStore } from '../host/store.js'
import { BotApi } from '../host/api.js'
import { ScreenBridge } from '../host/screen.js'
import {
  avatarBundleScript,
  avatarCatalog,
  deterministicAvatar,
  normalizeAvatar,
  randomAvatar,
  validateCustomAvatarJson,
} from '../host/avatar.js'

const AVATAR_KEYS = [
  'avatarId',
  'customJson',
  'color',
  'eyeColor',
  'material',
  'clay',
  'yaw',
  'pitch',
  'orbit',
  'badge',
  'depth',
  'followPointer',
]

const VALID_CUSTOM_JSON = JSON.stringify({
  version: 1,
  id: 'my-bot',
  name: 'My Bot',
  body: { path: 'M20 20L80 20L80 80L20 80Z' },
  eyes: { x: 50, y: 48, spacing: 18, scale: 1.1 },
})

function assertAvatarShape(avatar) {
  assert.ok(avatar && typeof avatar === 'object', 'avatar must be an object')
  for (const key of AVATAR_KEYS) {
    assert.ok(key in avatar, `avatar missing field: ${key}`)
  }
  assert.equal(typeof avatar.avatarId, 'string')
  assert.equal(typeof avatar.customJson, 'string')
  assert.match(avatar.color, /^#[0-9a-f]{6}$/)
  assert.match(avatar.eyeColor, /^#[0-9a-f]{6}$/)
  assert.ok(avatar.material === 'flat' || avatar.material === 'fluffy')
  assert.equal(typeof avatar.clay, 'boolean')
  assert.equal(typeof avatar.yaw, 'number')
  assert.equal(typeof avatar.pitch, 'number')
  assert.equal(typeof avatar.orbit, 'boolean')
  assert.equal(typeof avatar.badge, 'boolean')
  assert.equal(typeof avatar.depth, 'number')
  assert.equal(typeof avatar.followPointer, 'boolean')
}

function startAvatarMockGateway() {
  const avatarsByBot = new Map()
  const requests = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    requests.push({ method: req.method, path: url.pathname, body: bodyText })

    const send = (status, data) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(data))
    }

    if (url.pathname === '/healthz') {
      return send(200, { ok: true, api_version: 3, capabilities: ['ensure', 'tile_stream', 'bot_avatar'] })
    }
    if (url.pathname === '/api/screens') {
      return send(200, { screens: [], host: { available_mb: 4096 } })
    }
    if (url.pathname === '/api/avatars' && req.method === 'GET') {
      return send(200, { ok: true, avatars: Object.fromEntries(avatarsByBot.entries()) })
    }
    const avMatch = /^\/api\/screens\/([^/]+)\/avatar$/.exec(url.pathname)
    if (avMatch) {
      const botId = decodeURIComponent(avMatch[1])
      if (req.method === 'GET') {
        return send(200, { ok: true, bot_id: botId, avatar: avatarsByBot.get(botId) ?? null })
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const parsed = JSON.parse(bodyText)
        avatarsByBot.set(botId, parsed)
        return send(200, { ok: true, bot_id: botId, avatar: parsed })
      }
      if (req.method === 'DELETE') {
        const existed = avatarsByBot.delete(botId)
        return send(200, { ok: true, bot_id: botId, deleted: existed })
      }
    }
    send(404, { detail: 'not found' })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        avatarsByBot,
        requests,
        close: () => new Promise(r => server.close(() => r())),
      })
    })
  })
}

async function runApiReq(api, { method = 'GET', url, headers = {}, body = '' }) {
  const chunks = []
  const outHeaders = {}
  const req = {
    method,
    url,
    headers,
    on() {},
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.isBuffer(body) ? body : Buffer.from(body)
    },
  }
  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader(k, v) { outHeaders[String(k).toLowerCase()] = String(v) },
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''))) },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || '')))
      res.writableEnded = true
    },
  }
  await api.handle(req, res)
  return { status: res.statusCode, headers: outHeaders, body: Buffer.concat(chunks) }
}

const waitUntil = async (fn, timeoutMs = 1500) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return false
}

// --- 1. Embedded Image-bot catalog & validation unit tests ---
{
  const catalog = avatarCatalog()
  assert.equal(catalog.version, 1)
  assert.equal(catalog.items.length, 19, 'must match public-bot 19-avatar catalog')
  assert.equal(catalog.palettes.length, 12, 'must expose 12 clay palettes')
  const ids = catalog.items.map(i => i.id)
  for (const expected of ['mochi', 'neko', 'grok-pod', 'ghost', 'shape-circle', 'shape-star', 'shape-blob']) {
    assert.ok(ids.includes(expected), `catalog should include ${expected}`)
  }

  const bundle = avatarBundleScript()
  assert.ok(bundle.length > 10_000, 'browser avatar bundle should be non-trivial')
  assert.ok(bundle.includes('__DSH_AVATAR_ENGINE__'), 'bundle should expose window.__DSH_AVATAR_ENGINE__')
  assert.ok(bundle.includes('grok-bot'), 'bundle should register <grok-bot>')

  // Custom JSON validator
  assert.equal(validateCustomAvatarJson('').ok, true)
  assert.equal(validateCustomAvatarJson(VALID_CUSTOM_JSON).ok, true)
  assert.equal(validateCustomAvatarJson('{bad json').ok, false)
  assert.equal(validateCustomAvatarJson(JSON.stringify({ version: 2 })).ok, false)
  assert.equal(validateCustomAvatarJson(JSON.stringify({
    version: 1,
    body: { path: '<script>alert(1)</script>' },
    eyes: { x: 50, y: 50, spacing: 18, scale: 1 },
  })).ok, false)
  assert.equal(validateCustomAvatarJson(JSON.stringify({
    version: 1,
    body: { path: 'M10 10L90 90Z' },
    eyes: { x: 50, y: 50, spacing: 18, scale: 5 },
  })).ok, false)

  // Bare shape alias normalization (`circle` -> `shape-circle`) & clamping
  const norm = normalizeAvatar({
    avatarId: 'circle',
    color: '#F60',
    material: 'fluffy',
    clay: false,
    yaw: 99,
    pitch: -99,
    orbit: true,
    badge: 'red',
    depth: 99,
    followPointer: false,
  }, { strict: true })
  assertAvatarShape(norm)
  assert.equal(norm.avatarId, 'shape-circle')
  assert.equal(norm.color, '#ff6600')
  assert.equal(norm.material, 'fluffy')
  assert.equal(norm.clay, false)
  assert.equal(norm.yaw, 0.9)
  assert.equal(norm.pitch, -0.6)
  assert.equal(norm.orbit, true)
  assert.equal(norm.badge, true)
  assert.equal(norm.depth, 14)
  assert.equal(norm.followPointer, false)

  // Randomizer avoids existing avatarIds
  const picked = []
  const fakeBots = []
  for (let i = 0; i < 6; i += 1) {
    const av = randomAvatar({ existingBots: fakeBots })
    assertAvatarShape(av)
    picked.push(av.avatarId)
    fakeBots.push({ id: `b_${i}`, avatar: av })
  }
  assert.equal(new Set(picked).size, 6, 'randomAvatar should pick distinct avatarIds when unused ones exist')

  // Deterministic migration fallback for legacy Bots
  const d1 = deterministicAvatar('bot_legacy_01', '#2f9e6e')
  const d2 = deterministicAvatar('bot_legacy_01', '#2f9e6e')
  assert.deepEqual(d1, d2)
  assert.equal(d1.color, '#2f9e6e')
}

// --- 2. End-to-end Host API & Gateway Avatar Transport ---
const root = await mkdtemp(join(tmpdir(), 'botmode-avatar-test-'))
const gw = await startAvatarMockGateway()
try {
  const store = new BotStore(root)
  await store.load()
  const screen = new ScreenBridge({ gatewayUrl: gw.url, autoSpawn: false })
  const dispatcher = {
    status: () => ({ busy: {}, last: {} }),
    inRoom: () => false,
    ensureSession: async (bot) => { bot.sessionId = `sess_${bot.id}` },
    cancel: () => ({ ok: true }),
  }
  const rooms = {
    state: () => ({ running: false, stopping: false, currentSpeakerId: '', speakingBotIds: [], actors: [] }),
  }
  const ctx = {
    get(key) {
      if (key === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
  }
  const api = new BotApi({ ctx, store, dispatcher, rooms, routines: {}, approvals: { list: () => [] }, screen })

  // 2a. GET /botmode/api/avatar/catalog & bundle.js
  const catRes = await runApiReq(api, { method: 'GET', url: '/botmode/api/avatar/catalog' })
  assert.equal(catRes.status, 200)
  const catJson = JSON.parse(catRes.body.toString('utf8'))
  assert.equal(catJson.ok, true)
  assert.equal(catJson.catalog.items.length, 19)

  const bundleRes = await runApiReq(api, { method: 'GET', url: '/botmode/api/avatar/bundle.js' })
  assert.equal(bundleRes.status, 200)
  assert.ok(bundleRes.headers['content-type'].includes('javascript'))
  assert.ok(bundleRes.body.toString('utf8').includes('__DSH_AVATAR_ENGINE__'))

  // 2b. Create Bot WITHOUT avatar (optional -> random)
  const r1 = await api.command({ type: 'bot.save', draft: { name: 'RandomAlpha', role: 'Researcher' } })
  assertAvatarShape(r1.bot.avatar)
  assert.equal(r1.bot.color, r1.bot.avatar.color)
  const r2 = await api.command({ type: 'bot.save', draft: { name: 'RandomBeta', avatarRandom: true } })
  assertAvatarShape(r2.bot.avatar)
  assert.notEqual(r1.bot.avatar.avatarId, r2.bot.avatar.avatarId, 'random avatars should avoid collisions')

  // Verify synced to BotScreen gateway asynchronously
  const synced = await waitUntil(() => gw.avatarsByBot.has(r1.bot.id) && gw.avatarsByBot.has(r2.bot.id))
  assert.equal(synced, true, 'creating Bots should sync avatars to BotScreen gateway')
  assert.deepEqual(gw.avatarsByBot.get(r1.bot.id), r1.bot.avatar)

  // Verify persisted to bot.json and roster.json
  const botJsonOnDisk = JSON.parse(await readFile(join(r1.bot.dir, 'bot.json'), 'utf8'))
  assert.deepEqual(botJsonOnDisk.avatar, r1.bot.avatar)
  const rosterOnDisk = JSON.parse(await readFile(join(store.botsRoot, 'roster.json'), 'utf8'))
  const rosterEntry = rosterOnDisk.find(x => x.id === r1.bot.id)
  assert.deepEqual(rosterEntry.avatar, r1.bot.avatar)

  // 2c. Create Bot WITH custom avatar (including customJson)
  const r3 = await api.command({
    type: 'bot.save',
    draft: {
      name: 'CustomGamma',
      avatar: {
        avatarId: 'neko',
        customJson: VALID_CUSTOM_JSON,
        color: '#8b5cf6',
        eyeColor: '#ffffff',
        material: 'fluffy',
        clay: false,
        yaw: 0.35,
        pitch: -0.2,
        orbit: true,
        badge: true,
        depth: 10,
        followPointer: false,
      },
    },
  })
  assertAvatarShape(r3.bot.avatar)
  assert.equal(r3.bot.avatar.avatarId, 'neko')
  assert.equal(r3.bot.avatar.color, '#8b5cf6')
  assert.equal(r3.bot.color, '#8b5cf6')
  assert.equal(r3.bot.avatar.eyeColor, '#ffffff')
  assert.equal(r3.bot.avatar.material, 'fluffy')
  assert.equal(r3.bot.avatar.clay, false)
  assert.equal(r3.bot.avatar.yaw, 0.35)
  assert.equal(r3.bot.avatar.pitch, -0.2)
  assert.equal(r3.bot.avatar.orbit, true)
  assert.equal(r3.bot.avatar.badge, true)
  assert.equal(r3.bot.avatar.depth, 10)
  assert.equal(r3.bot.avatar.followPointer, false)
  assert.ok(r3.bot.avatar.customJson.includes('"my-bot"'))

  // Reject invalid avatarId or invalid customJson strictly
  await assert.rejects(
    () => api.command({ type: 'bot.save', draft: { name: 'BadAvatar', avatar: { avatarId: 'nonexistent-id' } } }),
    /Unknown avatarId/,
  )
  await assert.rejects(
    () => api.command({ type: 'bot.save', draft: { name: 'BadJson', avatar: { customJson: '{broken' } } }),
    /not valid JSON/,
  )

  // 2d. GET /botmode/api/avatar (all & single) and PUT /botmode/api/avatar
  const allAvRes = await runApiReq(api, { method: 'GET', url: '/botmode/api/avatar' })
  assert.equal(allAvRes.status, 200)
  const allAvJson = JSON.parse(allAvRes.body.toString('utf8'))
  assert.equal(Object.keys(allAvJson.avatars).length, 3)
  assert.deepEqual(allAvJson.avatars[r3.bot.id], r3.bot.avatar)

  const oneAvRes = await runApiReq(api, { method: 'GET', url: `/botmode/api/avatar?botId=${encodeURIComponent(r3.bot.id)}` })
  assert.equal(oneAvRes.status, 200)
  assert.deepEqual(JSON.parse(oneAvRes.body.toString('utf8')).avatar, r3.bot.avatar)

  const missingAvRes = await runApiReq(api, { method: 'GET', url: '/botmode/api/avatar?botId=bot_does_not_exist' })
  assert.equal(missingAvRes.status, 404)

  const putAvRes = await runApiReq(api, {
    method: 'PUT',
    url: '/botmode/api/avatar',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      botId: r1.bot.id,
      avatar: { avatarId: 'ghost', color: '#14b8a6', orbit: true, depth: 9 },
    }),
  })
  assert.equal(putAvRes.status, 200)
  const putAvJson = JSON.parse(putAvRes.body.toString('utf8'))
  assert.equal(putAvJson.avatar.avatarId, 'ghost')
  assert.equal(putAvJson.avatar.color, '#14b8a6')
  assert.equal(putAvJson.avatar.orbit, true)
  assert.equal(putAvJson.avatar.depth, 9)
  assert.equal(putAvJson.bot.color, '#14b8a6')

  // Verify BotScreen gateway received updated avatar
  const updatedSynced = await waitUntil(() => gw.avatarsByBot.get(r1.bot.id)?.avatarId === 'ghost')
  assert.equal(updatedSynced, true)
  const fromGw = await screen.getAvatar(r1.bot.id)
  assert.equal(fromGw.avatar.avatarId, 'ghost')
  const listGw = await screen.listAvatars()
  assert.equal(listGw.avatars[r1.bot.id].avatarId, 'ghost')

  // 2e. bot.avatar.randomize command
  const randRes = await api.command({ type: 'bot.avatar.randomize', botId: r1.bot.id })
  assertAvatarShape(randRes.avatar)

  // 2f. GET /botmode/api/state exposes avatar on bots and room members
  await store.mutate((state) => {
    state.rooms.push({
      id: 'room_av',
      name: 'Avatar Room',
      color: '#d97706',
      purpose: '',
      notes: '',
      workDir: '',
      memberIds: [r1.bot.id, r3.bot.id],
      mode: 'auto',
      leadBotId: '',
      status: 'idle',
      settledReason: '',
      needsYou: false,
      pausedReason: '',
      completion: null,
      subtasks: [],
      progress: { goal: '', items: [], updatedBy: '', updatedAt: '' },
      epoch: 0,
      nextSeq: 0,
      transcript: [],
      activity: [],
      watermarks: {},
      memberSessions: {},
      budget: { rounds: 0, messages: 0, maxRounds: 0, maxMessages: 0, tokensUsed: 0, tokenLimit: 0, tokenCheckpoint: 0, idleRounds: 0, idleRoundLimit: 5 },
      createdAt: new Date().toISOString(),
    })
  })
  const stateRes = await runApiReq(api, { method: 'GET', url: '/botmode/api/state' })
  assert.equal(stateRes.status, 200)
  const stateJson = JSON.parse(stateRes.body.toString('utf8')).state
  const stateBot3 = stateJson.bots.find(b => b.id === r3.bot.id)
  assert.deepEqual(stateBot3.avatar, r3.bot.avatar)
  const stateRoom = stateJson.rooms.find(rm => rm.id === 'room_av')
  const roomMember3 = stateRoom.members.find(m => m.id === r3.bot.id)
  assert.deepEqual(roomMember3.avatar, r3.bot.avatar)

  console.log('✓ avatar.test.mjs all assertions passed')
} finally {
  await gw.close()
  await rm(root, { recursive: true, force: true })
}
