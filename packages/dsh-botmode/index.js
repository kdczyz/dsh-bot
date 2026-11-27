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
import { isAbsolute, join, relative, resolve } from 'node:path'
import { BotStore } from './host/store.js'
import { Dispatcher } from './host/dispatch.js'
import { Rooms } from './host/rooms.js'
import { Routines } from './host/routines.js'
import { BotApi, PREFIX } from './host/api.js'
import { Approvals } from './host/approvals.js'
import { MemoryManager } from './host/memory/manager.js'
import { BotMcpRegistry } from './host/mcp.js'
import { NotificationHub, WebhookManager } from './host/channels.js'
import { personaBlock, seedInitialMemoryHub, syncBotFiles, syncTeamFiles } from './host/persona.js'
import { botModelCatalog, modelAcceptsImages, resolveBotSelection } from './host/models.js'
import { checkRoomWriteSoftLock, extractMutatedPathsFromTool } from './host/room-locks.js'
import { ScreenBridge } from './host/screen.js'
import {
  createBotScopedSkillTool,
  installPurgeHungGuard,
  installSessionAndWorkspaceIsolation,
  isBotSession,
  isNormalModeOnlyTool,
  isolateBotPreStepMessages,
  registerBotSkillsForNormalMode,
  sanitizeBotAssembly,
  wrapBotAgentStep,
} from './host/isolation.js'

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
const ORCHESTRATION_TOOLS = ['bot_manage', 'room_manage']
const ROOM_COORDINATION_TOOLS = ['claim_subtask', 'room_task_progress', 'room_finish_task']
const DEFAULT_PRIMARY_TOOLS = ['message_agent', 'bot_team', 'scheduled_tasks', ...ORCHESTRATION_TOOLS, ...MEMORY_TOOLS, ...SCREEN_TOOLS, ...SYSTEM_TOOLS, ...ARTIFACT_TOOLS]
const DEFAULT_ROOM_TOOLS = ['bot_team', ...ROOM_COORDINATION_TOOLS, ...MEMORY_TOOLS, ...SCREEN_TOOLS, ...SYSTEM_TOOLS, ...ARTIFACT_TOOLS]
export const ALL_BOT_SCOPED_TOOLS = [
  'message_agent',
  'bot_team',
  'scheduled_tasks',
  ...ORCHESTRATION_TOOLS,
  ...ROOM_COORDINATION_TOOLS,
  ...MEMORY_TOOLS,
  ...SCREEN_TOOLS,
  ...SYSTEM_TOOLS,
  ...ARTIFACT_TOOLS,
]
const BOT_SCOPED_TOOL_SET = new Set(ALL_BOT_SCOPED_TOOLS)

const sessionIdOf = (agent) => {
  try {
    return agent?.session?.id ?? agent?.session?.header?.id
  } catch (_error) {
    return undefined
  }
}

const sessionCwdOf = (agent) => {
  try {
    return agent?.cwd ?? agent?.session?.header?.cwd ?? ''
  } catch (_error) {
    return ''
  }
}

export function apply(ctx) {
  const logger = ctx.logger
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const store = new BotStore(join(home, 'botmode'))
  const memory = new MemoryManager(store, logger)
  const mcp = new BotMcpRegistry(ctx, store, logger)
  const dispatcher = new Dispatcher(
    ctx,
    store,
    logger,
    (agent, bot, meta) => configureAgent(agent, bot, meta),
    memory,
  )
  const approvals = new Approvals(store, logger)
  const screen = new ScreenBridge({ approvals, logger, logDir: store.root })
  const rooms = new Rooms(store, dispatcher, logger, approvals)
  const routines = new Routines(ctx, store, dispatcher, logger, { rooms })
  const notifications = new NotificationHub({ store, logger })
  const webhooks = new WebhookManager({ store, dispatcher, rooms, logger })
  const api = new BotApi({
    ctx,
    store,
    dispatcher,
    rooms,
    routines,
    approvals,
    memory,
    mcp,
    screen,
    notifications,
    webhooks,
    logger,
  })
  dispatcher.setArtifactHandler(event => api.syncReplyArtifacts(event))
  dispatcher.setBudgetExceededHandler((info) => {
    void notifications.notify({
      kind: 'budget_exceeded',
      title: `Token budget exceeded: ${info?.bot?.name || info?.bot?.id || 'Bot'}`,
      summary: `Used ${info?.used ?? 0} / ${info?.limit ?? 0} tokens on ${info?.day || 'today'}.`,
      botName: info?.bot?.name || '',
      meta: {
        botId: info?.bot?.id || '',
        used: info?.used ?? 0,
        limit: info?.limit ?? 0,
        day: info?.day || '',
      },
    })
  })
  rooms.setArtifactHandler(event => api.syncDeliverables(event))
  rooms.setCompletionHandler((event) => {
    const room = event?.room
    const comp = event?.completion
    void notifications.notify({
      kind: 'room_complete',
      title: `Group Room completed: ${room?.name || room?.id || 'Room'}`,
      summary: comp?.summary || 'Task marked completed.',
      botName: comp?.finishedByName || event?.bot?.name || '',
      roomName: room?.name || '',
      meta: {
        roomId: room?.id || '',
        deliverables: Array.isArray(comp?.deliverables) ? comp.deliverables : [],
      },
    })
  })
  const offApprovalNotify = approvals.onChange((ev) => {
    if (!ev || typeof ev !== 'object') return
    if (ev.kind === 'approval_pending' && ev.approval) {
      void notifications.notify({
        kind: 'approval',
        title: `Approval needed: ${ev.approval.botName || 'Bot'} → ${ev.approval.toolName || 'tool'}`,
        summary: ev.approval.reason || 'Awaiting human approval.',
        botName: ev.approval.botName || '',
        meta: { approvalId: ev.approval.id, toolName: ev.approval.toolName },
      })
    } else if (ev.kind === 'question_pending' && ev.question) {
      void notifications.notify({
        kind: 'question',
        title: `Question from ${ev.question.botName || 'Bot'}`,
        summary: ev.question.prompt || 'Awaiting your answer.',
        botName: ev.question.botName || '',
        meta: { questionId: ev.question.id },
      })
    } else if (ev.kind === 'screen_help_pending' && ev.help) {
      void notifications.notify({
        kind: 'screen_help',
        title: `Human screen takeover requested: ${ev.help.botName || 'Bot'}`,
        summary: ev.help.reason || 'CAPTCHA / login / manual verification required.',
        botName: ev.help.botName || '',
        meta: { helpId: ev.help.id },
      })
    }
  })
  ctx.effect(() => offApprovalNotify, 'botmode: outbound notification bridge')

  const ready = store.load()
    .then(async () => {
      await memory.ensureReady()
      await mcp.load().catch(() => undefined)
      mcp.syncToHostManager()
      // Apply saved gateway / system monitoring settings before warming up the gateway.
      const sysCfg = store.state?.settings?.system
      if (sysCfg && typeof sysCfg === 'object') {
        screen.configure({
          gatewayUrl: sysCfg.gatewayUrl || '',
          adminToken: sysCfg.adminToken || '',
        })
      }
      // Ensure existing Bot workspaces pick up built-in skills, initial MEMORY.md & Memory Hub bootstrap seed.
      for (const bot of store.state.bots) {
        if (bot.dir) await syncBotFiles(store, bot, store.state).catch(() => undefined)
        await seedInitialMemoryHub(memory, store, bot).catch(() => undefined)
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
  ctx.effect(() => () => mcp.dispose(), 'botmode: mcp registry shutdown')
  ctx.effect(() => installPurgeHungGuard(), 'botmode: purge hung-prompt isolation')
  ctx.effect(() => installSessionAndWorkspaceIsolation(ctx, store, ready, logger), 'botmode: session & workspace sidebar isolation')

  // Share Bot skills & Bot MCP with normal DSH mode at LOWER precedence than normal-mode assets
  // (Normal mode: Normal > Bot; Bot mode: Bot > Normal).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (scope) => {
      scope.effect(() => registerBotSkillsForNormalMode(scope, store), 'botmode: shared skills provider for normal mode')
    })
    ctx.inject(['mcpManager'], (scope) => {
      void ready.then(() => mcp.syncToHostManager(scope.mcpManager)).catch(() => undefined)
    })
  } else if (ctx.get?.('skills')) {
    ctx.effect(() => registerBotSkillsForNormalMode(ctx, store), 'botmode: shared skills provider for normal mode')
  }

  // Helper to resolve whether an Agent belongs to Bot Mode (primary chat or hidden room session).
  const resolveBotForAgent = (agent) => {
    const sessionId = sessionIdOf(agent)
    const resolved = sessionId ? store.botByAnySession(sessionId) : undefined
    if (resolved) return { ...resolved, sessionId }
    return undefined
  }

  // Prompt isolation (layer 1): strip normal-mode sections/tools during system-prompt/assemble for Bot sessions.
  const assembleOff = ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = typeof next === 'function' ? await next() : assembly
    const agent = context?.agent ?? context?.scope
    const sessionId = sessionIdOf(agent)
    const cwd = sessionCwdOf(agent)
    if (!isBotSession(store, sessionId, cwd)) return assembled
    return sanitizeBotAssembly(assembled)
  }, { global: true })
  ctx.effect(() => assembleOff, 'botmode: prompt isolation assemble hook')

  // Pre-step isolation: remove normal-mode `agent-instructions`, normal `skill-catalog`/`skill-invocation`,
  // and `dsh-purge` message injections for Bot sessions, then attach Bot-only skill catalog & `/skill` gestures.
  const preStepOff = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    const agent = payload?.agent
    const resolved = resolveBotForAgent(agent)
    const sessionId = sessionIdOf(agent)
    const cwd = sessionCwdOf(agent)
    if (!resolved && !isBotSession(store, sessionId, cwd)) return decision
    const messages = await isolateBotPreStepMessages({
      store,
      bot: resolved?.bot ?? (cwd ? { dir: cwd } : null),
      agent,
      hostSkills: ctx.get?.('skills') ?? null,
      incomingMessages: payload?.messages,
      decisionMessages: decision.messages,
    })
    return { ...decision, messages }
  }, { global: true })
  ctx.effect(() => preStepOff, 'botmode: skill & instruction pre-step isolation')

  // Bridge approvals & interactive questions for BOTH primary Bot sessions and isolated Group Room sessions.
  const approvalOff = ctx.on('approval/request', async (request, next) => {
    const sessionId = sessionIdOf(request?.agent)
    const resolved = sessionId ? store.botByAnySession(sessionId) : undefined
    if (!resolved) return next()
    const toolName = String(request?.toolName ?? '')
    if (resolved.kind === 'routine' && resolved.routineId && routines.allowsTool(resolved.routineId, toolName)) {
      return 'allowed-once'
    }
    const decision = await approvals.ask(resolved.bot, request, { roomId: resolved.roomId || '', sessionId })
    if (decision === 'rejected' && resolved.kind === 'routine' && resolved.runId) {
      routines.noteApprovalDenied(resolved.runId, toolName)
    }
    return decision
  })
  ctx.effect(() => approvalOff, 'botmode: approval bridge')

  const questionOff = ctx.on('user-questions/request', (request, next) => {
    const sessionId = sessionIdOf(request?.agent)
    const resolved = sessionId ? store.botByAnySession(sessionId) : undefined
    if (!resolved) return next()
    return approvals.askQuestion(resolved.bot, request, { roomId: resolved.roomId || '' })
  })
  ctx.effect(() => questionOff, 'botmode: user-questions bridge')

  // Path Soft-Lock + Bidirectional Tool/MCP isolation interceptor:
  //   1. Bot sessions can NEVER invoke normal-mode-only tools or normal-mode MCP tools.
  //   2. Normal sessions can NEVER invoke Bot-only tools.
  //   3. Concurrent Group Room Bots cannot overwrite files leased by a teammate via `claim_subtask`.
  const evaluateToolGuard = (exec) => {
    const sessionId = sessionIdOf(exec?.agent)
    const cwd = sessionCwdOf(exec?.agent)
    const toolName = String(exec?.name ?? '')
    const botSession = isBotSession(store, sessionId, cwd)
    if (botSession && isNormalModeOnlyTool(toolName)) {
      return `Tool "${toolName}" belongs to normal DSH mode and is isolated from Bot Mode.`
    }
    if (!botSession && BOT_SCOPED_TOOL_SET.has(toolName)) {
      return `Tool "${toolName}" is only available inside Bot Mode sessions.`
    }
    if (!sessionId) return undefined
    const resolved = store.botByAnySession(sessionId)
    if (!resolved) return undefined

    // Optional workspace write boundary guard for non-admin Bots in 1:1 sessions.
    if (
      resolved.kind !== 'room'
      && store.state?.settings?.governance?.protectExternalWrites === true
      && resolved.bot?.permissionRole !== 'admin'
      && resolved.bot?.dir
    ) {
      const mutated = extractMutatedPathsFromTool(toolName, exec?.arguments, resolved.bot.dir)
      const rootDir = resolve(resolved.bot.dir)
      for (const candidate of mutated) {
        const target = resolve(candidate)
        const rel = relative(rootDir, target)
        const inside = target === rootDir || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel))
        if (!inside) {
          return `Write blocked by Bot workspace boundary (protectExternalWrites): "${candidate}" is outside "${rootDir}". Grant admin role or disable protectExternalWrites to allow external writes.`
        }
      }
    }

    if (store.state?.settings?.groupChat?.enableSoftLock === false) return undefined
    if (resolved.kind !== 'room' || !resolved.roomId) return undefined
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
    const denyReason = evaluateToolGuard(exec)
    if (denyReason) return { kind: 'deny', reason: denyReason }
    return next()
  })
  ctx.effect(() => preExecuteOff, 'botmode: isolation & room soft-lock pre-execute')

  if (typeof ctx.tools?.guard === 'function') {
    ctx.effect(() => ctx.tools.guard((exec) => evaluateToolGuard(exec)), 'botmode: isolation & room soft-lock guard')
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

  // Persona, isolation step guard, scoped Bot tools & skills, memory block, model binding,
  // tool policy, permanent-chat commands and approval policy are applied once per live Bot Agent
  // (both primary & room). Uses a WeakMap of Promises so concurrent callers (`agent/created` +
  // `dispatcher.#announce`) both await full completion before the first turn starts.
  const configurePromises = new WeakMap()
  function configureAgent(agent, bot, meta = { kind: 'primary', roomId: '' }) {
    if (!agent || !bot) return Promise.resolve()
    const inflight = configurePromises.get(agent)
    if (inflight) return inflight
    const task = configureAgentOnce(agent, bot, meta)
    configurePromises.set(agent, task)
    return task
  }

  async function configureAgentOnce(agent, bot, meta = { kind: 'primary', roomId: '' }) {
    const isRoom = meta?.kind === 'room'

    // Prompt & MCP/tool final-stage isolation on this Bot Agent's `step()` method.
    try {
      const unwrapStep = wrapBotAgentStep(agent)
      if (typeof agent.ctx?.effect === 'function') {
        agent.ctx.effect(() => unwrapStep, `botmode: step isolation for ${bot.name}`)
      }
    } catch (error) {
      logger?.warn?.(`botmode: step isolation for ${bot.name} failed: ${String(error)}`)
    }

    try {
      await memory.ensureReady().catch(() => undefined)
      const memoryPromptBlock = memory.systemPromptBlockForBot(bot)
      const mcpPromptBlock = mcp.systemPromptIndexBlock()
      const persona = await personaBlock(store, bot, store.state, {
        kind: isRoom ? 'room' : 'primary',
        roomId: meta?.roomId || '',
        memoryPromptBlock,
        mcpPromptBlock,
      })
      agent.ctx.effect(() => {
        const prompt = agent.ctx.get('systemPrompt')
        if (!prompt) return
        return prompt.section({ name: `botmode:persona:${bot.id}`, order: 500, text: persona })
      }, `botmode: persona for ${bot.name}`)
    } catch (error) {
      logger?.warn?.(`botmode: persona for ${bot.name} failed: ${String(error)}`)
    }

    // Bidirectional Tool isolation & Shared Skill/MCP priority:
    //   1. Restrict inherited/global tools to deny normal-mode-only non-MCP tools.
    //   2. Register Bot-only tools + Bot-priority `skill` tool strictly into `agent.ctx` (own scope layer),
    //      so normal-mode sessions NEVER see Bot tools, while Bot skills take top precedence in Bot Mode.
    try {
      const tools = agent.ctx.get('tools')
      if (tools) {
        const restrictable = tools.view && typeof tools.view === 'function'
          ? new Set(tools.view(agent)?.restrictableNames ?? [])
          : new Set((tools.definitions?.() ?? []).map(entry => entry.name))
        const normalModeDenies = [...restrictable].filter(toolName => isNormalModeOnlyTool(toolName))
        const explicitDenies = (Array.isArray(bot.tools?.deny) ? bot.tools.deny : [])
          .filter(toolName => restrictable.has(toolName))
        const deny = [...new Set([...normalModeDenies, ...explicitDenies])]
        const denySet = new Set(deny)
        const allow = Array.isArray(bot.tools?.allow) && bot.tools.allow.length > 0
          ? [...new Set(bot.tools.allow)].filter(toolName => restrictable.has(toolName) && !denySet.has(toolName))
          : undefined
        if ((allow !== undefined && allow.length > 0) || deny.length > 0) {
          agent.ctx.effect(() => tools.restrict({
            ...(allow !== undefined && allow.length > 0 ? { allow } : {}),
            ...(deny.length > 0 ? { deny } : {}),
          }), `botmode: tool isolation for ${bot.name}`)
        }

        // Register Bot-only tools & Bot-priority `skill` loader strictly on this Bot's scope.
        if (typeof tools.register === 'function') {
          const explicitBotDenies = new Set(Array.isArray(bot.tools?.deny) ? bot.tools.deny : [])
          const scopedDefs = [
            createBotScopedSkillTool(store, bot, { hostSkills: ctx.get?.('skills') ?? null, agent }),
            ...buildBotToolDefinitions(isRoom),
          ]
          for (const def of scopedDefs) {
            if (explicitBotDenies.has(def.name)) continue
            agent.ctx.effect(() => tools.register(def), `botmode: scoped tool ${def.name} for ${bot.name}`)
          }
        }
      }
    } catch (error) {
      logger?.warn?.(`botmode: tool policy for ${bot.name} failed: ${String(error)}`)
    }

    // Mount Bot-priority MCP override clients onto this Bot's scoped `agent.ctx`
    // whenever a Bot MCP server collides by name with a normal-mode MCP server.
    try {
      await mcp.mountBotOverrides(agent.ctx)
    } catch (error) {
      logger?.warn?.(`botmode: MCP override mount for ${bot.name} failed: ${String(error)}`)
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
    await store.load()
    const sessionId = sessionIdOf(exec?.agent)
    if (!sessionId) return undefined
    const resolved = store.botByAnySession(sessionId)
    return resolved ? { ...resolved, sessionId } : undefined
  }

  // Governance approval gate for high-impact Bot/Room lifecycle mutations (`bot_manage`, `room_manage`).
  const requireGovernanceApproval = async (caller, toolName, reason) => {
    const gov = store.state?.settings?.governance
    if (gov?.requireApprovalForBotCrud === false) return { allowed: true }
    if (caller.bot.permissionRole === 'admin' || caller.bot.approvalPolicy === 'always') {
      return { allowed: true }
    }
    const decision = await approvals.ask(caller.bot, {
      toolName,
      reason,
    }, { roomId: caller.roomId || '', sessionId: caller.sessionId })
    if (decision === 'allowed-once' || decision === 'allowed-session') {
      return { allowed: true }
    }
    return { allowed: false, decision }
  }

  // ---- Per-Bot Virtual Screen helpers (auto-scoped to caller Bot) ----------
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

  const makeMemorySearchTool = (toolName) => ({
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
  })

  const makeConversationSearchTool = (toolName) => ({
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
  })

  const makeReadSceneTool = (toolName) => ({
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
  })

  // Build Bot-only tool definitions registered strictly inside each Bot's `agent.ctx`
  // (NEVER into global `ctx.tools`, guaranteeing zero leakage into normal DSH mode).
  function buildBotToolDefinitions(isRoom) {
    const defs = []
    if (!isRoom) {
      defs.push({
        name: 'scheduled_tasks',
        description: 'Manage your own scheduled tasks (routines): list, get, create, update, pause, resume, run, remove, history. Always scoped to you. Schedules accept shorthands like "every 30m", "daily 09:00", "weekdays 09:00", "weekly mon 10:00", "at 2026-12-01 09:00", or a five-field cron expression.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'get', 'create', 'update', 'pause', 'resume', 'run', 'remove', 'history'],
              description: 'Operation to perform.',
            },
            id: { type: 'string', description: 'Task id (for get, update, pause, resume, run, remove, history).' },
            name: { type: 'string', description: 'Short task name.' },
            prompt: { type: 'string', description: 'Instruction to execute when triggered.' },
            schedule: {
              description: 'Schedule shorthand string (e.g. "daily 09:00", "every 30m", "at 2026-12-01 09:00") or object { kind: "cron"|"every"|"at", cron?, everyMs?, at?, tz?, exact? }.',
            },
            tz: { type: 'string', description: 'Optional IANA time zone (e.g. "Asia/Shanghai").' },
            policy: {
              type: 'object',
              description: 'Optional execution policy: { session?: "fresh"|"named"|"primary", overlap?: "skip"|"queue"|"terminate", misfire?: "run_once"|"skip", deliver?: "announce"|"none"|"room:<id>", repeat?: number, deleteAfterRun?: boolean }.',
            },
            limit: { type: 'integer', description: 'Max history entries for action="history" (default 10, max 50).' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const caller = await resolveCallerBot(exec)
          if (!caller) return JSON.stringify({ ok: false, error: 'This Session is not a Bot.' })
          if (caller.kind === 'room') {
            return JSON.stringify({ ok: false, code: 'unavailable_in_room', error: 'scheduled_tasks is unavailable inside a Group Room.' })
          }
          const res = await routines.toolCall(caller, args)
          return JSON.stringify(res)
        },
      })
      defs.push({
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
      })
      defs.push({
        name: 'bot_manage',
        description: 'Control Bot roster capacity (CRUD): list, get, create, update, or delete Bots. Self-deletion is disallowed; follow the `bot-team-control` skill before mutating the team.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], description: 'Operation to perform.' },
            botId: { type: 'string', description: 'Target Bot id or exact name (required for get, update, delete).' },
            name: { type: 'string', description: 'Bot display name (required for create; optional for update).' },
            role: { type: 'string', description: 'Concise role or specialty description.' },
            instructions: { type: 'string', description: 'Standing instructions written into SOUL.md.' },
            approvalPolicy: { type: 'string', enum: ['ask', 'always', 'never'], description: 'Approval policy for the Bot.' },
            model: {
              type: 'object',
              description: 'Optional model override { provider, model, reasoningEffort }.',
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
                reasoningEffort: { type: 'string' },
              },
              additionalProperties: false,
            },
            tools: {
              type: 'object',
              description: 'Optional tool policy { allow: string[], deny: string[] }.',
              properties: {
                allow: { type: 'array', items: { type: 'string' } },
                deny: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const caller = await resolveCallerBot(exec)
          if (!caller) return JSON.stringify({ ok: false, error: 'This Session is not a Bot.' })
          if (caller.kind === 'room') {
            return JSON.stringify({ ok: false, code: 'unavailable_in_room', error: 'bot_manage is unavailable inside a Group Room.' })
          }
          const action = String(args?.action ?? 'list')
          const resolveTarget = (token) => {
            const key = String(token ?? '').trim()
            if (!key) return undefined
            return store.bot(key) ?? store.state.bots.find(b => b.name.toLowerCase() === key.toLowerCase())
          }
          try {
            if (action === 'list') {
              return JSON.stringify({
                ok: true,
                count: store.state.bots.length,
                bots: store.state.bots.map(b => ({
                  id: b.id,
                  name: b.name,
                  role: b.role,
                  approvalPolicy: b.approvalPolicy,
                  dir: b.dir,
                  running: dispatcher.isRunning(b.id),
                  inRoom: dispatcher.inRoom(b.id),
                  me: b.id === caller.bot.id,
                })),
              })
            }
            if (action === 'get') {
              const target = resolveTarget(args?.botId ?? args?.name)
              if (!target) return JSON.stringify({ ok: false, error: 'Unknown Bot.' })
              return JSON.stringify({ ok: true, bot: target })
            }
            if (action === 'create') {
              const gate = await requireGovernanceApproval(
                caller,
                'bot_manage',
                `Create new Bot "${String(args?.name ?? '').trim() || '(unnamed)'}" (role: ${String(args?.role ?? 'general')})`,
              )
              if (!gate.allowed) {
                return JSON.stringify({
                  ok: false,
                  code: 'approval_denied',
                  error: `Creating Bot "${String(args?.name ?? '')}" was denied by human approval (${gate.decision}).`,
                })
              }
              const res = await api.command({
                type: 'bot.save',
                draft: {
                  name: args?.name,
                  role: args?.role,
                  instructions: args?.instructions,
                  approvalPolicy: args?.approvalPolicy,
                  model: args?.model,
                  tools: args?.tools,
                },
              })
              return JSON.stringify({ ok: true, bot: res.bot })
            }
            if (action === 'update') {
              const target = resolveTarget(args?.botId)
              if (!target) return JSON.stringify({ ok: false, error: 'Unknown Bot.' })
              const res = await api.command({
                type: 'bot.save',
                botId: target.id,
                draft: {
                  ...(args?.name !== undefined ? { name: args.name } : {}),
                  ...(args?.role !== undefined ? { role: args.role } : {}),
                  ...(args?.instructions !== undefined ? { instructions: args.instructions } : {}),
                  ...(args?.approvalPolicy !== undefined ? { approvalPolicy: args.approvalPolicy } : {}),
                  ...(args?.model !== undefined ? { model: args.model } : {}),
                  ...(args?.tools !== undefined ? { tools: args.tools } : {}),
                },
              })
              return JSON.stringify({ ok: true, bot: res.bot })
            }
            if (action === 'delete') {
              const target = resolveTarget(args?.botId)
              if (!target) return JSON.stringify({ ok: false, error: 'Unknown Bot.' })
              if (target.id === caller.bot.id) {
                return JSON.stringify({ ok: false, code: 'self_delete_forbidden', error: 'Cannot delete the calling Bot itself.' })
              }
              if (dispatcher.isRunning(target.id)) {
                return JSON.stringify({ ok: false, code: 'bot_busy', error: `Bot "${target.name}" is currently running; wait for it to finish before deleting.` })
              }
              const gate = await requireGovernanceApproval(
                caller,
                'bot_manage',
                `Delete Bot "${target.name}" (${target.id}) and purge its workspace`,
              )
              if (!gate.allowed) {
                return JSON.stringify({
                  ok: false,
                  code: 'approval_denied',
                  error: `Deleting Bot "${target.name}" was denied by human approval (${gate.decision}).`,
                })
              }
              await api.command({ type: 'bot.delete', botId: target.id })
              return JSON.stringify({ ok: true, deleted: { id: target.id, name: target.name } })
            }
            return JSON.stringify({ ok: false, error: `Unknown action "${action}".` })
          } catch (error) {
            return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      defs.push({
        name: 'room_manage',
        description: 'Create and orchestrate multi-Bot Group Rooms: list, get, create, update, delete, send (kick off or continue a room task), or control (pause/resume/stop). Member references accept Bot ids or names.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'send', 'control'], description: 'Operation to perform.' },
            roomId: { type: 'string', description: 'Target Group Room id (required for get, update, delete, send, control).' },
            name: { type: 'string', description: 'Group Room name (required for create).' },
            purpose: { type: 'string', description: 'Concise room goal or mission.' },
            notes: { type: 'string', description: 'Optional shared notes.' },
            workDir: { type: 'string', description: 'Optional shared working directory for all room members.' },
            memberIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of 1-6 member Bot ids or exact Bot names.',
            },
            mode: { type: 'string', enum: ['auto', 'lead', 'everyone'], description: 'Routing mode (default "auto").' },
            leadBotId: { type: 'string', description: 'Optional Lead Bot id or name (used by "lead" / "auto" modes).' },
            text: { type: 'string', description: 'Message text to send when action="send".' },
            controlAction: { type: 'string', enum: ['pause', 'resume', 'stop'], description: 'Control action when action="control".' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const caller = await resolveCallerBot(exec)
          if (!caller) return JSON.stringify({ ok: false, error: 'This Session is not a Bot.' })
          if (caller.kind === 'room') {
            return JSON.stringify({ ok: false, code: 'unavailable_in_room', error: 'room_manage is unavailable inside a Group Room.' })
          }
          const action = String(args?.action ?? 'list')
          const resolveBotId = (token) => {
            const key = String(token ?? '').trim()
            if (!key) return ''
            const found = store.bot(key) ?? store.state.bots.find(b => b.name.toLowerCase() === key.toLowerCase())
            return found ? found.id : ''
          }
          try {
            if (action === 'list') {
              return JSON.stringify({
                ok: true,
                rooms: store.state.rooms.map(r => ({
                  id: r.id,
                  name: r.name,
                  purpose: r.purpose,
                  mode: r.mode,
                  status: r.status,
                  workDir: r.workDir,
                  leadBotId: r.leadBotId,
                  memberIds: r.memberIds,
                })),
              })
            }
            if (action === 'get') {
              const room = store.room(String(args?.roomId ?? ''))
              if (!room) return JSON.stringify({ ok: false, error: 'Unknown Group Room.' })
              return JSON.stringify({ ok: true, room })
            }
            if (action === 'create' || action === 'update') {
              const targetRoomId = action === 'update' ? String(args?.roomId ?? '') : ''
              if (action === 'update' && !store.room(targetRoomId)) {
                return JSON.stringify({ ok: false, error: 'Unknown Group Room.' })
              }
              const draft = {}
              if (args?.name !== undefined) draft.name = String(args.name)
              if (args?.purpose !== undefined) draft.purpose = String(args.purpose)
              if (args?.notes !== undefined) draft.notes = String(args.notes)
              if (args?.workDir !== undefined) draft.workDir = String(args.workDir)
              if (args?.mode !== undefined) draft.mode = String(args.mode)
              if (Array.isArray(args?.memberIds)) {
                draft.memberIds = [...new Set(args.memberIds.map(resolveBotId).filter(Boolean))]
              }
              if (args?.leadBotId !== undefined) {
                draft.leadBotId = resolveBotId(args.leadBotId)
              }
              const saved = await rooms.save(targetRoomId, draft)
              return JSON.stringify({
                ok: true,
                room: {
                  id: saved.id,
                  name: saved.name,
                  purpose: saved.purpose,
                  mode: saved.mode,
                  status: saved.status,
                  workDir: saved.workDir,
                  leadBotId: saved.leadBotId,
                  memberIds: saved.memberIds,
                },
              })
            }
            if (action === 'delete') {
              const roomId = String(args?.roomId ?? '')
              const targetRoom = store.room(roomId)
              if (!targetRoom) return JSON.stringify({ ok: false, error: 'Unknown Group Room.' })
              const gate = await requireGovernanceApproval(
                caller,
                'room_manage',
                `Delete Group Room "${targetRoom.name}" (${roomId})`,
              )
              if (!gate.allowed) {
                return JSON.stringify({
                  ok: false,
                  code: 'approval_denied',
                  error: `Deleting Group Room "${targetRoom.name}" was denied by human approval (${gate.decision}).`,
                })
              }
              await rooms.remove(roomId)
              return JSON.stringify({ ok: true, deleted: roomId })
            }
            if (action === 'send') {
              const roomId = String(args?.roomId ?? '')
              const text = String(args?.text ?? '').trim()
              if (!roomId || !text) return JSON.stringify({ ok: false, error: 'roomId and text are required for action="send".' })
              await rooms.send(roomId, text)
              return JSON.stringify({ ok: true, roomId, dispatched: true })
            }
            if (action === 'control') {
              const roomId = String(args?.roomId ?? '')
              const ctrl = String(args?.controlAction ?? '')
              if (!roomId || !ctrl) return JSON.stringify({ ok: false, error: 'roomId and controlAction are required.' })
              await rooms.control(roomId, ctrl)
              return JSON.stringify({ ok: true, roomId, controlAction: ctrl })
            }
            return JSON.stringify({ ok: false, error: `Unknown action "${action}".` })
          } catch (error) {
            return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
    }

    defs.push({
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
    })

    if (isRoom) {
      defs.push(
        {
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
        },
        {
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
        },
        {
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
        },
      )
    }

    defs.push(
      makeMemorySearchTool('memory_search'),
      makeMemorySearchTool('memory_tencentdb_memory_search'),
      makeConversationSearchTool('memory_conversation_search'),
      makeConversationSearchTool('memory_tencentdb_conversation_search'),
      makeReadSceneTool('memory_read_scene'),
      makeReadSceneTool('memory_tencentdb_read_scene'),
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
    )
    return defs
  }

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
