/**
 * Durable Bot-mode state.
 *
 * One JSON document holds the roster, Sections, Group Rooms and Routines; each
 * Bot additionally owns a directory with `bot.json`, `SOUL.md` and `MEMORY.md`.
 * Writes are serialized and atomic (temp file + rename), so a crash never leaves
 * a half-written state file and two concurrent commands cannot interleave.
 */
import { readFile, writeFile, mkdir, rename, rm, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const STATE_VERSION = 3

export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`

export const emptyState = () => ({
  version: STATE_VERSION,
  createdAt: new Date().toISOString(),
  sections: [{ id: 'general', name: 'General', nameZh: '常规', order: 0 }],
  bots: [],
  rooms: [],
  routines: [],
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

  /** Read the document once, reconciling a legacy or partial file into current fields. */
  async load() {
    if (this.#loaded) return this.#state
    await mkdir(this.botsRoot, { recursive: true })
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
    // Reconcile Bot directories that exist on disk but are missing from the file.
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
    return {
      id: room.id,
      name: room.name,
      color: typeof room.color === 'string' ? room.color : '#d97706',
      memberIds: Array.isArray(room.memberIds) ? room.memberIds.filter(id => typeof id === 'string').slice(0, 6) : [],
      mode: room.mode === 'everyone' || room.mode === 'lead' || room.mode === 'auto' ? room.mode : 'auto',
      leadBotId: typeof room.leadBotId === 'string' ? room.leadBotId : '',
      status: room.status === 'running' || room.status === 'paused' ? room.status : 'idle',
      needsYou: room.needsYou === true,
      pausedReason: typeof room.pausedReason === 'string' ? room.pausedReason : '',
      transcript: Array.isArray(room.transcript)
        ? room.transcript.filter(item => item && typeof item.text === 'string').slice(-200).map(item => ({
          id: typeof item.id === 'string' ? item.id : newId('msg'),
          from: typeof item.from === 'string' ? item.from : 'user',
          name: typeof item.name === 'string' ? item.name : '',
          text: item.text,
          at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
        }))
        : [],
      budget: room.budget && typeof room.budget === 'object'
        ? {
          rounds: Number.isFinite(room.budget.rounds) ? room.budget.rounds : 0,
          messages: Number.isFinite(room.budget.messages) ? room.budget.messages : 0,
          maxRounds: Number.isFinite(room.budget.maxRounds) ? room.budget.maxRounds : 3,
          maxMessages: Number.isFinite(room.budget.maxMessages) ? room.budget.maxMessages : 10,
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
    return this.#state.bots.find(bot => bot.sessionId !== '' && bot.sessionId === sessionId)
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

export { stat }