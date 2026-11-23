/**
 * Comprehensive headless verification suite for @local/dsh-botmode v0.5.0.
 * Run with:
 *   node packages/dsh-botmode/test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotStore } from '../host/store.js'
import { nextCronTime, parseCron } from '../host/cron.js'
import { Dispatcher, MAX_AGENT_HOPS } from '../host/dispatch.js'
import { Rooms } from '../host/rooms.js'
import { BotApi } from '../host/api.js'
import { syncBotFiles, personaBlock } from '../host/persona.js'
import { Approvals } from '../host/approvals.js'
import { botModelCatalog, modelAcceptsImages, resolveBotSelection } from '../host/models.js'
import {
  hasUserEscalation,
  isPassReply,
  parseMentions,
  resolveInitialResponders,
  rotateGroupSpeakers,
  stripNonDirectiveText,
} from '../host/room-protocol.js'
import { MemoryManager } from '../host/memory/manager.js'

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await wait(10)
  }
  return false
}

const root = await mkdtemp(join(tmpdir(), 'botmode-test-'))
const logger = { info() {}, warn() {}, error() {} }

const store = new BotStore(root)
await store.load()

// --- 1. cron ---------------------------------------------------------------
assert.equal(parseCron('0 9 * * 1-5').hours.has(9), true)
assert.equal(parseCron('bad'), undefined)
{
  const from = new Date(2026, 10, 23, 8, 0, 0)
  const next = nextCronTime('0 9 * * 1-5', from)
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 0)
  assert.equal(next.getDay(), 1)
}

// --- 2. room-protocol pure functions ---------------------------------------
{
  const members = [
    { id: 'bot_admin', name: '管理员' },
    { id: 'bot_ops', name: '服务器管理员' },
    { id: 'bot_dev', name: 'AdminDev' },
  ]

  // Quoted example must NOT wake 服务器管理员
  const exampleText = '我只是举例说明，比如「@服务器管理员 扫描脚本你打算怎么切参数网格」，不用现在跑。'
  assert.deepEqual(parseMentions(exampleText, members), { all: false, botIds: [] })

  // Code fence, inline code and blockquote must NOT wake anyone
  const codeText = '参考用法：\n```\n@服务器管理员 --run\n```\n行内 `@管理员` 和引用：\n> @AdminDev 忽略'
  assert.deepEqual(parseMentions(codeText, members), { all: false, botIds: [] })

  // Real directive mention of longer name must NOT also trigger shorter prefix name
  const realOps = '@服务器管理员 请检查目录权限并准备 runner。'
  assert.deepEqual(parseMentions(realOps, members), { all: false, botIds: ['bot_ops'] })

  // Full-width ＠ and multiple mentions keep order
  const multi = '＠管理员 先确认，然后 @服务器管理员 跟进。'
  assert.deepEqual(parseMentions(multi, members), { all: false, botIds: ['bot_admin', 'bot_ops'] })

  // Email must NOT trigger Bot mention
  assert.deepEqual(parseMentions('联系 ops@AdminDev.com 处理', members), { all: false, botIds: [] })

  // @all / @everyone / @所有人
  assert.deepEqual(parseMentions('@所有人 同步一下进度', members, 'bot_admin'), {
    all: true,
    botIds: ['bot_ops', 'bot_dev'],
  })

  // Escalation (@user / @你) respects quotes & Chinese boundaries
  assert.equal(hasUserEscalation('需要人工确认，@你 看下方案'), true)
  assert.equal(hasUserEscalation('Need approval @user.'), true)
  assert.equal(hasUserEscalation('规则说明：需要人时写「@user」或 `@你`'), false)
  assert.equal(hasUserEscalation('请帮我转发给 @你们 团队'), false)

  // Silence token normalization
  for (const token of ['', '   ', '(pass)', '（pass）', '[NO_REPLY]', '【NO_REPLY】', '`(pass)`', '[NO_REPLY]。', 'NO_REPLY!', 'SILENT']) {
    assert.equal(isPassReply(token), true, `expected pass for ${JSON.stringify(token)}`)
  }
  assert.equal(isPassReply('I will pass the parameters to the script.'), false)
  assert.equal(isPassReply('@服务器管理员 请继续'), false)

  // Round-robin rotation
  assert.deepEqual(rotateGroupSpeakers(['a', 'b', 'c'], 0), ['a', 'b', 'c'])
  assert.deepEqual(rotateGroupSpeakers(['a', 'b', 'c'], 1), ['b', 'c', 'a'])
  assert.deepEqual(rotateGroupSpeakers(['a', 'b', 'c'], 2), ['c', 'a', 'b'])

  // stripNonDirectiveText sanity
  assert.ok(!stripNonDirectiveText('比如「@服务器管理员」').includes('@服务器管理员'))

  // resolveInitialResponders
  const autoRoom = { mode: 'auto', leadBotId: 'bot_admin' }
  const leadRoom = { mode: 'lead', leadBotId: 'bot_admin' }
  assert.deepEqual(resolveInitialResponders(autoRoom, '大家讨论下', members, 0).botIds, ['bot_admin', 'bot_ops', 'bot_dev'])
  assert.deepEqual(resolveInitialResponders(autoRoom, '@服务器管理员 看下磁盘', members, 0).botIds, ['bot_ops'])
  assert.deepEqual(resolveInitialResponders(leadRoom, '大家讨论下', members, 0).botIds, ['bot_admin'])
}

// --- 3. store + persona ----------------------------------------------------
let alpha
await store.mutate((state) => {
  alpha = {
    id: 'bot_alpha', name: 'Alpha', role: 'Research', instructions: 'Find sources.',
    color: '#111111', sectionId: 'general', hidden: false, pinned: false, order: 0,
    dir: '', sessionId: 's_alpha', model: { provider: '', model: '', reasoningEffort: '' },
    tools: { allow: [], deny: [] }, skills: [], createdAt: new Date().toISOString(),
  }
  state.bots.push(alpha)
})
await store.ensureBotDir(alpha)
await syncBotFiles(store, alpha, store.state)
const persona = await personaBlock(store, alpha, store.state)
assert.match(persona, /Alpha/)
assert.match(persona, /Find sources/)
assert.ok((await readFile(join(alpha.dir, 'SOUL.md'), 'utf8')).includes('Alpha'))

// --- 4. fake agent/controller + Dispatcher FIFO ----------------------------
function fakeAgent(id, log = [], options = {}) {
  const events = []
  let replyFn = () => ''
  let delayMs = options.delayMs ?? 5
  let busy = false
  let cancelled = false
  let timer = null
  const session = {
    id,
    ownEvents: () => events.slice(),
    events,
    header: { id },
  }
  const agent = {
    session,
    cancelledCount: 0,
    prompts: [],
    model: { selected: [], select(selection) { this.selected.push(selection) } },
    ctx: { effect(fn) { return fn() }, get() { return undefined } },
    followup(message) {
      busy = true
      cancelled = false
      const text = message.content[0].text
      this.prompts.push(text)
      log.push(`start:${id}:${text}`)
      timer = setTimeout(() => {
        if (cancelled) { busy = false; return }
        const seq = events.length
        events.push({ type: 'user/message', seq, time: Date.now(), data: message })
        const out = replyFn(text, id)
        events.push({
          type: 'assistant/message', seq: seq + 1, time: Date.now(),
          data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: out }] }, stream: [] },
        })
        busy = false
      }, delayMs)
      this._last = message
    },
    whenIdle() {
      return new Promise((resolve) => {
        const check = () => {
          if (busy) { setTimeout(check, 2); return }
          log.push(`end:${id}:${this._last.content[0].text}`)
          resolve()
        }
        check()
      })
    },
    cancel() {
      this.cancelledCount += 1
      cancelled = true
      if (timer) clearTimeout(timer)
      busy = false
    },
    setReply(value) { replyFn = typeof value === 'function' ? value : () => value },
    setDelay(ms) { delayMs = ms },
  }
  return agent
}

const agents = new Map()
const ctx = {
  get(name) {
    if (name === 'sessionController') {
      return {
        async create({ cwd }) {
          const id = `s_${agents.size + 10}`
          const ag = fakeAgent(id)
          ag.cwd = cwd
          agents.set(id, ag)
          return { sessionId: id }
        },
        async resolveAgent(id) {
          const agent = agents.get(id)
          return agent ? { agent } : { error: new Error('not found') }
        },
      }
    }
    if (name === 'agents') return agents
    if (name === 'sessions') return { flush: async () => true }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'prov', model: 'default-model' }) }
    if (name === 'llm') {
      return {
        listProviders: () => [{ id: 'prov', name: 'Provider' }],
        async listModels(provider) { return provider === 'prov' ? [{ id: 'default-model', name: 'Default model' }, { id: 'text-only', name: 'Text only' }] : [] },
        async resolveModelInfo(provider, id) {
          return {
            provider, id, name: id,
            inputModalities: id === 'text-only' ? ['text'] : ['text', 'image'],
            reasoning: id === 'default-model' ? { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } : undefined,
          }
        },
      }
    }
    if (name === 'attachments') {
      return {
        async admitPromptContent(parts) { return parts.map(part => part.type === 'image' ? { type: 'image', attachment: part.attachment } : part) },
        async saveImages(inputs) {
          return inputs.map(input => ({ attachmentId: 'sha256:uploaded', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, ...input.name ? { name: input.name } : {} }))
        },
      }
    }
    if (name === 'tools') return { definitions: () => [{ name: 'bash' }] }
    if (name === 'connection') return undefined
    return undefined
  },
  logger,
}

const dispatcher = new Dispatcher(ctx, store, logger)
const order = []
agents.set('s_alpha', fakeAgent('s_alpha', order))
agents.get('s_alpha').setReply('alpha reply')
const result = await dispatcher.enqueue('bot_alpha', 'hello')
assert.equal(result.ok, true)
assert.equal(result.text, 'alpha reply')
assert.deepEqual(agents.get('s_alpha').model.selected.at(-1), { provider: 'prov', model: 'default-model' })

// FIFO: two turns on the same primary Session do not interleave.
agents.get('s_alpha').setReply('second')
order.length = 0
const first = dispatcher.enqueue('bot_alpha', 'one')
const second = dispatcher.enqueue('bot_alpha', 'two')
await Promise.all([first, second])
assert.deepEqual(order, ['start:s_alpha:one', 'end:s_alpha:one', 'start:s_alpha:two', 'end:s_alpha:two'])

// --- 5. per-Bot model & image capability -----------------------------------
{
  const alphaBot = store.bot('bot_alpha')
  const image = { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: 12, width: 1, height: 1 }
  const withImage = await dispatcher.enqueue('bot_alpha', 'look at this', { images: [image] })
  assert.equal(withImage.ok, true)
  assert.deepEqual(agents.get('s_alpha')._last.content.at(-1), { type: 'image', attachment: image })

  await store.mutate((state) => {
    const stored = state.bots.find(bot => bot.id === alphaBot.id)
    stored.model = { provider: 'prov', model: 'text-only', reasoningEffort: '' }
  })
  const rejected = await dispatcher.enqueue('bot_alpha', 'look again', { images: [image] })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /does not accept image input/)
  await store.mutate((state) => {
    const stored = state.bots.find(bot => bot.id === alphaBot.id)
    stored.model = { provider: '', model: '', reasoningEffort: '' }
  })
}

// --- 6. model catalog ------------------------------------------------------
{
  const modelCtx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'alpha', model: 'a1' }) }
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'alpha', name: 'Alpha' }, { id: 'broken', name: 'Broken' }],
          async listModels(provider) {
            if (provider === 'broken') throw new Error('provider offline')
            return [
              { id: 'a1', name: 'A One' },
              { id: 'a2', name: 'A Two', inputModalities: ['text', 'image'] },
            ]
          },
          async resolveModelInfo(provider, id) {
            if (id === 'a1') {
              return {
                provider, id, name: 'A One', inputModalities: ['text'],
                reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
              }
            }
            return { provider, id, name: 'A Two', inputModalities: ['text', 'image'] }
          },
        }
      }
      return undefined
    },
  }
  const catalog = await botModelCatalog(modelCtx, { force: true })
  assert.equal(catalog.default.provider, 'alpha')
  assert.equal(catalog.groups[0].models[0].vision, false)
  assert.equal(catalog.groups[0].models[1].vision, true)
  assert.equal(catalog.failures[0].id, 'broken')
  assert.deepEqual(resolveBotSelection(modelCtx, { model: { provider: '', model: '', reasoningEffort: '' } }), { provider: 'alpha', model: 'a1' })
  assert.equal(await modelAcceptsImages(modelCtx, { provider: 'alpha', model: 'a2' }), true)
  assert.equal(await modelAcceptsImages(modelCtx, { provider: 'alpha', model: 'a1' }), false)
}

// --- 7. Group Rooms: isolated hidden sessions, relay, watermark, pass->settled, capped, epoch, stop ---
await store.mutate((state) => {
  state.bots.push(
    {
      id: 'bot_admin', name: '管理员', role: 'Coordinator', instructions: '',
      color: '#222222', sectionId: 'general', hidden: false, pinned: false, order: 1,
      dir: '', sessionId: 's_admin', model: { provider: '', model: '', reasoningEffort: '' },
      tools: { allow: [], deny: [] }, skills: [], createdAt: new Date().toISOString(),
    },
    {
      id: 'bot_ops', name: '服务器管理员', role: 'Infra', instructions: '',
      color: '#333333', sectionId: 'general', hidden: false, pinned: false, order: 2,
      dir: '', sessionId: 's_ops', model: { provider: '', model: '', reasoningEffort: '' },
      tools: { allow: [], deny: [] }, skills: [], createdAt: new Date().toISOString(),
    },
  )
})
agents.set('s_admin', fakeAgent('s_admin'))
agents.set('s_ops', fakeAgent('s_ops'))

// 7a. Full multi-round relay + hidden sessions + inRoom accuracy + (pass) -> settled
{
  const primaryAdminBefore = agents.get('s_admin').prompts.length
  const primaryOpsBefore = agents.get('s_ops').prompts.length

  const rooms = new Rooms(store, dispatcher, logger)
  const room = await rooms.save('', {
    name: '运维讨论群',
    memberIds: ['bot_admin', 'bot_ops'],
    mode: 'auto',
    purpose: '协调脚本参数扫描任务',
    maxRounds: 4,
    maxMessages: 10,
  })

  // Pre-create hidden room sessions so we can script deterministic replies on them.
  const adminRoomSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
  const opsRoomSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)
  assert.notEqual(adminRoomSid, 's_admin', 'room session must be isolated from primary session')
  assert.notEqual(opsRoomSid, 's_ops', 'room session must be isolated from primary session')

  let adminTurn = 0
  let observedOpsInRoomDuringAdminTurn = false
  agents.get(adminRoomSid).setReply((prompt) => {
    adminTurn += 1
    observedOpsInRoomDuringAdminTurn = dispatcher.inRoom('bot_ops')
    if (adminTurn === 1) {
      // Real directive handoff to 服务器管理员
      return '明白，我负责汇总。@服务器管理员 请确认目录与 runner 切片方案。'
    }
    // Round 2: received ops handoff, nothing more needed -> full-width （pass）
    assert.ok(prompt.includes('目录已就绪'), 'Admin round 2 must receive Ops reply via delta')
    return '（pass）'
  })

  let opsTurn = 0
  agents.get(opsRoomSid).setReply((prompt) => {
    opsTurn += 1
    assert.ok(prompt.includes('请确认目录与 runner 切片方案'), 'Ops must receive Admin handoff via watermark delta')
    return '目录已就绪，runner 已切好。@管理员 请确认是否还有补充。'
  })

  await rooms.send(room.id, '@管理员 启动扫描任务协调')
  const done = await waitUntil(() => store.room(room.id).status === 'settled', 3000)
  assert.equal(done, true, `expected settled, got ${store.room(room.id).status}`)

  const finalRoom = store.room(room.id)
  assert.equal(observedOpsInRoomDuringAdminTurn, true, 'all active room members must report inRoom=true while room is running')
  assert.equal(dispatcher.inRoom('bot_ops'), false, 'inRoom clears after room settles')
  assert.equal(adminTurn, 2)
  assert.equal(opsTurn, 1)
  assert.equal(finalRoom.settledReason, 'silent_round')
  // User + Admin + Ops = 3 messages; （pass） MUST NOT appear as a chat bubble!
  assert.equal(finalRoom.transcript.length, 3)
  assert.ok(finalRoom.activity.some(a => a.kind === 'passed' && a.botId === 'bot_ops' || a.kind === 'passed' && a.botId === 'bot_admin'))
  assert.ok(finalRoom.activity.some(a => a.kind === 'settled'))
  // Primary chat sessions remained completely untouched!
  assert.equal(agents.get('s_admin').prompts.length, primaryAdminBefore)
  assert.equal(agents.get('s_ops').prompts.length, primaryOpsBefore)
  // JSONL archive exists
  const jsonl = await readFile(store.roomLogPath(room.id), 'utf8')
  assert.ok(jsonl.includes('message.user') && jsonl.includes('room.settled'))

  // 7b. Quoted example must NOT wake Ops
  let opsBeforeQuote = opsTurn
  adminTurn = 10
  agents.get(adminRoomSid).setReply(() => '这里仅作格式说明，比如「@服务器管理员 扫描脚本怎么切」，本轮无需操作。')
  await rooms.save(room.id, { name: '运维讨论群', memberIds: ['bot_admin', 'bot_ops'], mode: 'lead', leadBotId: 'bot_admin' })
  await rooms.send(room.id, '给大家示范一下格式')
  const quoteDone = await waitUntil(() => store.room(room.id).status === 'settled', 3000)
  assert.equal(quoteDone, true)
  assert.equal(opsTurn, opsBeforeQuote, 'quoted @服务器管理员 must NOT trigger Ops')
  assert.equal(store.room(room.id).settledReason, 'no_mentions')

  await rooms.remove(room.id)
}

// 7c. Hard cap (`capped`, never disguised as `idle`/`settled`) + Continue
{
  const rooms = new Rooms(store, dispatcher, logger)
  const room = await rooms.save('', {
    name: '上限验证群',
    memberIds: ['bot_admin', 'bot_ops'],
    mode: 'auto',
    maxRounds: 2,
    maxMessages: 10,
  })
  const adminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
  const opsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)
  let n = 0
  agents.get(adminSid).setReply(() => `管理员发言 #${++n} @服务器管理员`)
  agents.get(opsSid).setReply(() => `运维发言 #${++n} @管理员`)

  await rooms.send(room.id, '开始头脑风暴')
  const capped = await waitUntil(() => store.room(room.id).status === 'capped', 3000)
  assert.equal(capped, true, `expected capped, got ${store.room(room.id).status}`)
  assert.equal(store.room(room.id).needsYou, true)
  assert.equal(store.room(room.id).pausedReason, 'budget')
  assert.equal(store.room(room.id).budget.rounds, 2)

  // Continue extends budget; now both reply (pass) -> transitions cleanly to settled
  agents.get(adminSid).setReply(() => '(pass)')
  agents.get(opsSid).setReply(() => '(pass)')
  await rooms.control(room.id, 'continue')
  const settledAfterContinue = await waitUntil(() => store.room(room.id).status === 'settled', 3000)
  assert.equal(settledAfterContinue, true)
  await rooms.remove(room.id)
}

// 7d. Epoch supersession (human interjects mid-turn) + Watermark anti-miss + Stop cancellation
{
  const rooms = new Rooms(store, dispatcher, logger)
  const room = await rooms.save('', {
    name: '打断验证群',
    memberIds: ['bot_admin', 'bot_ops'],
    mode: 'lead',
    leadBotId: 'bot_admin',
  })
  const adminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
  const opsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)

  agents.get(adminSid).setDelay(80)
  let adminPrompts = []
  agents.get(adminSid).setReply((prompt) => {
    adminPrompts.push(prompt)
    if (prompt.includes('新指令：立刻停掉扫描')) {
      return '收到新指令，已切换为查日志。'
    }
    return '旧方案 @服务器管理员'
  })
  let opsCalled = 0
  agents.get(opsSid).setReply(() => { opsCalled += 1; return 'ops' })

  await rooms.send(room.id, '旧任务：开始全量扫描')
  await wait(20) // Admin is mid-turn on epoch 1
  await rooms.send(room.id, '新指令：立刻停掉扫描改看错误日志')
  assert.equal(store.room(room.id).epoch, 2)

  const settledEpoch2 = await waitUntil(() => store.room(room.id).status === 'settled', 3000)
  assert.equal(settledEpoch2, true)
  // Old epoch's @服务器管理员 was superseded and never executed!
  assert.equal(opsCalled, 0, 'superseded epoch must NOT schedule stale handoffs')
  // Admin saw the human interjection in epoch 2 because watermark only advanced to deliveredThrough!
  assert.ok(adminPrompts.some(p => p.includes('新指令：立刻停掉扫描改看错误日志')), 'watermark anti-miss failed')

  // Stop cancels in-flight room turn immediately
  agents.get(adminSid).setDelay(500)
  await rooms.send(room.id, '长任务')
  await wait(20)
  const beforeCancel = agents.get(adminSid).cancelledCount
  await rooms.control(room.id, 'stop')
  assert.ok(agents.get(adminSid).cancelledCount > beforeCancel, 'stop must cancel the active room session turn')
  assert.equal(store.room(room.id).status, 'idle')

  await rooms.remove(room.id)
}

// --- 8. message_agent loop guards (hops, dedup, ambiguity, room-session block) ---
{
  // Block inside hidden room session
  const rooms = new Rooms(store, dispatcher, logger)
  const room = await rooms.save('', { name: 'GuardRoom', memberIds: ['bot_admin', 'bot_ops'] })
  const adminRoomSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
  const blocked = await dispatcher.messageAgent('bot_admin', '服务器管理员', 'hi', false, adminRoomSid)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'unavailable_in_room')
  await rooms.remove(room.id)

  // Duplicate in same chain rejected
  dispatcher.dispatch('bot_admin', 'human kick', { source: 'api' })
  await wait(20)
  const dm1 = await dispatcher.messageAgent('bot_admin', 'bot_ops', 'check disk usage', false)
  assert.equal(dm1.ok, true)
  const dmDup = await dispatcher.messageAgent('bot_admin', 'bot_ops', 'check   disk   usage', false)
  assert.equal(dmDup.ok, false)
  assert.equal(dmDup.code, 'duplicate_in_chain')

  // Hop budget enforced after MAX_AGENT_HOPS relays
  dispatcher.dispatch('bot_admin', 'fresh human chain', { source: 'api' })
  await wait(20)
  let from = 'bot_admin'
  let to = 'bot_ops'
  for (let hop = 1; hop <= MAX_AGENT_HOPS; hop += 1) {
    const res = await dispatcher.messageAgent(from, to, `step ${hop}`, false)
    assert.equal(res.ok, true, `hop ${hop} should succeed`)
    ;[from, to] = [to, from]
  }
  const overHop = await dispatcher.messageAgent(from, to, 'one too many', false)
  assert.equal(overHop.ok, false)
  assert.equal(overHop.code, 'max_hops_exceeded')
}

// --- 9. Team Memory Hub: memory_tencentdb v3 Gateway + fallback + isolation + install/uninstall ---
{
  const seenRequests = []
  const mockGateway = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    seenRequests.push({ method: req.method, url: req.url, headers: req.headers, body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok', version: '0.1.0', stores: { ftsAvailable: true } }))
      return
    }
    if (req.url === '/v3/atomic/search') {
      res.end(JSON.stringify({
        code: 0,
        data: { items: [{ type: 'fact', content: `Scoped memory for ${body.agent_id}: grid uses 4 GPUs` }] },
      }))
      return
    }
    if (req.url === '/v3/core/read') {
      res.end(JSON.stringify({ code: 0, data: { content: `Persona core for ${body.agent_id}` } }))
      return
    }
    if (req.url === '/v3/scenario/ls') {
      res.end(JSON.stringify({ code: 0, data: { entries: [{ path: 'deploy.md' }] } }))
      return
    }
    if (req.url === '/v3/scenario/read') {
      res.end(JSON.stringify({ code: 0, data: { content: `# Deploy Scene for ${body.agent_id}` } }))
      return
    }
    if (req.url === '/v3/conversation/add') {
      res.end(JSON.stringify({ code: 0, data: { added: body.messages?.length ?? 0 } }))
      return
    }
    if (req.url === '/v3/conversation/search') {
      res.end(JSON.stringify({ code: 0, data: { items: [{ role: 'user', content: `conv for ${body.agent_id}` }] } }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ code: 404, message: 'not found' }))
  })
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve))
  const port = mockGateway.address().port

  const memory = new MemoryManager(store, logger)
  await memory.configure({
    providerId: 'memory_tencentdb',
    teamId: 'team_prod',
    userId: 'u_owner',
    config: {
      gatewayHost: '127.0.0.1',
      gatewayPort: port,
      gatewayApiKey: 'secret-token-1234',
      serviceId: 'dsh-svc',
      fallbackLocal: true,
    },
  })
  await memory.select('memory_tencentdb')

  // Verify health & Gateway connectivity
  const status = await memory.status()
  assert.equal(status.provider, 'memory_tencentdb')
  assert.equal(status.health.ok, true)
  assert.equal(status.health.mode, 'gateway')
  // Secret masking check
  const tdProvider = status.providers.find(p => p.id === 'memory_tencentdb')
  assert.ok(tdProvider.config.gatewayApiKey.includes('••••'), 'API key must be masked in public state')

  // Wire into Dispatcher and verify prefetch + syncTurn with per-Bot agent_id isolation
  dispatcher.setMemoryManager(memory)
  agents.get('s_alpha').setReply('Acknowledged GPU grid plan.')
  const memTurn = await dispatcher.enqueue('bot_alpha', '请制定 GPU 参数网格扫描计划', { source: 'api' })
  assert.equal(memTurn.ok, true)
  await wait(40)

  const lastAlphaPrompt = agents.get('s_alpha').prompts.at(-1)
  assert.ok(lastAlphaPrompt.includes('Scoped memory for bot_alpha: grid uses 4 GPUs'), 'prefetch L1 should inject into turn')
  assert.ok(lastAlphaPrompt.includes('Persona core for bot_alpha'), 'prefetch L3 should inject into turn')
  assert.ok(lastAlphaPrompt.includes('Scene: deploy'), 'prefetch L2 should inject into turn')

  const syncReq = seenRequests.find(r => r.url === '/v3/conversation/add')
  assert.ok(syncReq, 'syncTurn should POST /v3/conversation/add')
  assert.equal(syncReq.headers.authorization, 'Bearer secret-token-1234')
  assert.equal(syncReq.headers['x-tdai-service-id'], 'dsh-svc')
  assert.equal(syncReq.body.team_id, 'team_prod')
  assert.equal(syncReq.body.agent_id, 'bot_alpha')
  assert.equal(syncReq.body.user_id, 'u_owner')

  // Scene read & conversation search
  const sceneRes = await memory.readSceneForBot(store.bot('bot_alpha'), { sceneId: 'deploy' })
  assert.equal(sceneRes.ok, true)
  assert.ok(sceneRes.text.includes('bot_alpha'))

  mockGateway.close()

  // Fallback to local SQLite FTS5 when Gateway is unreachable + per-Bot isolation
  await memory.configure({
    providerId: 'memory_tencentdb',
    config: { gatewayHost: '127.0.0.1', gatewayPort: 1, fallbackLocal: true, timeoutMs: 1000 },
  })
  const fallbackHealth = await memory.test('memory_tencentdb')
  assert.equal(fallbackHealth.health.ok, true)
  assert.equal(fallbackHealth.health.mode, 'fallback-local')

  await memory.saveMemoryForBot(store.bot('bot_alpha'), { content: 'Alpha 专属约束：使用端口 9091', type: 'preference', scene: 'infra' })
  await memory.saveMemoryForBot(store.bot('bot_ops'), { content: 'Ops 专属约束：禁止重启主库', type: 'preference' })

  const alphaHits = await memory.searchMemoryForBot(store.bot('bot_alpha'), { query: '端口 9091' })
  assert.equal(alphaHits.ok, true)
  assert.ok(alphaHits.text.includes('9091'))
  const opsCross = await memory.searchMemoryForBot(store.bot('bot_ops'), { query: '9091' })
  assert.equal(opsCross.items.length, 0, 'Bot memories must be isolated by agent_id')

  // Switch globally to built-in local_sqlite provider
  const switched = await memory.select('local_sqlite')
  assert.equal(switched.provider, 'local_sqlite')
  assert.equal(switched.health.mode, 'local-sqlite')
  await memory.saveMemoryForBot(store.bot('bot_admin'), { content: '本地 SQLite 记忆：周五例会改到十点', type: 'fact' })
  const localHits = await memory.searchMemoryForBot(store.bot('bot_admin'), { query: '周五例会' })
  assert.ok(localHits.text.includes('十点'))

  // Install curated catalog plugin (`catalog:mem0_http`), activate & verify
  const installedCatalog = await memory.install('catalog:mem0_http', { activate: true })
  assert.equal(installedCatalog.installed.id, 'mem0_http')
  assert.equal(memory.activeId, 'mem0_http')

  // Install a custom third-party memory plugin from a local directory & hot-swap
  const customPluginDir = await mkdtemp(join(tmpdir(), 'custom-mem-plugin-'))
  await writeFile(join(customPluginDir, 'plugin.json'), JSON.stringify({
    id: 'my_custom_mem',
    displayName: 'Custom Echo Memory',
    version: '0.1.0',
    entry: 'index.js',
  }))
  await writeFile(join(customPluginDir, 'index.js'), `
    export function createProvider(manifest) {
      return {
        id: manifest.id,
        async health() { return { ok: true, mode: 'custom-echo', detail: 'echo ready' } },
        async searchMemory({ query, agentId }) { return { ok: true, items: [{ type: 'echo', content: agentId + ':' + query }], text: agentId + ':' + query } },
      }
    }
  `)
  const customInstalled = await memory.install(customPluginDir, { activate: true })
  assert.equal(customInstalled.installed.id, 'my_custom_mem')
  const customSearch = await memory.searchMemoryForBot(store.bot('bot_ops'), { query: 'hello' })
  assert.equal(customSearch.text, 'bot_ops:hello')

  // Bundled providers are protected from uninstall; external plugins uninstall cleanly
  await assert.rejects(() => memory.uninstall('memory_tencentdb'), /cannot be uninstalled/i)
  await memory.uninstall('my_custom_mem')
  assert.equal(memory.activeId, 'memory_tencentdb', 'uninstalling active external plugin restores memory_tencentdb')
  await memory.uninstall('mem0_http')
  await rm(customPluginDir, { recursive: true, force: true })

  // --- 10. approvals + API (including /memory and memory.* commands) -------
  {
    const approvals = new Approvals(store, logger)
    const alphaBot = store.bot('bot_alpha')
    const pending = approvals.ask(alphaBot, { toolName: 'bash', reason: 'rm -rf build' })
    assert.equal(approvals.list().length, 1)
    await approvals.decide(approvals.list()[0].id, 'always')
    assert.equal(await pending, 'allowed-once')
    assert.equal(store.bot('bot_alpha').approvalPolicy, 'always')
  }

  const apiRooms = new Rooms(store, dispatcher, logger)
  const api = new BotApi({
    ctx, store, dispatcher, rooms: apiRooms, memory,
    approvals: new Approvals(store, logger),
    routines: { save: async () => ({}), remove: async () => {}, setEnabled: async () => ({}), runNow: async () => ({}) },
    logger,
  })
  function fakeRequest(method, path, body) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    return {
      method,
      url: path,
      headers: {},
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
  }
  function fakeResponse() {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(name, value) { this.headers[name] = value },
      end(value) { this.body = value },
    }
  }
  {
    const res = fakeResponse()
    await api.handle(fakeRequest('GET', '/botmode/api/state'), res)
    assert.equal(res.statusCode, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.ok(payload.state.memory && payload.state.memory.provider === 'memory_tencentdb')
  }
  {
    const res = fakeResponse()
    await api.handle(fakeRequest('GET', '/botmode/api/memory'), res)
    assert.equal(res.statusCode, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.ok(payload.memory.providers.some(p => p.id === 'memory_tencentdb'))
    assert.ok(payload.memory.providers.some(p => p.id === 'local_sqlite'))
  }
  {
    const res = fakeResponse()
    await api.handle(fakeRequest('POST', '/botmode/api/command', { type: 'memory.select', providerId: 'local_sqlite' }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).state.memory.provider, 'local_sqlite')
  }
  {
    const res = fakeResponse()
    await api.handle(fakeRequest('POST', '/botmode/api/command', { type: 'memory.search', botId: 'bot_admin', query: '周五例会' }), res)
    assert.equal(res.statusCode, 200)
    assert.ok(JSON.parse(res.body).result.text.includes('十点'))
  }
  {
    const res = fakeResponse()
    await api.handle(fakeRequest('GET', '/botmode/api/models'), res)
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).ok, true)
  }
  {
    const image = Buffer.from([137, 80, 78, 71])
    const req = {
      method: 'POST',
      url: '/botmode/api/image',
      headers: { 'content-type': 'image/png', 'x-botmode-image-name': encodeURIComponent('shot.png') },
      async *[Symbol.asyncIterator]() { yield image },
    }
    const res = fakeResponse()
    await api.handle(req, res)
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).attachment.name, 'shot.png')
  }

  dispatcher.setMemoryManager(null)
  await memory.shutdown()
}

await rm(root, { recursive: true, force: true })
console.log('all host, group-room and memory-hub tests passed')
