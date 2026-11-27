/**
 * The Host API the Bot page talks to.
 *
 * One authenticated, same-origin JSON surface behind `/botmode/api/`:
 *   GET  state          — roster, Sections, Rooms, Routines, Memory Hub and live status
 *   GET  models         — live DSH provider/model catalog
 *   GET  memory         — full Memory Hub status, installed plugins, catalog & health
 *   GET  system         — host system info (disk, memory, CPU, uptime) via BotScreen gateway
 *   GET  system/config  — read gateway & system info interface configuration
 *   PUT/POST system/config — update & sync gateway / system info interface configuration
 *   POST system/push    — push a system info snapshot through gateway to configured endpoint
 *   GET  system/stream  — SSE live system metrics stream via gateway
 *   GET  avatar         — read one Bot's avatar (`?botId=...`) or all Bot avatars map
 *   PUT/POST avatar     — update one Bot's avatar config (synced to BotScreen gateway)
 *   GET  avatar/catalog — built-in 19-avatar catalog & 12 clay palettes (Image-bot)
 *   GET  avatar/bundle.js — zero-dependency browser `<grok-bot>` engine bundle
 *   GET  artifacts      — list Agent reply artifacts & deliverables (with gateway download URLs)
 *   POST artifacts      — publish/upload an Agent reply artifact through BotScreen gateway
 *   GET  artifacts/download — download an Agent reply artifact via BotScreen gateway (`?id=...`)
 *   GET  artifacts/:id/download — REST alias for downloading an Agent reply artifact via gateway
 *   POST artifacts/bundle — download multiple Agent reply artifacts as a ZIP archive via gateway
 *   DELETE artifacts    — delete an Agent reply artifact (`?id=...` or `DELETE artifacts/:id`)
 *   POST image          — upload one image attachment
 *   POST command        — one typed mutation or action
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  clampInt,
  defaultSettingsState,
  newId,
  normalizeDiskPaths,
  normalizeSystemSettings,
  readTextFile,
  writeTextFile,
} from './store.js'
import { seedInitialMemoryHub, syncBotFiles, syncTeamFiles } from './persona.js'
import { nextCronTime } from './cron.js'
import { normalizeRoutineSettings } from './scheduler/model.js'
import { botModelCatalog } from './models.js'
import {
  avatarBundleScript,
  avatarCatalog,
  deterministicAvatar,
  hasExplicitAvatar,
  normalizeAvatar,
  normalizeHex,
  randomAvatar,
} from './avatar.js'
import {
  MAX_ARTIFACT_BYTES,
  buildContentDisposition,
  extractXmlArtifacts,
  inferArtifactMimeType,
  isValidArtifactId,
  makeDeliverableArtifactId,
  resolveSafeWorkspaceFile,
  sanitizeArtifactFilename,
} from './artifacts.js'
import { collectLocalHostSystem } from './screen.js'
import {
  deleteBotSkillFile,
  discoverBotSkills,
  isNormalModeOnlyTool,
  readBotSkillRaw,
  saveBotSkillFile,
} from './isolation.js'
import { normalizeNotificationsSettings } from './channels.js'
import { RemoteGateway } from './remote.js'

const BOT_SCOPED_TOOL_NAMES = [
  'message_agent',
  'bot_team',
  'bot_manage',
  'room_manage',
  'scheduled_tasks',
  'claim_subtask',
  'room_task_progress',
  'room_finish_task',
  'memory_search',
  'memory_conversation_search',
  'memory_read_scene',
  'memory_save',
  'memory_tencentdb_memory_search',
  'memory_tencentdb_conversation_search',
  'memory_tencentdb_read_scene',
  'screen_screenshot',
  'screen_click',
  'screen_type',
  'screen_key',
  'screen_scroll',
  'screen_drag',
  'screen_open_app',
  'screen_windows',
  'screen_request_help',
  'system_info',
  'publish_artifact',
  'skill',
]

const MAX_BODY_BYTES = 256 * 1024
const MAX_ARTIFACT_JSON_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const APPROVAL_POLICIES = ['ask', 'always', 'never']
const PREFIX = '/botmode/api/'
const SYSTEM_INFO_ROUTES = new Set([
  'system',
  'system/info',
  'host',
  'host/info',
  'host/system',
  'sysinfo',
  'node/info',
])
const SYSTEM_STREAM_ROUTES = new Set(['system/stream', 'host/stream'])

const sendJson = (res, status, payload) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

const readRawBody = async (req, maxBytes) => {
  const declaredLength = Number(req.headers?.['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.destroy?.()
    return undefined
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > maxBytes) {
      req.destroy?.()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

const readBody = async (req) => {
  const body = await readRawBody(req, MAX_BODY_BYTES)
  return body === undefined ? undefined : body.toString('utf8')
}

const stringOr = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

export class BotApi {
  #screenSnapshot = {
    available: false,
    gatewayUrl: 'http://127.0.0.1:6200',
    autoStartable: false,
    starting: false,
    error: '',
    byBot: {},
    host: null,
  }

  #systemSnapshot = null
  #skillsByBot = new Map()

  constructor({ ctx, store, dispatcher, rooms, routines, approvals, memory, mcp, screen, notifications, webhooks, remote, logger }) {
    this.ctx = ctx
    this.store = store
    this.dispatcher = dispatcher
    this.rooms = rooms
    this.routines = routines
    this.approvals = approvals ?? { list: () => [], decide: async () => ({}) }
    this.memory = memory ?? null
    this.mcp = mcp ?? null
    this.screen = screen ?? null
    this.notifications = notifications ?? null
    this.webhooks = webhooks ?? null
    this.remote = remote ?? new RemoteGateway({ logger: logger ?? console })
    this.logger = logger
  }

  async #refreshScreenSnapshot() {
    if (!this.screen) return this.#screenSnapshot
    const data = await this.screen.listScreens()
    const byBot = {}
    for (const item of data.screens || []) {
      if (item && item.bot_id) byBot[item.bot_id] = item
    }
    const gwUrl = data.gatewayUrl || this.screen.gatewayUrl
    let host = data.host || null
    const hasRichHost = Boolean(host && host.cpu && host.memory && host.disk)
    if (hasRichHost) {
      this.#systemSnapshot = {
        available: true,
        source: 'gateway',
        gatewayUrl: gwUrl,
        ...host,
      }
    } else if (typeof this.screen.isLocalGateway === 'function' && this.screen.isLocalGateway()) {
      // Local gateway is offline, starting, or pinned on a legacy build without CPU/disk fields:
      // enrich with local Host metrics while preserving any gateway memory-gate fields.
      const sysCfg = this.#currentSystemSettings()
      const fallback = collectLocalHostSystem(sysCfg.diskPaths)
      host = {
        ...fallback,
        ...(host || {}),
        gatewayAvailable: data.available === true,
        gatewayUrl: gwUrl,
        gatewayError: typeof data.error === 'string' ? data.error : '',
        degraded: true,
        source: 'host-fallback',
      }
      this.#systemSnapshot = host
    }
    this.#screenSnapshot = {
      available: data.available === true,
      gatewayUrl: gwUrl,
      autoStartable: Boolean(data.autoStartable),
      starting: Boolean(data.starting),
      error: typeof data.error === 'string' ? data.error : '',
      host,
      byBot,
    }
    return this.#screenSnapshot
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith(PREFIX)) {
      const earlyRoute = url.pathname.slice(PREFIX.length)
      const webhookMatch = /^webhook\/([^/]+)$/.exec(earlyRoute)
      if (webhookMatch && req.method === 'POST') {
        if (!this.webhooks) {
          sendJson(res, 503, { ok: false, error: 'webhooks unavailable' })
          return
        }
        const raw = await readBody(req)
        if (raw === undefined) {
          sendJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        try {
          await this.store.load()
          const webhookId = decodeURIComponent(webhookMatch[1])
          const result = await this.webhooks.trigger(webhookId, {
            headers: req.headers ?? {},
            rawBody: raw,
          })
          sendJson(res, result.status || (result.ok ? 202 : 400), result)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
    }

    const connection = this.ctx.get('connection')
    if (!connection || typeof connection.requestRejection !== 'function') {
      sendJson(res, 503, { ok: false, error: 'connection auth fence unavailable' })
      return
    }
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'sign-in required' : 'request refused' })
      return
    }
    if (!url.pathname.startsWith(PREFIX)) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const route = url.pathname.slice(PREFIX.length)
    try {
      if (route === 'state' && req.method === 'GET') {
        await this.store.load()
        if (this.mcp) await this.mcp.syncIfChanged().catch(() => undefined)
        if (this.memory) await this.memory.ensureReady().catch(() => undefined)
        await Promise.all([
          this.#refreshScreenSnapshot().catch(() => undefined),
          this.#refreshBotSkills().catch(() => undefined),
        ])
        sendJson(res, 200, { ok: true, state: this.publicState() })
        return
      }
      if (route === 'remote' && req.method === 'GET') {
        try {
          await this.remote?.recordUpstreamHintFromRequest?.(req)
          sendJson(res, 200, await this.remote.status({ qr: url.searchParams.get('qr') !== '0' }))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === 'screen/status' && req.method === 'GET') {
        const botId = stringOr(url.searchParams.get('botId'))
        if (!this.screen) {
          sendJson(res, 503, { ok: false, error: 'Screen bridge unavailable' })
          return
        }
        if (botId) {
          const status = await this.screen.getStatus(botId)
          this.#screenSnapshot.byBot[botId] = status
          sendJson(res, 200, { ok: true, screen: status })
          return
        }
        const snap = await this.#refreshScreenSnapshot()
        sendJson(res, 200, { ok: true, ...snap })
        return
      }
      if (route === 'screen/preview' && req.method === 'GET') {
        const botId = stringOr(url.searchParams.get('botId'))
        if (!botId || !this.screen) {
          sendJson(res, 404, { ok: false, error: 'unknown bot or screen unavailable' })
          return
        }
        const cached = url.searchParams.get('cached') !== '0'
        const onlyCached = url.searchParams.get('onlyCached') === '1'
        const ifNoneMatch = stringOr(req.headers?.['if-none-match'])
        try {
          const shot = await this.screen.preview(botId, { cached, onlyCached, ifNoneMatch })
          res.setHeader('cache-control', 'no-store')
          if (shot.etag) res.setHeader('etag', shot.etag)
          if (shot.frozen) res.setHeader('x-screen-frozen', 'true')
          if (shot.width) res.setHeader('x-screen-width', String(shot.width))
          if (shot.height) res.setHeader('x-screen-height', String(shot.height))
          if (shot.notModified) {
            res.statusCode = 304
            res.end()
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', shot.mimeType)
          res.end(shot.buffer)
        } catch (error) {
          sendJson(res, error?.status || 409, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === 'screen/stream' && req.method === 'GET') {
        const botId = stringOr(url.searchParams.get('botId'))
        if (!botId || !this.screen) {
          sendJson(res, 404, { ok: false, error: 'unknown bot or screen unavailable' })
          return
        }
        const format = url.searchParams.get('fmt') === 'webp' ? 'webp' : 'jpeg'
        const ac = new AbortController()
        const onAbort = () => ac.abort()
        const onResClose = () => {
          if (!res.writableEnded) ac.abort()
        }
        req.on?.('aborted', onAbort)
        res.on?.('close', onResClose)
        try {
          const upstream = await this.screen.openTileStream(botId, { format, signal: ac.signal })
          res.statusCode = 200
          res.setHeader('content-type', 'text/event-stream; charset=utf-8')
          res.setHeader('cache-control', 'no-cache, no-transform')
          res.setHeader('connection', 'keep-alive')
          res.setHeader('x-accel-buffering', 'no')
          res.flushHeaders?.()
          for await (const chunk of upstream.body) {
            if (ac.signal.aborted || res.writableEnded) break
            res.write(Buffer.from(chunk))
          }
          if (!res.writableEnded) res.end()
        } catch (error) {
          if (!ac.signal.aborted && !res.headersSent) {
            sendJson(res, error?.status || 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
          } else if (!res.writableEnded) {
            res.end()
          }
        } finally {
          req.off?.('aborted', onAbort)
          res.off?.('close', onResClose)
          ac.abort()
        }
        return
      }
      if (route === 'screen/input' && req.method === 'POST') {
        const ct = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (ct !== 'application/json') {
          sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        const raw = await readBody(req)
        if (raw === undefined) {
          sendJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let payload
        try {
          payload = JSON.parse(raw)
        } catch (_error) {
          sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          return
        }
        const botId = stringOr(payload?.botId)
        if (!botId || !this.screen) {
          sendJson(res, 400, { ok: false, error: 'missing botId or screen unavailable' })
          return
        }
        const result = await this.screen.humanInput(botId, payload?.input || payload)
        sendJson(res, 200, { ok: true, result })
        return
      }
      if (route === 'screen/audit' && req.method === 'GET') {
        const botId = stringOr(url.searchParams.get('botId'))
        if (!botId || !this.screen) {
          sendJson(res, 400, { ok: false, error: 'missing botId' })
          return
        }
        const limit = Number(url.searchParams.get('limit') || 30)
        const data = await this.screen.audit(botId, limit)
        sendJson(res, 200, { ok: true, ...data })
        return
      }
      if (route === 'screen/files' && req.method === 'GET') {
        const botId = stringOr(url.searchParams.get('botId'))
        if (!botId || !this.screen) {
          sendJson(res, 400, { ok: false, error: 'missing botId' })
          return
        }
        const data = await this.screen.listFiles(botId)
        sendJson(res, 200, { ok: true, ...data })
        return
      }
      if (route === 'screen/files' && req.method === 'POST') {
        const botId = stringOr(url.searchParams.get('botId'))
        if (!botId || !this.screen) {
          sendJson(res, 400, { ok: false, error: 'missing botId' })
          return
        }
        const body = await readRawBody(req, 32 * 1024 * 1024)
        if (body === undefined) {
          sendJson(res, 413, { ok: false, error: 'file too large' })
          return
        }
        let name = 'upload.bin'
        try {
          const rawName = String(req.headers['x-file-name'] || url.searchParams.get('name') || '')
          if (rawName) name = decodeURIComponent(rawName)
        } catch (_e) { /* keep default */ }
        const data = await this.screen.uploadFile(botId, name, body, String(req.headers['content-type'] || 'application/octet-stream'))
        sendJson(res, 200, { ok: true, ...data })
        return
      }
      if (route === 'screen/file' && req.method === 'GET') {
        const botId = stringOr(url.searchParams.get('botId'))
        const name = stringOr(url.searchParams.get('name'))
        if (!botId || !name || !this.screen) {
          sendJson(res, 400, { ok: false, error: 'missing botId or name' })
          return
        }
        const file = await this.screen.downloadFile(botId, name)
        res.statusCode = 200
        res.setHeader('content-type', file.mimeType)
        res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(name)}"`)
        res.end(file.buffer)
        return
      }
      if (route === 'screen/file' && req.method === 'DELETE') {
        const botId = stringOr(url.searchParams.get('botId'))
        const name = stringOr(url.searchParams.get('name'))
        if (!botId || !name || !this.screen) {
          sendJson(res, 400, { ok: false, error: 'missing botId or name' })
          return
        }
        const data = await this.screen.deleteFile(botId, name)
        sendJson(res, 200, { ok: true, ...data })
        return
      }
      if (route === 'models' && req.method === 'GET') {
        const force = url.searchParams.get('force') === '1'
        const catalog = await botModelCatalog(this.ctx, { force })
        sendJson(res, 200, { ok: true, catalog })
        return
      }
      if (route === 'memory' && req.method === 'GET') {
        await this.store.load()
        const memory = this.memory ? await this.memory.status() : null
        sendJson(res, 200, { ok: true, memory })
        return
      }
      if (SYSTEM_INFO_ROUTES.has(route) && req.method === 'GET') {
        await this.store.load()
        const rawDisk = url.searchParams.get('diskPath') || url.searchParams.get('disk_path') || ''
        const diskPaths = rawDisk ? normalizeDiskPaths(rawDisk) : undefined
        const data = await this.getSystemInfo({ diskPaths })
        const sys = data.system || {}
        sendJson(res, 200, {
          ok: sys.available !== false,
          ...(sys.hostname !== undefined ? { hostname: sys.hostname } : {}),
          ...(sys.os !== undefined ? { os: sys.os } : {}),
          ...(sys.arch !== undefined ? { arch: sys.arch } : {}),
          ...(sys.kernel !== undefined ? { kernel: sys.kernel } : {}),
          ...(sys.platform !== undefined ? { platform: sys.platform } : {}),
          ...(sys.cgroup !== undefined ? { cgroup: sys.cgroup } : {}),
          ...(sys.source !== undefined ? { source: sys.source } : {}),
          ...(sys.degraded !== undefined ? { degraded: sys.degraded } : {}),
          ...(sys.available_mb !== undefined ? { available_mb: sys.available_mb } : {}),
          ...(sys.limit_mb !== undefined ? { limit_mb: sys.limit_mb } : {}),
          ...(sys.min_free_mb !== undefined ? { min_free_mb: sys.min_free_mb } : {}),
          ...(sys.blocker !== undefined ? { blocker: sys.blocker } : {}),
          ...(sys.cpu !== undefined ? { cpu: sys.cpu } : {}),
          ...(sys.memory !== undefined ? { memory: sys.memory } : {}),
          ...(sys.disk !== undefined ? { disk: sys.disk } : {}),
          ...(sys.uptime !== undefined ? { uptime: sys.uptime } : {}),
          ...data,
        })
        return
      }
      if (route === 'system/config' && req.method === 'GET') {
        await this.store.load()
        const data = await this.getSystemConfig()
        sendJson(res, 200, { ok: true, ...data })
        return
      }
      if (route === 'system/config' && (req.method === 'PUT' || req.method === 'POST')) {
        const ct = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (ct !== 'application/json') {
          sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        const raw = await readBody(req)
        if (raw === undefined) {
          sendJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let payload
        try {
          payload = JSON.parse(raw)
        } catch (_error) {
          sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          return
        }
        await this.store.load()
        const data = await this.saveSystemConfig(payload)
        sendJson(res, 200, { ok: true, ...data, state: this.publicState() })
        return
      }
      if (route === 'system/push' && req.method === 'POST') {
        let payload = {}
        const raw = await readBody(req)
        if (raw === undefined) {
          sendJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        if (raw.trim() !== '') {
          try {
            payload = JSON.parse(raw)
          } catch (_error) {
            sendJson(res, 400, { ok: false, error: 'invalid JSON' })
            return
          }
        }
        await this.store.load()
        const data = await this.pushSystemInfo(payload)
        sendJson(res, 200, { ok: data?.ok !== false, result: data })
        return
      }
      if (SYSTEM_STREAM_ROUTES.has(route) && req.method === 'GET') {
        if (!this.screen) {
          sendJson(res, 503, { ok: false, error: 'Gateway bridge unavailable' })
          return
        }
        await this.store.load()
        const sysCfg = this.#currentSystemSettings()
        const rawInterval = url.searchParams.get('interval')
        const interval = rawInterval !== null && rawInterval !== ''
          ? Number(rawInterval)
          : sysCfg.refreshIntervalSec
        const stepMs = Math.max(500, Math.min(60_000, Math.round((Number.isFinite(interval) ? interval : 2) * 1000)))
        const rawDisk = url.searchParams.get('diskPath') || url.searchParams.get('disk_path') || ''
        const diskPaths = rawDisk ? normalizeDiskPaths(rawDisk) : sysCfg.diskPaths
        const ac = new AbortController()
        const onAbort = () => ac.abort()
        const onResClose = () => {
          if (!res.writableEnded) ac.abort()
        }
        req.on?.('aborted', onAbort)
        res.on?.('close', onResClose)
        try {
          const upstream = await this.screen.openSystemStream({ interval, diskPaths, signal: ac.signal })
          res.statusCode = 200
          res.setHeader('content-type', 'text/event-stream; charset=utf-8')
          res.setHeader('cache-control', 'no-cache, no-transform')
          res.setHeader('connection', 'keep-alive')
          res.setHeader('x-accel-buffering', 'no')
          res.flushHeaders?.()
          for await (const chunk of upstream.body) {
            if (ac.signal.aborted || res.writableEnded) break
            res.write(Buffer.from(chunk))
          }
          if (!res.writableEnded) res.end()
        } catch (error) {
          const canLocalFallback = !ac.signal.aborted
            && !res.headersSent
            && typeof this.screen.isLocalGateway === 'function'
            && this.screen.isLocalGateway()
          if (canLocalFallback) {
            const gwErr = error instanceof Error ? error.message : String(error)
            res.statusCode = 200
            res.setHeader('content-type', 'text/event-stream; charset=utf-8')
            res.setHeader('cache-control', 'no-cache, no-transform')
            res.setHeader('connection', 'keep-alive')
            res.setHeader('x-accel-buffering', 'no')
            res.flushHeaders?.()
            const emit = () => {
              const pkt = {
                type: 'system',
                ...collectLocalHostSystem(diskPaths),
                gatewayAvailable: false,
                gatewayUrl: this.screen.gatewayUrl,
                gatewayError: gwErr,
              }
              this.#systemSnapshot = pkt
              res.write(`data: ${JSON.stringify(pkt)}\n\n`)
            }
            emit()
            // Wait on abort/close when the stream is a real HTTP socket; mock test responses without `.on` finish after one frame.
            if (typeof res.on === 'function') {
              await new Promise((resolveDone) => {
                const timer = setInterval(() => {
                  if (ac.signal.aborted || res.writableEnded) {
                    clearInterval(timer)
                    resolveDone()
                    return
                  }
                  emit()
                }, stepMs)
                ac.signal.addEventListener('abort', () => {
                  clearInterval(timer)
                  resolveDone()
                }, { once: true })
              })
            }
            if (!res.writableEnded) res.end()
          } else if (!ac.signal.aborted && !res.headersSent) {
            sendJson(res, error?.status || 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
          } else if (!res.writableEnded) {
            res.end()
          }
        } finally {
          req.off?.('aborted', onAbort)
          res.off?.('close', onResClose)
          ac.abort()
        }
        return
      }
      if (route === 'avatar/catalog' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, catalog: avatarCatalog() })
        return
      }
      if (route === 'avatar/bundle.js' && req.method === 'GET') {
        const script = avatarBundleScript()
        res.statusCode = 200
        res.setHeader('content-type', 'application/javascript; charset=utf-8')
        res.setHeader('cache-control', 'public, max-age=300')
        res.end(script)
        return
      }
      if (route === 'avatar' && req.method === 'GET') {
        await this.store.load()
        const botId = stringOr(url.searchParams.get('botId')).trim()
        if (botId) {
          const bot = this.store.bot(botId)
          if (!bot) {
            sendJson(res, 404, { ok: false, error: 'Unknown Bot.' })
            return
          }
          sendJson(res, 200, {
            ok: true,
            botId: bot.id,
            name: bot.name,
            avatar: bot.avatar,
          })
          return
        }
        const avatars = {}
        for (const bot of this.store.state.bots) {
          avatars[bot.id] = bot.avatar
        }
        sendJson(res, 200, { ok: true, avatars })
        return
      }
      if (route === 'avatar' && (req.method === 'PUT' || req.method === 'POST')) {
        const ct = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (ct !== 'application/json') {
          sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        const raw = await readBody(req)
        if (raw === undefined) {
          sendJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let payload
        try {
          payload = JSON.parse(raw)
        } catch (_error) {
          sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          return
        }
        await this.store.load()
        const botId = stringOr(payload?.botId || url.searchParams.get('botId')).trim()
        const avatarBody = payload?.avatar && typeof payload.avatar === 'object'
          ? payload.avatar
          : payload
        const result = payload?.random === true
          ? await this.randomizeBotAvatar({ botId })
          : await this.saveBotAvatar({ botId, avatar: avatarBody })
        sendJson(res, 200, { ok: true, ...result, state: this.publicState() })
        return
      }
      if (route === 'artifacts' && req.method === 'GET') {
        await this.store.load()
        const botId = stringOr(url.searchParams.get('botId') || url.searchParams.get('bot_id')).trim()
        const roomId = stringOr(url.searchParams.get('roomId') || url.searchParams.get('room_id')).trim()
        const kind = stringOr(url.searchParams.get('kind')).trim()
        const rawLimit = url.searchParams.get('limit')
        const limit = rawLimit !== null && rawLimit.trim() !== '' ? clampInt(rawLimit, 1, 500, 100) : 100
        const data = await this.listArtifacts({ botId, roomId, kind, limit })
        sendJson(res, 200, { ok: true, ...data })
        return
      }
      if (route === 'artifacts' && req.method === 'POST') {
        await this.store.load()
        const ct = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (ct === 'application/json') {
          const rawBuf = await readRawBody(req, MAX_ARTIFACT_JSON_BYTES)
          if (rawBuf === undefined) {
            sendJson(res, 413, { ok: false, error: 'artifact payload too large' })
            return
          }
          let payload
          try {
            payload = JSON.parse(rawBuf.toString('utf8'))
          } catch (_error) {
            sendJson(res, 400, { ok: false, error: 'invalid JSON' })
            return
          }
          const result = await this.publishArtifact(payload)
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        const rawBuf = await readRawBody(req, MAX_ARTIFACT_BYTES)
        if (rawBuf === undefined) {
          sendJson(res, 413, { ok: false, error: 'artifact file too large' })
          return
        }
        let filename = 'artifact.bin'
        try {
          const rawName = String(req.headers['x-file-name'] || url.searchParams.get('filename') || url.searchParams.get('name') || '')
          if (rawName) filename = decodeURIComponent(rawName)
        } catch (_error) { /* keep default */ }
        const result = await this.publishArtifact({
          botId: stringOr(url.searchParams.get('botId') || url.searchParams.get('bot_id')).trim(),
          artifactId: stringOr(url.searchParams.get('id') || url.searchParams.get('artifactId')).trim(),
          title: stringOr(url.searchParams.get('title')).trim() || filename,
          filename,
          kind: stringOr(url.searchParams.get('kind')).trim() || 'file',
          type: stringOr(url.searchParams.get('type')).trim() || 'file',
          mimeType: ct || 'application/octet-stream',
          roomId: stringOr(url.searchParams.get('roomId') || url.searchParams.get('room_id')).trim(),
          messageId: stringOr(url.searchParams.get('messageId') || url.searchParams.get('message_id')).trim(),
          buffer: rawBuf,
        })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (route === 'artifacts/bundle' && req.method === 'POST') {
        await this.store.load()
        const raw = await readBody(req)
        if (raw === undefined) {
          sendJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let payload = {}
        if (raw.trim() !== '') {
          try {
            payload = JSON.parse(raw)
          } catch (_error) {
            sendJson(res, 400, { ok: false, error: 'invalid JSON' })
            return
          }
        }
        const ac = new AbortController()
        const onAbort = () => ac.abort()
        req.on?.('close', onAbort)
        res.on?.('close', onAbort)
        try {
          await this.#streamArtifactsBundle(payload, res, ac.signal)
        } catch (error) {
          if (!ac.signal.aborted && !res.headersSent) {
            sendJson(res, error?.status || 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
          } else if (!res.writableEnded) {
            res.end()
          }
        } finally {
          ac.abort()
        }
        return
      }
      const dlMatch = /^artifacts\/([^/]+)\/download$/.exec(route)
      if ((route === 'artifacts/download' || dlMatch) && req.method === 'GET') {
        await this.store.load()
        const artifactId = dlMatch
          ? decodeURIComponent(dlMatch[1])
          : stringOr(url.searchParams.get('id') || url.searchParams.get('artifactId') || url.searchParams.get('artifact_id')).trim()
        if (!artifactId) {
          sendJson(res, 400, { ok: false, error: 'missing artifact id' })
          return
        }
        const botId = stringOr(url.searchParams.get('botId') || url.searchParams.get('bot_id')).trim()
        const inline = url.searchParams.get('inline') === '1' || url.searchParams.get('inline') === 'true'
        const filename = stringOr(url.searchParams.get('filename')).trim()
        const ac = new AbortController()
        const onAbort = () => ac.abort()
        req.on?.('close', onAbort)
        res.on?.('close', onAbort)
        try {
          await this.#streamArtifactDownload({ artifactId, botId, inline, filename }, res, ac.signal)
        } catch (error) {
          if (!ac.signal.aborted && !res.headersSent) {
            sendJson(res, error?.status || 404, { ok: false, error: error instanceof Error ? error.message : String(error) })
          } else if (!res.writableEnded) {
            res.end()
          }
        } finally {
          ac.abort()
        }
        return
      }
      const delArtMatch = /^artifacts\/([^/]+)$/.exec(route)
      if ((route === 'artifacts' || delArtMatch) && req.method === 'DELETE') {
        await this.store.load()
        const artifactId = delArtMatch
          ? decodeURIComponent(delArtMatch[1])
          : stringOr(url.searchParams.get('id') || url.searchParams.get('artifactId') || url.searchParams.get('artifact_id')).trim()
        if (!artifactId) {
          sendJson(res, 400, { ok: false, error: 'missing artifact id' })
          return
        }
        const botId = stringOr(url.searchParams.get('botId') || url.searchParams.get('bot_id')).trim()
        const result = await this.deleteArtifact({ artifactId, botId })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (route === 'image' && req.method === 'POST') {
        const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (!IMAGE_TYPES.has(mediaType)) {
          sendJson(res, 415, { ok: false, error: 'unsupported image type' })
          return
        }
        const body = await readRawBody(req, MAX_IMAGE_BYTES)
        if (body === undefined) {
          sendJson(res, 413, { ok: false, error: 'image too large' })
          return
        }
        const attachments = this.ctx.get('attachments')
        if (!attachments || typeof attachments.saveImages !== 'function') {
          throw new Error('Image attachments are unavailable in this Host.')
        }
        let name = ''
        try {
          const raw = String(req.headers['x-botmode-image-name'] ?? '')
          name = raw === '' ? '' : decodeURIComponent(raw)
        } catch (_error) {
          name = ''
        }
        const [attachment] = await attachments.saveImages([{
          data: body,
          mediaType,
          ...name === '' ? {} : { name },
        }])
        sendJson(res, 200, { ok: true, attachment })
        return
      }
      if (route === 'command' && req.method === 'POST') {
        const ct = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (ct !== 'application/json') {
          sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        const raw = await readBody(req)
        if (raw === undefined) {
          sendJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let payload
        try {
          payload = JSON.parse(raw)
        } catch (_error) {
          sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          return
        }
        if (String(payload?.type ?? '').startsWith('remote.')) {
          await this.remote?.recordUpstreamHintFromRequest?.(req)
        }
        const result = await this.command(payload)
        sendJson(res, 200, { ok: true, state: this.publicState(), result })
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`botmode: API ${route} failed: ${message}`)
      sendJson(res, 400, { ok: false, error: message })
    }
  }

  publicState() {
    const state = this.store.state
    const status = this.dispatcher.status()
    return {
      version: state.version,
      sections: state.sections.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      bots: state.bots.map((bot) => ({
        ...bot,
        sessionId: bot.sessionId,
        running: status.busy[bot.id]?.running === true,
        queued: status.busy[bot.id]?.queued ?? 0,
        last: status.last[bot.id] ?? undefined,
        inRoom: this.dispatcher.inRoom(bot.id),
        roomSpeaking: this.dispatcher.roomSpeaking?.(bot.id) === true,
        activeRoomId: this.dispatcher.activeRoomId?.(bot.id) ?? '',
        discoveredSkills: this.#skillsByBot.get(bot.id) ?? [],
      })),
      rooms: state.rooms.map((room) => {
        const runtime = this.rooms.state(room.id)
        return {
          ...room,
          running: runtime.running,
          stopping: runtime.stopping,
          currentSpeakerId: runtime.currentSpeakerId || '',
          speakingBotIds: runtime.speakingBotIds || [],
          actors: runtime.actors || [],
          members: room.memberIds.map((id) => {
            const bot = this.store.bot(id)
            return bot
              ? { id: bot.id, name: bot.name, role: bot.role, color: bot.color, avatar: bot.avatar }
              : { id, name: id, role: '' }
          }),
        }
      }),
      routines: state.routines.map(routine => ({
        ...routine,
        botName: this.store.bot(routine.botId)?.name ?? '',
      })),
      routineNotices: (state.routineNotices ?? []).slice(-50),
      approvals: this.approvals ? this.approvals.list() : [],
      questions: this.approvals && typeof this.approvals.listQuestions === 'function'
        ? this.approvals.listQuestions()
        : [],
      screenHelps: this.approvals && typeof this.approvals.listScreenHelps === 'function'
        ? this.approvals.listScreenHelps()
        : [],
      screens: this.#screenSnapshot.byBot,
      screenGateway: {
        available: this.#screenSnapshot.available,
        gatewayUrl: this.#screenSnapshot.gatewayUrl,
        autoStartable: this.#screenSnapshot.autoStartable,
        starting: this.#screenSnapshot.starting,
        error: this.#screenSnapshot.error,
        host: this.#screenSnapshot.host,
      },
      system: this.#systemSnapshot || (this.#screenSnapshot.host?.cpu ? this.#screenSnapshot.host : null),
      memory: this.memory ? this.memory.publicSummary() : null,
      mcp: this.mcp ? this.mcp.publicConfig() : null,
      webhooks: this.webhooks ? this.webhooks.list() : (state.webhooks ?? []),
      notificationLogs: this.notifications ? this.notifications.recentLogs(20) : [],
      settings: state.settings ?? defaultSettingsState(),
      usage: this.#usageSummary(state),
      artifacts: this.#artifactsSummary(state),
      tools: (() => {
        try {
          const tools = this.ctx.get('tools')
          const globalAllowed = tools
            ? (tools.definitions?.() ?? [])
              .map(tool => tool.name)
              .filter(toolName => !isNormalModeOnlyTool(toolName))
            : []
          return [...new Set([...globalAllowed, ...BOT_SCOPED_TOOL_NAMES])].sort()
        } catch (_error) {
          return [...BOT_SCOPED_TOOL_NAMES].sort()
        }
      })(),
      runtime: {
        root: this.store.root,
        botsRoot: this.store.botsRoot,
        skillsRoot: this.store.skillsRoot,
        mcpConfigPath: this.store.mcpConfigPath,
        pid: process.pid,
      },
    }
  }

  async #refreshBotSkills() {
    const bots = this.store.state?.bots ?? []
    const hostSkills = this.ctx?.get?.('skills') ?? null
    const next = new Map()
    await Promise.all(bots.map(async (bot) => {
      try {
        const list = await discoverBotSkills(this.store, bot, { hostSkills, includeDisabled: true })
        next.set(bot.id, list.map(sk => ({
          name: sk.name,
          description: sk.description,
          source: sk.source,
          tier: sk.tier || 'bot',
          path: sk.path,
          enabled: sk.enabled !== false,
          editable: sk.editable === true,
        })))
      } catch (_error) {
        next.set(bot.id, [])
      }
    }))
    this.#skillsByBot = next
  }

  #usageSummary(state) {
    let totalTokens = 0
    let totalRoomMessages = 0
    const byRoom = []
    for (const room of state.rooms ?? []) {
      const tokens = Number(room.budget?.tokensUsed) || 0
      const messages = Number(room.budget?.messages) || (room.transcript?.length ?? 0)
      totalTokens += tokens
      totalRoomMessages += messages
      byRoom.push({
        roomId: room.id,
        name: room.name,
        status: room.status,
        tokensUsed: tokens,
        tokenLimit: Number(room.budget?.tokenLimit) || 0,
        messages: room.transcript?.length ?? 0,
        epoch: room.epoch ?? 0,
      })
    }
    return {
      totalTokens,
      totalRoomMessages,
      botCount: (state.bots ?? []).length,
      roomCount: (state.rooms ?? []).length,
      routineCount: (state.routines ?? []).length,
      byRoom,
    }
  }

  #artifactDownloadUrls(artifactId, botId = '') {
    const gw = this.screen?.gatewayUrl || 'http://127.0.0.1:6200'
    const encId = encodeURIComponent(artifactId)
    const botQs = botId ? `&botId=${encodeURIComponent(botId)}` : ''
    return {
      downloadUrl: `${PREFIX}artifacts/download?id=${encId}${botQs}`,
      restDownloadUrl: `${PREFIX}artifacts/${encId}/download${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`,
      gatewayDownloadUrl: `${gw}/api/artifacts/${encId}/download`,
      gatewayBotDownloadUrl: botId ? `${gw}/api/screens/${encodeURIComponent(botId)}/artifacts/${encId}/download` : '',
    }
  }

  #artifactEndpoints() {
    const gw = this.screen?.gatewayUrl || 'http://127.0.0.1:6200'
    return {
      hostList: `${PREFIX}artifacts`,
      hostPublish: `${PREFIX}artifacts`,
      hostDownload: `${PREFIX}artifacts/download`,
      hostRestDownload: `${PREFIX}artifacts/{id}/download`,
      hostBundle: `${PREFIX}artifacts/bundle`,
      hostDelete: `${PREFIX}artifacts/{id}`,
      gatewayList: `${gw}/api/artifacts`,
      gatewayMeta: `${gw}/api/artifacts/{artifact_id}`,
      gatewayDownload: `${gw}/api/artifacts/{artifact_id}/download`,
      gatewayBundle: `${gw}/api/artifacts/bundle`,
      gatewayDelete: `${gw}/api/artifacts/{artifact_id}`,
      gatewayBotList: `${gw}/api/screens/{bot_id}/artifacts`,
      gatewayBotPublish: `${gw}/api/screens/{bot_id}/artifacts`,
      gatewayBotDownload: `${gw}/api/screens/{bot_id}/artifacts/{artifact_id}/download`,
      gatewayAgentPublish: `${gw}/api/agent/{bot_id}/artifacts`,
      gatewayAgentList: `${gw}/api/agent/{bot_id}/artifacts`,
      gatewayAgentDownload: `${gw}/api/agent/{bot_id}/artifacts/{artifact_id}/download`,
    }
  }

  #artifactsSummary(state) {
    const byId = new Map()
    const upsert = (entry) => {
      if (!entry || !entry.id) return
      const existing = byId.get(entry.id)
      const urls = this.#artifactDownloadUrls(entry.id, entry.botId || existing?.botId || '')
      byId.set(entry.id, {
        ...(existing || {}),
        ...entry,
        artifactId: entry.id,
        ...urls,
      })
    }

    for (const room of state.rooms ?? []) {
      if (room.completion && Array.isArray(room.completion.deliverables)) {
        for (const filePath of room.completion.deliverables) {
          const aid = makeDeliverableArtifactId(room.id, filePath)
          const filename = sanitizeArtifactFilename(filePath, filePath, 'file')
          upsert({
            id: aid,
            kind: 'deliverable',
            title: filePath,
            type: 'file',
            filename,
            mimeType: inferArtifactMimeType(filename, 'file'),
            sourcePath: filePath,
            roomId: room.id,
            roomName: room.name,
            botId: room.completion.finishedBy || '',
            botName: room.completion.finishedByName || '',
            at: room.completion.at || room.updatedAt || '',
          })
        }
      }
      for (const msg of (room.transcript ?? []).slice(-100)) {
        if (typeof msg.text !== 'string' || !msg.text.includes('<artifact')) continue
        const extracted = extractXmlArtifacts(msg.text, {
          botId: msg.from || '',
          botName: msg.name || '',
          roomId: room.id,
          roomName: room.name,
          messageId: msg.id || '',
          at: msg.at || '',
        })
        for (const item of extracted) {
          const { content: _omitContent, ...metaOnly } = item
          upsert(metaOnly)
        }
      }
    }

    for (const item of state.artifacts ?? []) {
      if (item && item.id) {
        const filename = sanitizeArtifactFilename(item.filename, item.title, item.type)
        upsert({
          ...item,
          filename,
          mimeType: item.mimeType || inferArtifactMimeType(filename, item.type),
        })
      }
    }

    return [...byId.values()]
      .sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))
      .slice(0, 80)
  }

  async command(payload) {
    await this.store.load()
    const type = stringOr(payload?.type)
    switch (type) {
      case 'bot.save': return this.saveBot(payload)
      case 'bot.delete': return this.deleteBot(payload)
      case 'bot.avatar.save': return this.saveBotAvatar(payload)
      case 'bot.avatar.randomize': return this.randomizeBotAvatar(payload)
      case 'bot.dispatch': return this.dispatchBot(payload)
      case 'bot.stop': return this.stopBot(payload)
      case 'section.save': return this.saveSection(payload)
      case 'section.delete': return this.deleteSection(payload)
      case 'room.save': return this.rooms.save(stringOr(payload.roomId), {
        name: payload?.draft?.name,
        memberIds: payload?.draft?.memberIds,
        mode: payload?.draft?.mode,
        leadBotId: payload?.draft?.leadBotId,
        color: payload?.draft?.color,
        purpose: payload?.draft?.purpose,
        notes: payload?.draft?.notes,
        workDir: payload?.draft?.workDir,
        maxRounds: payload?.draft?.maxRounds,
        maxMessages: payload?.draft?.maxMessages,
        tokenLimit: payload?.draft?.tokenLimit,
        idleRoundLimit: payload?.draft?.idleRoundLimit,
      })
      case 'room.delete': return this.rooms.remove(stringOr(payload.roomId))
      case 'room.send': return this.rooms.send(stringOr(payload.roomId), stringOr(payload.text))
      case 'room.control': return this.rooms.control(stringOr(payload.roomId), stringOr(payload.action), {
        botId: stringOr(payload.botId),
      })
      case 'routine.save': return this.routines.save(stringOr(payload.routineId), {
        botId: stringOr(payload.botId),
        name: payload?.name,
        cron: payload?.cron,
        schedule: payload?.schedule,
        tz: payload?.tz,
        prompt: payload?.prompt,
        enabled: payload?.enabled,
        policy: payload?.policy,
      })
      case 'routine.delete': return this.routines.remove(stringOr(payload.routineId))
      case 'routine.toggle': return this.routines.setEnabled(stringOr(payload.routineId), payload?.enabled === true)
      case 'routine.run': return this.routines.runNow(stringOr(payload.routineId))
      case 'routine.renew': return this.routines.renew(stringOr(payload.routineId), payload?.days)
      case 'routine.history': return this.routines.history(stringOr(payload.routineId), payload?.limit)
      case 'routine.preview': return this.routines.previewSchedule(payload?.schedule ?? payload?.cron, payload?.tz)
      case 'routine.notices.read': return this.routines.markNoticesRead(payload?.ids)
      case 'routine.notices.clear': return this.routines.clearNotices()
      case 'approval.decide': return this.approvals.decide(stringOr(payload.approvalId), stringOr(payload.decision))
      case 'question.decide': return this.approvals.decideQuestion(stringOr(payload.questionId), payload.answers)
      case 'remote.status': return this.remote.status({ qr: payload?.qr !== false })
      case 'remote.up': return this.remote.up()
      case 'remote.rotate': return this.remote.rotate()
      case 'remote.rotateApp': return this.remote.rotateApp()
      case 'remote.down': return this.remote.down()
      case 'remote.inspect': return this.remote.inspectLink(payload?.link ?? payload?.text ?? '')
      case 'screen.help.decide': {
        const helpId = stringOr(payload.helpId)
        const decision = stringOr(payload.decision, 'release')
        const note = stringOr(payload.note)
        const result = await this.approvals.decideScreenHelp(helpId, decision, note)
        if (result?.botId && this.screen && decision !== 'cancel') {
          await this.screen.release(result.botId).catch(() => undefined)
          await this.#refreshScreenSnapshot().catch(() => undefined)
        }
        return result
      }
      case 'screen.start': {
        const botId = stringOr(payload.botId)
        const out = await this.#requireScreen().start(botId, Array.isArray(payload.apps) ? payload.apps : undefined)
        await this.#refreshScreenSnapshot().catch(() => undefined)
        return out
      }
      case 'screen.stop': {
        const botId = stringOr(payload.botId)
        const out = await this.#requireScreen().stop(botId)
        await this.#refreshScreenSnapshot().catch(() => undefined)
        return out
      }
      case 'screen.freeze': {
        const botId = stringOr(payload.botId)
        const out = await this.#requireScreen().freeze(botId)
        await this.#refreshScreenSnapshot().catch(() => undefined)
        return out
      }
      case 'screen.thaw': {
        const botId = stringOr(payload.botId)
        const out = await this.#requireScreen().thaw(botId)
        await this.#refreshScreenSnapshot().catch(() => undefined)
        return out
      }
      case 'screen.takeover': {
        const botId = stringOr(payload.botId)
        const out = await this.#requireScreen().takeover(botId, stringOr(payload.reason, 'human'))
        await this.#refreshScreenSnapshot().catch(() => undefined)
        return out
      }
      case 'screen.release': {
        const botId = stringOr(payload.botId)
        const out = await this.#requireScreen().release(botId)
        await this.#refreshScreenSnapshot().catch(() => undefined)
        return out
      }
      case 'screen.brake': {
        const botId = stringOr(payload.botId)
        const out = await this.#requireScreen().brake(botId)
        await this.#refreshScreenSnapshot().catch(() => undefined)
        return out
      }
      case 'screen.human_input': {
        const botId = stringOr(payload.botId)
        return this.#requireScreen().humanInput(botId, payload.input || payload)
      }
      case 'memory.select': return this.#requireMemory().select(stringOr(payload.providerId))
      case 'memory.configure': return this.#requireMemory().configure({
        providerId: stringOr(payload.providerId),
        teamId: payload?.teamId,
        userId: payload?.userId,
        prefetchEnabled: payload?.prefetchEnabled,
        syncEnabled: payload?.syncEnabled,
        syncGroupRooms: payload?.syncGroupRooms,
        config: payload?.config,
      })
      case 'memory.test': return this.#requireMemory().test(stringOr(payload.providerId))
      case 'memory.install': return this.#requireMemory().install(stringOr(payload.source), {
        overwrite: payload?.overwrite === true,
        activate: payload?.activate === true,
      })
      case 'memory.uninstall': return this.#requireMemory().uninstall(stringOr(payload.providerId))
      case 'memory.search': return this.searchBotMemory(payload)
      case 'system.info': return this.getSystemInfo({
        diskPaths: payload?.diskPaths ?? payload?.disk_paths ?? payload?.diskPath ?? payload?.disk_path,
      })
      case 'system.config.get': return this.getSystemConfig()
      case 'system.config.save': return this.saveSystemConfig(payload)
      case 'system.push': return this.pushSystemInfo(payload)
      case 'artifact.list': return this.listArtifacts({
        botId: stringOr(payload?.botId || payload?.bot_id).trim(),
        roomId: stringOr(payload?.roomId || payload?.room_id).trim(),
        kind: stringOr(payload?.kind).trim(),
        limit: payload?.limit !== undefined && payload?.limit !== null && payload?.limit !== ''
          ? clampInt(payload.limit, 1, 500, 100)
          : 100,
      })
      case 'artifact.publish': return this.publishArtifact({
        ...payload,
        type: stringOr(payload?.artifactType || payload?.artifact_type).trim(),
      })
      case 'artifact.delete': return this.deleteArtifact({
        artifactId: stringOr(payload?.artifactId || payload?.artifact_id || payload?.id).trim(),
        botId: stringOr(payload?.botId || payload?.bot_id).trim(),
      })
      case 'settings.save': return this.saveSettings(payload)
      case 'mcp.list': return this.#requireMcp().publicConfig()
      case 'mcp.save': return this.#requireMcp().saveServer(stringOr(payload.name), payload.config ?? payload)
      case 'mcp.delete': return this.#requireMcp().deleteServer(stringOr(payload.name))
      case 'mcp.toggle': return this.#requireMcp().toggleServer(
        stringOr(payload.name),
        payload.enabled !== undefined ? payload.enabled === true : payload.disabled !== true,
      )
      case 'mcp.test': return this.#requireMcp().probeServer(stringOr(payload.name))
      case 'skills.list': return this.listSkills(payload)
      case 'skills.read': return this.readSkill(payload)
      case 'skills.save': return this.saveSkill(payload)
      case 'skills.delete': return this.deleteSkill(payload)
      case 'skills.toggle': return this.toggleBotSkill(payload)
      case 'webhook.list': return { ok: true, webhooks: this.#requireWebhooks().list() }
      case 'webhook.save': return this.#requireWebhooks().save(stringOr(payload.webhookId), payload.draft ?? payload)
      case 'webhook.delete': return this.#requireWebhooks().remove(stringOr(payload.webhookId))
      case 'webhook.test': return this.testWebhook(payload)
      case 'notifications.test': return this.#requireNotifications().test(payload.override ?? null)
      case 'bot.files.read': return this.readBotFiles(payload)
      case 'bot.files.save': return this.saveBotFiles(payload)
      case 'logs.read': return this.readLogs(payload)
      default: throw new Error(`Unknown command "${type}".`)
    }
  }

  #requireMemory() {
    if (!this.memory) throw new Error('Memory Hub is unavailable in this Host.')
    return this.memory
  }

  #requireScreen() {
    if (!this.screen) throw new Error('Virtual Screen bridge is unavailable in this Host.')
    return this.screen
  }

  #requireMcp() {
    if (!this.mcp) throw new Error('Bot MCP Registry is unavailable in this Host.')
    return this.mcp
  }

  #requireWebhooks() {
    if (!this.webhooks) throw new Error('Webhook Manager is unavailable in this Host.')
    return this.webhooks
  }

  #requireNotifications() {
    if (!this.notifications) throw new Error('Notification Hub is unavailable in this Host.')
    return this.notifications
  }

  async listSkills(payload = {}) {
    await this.#refreshBotSkills()
    const botId = stringOr(payload.botId).trim()
    const bot = botId ? this.store.bot(botId) : null
    const hostSkills = this.ctx?.get?.('skills') ?? null
    const list = await discoverBotSkills(this.store, bot, { hostSkills, includeDisabled: true })
    return {
      ok: true,
      botId: bot?.id || '',
      skills: list.map(sk => ({
        name: sk.name,
        description: sk.description,
        source: sk.source,
        tier: sk.tier || 'bot',
        path: sk.path,
        enabled: sk.enabled !== false,
        editable: sk.editable === true,
      })),
    }
  }

  async readSkill(payload = {}) {
    const botId = stringOr(payload.botId).trim()
    const bot = botId ? this.store.bot(botId) : null
    const hostSkills = this.ctx?.get?.('skills') ?? null
    const res = await readBotSkillRaw(this.store, bot, stringOr(payload.name), { hostSkills })
    if (!res.ok) throw new Error(res.error || 'Skill read failed.')
    return res
  }

  async saveSkill(payload = {}) {
    const scope = payload.scope === 'bot' ? 'bot' : 'shared'
    const botId = stringOr(payload.botId).trim()
    const bot = scope === 'bot' ? this.store.bot(botId) : null
    if (scope === 'bot' && !bot) throw new Error('Select a Bot to save a Bot-local skill.')
    if (bot) await this.store.ensureBotDir(bot)
    const res = await saveBotSkillFile(this.store, bot, {
      scope,
      name: stringOr(payload.name),
      content: stringOr(payload.content),
    })
    if (!res.ok) throw new Error(res.error || 'Skill save failed.')
    await this.#refreshBotSkills()
    return res
  }

  async deleteSkill(payload = {}) {
    const scope = payload.scope === 'bot' ? 'bot' : 'shared'
    const botId = stringOr(payload.botId).trim()
    const bot = scope === 'bot' ? this.store.bot(botId) : null
    const res = await deleteBotSkillFile(this.store, bot, {
      scope,
      name: stringOr(payload.name),
    })
    if (!res.ok) throw new Error(res.error || 'Skill delete failed.')
    await this.#refreshBotSkills()
    return res
  }

  async toggleBotSkill(payload = {}) {
    const botId = stringOr(payload.botId).trim()
    const skillName = stringOr(payload.name).trim()
    const enabled = payload.enabled === true
    if (!botId || !skillName) throw new Error('botId and name are required.')
    const bot = this.store.bot(botId)
    if (!bot) throw new Error('Unknown Bot.')
    let disabledSkills = []
    await this.store.mutate((state) => {
      const target = state.bots.find(item => item.id === botId)
      if (!target) return
      const set = new Set(Array.isArray(target.disabledSkills) ? target.disabledSkills : [])
      if (enabled) set.delete(skillName)
      else set.add(skillName)
      target.disabledSkills = [...set].sort()
      target.updatedAt = new Date().toISOString()
      disabledSkills = target.disabledSkills
    })
    await this.#refreshBotSkills()
    return { ok: true, botId, name: skillName, enabled, disabledSkills }
  }

  async testWebhook(payload = {}) {
    const manager = this.#requireWebhooks()
    const webhookId = stringOr(payload.webhookId).trim()
    const hook = manager.get(webhookId)
    if (!hook) throw new Error('Unknown webhook.')
    const body = JSON.stringify({
      event: 'webhook.test',
      message: stringOr(payload.message, 'Test event from DSH Bot Mode Settings'),
      at: new Date().toISOString(),
    })
    return manager.trigger(webhookId, {
      headers: {
        authorization: `Bearer ${hook.secret}`,
        'content-type': 'application/json',
      },
      rawBody: body,
    })
  }

  #currentSystemSettings() {
    const defaults = defaultSettingsState().system
    return normalizeSystemSettings(this.store.state?.settings?.system, defaults)
  }

  #systemEndpoints() {
    const gw = this.screen?.gatewayUrl || 'http://127.0.0.1:6200'
    return {
      hostInfo: `${PREFIX}system`,
      hostAlias: `${PREFIX}host/system`,
      hostConfig: `${PREFIX}system/config`,
      hostPush: `${PREFIX}system/push`,
      hostStream: `${PREFIX}system/stream`,
      gatewayInfo: `${gw}/api/system`,
      gatewayAlias: `${gw}/api/host/system`,
      gatewayConfig: `${gw}/api/system/config`,
      gatewayPush: `${gw}/api/system/push`,
      gatewayStream: `${gw}/api/system/stream`,
    }
  }

  async getSystemInfo({ diskPaths, timeoutMs } = {}) {
    const screen = this.#requireScreen()
    const sysCfg = this.#currentSystemSettings()
    const resolvedPaths = diskPaths
      ? normalizeDiskPaths(diskPaths, sysCfg.diskPaths)
      : sysCfg.diskPaths
    let data = await screen.getSystemInfo({ diskPaths: resolvedPaths, ...(timeoutMs ? { timeoutMs } : {}) })
    if (!data?.available && typeof screen.isLocalGateway === 'function' && screen.isLocalGateway()) {
      const fallback = collectLocalHostSystem(resolvedPaths)
      data = {
        ...fallback,
        gatewayAvailable: false,
        gatewayUrl: screen.gatewayUrl,
        gatewayError: data?.error || 'BotScreen gateway unavailable',
        status: data?.status,
      }
    }
    if (data?.available) {
      this.#systemSnapshot = data
    }
    return {
      system: data,
      config: {
        ...sysCfg,
        effectiveGatewayUrl: screen.gatewayUrl,
        endpoints: this.#systemEndpoints(),
      },
    }
  }

  async getSystemConfig() {
    const sysCfg = this.#currentSystemSettings()
    let gatewayConfig = null
    let gatewayError = ''
    if (this.screen) {
      try {
        const res = await this.screen.getSystemConfig()
        gatewayConfig = res?.config || res || null
      } catch (error) {
        gatewayError = error instanceof Error ? error.message : String(error)
      }
    }
    return {
      config: {
        ...sysCfg,
        effectiveGatewayUrl: this.screen?.gatewayUrl || 'http://127.0.0.1:6200',
        endpoints: this.#systemEndpoints(),
      },
      gatewayConfig,
      gatewayError,
    }
  }

  async saveSystemConfig(payload = {}) {
    const rawPatch = payload?.config && typeof payload.config === 'object'
      ? payload.config
      : (payload?.system && typeof payload.system === 'object' ? payload.system : payload)

    const validateOptUrl = (val, label) => {
      if (val === undefined) return
      const s = String(val ?? '').trim()
      if (s !== '' && !/^https?:\/\//i.test(s)) {
        throw new Error(`${label} must start with http:// or https://`)
      }
    }
    validateOptUrl(rawPatch.gatewayUrl, 'gatewayUrl')
    validateOptUrl(rawPatch.pushUrl ?? rawPatch.push_url, 'pushUrl')

    const mappedPatch = {
      ...(rawPatch.enabled !== undefined ? { enabled: rawPatch.enabled === true } : {}),
      ...(rawPatch.gatewayUrl !== undefined ? { gatewayUrl: String(rawPatch.gatewayUrl ?? '').trim() } : {}),
      ...(rawPatch.adminToken !== undefined ? { adminToken: String(rawPatch.adminToken ?? '').trim() } : {}),
      ...(rawPatch.diskPaths !== undefined ? { diskPaths: rawPatch.diskPaths } : {}),
      ...(rawPatch.disk_paths !== undefined ? { diskPaths: rawPatch.disk_paths } : {}),
      ...(rawPatch.diskPath !== undefined ? { diskPath: rawPatch.diskPath } : {}),
      ...(rawPatch.disk_path !== undefined ? { diskPath: rawPatch.disk_path } : {}),
      ...(rawPatch.refreshIntervalSec !== undefined ? { refreshIntervalSec: rawPatch.refreshIntervalSec } : {}),
      ...(rawPatch.stream_interval_sec !== undefined ? { refreshIntervalSec: rawPatch.stream_interval_sec } : {}),
      ...(rawPatch.pushUrl !== undefined ? { pushUrl: String(rawPatch.pushUrl ?? '').trim() } : {}),
      ...(rawPatch.push_url !== undefined ? { pushUrl: String(rawPatch.push_url ?? '').trim() } : {}),
      ...(rawPatch.pushIntervalSec !== undefined ? { pushIntervalSec: rawPatch.pushIntervalSec } : {}),
      ...(rawPatch.push_interval_sec !== undefined ? { pushIntervalSec: rawPatch.push_interval_sec } : {}),
      ...(rawPatch.pushToken !== undefined ? { pushToken: String(rawPatch.pushToken ?? '').trim() } : {}),
      ...(rawPatch.push_token !== undefined ? { pushToken: String(rawPatch.push_token ?? '').trim() } : {}),
    }

    let updated
    await this.store.mutate((state) => {
      state.settings = state.settings ?? defaultSettingsState()
      const current = normalizeSystemSettings(state.settings.system, defaultSettingsState().system)
      updated = normalizeSystemSettings(mappedPatch, current)
      state.settings.system = updated
    })

    let gatewaySynced = false
    let gatewayConfig = null
    let gatewayError = ''
    if (this.screen) {
      this.screen.configure({
        gatewayUrl: updated.gatewayUrl,
        adminToken: updated.adminToken,
      })
      try {
        const synced = await this.screen.updateSystemConfig({
          enabled: updated.enabled,
          diskPaths: updated.diskPaths,
          refreshIntervalSec: updated.refreshIntervalSec,
          pushUrl: updated.pushUrl,
          pushIntervalSec: updated.pushIntervalSec,
          pushToken: updated.pushToken,
        })
        gatewaySynced = true
        gatewayConfig = synced?.config || synced || null
      } catch (error) {
        gatewayError = error instanceof Error ? error.message : String(error)
      }
    }

    return {
      config: {
        ...updated,
        effectiveGatewayUrl: this.screen?.gatewayUrl || 'http://127.0.0.1:6200',
        endpoints: this.#systemEndpoints(),
      },
      gatewaySynced,
      gatewayConfig,
      gatewayError,
    }
  }

  async pushSystemInfo(payload = {}) {
    const screen = this.#requireScreen()
    const sysCfg = this.#currentSystemSettings()
    const url = typeof payload?.url === 'string' && payload.url.trim() !== ''
      ? payload.url.trim()
      : sysCfg.pushUrl
    const token = typeof payload?.token === 'string' && payload.token.trim() !== ''
      ? payload.token.trim()
      : sysCfg.pushToken
    const diskPaths = payload?.diskPaths ?? payload?.disk_paths ?? payload?.diskPath ?? payload?.disk_path ?? sysCfg.diskPaths
    const normalizedPaths = normalizeDiskPaths(diskPaths, sysCfg.diskPaths)
    return screen.pushSystemInfo({ url, token, diskPaths: normalizedPaths })
  }

  // ---- Agent Reply Artifact gateway transport -----------------------------

  #allowedRootsForArtifact({ botId = '', roomId = '' } = {}) {
    const roots = []
    if (roomId) {
      const room = this.store.room(roomId)
      if (room?.workDir) roots.push(room.workDir)
    }
    if (botId) {
      const bot = this.store.bot(botId)
      if (bot?.dir) roots.push(bot.dir)
    }
    for (const room of this.store.state.rooms ?? []) {
      if (room?.workDir && !roots.includes(room.workDir)) roots.push(room.workDir)
    }
    for (const bot of this.store.state.bots ?? []) {
      if (bot?.dir && !roots.includes(bot.dir)) roots.push(bot.dir)
    }
    return roots
  }

  async #recordArtifactMeta(entry) {
    if (!entry || !entry.id) return
    await this.store.mutate((state) => {
      state.artifacts = Array.isArray(state.artifacts) ? state.artifacts : []
      const idx = state.artifacts.findIndex(item => item && item.id === entry.id)
      const prev = idx >= 0 ? state.artifacts[idx] : {}
      const merged = {
        ...prev,
        ...entry,
        id: entry.id,
        artifactId: entry.id,
        at: entry.at || prev.at || new Date().toISOString(),
      }
      if (idx >= 0) state.artifacts[idx] = merged
      else state.artifacts.push(merged)
      if (state.artifacts.length > 200) {
        state.artifacts = state.artifacts.slice(-200)
      }
    }).catch(() => undefined)
  }

  async #resolveLocalArtifact(artifactId, hintBotId = '') {
    const state = this.store.state
    // 1. Check `<artifact>` blocks in room transcripts
    for (const room of state.rooms ?? []) {
      for (const msg of (room.transcript ?? []).slice(-100)) {
        if (typeof msg.text !== 'string' || !msg.text.includes('<artifact')) continue
        const extracted = extractXmlArtifacts(msg.text, {
          botId: msg.from || hintBotId || '',
          botName: msg.name || '',
          roomId: room.id,
          roomName: room.name,
          messageId: msg.id || '',
          at: msg.at || '',
        })
        const match = extracted.find(item => item.id === artifactId)
        if (match) {
          return {
            ...match,
            buffer: Buffer.from(match.content, 'utf8'),
          }
        }
      }
      // 2. Check completion deliverables for this room
      if (room.completion && Array.isArray(room.completion.deliverables)) {
        for (const filePath of room.completion.deliverables) {
          const aid = makeDeliverableArtifactId(room.id, filePath)
          if (aid !== artifactId && `deliv:${room.id}:${filePath}` !== artifactId) continue
          const botId = room.completion.finishedBy || hintBotId || room.memberIds?.[0] || ''
          const roots = this.#allowedRootsForArtifact({ botId, roomId: room.id })
          const resolved = await resolveSafeWorkspaceFile(filePath, roots)
          if (!resolved) {
            const err = new Error(`Deliverable file not found or outside workspace: ${filePath}`)
            err.status = 404
            throw err
          }
          const buffer = await readFile(resolved.path)
          const filename = sanitizeArtifactFilename(resolved.path, filePath, 'file')
          return {
            id: aid,
            artifactId: aid,
            kind: 'deliverable',
            title: filePath,
            type: 'file',
            filename,
            mimeType: inferArtifactMimeType(filename, 'file'),
            size: buffer.byteLength,
            sourcePath: resolved.path,
            roomId: room.id,
            roomName: room.name,
            botId,
            botName: room.completion.finishedByName || '',
            at: room.completion.at || room.updatedAt || new Date().toISOString(),
            buffer,
          }
        }
      }
    }

    // 3. Check persisted state.artifacts with a workspace sourcePath
    const stored = (state.artifacts ?? []).find(item => item && item.id === artifactId)
    if (stored?.sourcePath) {
      const roots = this.#allowedRootsForArtifact({ botId: stored.botId || hintBotId, roomId: stored.roomId })
      const resolved = await resolveSafeWorkspaceFile(stored.sourcePath, roots)
      if (resolved) {
        const buffer = await readFile(resolved.path)
        const filename = sanitizeArtifactFilename(stored.filename || resolved.path, stored.title, stored.type)
        return {
          ...stored,
          filename,
          mimeType: stored.mimeType || inferArtifactMimeType(filename, stored.type),
          size: buffer.byteLength,
          buffer,
        }
      }
    }
    return null
  }

  async listArtifacts({ botId = '', roomId = '', kind = '', limit = 100 } = {}) {
    const byId = new Map()
    for (const item of this.#artifactsSummary(this.store.state)) {
      byId.set(item.id, item)
    }

    let gatewayAvailable = false
    let gatewayError = ''
    if (this.screen) {
      try {
        const res = await this.screen.listArtifacts({ botId, roomId, kind, limit })
        gatewayAvailable = true
        for (const gwItem of res?.artifacts ?? []) {
          if (!gwItem || !gwItem.artifact_id) continue
          const aid = gwItem.artifact_id
          const bid = gwItem.bot_id || ''
          const bot = bid ? this.store.bot(bid) : null
          const urls = this.#artifactDownloadUrls(aid, bid)
          const existing = byId.get(aid) || {}
          byId.set(aid, {
            ...existing,
            id: aid,
            artifactId: aid,
            kind: gwItem.kind || existing.kind || 'artifact',
            title: gwItem.title || existing.title || gwItem.filename || aid,
            type: gwItem.artifact_type || existing.type || 'file',
            filename: gwItem.filename || existing.filename || '',
            mimeType: gwItem.mime_type || existing.mimeType || 'application/octet-stream',
            size: Number.isFinite(Number(gwItem.size)) ? Number(gwItem.size) : (existing.size || 0),
            sha256: gwItem.sha256 || existing.sha256 || '',
            botId: bid || existing.botId || '',
            botName: bot?.name || existing.botName || '',
            roomId: gwItem.room_id || existing.roomId || '',
            roomName: gwItem.room_name || existing.roomName || '',
            messageId: gwItem.message_id || existing.messageId || '',
            sourcePath: gwItem.source_path || existing.sourcePath || '',
            preview: gwItem.preview || existing.preview || '',
            gatewaySynced: true,
            at: existing.at || (gwItem.updated_at ? new Date(gwItem.updated_at * 1000).toISOString() : new Date().toISOString()),
            ...urls,
          })
        }
      } catch (error) {
        gatewayError = error instanceof Error ? error.message : String(error)
      }
    }

    let items = [...byId.values()]
    if (botId) items = items.filter(item => item.botId === botId)
    if (roomId) items = items.filter(item => item.roomId === roomId)
    if (kind) items = items.filter(item => item.kind === kind)
    items.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))
    const sliced = items.slice(0, clampInt(limit, 1, 500, 100))

    return {
      total: sliced.length,
      artifacts: sliced,
      gatewayAvailable,
      gatewayError,
      endpoints: this.#artifactEndpoints(),
    }
  }

  async publishArtifact(payload = {}) {
    const rawBotId = stringOr(payload.botId || payload.bot_id).trim()
    const bot = rawBotId ? this.store.bot(rawBotId) : this.store.state.bots[0]
    const targetBotId = rawBotId || bot?.id || 'default'
    if (targetBotId.includes('/') || targetBotId.includes('..')) {
      throw new Error('Invalid botId.')
    }
    const roomId = stringOr(payload.roomId || payload.room_id).trim()
    const room = roomId ? this.store.room(roomId) : null
    const rawId = stringOr(payload.artifactId || payload.artifact_id || payload.id).trim()
    if (rawId && !isValidArtifactId(rawId)) {
      throw new Error('Invalid artifactId: only [A-Za-z0-9._-] up to 96 chars allowed.')
    }

    let buffer = Buffer.isBuffer(payload.buffer)
      ? payload.buffer
      : (payload.buffer instanceof Uint8Array ? Buffer.from(payload.buffer) : null)
    let sourcePath = stringOr(payload.sourcePath || payload.source_path || payload.filePath || payload.file_path).trim()
    const kind = stringOr(payload.kind).trim() || (sourcePath ? 'deliverable' : 'artifact')
    const type = stringOr(payload.type || payload.artifactType || payload.artifact_type).trim() || (sourcePath ? 'file' : 'text')
    let title = stringOr(payload.title).trim()
    let filename = stringOr(payload.filename || payload.name).trim()
    let encoding = stringOr(payload.encoding).trim() || 'utf-8'

    if (!buffer && sourcePath) {
      const roots = this.#allowedRootsForArtifact({ botId: targetBotId, roomId })
      const resolved = await resolveSafeWorkspaceFile(sourcePath, roots)
      if (!resolved) {
        const err = new Error(`File not found or outside allowed Bot/Room workspace: ${sourcePath}`)
        err.status = 404
        throw err
      }
      buffer = await readFile(resolved.path)
      sourcePath = resolved.path
      if (!filename) filename = sanitizeArtifactFilename(resolved.path, title, type)
      if (!title) title = filename
    }

    let contentStr
    if (!buffer) {
      if (payload.content === undefined || payload.content === null) {
        throw new Error('Provide either content, buffer, or a workspace sourcePath/filePath.')
      }
      contentStr = typeof payload.content === 'string'
        ? payload.content
        : JSON.stringify(payload.content, null, 2)
      if (encoding.toLowerCase() === 'base64' || encoding.toLowerCase() === 'b64') {
        buffer = Buffer.from(contentStr, 'base64')
      } else {
        buffer = Buffer.from(contentStr, 'utf8')
      }
    }
    if (buffer.byteLength > MAX_ARTIFACT_BYTES) {
      const err = new Error(`Artifact exceeds max size (${MAX_ARTIFACT_BYTES} bytes).`)
      err.status = 413
      throw err
    }

    filename = sanitizeArtifactFilename(filename, title, type)
    if (!title) title = filename
    const mimeType = inferArtifactMimeType(filename, type, stringOr(payload.mimeType || payload.mime_type))
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const artifactId = rawId || newId('art')
    const now = new Date().toISOString()

    let gatewaySynced = false
    let gatewayError = ''
    let gwRecord = null
    if (this.screen) {
      try {
        const res = await this.screen.publishArtifact(targetBotId, {
          artifactId,
          title,
          filename,
          kind,
          type,
          mimeType,
          buffer,
          roomId,
          roomName: stringOr(payload.roomName || payload.room_name).trim() || room?.name || '',
          messageId: stringOr(payload.messageId || payload.message_id).trim(),
          sourcePath,
          metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
        })
        gwRecord = res?.artifact || null
        gatewaySynced = Boolean(gwRecord)
      } catch (error) {
        gatewayError = error instanceof Error ? error.message : String(error)
      }
    } else {
      gatewayError = 'Screen bridge unavailable'
    }

    const preview = (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('svg'))
      ? buffer.subarray(0, 2048).toString('utf8').trim().slice(0, 400)
      : ''

    const finalId = gwRecord?.artifact_id || artifactId
    const urls = this.#artifactDownloadUrls(finalId, targetBotId)
    const record = {
      id: finalId,
      artifactId: finalId,
      kind: gwRecord?.kind || kind,
      title: gwRecord?.title || title,
      type: gwRecord?.artifact_type || type,
      filename: gwRecord?.filename || filename,
      mimeType: gwRecord?.mime_type || mimeType,
      size: gwRecord?.size ?? buffer.byteLength,
      sha256: gwRecord?.sha256 || sha256,
      botId: targetBotId,
      botName: bot?.name || '',
      roomId,
      roomName: stringOr(payload.roomName || payload.room_name).trim() || room?.name || '',
      messageId: stringOr(payload.messageId || payload.message_id).trim(),
      sourcePath,
      preview: gwRecord?.preview ?? preview,
      gatewaySynced,
      at: now,
      ...urls,
    }
    await this.#recordArtifactMeta(record)
    return {
      artifact: record,
      gatewaySynced,
      gatewayError,
      endpoints: this.#artifactEndpoints(),
    }
  }

  async #ensureArtifactOnGateway(artifactId, botId = '') {
    const local = await this.#resolveLocalArtifact(artifactId, botId)
    if (!local) return null
    const targetBotId = local.botId || botId || this.store.state.bots[0]?.id || 'default'
    if (this.screen) {
      try {
        await this.screen.publishArtifact(targetBotId, {
          artifactId: local.id,
          title: local.title,
          filename: local.filename,
          kind: local.kind,
          type: local.type,
          mimeType: local.mimeType,
          buffer: local.buffer,
          roomId: local.roomId || '',
          roomName: local.roomName || '',
          messageId: local.messageId || '',
          sourcePath: local.sourcePath || '',
        })
        await this.#recordArtifactMeta({
          id: local.id,
          kind: local.kind,
          title: local.title,
          type: local.type,
          filename: local.filename,
          mimeType: local.mimeType,
          size: local.size,
          botId: targetBotId,
          botName: local.botName || '',
          roomId: local.roomId || '',
          roomName: local.roomName || '',
          messageId: local.messageId || '',
          sourcePath: local.sourcePath || '',
          preview: local.preview || '',
          gatewaySynced: true,
          at: local.at,
        })
        return { ...local, botId: targetBotId, synced: true }
      } catch (_error) {
        return { ...local, botId: targetBotId, synced: false }
      }
    }
    return { ...local, botId: targetBotId, synced: false }
  }

  async #streamArtifactDownload({ artifactId, botId = '', inline = false, filename = '' }, res, signal) {
    let upstream = null
    if (this.screen) {
      try {
        upstream = await this.screen.openArtifactDownloadStream(artifactId, { botId, inline, filename, signal })
      } catch (error) {
        if (error?.status === 404) {
          const synced = await this.#ensureArtifactOnGateway(artifactId, botId)
          if (synced?.synced) {
            upstream = await this.screen.openArtifactDownloadStream(synced.id, {
              botId: synced.botId,
              inline,
              filename,
              signal,
            })
          } else if (synced?.buffer) {
            const dlName = filename ? sanitizeArtifactFilename(filename) : synced.filename
            res.statusCode = 200
            res.setHeader('content-type', synced.mimeType || 'application/octet-stream')
            res.setHeader('content-disposition', buildContentDisposition(dlName, inline))
            res.setHeader('content-length', String(synced.buffer.byteLength))
            res.setHeader('x-content-type-options', 'nosniff')
            res.setHeader('x-artifact-id', synced.id)
            res.setHeader('x-bot-id', synced.botId || '')
            res.setHeader('x-artifact-sha256', createHash('sha256').update(synced.buffer).digest('hex'))
            res.setHeader('x-artifact-source', 'host-fallback')
            res.end(synced.buffer)
            return
          } else {
            const notFound = new Error(`Artifact not found: ${artifactId}`)
            notFound.status = 404
            throw notFound
          }
        } else {
          // Gateway unreachable: try local fallback before failing
          const local = await this.#resolveLocalArtifact(artifactId, botId).catch(() => null)
          if (local?.buffer) {
            const dlName = filename ? sanitizeArtifactFilename(filename) : local.filename
            res.statusCode = 200
            res.setHeader('content-type', local.mimeType || 'application/octet-stream')
            res.setHeader('content-disposition', buildContentDisposition(dlName, inline))
            res.setHeader('content-length', String(local.buffer.byteLength))
            res.setHeader('x-content-type-options', 'nosniff')
            res.setHeader('x-artifact-id', local.id)
            res.setHeader('x-bot-id', local.botId || '')
            res.setHeader('x-artifact-sha256', createHash('sha256').update(local.buffer).digest('hex'))
            res.setHeader('x-artifact-source', 'host-fallback')
            res.end(local.buffer)
            return
          }
          throw error
        }
      }
    } else {
      const local = await this.#resolveLocalArtifact(artifactId, botId)
      if (!local?.buffer) {
        const err = new Error(`Artifact not found: ${artifactId}`)
        err.status = 404
        throw err
      }
      const dlName = filename ? sanitizeArtifactFilename(filename) : local.filename
      res.statusCode = 200
      res.setHeader('content-type', local.mimeType || 'application/octet-stream')
      res.setHeader('content-disposition', buildContentDisposition(dlName, inline))
      res.setHeader('content-length', String(local.buffer.byteLength))
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('x-artifact-id', local.id)
      res.setHeader('x-bot-id', local.botId || '')
      res.setHeader('x-artifact-sha256', createHash('sha256').update(local.buffer).digest('hex'))
      res.setHeader('x-artifact-source', 'host-fallback')
      res.end(local.buffer)
      return
    }

    res.statusCode = 200
    const passHeaders = [
      'content-type',
      'content-disposition',
      'content-length',
      'etag',
      'last-modified',
      'x-artifact-id',
      'x-bot-id',
      'x-artifact-sha256',
      'x-artifact-kind',
      'x-artifact-type',
      'x-artifact-source',
    ]
    for (const hName of passHeaders) {
      const val = upstream.headers.get(hName)
      if (val) res.setHeader(hName, val)
    }
    res.setHeader('x-content-type-options', 'nosniff')
    res.flushHeaders?.()
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (signal?.aborted || res.writableEnded) break
        res.write(Buffer.from(chunk))
      }
      if (!res.writableEnded) res.end()
    } else {
      res.end(Buffer.from(await upstream.arrayBuffer()))
    }
  }

  async #streamArtifactsBundle(payload = {}, res, signal) {
    const screen = this.#requireScreen()
    const rawIds = Array.isArray(payload.ids)
      ? payload.ids
      : (Array.isArray(payload.artifactIds) ? payload.artifactIds : (Array.isArray(payload.artifact_ids) ? payload.artifact_ids : []))
    const botId = stringOr(payload.botId || payload.bot_id).trim()
    const roomId = stringOr(payload.roomId || payload.room_id).trim()
    const filename = stringOr(payload.filename).trim() || 'agent-artifacts.zip'

    // Lazily ensure local reply artifacts / deliverables exist on gateway before bundling
    const idsToSync = rawIds.length > 0
      ? rawIds.map(v => String(v ?? '').trim()).filter(Boolean)
      : this.#artifactsSummary(this.store.state)
        .filter(item => (!botId || item.botId === botId) && (!roomId || item.roomId === roomId))
        .map(item => item.id)

    for (const aid of idsToSync.slice(0, 60)) {
      await this.#ensureArtifactOnGateway(aid, botId).catch(() => undefined)
    }

    const upstream = await screen.openArtifactsBundleStream({
      artifactIds: rawIds.map(v => String(v ?? '').trim()).filter(Boolean),
      botId,
      roomId,
      filename,
      signal,
    })
    res.statusCode = 200
    for (const hName of ['content-type', 'content-disposition', 'content-length', 'x-artifact-count', 'x-artifact-source']) {
      const val = upstream.headers.get(hName)
      if (val) res.setHeader(hName, val)
    }
    res.setHeader('x-content-type-options', 'nosniff')
    res.flushHeaders?.()
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (signal?.aborted || res.writableEnded) break
        res.write(Buffer.from(chunk))
      }
      if (!res.writableEnded) res.end()
    } else {
      res.end(Buffer.from(await upstream.arrayBuffer()))
    }
  }

  async downloadArtifact({ artifactId, botId = '', inline = false, filename = '' } = {}) {
    if (!artifactId) throw new Error('artifactId is required.')
    if (this.screen) {
      try {
        return await this.screen.downloadArtifact(artifactId, { botId, inline, filename })
      } catch (error) {
        if (error?.status === 404) {
          const synced = await this.#ensureArtifactOnGateway(artifactId, botId)
          if (synced?.synced) {
            return this.screen.downloadArtifact(synced.id, { botId: synced.botId, inline, filename })
          }
          if (synced?.buffer) {
            return {
              buffer: synced.buffer,
              mimeType: synced.mimeType,
              filename: filename || synced.filename,
              artifactId: synced.id,
              botId: synced.botId || '',
              sha256: createHash('sha256').update(synced.buffer).digest('hex'),
              size: synced.buffer.byteLength,
              source: 'host-fallback',
            }
          }
        }
        throw error
      }
    }
    const local = await this.#resolveLocalArtifact(artifactId, botId)
    if (!local?.buffer) throw new Error(`Artifact not found: ${artifactId}`)
    return {
      buffer: local.buffer,
      mimeType: local.mimeType,
      filename: filename || local.filename,
      artifactId: local.id,
      botId: local.botId || '',
      sha256: createHash('sha256').update(local.buffer).digest('hex'),
      size: local.buffer.byteLength,
      source: 'host-fallback',
    }
  }

  async deleteArtifact({ artifactId, botId = '' } = {}) {
    if (!artifactId) throw new Error('artifactId is required.')
    let gatewayDeleted = false
    if (this.screen) {
      try {
        const res = await this.screen.deleteArtifact(artifactId, { botId })
        gatewayDeleted = Boolean(res?.deleted)
      } catch (_error) {
        gatewayDeleted = false
      }
    }
    let stateRemoved = false
    await this.store.mutate((state) => {
      if (!Array.isArray(state.artifacts)) return
      const before = state.artifacts.length
      state.artifacts = state.artifacts.filter(item => item && item.id !== artifactId)
      stateRemoved = state.artifacts.length !== before
    })
    return {
      artifactId,
      botId,
      deleted: gatewayDeleted || stateRemoved,
      gatewayDeleted,
      stateRemoved,
    }
  }

  async syncReplyArtifacts({ bot, text, roomId = '', messageId = '', at = '' } = {}) {
    if (!bot || typeof text !== 'string' || !text.includes('<artifact')) return []
    const room = roomId ? this.store.room(roomId) : null
    const extracted = extractXmlArtifacts(text, {
      botId: bot.id,
      botName: bot.name,
      roomId,
      roomName: room?.name || '',
      messageId,
      at: at || new Date().toISOString(),
    })
    const results = []
    for (const item of extracted) {
      try {
        const res = await this.publishArtifact({
          botId: bot.id,
          artifactId: item.id,
          title: item.title,
          filename: item.filename,
          kind: 'artifact',
          type: item.type,
          mimeType: item.mimeType,
          content: item.content,
          roomId,
          roomName: room?.name || '',
          messageId,
        })
        results.push(res.artifact)
      } catch (_error) {
        // non-blocking best-effort sync
      }
    }
    return results
  }

  async syncDeliverables({ room, bot, deliverables = [], messageId = '', at = '' } = {}) {
    if (!room || !Array.isArray(deliverables) || deliverables.length === 0) return []
    const results = []
    for (const filePath of deliverables) {
      const aid = makeDeliverableArtifactId(room.id, filePath)
      try {
        const res = await this.publishArtifact({
          botId: bot?.id || room.completion?.finishedBy || room.memberIds?.[0] || 'default',
          artifactId: aid,
          title: filePath,
          kind: 'deliverable',
          type: 'file',
          sourcePath: filePath,
          roomId: room.id,
          roomName: room.name,
          messageId,
        })
        results.push(res.artifact)
      } catch (_error) {
        // Deliverable may be conceptual or not on disk yet; keep metadata without failing room finish
      }
    }
    return results
  }

  async searchBotMemory(payload) {
    const memory = this.#requireMemory()
    const botId = stringOr(payload.botId)
    const bot = botId ? this.store.bot(botId) : this.store.state.bots[0]
    if (!bot) throw new Error('Select a Bot first.')
    const query = stringOr(payload.query).trim()
    if (query === '') throw new Error('Write a search query first.')
    return memory.searchMemoryForBot(bot, {
      query,
      limit: Number(payload.limit) || 8,
      typeFilter: stringOr(payload.typeFilter),
    })
  }

  async saveSettings(payload) {
    const patch = payload?.settings && typeof payload.settings === 'object' ? payload.settings : payload
    const rf = patch?.responseFormat && typeof patch.responseFormat === 'object' ? patch.responseFormat : null
    const gc = patch?.groupChat && typeof patch.groupChat === 'object' ? patch.groupChat : null
    const sys = patch?.system && typeof patch.system === 'object' ? patch.system : null
    let updated
    await this.store.mutate((state) => {
      state.settings = state.settings ?? defaultSettingsState()
      if (rf) {
        state.settings.responseFormat = {
          ...state.settings.responseFormat,
          ...(rf.enabled !== undefined ? { enabled: rf.enabled === true } : {}),
          ...(rf.extendedMarkdown !== undefined ? { extendedMarkdown: rf.extendedMarkdown === true } : {}),
          ...(rf.diagramsAndMath !== undefined ? { diagramsAndMath: rf.diagramsAndMath === true } : {}),
          ...(rf.artifacts !== undefined ? { artifacts: rf.artifacts === true } : {}),
          ...(rf.structuredCards !== undefined ? { structuredCards: rf.structuredCards === true } : {}),
          ...(rf.multimodal !== undefined ? { multimodal: rf.multimodal === true } : {}),
        }
      }
      if (gc) {
        state.settings.groupChat = {
          ...state.settings.groupChat,
          ...(gc.defaultTokenLimit !== undefined
            ? { defaultTokenLimit: clampInt(gc.defaultTokenLimit, 0, 1_000_000_000, 0) }
            : {}),
          ...(gc.defaultIdleRoundLimit !== undefined
            ? { defaultIdleRoundLimit: clampInt(gc.defaultIdleRoundLimit, 1, 100, 5) }
            : {}),
          ...(gc.enableSoftLock !== undefined ? { enableSoftLock: gc.enableSoftLock === true } : {}),
          ...(gc.enableErrorProbe !== undefined ? { enableErrorProbe: gc.enableErrorProbe === true } : {}),
          ...(gc.autoProgressReview !== undefined ? { autoProgressReview: gc.autoProgressReview === true } : {}),
          ...(gc.showActivityStrip !== undefined ? { showActivityStrip: gc.showActivityStrip === true } : {}),
        }
      }
      if (sys) {
        const currentSys = normalizeSystemSettings(state.settings.system, defaultSettingsState().system)
        state.settings.system = normalizeSystemSettings(sys, currentSys)
      }
      if (patch.routines && typeof patch.routines === 'object') {
        state.settings.routines = normalizeRoutineSettings({
          ...state.settings.routines,
          ...patch.routines,
        })
      }
      if (patch.governance && typeof patch.governance === 'object') {
        const gov = patch.governance
        const curGov = state.settings.governance ?? defaultSettingsState().governance
        state.settings.governance = {
          requireApprovalForBotCrud: gov.requireApprovalForBotCrud !== undefined
            ? gov.requireApprovalForBotCrud === true
            : curGov.requireApprovalForBotCrud !== false,
          defaultDailyTokenLimit: gov.defaultDailyTokenLimit !== undefined
            ? clampInt(gov.defaultDailyTokenLimit, 0, 1_000_000_000, 0)
            : (Number(curGov.defaultDailyTokenLimit) || 0),
          protectExternalWrites: gov.protectExternalWrites !== undefined
            ? gov.protectExternalWrites === true
            : curGov.protectExternalWrites === true,
        }
      }
      if (patch.notifications && typeof patch.notifications === 'object') {
        state.settings.notifications = normalizeNotificationsSettings(
          patch.notifications,
          state.settings.notifications ?? defaultSettingsState().notifications,
        )
      }
      updated = state.settings
    })
    if (sys && this.screen && updated?.system) {
      this.screen.configure({
        gatewayUrl: updated.system.gatewayUrl,
        adminToken: updated.system.adminToken,
      })
      void this.screen.updateSystemConfig(updated.system).catch(() => undefined)
    }
    return { settings: updated }
  }

  async readBotFiles(payload) {
    const botId = stringOr(payload.botId)
    const bot = this.store.bot(botId)
    if (!bot) throw new Error('Unknown Bot.')
    await this.store.ensureBotDir(bot)
    const [soul, memoryMd] = await Promise.all([
      readTextFile(join(bot.dir, 'SOUL.md'), ''),
      readTextFile(join(bot.dir, 'MEMORY.md'), ''),
    ])
    return { botId: bot.id, dir: bot.dir, soul, memoryMd }
  }

  async saveBotFiles(payload) {
    const botId = stringOr(payload.botId)
    const bot = this.store.bot(botId)
    if (!bot) throw new Error('Unknown Bot.')
    await this.store.ensureBotDir(bot)
    if (typeof payload.soul === 'string') {
      await writeTextFile(join(bot.dir, 'SOUL.md'), payload.soul)
    }
    if (typeof payload.memoryMd === 'string') {
      await writeTextFile(join(bot.dir, 'MEMORY.md'), payload.memoryMd)
    }
    if (typeof payload.instructions === 'string') {
      await this.store.mutate((state) => {
        const stored = state.bots.find(item => item.id === bot.id)
        if (stored) {
          stored.instructions = payload.instructions
          stored.updatedAt = new Date().toISOString()
        }
      })
    }
    return { ok: true, botId: bot.id }
  }

  async readLogs(payload) {
    const limit = clampInt(payload?.limit, 10, 200, 60)
    const roomId = stringOr(payload?.roomId)
    const rooms = roomId
      ? [this.store.room(roomId)].filter(Boolean)
      : (this.store.state.rooms ?? [])
    const entries = []
    for (const room of rooms) {
      for (const act of (room.activity ?? []).slice(-limit)) {
        entries.push({
          roomId: room.id,
          roomName: room.name,
          ...act,
        })
      }
    }
    entries.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))
    return { entries: entries.slice(0, limit) }
  }

  async saveBot(payload) {
    const draft = payload?.draft ?? {}
    const name = stringOr(draft.name).trim()
    if (name === '') throw new Error('Give the Bot a name.')
    const botId = stringOr(payload.botId)
    const existing = botId === '' ? undefined : this.store.bot(botId)
    if (botId !== '' && !existing) throw new Error('Unknown Bot.')
    // All Bots stay flat under the single General (常规) section.
    const sectionId = 'general'
    const model = {
      provider: stringOr(draft?.model?.provider, existing?.model?.provider ?? '').trim(),
      model: stringOr(draft?.model?.model, existing?.model?.model ?? '').trim(),
      reasoningEffort: stringOr(draft?.model?.reasoningEffort, existing?.model?.reasoningEffort ?? '').trim(),
    }
    if ((model.provider === '') !== (model.model === '')) {
      throw new Error('Choose both a provider and a model, or leave both empty for the DSH default.')
    }
    const tools = {
      allow: Array.isArray(draft?.tools?.allow)
        ? [...new Set(draft.tools.allow.filter(item => typeof item === 'string' && item !== ''))]
        : (existing?.tools.allow ?? []),
      deny: Array.isArray(draft?.tools?.deny)
        ? [...new Set(draft.tools.deny.filter(item => typeof item === 'string' && item !== ''))]
        : (existing?.tools.deny ?? []),
    }

    let created
    await this.store.mutate((state) => {
      const now = new Date().toISOString()
      if (existing) {
        if (state.bots.some(bot => bot.id !== existing.id && bot.name.toLowerCase() === name.toLowerCase())) {
          throw new Error(`A Bot named "${name}" already exists.`)
        }
        const prevColor = existing.color
        const prevAvatar = existing.avatar && typeof existing.avatar === 'object'
          ? existing.avatar
          : deterministicAvatar(existing.id, prevColor)
        existing.name = name
        existing.role = stringOr(draft.role, existing.role)
        existing.instructions = stringOr(draft.instructions, existing.instructions)
        const nextColorInput = typeof draft.color === 'string' && draft.color.trim() !== ''
          ? draft.color.trim()
          : existing.color
        if (draft.avatarRandom === true || draft?.avatar?.mode === 'random' || draft?.avatar?.random === true) {
          const picked = randomAvatar({
            existingBots: state.bots.filter(item => item.id !== existing.id),
          })
          existing.avatar = picked
          existing.color = picked.color
        } else if (hasExplicitAvatar(draft.avatar)) {
          const fallbackForEdit = {
            ...prevAvatar,
            ...(normalizeHex(nextColorInput) ? { color: normalizeHex(nextColorInput) } : {}),
          }
          existing.avatar = normalizeAvatar(draft.avatar, { fallback: fallbackForEdit, strict: true })
          existing.color = existing.avatar.color
        } else {
          existing.color = nextColorInput
          if (nextColorInput !== prevColor && normalizeHex(nextColorInput)) {
            existing.avatar = normalizeAvatar(
              { ...prevAvatar, color: nextColorInput },
              { fallback: prevAvatar, strict: false },
            )
          } else {
            existing.avatar = prevAvatar
          }
        }
        existing.sectionId = sectionId
        if (typeof draft.hidden === 'boolean') existing.hidden = draft.hidden
        if (typeof draft.pinned === 'boolean') existing.pinned = draft.pinned
        existing.order = Number.isFinite(draft.order) ? draft.order : existing.order
        existing.model = model
        existing.tools = tools
        existing.approvalPolicy = APPROVAL_POLICIES.includes(draft.approvalPolicy)
          ? draft.approvalPolicy
          : existing.approvalPolicy
        if (draft.permissionRole === 'admin' || draft.permissionRole === 'worker') {
          existing.permissionRole = draft.permissionRole
        }
        if (draft.dailyTokenLimit !== undefined) {
          existing.dailyTokenLimit = clampInt(draft.dailyTokenLimit, 0, 1_000_000_000, 0)
        }
        if (Array.isArray(draft.disabledSkills)) {
          existing.disabledSkills = [...new Set(draft.disabledSkills.filter(s => typeof s === 'string' && s.trim() !== '').map(s => s.trim()))].sort()
        }
        existing.updatedAt = now
        return
      }
      if (state.bots.some(bot => bot.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A Bot named "${name}" already exists.`)
      }
      const draftColorHex = typeof draft.color === 'string' ? normalizeHex(draft.color) : null
      let avatar
      if (hasExplicitAvatar(draft.avatar)) {
        const randBase = randomAvatar({
          existingBots: state.bots,
          preferredColor: draftColorHex || '',
        })
        avatar = normalizeAvatar(draft.avatar, { fallback: randBase, strict: true })
      } else {
        const preferredColor = draft.avatarRandom === true ? '' : (draftColorHex || '')
        avatar = randomAvatar({
          existingBots: state.bots,
          preferredColor,
        })
      }
      created = {
        id: newId('bot'),
        name,
        role: stringOr(draft.role),
        instructions: stringOr(draft.instructions),
        color: avatar.color,
        avatar,
        sectionId,
        hidden: draft.hidden === true,
        pinned: draft.pinned === true,
        order: Number.isFinite(draft.order) ? draft.order : state.bots.length,
        dir: '',
        sessionId: '',
        model,
        tools,
        approvalPolicy: APPROVAL_POLICIES.includes(draft.approvalPolicy) ? draft.approvalPolicy : 'ask',
        permissionRole: draft.permissionRole === 'admin' ? 'admin' : 'worker',
        dailyTokenLimit: clampInt(draft.dailyTokenLimit, 0, 1_000_000_000, 0),
        tokenUsage: { day: '', tokens: 0 },
        disabledSkills: Array.isArray(draft.disabledSkills)
          ? [...new Set(draft.disabledSkills.filter(s => typeof s === 'string' && s.trim() !== '').map(s => s.trim()))].sort()
          : [],
        skills: [],
        createdAt: now,
      }
      state.bots.push(created)
    })
    const bot = existing ?? created
    const dir = await this.store.ensureBotDir(bot)
    await this.store.mutate((state) => {
      const target = state.bots.find(item => item.id === bot.id)
      if (target && !target.dir) target.dir = dir
    })
    const liveBot = this.store.bot(bot.id) ?? bot
    if (liveBot.sessionId === '') {
      try {
        await this.dispatcher.ensureSession(liveBot)
      } catch (error) {
        this.logger?.warn?.(`botmode: could not open a Session for ${liveBot.name}: ${String(error)}`)
      }
    }
    await this.syncAll()
    const finalBot = this.store.bot(bot.id) ?? liveBot
    await seedInitialMemoryHub(this.memory, this.store, finalBot).catch(() => undefined)
    void this.screen?.syncAvatar?.(finalBot.id, finalBot.avatar).catch(() => undefined)
    return { botId: finalBot.id, bot: finalBot }
  }

  async saveBotAvatar(payload) {
    const botId = stringOr(payload?.botId).trim()
    const bot = this.store.bot(botId)
    if (!bot) throw new Error('Unknown Bot.')
    const rawAvatar = payload?.avatar && typeof payload.avatar === 'object' ? payload.avatar : payload
    if (!rawAvatar || typeof rawAvatar !== 'object') {
      throw new Error('Provide an avatar object.')
    }
    let updatedAvatar
    await this.store.mutate((state) => {
      const target = state.bots.find(item => item.id === botId)
      if (!target) throw new Error('Unknown Bot.')
      const base = target.avatar && typeof target.avatar === 'object'
        ? target.avatar
        : deterministicAvatar(target.id, target.color)
      updatedAvatar = normalizeAvatar(rawAvatar, { fallback: base, strict: true })
      target.avatar = updatedAvatar
      target.color = updatedAvatar.color
      target.updatedAt = new Date().toISOString()
    })
    const refreshed = this.store.bot(botId)
    await this.syncAll()
    void this.screen?.syncAvatar?.(botId, updatedAvatar).catch(() => undefined)
    return { botId, avatar: updatedAvatar, bot: refreshed }
  }

  async randomizeBotAvatar(payload) {
    const botId = stringOr(payload?.botId).trim()
    const bot = this.store.bot(botId)
    if (!bot) throw new Error('Unknown Bot.')
    let nextAvatar
    await this.store.mutate((state) => {
      const target = state.bots.find(item => item.id === botId)
      if (!target) throw new Error('Unknown Bot.')
      nextAvatar = randomAvatar({
        existingBots: state.bots.filter(item => item.id !== botId),
      })
      target.avatar = nextAvatar
      target.color = nextAvatar.color
      target.updatedAt = new Date().toISOString()
    })
    const refreshed = this.store.bot(botId)
    await this.syncAll()
    void this.screen?.syncAvatar?.(botId, nextAvatar).catch(() => undefined)
    return { botId, avatar: nextAvatar, bot: refreshed }
  }

  async deleteBot(payload) {
    const botId = stringOr(payload.botId)
    const bot = this.store.bot(botId)
    if (!bot) throw new Error('Unknown Bot.')
    this.dispatcher.cancel(botId)
    // Also cancel any live hidden Group Room sessions & pending approvals owned by this Bot.
    for (const room of this.store.state.rooms) {
      const sid = room.memberSessions?.[botId]
      if (sid) this.dispatcher.cancelSession?.(sid)
    }
    this.approvals?.cancelForBot?.(botId)
    await this.routines?.removeForBot?.(botId).catch(() => undefined)
    await this.store.mutate((state) => {
      state.bots = state.bots.filter(item => item.id !== botId)
      state.routines = state.routines.filter(routine => routine.botId !== botId)
      if (Array.isArray(state.routineNotices)) {
        state.routineNotices = state.routineNotices.filter(item => item.botId !== botId)
      }
      for (const room of state.rooms) {
        room.memberIds = room.memberIds.filter(id => id !== botId)
        if (room.memberSessions) delete room.memberSessions[botId]
        if (room.watermarks) delete room.watermarks[botId]
        for (const task of room.subtasks ?? []) {
          if (task.ownerBotId === botId && task.status === 'in_progress') {
            task.status = 'released'
            task.updatedAt = new Date().toISOString()
          }
        }
      }
    })
    await this.store.removeBotDir(bot)
    await this.memory?.purgeBot?.(botId)
    await this.screen?.purge?.(botId)
    await this.syncAll()
    return { botId }
  }

  async dispatchBot(payload) {
    const botId = stringOr(payload.botId)
    const text = stringOr(payload.text).trim()
    const images = Array.isArray(payload.images)
      ? payload.images.filter(image => image && typeof image === 'object'
        && typeof image.attachmentId === 'string' && image.attachmentId !== ''
        && typeof image.mediaType === 'string' && IMAGE_TYPES.has(image.mediaType)).slice(0, 20)
      : []
    if (text === '' && images.length === 0) throw new Error('Write a message or attach an image first.')
    const result = this.dispatcher.dispatch(botId, text, { source: 'api', images })
    if (!result.ok) throw new Error(result.error ?? 'dispatch failed')
    return result
  }

  async stopBot(payload) {
    const result = this.dispatcher.cancel(stringOr(payload.botId))
    if (!result.ok) throw new Error(result.error ?? 'nothing to stop')
    return result
  }

  async syncAll() {
    await this.store.load()
    for (const bot of this.store.state.bots) {
      await syncBotFiles(this.store, bot, this.store.state).catch((error) => {
        this.logger?.warn?.(`botmode: identity files for ${bot.name} failed: ${String(error)}`)
      })
    }
    await syncTeamFiles(this.store, this.store.state)
  }

  async saveSection(_payload) {
    // Custom bot sections are disabled: all Bots live in the single General (常规) group.
    let saved
    await this.store.mutate((state) => {
      state.sections = [{ id: 'general', name: 'General', nameZh: '常规', order: 0 }]
      for (const bot of state.bots) bot.sectionId = 'general'
      saved = state.sections[0]
    })
    return saved
  }

  async deleteSection(payload) {
    const sectionId = stringOr(payload.sectionId)
    if (sectionId === 'general') throw new Error('The General Section cannot be removed.')
    await this.store.mutate((state) => {
      state.sections = state.sections.filter(section => section.id !== sectionId)
      for (const bot of state.bots) {
        if (bot.sectionId === sectionId) bot.sectionId = 'general'
      }
    })
    return { sectionId }
  }

  previewCron(expression) {
    const next = nextCronTime(expression, new Date())
    return next ? next.toISOString() : undefined
  }
}

export { PREFIX }
