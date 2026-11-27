/**
 * Bot mode for DeepSeek Harness — Host half.
 *
 * Adds a Bot roster with real identity isolation, a loop-guarded teammate
 * messaging tool, Hermes-style Group Rooms (deterministic state machine +
 * isolated per-member hidden sessions + watermarks + (pass) convergence +
 * epoch supersession), Host-level persistent Routines, and a pluggable global
 * Memory Hub (built-in `memory_tencentdb`, `local_sqlite`, `builtin`, plus
 * downloadable third-party memory plugins).
 *
 * State lives under `$DSH_HOME/botmode/`:
 *   state.json                 roster, Sections, Rooms, Routines, Memory Hub config
 *   rooms/<roomId>.jsonl       append-only Group Room event logs
 *   memory-plugins/<id>/       downloaded external memory provider plugins
 *   memory-data/               local SQLite memory databases
 *   bots/<slug>-<id>/          one directory per Bot
 *     bot.json  SOUL.md  MEMORY.md  .dsh/skills/team/SKILL.md
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BotStore } from './host/store.js'
import { Dispatcher } from './host/dispatch.js'
import { Rooms } from './host/rooms.js'
import { Routines } from './host/routines.js'
import { BotApi, PREFIX } from './host/api.js'
import { Approvals } from './host/approvals.js'
import { MemoryManager } from './host/memory/manager.js'
import { personaBlock, syncBotFiles, syncTeamFiles } from './host/persona.js'
import { botModelCatalog, modelAcceptsImages, resolveBotSelection } from './host/models.js'
import { checkRoomWriteSoftLock } from './host/room-locks.js'
import { ScreenBridge } from './host/screen.js'

export const name = 'botmode'
export const inject = ['commands', 'tools']

const MEMORY_TOOLS = [
  'memory_search',
  'memory_conversation_search',
  'memory_read_scene',
  'memory_save',
  'memory_tencentdb_memory_search',
  'memory_tencentdb_conversation_search',
  'memory_tencentdb_read_scene',
]
const SCREEN_TOOLS = [
  'screen_screenshot',
  'screen_click',
  'screen_type',
  'screen_key',
  'screen_scroll',
  'screen_drag',
  'screen_open_app',
  'screen_windows',
  'screen_request_help',
]
const SYSTEM_TOOLS = ['system_info']
const ARTIFACT_TOOLS = ['publish_artifact']
const ROOM_COORDINATION_TOOLS = ['claim_subtask', 'room_task_progress', 'room_finish_task']
const DEFAULT_PRIMARY_TOOLS = ['message_agent', 'bot_team', ...MEMORY_TOOLS, ...SCREEN_TOOLS, ...SYSTEM_TOOLS, ...ARTIFACT_TOOLS]
const DEFAULT_ROOM_TOOLS = ['bot_team', ...ROOM_COORDINATION_TOOLS, ...MEMORY_TOOLS, ...SCREEN_TOOLS, ...SYSTEM_TOOLS, ...ARTIFACT_TOOLS]

const sessionIdOf = (agent) => {
  try {
    return agent?.session?.id ?? agent?.session?.header?.id
  } catch (_error) {
    return undefined
  }
}

export function apply(ctx) {
  const logger = ctx.logger
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const store = new BotStore(join(home, 'botmode'))
  const memory = new MemoryManager(store, logger)
  const dispatcher = new Dispatcher(
    ctx,
    store,
    logger,
    (agent, bot, meta) => { void configureAgent(agent, bot, meta) },
    memory,
  )
  const approvals = new Approvals(store, logger)
  const screen = new ScreenBridge({ approvals, logger, logDir: store.root })
  const rooms = new Rooms(store, dispatcher, logger, approvals)
  const routines = new Routines(ctx, store, dispatcher, logger)
  const api = new BotApi({ ctx, store, dispatcher, rooms, routines, approvals, memory, screen, logger })
  dispatcher.setArtifactHandler(event => api.syncReplyArtifacts(event))
  rooms.setArtifactHandler(event => api.syncDeliverables(event))

  const ready = store.load()
    .then(async () => {
      await memory.ensureReady()
      // Apply saved gateway / system monitoring settings before warming up the gateway.
      const sysCfg = store.state?.settings?.system
      if (sysCfg && typeof sysCfg === 'object') {
        screen.configure({
          gatewayUrl: sysCfg.gatewayUrl || '',
          adminToken: sysCfg.adminToken || '',
        })
      }
      // Ensure existing Bot workspaces pick up built-in skills (e.g. `room-completion/SKILL.md`) on startup.
      for (const bot of store.state.bots) {
        if (bot.dir) await syncBotFiles(store, bot, store.state).catch(() => undefined)
      }
      // Best-effort non-blocking warm-up so local BotScreen gateway starts automatically on plugin load.
      void screen.warmUp()
        .then((res) => {
          if (res?.available && sysCfg && typeof sysCfg === 'object') {
            return screen.updateSystemConfig(sysCfg).catch(() => undefined)
          }
          return undefined
        })
        .catch(() => undefined)
    })
    .catch((error) => {
      logger?.warn?.(`botmode: startup initialization warning: ${String(error)}`)
    })

  ctx.effect(() => routines.start(), 'botmode: persistent routines')
  ctx.effect(() => () => approvals.clear(), 'botmode: approval cleanup')
  ctx.effect(() => () => { void memory.shutdown() }, 'botmode: memory hub shutdown')

  // Bridge approvals & interactive questions for BOTH primary Bot sessions and isolated Group Room sessions.
  const approvalOff = ctx.on('approval/request', (request, next) => {
    const sessionId = sessionIdOf(request?.agent)
    const resolved = sessionId ? store.botByAnySession(sessionId) : undefined
    if (!resolved) return next()
    return approvals.ask(resolved.bot, request, { roomId: resolved.roomId || '', sessionId })
  })
  ctx.effect(() => approvalOff, 'botmode: approval bridge')

  const questionOff = ctx.on('user-questions/request', (request, next) => {
    const sessionId = sessionIdOf(request?.agent)
    const resolved = sessionId ? store.botByAnySession(sessionId) : undefined
    if (!resolved) return next()
    return approvals.askQuestion(resolved.bot, request, { roomId: resolved.roomId || '' })
  })
  ctx.effect(() => questionOff, 'botmode: user-questions bridge')

  // Path Soft-Lock interceptor: prevent concurrent Group Room Bots from silently overwriting
  // files currently leased by a teammate via `claim_subtask`.
  const evaluateRoomSoftLock = (exec) => {
    if (store.state?.settings?.groupChat?.enableSoftLock === false) return undefined
    const sessionId = sessionIdOf(exec?.agent)
    if (!sessionId) return undefined
    const resolved = store.botByAnySession(sessionId)
    if (!resolved || resolved.kind !== 'room' || !resolved.roomId) return undefined
    const room = store.room(resolved.roomId)
    if (!room) return undefined
    return checkRoomWriteSoftLock({
      room,
      callerBotId: resolved.bot.id,
      toolName: exec?.name,
      args: exec?.arguments,
      baseDir: room.workDir || resolved.bot.dir,
    })
  }

  const preExecuteOff = ctx.on('tools/pre-execute', (exec, next) => {
    const lockReason = evaluateRoomSoftLock(exec)
    if (lockReason) return { kind: 'deny', reason: lockReason }
    return next()
  })
  ctx.effect(() => preExecuteOff, 'botmode: room file soft-lock pre-execute')

  if (typeof ctx.tools?.guard === 'function') {
    ctx.effect(() => ctx.tools.guard((exec) => evaluateRoomSoftLock(exec)), 'botmode: room file soft-lock guard')
  }

  // Public Host service: other plugins and the CLI can drive the same roster.
  const botsService = {
    state: () => store.state,
    list: () => store.state.bots.slice(),
    get: (id) => store.bot(id),
    sectionList: () => store.state.sections.slice(),
    roomList: () => store.state.rooms.slice(),
    routineList: () => store.state.routines.slice(),
    async create(draft) {
      await ready
      const response = await api.command({ type: 'bot.save', draft })
      return response.bot
    },
    async update(id, draft) {
      await ready
      const response = await api.command({ type: 'bot.save', botId: id, draft })
      return response.bot
    },
    async remove(id) {
      await ready
      return api.command({ type: 'bot.delete', botId: id })
    },
    dispatchToBot(botId, text, options = {}) {
      return dispatcher.dispatch(botId, text, { source: options.source ?? 'service' })
    },
    async messageAgent(botId, target, message, expectReply = false) {
      return dispatcher.messageAgent(botId, target, message, expectReply)
    },
    isBusy: (botId) => dispatcher.isBusy(botId),
    status: () => dispatcher.status(),
    saveRoom: (roomId, draft) => rooms.save(roomId, draft),
    sendToRoom: (roomId, text) => rooms.send(roomId, text),
    controlRoom: (roomId, action) => rooms.control(roomId, action),
    saveRoutine: (routineId, draft) => routines.save(routineId, draft),
    modelCatalog: (options) => botModelCatalog(ctx, options),
    memoryStatus: () => memory.status(),
    selectMemoryProvider: (providerId) => memory.select(providerId),
    configureMemory: (patch) => memory.configure(patch),
    installMemoryPlugin: (source, options) => memory.install(source, options),
    uninstallMemoryPlugin: (providerId) => memory.uninstall(providerId),
    systemInfo: async (options) => {
      await ready
      return api.getSystemInfo(options)
    },
    getSystemConfig: async () => {
      await ready
      return api.getSystemConfig()
    },
    configureSystem: async (patch) => {
      await ready
      return api.saveSystemConfig(patch)
    },
    pushSystemInfo: async (options) => {
      await ready
      return api.pushSystemInfo(options)
    },
    listArtifacts: async (options) => {
      await ready
      return api.listArtifacts(options)
    },
    publishArtifact: async (payload) => {
      await ready
      return api.publishArtifact(payload)
    },
    downloadArtifact: async (options) => {
      await ready
      return api.downloadArtifact(options)
    },
    deleteArtifact: async (options) => {
      await ready
      return api.deleteArtifact(options)
    },
  }
  ctx.effect(() => ctx.reflect.provide('bots', botsService), 'botmode: ctx.bots service')

  // Persona, memory block, model binding, tool policy, permanent-chat commands
  // and approval policy are applied once per live Agent (both primary & room).
  const configured = new WeakSet()
  async function configureAgent(agent, bot, meta = { kind: 'primary', roomId: '' }) {
    if (!agent || !bot || configured.has(agent)) return
    configured.add(agent)
    const isRoom = meta?.kind === 'room'
    try {
      await memory.ensureReady().catch(() => undefined)
      const memoryPromptBlock = memory.systemPromptBlockForBot(bot)
      const persona = await personaBlock(store, bot, store.state, {
        kind: isRoom ? 'room' : 'primary',
        roomId: meta?.roomId || '',
        memoryPromptBlock,
      })
      agent.ctx.effect(() => {
        const prompt = agent.ctx.get('systemPrompt')
        if (!prompt) return
        return prompt.section({ name: `botmode:persona:${bot.id}`, order: 500, text: persona })
      }, `botmode: persona for ${bot.name}`)
    } catch (error) {
      logger?.warn?.(`botmode: persona for ${bot.name} failed: ${String(error)}`)
    }
    try {
      const tools = agent.ctx.get('tools')
      if (tools) {
        const known = new Set((tools.definitions?.() ?? []).map(entry => entry.name))
        const defaultTools = isRoom ? DEFAULT_ROOM_TOOLS : DEFAULT_PRIMARY_TOOLS
        const baseDeny = isRoom
          ? [...bot.tools.deny, 'message_agent']
          : [...bot.tools.deny, ...ROOM_COORDINATION_TOOLS]
        const deny = [...new Set(baseDeny)].filter(toolName => known.has(toolName))
        const allow = bot.tools.allow.length > 0
          ? [...new Set([...bot.tools.allow, ...defaultTools])].filter(toolName => known.has(toolName) && !deny.includes(toolName))
          : undefined
        if (allow !== undefined || deny.length > 0) {
          agent.ctx.effect(() => tools.restrict({
            ...allow === undefined ? {} : { allow },
            ...deny.length > 0 ? { deny } : {},
          }), `botmode: tools for ${bot.name}`)
        }
      }
    } catch (error) {
      logger?.warn?.(`botmode: tool policy for ${bot.name} failed: ${String(error)}`)
    }
    // Permanent chat compaction with Hermes-style `onPreCompress` memory checkpoint.
    try {
      const commands = agent.ctx.get('commands')
      const compaction = agent.ctx.get('compaction')
      if (commands && compaction && typeof compaction.compactNow === 'function') {
        for (const commandName of ['new', 'reset']) {
          agent.ctx.effect(() => commands.register({
            name: commandName,
            description: `Compact this Bot chat instead of starting a new Session (/${commandName}).`,
            recordInput: false,
            input: { hint: '(no arguments)' },
            handler: async (invocation) => {
              try {
                const sid = sessionIdOf(invocation.agent) || ''
                await memory.onPreCompressForBot(bot, `Session ${sid} compacted via /${commandName}.`, { sessionId: sid })
                const outcome = await compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
                return {
                  kind: 'success',
                  text: outcome === null
                    ? 'No compactable history yet; this permanent Bot chat is unchanged.'
                    : `Compacted this permanent Bot chat through seq ${String(outcome.endSeq ?? '')}. The Session is unchanged.`,
                }
              } catch (error) {
                return { kind: 'error', text: `Compaction failed: ${error instanceof Error ? error.message : String(error)}` }
              }
            },
          }), `botmode: /${commandName} for ${bot.name}`)
        }
      }
    } catch (error) {
      logger?.warn?.(`botmode: permanent-chat commands for ${bot.name} failed: ${String(error)}`)
    }
    try {
      const approval = agent.ctx.get('approval')
      if (approval && typeof approval.setPolicy === 'function') {
        approval.setPolicy(agent, bot.approvalPolicy === 'never' ? 'never' : 'ask')
      }
    } catch (error) {
      logger?.warn?.(`botmode: approval policy for ${bot.name} failed: ${String(error)}`)
    }
    const selection = resolveBotSelection(ctx, bot)
    if (selection) {
      try {
        agent.model.select(selection)
      } catch (error) {
        logger?.warn?.(`botmode: model for ${bot.name} failed: ${String(error)}`)
      }
    }
  }

  const agentOff = ctx.on('agent/created', async ({ agent }) => {
    await ready
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    const resolved = store.botByAnySession(sessionId)
    if (!resolved) return
    await configureAgent(agent, resolved.bot, { kind: resolved.kind, roomId: resolved.roomId })
  })
  ctx.effect(() => agentOff, 'botmode: agent bootstrap listener')

  // Helper to resolve the calling Bot across both primary and hidden room sessions.
  const resolveCallerBot = async (exec) => {
    await ready
    const sessionId = sessionIdOf(exec?.agent)
    if (!sessionId) return undefined
    const resolved = store.botByAnySession(sessionId)
    return resolved ? { ...resolved, sessionId } : undefined
  }

  // Teammate messaging (with hop guard + strict Group Room rejection).
  ctx.effect(() => ctx.tools.register({
    name: 'message_agent',
    description: 'Send an asynchronous message to another Bot\'s permanent chat. Returns a dispatched receipt immediately; with expectReply the answer arrives later in your own chat. Unavailable inside a Group Room.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Teammate name or Bot id.' },
        message: { type: 'string', description: 'Self-contained message, including the context the teammate cannot see.' },
        expectReply: { type: 'boolean', description: 'Ask the dispatcher to deliver the teammate\'s reply back into this chat.' },
      },
      required: ['target', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return 'This Session is not a Bot.'
      const result = await dispatcher.messageAgent(
        caller.bot.id,
        String(args?.target ?? ''),
        String(args?.message ?? ''),
        args?.expectReply === true,
        caller.sessionId,
      )
      return JSON.stringify(result)
    },
  }), 'botmode: message_agent tool')

  ctx.effect(() => ctx.tools.register({
    name: 'bot_team',
    description: 'Read the Bot roster, your own identity, Sections and Group Room membership.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['roster', 'me', 'rooms'], description: 'Which view to return.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      const me = caller?.bot
      const action = String(args?.action ?? 'roster')
      if (action === 'me') {
        return JSON.stringify(me
          ? {
            id: me.id,
            name: me.name,
            role: me.role,
            dir: me.dir,
            sectionId: me.sectionId,
            sessionKind: caller.kind,
            roomId: caller.roomId || '',
            inRoom: dispatcher.inRoom(me.id),
            tools: me.tools,
          }
          : { error: 'This Session is not a Bot.' })
      }
      if (action === 'rooms') {
        const mine = store.state.rooms.filter(room => me && room.memberIds.includes(me.id))
        return JSON.stringify(mine.map(room => ({
          id: room.id,
          name: room.name,
          mode: room.mode,
          status: room.status,
          members: room.memberIds,
        })))
      }
      return JSON.stringify(store.state.bots.map(bot => ({
        id: bot.id,
        name: bot.name,
        role: bot.role,
        sectionId: bot.sectionId,
        inRoom: dispatcher.inRoom(bot.id),
        running: dispatcher.isRunning(bot.id),
        queued: dispatcher.queueDepth(bot.id),
        me: me?.id === bot.id,
      })))
    },
  }), 'botmode: bot_team tool')

  ctx.effect(() => ctx.tools.register({
    name: 'claim_subtask',
    description: 'Claim, update, complete or release a subtask and its file/directory path leases on the shared Group Room task board so concurrent Bots never overwrite the same files.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['claim', 'list'], description: 'Optional: pass "list" to inspect all subtasks in the room.' },
        taskId: { type: 'string', description: 'Short deterministic subtask identifier, e.g. "auth-api" or "ui-login".' },
        title: { type: 'string', description: 'Brief human-readable description of what this subtask covers.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File or directory paths (relative to workspace or absolute) leased exclusively while status is "in_progress".',
        },
        status: {
          type: 'string',
          enum: ['in_progress', 'completed', 'released'],
          description: 'Subtask lifecycle state. Set to "completed" when finished to release file locks.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return JSON.stringify({ ok: false, error: 'This Session is not a Bot.' })
      if (caller.kind !== 'room' || !caller.roomId) {
        return JSON.stringify({ ok: false, code: 'room_only', error: 'claim_subtask is only available inside a Group Room session.' })
      }
      const res = await rooms.claimSubtask(caller.roomId, caller.bot, {
        action: args?.action,
        taskId: args?.taskId,
        title: args?.title,
        paths: args?.paths,
        status: args?.status,
      })
      return JSON.stringify(res)
    },
  }), 'botmode: claim_subtask tool')

  ctx.effect(() => ctx.tools.register({
    name: 'room_task_progress',
    description: 'Read or update the shared Group Room task progress checklist (used by the room-completion skill to verify milestones autonomously before calling room_finish_task).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'update'], description: '"get" returns current checklist and readyToFinish status; "update" upserts checklist items.' },
        goal: { type: 'string', description: 'Optional concise goal statement for this room task.' },
        items: {
          type: 'array',
          description: 'Checklist items to create or update when action="update".',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short stable milestone id.' },
              title: { type: 'string', description: 'Milestone description.' },
              owner: { type: 'string', description: 'Responsible Bot name.' },
              done: { type: 'boolean', description: 'Whether this milestone is verified done.' },
              note: { type: 'string', description: 'Optional verification note or artifact path.' },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return JSON.stringify({ ok: false, error: 'This Session is not a Bot.' })
      if (caller.kind !== 'room' || !caller.roomId) {
        return JSON.stringify({ ok: false, code: 'room_only', error: 'room_task_progress is only available inside a Group Room session.' })
      }
      const res = await rooms.updateTaskProgress(caller.roomId, caller.bot, {
        action: args?.action,
        goal: args?.goal,
        items: args?.items,
      })
      return JSON.stringify(res)
    },
  }), 'botmode: room_task_progress tool')

  ctx.effect(() => ctx.tools.register({
    name: 'room_finish_task',
    description: 'Formally mark the Group Room task as completed once all deliverables and subtasks are verified. Writing "task completed" in chat text will NOT close the room.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise final acceptance summary of what the team accomplished and verified.' },
        deliverables: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of modified files, artifacts, or verification outputs.',
        },
        verification: { type: 'string', description: 'Optional test or verification evidence.' },
        force: { type: 'boolean', description: 'Optional override when closing despite superseded subtasks.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return JSON.stringify({ ok: false, error: 'This Session is not a Bot.' })
      if (caller.kind !== 'room' || !caller.roomId) {
        return JSON.stringify({ ok: false, code: 'room_only', error: 'room_finish_task is only available inside a Group Room session.' })
      }
      const res = await rooms.finishTask(caller.roomId, caller.bot, {
        summary: args?.summary,
        deliverables: args?.deliverables,
        verification: args?.verification,
        force: args?.force === true,
      })
      return JSON.stringify(res)
    },
  }), 'botmode: room_finish_task tool')

  // Unified Memory Hub tools (routed to the globally active memory provider,
  // scoped strictly to the calling Bot's `agent_id`).
  const registerMemorySearchTool = (toolName) => ctx.effect(() => ctx.tools.register({
    name: toolName,
    description: 'Search structured long-term memories (L1 facts/preferences) in the active Memory Hub for this Bot.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Semantic or keyword search query.' },
        limit: { type: 'integer', description: 'Maximum items to return (1-20, default 5).' },
        type: { type: 'string', description: 'Optional memory type filter (e.g. fact, preference, decision).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return 'This Session is not a Bot.'
      const res = await memory.searchMemoryForBot(caller.bot, {
        query: String(args?.query ?? ''),
        limit: args?.limit,
        typeFilter: String(args?.type ?? ''),
      })
      return res.ok ? (res.text || 'No memories found.') : JSON.stringify(res)
    },
  }), `botmode: ${toolName} tool`)

  const registerConversationSearchTool = (toolName) => ctx.effect(() => ctx.tools.register({
    name: toolName,
    description: 'Search raw historical conversation logs (L0) in the active Memory Hub for this Bot.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'integer', description: 'Maximum items to return (1-20, default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return 'This Session is not a Bot.'
      const res = await memory.searchConversationsForBot(caller.bot, {
        query: String(args?.query ?? ''),
        limit: args?.limit,
      })
      return res.ok ? (res.text || 'No conversations found.') : JSON.stringify(res)
    },
  }), `botmode: ${toolName} tool`)

  const registerReadSceneTool = (toolName) => ctx.effect(() => ctx.tools.register({
    name: toolName,
    description: 'List or read L2 scene blocks from the active Memory Hub for this Bot. Omit scene_id to list available scenes.',
    parameters: {
      type: 'object',
      properties: {
        scene_id: { type: 'string', description: 'Scene identifier (or empty to list scenes).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return 'This Session is not a Bot.'
      const res = await memory.readSceneForBot(caller.bot, { sceneId: String(args?.scene_id ?? '') })
      return res.ok ? (res.text || 'No scene content.') : JSON.stringify(res)
    },
  }), `botmode: ${toolName} tool`)

  registerMemorySearchTool('memory_search')
  registerMemorySearchTool('memory_tencentdb_memory_search')
  registerConversationSearchTool('memory_conversation_search')
  registerConversationSearchTool('memory_tencentdb_conversation_search')
  registerReadSceneTool('memory_read_scene')
  registerReadSceneTool('memory_tencentdb_read_scene')

  ctx.effect(() => ctx.tools.register({
    name: 'memory_save',
    description: 'Explicitly persist an important fact, decision, or preference into the active Memory Hub for this Bot.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Durable fact or preference to remember.' },
        type: { type: 'string', description: 'Category such as fact, preference, decision, workflow.' },
        scene: { type: 'string', description: 'Optional scene name to file this memory under.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return 'This Session is not a Bot.'
      const res = await memory.saveMemoryForBot(caller.bot, {
        content: String(args?.content ?? ''),
        type: String(args?.type ?? 'fact'),
        scene: String(args?.scene ?? ''),
      })
      return JSON.stringify(res)
    },
  }), 'botmode: memory_save tool')

  // ---- Per-Bot Virtual Screen tools (auto-scoped to caller Bot) ----------
  const encodeShotResult = async (caller, meta, shot) => {
    let attachment
    let visionNote = ''
    if (shot?.buffer && shot?.mimeType) {
      const accepts = await modelAcceptsImages(ctx, resolveBotSelection(ctx, caller.bot)).catch(() => undefined)
      if (accepts === false) {
        visionNote = 'Current Bot model does not accept image inputs; switch to a vision-capable model to view screenshots.'
      } else {
        const attachments = ctx.get('attachments')
        if (attachments && typeof attachments.saveImages === 'function') {
          try {
            const [saved] = await attachments.saveImages([{
              data: shot.buffer,
              mediaType: shot.mimeType,
              name: `${caller.bot.id}-screen.jpg`,
            }])
            if (saved) attachment = saved
          } catch (error) {
            logger?.warn?.(`botmode: saveImages for screen failed: ${String(error)}`)
          }
        }
      }
    }
    const payload = { ...meta, ...(visionNote ? { visionNote } : {}) }
    return {
      text: JSON.stringify(payload),
      ...(attachment ? { attachment } : {}),
    }
  }

  const renderShotOutput = (_args, value) => {
    if (value && typeof value === 'object') {
      const blocks = [{ type: 'text', text: String(value.text ?? JSON.stringify(value)) }]
      if (value.attachment) blocks.push({ type: 'image', attachment: value.attachment })
      return blocks
    }
    return [{ type: 'text', text: String(value ?? '') }]
  }

  const SHOT_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
      text: { type: 'string' },
      attachment: { type: 'object' },
    },
  }

  ctx.effect(() => ctx.tools.register({
    name: 'screen_screenshot',
    description: 'Capture a 1280x720 screenshot of this Bot\'s dedicated Linux virtual screen (automatically wakes frozen screens).',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['jpeg', 'webp', 'png'], description: 'Image format (default jpeg).' },
        include_focus: { type: 'boolean', description: 'Include active window title & geometry.' },
      },
      additionalProperties: false,
    },
    output: { schema: SHOT_OUTPUT_SCHEMA, render: renderShotOutput },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return { text: JSON.stringify({ ok: false, error: 'This Session is not a Bot.' }) }
      const shot = await screen.screenshot(caller.bot, {
        format: String(args?.format || 'jpeg'),
        includeFocus: args?.include_focus === true,
        signal: exec?.signal,
      })
      if (shot?.abortedByHuman) return { text: JSON.stringify(shot) }
      const meta = {
        ok: true,
        width: shot.width,
        height: shot.height,
        state: shot.state,
        resumedFromLongFreeze: shot.resumedFromLongFreeze,
        focusedWindow: shot.focusedWindow,
        ...(shot.resumedFromLongFreeze
          ? { hint: 'Screen resumed from a long freeze; refresh pages if WebSockets or sessions expired.' }
          : {}),
      }
      return encodeShotResult(caller, meta, shot)
    },
  }), 'botmode: screen_screenshot tool')

  ctx.effect(() => ctx.tools.register({
    name: 'screen_click',
    description: 'Click at (x, y) on this Bot\'s 1280x720 virtual screen. Optionally set observe=true to return an updated screenshot.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'X coordinate (0..1279).' },
        y: { type: 'integer', description: 'Y coordinate (0..719).' },
        button: { type: 'integer', description: 'Mouse button: 1=left, 2=middle, 3=right.' },
        double: { type: 'boolean', description: 'Double-click when true.' },
        observe: { type: 'boolean', description: 'Capture and return updated screenshot after clicking.' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    output: { schema: SHOT_OUTPUT_SCHEMA, render: renderShotOutput },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return { text: JSON.stringify({ ok: false, error: 'This Session is not a Bot.' }) }
      const res = await screen.click(caller.bot, {
        x: Number(args?.x ?? 0),
        y: Number(args?.y ?? 0),
        button: Number(args?.button ?? 1),
        double: args?.double === true,
        observe: args?.observe === true,
        signal: exec?.signal,
      })
      const shot = res?.screenshot
      if (res && typeof res === 'object' && 'screenshot' in res) delete res.screenshot
      return encodeShotResult(caller, res, shot)
    },
  }), 'botmode: screen_click tool')

  ctx.effect(() => ctx.tools.register({
    name: 'screen_type',
    description: 'Type text into the focused element on this Bot\'s virtual screen (supports Chinese & emoji via clipboard paste). Use paste_key="shift+Insert" inside terminals.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to input.' },
        press_enter: { type: 'boolean', description: 'Press Enter after pasting.' },
        paste_key: { type: 'string', description: 'Paste shortcut: "ctrl+v" (default, browsers/GUI) or "shift+Insert" (terminals).' },
        observe: { type: 'boolean', description: 'Capture updated screenshot after typing.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: SHOT_OUTPUT_SCHEMA, render: renderShotOutput },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return { text: JSON.stringify({ ok: false, error: 'This Session is not a Bot.' }) }
      const res = await screen.type(caller.bot, {
        text: String(args?.text ?? ''),
        press_enter: args?.press_enter === true,
        paste_key: String(args?.paste_key || 'ctrl+v'),
        observe: args?.observe === true,
        signal: exec?.signal,
      })
      const shot = res?.screenshot
      if (res && typeof res === 'object' && 'screenshot' in res) delete res.screenshot
      return encodeShotResult(caller, res, shot)
    },
  }), 'botmode: screen_type tool')

  ctx.effect(() => ctx.tools.register({
    name: 'screen_key',
    description: 'Send a key or shortcut combination (e.g. "Return", "Escape", "ctrl+l", "alt+F4", "Page_Down") on this Bot\'s virtual screen.',
    parameters: {
      type: 'object',
      properties: {
        combo: { type: 'string', description: 'xdotool key combo.' },
        observe: { type: 'boolean', description: 'Capture updated screenshot afterwards.' },
      },
      required: ['combo'],
      additionalProperties: false,
    },
    output: { schema: SHOT_OUTPUT_SCHEMA, render: renderShotOutput },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return { text: JSON.stringify({ ok: false, error: 'This Session is not a Bot.' }) }
      const res = await screen.key(caller.bot, {
        combo: String(args?.combo ?? ''),
        observe: args?.observe === true,
        signal: exec?.signal,
      })
      const shot = res?.screenshot
      if (res && typeof res === 'object' && 'screenshot' in res) delete res.screenshot
      return encodeShotResult(caller, res, shot)
    },
  }), 'botmode: screen_key tool')

  ctx.effect(() => ctx.tools.register({
    name: 'screen_scroll',
    description: 'Scroll mouse wheel at (x, y) on this Bot\'s virtual screen. clicks > 0 scrolls down, clicks < 0 scrolls up.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'X coordinate (default 640).' },
        y: { type: 'integer', description: 'Y coordinate (default 360).' },
        clicks: { type: 'integer', description: 'Scroll clicks (+down / -up).' },
        observe: { type: 'boolean', description: 'Capture updated screenshot afterwards.' },
      },
      required: ['clicks'],
      additionalProperties: false,
    },
    output: { schema: SHOT_OUTPUT_SCHEMA, render: renderShotOutput },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return { text: JSON.stringify({ ok: false, error: 'This Session is not a Bot.' }) }
      const res = await screen.scroll(caller.bot, {
        x: Number(args?.x ?? 640),
        y: Number(args?.y ?? 360),
        clicks: Number(args?.clicks ?? 3),
        observe: args?.observe === true,
        signal: exec?.signal,
      })
      const shot = res?.screenshot
      if (res && typeof res === 'object' && 'screenshot' in res) delete res.screenshot
      return encodeShotResult(caller, res, shot)
    },
  }), 'botmode: screen_scroll tool')

  ctx.effect(() => ctx.tools.register({
    name: 'screen_drag',
    description: 'Drag mouse from (x1, y1) to (x2, y2) on this Bot\'s virtual screen.',
    parameters: {
      type: 'object',
      properties: {
        x1: { type: 'integer' },
        y1: { type: 'integer' },
        x2: { type: 'integer' },
        y2: { type: 'integer' },
        button: { type: 'integer' },
        observe: { type: 'boolean' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
      additionalProperties: false,
    },
    output: { schema: SHOT_OUTPUT_SCHEMA, render: renderShotOutput },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return { text: JSON.stringify({ ok: false, error: 'This Session is not a Bot.' }) }
      const res = await screen.drag(caller.bot, {
        x1: Number(args?.x1 ?? 0),
        y1: Number(args?.y1 ?? 0),
        x2: Number(args?.x2 ?? 0),
        y2: Number(args?.y2 ?? 0),
        button: Number(args?.button ?? 1),
        observe: args?.observe === true,
        signal: exec?.signal,
      })
      const shot = res?.screenshot
      if (res && typeof res === 'object' && 'screenshot' in res) delete res.screenshot
      return encodeShotResult(caller, res, shot)
    },
  }), 'botmode: screen_drag tool')

  ctx.effect(() => ctx.tools.register({
    name: 'screen_open_app',
    description: 'Launch an application ("chrome", "terminal", or "files") inside this Bot\'s isolated virtual screen, optionally opening a URL in Chrome, and observe the screen.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', enum: ['chrome', 'terminal', 'files'], description: 'Application to launch (default chrome).' },
        url: { type: 'string', description: 'Optional URL to open in Chrome.' },
      },
      additionalProperties: false,
    },
    output: { schema: SHOT_OUTPUT_SCHEMA, render: renderShotOutput },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return { text: JSON.stringify({ ok: false, error: 'This Session is not a Bot.' }) }
      const res = await screen.openApp(caller.bot, {
        app: String(args?.app || 'chrome'),
        url: args?.url ? String(args.url) : undefined,
        observe: true,
        signal: exec?.signal,
      })
      const shot = res?.screenshot
      if (res && typeof res === 'object' && 'screenshot' in res) delete res.screenshot
      return encodeShotResult(caller, res, shot)
    },
  }), 'botmode: screen_open_app tool')

  ctx.effect(() => ctx.tools.register({
    name: 'screen_windows',
    description: 'List visible windows and the focused window inside this Bot\'s virtual screen.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(_args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return JSON.stringify({ ok: false, error: 'This Session is not a Bot.' })
      const res = await screen.windows(caller.bot, { signal: exec?.signal })
      return JSON.stringify(res)
    },
  }), 'botmode: screen_windows tool')

  ctx.effect(() => ctx.tools.register({
    name: 'screen_request_help',
    description: 'ONLY call this for hard human-only blockers that cannot be solved autonomously (real CAPTCHA/slider verification, QR/SMS/hardware-key login or MFA, real payment confirmation, or explicit irreversible authorization). Do NOT call this for normal UI misses, slow page loads, scrolling, popups, or tasks solvable via retry, shortcuts, or shell commands — exhaust autonomous retries first.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['captcha', 'login', 'mfa', 'payment', 'confirm', 'manual'],
          description: 'Type of hard human-only blocker.',
        },
        reason: { type: 'string', description: 'Specific human-only blocker and exact action required from the human.' },
        tried: { type: 'string', description: 'Autonomous steps already attempted before requesting human intervention.' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    output: { schema: SHOT_OUTPUT_SCHEMA, render: renderShotOutput },
    async execute(args, exec) {
      const caller = await resolveCallerBot(exec)
      if (!caller) return { text: JSON.stringify({ ok: false, error: 'This Session is not a Bot.' }) }
      const reasonText = String(args?.reason || '').trim()
      const category = String(args?.category || 'manual').trim() || 'manual'
      if (reasonText.length < 8) {
        return {
          text: JSON.stringify({
            ok: false,
            error: 'Human intervention rejected: provide a specific hard blocker reason and exhaust autonomous retries first.',
          }),
        }
      }
      const triedText = String(args?.tried || '').trim()
      const fullReason = triedText ? `${reasonText}\n（已尝试：${triedText}）` : reasonText
      const res = await screen.requestHelp(caller.bot, {
        category,
        reason: fullReason,
        roomId: caller.roomId || '',
        signal: exec?.signal,
      })
      const shot = res?.screenshot
      if (res && typeof res === 'object' && 'screenshot' in res) delete res.screenshot
      return encodeShotResult(caller, res, shot)
    },
  }), 'botmode: screen_request_help tool')

  // Host system telemetry tool (disk, memory, CPU, uptime) via BotScreen gateway.
  ctx.effect(() => ctx.tools.register({
    name: 'system_info',
    description: 'Fetch host system metrics (disk usage, memory usage, CPU usage, and system uptime) transmitted through the BotScreen gateway.',
    parameters: {
      type: 'object',
      properties: {
        disk_path: {
          type: 'string',
          description: 'Optional comma-separated disk mount path(s) to inspect (defaults to configured disk paths, e.g. "/").',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      await ready
      const diskPath = typeof args?.disk_path === 'string' && args.disk_path.trim() !== ''
        ? args.disk_path.trim()
        : undefined
      const res = await api.getSystemInfo({ diskPaths: diskPath })
      return JSON.stringify(res)
    },
  }), 'botmode: system_info tool')

  // Agent reply artifact gateway publish tool: uploads file or text artifact to BotScreen gateway and returns download URLs.
  ctx.effect(() => ctx.tools.register({
    name: 'publish_artifact',
    description: 'Publish an Agent reply artifact (a workspace file path or inline text/HTML/JSON/Markdown/Base64 content) to the BotScreen gateway and return downloadable URLs.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable artifact title.' },
        filename: { type: 'string', description: 'Optional download filename (e.g. report.html, output.csv).' },
        type: { type: 'string', description: 'Artifact type: html, markdown, json, code, text, file, etc.' },
        kind: { type: 'string', enum: ['artifact', 'deliverable', 'file', 'reply'], description: 'Artifact category.' },
        content: { type: 'string', description: 'Inline artifact content (UTF-8 text or base64 when encoding="base64").' },
        encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Encoding for content (default utf-8).' },
        file_path: { type: 'string', description: 'Optional workspace file path (relative to Bot/Room workspace or absolute inside it) to upload.' },
        mime_type: { type: 'string', description: 'Optional explicit MIME type.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      await ready
      const caller = await resolveCallerBot(exec)
      const res = await api.publishArtifact({
        botId: caller?.bot?.id || '',
        roomId: caller?.roomId || '',
        title: args?.title,
        filename: args?.filename,
        type: args?.type,
        kind: args?.kind,
        content: args?.content,
        encoding: args?.encoding,
        filePath: args?.file_path,
        mimeType: args?.mime_type,
      })
      return JSON.stringify({
        ok: true,
        gatewaySynced: res.gatewaySynced,
        artifact: res.artifact,
      })
    },
  }), 'botmode: publish_artifact tool')

  // Human command for headless use and troubleshooting.
  ctx.effect(() => ctx.commands.register({
    name: 'botmode',
    description: 'Inspect or drive Bot mode from a Session: status, roster, dispatch, room, routine, memory, system, artifacts.',
    input: { hint: 'status | roster | dispatch <bot> <text> | room <roomId> <text> | routine <id> | memory <status|list|use|test|install|uninstall> | system [info|config|push [url]] | artifacts [list|delete <id>]' },
    handler: async ({ rawInput }) => {
      await ready
      const input = String(rawInput ?? '').trim()
      const space = input.indexOf(' ')
      const action = (space === -1 ? input : input.slice(0, space)).toLowerCase()
      const rest = space === -1 ? '' : input.slice(space + 1).trim()
      if (action === '' || action === 'status') {
        return {
          kind: 'success',
          text: JSON.stringify({
            root: store.root,
            memory: {
              provider: memory.activeId,
              health: memory.publicSummary().health,
            },
            bots: store.state.bots.map(bot => ({
              id: bot.id,
              name: bot.name,
              sessionId: bot.sessionId,
              busy: dispatcher.isBusy(bot.id),
              inRoom: dispatcher.inRoom(bot.id),
            })),
            rooms: store.state.rooms.map(room => ({
              id: room.id,
              name: room.name,
              status: room.status,
              epoch: room.epoch,
              budget: room.budget,
            })),
            routines: store.state.routines.map(routine => ({ id: routine.id, botId: routine.botId, cron: routine.cron, nextAt: routine.nextAt })),
          }, null, 2),
        }
      }
      if (action === 'roster') {
        return {
          kind: 'success',
          text: store.state.bots.map(bot => `${bot.id}  ${bot.name}${bot.role ? ` — ${bot.role}` : ''}`).join('\n') || '(no Bots)',
        }
      }
      if (action === 'dispatch') {
        const split = rest.indexOf(' ')
        const target = split === -1 ? rest : rest.slice(0, split)
        const text = split === -1 ? '' : rest.slice(split + 1).trim()
        const bot = store.bot(target) ?? store.state.bots.find(item => item.name.toLowerCase() === target.toLowerCase())
        if (!bot || text === '') return { kind: 'error', text: 'Use: dispatch <bot> <text>' }
        dispatcher.dispatch(bot.id, text, { source: 'command' })
        return { kind: 'success', text: `Dispatched to ${bot.name}.` }
      }
      if (action === 'room') {
        const split = rest.indexOf(' ')
        const roomId = split === -1 ? rest : rest.slice(0, split)
        const text = split === -1 ? '' : rest.slice(split + 1).trim()
        if (text === '') return { kind: 'error', text: 'Use: room <roomId> <text>' }
        await rooms.send(roomId, text)
        return { kind: 'success', text: 'Room turn started.' }
      }
      if (action === 'routine') {
        if (rest === '') return { kind: 'error', text: 'Use: routine <routineId>' }
        await routines.runNow(rest)
        return { kind: 'success', text: 'Routine dispatched.' }
      }
      if (action === 'memory') {
        const parts = rest.split(/\s+/).filter(Boolean)
        const sub = (parts[0] || 'status').toLowerCase()
        const arg = parts.slice(1).join(' ').trim()
        if (sub === 'status' || sub === 'list') {
          return { kind: 'success', text: JSON.stringify(await memory.status(), null, 2) }
        }
        if (sub === 'use' || sub === 'select') {
          if (!arg) return { kind: 'error', text: 'Use: memory use <providerId>' }
          const next = await memory.select(arg)
          return { kind: 'success', text: `Active memory provider: ${next.provider} (${next.health?.detail || 'ok'})` }
        }
        if (sub === 'test') {
          const tested = await memory.test(arg)
          return { kind: 'success', text: JSON.stringify(tested, null, 2) }
        }
        if (sub === 'install') {
          if (!arg) return { kind: 'error', text: 'Use: memory install <catalog:id | npm:pkg | git-url | local-path>' }
          const installed = await memory.install(arg, { activate: true })
          return { kind: 'success', text: `Installed and activated memory plugin: ${installed.installed.id}` }
        }
        if (sub === 'uninstall') {
          if (!arg) return { kind: 'error', text: 'Use: memory uninstall <providerId>' }
          await memory.uninstall(arg)
          return { kind: 'success', text: `Uninstalled memory plugin: ${arg}` }
        }
        return { kind: 'error', text: 'Use: memory <status|list|use|test|install|uninstall>' }
      }
      if (action === 'system') {
        const parts = rest.split(/\s+/).filter(Boolean)
        const sub = (parts[0] || 'info').toLowerCase()
        const arg = parts.slice(1).join(' ').trim()
        if (sub === 'info' || sub === 'status') {
          const data = await api.getSystemInfo({ diskPaths: arg || undefined })
          return { kind: 'success', text: JSON.stringify(data, null, 2) }
        }
        if (sub === 'config') {
          const data = await api.getSystemConfig()
          return { kind: 'success', text: JSON.stringify(data, null, 2) }
        }
        if (sub === 'push') {
          const data = await api.pushSystemInfo(arg ? { url: arg } : {})
          return { kind: data?.ok !== false ? 'success' : 'error', text: JSON.stringify(data, null, 2) }
        }
        return { kind: 'error', text: 'Use: system <info [disk_path]|config|push [url]>' }
      }
      if (action === 'artifacts' || action === 'artifact') {
        const parts = rest.split(/\s+/).filter(Boolean)
        const sub = (parts[0] || 'list').toLowerCase()
        const arg = parts.slice(1).join(' ').trim()
        if (sub === 'list') {
          const data = await api.listArtifacts({ botId: arg || '' })
          return { kind: 'success', text: JSON.stringify(data, null, 2) }
        }
        if (sub === 'delete' || sub === 'rm') {
          if (!arg) return { kind: 'error', text: 'Use: artifacts delete <artifactId>' }
          const data = await api.deleteArtifact({ artifactId: arg })
          return { kind: 'success', text: JSON.stringify(data, null, 2) }
        }
        return { kind: 'error', text: 'Use: artifacts <list [botId]|delete <artifactId>>' }
      }
      if (action === 'scaffold') {
        await syncTeamFiles(store, store.state)
        for (const bot of store.state.bots) await syncBotFiles(store, bot, store.state)
        return { kind: 'success', text: 'Bot identity files rewritten.' }
      }
      return { kind: 'error', text: 'Unknown action.' }
    },
  }), 'botmode: command')

  ctx.inject(['webServer', 'connection'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: PREFIX.replace(/\/$/, ''),
      handler: (req, res) => api.handle(req, res),
    }), 'botmode: api route')
  })

  logger?.info?.(`botmode: state at ${store.root}`)
}
