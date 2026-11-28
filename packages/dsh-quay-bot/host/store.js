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
import { readFile, writeFile, appendFile, mkdir, rename, rm, readdir, stat, open } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deterministicAvatar, normalizeAvatar } from './avatar.js'
import { DEFAULT_ROUTINE_SETTINGS, normalizeRoutine, normalizeRoutineSettings } from './scheduler/model.js'
import { defaultNotificationsSettings, normalizeNotificationsSettings } from './channels.js'

/** True ONLY when `candidatePath` resolves strictly inside `parentDir` (never equal, never sibling/escape). */
export const isStrictSubpath = (parentDir, candidatePath) => {
  if (typeof parentDir !== 'string' || typeof candidatePath !== 'string') return false
  if (parentDir.trim() === '' || candidatePath.trim() === '') return false
  const root = resolve(parentDir)
  const target = resolve(candidatePath)
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export const STATE_VERSION = 5
export const ROOM_STATUSES = new Set([
  'idle',
  'running',
  'completed',
  'settled',
  'waiting_user',
  'stalled',
  'capped',
  'paused',
])

export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`

/** True when `pid` refers to a currently alive local process. */
export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Cross-process cooperative file lock (`O_CREAT | O_EXCL` with owner `{ pid, token }`
 * verification, immediate dead-PID reclamation, stale fallback, and token-checked release).
 */
export const withFileLock = async (lockPath, task, { timeoutMs = 5_000, staleMs = 15_000 } = {}) => {
  await mkdir(dirname(lockPath), { recursive: true })
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  let acquired = false
  while (!acquired) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }), 'utf8')
      } finally {
        await handle.close().catch(() => undefined)
      }
      acquired = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let info = null
      try {
        info = JSON.parse(await readFile(lockPath, 'utf8'))
      } catch {
        info = null
      }
      const st = await stat(lockPath).catch(() => null)
      const ownerDead = info && Number.isInteger(info.pid) && info.pid > 0 && !pidAlive(info.pid)
      const expired = st ? (Date.now() - st.mtimeMs > staleMs) : false
      if (ownerDead || expired || Date.now() >= deadline) {
        await rm(lockPath, { force: true }).catch(() => undefined)
        continue
      }
      await delay(15)
    }
  }
  try {
    return await task()
  } finally {
    try {
      const info = JSON.parse(await readFile(lockPath, 'utf8'))
      if (info?.token === token) await rm(lockPath, { force: true }).catch(() => undefined)
    } catch {
      /* already removed or unreadable */
    }
  }
}

export const normalizeDiskPaths = (value, fallback = ['/']) => {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[\n,]/) : [])
  const out = []
  for (const item of raw) {
    const p = String(item ?? '').trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out.length > 0 ? out.slice(0, 16) : [...fallback]
}

export const normalizeSystemSettings = (input, base = defaultSettingsState().system) => {
  const sys = input && typeof input === 'object' ? input : {}
  const cleanUrl = (val, fallback = '') => {
    if (typeof val !== 'string') return fallback
    const trimmed = val.trim().replace(/\/+$/, '')
    if (trimmed === '') return ''
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    return fallback
  }
  return {
    enabled: sys.enabled !== undefined ? sys.enabled !== false : base.enabled,
    gatewayUrl: sys.gatewayUrl !== undefined ? cleanUrl(sys.gatewayUrl, base.gatewayUrl) : base.gatewayUrl,
    adminToken: typeof sys.adminToken === 'string' ? sys.adminToken.trim() : base.adminToken,
    diskPaths: sys.diskPaths !== undefined
      ? normalizeDiskPaths(sys.diskPaths, base.diskPaths)
      : (sys.diskPath !== undefined ? normalizeDiskPaths(sys.diskPath, base.diskPaths) : [...base.diskPaths]),
    refreshIntervalSec: sys.refreshIntervalSec !== undefined
      ? clampInt(sys.refreshIntervalSec, 1, 60, base.refreshIntervalSec)
      : base.refreshIntervalSec,
    pushUrl: sys.pushUrl !== undefined ? cleanUrl(sys.pushUrl, base.pushUrl) : base.pushUrl,
    pushIntervalSec: sys.pushIntervalSec !== undefined
      ? clampInt(sys.pushIntervalSec, 0, 86400, base.pushIntervalSec)
      : base.pushIntervalSec,
    pushToken: typeof sys.pushToken === 'string' ? sys.pushToken.trim() : base.pushToken,
  }
}

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
  syncGroupRooms: false,
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

export const defaultSettingsState = () => ({
  responseFormat: {
    enabled: true,
    extendedMarkdown: true, // GFM tables, Callouts (> [!TIP]), Diff blocks, <details>
    diagramsAndMath: true,  // ```mermaid diagrams & KaTeX-style math blocks
    artifacts: true,        // <artifact type="..." title="...">...</artifact> preview cards
    structuredCards: true,  // ```metrics / ```card / ```file structured JSON cards
    multimodal: true,       // inline images, audio/video & file attachment cards
  },
  groupChat: {
    defaultTokenLimit: 0,
    defaultIdleRoundLimit: 5,
    enableSoftLock: true,
    enableErrorProbe: true,
    autoProgressReview: true,
    showActivityStrip: false,
  },
  system: {
    enabled: true,
    gatewayUrl: '',         // 空表示使用 BOTSCREEN_GATEWAY 或默认 http://127.0.0.1:6200
    adminToken: '',         // 空表示使用 BOTSCREEN_ADMIN_TOKEN
    diskPaths: ['/'],       // 采集磁盘占用的挂载点列表
    refreshIntervalSec: 5,  // 监控流/界面刷新周期（秒）
    pushUrl: '',            // 可选：通过网关主动上报的目标接口 URL
    pushIntervalSec: 0,     // 0 = 关闭定时主动上报；>0 为秒级周期
    pushToken: '',          // 可选：主动上报鉴权 Token
  },
  routines: { ...DEFAULT_ROUTINE_SETTINGS },
  governance: {
    requireApprovalForBotCrud: true,
    defaultDailyTokenLimit: 0,
    protectExternalWrites: false,
  },
  notifications: defaultNotificationsSettings(),
})

export const emptyState = () => ({
  version: STATE_VERSION,
  createdAt: new Date().toISOString(),
  sections: [{ id: 'general', name: 'General', nameZh: '常规', order: 0 }],
  bots: [],
  rooms: [],
  routines: [],
  routineNotices: [],
  webhooks: [],
  artifacts: [],
  memory: defaultMemoryState(),
  settings: defaultSettingsState(),
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
  #loadPromise = null
  #lastStatKey = null

  /** @param root - `${DSH_HOME}/botmode`, the plugin's own state root. */
  constructor(root) {
    this.root = root
    this.statePath = join(root, 'state.json')
    this.stateLockPath = join(root, 'state.json.lock')
  }

  get state() { return this.#state }

  get botsRoot() { return join(this.root, 'bots') }

  get roomsRoot() { return join(this.root, 'rooms') }

  get memoryPluginsRoot() { return join(this.root, 'memory-plugins') }

  get memoryDataRoot() { return join(this.root, 'memory-data') }

  /** Bot-Mode shared skills directory (`$DSH_HOME/botmode/skills`), isolated from normal DSH skills. */
  get skillsRoot() { return join(this.root, 'skills') }

  /** Bot-Mode independent MCP configuration file (`$DSH_HOME/botmode/mcp.json`), isolated from normal DSH MCP. */
  get mcpConfigPath() { return join(this.root, 'mcp.json') }

  roomLogPath(roomId) {
    return join(this.roomsRoot, `${slug(roomId)}.jsonl`)
  }

  async #statKey() {
    try {
      const st = await stat(this.statePath)
      return `${st.mtimeMs}:${st.size}:${st.ino}`
    } catch {
      return null
    }
  }

  /** Unconditionally reload `state.json` from disk (keeps multi-process readers in sync). */
  async reload({ ensureDirs = false } = {}) {
    if (this.#loadPromise) return this.#loadPromise
    this.#loadPromise = (async () => {
      if (ensureDirs) {
        await mkdir(this.botsRoot, { recursive: true })
        await mkdir(this.roomsRoot, { recursive: true })
        await mkdir(this.memoryPluginsRoot, { recursive: true })
        await mkdir(this.memoryDataRoot, { recursive: true })
        await mkdir(this.skillsRoot, { recursive: true })
      }
      const coldBoot = !this.#loaded
      const keyBefore = await this.#statKey()
      const stored = await readJson(this.statePath)
      if (stored !== undefined && stored !== null) {
        this.#state = this.#normalize(stored, { coldBoot })
      } else if (keyBefore === null && coldBoot) {
        this.#state = emptyState()
      }
      this.#lastStatKey = await this.#statKey() ?? keyBefore
      this.#loaded = true
      return this.#state
    })()
    try {
      return await this.#loadPromise
    } finally {
      this.#loadPromise = null
    }
  }

  /** Read the document on first access or whenever `state.json` changed on disk. */
  async load() {
    if (!this.#loaded) return this.reload({ ensureDirs: true })
    if (this.#loadPromise) return this.#loadPromise
    const currentKey = await this.#statKey()
    if (currentKey !== null && currentKey !== this.#lastStatKey) {
      return this.reload({ ensureDirs: false })
    }
    return this.#state
  }

  #normalize(stored, { coldBoot = false } = {}) {
    const base = emptyState()
    const bots = Array.isArray(stored.bots) ? stored.bots.filter(bot => bot && typeof bot.id === 'string') : []
    return {
      ...base,
      ...stored,
      version: STATE_VERSION,
      // All Bots belong to the single "general" (常规) list; only General & Groups exist.
      sections: [{ id: 'general', name: 'General', nameZh: '常规', order: 0 }],
      bots: bots.map(bot => this.#normalizeBot(bot)),
      rooms: Array.isArray(stored.rooms) ? stored.rooms.map(room => this.#normalizeRoom(room, { coldBoot })).filter(Boolean) : [],
      routines: Array.isArray(stored.routines) ? stored.routines.map(routine => this.#normalizeRoutine(routine)).filter(Boolean) : [],
      routineNotices: Array.isArray(stored.routineNotices) ? stored.routineNotices.slice(-100) : [],
      webhooks: Array.isArray(stored.webhooks) ? stored.webhooks.map(item => this.#normalizeWebhook(item)).filter(Boolean) : [],
      artifacts: Array.isArray(stored.artifacts)
        ? stored.artifacts.map(item => this.#normalizeArtifact(item)).filter(Boolean).slice(-200)
        : [],
      memory: this.#normalizeMemory(stored.memory),
      settings: this.#normalizeSettings(stored.settings),
    }
  }

  #normalizeArtifact(item) {
    if (!item || typeof item !== 'object') return undefined
    const id = typeof item.id === 'string' && item.id.trim() !== ''
      ? item.id.trim()
      : (typeof item.artifactId === 'string' ? item.artifactId.trim() : '')
    if (!id) return undefined
    return {
      id,
      artifactId: id,
      kind: typeof item.kind === 'string' && item.kind.trim() !== '' ? item.kind.trim() : 'artifact',
      title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : id,
      type: typeof item.type === 'string' && item.type.trim() !== '' ? item.type.trim() : 'file',
      filename: typeof item.filename === 'string' ? item.filename : '',
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
      size: Number.isFinite(Number(item.size)) ? Math.max(0, Math.trunc(Number(item.size))) : 0,
      sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
      botId: typeof item.botId === 'string' ? item.botId : '',
      botName: typeof item.botName === 'string' ? item.botName : '',
      roomId: typeof item.roomId === 'string' ? item.roomId : '',
      roomName: typeof item.roomName === 'string' ? item.roomName : '',
      messageId: typeof item.messageId === 'string' ? item.messageId : '',
      sourcePath: typeof item.sourcePath === 'string' ? item.sourcePath : '',
      preview: typeof item.preview === 'string' ? item.preview.slice(0, 400) : '',
      gatewaySynced: item.gatewaySynced === true,
      at: typeof item.at === 'string' && item.at !== '' ? item.at : new Date().toISOString(),
    }
  }

  #normalizeSettings(settings) {
    const defaults = defaultSettingsState()
    if (!settings || typeof settings !== 'object') return defaults
    const rf = settings.responseFormat && typeof settings.responseFormat === 'object' ? settings.responseFormat : {}
    const gc = settings.groupChat && typeof settings.groupChat === 'object' ? settings.groupChat : {}
    return {
      responseFormat: {
        enabled: rf.enabled !== false,
        extendedMarkdown: rf.extendedMarkdown !== false,
        diagramsAndMath: rf.diagramsAndMath !== false,
        artifacts: rf.artifacts !== false,
        structuredCards: rf.structuredCards !== false,
        multimodal: rf.multimodal !== false,
      },
      groupChat: {
        defaultTokenLimit: clampInt(gc.defaultTokenLimit, 0, 1_000_000_000, defaults.groupChat.defaultTokenLimit),
        defaultIdleRoundLimit: clampInt(gc.defaultIdleRoundLimit, 1, 100, defaults.groupChat.defaultIdleRoundLimit),
        enableSoftLock: gc.enableSoftLock !== false,
        enableErrorProbe: gc.enableErrorProbe !== false,
        autoProgressReview: gc.autoProgressReview !== false,
        showActivityStrip: gc.showActivityStrip === true,
      },
      system: normalizeSystemSettings(settings.system, defaults.system),
      routines: normalizeRoutineSettings(settings.routines),
      governance: {
        requireApprovalForBotCrud: settings.governance?.requireApprovalForBotCrud !== false,
        defaultDailyTokenLimit: clampInt(settings.governance?.defaultDailyTokenLimit, 0, 1_000_000_000, defaults.governance.defaultDailyTokenLimit),
        protectExternalWrites: settings.governance?.protectExternalWrites === true,
      },
      notifications: normalizeNotificationsSettings(settings.notifications, defaults.notifications),
    }
  }

  #normalizeWebhook(item) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim() === '') return undefined
    const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : item.id
    const targetKind = item.targetKind === 'room' ? 'room' : 'bot'
    const targetId = typeof item.targetId === 'string' ? item.targetId.trim() : ''
    if (!targetId) return undefined
    return {
      id: item.id.trim(),
      name,
      enabled: item.enabled !== false,
      secret: typeof item.secret === 'string' ? item.secret : '',
      targetKind,
      targetId,
      promptTemplate: typeof item.promptTemplate === 'string' ? item.promptTemplate : '',
      triggerCount: clampInt(item.triggerCount, 0, 1_000_000_000, 0),
      lastTriggeredAt: typeof item.lastTriggeredAt === 'string' ? item.lastTriggeredAt : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
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
      syncGroupRooms: memory.syncGroupRooms === true,
      providersConfig,
    }
  }

  #normalizeBot(bot) {
    const baseColor = typeof bot.color === 'string' && bot.color !== '' ? bot.color : '#4d6bfe'
    const fallbackAvatar = deterministicAvatar(bot.id, baseColor)
    const avatar = bot.avatar && typeof bot.avatar === 'object'
      ? normalizeAvatar(bot.avatar, { fallback: fallbackAvatar, strict: false })
      : fallbackAvatar
    return {
      id: bot.id,
      name: typeof bot.name === 'string' && bot.name !== '' ? bot.name : bot.id,
      role: typeof bot.role === 'string' ? bot.role : '',
      instructions: typeof bot.instructions === 'string' ? bot.instructions : '',
      color: baseColor,
      avatar,
      sectionId: 'general',
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
      permissionRole: bot.permissionRole === 'admin' ? 'admin' : 'worker',
      dailyTokenLimit: clampInt(bot.dailyTokenLimit, 0, 1_000_000_000, 0),
      tokenUsage: bot.tokenUsage && typeof bot.tokenUsage === 'object'
        ? {
          day: typeof bot.tokenUsage.day === 'string' ? bot.tokenUsage.day : '',
          tokens: clampInt(bot.tokenUsage.tokens, 0, 1_000_000_000, 0),
        }
        : { day: '', tokens: 0 },
      tools: bot.tools && typeof bot.tools === 'object'
        ? {
          allow: Array.isArray(bot.tools.allow) ? bot.tools.allow.filter(name => typeof name === 'string') : [],
          deny: Array.isArray(bot.tools.deny) ? bot.tools.deny.filter(name => typeof name === 'string') : [],
        }
        : { allow: [], deny: [] },
      skills: Array.isArray(bot.skills) ? bot.skills.filter(name => typeof name === 'string') : [],
      disabledSkills: Array.isArray(bot.disabledSkills) ? [...new Set(bot.disabledSkills.filter(name => typeof name === 'string' && name.trim() !== ''))] : [],
      createdAt: typeof bot.createdAt === 'string' ? bot.createdAt : new Date().toISOString(),
      updatedAt: typeof bot.updatedAt === 'string' ? bot.updatedAt : undefined,
      lastTurnAt: typeof bot.lastTurnAt === 'string' ? bot.lastTurnAt : undefined,
      lastReply: typeof bot.lastReply === 'string' ? bot.lastReply : '',
      lastError: typeof bot.lastError === 'string' ? bot.lastError : '',
    }
  }

  #normalizeRoom(room, { coldBoot = false } = {}) {
    if (!room || typeof room.id !== 'string' || typeof room.name !== 'string') return undefined
    const rawOwnerPid = Number.isInteger(room.ownerPid) && room.ownerPid > 0 ? room.ownerPid : 0
    const ownedByOtherLiveHost = rawOwnerPid > 0 && rawOwnerPid !== process.pid && pidAlive(rawOwnerPid)
    const shouldRecoverCold = coldBoot && !ownedByOtherLiveHost
    let seqCursor = 0
    const transcript = Array.isArray(room.transcript)
      ? room.transcript.filter(item => item && typeof item.text === 'string').slice(-500).map((item) => {
        const seq = Number.isFinite(item.seq) && item.seq > seqCursor ? Math.trunc(item.seq) : (seqCursor + 1)
        seqCursor = seq
        const rawKind = item.kind
        const kind = rawKind === 'error' || rawKind === 'system' || rawKind === 'completion'
          ? rawKind
          : 'message'
        return {
          seq,
          id: typeof item.id === 'string' ? item.id : newId('msg'),
          from: typeof item.from === 'string' ? item.from : 'user',
          name: typeof item.name === 'string' ? item.name : '',
          text: item.text,
          kind,
          mentions: Array.isArray(item.mentions) ? item.mentions.filter(m => typeof m === 'string') : [],
          deliverables: Array.isArray(item.deliverables) ? item.deliverables.filter(d => typeof d === 'string') : undefined,
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
    const subtasks = Array.isArray(room.subtasks)
      ? room.subtasks
        .filter(item => item && typeof item.taskId === 'string' && item.taskId.trim() !== '')
        .slice(-100)
        .map(item => ({
          taskId: item.taskId.trim(),
          title: typeof item.title === 'string' ? item.title.trim() : '',
          ownerBotId: typeof item.ownerBotId === 'string' ? item.ownerBotId : '',
          ownerName: typeof item.ownerName === 'string' ? item.ownerName : '',
          paths: Array.isArray(item.paths) ? item.paths.filter(p => typeof p === 'string' && p.trim() !== '') : [],
          // Only release `in_progress` subtasks on cold boot when no other live Host owns the room.
          status: item.status === 'completed' || item.status === 'released'
            ? item.status
            : (shouldRecoverCold ? 'released' : 'in_progress'),
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
        }))
      : []
    const completion = room.completion && typeof room.completion === 'object' && typeof room.completion.summary === 'string'
      ? {
        summary: room.completion.summary,
        deliverables: Array.isArray(room.completion.deliverables)
          ? room.completion.deliverables.filter(d => typeof d === 'string')
          : [],
        verification: typeof room.completion.verification === 'string' ? room.completion.verification : '',
        finishedBy: typeof room.completion.finishedBy === 'string' ? room.completion.finishedBy : '',
        finishedByName: typeof room.completion.finishedByName === 'string' ? room.completion.finishedByName : '',
        epoch: Number.isFinite(room.completion.epoch) ? Math.trunc(room.completion.epoch) : 0,
        at: typeof room.completion.at === 'string' ? room.completion.at : new Date().toISOString(),
      }
      : null
    // A `running` status or an in-memory `waiting_user` (approval/question) loaded from
    // disk on cold boot (when no other live Host owns it) belonged to an exited Host process;
    // recover them cleanly without clobbering live rooms owned by another instance.
    const rawStatus = ROOM_STATUSES.has(room.status) ? room.status : 'idle'
    const rawPausedReason = typeof room.pausedReason === 'string' ? room.pausedReason : ''
    let status = (shouldRecoverCold && rawStatus === 'running') ? 'idle' : rawStatus
    let pausedReason = rawPausedReason
    let needsYou = room.needsYou === true
    let ownerPid = shouldRecoverCold ? 0 : rawOwnerPid
    if (shouldRecoverCold && rawStatus === 'waiting_user' && (rawPausedReason === 'approval' || rawPausedReason === 'question')) {
      status = 'stalled'
      pausedReason = 'host_restarted'
      needsYou = true
      ownerPid = 0
    }
    const tokenLimit = room.budget && typeof room.budget === 'object'
      ? clampInt(room.budget.tokenLimit, 0, 1_000_000_000, 0)
      : 0
    const tokensUsed = room.budget && typeof room.budget === 'object'
      ? clampInt(room.budget.tokensUsed, 0, 1_000_000_000, 0)
      : 0
    const tokenCheckpoint = room.budget && typeof room.budget === 'object'
      ? clampInt(room.budget.tokenCheckpoint, 0, 1_000_000_000, tokenLimit)
      : tokenLimit
    const progress = room.progress && typeof room.progress === 'object'
      ? {
        goal: typeof room.progress.goal === 'string' ? room.progress.goal : '',
        items: Array.isArray(room.progress.items)
          ? room.progress.items
            .filter(item => item && typeof item.id === 'string' && item.id.trim() !== '')
            .slice(0, 40)
            .map(item => ({
              id: item.id.trim(),
              title: typeof item.title === 'string' ? item.title.trim() : item.id.trim(),
              owner: typeof item.owner === 'string' ? item.owner.trim() : '',
              done: item.done === true,
              note: typeof item.note === 'string' ? item.note.trim() : '',
            }))
          : [],
        updatedBy: typeof room.progress.updatedBy === 'string' ? room.progress.updatedBy : '',
        updatedAt: typeof room.progress.updatedAt === 'string' ? room.progress.updatedAt : '',
      }
      : { goal: '', items: [], updatedBy: '', updatedAt: '' }
    return {
      id: room.id,
      name: room.name,
      color: typeof room.color === 'string' ? room.color : '#d97706',
      purpose: typeof room.purpose === 'string' ? room.purpose : '',
      notes: typeof room.notes === 'string' ? room.notes : '',
      workDir: typeof room.workDir === 'string' ? room.workDir.trim() : '',
      memberIds: Array.isArray(room.memberIds) ? room.memberIds.filter(id => typeof id === 'string').slice(0, 6) : [],
      mode: room.mode === 'everyone' || room.mode === 'lead' || room.mode === 'auto' ? room.mode : 'auto',
      leadBotId: typeof room.leadBotId === 'string' ? room.leadBotId : '',
      status,
      ownerPid,
      settledReason: typeof room.settledReason === 'string' ? room.settledReason : '',
      needsYou,
      pausedReason,
      completion,
      subtasks,
      progress,
      epoch: Number.isFinite(room.epoch) ? Math.max(0, Math.trunc(room.epoch)) : 0,
      nextSeq,
      transcript,
      activity,
      watermarks: normalizeNumberMap(room.watermarks),
      memberSessions: normalizeStringMap(room.memberSessions),
      budget: room.budget && typeof room.budget === 'object'
        ? {
          rounds: clampInt(room.budget.rounds, 0, 100_000, 0),
          messages: clampInt(room.budget.messages, 0, 100_000, 0),
          maxRounds: clampInt(room.budget.maxRounds, 0, 10_000, 0),
          maxMessages: clampInt(room.budget.maxMessages, 0, 100_000, 0),
          tokensUsed,
          tokenLimit,
          tokenCheckpoint,
          idleRounds: clampInt(room.budget.idleRounds, 0, 1000, 0),
          idleRoundLimit: clampInt(room.budget.idleRoundLimit, 1, 100, 5),
        }
        : {
          rounds: 0,
          messages: 0,
          maxRounds: 0,
          maxMessages: 0,
          tokensUsed: 0,
          tokenLimit: 0,
          tokenCheckpoint: 0,
          idleRounds: 0,
          idleRoundLimit: 5,
        },
      createdAt: typeof room.createdAt === 'string' ? room.createdAt : new Date().toISOString(),
      updatedAt: typeof room.updatedAt === 'string' ? room.updatedAt : undefined,
    }
  }

  #normalizeRoutine(routine) {
    return normalizeRoutine(routine)
  }

  /** Run one mutation against the latest on-disk document under a cross-process lock. */
  async mutate(mutator) {
    const run = this.#writeChain.then(() => withFileLock(this.stateLockPath, async () => {
      await this.load()
      const result = await mutator(this.#state)
      await this.#save()
      return result
    }))
    // Keep the chain alive after a rejected mutation.
    this.#writeChain = run.catch(() => undefined)
    return run
  }

  async #save() {
    await mkdir(this.root, { recursive: true })
    const temp = `${this.statePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(temp, `${JSON.stringify(this.#state, null, 2)}\n`, 'utf8')
    await rename(temp, this.statePath)
    this.#lastStatKey = await this.#statKey()
    this.#loaded = true
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
    if (!member) {
      // Isolated Routine sessions (`fresh` per run, or one `named` session per task).
      const owned = this.routineBySession(sessionId)
      const owner = owned ? this.bot(owned.routine.botId) : undefined
      if (!owner) return undefined
      return { bot: owner, kind: 'routine', roomId: '', routineId: owned.routine.id, runId: owned.runId }
    }
    const bot = this.bot(member.botId)
    if (!bot) return undefined
    return { bot, kind: 'room', roomId: member.room.id }
  }

  /** Resolve a Session created for a Routine run (or a Routine's named session). */
  routineBySession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    for (const routine of this.#state.routines) {
      if (routine.namedSessionId === sessionId) return { routine, runId: '' }
      const hit = routine.runSessions?.find(item => item.sessionId === sessionId)
      if (hit) return { routine, runId: hit.runId }
    }
    return undefined
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
    for (const routine of this.#state.routines) {
      if (routine.namedSessionId) ids.add(routine.namedSessionId)
      for (const item of routine.runSessions ?? []) {
        if (item.sessionId) ids.add(item.sessionId)
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
    if (typeof bot.dir !== 'string' || bot.dir === '' || !isStrictSubpath(this.botsRoot, bot.dir)) return
    await rm(resolve(bot.dir), { recursive: true, force: true })
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
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, path)
}

export const appendJsonl = async (path, record) => {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export { stat }
