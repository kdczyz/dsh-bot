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
import { botModelCatalog, resolveBotSelection } from './host/models.js'

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
const DEFAULT_PRIMARY_TOOLS = ['message_agent', 'bot_team', ...MEMORY_TOOLS]
const DEFAULT_ROOM_TOOLS = ['bot_team', ...MEMORY_TOOLS]

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
  const rooms = new Rooms(store, dispatcher, logger)
  const routines = new Routines(ctx, store, dispatcher, logger)
  const approvals = new Approvals(store, logger)
  const api = new BotApi({ ctx, store, dispatcher, rooms, routines, approvals, memory, logger })

  const ready = store.load()
    .then(() => memory.ensureReady())
    .catch((error) => {
      logger?.warn?.(`botmode: startup initialization warning: ${String(error)}`)
    })

  ctx.effect(() => routines.start(), 'botmode: persistent routines')
  ctx.effect(() => () => approvals.clear(), 'botmode: approval cleanup')
  ctx.effect(() => () => { void memory.shutdown() }, 'botmode: memory hub shutdown')

  // Bridge approvals for BOTH primary Bot sessions and isolated hidden Group Room sessions.
  const approvalOff = ctx.on('approval/request', (request, next) => {
    const sessionId = sessionIdOf(request?.agent)
    const resolved = sessionId ? store.botByAnySession(sessionId) : undefined
    if (!resolved) return next()
    return approvals.ask(resolved.bot, request)
  })
  ctx.effect(() => approvalOff, 'botmode: approval bridge')

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
        const baseDeny = isRoom ? [...bot.tools.deny, 'message_agent'] : bot.tools.deny
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

  // Human command for headless use and troubleshooting.
  ctx.effect(() => ctx.commands.register({
    name: 'botmode',
    description: 'Inspect or drive Bot mode from a Session: status, roster, dispatch, room, routine, memory.',
    input: { hint: 'status | roster | dispatch <bot> <text> | room <roomId> <text> | routine <id> | memory <status|list|use|test|install|uninstall>' },
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
      if (action === 'scaffold') {
        await syncTeamFiles(store, store.state)
        for (const bot of store.state.bots) await syncBotFiles(store, bot, store.state)
        return { kind: 'success', text: 'Bot identity files rewritten.' }
      }
      return { kind: 'error', text: 'Unknown action.' }
    },
  }), 'botmode: command')

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: PREFIX.replace(/\/$/, ''),
      handler: (req, res) => api.handle(req, res),
    }), 'botmode: api route')
  })

  logger?.info?.(`botmode: state at ${store.root}`)
}
