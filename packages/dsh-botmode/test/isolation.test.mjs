/**
 * Comprehensive verification suite covering:
 *   1. Prompt isolation (normal-mode prompts & dsh-purge stripped; shared MCP sections allowed)
 *   2. Bidirectional Tool isolation (0 Bot tools in global/normal mode; normal-only non-MCP tools denied in Bot)
 *   3. Shared Skills with mode-reversed priority (Bot mode: Bot > Normal; Normal mode: Normal > Bot)
 *   4. Shared MCP with mode-reversed priority (Bot mode: Bot MCP > Normal MCP; Normal mode: Normal MCP > Bot MCP)
 *   5. Zero-redundancy Bootstrap Prompt + Initial Memory (`MEMORY.md` + Memory Hub seed) linkage
 *   6. Built-in Skills Library (`browser-desktop-automation`, `bot-team-control`, `scheduled-routines`, `room-completion`, `team-collaboration`)
 *      + Scoped Tools (`bot_manage`, `room_manage`, `scheduled_tasks`)
 *   7. Host session & workspace sidebar isolation + first-turn race fix
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotStore } from '../host/store.js'
import { Dispatcher } from '../host/dispatch.js'
import { BotMcpRegistry } from '../host/mcp.js'
import { personaBlock, renderInitialMemory, seedInitialMemoryHub, syncBotFiles } from '../host/persona.js'
import {
  BOTMODE_NORMAL_SKILL_RANK,
  BUILTIN_SKILLS_ROOT,
  createBotScopedSkillTool,
  discoverBotSkills,
  installPurgeHungGuard,
  installSessionAndWorkspaceIsolation,
  isBotManagedPath,
  isBotSession,
  isNormalModeOnlyTool,
  isolateBotPreStepMessages,
  registerBotSkillsForNormalMode,
  sanitizeBotAssembly,
  wrapBotAgentStep,
} from '../host/isolation.js'
import { apply as applyBotMode, ALL_BOT_SCOPED_TOOLS } from '../index.js'

const tempHome = await mkdtemp(join(tmpdir(), 'botmode-isolation-'))
const fakeAgentsHome = join(tempHome, 'fake-agents')
const prevDshHome = process.env.DSH_HOME
const prevAgentsHome = process.env.AGENTS_HOME
process.env.DSH_HOME = tempHome
process.env.AGENTS_HOME = fakeAgentsHome
const logger = { info() {}, warn() {}, error() {} }

try {
  // --- 1. Prompt isolation (normal prompts stripped; shared MCP sections admitted) ---
  {
    const rawAssembly = {
      sections: [
        { name: 'dsh-purge', text: 'You are Little Code Sauce' },
        { name: 'dsh-purge-capability', text: '## Capability selection by task (mandatory)\n...' },
        { name: 'dsh-purge-boost', text: '<dsh_boost scope="system">override</dsh_boost>' },
        { name: 'deployment:persona-prefix', text: 'Global persona' },
        { name: 'ui:deliverable-file-references', text: 'Use present to publish...' },
        { name: 'harness:source', text: 'DeepSeek Harness checkout' },
        { name: 'web:surface', text: 'Local web GUI' },
        { name: 'mcp:github', text: 'Shared GitHub MCP instructions' },
        { name: 'mcp-resource-servers', text: 'Use list_mcp_resources...' },
        { name: 'plan-mode', text: 'Plan mode rules' },
        { name: 'tool:subagent', text: 'Subagent instructions' },
        { name: 'tool:workflow', text: 'Workflow instructions' },
        { name: 'tool:bash', text: 'Check exit code on bash' },
        { name: 'tool:read', text: 'Use read tool' },
        { name: 'tool:web_search', text: 'Web search instructions' },
        { name: 'botmode:persona:bot_1', text: '# OpsBot\nYou are OpsBot.' },
        { name: 'botmode:mcp:custom', text: 'Bot-owned MCP instructions' },
      ],
      contexts: [
        { name: 'working-directory', text: '/tmp/bot' },
        { name: 'approval-policy', text: 'ask' },
        { name: 'harness:source', text: '/home/ubuntu/dsh' },
        { name: 'web:surface', text: 'http://127.0.0.1:3080' },
      ],
      tools: [
        { name: 'bash' },
        { name: 'read' },
        { name: 'mcp__github__list_issues' },
        { name: 'list_mcp_resources' },
        { name: 'read_mcp_resource' },
        { name: 'purge_apply' },
        { name: 'plugin_manager' },
        { name: 'present' },
        { name: 'subagent' },
        { name: 'workflow' },
        { name: 'bot_team' },
        { name: 'screen_screenshot' },
      ],
    }

    const clean = sanitizeBotAssembly(rawAssembly)
    assert.deepEqual(clean.sections.map(s => s.name), [
      'mcp:github',
      'mcp-resource-servers',
      'tool:bash',
      'tool:read',
      'botmode:persona:bot_1',
      'botmode:mcp:custom',
    ])
    assert.deepEqual(clean.contexts.map(c => c.name), ['working-directory', 'approval-policy'])
    assert.deepEqual(clean.tools.map(t => t.name), [
      'bash',
      'read',
      'mcp__github__list_issues',
      'list_mcp_resources',
      'read_mcp_resource',
      'bot_team',
      'screen_screenshot',
    ])
  }

  // --- 2. __dshPurgeHungPrompt isolation via AsyncLocalStorage + agent.step -
  {
    const fakeGlobal = {}
    const restore = installPurgeHungGuard(fakeGlobal)
    fakeGlobal.__dshPurgeHungPrompt = () => 'SECRET_NORMAL_MODE_PROMPT_INJECT'
    assert.equal(fakeGlobal.__dshPurgeHungPrompt(), 'SECRET_NORMAL_MODE_PROMPT_INJECT')

    let seenInsideBotStep = 'NOT_RUN'
    let seenSectionsInsideBotStep = []
    const botAgent = {
      async step(decision) {
        seenSectionsInsideBotStep = decision.assembly.sections.map(s => s.name)
        await Promise.resolve()
        seenInsideBotStep = fakeGlobal.__dshPurgeHungPrompt()
        return { kind: 'completed' }
      },
    }
    const unwrap = wrapBotAgentStep(botAgent)
    await botAgent.step({
      assembly: {
        sections: [
          { name: 'dsh-purge', text: 'injected by guard' },
          { name: 'botmode:persona:b1', text: '# Bot1' },
        ],
        contexts: [],
        tools: [{ name: 'bash' }, { name: 'purge_apply' }],
      },
    })
    assert.equal(seenInsideBotStep, '')
    assert.deepEqual(seenSectionsInsideBotStep, ['botmode:persona:b1'])
    assert.equal(fakeGlobal.__dshPurgeHungPrompt(), 'SECRET_NORMAL_MODE_PROMPT_INJECT')

    unwrap()
    restore()
    assert.equal(fakeGlobal.__dshPurgeHungPrompt(), 'SECRET_NORMAL_MODE_PROMPT_INJECT')
  }

  // --- 3. Zero-redundancy Bootstrap Prompt + Initial Memory & Hub seed ------
  {
    const store = new BotStore(join(tempHome, 'botmode-dedup'))
    await store.load()
    const botA = {
      id: 'bot_a', name: 'Alpha', role: 'Ops', instructions: 'Check health.',
      sectionId: 'general', dir: '', sessionId: 'sess_a',
      tools: { allow: [], deny: [] }, skills: [],
    }
    const botB = {
      id: 'bot_b', name: 'Beta', role: 'QA', instructions: 'Run tests.',
      sectionId: 'general', dir: '', sessionId: 'sess_b',
      tools: { allow: [], deny: [] }, skills: [],
    }
    await store.mutate((state) => {
      state.bots.push(botA, botB)
      state.rooms.push({
        id: 'room_1', name: 'WarRoom', memberIds: ['bot_a', 'bot_b'],
        memberSessions: { bot_a: 'sess_room_a', bot_b: 'sess_room_b' },
      })
    })
    await syncBotFiles(store, botA, store.state)
    const memMd = await readFile(join(botA.dir, 'MEMORY.md'), 'utf8')
    assert.ok(memMd.includes('Capability Dispatch Index'))
    assert.ok(memMd.includes('browser-desktop-automation'))
    assert.ok(memMd.includes('bot-team-control'))
    assert.ok(memMd.includes('scheduled-routines'))
    assert.ok(memMd.includes(store.mcpConfigPath))
    assert.ok(memMd.includes(BUILTIN_SKILLS_ROOT))

    // Custom edits to MEMORY.md must NOT be overwritten by subsequent syncBotFiles
    await writeFile(join(botA.dir, 'MEMORY.md'), '# Custom Memory\nKeep my preference.\n')
    await syncBotFiles(store, botA, store.state)
    assert.ok((await readFile(join(botA.dir, 'MEMORY.md'), 'utf8')).includes('Keep my preference.'))

    // Idempotent Memory Hub bootstrap seed
    const savedHubItems = []
    const fakeMem = {
      async readSceneForBot(_bot, { sceneId }) {
        const hit = savedHubItems.find(item => item.scene === sceneId)
        return hit ? { ok: true, text: hit.content } : { ok: true, text: '' }
      },
      async saveMemoryForBot(_bot, payload) {
        savedHubItems.push(payload)
        return { ok: true }
      },
    }
    await seedInitialMemoryHub(fakeMem, store, botA)
    await seedInitialMemoryHub(fakeMem, store, botA)
    assert.equal(savedHubItems.length, 1, 'bootstrap seed must be idempotent')
    assert.equal(savedHubItems[0].scene, 'bot-bootstrap')
    assert.ok(savedHubItems[0].content.includes('browser-desktop-automation'))

    const roomPersona = await personaBlock(store, botA, store.state, {
      kind: 'room',
      roomId: 'room_1',
      mcpPromptBlock: '## MCP Library & Priority\n- Bot MCP > Normal MCP',
    })
    assert.equal((roomPersona.match(/bot_b/g) || []).length, 1, 'teammate roster should appear once')
    assert.ok(!roomPersona.includes('## Teammates'))
    assert.ok(roomPersona.includes('Execution Protocol, Skills & Memory Contract'))
    assert.ok(roomPersona.includes('MCP Library & Priority'))
    assert.ok(renderInitialMemory(botA, store).includes('Bootstrap Anchors'))
  }

  // --- 4. Shared Skills with Mode-Reversed Priority + Built-in Library ------
  {
    const store = new BotStore(join(tempHome, 'botmode-skills'))
    await store.load()
    const bot = { id: 'bot_sk', name: 'SkillBot', dir: '' }
    await store.ensureBotDir(bot)

    // Create normal-mode skills (one unique OSS skill + one colliding name)
    const normalOssDir = join(fakeAgentsHome, 'skills', 'oss-browser-demo')
    await mkdir(normalOssDir, { recursive: true })
    await writeFile(join(normalOssDir, 'SKILL.md'), '---\nname: oss-browser-demo\ndescription: Open-source browser helper\n---\nOSS browser guide\n')

    const normalClashDir = join(tempHome, 'skills', 'priority-clash')
    await mkdir(normalClashDir, { recursive: true })
    await writeFile(join(normalClashDir, 'SKILL.md'), '---\nname: priority-clash\ndescription: Normal version\n---\nNORMAL_BODY\n')

    // Create Bot shared skill with same colliding name
    const botClashDir = join(store.skillsRoot, 'priority-clash')
    await mkdir(botClashDir, { recursive: true })
    await writeFile(join(botClashDir, 'SKILL.md'), '---\nname: priority-clash\ndescription: Bot priority version\n---\nBOT_BODY\n')

    // In Bot Mode: Bot skills > Normal skills, AND all 5 built-in skills + shared normal skills are visible
    const discovered = await discoverBotSkills(store, bot)
    const names = discovered.map(s => s.name)
    for (const builtin of ['browser-desktop-automation', 'bot-team-control', 'scheduled-routines', 'room-completion', 'team-collaboration']) {
      assert.ok(names.includes(builtin), `expected built-in skill ${builtin}`)
    }
    assert.ok(names.includes('oss-browser-demo'), 'Bot Mode should share normal-mode OSS skills')
    const clashInBot = discovered.find(s => s.name === 'priority-clash')
    assert.equal(clashInBot.tier, 'bot', 'Bot skill must outrank normal-mode skill in Bot Mode')
    assert.equal(clashInBot.content, 'BOT_BODY')

    const scopedSkillTool = createBotScopedSkillTool(store, bot)
    assert.equal((await scopedSkillTool.execute({ name: 'priority-clash' })).content, 'BOT_BODY')
    assert.equal((await scopedSkillTool.execute({ name: 'oss-browser-demo' })).content, 'OSS browser guide')
    assert.ok((await scopedSkillTool.execute({ name: 'browser-desktop-automation' })).content.includes('screen_request_help'))

    // In Normal Mode: Bot skills provider registers at BOTMODE_NORMAL_SKILL_RANK (900 > 600),
    // so Normal-mode skills ALWAYS win on collision while Bot built-ins remain available!
    let registeredProvider = null
    const mockNormalCtx = {
      skills: {
        registerProvider(factory) {
          registeredProvider = factory({ signal: new AbortController().signal, invalidate() {} })
          return () => {}
        },
      },
    }
    registerBotSkillsForNormalMode(mockNormalCtx, store)
    assert.ok(registeredProvider)
    const normalCandidates = await registeredProvider.list()
    assert.ok(normalCandidates.some(c => c.name === 'browser-desktop-automation' && c.rank >= BOTMODE_NORMAL_SKILL_RANK))
    assert.ok(normalCandidates.some(c => c.name === 'priority-clash' && c.rank === BOTMODE_NORMAL_SKILL_RANK))
    assert.ok(BOTMODE_NORMAL_SKILL_RANK > 600, 'Bot skills in normal mode must rank lower than DSH bundled/user skills')

    // Pre-step still strips normal-mode `agent-instructions` & `dsh-purge`, while injecting Bot-priority catalog
    const fakeAgent = { session: { ownEvents: () => [] } }
    const filtered = await isolateBotPreStepMessages({
      store,
      bot,
      agent: fakeAgent,
      incomingMessages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use /priority-clash and /oss-browser-demo' }] }],
      decisionMessages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use /priority-clash and /oss-browser-demo' }] },
        { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'Normal AGENTS.md' }] },
        { role: 'user', source: { kind: 'skill-catalog', entries: [] }, content: [{ type: 'text', text: 'normal catalog' }] },
        { role: 'user', source: { kind: 'dsh-purge' }, content: [{ type: 'text', text: 'purge' }] },
      ],
    })
    assert.ok(!filtered.some(m => m.source?.kind === 'agent-instructions'))
    assert.ok(!filtered.some(m => m.source?.kind === 'dsh-purge'))
    const botCatalog = filtered.find(m => m.source?.kind === 'botmode-skill-catalog')
    assert.ok(botCatalog)
    assert.equal(botCatalog.source.entries.find(e => e.name === 'priority-clash')?.tier, 'bot')
    assert.equal(botCatalog.source.entries.find(e => e.name === 'oss-browser-demo')?.tier, 'normal')
    const invokes = filtered.filter(m => m.source?.kind === 'botmode-skill-invocation')
    assert.deepEqual(invokes.map(m => m.source.name), ['priority-clash', 'oss-browser-demo'])
    assert.ok(invokes[0].content[0].text.includes('BOT_BODY'))
  }

  // --- 5. Shared MCP Registry with Mode-Reversed Priority -------------------
  {
    const store = new BotStore(join(tempHome, 'botmode-mcp'))
    await store.load()
    const registeredInHost = new Map()
    const mockMcpManager = {
      list: () => [
        { name: 'github', configured: true, status: { state: 'ready' } },
        { name: 'normal_only', configured: true, status: { state: 'ready' } },
        ...[...registeredInHost.keys()].map(name => ({ name, configured: false, status: { state: 'ready' } })),
      ],
      register(name, entry) {
        registeredInHost.set(name, entry)
        return () => { registeredInHost.delete(name) }
      },
    }
    const mockCtx = { get: (k) => (k === 'mcpManager' ? mockMcpManager : undefined) }
    const mcp = new BotMcpRegistry(mockCtx, store, logger)
    await mcp.load()
    await mcp.save({
      servers: {
        github: { transport: 'stdio', command: 'node', args: ['bot-github.js'] },
        bot_crm: { transport: 'stdio', command: 'node', args: ['crm.js'] },
      },
    })
    // Non-colliding Bot MCP server `bot_crm` is shared to host mcpManager; colliding `github` yields to normal mode
    assert.ok(registeredInHost.has('bot_crm'))
    assert.ok(!registeredInHost.has('github'))

    const botOrder = mcp.listForMode('bot')
    assert.equal(botOrder[0].name, 'github')
    assert.equal(botOrder[0].tier, 'bot', 'Bot MCP must win in Bot Mode')
    assert.equal(botOrder[1].name, 'bot_crm')
    assert.equal(botOrder[2].name, 'normal_only')

    const normalOrder = mcp.listForMode('normal')
    assert.equal(normalOrder[0].name, 'github')
    assert.equal(normalOrder[0].tier, 'normal', 'Normal MCP must win in Normal Mode')
    assert.ok(normalOrder.some(s => s.name === 'bot_crm' && s.tier === 'bot'))

    const promptIdx = mcp.systemPromptIndexBlock()
    assert.ok(promptIdx.includes(store.mcpConfigPath))
    assert.ok(promptIdx.includes('Bot MCP > Normal DSH MCP'))
    mcp.dispose()
  }

  // --- 6. Host session & workspace sidebar isolation ------------------------
  {
    const store = new BotStore(join(tempHome, 'botmode-sessions'))
    await store.load()
    const botDir = join(store.botsRoot, 'ops-123456')
    await mkdir(botDir, { recursive: true })
    await store.mutate((state) => {
      state.bots.push({
        id: 'bot_ops', name: 'Ops', dir: botDir, sessionId: 'sess_bot_primary',
        tools: { allow: [], deny: [] }, skills: [],
      })
      state.rooms.push({
        id: 'room_ops', name: 'RoomOps', workDir: '/tmp/normal-project',
        memberIds: ['bot_ops'], memberSessions: { bot_ops: 'sess_bot_room' },
      })
    })

    assert.equal(isBotManagedPath(store, botDir), true)
    assert.equal(isBotManagedPath(store, join(store.botsRoot, 'deleted-bot-999')), true)
    assert.equal(isBotManagedPath(store, '/tmp/normal-project'), false)
    assert.equal(isBotSession(store, 'sess_bot_primary', botDir), true)
    assert.equal(isBotSession(store, 'sess_bot_room', '/tmp/normal-project'), true)
    assert.equal(isBotSession(store, 'sess_normal', '/tmp/normal-project'), false)

    const detached = []
    const deletedWorkspaces = []
    const wsEntries = [
      { id: 'ws_normal', path: '/tmp/normal-project', sessionIds: ['sess_normal', 'sess_bot_room'], detachSession: async (sid) => { detached.push(sid) } },
      { id: 'ws_bot', path: botDir, sessionIds: ['sess_bot_primary'], detachSession: async () => {} },
    ]
    const sessionController = {
      async list() {
        return {
          items: [
            { sessionId: 'sess_normal', cwd: '/tmp/normal-project' },
            { sessionId: 'sess_bot_primary', cwd: botDir },
            { sessionId: 'sess_bot_room', cwd: '/tmp/normal-project' },
          ],
        }
      },
      async search() {
        return {
          items: [
            { sessionId: 'sess_normal', cwd: '/tmp/normal-project' },
            { sessionId: 'sess_bot_primary', cwd: botDir },
          ],
          hasMore: false,
        }
      },
    }
    const workspaceRegistry = {
      list: () => wsEntries.filter(w => !deletedWorkspaces.includes(w.id)),
      delete: async (id) => { deletedWorkspaces.push(id) },
    }
    const mockCtx = {
      get: (key) => (key === 'sessionController' ? sessionController : key === 'workspaceRegistry' ? workspaceRegistry : undefined),
    }

    const disposeIso = installSessionAndWorkspaceIsolation(mockCtx, store, Promise.resolve(), logger)
    await new Promise(r => setTimeout(r, 20))

    assert.deepEqual((await sessionController.list()).items.map(i => i.sessionId), ['sess_normal'])
    assert.deepEqual((await sessionController.search({ query: 'hello' })).items.map(i => i.sessionId), ['sess_normal'])
    assert.deepEqual(deletedWorkspaces, ['ws_bot'])
    assert.deepEqual(detached, ['sess_bot_room'])
    disposeIso()
  }

  // --- 7. End-to-end apply(ctx): scoped Bot tools (`bot_manage`, `room_manage`, `scheduled_tasks`) ---
  {
    const globalRegisteredTools = []
    const listeners = new Map()
    const guards = []
    const services = new Map()
    const effects = []
    const inheritedNormalTools = [
      { name: 'bash' },
      { name: 'read' },
      { name: 'skill' },
      { name: 'mcp__github__list_issues' },
      { name: 'list_mcp_resources' },
      { name: 'read_mcp_resource' },
      { name: 'purge_apply' },
      { name: 'plugin_manager' },
      { name: 'present' },
      { name: 'subagent' },
      { name: 'workflow' },
    ]
    const mockHostCtx = {
      logger,
      effect(fn) {
        const d = fn()
        effects.push(d)
        return d
      },
      on(event, fn) {
        const arr = listeners.get(event) ?? []
        arr.push(fn)
        listeners.set(event, arr)
        return () => {}
      },
      get: (name) => services.get(name),
      inject() {},
      reflect: {
        provide(key, val) {
          services.set(key, val)
          return () => services.delete(key)
        },
      },
      commands: { register() { return () => {} } },
      tools: {
        register(def) {
          globalRegisteredTools.push(def.name)
          return () => {}
        },
        definitions: () => inheritedNormalTools,
        guard(fn) {
          guards.push(fn)
          return () => {}
        },
      },
    }

    applyBotMode(mockHostCtx)
    assert.deepEqual(globalRegisteredTools, [], 'Bot tools must NEVER leak into global ctx.tools')

    const botsService = services.get('bots')
    const createdBot = await botsService.create({ name: 'IsoBot', role: 'Orchestrator' })
    const botSessionId = 'sess_iso_primary'
    const state = botsService.state()
    state.bots.find(b => b.id === createdBot.id).sessionId = botSessionId

    const makeFakeScopedAgent = (sid, cwd) => {
      const scopedRegistered = []
      const restrictions = []
      const promptSections = []
      const agentTools = {
        definitions: () => [...inheritedNormalTools, ...scopedRegistered],
        view: () => ({ restrictableNames: new Set(inheritedNormalTools.map(t => t.name)) }),
        restrict(filter) { restrictions.push(filter); return () => {} },
        register(def) { scopedRegistered.push(def); return () => {} },
      }
      const agentPrompt = { section(sec) { promptSections.push(sec); return () => {} } }
      return {
        cwd,
        session: { id: sid, header: { id: sid, cwd }, ownEvents: () => [] },
        model: { select() {} },
        async step(decision) { return decision },
        ctx: {
          effect(fn) { return fn() },
          get(key) {
            if (key === 'tools') return agentTools
            if (key === 'systemPrompt') return agentPrompt
            return undefined
          },
        },
        scopedRegistered,
        restrictions,
        promptSections,
      }
    }

    const primaryAgent = makeFakeScopedAgent(botSessionId, createdBot.dir)
    for (const fn of listeners.get('agent/created') ?? []) await fn({ agent: primaryAgent })
    const scopedByName = new Map(primaryAgent.scopedRegistered.map(t => [t.name, t]))

    for (const expected of ['skill', 'message_agent', 'bot_team', 'bot_manage', 'room_manage', 'scheduled_tasks', 'screen_screenshot']) {
      assert.ok(scopedByName.has(expected), `expected scoped tool ${expected}`)
    }
    assert.ok(!scopedByName.has('claim_subtask'))

    // MCP tools are NOT denied in Bot Mode; non-MCP normal tools ARE denied
    const deniedInPrimary = new Set(primaryAgent.restrictions[0].deny)
    assert.ok(!deniedInPrimary.has('mcp__github__list_issues'), 'MCP tools are shared with Bot Mode')
    assert.ok(!deniedInPrimary.has('list_mcp_resources'), 'MCP resources are shared with Bot Mode')
    assert.ok(deniedInPrimary.has('purge_apply'))
    assert.ok(deniedInPrimary.has('plugin_manager'))
    assert.ok(deniedInPrimary.has('present'))
    assert.ok(deniedInPrimary.has('subagent'))

    // Exercise `bot_manage` CRUD + self-delete guard
    const botManageTool = scopedByName.get('bot_manage')
    const execCtx = { agent: primaryAgent }
    const created2 = JSON.parse(await botManageTool.execute({ action: 'create', name: 'WorkerBot', role: 'Builder' }, execCtx))
    assert.equal(created2.ok, true)
    const selfDel = JSON.parse(await botManageTool.execute({ action: 'delete', botId: createdBot.id }, execCtx))
    assert.equal(selfDel.ok, false)
    assert.equal(selfDel.code, 'self_delete_forbidden')

    // Exercise `room_manage` create by Bot names + list + delete
    const roomManageTool = scopedByName.get('room_manage')
    const createdRoom = JSON.parse(await roomManageTool.execute({
      action: 'create',
      name: 'AutoSquad',
      purpose: 'Joint delivery',
      memberIds: ['IsoBot', 'WorkerBot'],
      mode: 'lead',
      leadBotId: 'IsoBot',
    }, execCtx))
    assert.equal(createdRoom.ok, true)
    assert.equal(createdRoom.room.memberIds.length, 2)
    assert.equal(createdRoom.room.leadBotId, createdBot.id)
    const delRoom = JSON.parse(await roomManageTool.execute({ action: 'delete', roomId: createdRoom.room.id }, execCtx))
    assert.equal(delRoom.ok, true)

    // Delete WorkerBot cleanly
    const delWorker = JSON.parse(await botManageTool.execute({ action: 'delete', botId: created2.bot.id }, execCtx))
    assert.equal(delWorker.ok, true)

    // Exercise `scheduled_tasks` create + list + remove
    const schedTool = scopedByName.get('scheduled_tasks')
    const schedCreate = JSON.parse(await schedTool.execute({
      action: 'create',
      name: 'HealthCheck',
      schedule: 'daily 09:00',
      tz: 'Asia/Shanghai',
      prompt: 'Check disk usage and reply [SILENT] if healthy.',
    }, execCtx))
    assert.equal(schedCreate.ok, true)
    const schedList = JSON.parse(await schedTool.execute({ action: 'list' }, execCtx))
    assert.equal(schedList.ok, true)
    assert.equal(schedList.tasks.length, 1)
    const schedRemove = JSON.parse(await schedTool.execute({ action: 'remove', id: schedCreate.task.id }, execCtx))
    assert.equal(schedRemove.ok, true)

    // Guard check: Bot allows shared MCP, denies purge_apply; Normal denies Bot tools
    assert.equal(isNormalModeOnlyTool('mcp__anything__do'), false)
    assert.equal(isNormalModeOnlyTool('purge_apply'), true)
    const guard = guards[0]
    assert.equal(guard({ agent: primaryAgent, name: 'mcp__github__list_issues' }), undefined)
    assert.ok(guard({ agent: primaryAgent, name: 'purge_apply' }))
    const normalAgent = { cwd: '/tmp/user-proj', session: { id: 'sess_normal_1', header: { id: 'sess_normal_1', cwd: '/tmp/user-proj' } } }
    assert.ok(guard({ agent: normalAgent, name: 'bot_manage' }))
    assert.ok(guard({ agent: normalAgent, name: 'room_manage' }))
    assert.ok(guard({ agent: normalAgent, name: 'scheduled_tasks' }))
    assert.ok(ALL_BOT_SCOPED_TOOLS.includes('bot_manage'))
    assert.ok(ALL_BOT_SCOPED_TOOLS.includes('room_manage'))

    for (const d of effects) {
      if (typeof d === 'function') d()
    }
  }

  // --- 8. Dispatcher awaits async configureAgent before first followup ------
  {
    const store = new BotStore(join(tempHome, 'botmode-race'))
    await store.load()
    const bot = { id: 'bot_race', name: 'RaceBot', dir: '', sessionId: '', tools: { allow: [], deny: [] } }
    await store.mutate(state => state.bots.push(bot))

    const order = []
    let createdAgent
    const fakeController = {
      async create() { return { sessionId: 'sess_race_1' } },
      async resolveAgent() {
        if (!createdAgent) {
          const events = []
          createdAgent = {
            session: { id: 'sess_race_1', header: { id: 'sess_race_1' }, ownEvents: () => events },
            model: { select() {} },
            followup() {
              order.push('followup')
              events.push({ type: 'assistant/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
            },
            async whenIdle() {},
          }
        }
        return { agent: createdAgent }
      },
    }
    const fakeCtx = {
      get: (k) => (k === 'sessionController' ? fakeController : undefined),
      sessions: { async flush() {} },
    }
    const dispatcher = new Dispatcher(fakeCtx, store, logger, async () => {
      await new Promise(r => setTimeout(r, 30))
      order.push('configured')
    })
    const res = await dispatcher.enqueue(bot.id, 'hello first turn')
    assert.equal(res.ok, true)
    assert.deepEqual(order, ['configured', 'followup'])
  }

  console.log('✓ isolation.test.mjs all assertions passed')
} finally {
  if (prevDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDshHome
  if (prevAgentsHome === undefined) delete process.env.AGENTS_HOME
  else process.env.AGENTS_HOME = prevAgentsHome
  await rm(tempHome, { recursive: true, force: true })
}
