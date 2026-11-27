import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply as applyBotMode } from '../index.js'
import { BotStore } from '../host/store.js'
import { BotMcpRegistry } from '../host/mcp.js'
import { Dispatcher } from '../host/dispatch.js'
import { Approvals } from '../host/approvals.js'
import { BotApi } from '../host/api.js'
import { NotificationHub, WebhookManager, formatOutboundPayload } from '../host/channels.js'
import {
  BUILTIN_SKILLS_ROOT,
  createBotScopedSkillTool,
  deleteBotSkillFile,
  discoverBotSkills,
  loadBotSkill,
  saveBotSkillFile,
} from '../host/isolation.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} }

const makeMockRes = () => {
  let statusCode = 200
  const headers = {}
  let body = ''
  return {
    get statusCode() { return statusCode },
    set statusCode(v) { statusCode = v },
    setHeader(k, v) { headers[k.toLowerCase()] = v },
    end(chunk = '') { body += String(chunk) },
    json() { return JSON.parse(body || '{}') },
    headers,
  }
}

const makeMockReq = (method, url, headers = {}, body = '') => {
  const stream = Readable.from(body ? [Buffer.from(body, 'utf8')] : [])
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

const tempHome = await mkdtemp(join(tmpdir(), 'dsh-botmode-gov-'))
const prevDshHome = process.env.DSH_HOME
const prevAgentsHome = process.env.AGENTS_HOME
process.env.DSH_HOME = tempHome
process.env.AGENTS_HOME = join(tempHome, 'agents')

let notifyServer
try {
  // --- 1. Built-in 7 Skills + Custom Skill CRUD & Per-Bot Disable -----------
  {
    const store = new BotStore(join(tempHome, 'botmode-skills'))
    await store.load()
    const bot = { id: 'bot_sk', name: 'SkillBot', dir: '', disabledSkills: [], tools: { allow: [], deny: [] } }
    await store.mutate(s => s.bots.push(bot))
    await store.ensureBotDir(bot)

    const initial = await discoverBotSkills(store, bot, { includeNormalSkills: false })
    const names = new Set(initial.map(s => s.name))
    for (const reqSkill of [
      'browser-desktop-automation',
      'bot-team-control',
      'team-collaboration',
      'room-completion',
      'scheduled-routines',
      'artifact-delivery',
      'memory-hygiene',
    ]) {
      assert.ok(names.has(reqSkill), `missing built-in skill ${reqSkill}`)
    }

    // Create custom shared skill & bot-local skill
    const savedShared = await saveBotSkillFile(store, bot, {
      scope: 'shared',
      name: 'ops-runbook',
      content: '---\nname: ops-runbook\ndescription: Custom shared ops runbook\n---\n\n# Ops\nCheck health.',
    })
    assert.equal(savedShared.ok, true)

    const savedLocal = await saveBotSkillFile(store, bot, {
      scope: 'bot',
      name: 'local-only',
      content: '---\nname: local-only\ndescription: Local skill\n---\n\n# Local\nOnly for SkillBot.',
    })
    assert.equal(savedLocal.ok, true)

    // Disable `ops-runbook` for SkillBot -> hidden from runtime discover & scoped skill tool
    await store.mutate((s) => {
      s.bots.find(b => b.id === bot.id).disabledSkills = ['ops-runbook']
    })
    const runtimeList = await discoverBotSkills(store, bot, { includeNormalSkills: false })
    assert.ok(!runtimeList.some(s => s.name === 'ops-runbook'), 'disabled skill must be hidden from model')
    assert.ok(runtimeList.some(s => s.name === 'local-only'))

    const uiList = await discoverBotSkills(store, bot, { includeNormalSkills: false, includeDisabled: true })
    const uiOps = uiList.find(s => s.name === 'ops-runbook')
    assert.equal(uiOps?.enabled, false)
    assert.equal(uiOps?.editable, true)

    assert.equal(await loadBotSkill(store, bot, 'ops-runbook', { includeNormalSkills: false }), undefined)
    const scopedSkillTool = createBotScopedSkillTool(store, bot, { includeNormalSkills: false })
    await assert.rejects(() => scopedSkillTool.execute({ name: 'ops-runbook' }, {}), /unavailable|unknown/i)

    // Delete custom skills cleanly; built-in root must remain untouched
    const delShared = await deleteBotSkillFile(store, bot, { scope: 'shared', name: 'ops-runbook' })
    assert.equal(delShared.ok, true)
    const delLocal = await deleteBotSkillFile(store, bot, { scope: 'bot', name: 'local-only' })
    assert.equal(delLocal.ok, true)
    const afterDelete = await discoverBotSkills(store, bot, { includeNormalSkills: false })
    assert.ok(afterDelete.some(s => s.name === 'artifact-delivery'), `built-in skills under ${BUILTIN_SKILLS_ROOT} stay intact`)
  }

  // --- 2. MCP CRUD + Same-Name Conflict Override Detection ------------------
  {
    const store = new BotStore(join(tempHome, 'botmode-mcp'))
    await store.load()
    const hostServers = new Map([
      ['github', { name: 'github', config: { command: 'normal-gh', args: [] } }],
    ])
    const fakeMcpManager = {
      list: () => [...hostServers.values()],
      add(name, cfg) {
        if (!hostServers.has(name)) hostServers.set(name, { name, config: cfg })
        return () => hostServers.delete(name)
      },
    }
    const fakeCtx = { get: (k) => (k === 'mcpManager' ? fakeMcpManager : undefined) }
    const mcp = new BotMcpRegistry(fakeCtx, store, logger)
    await mcp.load()

    const saved = await mcp.saveServer('github', { command: 'node', args: ['-v'] })
    assert.equal(saved.ok, true)
    const savedHttp = await mcp.saveServer('remote-api', { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' })
    assert.equal(savedHttp.ok, true)

    const pub = mcp.publicConfig()
    const botGh = pub.botServers.find(s => s.name === 'github')
    assert.equal(botGh?.overridesNormal, true, 'same-name Bot MCP must be flagged as overriding normal MCP')

    // Probe stdio binary (`node` exists in PATH)
    const probeOk = await mcp.probeServer('github')
    assert.equal(probeOk.ok, true)

    // Toggle disabled & delete
    await mcp.toggleServer('remote-api', false)
    assert.equal(mcp.publicConfig().botServers.find(s => s.name === 'remote-api')?.disabled, true)
    await mcp.deleteServer('remote-api')
    assert.equal(mcp.publicConfig().botServers.some(s => s.name === 'remote-api'), false)
    mcp.dispose()
  }

  // --- 3. Governance: Worker CRUD Approval Gate, Admin Bypass, External Write Guard ---
  {
    const listeners = new Map()
    const guards = []
    const services = new Map()
    const effects = []
    let apiHandler = null
    const mockHostCtx = {
      logger,
      effect(fn) { const d = fn(); effects.push(d); return d },
      on(ev, fn) {
        const arr = listeners.get(ev) ?? []
        arr.push(fn)
        listeners.set(ev, arr)
        return () => {}
      },
      get: (k) => (k === 'connection' ? { requestRejection: () => undefined } : services.get(k)),
      inject(deps, fn) {
        if (Array.isArray(deps) && deps.includes('webServer')) {
          fn({
            effect: (f) => f(),
            webServer: {
              register(route) {
                apiHandler = route.handler
                return () => {}
              },
            },
            connection: { requestRejection: () => undefined },
          })
        }
      },
      reflect: { provide(k, v) { services.set(k, v); return () => services.delete(k) } },
      commands: { register() { return () => {} } },
      tools: {
        register() { return () => {} },
        definitions: () => [{ name: 'write' }, { name: 'read' }],
        guard(fn) { guards.push(fn); return () => {} },
      },
    }

    applyBotMode(mockHostCtx)
    const botsService = services.get('bots')
    const workerBot = await botsService.create({ name: 'WorkerA', role: 'Dev', permissionRole: 'worker' })
    const adminBot = await botsService.create({ name: 'AdminA', role: 'Lead', permissionRole: 'admin' })
    const state = botsService.state()
    state.bots.find(b => b.id === workerBot.id).sessionId = 'sess_worker_a'
    state.bots.find(b => b.id === adminBot.id).sessionId = 'sess_admin_a'

    const buildAgent = (sid, cwd) => {
      const scoped = []
      const agentTools = {
        definitions: () => [{ name: 'write' }, { name: 'read' }, ...scoped],
        view: () => ({ restrictableNames: new Set(['write', 'read']) }),
        restrict() { return () => {} },
        register(def) { scoped.push(def); return () => {} },
      }
      return {
        cwd,
        session: { id: sid, header: { id: sid, cwd }, ownEvents: () => [] },
        model: { select() {} },
        async step(d) { return d },
        ctx: {
          effect(fn) { return fn() },
          get: (k) => (k === 'tools' ? agentTools : undefined),
        },
        scoped,
      }
    }

    const workerAgent = buildAgent('sess_worker_a', workerBot.dir)
    const adminAgent = buildAgent('sess_admin_a', adminBot.dir)
    for (const fn of listeners.get('agent/created') ?? []) {
      await fn({ agent: workerAgent })
      await fn({ agent: adminAgent })
    }
    const workerBotManage = workerAgent.scoped.find(t => t.name === 'bot_manage')
    const adminBotManage = adminAgent.scoped.find(t => t.name === 'bot_manage')

    // Admin creates a Bot without approval pause
    const adminCreated = JSON.parse(await adminBotManage.execute({
      action: 'create',
      name: 'TempSubBot',
      role: 'Helper',
    }, { agent: adminAgent }))
    assert.equal(adminCreated.ok, true)

    // External write guard when enabled: worker blocked outside dir, admin allowed
    state.settings.governance.protectExternalWrites = true
    const guard = guards[0]
    const blockedOutside = guard({ agent: workerAgent, name: 'write', arguments: { path: '/tmp/outside-file.txt' } })
    assert.ok(blockedOutside && blockedOutside.includes('protectExternalWrites'))
    const allowedInside = guard({ agent: workerAgent, name: 'write', arguments: { path: join(workerBot.dir, 'ok.txt') } })
    assert.equal(allowedInside, undefined)
    const allowedAdmin = guard({ agent: adminAgent, name: 'write', arguments: { path: '/tmp/outside-file.txt' } })
    assert.equal(allowedAdmin, undefined)

    // Clean up admin-created bot directly via admin
    const adminDeleted = JSON.parse(await adminBotManage.execute({
      action: 'delete',
      botId: adminCreated.bot.id,
    }, { agent: adminAgent }))
    assert.equal(adminDeleted.ok, true)

    // Worker calls bot_manage(create) -> blocked by governance approval gate; deny -> approval_denied
    assert.equal(typeof apiHandler, 'function')
    const fetchState = async () => {
      const r = makeMockRes()
      await apiHandler(makeMockReq('GET', '/botmode/api/state'), r)
      return r.json().state
    }
    const postCmd = async (payload) => {
      const r = makeMockRes()
      await apiHandler(makeMockReq('POST', '/botmode/api/command', { 'content-type': 'application/json' }, JSON.stringify(payload)), r)
      return r.json()
    }

    const deniedPromise = workerBotManage.execute({ action: 'create', name: 'DeniedWorkerBot', role: 'Tester' }, { agent: workerAgent })
    await new Promise(r => setTimeout(r, 20))
    const st1 = await fetchState()
    assert.equal(st1.approvals.length, 1, 'worker bot_manage(create) must pause for human approval')
    const dec1 = await postCmd({ type: 'approval.decide', approvalId: st1.approvals[0].id, decision: 'deny' })
    assert.equal(dec1.ok, true)
    const deniedRes = JSON.parse(await deniedPromise)
    assert.equal(deniedRes.ok, false)
    assert.equal(deniedRes.code, 'approval_denied')

    // Worker calls bot_manage(create) again -> approve -> succeeds!
    const approvedPromise = workerBotManage.execute({ action: 'create', name: 'ApprovedWorkerBot', role: 'Tester' }, { agent: workerAgent })
    await new Promise(r => setTimeout(r, 20))
    const st2 = await fetchState()
    assert.equal(st2.approvals.length, 1)
    const dec2 = await postCmd({ type: 'approval.decide', approvalId: st2.approvals[0].id, decision: 'once' })
    assert.equal(dec2.ok, true)
    const approvedRes = JSON.parse(await approvedPromise)
    assert.equal(approvedRes.ok, true)
    assert.equal(approvedRes.bot.name, 'ApprovedWorkerBot')

    for (const d of effects) {
      if (typeof d === 'function') d()
    }
  }

  // --- 4. Per-Bot Daily Token Budget Circuit Breaker ------------------------
  {
    const store = new BotStore(join(tempHome, 'botmode-budget'))
    await store.load()
    const bot = {
      id: 'bot_budget',
      name: 'BudgetBot',
      dir: '',
      sessionId: '',
      dailyTokenLimit: 100,
      tokenUsage: { day: '', tokens: 0 },
      tools: { allow: [], deny: [] },
    }
    await store.mutate(s => s.bots.push(bot))

    let turnCount = 0
    let fakeAgent
    const fakeController = {
      async create() { return { sessionId: 'sess_budget_1' } },
      async resolveAgent() {
        if (!fakeAgent) {
          const events = []
          fakeAgent = {
            session: { id: 'sess_budget_1', header: { id: 'sess_budget_1' }, ownEvents: () => events },
            model: { select() {} },
            followup() {
              turnCount += 1
              events.push({
                type: 'assistant/message',
                seq: events.length,
                data: {
                  usage: { inputTokens: 40, outputTokens: 25 },
                  message: { content: [{ type: 'text', text: `reply ${turnCount}` }] },
                },
              })
            },
            async whenIdle() {},
          }
        }
        return { agent: fakeAgent }
      },
    }
    const fakeCtx = {
      get: (k) => (k === 'sessionController' ? fakeController : undefined),
      sessions: { async flush() {} },
    }
    const budgetAlerts = []
    const dispatcher = new Dispatcher(fakeCtx, store, logger, async () => {})
    dispatcher.setBudgetExceededHandler(info => budgetAlerts.push(info))

    // Turn 1: 65 tokens (under 100)
    const r1 = await dispatcher.enqueue(bot.id, 'first')
    assert.equal(r1.ok, true)
    assert.equal(store.bot(bot.id).tokenUsage.tokens, 65)

    // Turn 2: +65 -> 130 tokens (succeeds, now >= 100)
    const r2 = await dispatcher.enqueue(bot.id, 'second')
    assert.equal(r2.ok, true)
    assert.equal(store.bot(bot.id).tokenUsage.tokens, 130)

    // Turn 3: blocked immediately by daily budget circuit breaker!
    const r3 = await dispatcher.enqueue(bot.id, 'third')
    assert.equal(r3.ok, false)
    assert.equal(r3.code, 'budget_exceeded')
    assert.equal(turnCount, 2, 'must not execute turn once daily token limit is exceeded')
    assert.equal(budgetAlerts.length, 1)
    assert.equal(budgetAlerts[0].limit, 100)
  }

  // --- 5. Inbound Webhooks (Bearer + HMAC) & Outbound NotificationHub -------
  {
    const receivedOutbounds = []
    notifyServer = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        receivedOutbounds.push({ headers: req.headers, body: JSON.parse(body || '{}') })
        res.statusCode = 200
        res.end('ok')
      })
    })
    await new Promise(resolveListen => notifyServer.listen(0, '127.0.0.1', resolveListen))
    const port = notifyServer.address().port
    const outboundUrl = `http://127.0.0.1:${port}/notify`

    const store = new BotStore(join(tempHome, 'botmode-channels'))
    await store.load()
    await store.mutate((s) => {
      s.bots.push({ id: 'bot_ch', name: 'AlertBot', dir: '', sessionId: '', tools: { allow: [], deny: [] } })
      s.rooms.push({ id: 'room_ch', name: 'OpsRoom', memberIds: ['bot_ch'], transcript: [], subtasks: [] })
      s.settings.notifications = {
        enabled: true,
        desktopNotifications: true,
        webhookUrl: outboundUrl,
        webhookFormat: 'generic',
        webhookSecret: 'notify-secret-123',
        onApproval: true,
        onScreenHelp: true,
        onRoomComplete: true,
        onBudgetExceeded: true,
        onRoutineError: true,
      }
    })

    const dispatched = []
    const roomSent = []
    const fakeDispatcher = {
      status: () => ({ busy: {}, last: {} }),
      inRoom: () => false,
      dispatch(botId, text, opts) {
        dispatched.push({ botId, text, opts })
        return { ok: true, accepted: true, queued: 0 }
      },
    }
    const fakeRooms = {
      state: () => ({ running: false, stopping: false }),
      async send(roomId, text) {
        roomSent.push({ roomId, text })
        return { ok: true }
      },
    }
    const approvals = new Approvals(store, logger)
    const notifications = new NotificationHub({ store, logger })
    const webhooks = new WebhookManager({ store, dispatcher: fakeDispatcher, rooms: fakeRooms, logger })
    const api = new BotApi({
      ctx: { get: () => undefined }, // No browser connection -> /state must still 503 fail-closed!
      store,
      dispatcher: fakeDispatcher,
      rooms: fakeRooms,
      routines: {},
      approvals,
      notifications,
      webhooks,
      logger,
    })

    // Fail-closed check: normal API without connection STILL returns 503
    const stateRes = makeMockRes()
    await api.handle(makeMockReq('GET', '/botmode/api/state'), stateRes)
    assert.equal(stateRes.statusCode, 503)

    // Create Bot webhook & Room webhook
    const botHook = await webhooks.save('', {
      name: 'GitHub Hook',
      targetKind: 'bot',
      targetId: 'bot_ch',
    })
    const roomHook = await webhooks.save('', {
      name: 'Incident Room Hook',
      targetKind: 'room',
      targetId: 'room_ch',
    })

    // Missing secret -> 401
    const unauthRes = makeMockRes()
    await api.handle(makeMockReq('POST', `/botmode/api/webhook/${botHook.id}`, {}, '{"event":"push"}'), unauthRes)
    assert.equal(unauthRes.statusCode, 401)

    // Valid Bearer secret -> 202 and wakes Bot
    const bearerRes = makeMockRes()
    await api.handle(makeMockReq('POST', `/botmode/api/webhook/${botHook.id}`, {
      authorization: `Bearer ${botHook.secret}`,
      'content-type': 'application/json',
    }, JSON.stringify({ event: 'pr.opened', pr: 42 })), bearerRes)
    assert.equal(bearerRes.statusCode, 202)
    assert.equal(dispatched.length, 1)
    assert.equal(dispatched[0].botId, 'bot_ch')
    assert.ok(dispatched[0].text.includes('pr.opened'))
    assert.equal(webhooks.get(botHook.id).triggerCount, 1)

    // Valid HMAC-SHA256 signature -> 202 and wakes Group Room
    const roomBody = JSON.stringify({ event: 'alert.firing', service: 'checkout' })
    const sig = `sha256=${createHmac('sha256', roomHook.secret).update(roomBody).digest('hex')}`
    const hmacRes = makeMockRes()
    await api.handle(makeMockReq('POST', `/botmode/api/webhook/${roomHook.id}`, {
      'x-hub-signature-256': sig,
      'content-type': 'application/json',
    }, roomBody), hmacRes)
    assert.equal(hmacRes.statusCode, 202)
    assert.equal(roomSent.length, 1)
    assert.equal(roomSent[0].roomId, 'room_ch')
    assert.ok(roomSent[0].text.includes('checkout'))

    // Disabled webhook -> 403
    await webhooks.save(botHook.id, { enabled: false })
    const disRes = makeMockRes()
    await api.handle(makeMockReq('POST', `/botmode/api/webhook/${botHook.id}`, {
      authorization: `Bearer ${botHook.secret}`,
    }, '{}'), disRes)
    assert.equal(disRes.statusCode, 403)

    // Outbound NotificationHub delivery + HMAC signature verification + IM formatters
    const notifyRes = await notifications.notify({
      kind: 'approval',
      title: 'Approval Needed',
      summary: 'Bot wants to delete room',
      botName: 'AlertBot',
    })
    assert.equal(notifyRes.ok, true)
    assert.equal(receivedOutbounds.length, 1)
    assert.equal(receivedOutbounds[0].body.kind, 'approval')
    assert.ok(String(receivedOutbounds[0].headers['x-botmode-signature'] || '').startsWith('sha256='))

    // Verify all 5 IM payload formats
    for (const fmt of ['generic', 'feishu', 'wecom', 'dingtalk', 'slack']) {
      const { body } = formatOutboundPayload(fmt, { kind: 'room_complete', title: 'Done', summary: 'All green', botName: 'AlertBot' })
      assert.equal(typeof body, 'object')
      if (fmt === 'feishu') assert.equal(body.msg_type, 'text')
      if (fmt === 'wecom') assert.equal(body.msgtype, 'markdown')
      if (fmt === 'dingtalk') assert.equal(body.msgtype, 'markdown')
      if (fmt === 'slack') assert.ok(body.text.includes('Done'))
    }
  }

  console.log('✓ governance-channels.test.mjs all assertions passed')
} finally {
  if (notifyServer) notifyServer.close()
  if (prevDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDshHome
  if (prevAgentsHome === undefined) delete process.env.AGENTS_HOME
  else process.env.AGENTS_HOME = prevAgentsHome
  await rm(tempHome, { recursive: true, force: true })
}
