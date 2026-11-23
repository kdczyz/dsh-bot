/**
 * The Host API the Bot page talks to.
 *
 * One authenticated, same-origin JSON surface behind `/botmode/api/`:
 *   GET  state     — the roster, Sections, Rooms, Routines and live status
 *   POST command   — one typed mutation or action
 *
 * Every request passes the composition's Connection fence first, so a browser
 * without the login cookie or a cross-site caller never reaches a Bot session.
 */
import { newId } from './store.js'
import { syncBotFiles, syncTeamFiles } from './persona.js'
import { nextCronTime } from './cron.js'

const MAX_BODY_BYTES = 256 * 1024
const APPROVAL_POLICIES = ['ask', 'always', 'never']
const PREFIX = '/botmode/api/'

const sendJson = (res, status, payload) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

const readBody = async (req) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

const stringOr = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

export class BotApi {
  constructor({ ctx, store, dispatcher, rooms, routines, approvals, logger }) {
    this.ctx = ctx
    this.store = store
    this.dispatcher = dispatcher
    this.rooms = rooms
    this.routines = routines
    this.approvals = approvals ?? { list: () => [], decide: async () => ({}) }
    this.logger = logger
  }

  async handle(req, res) {
    const rejection = this.ctx.get('connection')?.requestRejection?.(req)
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
        sendJson(res, 200, { ok: true, state: this.publicState() })
        return
      }
      if (route === 'command' && req.method === 'POST') {
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
      })),
      rooms: state.rooms.map(room => ({
        ...room,
        running: this.rooms.state(room.id).running,
        members: room.memberIds.map((id) => {
          const bot = this.store.bot(id)
          return bot ? { id: bot.id, name: bot.name, role: bot.role, color: bot.color } : { id, name: id, role: '' }
        }),
      })),
      routines: state.routines.map(routine => ({
        ...routine,
        botName: this.store.bot(routine.botId)?.name ?? '',
      })),
      approvals: this.approvals ? this.approvals.list() : [],
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
      })
      case 'room.delete': return this.rooms.remove(stringOr(payload.roomId))
      case 'room.send': return this.rooms.send(stringOr(payload.roomId), stringOr(payload.text))
      case 'room.control': return this.rooms.control(stringOr(payload.roomId), stringOr(payload.action))
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
      default: throw new Error(`Unknown command "${type}".`)
    }
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
        existing.hidden = draft.hidden === true
        existing.pinned = draft.pinned === true
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
    // ensureBotDir assigns the directory in memory; flush it before any await
    // that could fail, so a restart never strands the assets on disk.
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
    await this.store.mutate((state) => {
      state.bots = state.bots.filter(item => item.id !== botId)
      for (const routine of state.routines) {
        if (routine.botId === botId) routine.enabled = false
      }
      for (const room of state.rooms) {
        room.memberIds = room.memberIds.filter(id => id !== botId)
      }
    })
    await this.store.removeBotDir(bot)
    await this.syncAll()
    return { botId }
  }

  async dispatchBot(payload) {
    const botId = stringOr(payload.botId)
    const text = stringOr(payload.text).trim()
    if (text === '') throw new Error('Write a message first.')
    const result = this.dispatcher.dispatch(botId, text, { source: 'api' })
    if (!result.ok) throw new Error(result.error ?? 'dispatch failed')
    return result
  }

  async stopBot(payload) {
    const result = this.dispatcher.cancel(stringOr(payload.botId))
    if (!result.ok) throw new Error(result.error ?? 'nothing to stop')
    return result
  }

  /** Rewrite every Bot's identity files so rosters in SOUL.md never go stale. */
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

  /** Next occurrence preview for the UI. */
  previewCron(expression) {
    const next = nextCronTime(expression, new Date())
    return next ? next.toISOString() : undefined
  }
}

export { PREFIX }