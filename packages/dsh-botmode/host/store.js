/**
 * Durable Bot-mode state.
 *
 * One JSON document holds the roster, Sections, Group Rooms, Routines and
 * global Memory Hub configuration; each Bot additionally owns a directory with
 * `bot.json`, `SOUL.md` and `MEMORY.md`, and each Group Room appends its full
 * event stream to `rooms/<roomId>.jsonl`.
 * Writes are serialized and atomic (temp file + rename), so a crash never leaves
 * a half-written state file and two concurrent commands cannot interleave.
 */
import { readFile, writeFile, appendFile, mkdir, rename, rm, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const STATE_VERSION = 4
export const ROOM_STATUSES = new Set(['idle', 'running', 'settled', 'capped', 'paused'])

export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`

export const clampInt = (value, min, max, fallback) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(num)))
}

export const defaultMemoryState = () => ({
  provider: 'memory_tencentdb',
  teamId: 'dsh-botmode',
  userId: 'default',
  prefetchEnabled: true,
  syncEnabled: true,
  syncGroupRooms: true,
  providersConfig: {
    memory_tencentdb: {
      gatewayHost: '127.0.0.1',
      gatewayPort: 8420,
      gatewayApiKey: '',
      serviceId: 'default',
      gatewayCmd: '',
      fallbackLocal: true,
      timeoutMs: 8000,
      recallLimit: 5,
    },
    local_sqlite: {
      recallLimit: 6,
    },
    builtin: {},
  },
})

export const emptyState = () => ({
  version: STATE_VERSION,
  createdAt: new Date().toISOString(),
  sections: [{ id: 'general', name: 'General', nameZh: '常规', order: 0 }],
  bots: [],
  rooms: [],
  routines: [],
  memory: defaultMemoryState(),
})

const slug = (value) => {
  const text = String(value ?? '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return text === '' ? 'bot' : text.slice(0, 40)
}

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (_error) {
    return undefined
  }
}

const normalizeStringMap = (input) => {
  const result = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result
  for (const [key, value] of Object.entries(input)) {
    if (typeof key === 'string' && key !== '' && typeof value === 'string' && value !== '') {
      result[key] = value
    }
  }
  return result
}

const normalizeNumberMap = (input) => {
  const result = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result
  for (const [key, value] of Object.entries(input)) {
    if (typeof key === 'string' && key !== '' && Number.isFinite(Number(value))) {
      result[key] = Math.max(0, Math.trunc(Number(value)))
    }
  }
  return result
}

/** One durable document plus the derived paths of its Bot directories. */
export class BotStore {
  #state = emptyState()
  #writeChain = Promise.resolve()
  #loaded = false

  /** @param root - `${DSH_HOME}/botmode`, the plugin's own state root. */
  constructor(root) {
    this.root = root
    this.statePath = join(root, 'state.json')
  }

  get state() { return this.#state }

  get botsRoot() { return join(this.root, 'bots') }

  get roomsRoot() { return join(this.root, 'rooms') }

  get memoryPluginsRoot() { return join(this.root, 'memory-plugins') }

  get memoryDataRoot() { return join(this.root, 'memory-data') }

  roomLogPath(roomId) {
    return join(this.roomsRoot, `${slug(roomId)}.jsonl`)
  }

  /** Read the document once, reconciling a legacy or partial file into current fields. */
  async load() {
    if (this.#loaded) return this.#state
    await mkdir(this.botsRoot, { recursive: true })
    await mkdir(this.roomsRoot, { recursive: true })
    await mkdir(this.memoryPluginsRoot, { recursive: true })
    await mkdir(this.memoryDataRoot, { recursive: true })
    const stored = await readJson(this.statePath)
    if (stored !== undefined && stored !== null) {
      this.#state = this.#normalize(stored)
    }
    this.#loaded = true
    return this.#state
  }

  #normalize(stored) {
    const base = emptyState()
    const sections = Array.isArray(stored.sections) && stored.sections.length > 0
      ? stored.sections.filter(section => section && typeof section.id === 'string')
      : base.sections
    const bots = Array.isArray(stored.bots) ? stored.bots.filter(bot => bot && typeof bot.id === 'string') : []
    return {
      ...base,
      ...stored,
      version: STATE_VERSION,
      sections: sections.map((section, index) => ({
        id: section.id,
        name: typeof section.name === 'string' && section.name !== '' ? section.name : section.id,
        nameZh: typeof section.nameZh === 'string' ? section.nameZh : undefined,
        order: Number.isFinite(section.order) ? section.order : index,
      })),
      bots: bots.map(bot => this.#normalizeBot(bot)),
      rooms: Array.isArray(stored.rooms) ? stored.rooms.map(room => this.#normalizeRoom(room)).filter(Boolean) : [],
      routines: Array.isArray(stored.routines) ? stored.routines.map(routine => this.#normalizeRoutine(routine)).filter(Boolean) : [],
      memory: this.#normalizeMemory(stored.memory),
    }
  }

  #normalizeMemory(memory) {
    const defaults = defaultMemoryState()
    if (!memory || typeof memory !== 'object') return defaults
    const providersConfig = { ...defaults.providersConfig }
    if (memory.providersConfig && typeof memory.providersConfig === 'object') {
      for (const [providerId, cfg] of Object.entries(memory.providersConfig)) {
        if (typeof providerId !== 'string' || providerId === '' || !cfg || typeof cfg !== 'object') continue
        providersConfig[providerId] = {
          ...(providersConfig[providerId] ?? {}),
          ...cfg,
        }
      }
    }
    return {
      provider: typeof memory.provider === 'string' && memory.provider.trim() !== ''
        ? memory.provider.trim()
        : defaults.provider,
      teamId: typeof memory.teamId === 'string' && memory.teamId.trim() !== ''
        ? memory.teamId.trim()
        : defaults.teamId,
      userId: typeof memory.userId === 'string' && memory.userId.trim() !== ''
        ? memory.userId.trim()
        : defaults.userId,
      prefetchEnabled: memory.prefetchEnabled !== false,
      syncEnabled: memory.syncEnabled !== false,
      syncGroupRooms: memory.syncGroupRooms !== false,
      providersConfig,
    }
  }

  #normalizeBot(bot) {
    return {
      id: bot.id,
      name: typeof bot.name === 'string' && bot.name !== '' ? bot.name : bot.id,
      role: typeof bot.role === 'string' ? bot.role : '',
      instructions: typeof bot.instructions === 'string' ? bot.instructions : '',
      color: typeof bot.color === 'string' && bot.color !== '' ? bot.color : '#4d6bfe',
      sectionId: typeof bot.sectionId === 'string' ? bot.sectionId : 'general',
      hidden: bot.hidden === true,
      pinned: bot.pinned === true,
      order: Number.isFinite(bot.order) ? bot.order : 0,
      dir: typeof bot.dir === 'string' ? bot.dir : '',
      sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : '',
      model: bot.model && typeof bot.model === 'object'
        ? {
          provider: typeof bot.model.provider === 'string' ? bot.model.provider : '',
          model: typeof bot.model.model === 'string' ? bot.model.model : '',
          reasoningEffort: typeof bot.model.reasoningEffort === 'string' ? bot.model.reasoningEffort : '',
        }
        : { provider: '', model: '', reasoningEffort: '' },
      approvalPolicy: bot.approvalPolicy === 'always' || bot.approvalPolicy === 'never' ? bot.approvalPolicy : 'ask',
      tools: bot.tools && typeof bot.tools === 'object'
        ? {
          allow: Array.isArray(bot.tools.allow) ? bot.tools.allow.filter(name => typeof name === 'string') : [],
          deny: Array.isArray(bot.tools.deny) ? bot.tools.deny.filter(name => typeof name === 'string') : [],
        }
        : { allow: [], deny: [] },
      skills: Array.isArray(bot.skills) ? bot.skills.filter(name => typeof name === 'string') : [],
      createdAt: typeof bot.createdAt === 'string' ? bot.createdAt : new Date().toISOString(),
      updatedAt: typeof bot.updatedAt === 'string' ? bot.updatedAt : undefined,
      lastTurnAt: typeof bot.lastTurnAt === 'string' ? bot.lastTurnAt : undefined,
      lastReply: typeof bot.lastReply === 'string' ? bot.lastReply : '',
      lastError: typeof bot.lastError === 'string' ? bot.lastError : '',
    }
  }

  #normalizeRoom(room) {
    if (!room || typeof room.id !== 'string' || typeof room.name !== 'string') return undefined
    let seqCursor = 0
    const transcript = Array.isArray(room.transcript)
      ? room.transcript.filter(item => item && typeof item.text === 'string').slice(-500).map((item) => {
        const seq = Number.isFinite(item.seq) && item.seq > seqCursor ? Math.trunc(item.seq) : (seqCursor + 1)
        seqCursor = seq
        return {
          seq,
          id: typeof item.id === 'string' ? item.id : newId('msg'),
          from: typeof item.from === 'string' ? item.from : 'user',
          name: typeof item.name === 'string' ? item.name : '',
          text: item.text,
          kind: item.kind === 'error' ? 'error' : 'message',
          epoch: Number.isFinite(item.epoch) ? Math.trunc(item.epoch) : 0,
          round: Number.isFinite(item.round) ? Math.trunc(item.round) : 0,
          at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
        }
      })
      : []
    const nextSeq = Math.max(
      seqCursor,
      Number.isFinite(room.nextSeq) ? Math.trunc(room.nextSeq) : 0,
    )
    const activity = Array.isArray(room.activity)
      ? room.activity.filter(item => item && typeof item.kind === 'string').slice(-100)
      : []
    // A `running` status loaded from disk belonged to a prior Host process that
    // exited; reset it to `idle` so the UI never gets stuck in a zombie state.
    const rawStatus = ROOM_STATUSES.has(room.status) ? room.status : 'idle'
    const status = rawStatus === 'running' ? 'idle' : rawStatus
    return {
      id: room.id,
      name: room.name,
      color: typeof room.color === 'string' ? room.color : '#d97706',
      purpose: typeof room.purpose === 'string' ? room.purpose : '',
      notes: typeof room.notes === 'string' ? room.notes : '',
      memberIds: Array.isArray(room.memberIds) ? room.memberIds.filter(id => typeof id === 'string').slice(0, 6) : [],
      mode: room.mode === 'everyone' || room.mode === 'lead' || room.mode === 'auto' ? room.mode : 'auto',
      leadBotId: typeof room.leadBotId === 'string' ? room.leadBotId : '',
      status,
      settledReason: typeof room.settledReason === 'string' ? room.settledReason : '',
      needsYou: room.needsYou === true,
      pausedReason: typeof room.pausedReason === 'string' ? room.pausedReason : '',
      epoch: Number.isFinite(room.epoch) ? Math.max(0, Math.trunc(room.epoch)) : 0,
      nextSeq,
      transcript,
      activity,
      watermarks: normalizeNumberMap(room.watermarks),
      memberSessions: normalizeStringMap(room.memberSessions),
      budget: room.budget && typeof room.budget === 'object'
        ? {
          rounds: clampInt(room.budget.rounds, 0, 100, 0),
          messages: clampInt(room.budget.messages, 0, 200, 0),
          maxRounds: clampInt(room.budget.maxRounds, 1, 20, 3),
          maxMessages: clampInt(room.budget.maxMessages, 1, 60, 10),
        }
        : { rounds: 0, messages: 0, maxRounds: 3, maxMessages: 10 },
      createdAt: typeof room.createdAt === 'string' ? room.createdAt : new Date().toISOString(),
      updatedAt: typeof room.updatedAt === 'string' ? room.updatedAt : undefined,
    }
  }

  #normalizeRoutine(routine) {
    if (!routine || typeof routine.id !== 'string' || typeof routine.botId !== 'string') return undefined
    return {
      id: routine.id,
      botId: routine.botId,
      name: typeof routine.name === 'string' ? routine.name : 'Routine',
      prompt: typeof routine.prompt === 'string' ? routine.prompt : '',
      cron: typeof routine.cron === 'string' ? routine.cron : '0 9 * * *',
      enabled: routine.enabled !== false,
      lastRunAt: typeof routine.lastRunAt === 'string' ? routine.lastRunAt : undefined,
      nextAt: typeof routine.nextAt === 'string' ? routine.nextAt : undefined,
      lastStatus: typeof routine.lastStatus === 'string' ? routine.lastStatus : '',
      createdAt: typeof routine.createdAt === 'string' ? routine.createdAt : new Date().toISOString(),
    }
  }

  /** Run one mutation against the document, then persist the result atomically. */
  async mutate(mutator) {
    const run = this.#writeChain.then(async () => {
      await this.load()
      const result = await mutator(this.#state)
      await this.#save()
      return result
    })
    // Keep the chain alive after a rejected mutation.
    this.#writeChain = run.catch(() => undefined)
    return run
  }

  async #save() {
    await mkdir(this.root, { recursive: true })
    const temp = `${this.statePath}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(this.#state, null, 2)}\n`, 'utf8')
    await rename(temp, this.statePath)
  }

  bot(id) { return this.#state.bots.find(bot => bot.id === id) }

  botBySession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    return this.#state.bots.find(bot => bot.sessionId !== '' && bot.sessionId === sessionId)
  }

  roomByMemberSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    for (const room of this.#state.rooms) {
      if (!room.memberSessions) continue
      for (const [botId, memberSessionId] of Object.entries(room.memberSessions)) {
        if (memberSessionId === sessionId) return { room, botId }
      }
    }
    return undefined
  }

  /** Resolve a Session belonging to either a Bot's primary chat or a hidden Group Room session. */
  botByAnySession(sessionId) {
    const primary = this.botBySession(sessionId)
    if (primary) return { bot: primary, kind: 'primary', roomId: '' }
    const member = this.roomByMemberSession(sessionId)
    if (!member) return undefined
    const bot = this.bot(member.botId)
    if (!bot) return undefined
    return { bot, kind: 'room', roomId: member.room.id }
  }

  allBotSessionIds() {
    const ids = new Set()
    for (const bot of this.#state.bots) {
      if (bot.sessionId) ids.add(bot.sessionId)
    }
    for (const room of this.#state.rooms) {
      for (const sessionId of Object.values(room.memberSessions ?? {})) {
        if (sessionId) ids.add(sessionId)
      }
    }
    return ids
  }

  room(id) { return this.#state.rooms.find(room => room.id === id) }

  routine(id) { return this.#state.routines.find(routine => routine.id === id) }

  section(id) { return this.#state.sections.find(section => section.id === id) }

  async ensureBotDir(bot) {
    if (typeof bot.dir === 'string' && bot.dir !== '') {
      await mkdir(bot.dir, { recursive: true })
      return bot.dir
    }
    const dir = join(this.botsRoot, `${slug(bot.name)}-${bot.id.slice(-6)}`)
    await mkdir(dir, { recursive: true })
    await mkdir(join(dir, '.dsh', 'skills', 'team'), { recursive: true })
    bot.dir = dir
    return dir
  }

  async removeBotDir(bot) {
    if (typeof bot.dir !== 'string' || bot.dir === '' || !bot.dir.startsWith(this.botsRoot)) return
    await rm(bot.dir, { recursive: true, force: true })
  }

  async listOrphanDirs() {
    try {
      const entries = await readdir(this.botsRoot, { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory()).map(entry => join(this.botsRoot, entry.name))
    } catch (_error) {
      return []
    }
  }
}

export const readTextFile = async (path, fallback = '') => {
  try {
    return await readFile(path, 'utf8')
  } catch (_error) {
    return fallback
  }
}

export const writeTextFile = async (path, text) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

export const appendJsonl = async (path, record) => {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export { stat }
