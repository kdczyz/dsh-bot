/**
 * The Host API the Bot page talks to.
 *
 * One authenticated, same-origin JSON surface behind `/botmode/api/`:
 *   GET  state     — roster, Sections, Rooms, Routines, Memory Hub and live status
 *   GET  models    — live DSH provider/model catalog
 *   GET  memory    — full Memory Hub status, installed plugins, catalog & health
 *   POST image     — upload one image attachment
 *   POST command   — one typed mutation or action
 */
import { join } from 'node:path'
import { clampInt, defaultSettingsState, newId, readTextFile, writeTextFile } from './store.js'
import { syncBotFiles, syncTeamFiles } from './persona.js'
import { nextCronTime } from './cron.js'
import { botModelCatalog } from './models.js'

const MAX_BODY_BYTES = 256 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const APPROVAL_POLICIES = ['ask', 'always', 'never']
const PREFIX = '/botmode/api/'

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

  constructor({ ctx, store, dispatcher, rooms, routines, approvals, memory, screen, logger }) {
    this.ctx = ctx
    this.store = store
    this.dispatcher = dispatcher
    this.rooms = rooms
    this.routines = routines
    this.approvals = approvals ?? { list: () => [], decide: async () => ({}) }
    this.memory = memory ?? null
    this.screen = screen ?? null
    this.logger = logger
  }

  async #refreshScreenSnapshot() {
    if (!this.screen) return this.#screenSnapshot
    const data = await this.screen.listScreens()
    const byBot = {}
    for (const item of data.screens || []) {
      if (item && item.bot_id) byBot[item.bot_id] = item
    }
    this.#screenSnapshot = {
      available: data.available === true,
      gatewayUrl: data.gatewayUrl || this.screen.gatewayUrl,
      autoStartable: Boolean(data.autoStartable),
      starting: Boolean(data.starting),
      error: typeof data.error === 'string' ? data.error : '',
      host: data.host || null,
      byBot,
    }
    return this.#screenSnapshot
  }

  async handle(req, res) {
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
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(PREFIX)) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const route = url.pathname.slice(PREFIX.length)
    try {
      if (route === 'state' && req.method === 'GET') {
        await this.store.load()
        if (this.memory) await this.memory.ensureReady().catch(() => undefined)
        await this.#refreshScreenSnapshot().catch(() => undefined)
        sendJson(res, 200, { ok: true, state: this.publicState() })
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
        try {
          const shot = await this.screen.preview(botId, { cached })
          res.statusCode = 200
          res.setHeader('content-type', shot.mimeType)
          res.setHeader('cache-control', 'no-store')
          if (shot.frozen) res.setHeader('x-screen-frozen', 'true')
          res.end(shot.buffer)
        } catch (error) {
          sendJson(res, error?.status || 409, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
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
            return bot ? { id: bot.id, name: bot.name, role: bot.role, color: bot.color } : { id, name: id, role: '' }
          }),
        }
      }),
      routines: state.routines.map(routine => ({
        ...routine,
        botName: this.store.bot(routine.botId)?.name ?? '',
      })),
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
      memory: this.memory ? this.memory.publicSummary() : null,
      settings: state.settings ?? defaultSettingsState(),
      usage: this.#usageSummary(state),
      artifacts: this.#artifactsSummary(state),
      tools: (() => {
        try {
          const tools = this.ctx.get('tools')
          return tools ? tools.definitions().map(tool => tool.name).sort() : []
        } catch (_error) {
          return []
        }
      })(),
      runtime: {
        root: this.store.root,
        pid: process.pid,
      },
    }
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

  #artifactsSummary(state) {
    const items = []
    const artifactRe = /<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/gi
    for (const room of state.rooms ?? []) {
      if (room.completion && Array.isArray(room.completion.deliverables)) {
        for (const path of room.completion.deliverables) {
          items.push({
            id: `deliv:${room.id}:${path}`,
            kind: 'deliverable',
            title: path,
            type: 'file',
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
        for (const match of msg.text.matchAll(artifactRe)) {
          const attrs = match[1] || ''
          const title = (/title="([^"]+)"/i.exec(attrs)?.[1] ?? /title='([^']+)'/i.exec(attrs)?.[1] ?? 'Artifact').trim()
          const type = (/type="([^"]+)"/i.exec(attrs)?.[1] ?? /type='([^']+)'/i.exec(attrs)?.[1] ?? 'code').trim()
          items.push({
            id: `art:${msg.id}:${items.length}`,
            kind: 'artifact',
            title,
            type,
            roomId: room.id,
            roomName: room.name,
            botId: msg.from || '',
            botName: msg.name || '',
            preview: String(match[2] || '').trim().slice(0, 400),
            at: msg.at || '',
          })
        }
      }
    }
    return items.slice(-60).reverse()
  }

  async command(payload) {
    const type = stringOr(payload?.type)
    switch (type) {
      case 'bot.save': return this.saveBot(payload)
      case 'bot.delete': return this.deleteBot(payload)
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
        prompt: payload?.prompt,
        enabled: payload?.enabled,
      })
      case 'routine.delete': return this.routines.remove(stringOr(payload.routineId))
      case 'routine.toggle': return this.routines.setEnabled(stringOr(payload.routineId), payload?.enabled === true)
      case 'routine.run': return this.routines.runNow(stringOr(payload.routineId))
      case 'approval.decide': return this.approvals.decide(stringOr(payload.approvalId), stringOr(payload.decision))
      case 'question.decide': return this.approvals.decideQuestion(stringOr(payload.questionId), payload.answers)
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
      case 'settings.save': return this.saveSettings(payload)
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
      updated = state.settings
    })
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
    const sectionId = stringOr(draft.sectionId, existing?.sectionId ?? 'general')
    if (!this.store.section(sectionId)) throw new Error('Unknown Section.')
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
        existing.name = name
        existing.role = stringOr(draft.role, existing.role)
        existing.instructions = stringOr(draft.instructions, existing.instructions)
        existing.color = stringOr(draft.color, existing.color)
        existing.sectionId = sectionId
        if (typeof draft.hidden === 'boolean') existing.hidden = draft.hidden
        if (typeof draft.pinned === 'boolean') existing.pinned = draft.pinned
        existing.order = Number.isFinite(draft.order) ? draft.order : existing.order
        existing.model = model
        existing.tools = tools
        existing.approvalPolicy = APPROVAL_POLICIES.includes(draft.approvalPolicy)
          ? draft.approvalPolicy
          : existing.approvalPolicy
        existing.updatedAt = now
        return
      }
      if (state.bots.some(bot => bot.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A Bot named "${name}" already exists.`)
      }
      created = {
        id: newId('bot'),
        name,
        role: stringOr(draft.role),
        instructions: stringOr(draft.instructions),
        color: stringOr(draft.color, '#4d6bfe'),
        sectionId,
        hidden: draft.hidden === true,
        pinned: draft.pinned === true,
        order: Number.isFinite(draft.order) ? draft.order : state.bots.length,
        dir: '',
        sessionId: '',
        model,
        tools,
        approvalPolicy: APPROVAL_POLICIES.includes(draft.approvalPolicy) ? draft.approvalPolicy : 'ask',
        skills: [],
        createdAt: now,
      }
      state.bots.push(created)
    })
    const bot = existing ?? created
    await this.store.ensureBotDir(bot)
    await this.store.mutate(() => {})
    if (bot.sessionId === '') {
      try {
        await this.dispatcher.ensureSession(bot)
      } catch (error) {
        this.logger?.warn?.(`botmode: could not open a Session for ${bot.name}: ${String(error)}`)
      }
    }
    await this.syncAll()
    return { botId: bot.id, bot }
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
    await this.store.mutate((state) => {
      state.bots = state.bots.filter(item => item.id !== botId)
      for (const routine of state.routines) {
        if (routine.botId === botId) routine.enabled = false
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
    for (const bot of this.store.state.bots) {
      await syncBotFiles(this.store, bot, this.store.state).catch((error) => {
        this.logger?.warn?.(`botmode: identity files for ${bot.name} failed: ${String(error)}`)
      })
    }
    await syncTeamFiles(this.store, this.store.state)
  }

  async saveSection(payload) {
    const name = stringOr(payload?.name).trim()
    if (name === '') throw new Error('Give the Section a name.')
    const sectionId = stringOr(payload.sectionId)
    let saved
    await this.store.mutate((state) => {
      if (sectionId !== '') {
        const section = state.sections.find(item => item.id === sectionId)
        if (!section) throw new Error('Unknown Section.')
        section.name = name
        section.nameZh = stringOr(payload.nameZh, section.nameZh ?? '')
        saved = section
        return
      }
      saved = {
        id: newId('sec'),
        name,
        nameZh: stringOr(payload.nameZh),
        order: state.sections.length,
      }
      state.sections.push(saved)
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
