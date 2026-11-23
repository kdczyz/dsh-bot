/**
 * Bot mode for DeepSeek Harness — Host half.
 *
 * Adds a Bot roster with real identity isolation, a teammate messaging tool,
 * Group Rooms with a bounded routing state machine, and Host-level persistent
 * Routines that wake a cold Bot Session. The Client half renders the roster and
 * the Bot page behind the sidebar switch.
 *
 * State lives under `$DSH_HOME/botmode/`:
 *   state.json                 roster, Sections, Rooms, Routines
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
import { personaBlock, syncBotFiles, syncTeamFiles } from './host/persona.js'
import { botModelCatalog, resolveBotSelection } from './host/models.js'

export const name = 'botmode'
export const inject = ['commands', 'tools']

const DEFAULT_TOOLS = ['message_agent', 'bot_team']

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
  const dispatcher = new Dispatcher(ctx, store, logger, (agent, bot) => { void configureAgent(agent, bot) })
  const rooms = new Rooms(store, dispatcher, logger)
  const routines = new Routines(ctx, store, dispatcher, logger)
  const approvals = new Approvals(store, logger)
  const api = new BotApi({ ctx, store, dispatcher, rooms, routines, approvals, logger })

  const ready = store.load().catch((error) => {
    logger?.warn?.(`botmode: could not read state: ${String(error)}`)
  })

  ctx.effect(() => routines.start(), 'botmode: persistent routines')
  ctx.effect(() => () => approvals.clear(), 'botmode: approval cleanup')

  // A Bot Session is never shown in the Harness UI, so its approval requests
  // would otherwise fail closed with no human in reach. Answer them here and
  // park the ones that need the Bot page; non-Bot Sessions keep the normal
  // composed answerers.
  const approvalOff = ctx.on('approval/request', (request, next) => {
    const sessionId = sessionIdOf(request?.agent)
    const bot = sessionId ? store.botBySession(sessionId) : undefined
    if (!bot) return next()
    return approvals.ask(bot, request)
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
  }
  ctx.effect(() => ctx.reflect.provide('bots', botsService), 'botmode: ctx.bots service')

  // Persona, model binding, tool policy, permanent-chat commands and approval
  // policy are applied once per live Agent. A newly created Session is mapped to
  // its Bot only after session creation returns, so the Dispatcher invokes this
  // same function when it first resolves that Agent.
  const configured = new WeakSet()
  async function configureAgent(agent, bot) {
    if (!agent || !bot || configured.has(agent)) return
    configured.add(agent)
    try {
      const persona = await personaBlock(store, bot, store.state)
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
        // Drop names the current composition does not expose instead of letting
        // tools.restrict() throw and silently leave every tool visible.
        const known = new Set((tools.definitions?.() ?? []).map(entry => entry.name))
        const deny = bot.tools.deny.filter(name => known.has(name))
        const allow = bot.tools.allow.length > 0
          ? [...new Set([...bot.tools.allow, ...DEFAULT_TOOLS])].filter(name => known.has(name))
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
    // A Bot chat is permanent: `/new` and `/reset` compact the history instead of
    // abandoning the Session, so the canonical botId → sessionId mapping survives.
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
    // A Bot must ask under the policy the Bot page exposes. The profile default
    // may be "never" (fully autonomous); "ask" is what lets the approval bridge
    // park a request for a human decision, and "always"/"ask" both need it.
    try {
      const approval = agent.ctx.get('approval')
      if (approval && typeof approval.setPolicy === 'function') {
        approval.setPolicy(agent, bot.approvalPolicy === 'never' ? 'never' : 'ask')
      }
    } catch (error) {
      logger?.warn?.(`botmode: approval policy for ${bot.name} failed: ${String(error)}`)
    }
    // The Bot's own binding wins; an empty binding follows the DSH default.
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
    const bot = store.botBySession(sessionId)
    if (!bot) return
    await configureAgent(agent, bot)
  })
  ctx.effect(() => agentOff, 'botmode: agent bootstrap listener')

  // Teammate messaging. Registered globally, but only a Bot Session may use it.
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
      await ready
      const sessionId = sessionIdOf(exec?.agent)
      if (!sessionId) return 'This Session is not a Bot.'
      const sender = store.botBySession(sessionId)
      if (!sender) return 'This Session is not a Bot.'
      const result = await dispatcher.messageAgent(
        sender.id,
        String(args?.target ?? ''),
        String(args?.message ?? ''),
        args?.expectReply === true,
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
      await ready
      const action = String(args?.action ?? 'roster')
      const sessionId = sessionIdOf(exec?.agent)
      const me = sessionId ? store.botBySession(sessionId) : undefined
      if (action === 'me') {
        return JSON.stringify(me
          ? { id: me.id, name: me.name, role: me.role, dir: me.dir, sectionId: me.sectionId, tools: me.tools }
          : { error: 'This Session is not a Bot.' })
      }
      if (action === 'rooms') {
        const mine = store.state.rooms.filter(room => me && room.memberIds.includes(me.id))
        return JSON.stringify(mine.map(room => ({ id: room.id, name: room.name, mode: room.mode, members: room.memberIds })))
      }
      return JSON.stringify(store.state.bots.map(bot => ({
        id: bot.id,
        name: bot.name,
        role: bot.role,
        sectionId: bot.sectionId,
        me: me?.id === bot.id,
      })))
    },
  }), 'botmode: bot_team tool')

  // Human command for headless use and troubleshooting.
  ctx.effect(() => ctx.commands.register({
    name: 'botmode',
    description: 'Inspect or drive Bot mode from a Session: status, roster, dispatch, room, routine.',
    input: { hint: 'status | roster | dispatch <bot> <text> | room <roomId> <text> | routine <id>' },
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
            bots: store.state.bots.map(bot => ({ id: bot.id, name: bot.name, sessionId: bot.sessionId, busy: dispatcher.isBusy(bot.id) })),
            rooms: store.state.rooms.map(room => ({ id: room.id, name: room.name, status: room.status })),
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
      if (action === 'scaffold') {
        // Backwards-compatible: rewrite every Bot's identity files.
        await syncTeamFiles(store, store.state)
        for (const bot of store.state.bots) await syncBotFiles(store, bot, store.state)
        return { kind: 'success', text: 'Bot identity files rewritten.' }
      }
      return { kind: 'error', text: 'Unknown action.' }
    },
  }), 'botmode: command')

  // HTTP surface for the Client half. The Web carrier may activate after this
  // plugin; wait for it instead of probing once at load.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: PREFIX.replace(/\/$/, ''),
      handler: (req, res) => api.handle(req, res),
    }), 'botmode: api route')
  })

  logger?.info?.(`botmode: state at ${store.root}`)
}