/**
 * Comprehensive headless verification suite for @local/dsh-botmode v0.6.0.
 * Run with:
 *   node packages/dsh-botmode/test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotStore, isStrictSubpath } from '../host/store.js'
import { nextCronTime, parseCron } from '../host/cron.js'
import { Dispatcher, MAX_AGENT_HOPS } from '../host/dispatch.js'
import { Rooms } from '../host/rooms.js'
import { BotApi } from '../host/api.js'
import { syncBotFiles, personaBlock, renderResponseFormatProtocol } from '../host/persona.js'
import { Approvals } from '../host/approvals.js'
import { botModelCatalog, modelAcceptsImages, resolveBotSelection } from '../host/models.js'
import {
  findUnresolvedMentions,
  hasUserEscalation,
  isPassReply,
  parseMentions,
  resolveInitialResponders,
  rotateGroupSpeakers,
  stripNonDirectiveText,
} from '../host/room-protocol.js'
import { checkRoomWriteSoftLock } from '../host/room-locks.js'
import { MemoryManager } from '../host/memory/manager.js'
import { MemoryPluginInstaller } from '../host/memory/installer.js'
import { LocalFourLayerStore } from '../host/memory/providers/memory_tencentdb/fallback.js'

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
      this.firstFollowupAt ??= Date.now()
      this.lastFollowupAt = Date.now()
      const text = message.content[0].text
      this.prompts.push(text)
      log.push(`start:${id}:${text}`)
      timer = setTimeout(async () => {
        if (cancelled) { busy = false; return }
        try {
          const rawOut = await replyFn(text, id, { events, agent })
          if (cancelled) { busy = false; return }
          const spec = typeof rawOut === 'object' && rawOut !== null
            ? rawOut
            : { text: String(rawOut ?? '') }
          let seq = events.length
          events.push({ type: 'user/message', seq: seq++, time: Date.now(), data: message })
          if (Array.isArray(spec.toolCalls)) {
            for (const tc of spec.toolCalls) {
              const callId = tc.callId || `call_${seq}`
              events.push({
                type: 'tool/call',
                seq: seq++,
                time: Date.now(),
                data: { callId, name: tc.name || 'bash', arguments: tc.arguments || {} },
              })
              events.push({
                type: 'tool/result',
                seq: seq++,
                time: Date.now(),
                data: {
                  message: {
                    toolCallId: callId,
                    name: tc.name || 'bash',
                    isError: tc.isError === true,
                    content: [{ type: 'text', text: String(tc.output ?? 'ok') }],
                  },
                },
              })
            }
          }
          if (spec.turnError) {
            events.push({
              type: 'turn/end',
              seq: seq++,
              time: Date.now(),
              data: { reason: { kind: 'error', error: { message: spec.turnError } } },
            })
          } else {
            events.push({
              type: 'assistant/message',
              seq: seq++,
              time: Date.now(),
              data: {
                turn: 1,
                step: 1,
                ...(spec.usage ? { usage: spec.usage } : {}),
                message: { role: 'assistant', content: [{ type: 'text', text: String(spec.text ?? '') }] },
                stream: [],
              },
            })
          }
        } finally {
          busy = false
        }
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
    if (name === 'connection') return { requestRejection: () => undefined }
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
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
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

// --- 11. v0.6 Task-Driven Concurrent Actor Bus, Probes, Soft-Locks & Approvals ---
{
  // Add a third Bot (`bot_dev`) so we can test 3-Bot concurrency, fault isolation & Lead acceptance.
  await store.mutate((state) => {
    state.bots.push({
      id: 'bot_dev',
      name: '前端工程师',
      role: 'Frontend',
      instructions: '',
      color: '#444444',
      sectionId: 'general',
      hidden: false,
      pinned: false,
      order: 3,
      dir: '',
      sessionId: 's_dev',
      model: { provider: '', model: '', reasoningEffort: '' },
      tools: { allow: [], deny: [] },
      skills: [],
      createdAt: new Date().toISOString(),
    })
  })
  agents.set('s_dev', fakeAgent('s_dev'))

  // 11a. Parallel Execution (No Slow-Bot Head-of-Line Blocking) + Snapshot Watermark Anti-Miss
  {
    const rooms = new Rooms(store, dispatcher, logger)
    const room = await rooms.save('', {
      name: '并发防漏看验证群',
      memberIds: ['bot_admin', 'bot_ops'],
      mode: 'auto',
    })
    // Default room has NO hard round/message cutoffs!
    assert.equal(room.budget.maxRounds, 0)
    assert.equal(room.budget.maxMessages, 0)

    const fastSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
    const slowSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)
    agents.get(fastSid).setDelay(15)
    agents.get(slowSid).setDelay(75)

    let fastFinishAt = 0
    let fastCalls = 0
    let slowCalls = 0
    let slowSawFastReply = false
    let fastSawSlowReply = false
    agents.get(fastSid).firstFollowupAt = undefined
    agents.get(slowSid).firstFollowupAt = undefined

    agents.get(fastSid).setReply((prompt) => {
      fastCalls += 1
      if (fastCalls === 1) {
        fastFinishAt = Date.now()
        return '快速Bot方案：采用缓存分片（用时15ms），请 @服务器管理员 同步核对压测口径'
      }
      if (prompt.includes('慢速Bot报告：压测已完成')) {
        fastSawSlowReply = true
      }
      // Plain text saying "任务已完成" MUST NOT close the room!
      if (fastCalls === 2) {
        return '顺便复述一下规则：不要因为正文写了「任务已完成」就关房间。'
      }
      return '(pass)'
    })

    agents.get(slowSid).setReply((prompt) => {
      slowCalls += 1
      if (slowCalls === 1) {
        return '慢速Bot报告：压测已完成（用时75ms），请 @管理员 查收结论'
      }
      // CRITICAL: Slow Bot finished AFTER Fast Bot got seq=2, so Slow Bot got seq=3.
      // Because Slow Bot's watermark only advanced to snapshotSeq=1 (NOT 3!), it MUST see seq=2!
      if (prompt.includes('快速Bot方案：采用缓存分片')) {
        slowSawFastReply = true
      }
      // Also ensure Slow Bot never re-ingests its own seq=3!
      assert.ok(!prompt.includes('慢速Bot报告：压测已完成（用时75ms）'), 'selfSentSeqs must filter own message')
      return '(pass)'
    })

    await rooms.send(room.id, '请大家并行给出方案与压测结果')
    const settled = await waitUntil(() => store.room(room.id).status === 'settled', 4000)
    assert.equal(settled, true, `expected settled, got ${store.room(room.id).status}`)
    // Both Bots launched concurrently BEFORE Fast Bot finished its 15ms turn!
    assert.ok(agents.get(slowSid).firstFollowupAt < fastFinishAt, 'Slow Bot must start concurrently without waiting for Fast Bot')
    assert.equal(slowSawFastReply, true, 'Slow Bot MUST NOT miss Fast Bot reply (Snapshot Watermark Anti-Miss)')
    assert.equal(fastSawSlowReply, true, 'Fast Bot MUST receive Slow Bot reply')
    // Plain text "任务已完成" did NOT mark status === 'completed'!
    assert.equal(store.room(room.id).status, 'settled')

    await rooms.remove(room.id)
    agents.get(fastSid)?.setDelay?.(5)
    agents.get(slowSid)?.setDelay?.(5)
  }

  // 11b. Shared `workDir` + `claim_subtask` + File Path Soft-Locks + `room_finish_task` (`completed`)
  {
    const sharedRepoDir = await mkdtemp(join(tmpdir(), 'botmode-shared-repo-'))
    const rooms = new Rooms(store, dispatcher, logger)
    const room = await rooms.save('', {
      name: '工程协作防撞车群',
      memberIds: ['bot_admin', 'bot_ops', 'bot_dev'],
      mode: 'lead',
      leadBotId: 'bot_admin',
      workDir: sharedRepoDir,
    })

    const adminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
    const opsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)
    const devSid = await dispatcher.ensureRoomSession(store.bot('bot_dev'), room.id)

    // Verify shared workDir applied to hidden room sessions
    assert.equal(agents.get(adminSid).cwd, sharedRepoDir)
    assert.equal(agents.get(devSid).cwd, sharedRepoDir)

    // Ops claims `src/server` directory
    const claimOps = await rooms.claimSubtask(room.id, store.bot('bot_ops'), {
      taskId: 'backend-api',
      title: '重构后端接口',
      paths: ['src/server'],
    })
    assert.equal(claimOps.ok, true)

    // Dev attempts to claim overlapping path `src/server/routes.js` -> rejected!
    const conflictClaim = await rooms.claimSubtask(room.id, store.bot('bot_dev'), {
      taskId: 'collide-task',
      paths: ['src/server/routes.js'],
    })
    assert.equal(conflictClaim.ok, false)
    assert.equal(conflictClaim.code, 'path_locked')

    // DSH Tool Layer Soft-Lock check: Dev tries `write` / `apply_patch` on `src/server/routes.js` -> blocked!
    const writeBlocked = checkRoomWriteSoftLock({
      room: store.room(room.id),
      callerBotId: 'bot_dev',
      toolName: 'write',
      args: { path: 'src/server/routes.js', content: 'hack' },
      baseDir: sharedRepoDir,
    })
    assert.ok(writeBlocked && writeBlocked.includes('正由 @服务器管理员 编辑中'), `expected soft-lock block, got ${writeBlocked}`)

    const patchBlocked = checkRoomWriteSoftLock({
      room: store.room(room.id),
      callerBotId: 'bot_dev',
      toolName: 'apply_patch',
      args: { patch: '*** Begin Patch\n*** Update File: src/server/index.js\n@@\n*** End Patch' },
      baseDir: sharedRepoDir,
    })
    assert.ok(patchBlocked && patchBlocked.includes('backend-api'))

    // Owner (`bot_ops`) writing its own leased file is ALLOWED (`undefined`)!
    const ownerAllowed = checkRoomWriteSoftLock({
      room: store.room(room.id),
      callerBotId: 'bot_ops',
      toolName: 'edit',
      args: { path: 'src/server/routes.js' },
      baseDir: sharedRepoDir,
    })
    assert.equal(ownerAllowed, undefined)

    // Non-lead (`bot_ops`) attempting `room_finish_task` in Lead room -> rejected!
    const nonLeadFinish = await rooms.finishTask(room.id, store.bot('bot_ops'), {
      summary: '我先关房间了',
    })
    assert.equal(nonLeadFinish.ok, false)
    assert.equal(nonLeadFinish.code, 'not_lead')

    // Lead (`bot_admin`) attempting `room_finish_task` while Ops subtask is still `in_progress` -> guarded!
    const prematureFinish = await rooms.finishTask(room.id, store.bot('bot_admin'), {
      summary: '提前收口',
    })
    assert.equal(prematureFinish.ok, false)
    assert.equal(prematureFinish.code, 'subtasks_in_progress')

    // Ops marks `backend-api` completed -> releases path lock!
    const doneOps = await rooms.claimSubtask(room.id, store.bot('bot_ops'), {
      taskId: 'backend-api',
      status: 'completed',
    })
    assert.equal(doneOps.ok, true)
    assert.equal(
      checkRoomWriteSoftLock({
        room: store.room(room.id),
        callerBotId: 'bot_dev',
        toolName: 'write',
        args: { path: 'src/server/routes.js' },
        baseDir: sharedRepoDir,
      }),
      undefined,
      'completing subtask must release soft-lock',
    )

    // Full end-to-end Lead acceptance flow driving room to `completed` across >5 rounds with tools!
    let step = 0
    agents.get(adminSid).setReply(async () => {
      step += 1
      if (step <= 6) {
        // 6 rounds WITH tool calls -> proves >5 rounds NEVER trigger `idle_spin` while doing real work!
        return {
          text: `第 ${step} 步检查通过，@服务器管理员 继续执行第 ${step} 批脚本`,
          toolCalls: [{ name: 'read', arguments: { path: 'README.md' }, output: 'ok' }],
        }
      }
      await rooms.finishTask(room.id, store.bot('bot_admin'), {
        summary: '全部 6 批脚本与接口改造验证通过',
        deliverables: ['src/server/routes.js', 'report.json'],
      })
      return '验收完毕。'
    })
    agents.get(opsSid).setReply(() => ({
      text: '本批脚本已跑完 @管理员',
      toolCalls: [{ name: 'bash', arguments: { command: 'npm test' }, output: 'PASS' }],
    }))

    await rooms.send(room.id, '开始执行完整 6 步迭代并验收')
    const completed = await waitUntil(() => store.room(room.id).status === 'completed', 5000)
    assert.equal(completed, true, `expected completed after 6+ tool rounds, got ${store.room(room.id).status}`)
    assert.equal(store.room(room.id).completion.finishedBy, 'bot_admin')
    assert.deepEqual(store.room(room.id).completion.deliverables, ['src/server/routes.js', 'report.json'])
    assert.ok(store.room(room.id).transcript.some(m => m.kind === 'completion'))

    await rooms.remove(room.id)
    await rm(sharedRepoDir, { recursive: true, force: true })
  }

  // 11c. Probe 1 (`idle_spin`): 5 consecutive pure-text rounds with zero tools -> soft-pause `stalled`
  {
    const rooms = new Rooms(store, dispatcher, logger)
    const room = await rooms.save('', {
      name: '空转探针验证群',
      memberIds: ['bot_admin', 'bot_ops'],
      mode: 'auto',
      idleRoundLimit: 5,
    })
    const adminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
    const opsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)

    let count = 0
    agents.get(adminSid).setReply(() => `纯客套复读 A-${++count} @服务器管理员`)
    agents.get(opsSid).setReply(() => `纯客套复读 B-${++count} @管理员`)

    await rooms.send(room.id, '聊聊想法')
    const stalled = await waitUntil(() => store.room(room.id).status === 'stalled', 4000)
    assert.equal(stalled, true, `expected stalled on idle_spin, got ${store.room(room.id).status}`)
    assert.equal(store.room(room.id).pausedReason, 'idle_spin')
    assert.equal(store.room(room.id).needsYou, true)

    await rooms.remove(room.id)
  }

  // 11d. Probe 2 (`paused_error`): Same Bot fails 3x with identical error fingerprint -> ONLY that Bot pauses, healthy Bot steps in!
  {
    const rooms = new Rooms(store, dispatcher, logger)
    const room = await rooms.save('', {
      name: '重复报错探针群',
      memberIds: ['bot_admin', 'bot_ops'],
      mode: 'auto',
    })
    const adminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
    const opsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)

    let opsFailures = 0
    let adminSawSystemHelp = false
    agents.get(opsSid).setReply(() => {
      opsFailures += 1
      return {
        text: '重试连接数据库 @管理员',
        toolCalls: [{
          name: 'bash',
          arguments: { command: 'psql -h 10.0.0.9' },
          isError: true,
          output: 'psql: error: connection refused (exit code 2)',
        }],
      }
    })
    agents.get(adminSid).setReply(async (prompt) => {
      if (prompt.includes('[异常探针 · 局部暂停]') && prompt.includes('服务器管理员')) {
        adminSawSystemHelp = true
        await rooms.finishTask(room.id, store.bot('bot_admin'), {
          summary: '已接管排障并切换备用库完成任务',
          deliverables: ['config/db-fallback.json'],
          force: true,
        })
        return '收到系统排障广播，我已直接切换备用配置完成任务。'
      }
      return '请 @服务器管理员 继续测试连接'
    })

    await rooms.send(room.id, '@服务器管理员 检查数据库连接')
    const rescued = await waitUntil(() => store.room(room.id).status === 'completed', 4000)
    assert.equal(rescued, true, `expected healthy Bot to rescue room to completed, got ${store.room(room.id).status}`)
    assert.equal(opsFailures, 3, 'Faulting Bot must pause locally right after 3 identical errors')
    assert.equal(adminSawSystemHelp, true, 'Teammate must receive system help broadcast when a Bot is locally fault-paused')

    await rooms.remove(room.id)
  }

  // 11e. Probe 3 (`token_budget` Soft Checkpoint) + Continue seamlessly extends checkpoint
  {
    const rooms = new Rooms(store, dispatcher, logger)
    const room = await rooms.save('', {
      name: '软预算检查点群',
      memberIds: ['bot_admin', 'bot_ops'],
      mode: 'lead',
      leadBotId: 'bot_admin',
      tokenLimit: 900,
    })
    const adminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
    const opsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)

    let phase = 1
    agents.get(adminSid).setReply(async () => {
      if (phase === 1) {
        return {
          text: '第一阶段完成，消耗 1000 tokens @服务器管理员',
          usage: { inputTokens: 700, outputTokens: 300, totalTokens: 1000 },
        }
      }
      await rooms.finishTask(room.id, store.bot('bot_admin'), {
        summary: '追加预算后顺利收口完成',
      })
      return '全部搞定'
    })
    agents.get(opsSid).setReply(() => ({
      text: '运维已完成配合 @管理员',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }))

    await rooms.send(room.id, '执行高消耗分析任务')
    const hitBudget = await waitUntil(() => store.room(room.id).status === 'stalled', 3000)
    assert.equal(hitBudget, true)
    assert.equal(store.room(room.id).pausedReason, 'token_budget')
    assert.ok(store.room(room.id).budget.tokensUsed >= 1000)

    // Clicking Continue extends `tokenCheckpoint` without losing session or watermarks!
    phase = 2
    await rooms.control(room.id, 'continue')
    const finishedAfterContinue = await waitUntil(() => store.room(room.id).status === 'completed', 3000)
    assert.equal(finishedAfterContinue, true)
    assert.ok(store.room(room.id).budget.tokenCheckpoint > 1000)

    await rooms.remove(room.id)
  }

  // 11f. Local Approval & Question Suspension (`waiting_user` without blocking parallel Bots) + Soft Steer without Hard Abort
  {
    const approvals = new Approvals(store, logger)
    // Reset bot_alpha/bot_admin approvalPolicy to 'ask'
    await store.mutate((state) => {
      for (const b of state.bots) b.approvalPolicy = 'ask'
    })
    const rooms = new Rooms(store, dispatcher, logger, approvals)
    const room = await rooms.save('', {
      name: '局部审批与软插话群',
      memberIds: ['bot_admin', 'bot_ops'],
      mode: 'auto',
    })
    const adminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
    const opsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)

    let opsFinishedWhileAdminWaitingApproval = false
    let adminTurnCount = 0
    agents.get(adminSid).setReply(async (prompt) => {
      adminTurnCount += 1
      if (adminTurnCount === 1) {
        const decision = await approvals.ask(
          store.bot('bot_admin'),
          { toolName: 'bash', reason: 'deploy staging' },
          { roomId: room.id },
        )
        assert.equal(decision, 'allowed-once')
        return '审批通过，预发部署完成。'
      }
      return '(pass)'
    })
    agents.get(opsSid).setReply(() => {
      if (approvals.list().length === 1) {
        opsFinishedWhileAdminWaitingApproval = true
      }
      return '我在并行写监控配置，完全没被管理员的审批卡住！'
    })

    await rooms.send(room.id, '管理员发预发，运维配监控')
    // Wait until Ops finishes its turn and room enters `waiting_user` (`approval`) instead of settling prematurely!
    const waitingApproval = await waitUntil(() => store.room(room.id).status === 'waiting_user', 3000)
    assert.equal(waitingApproval, true, `expected waiting_user while approval is pending, got ${store.room(room.id).status}`)
    assert.equal(store.room(room.id).pausedReason, 'approval')
    assert.equal(opsFinishedWhileAdminWaitingApproval, true, 'Parallel Bot MUST NOT be blocked by teammate approval')

    // Approve -> Admin resumes automatically and room converges to `settled`!
    await approvals.decide(approvals.list()[0].id, 'once')
    const settledAfterApproval = await waitUntil(() => store.room(room.id).status === 'settled', 3000)
    assert.equal(settledAfterApproval, true)

    // Verify `ask_user_question` (`askQuestion` + `decideQuestion`) bridge as well
    const pendingQ = approvals.askQuestion(
      store.bot('bot_ops'),
      { questions: [{ id: 'env', question: '部署到哪个区域？', options: [{ label: 'ap-guangzhou' }, { label: 'ap-shanghai' }] }] },
      { roomId: room.id },
    )
    assert.equal(approvals.listQuestions().length, 1)
    await approvals.decideQuestion(approvals.listQuestions()[0].id, [{ id: 'env', selected: ['ap-shanghai'] }])
    const answered = await pendingQ
    assert.deepEqual(answered, { answers: [{ id: 'env', selected: ['ap-shanghai'] }] })

    // Verify Soft Steer: sending a human follow-up while Ops is mid-turn does NOT `cancel()` Ops!
    agents.get(opsSid).setDelay(70)
    agents.get(adminSid).setDelay(10)
    const opsCancelBefore = agents.get(opsSid).cancelledCount
    let adminRespondedImmediatelyToSteer = false
    let opsAbsorbedSteer = false

    agents.get(opsSid).setReply((prompt) => {
      if (prompt.includes('补充要求：加上超时重试')) {
        opsAbsorbedSteer = true
        return '运维已吸纳补充要求加上重试。'
      }
      if (prompt.includes('管理员已立即响应补充要求')) return '(pass)'
      return '运维第一阶段脚本执行完'
    })
    agents.get(adminSid).setReply((prompt) => {
      if (prompt.includes('补充要求：加上超时重试') && !adminRespondedImmediatelyToSteer) {
        adminRespondedImmediatelyToSteer = true
        return '管理员已立即响应补充要求！'
      }
      return '(pass)'
    })

    await rooms.send(room.id, '第一阶段开始')
    await wait(25) // Admin (10ms) is already idle; Ops (70ms) is STILL running!
    await rooms.send(room.id, '补充要求：加上超时重试')
    assert.equal(agents.get(opsSid).cancelledCount, opsCancelBefore, 'Soft Steer MUST NOT hard-abort running Bot sessions')

    const settledAfterSteer = await waitUntil(() => store.room(room.id).status === 'settled', 4000)
    assert.equal(settledAfterSteer, true, `expected settled after soft steer, got status=${store.room(room.id).status} reason=${store.room(room.id).pausedReason} state=${JSON.stringify(rooms.state(room.id))}`)
    assert.equal(adminRespondedImmediatelyToSteer, true, 'Idle Bot must wake immediately on Soft Steer')
    assert.equal(opsAbsorbedSteer, true, 'Busy Bot must absorb Soft Steer immediately after finishing its step')

    await rooms.remove(room.id)
  }
}

// --- 12. Modular Settings, Response Format Protocol, Bot Files, Usage & Artifacts API ---
{
  // 12a. Response Format Protocol modular rendering
  const fullProtocol = renderResponseFormatProtocol(store.state.settings)
  assert.ok(fullProtocol.includes('Response Format & Rich Media Protocol'))
  assert.ok(fullProtocol.includes('[!WARNING]'))
  assert.ok(fullProtocol.includes('```mermaid'))
  assert.ok(fullProtocol.includes('<artifact'))
  assert.ok(fullProtocol.includes('```metrics'))

  const noArtifactsProtocol = renderResponseFormatProtocol({
    responseFormat: { enabled: true, extendedMarkdown: true, diagramsAndMath: false, artifacts: false, structuredCards: false, multimodal: false },
  })
  assert.ok(noArtifactsProtocol.includes('[!WARNING]'))
  assert.ok(!noArtifactsProtocol.includes('<artifact'))
  assert.ok(!noArtifactsProtocol.includes('```mermaid'))
  assert.equal(renderResponseFormatProtocol({ responseFormat: { enabled: false } }), '')

  // Persona block automatically injects the active response format protocol
  const richPersona = await personaBlock(store, store.bot('bot_alpha'), store.state)
  assert.ok(richPersona.includes('Response Format & Rich Media Protocol'))

  // 12b. Settings, Bot SOUL/MEMORY files, Logs, Usage & Artifacts via BotApi
  const settingsRooms = new Rooms(store, dispatcher, logger)
  const settingsApi = new BotApi({
    ctx, store, dispatcher, rooms: settingsRooms,
    approvals: new Approvals(store, logger),
    routines: { save: async () => ({}), remove: async () => {}, setEnabled: async () => ({}), runNow: async () => ({}) },
    logger,
  })

  // Save modular settings
  const savedSettings = await settingsApi.command({
    type: 'settings.save',
    responseFormat: { artifacts: false, structuredCards: true },
    groupChat: { defaultTokenLimit: 500_000, enableSoftLock: true, showActivityStrip: true },
  })
  assert.equal(savedSettings.settings.responseFormat.artifacts, false)
  assert.equal(savedSettings.settings.groupChat.defaultTokenLimit, 500_000)
  assert.equal(savedSettings.settings.groupChat.showActivityStrip, true)
  // Restore defaults
  await settingsApi.command({
    type: 'settings.save',
    responseFormat: { artifacts: true },
    groupChat: { defaultTokenLimit: 0, showActivityStrip: false },
  })

  // Bot SOUL.md & MEMORY.md read/save
  await settingsApi.command({
    type: 'bot.files.save',
    botId: 'bot_alpha',
    soul: '# Alpha Custom Soul\nAlways verify before shipping.',
    memoryMd: '# Alpha Memory\nPrefers concise tables.',
  })
  const readFiles = await settingsApi.command({ type: 'bot.files.read', botId: 'bot_alpha' })
  assert.ok(readFiles.soul.includes('Always verify before shipping.'))
  assert.ok(readFiles.memoryMd.includes('Prefers concise tables.'))

  // Artifact & Usage extraction in publicState + Logs read
  const artRoom = await settingsRooms.save('', {
    name: '产物汇总验证群',
    memberIds: ['bot_admin', 'bot_ops'],
  })
  await settingsRooms.appendAtomic(artRoom.id, {
    from: 'bot_admin',
    name: '管理员',
    text: '已生成可视化报告：\n<artifact type="html" title="巡检报告"><h1>OK</h1></artifact>',
    kind: 'message',
  })
  const pub = settingsApi.publicState()
  assert.ok(pub.settings && pub.settings.responseFormat.enabled === true)
  assert.ok(pub.usage && pub.usage.roomCount >= 1)
  assert.ok(pub.artifacts.some(a => a.title === '巡检报告' && a.type === 'html'))

  const logsRes = await settingsApi.command({ type: 'logs.read', roomId: artRoom.id, limit: 20 })
  assert.ok(Array.isArray(logsRes.entries))
  await settingsRooms.remove(artRoom.id)
}

// --- 13. Autonomous Group Stability Fixes (diagnosed from 本机管理组) ---
{
  // 13a. Chinese @mention without trailing space (`@服务器管理员汇总一下`) and with single space (`@ 服务器管理员`)
  const zhMembers = [
    { id: 'bot_admin', name: '管理员' },
    { id: 'bot_ops', name: '服务器管理员' },
  ]
  assert.deepEqual(parseMentions('@服务器管理员汇总一下', zhMembers), { all: false, botIds: ['bot_ops'] })
  assert.deepEqual(parseMentions('@ 服务器管理员 汇总一下', zhMembers), { all: false, botIds: ['bot_ops'] })
  assert.deepEqual(parseMentions('@管理员请确认', zhMembers), { all: false, botIds: ['bot_admin'] })
  assert.deepEqual(parseMentions('@管理员2 不应命中', zhMembers), { all: false, botIds: [] })
  assert.deepEqual(parseMentions('@所有人汇总一下', zhMembers), { all: true, botIds: ['bot_admin', 'bot_ops'] })
  assert.deepEqual(parseMentions('@ 所有人 汇总一下', zhMembers), { all: true, botIds: ['bot_admin', 'bot_ops'] })
  assert.deepEqual(parseMentions('ops@管理员.com 不应命中', zhMembers), { all: false, botIds: [] })

  // 13b. room-completion SKILL.md is scaffolded by syncBotFiles
  const skillPath = join(store.bot('bot_alpha').dir, '.dsh', 'skills', 'room-completion', 'SKILL.md')
  await syncBotFiles(store, store.bot('bot_alpha'), store.state)
  const skillContent = await readFile(skillPath, 'utf8')
  assert.ok(skillContent.includes('name: room-completion'))
  assert.ok(skillContent.includes('room_finish_task'))
  assert.ok(skillContent.includes('room_task_progress'))

  // 13c. Casual `@user` + teammate `@mention` keeps peers collaborating, followed by
  // automatic Lead `progress_review` calling `room_finish_task` -> `completed` with ZERO manual Continue!
  const rooms = new Rooms(store, dispatcher, logger)
  const room = await rooms.save('', {
    name: '全自动本机管理组验证',
    memberIds: ['bot_admin', 'bot_ops', 'bot_dev'],
    mode: 'auto',
    leadBotId: 'bot_admin',
  })
  // Default tokenLimit is now 0 (full-auto, no manual Continue interruptions!)
  assert.equal(room.budget.tokenLimit, 0)

  const adminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), room.id)
  const opsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), room.id)
  const devSid = await dispatcher.ensureRoomSession(store.bot('bot_dev'), room.id)

  let opsCrossChecked = false
  let adminGotAutoProgressReview = false

  agents.get(devSid).setReply((prompt) => {
    if (prompt.includes('开始全面巡检')) {
      // Casual @user alongside teammate @服务器管理员 MUST NOT freeze the room!
      return '@user @服务器管理员 我这侧安全巡检完成，请核对 D5 日志策略。'
    }
    return '(pass)'
  })

  agents.get(opsSid).setReply(async (prompt) => {
    if (prompt.includes('开始全面巡检')) {
      await rooms.updateTaskProgress(room.id, store.bot('bot_ops'), {
        action: 'update',
        goal: '本机巡检与并表',
        items: [{ id: 'audit-ops', title: '资源侧盘点', owner: '服务器管理员', done: true }],
      })
      return '资源侧盘点完成。'
    }
    if (prompt.includes('核对 D5 日志策略') && !opsCrossChecked) {
      opsCrossChecked = true
      return '已与安全侧核对 D5 策略完毕，无遗漏。'
    }
    return '(pass)'
  })

  agents.get(adminSid).setReply(async (prompt) => {
    if (prompt.includes('[Autonomous Progress Review · room-completion skill]')) {
      adminGotAutoProgressReview = true
      const status = await rooms.updateTaskProgress(room.id, store.bot('bot_admin'), { action: 'get' })
      assert.equal(status.ok, true)
      await rooms.finishTask(room.id, store.bot('bot_admin'), {
        summary: '三方巡检已交叉核对并汇总为统一清理清单，全自动验收收口完成。',
        deliverables: ['unified-cleanup-plan.md'],
      })
      return '已汇总全部报告并正式收口。'
    }
    if (prompt.includes('开始全面巡检')) {
      return '总控启动，等各侧产出。'
    }
    return '(pass)'
  })

  await rooms.send(room.id, '开始全面巡检并汇总清单')
  const autoCompleted = await waitUntil(() => store.room(room.id).status === 'completed', 5000)
  assert.equal(autoCompleted, true, `expected auto completed, got ${store.room(room.id).status} (${store.room(room.id).pausedReason})`)
  assert.equal(opsCrossChecked, true, 'Casual @user alongside teammate mention must NOT block peer cross-check')
  assert.equal(adminGotAutoProgressReview, true, 'Lead must automatically receive progress_review turn to call room_finish_task')
  await rooms.remove(room.id)

  // 13d. All-error round MUST mark `stalled` (`turn_error`), NEVER falsely mark `settled`!
  const errRoom = await rooms.save('', {
    name: '全报错防误判收敛群',
    memberIds: ['bot_admin', 'bot_ops'],
    mode: 'auto',
  })
  const errAdminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), errRoom.id)
  const errOpsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), errRoom.id)
  agents.get(errAdminSid).setReply(() => ({ turnError: 'provider rate limit 503' }))
  agents.get(errOpsSid).setReply(() => ({ turnError: 'provider rate limit 503' }))
  await rooms.send(errRoom.id, '测试报错状态')
  const stalledOnError = await waitUntil(() => store.room(errRoom.id).status === 'stalled', 3000)
  assert.equal(stalledOnError, true, `expected stalled on all-error round, got ${store.room(errRoom.id).status}`)
  assert.equal(store.room(errRoom.id).pausedReason, 'turn_error')
  await rooms.remove(errRoom.id)

  // 13e. Stale hidden room session model-switch compaction failure auto-rotates & recovers!
  const rotateRoom = await rooms.save('', {
    name: '会话切换自愈验证群',
    memberIds: ['bot_admin', 'bot_ops'],
    mode: 'lead',
    leadBotId: 'bot_admin',
  })
  const staleSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), rotateRoom.id)
  agents.get(staleSid).setReply(() => ({
    turnError: 'Cannot switch to custom_18022/doubao/glm-5.3-flash: context compaction failed: no adapter registered for provider "custom_18022".',
  }))
  // When Dispatcher rotates to a brand-new session, mock its reply to succeed cleanly!
  const origCreate = ctx.get('sessionController').create
  const recovered = await dispatcher.enqueue('bot_admin', '汇总一下', { source: 'room', roomId: rotateRoom.id })
  const newSid = store.room(rotateRoom.id).memberSessions.bot_admin
  assert.notEqual(newSid, staleSid, 'Dispatcher must rotate stale room session on model-switch compaction failure')
  assert.equal(recovered.ok, true)
  void origCreate
  await rooms.remove(rotateRoom.id)
}

// --- 14. Hermes Bot Mode Alignment: Solo-@ Epoch Fence, Opt-In Rounds, Table/Paren Strip, Nudge, Hold & Skills ---
{
  const rooms = new Rooms(store, dispatcher, logger)

  // 14a & 14b: Solo @Bot after previous epoch's messy @mentions MUST wake ONLY that Bot (0 tokens for others),
  // keep unaddressed Bots' watermarks intact, and let that Bot pull in a specialist if task doesn't fit!
  const hermesRoom = await rooms.save('', {
    name: 'Hermes精准点名验证群',
    memberIds: ['bot_admin', 'bot_ops', 'bot_dev'],
    mode: 'auto',
    leadBotId: 'bot_admin',
  })
  const adminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), hermesRoom.id)
  const opsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), hermesRoom.id)
  const devSid = await dispatcher.ensureRoomSession(store.bot('bot_dev'), hermesRoom.id)

  // Seed stale epoch=1 transcript with unread @mentions pointing at bot_ops & bot_dev (reproducing 服务器运维组 bug!)
  await store.mutate((state) => {
    const r = state.rooms.find(item => item.id === hermesRoom.id)
    r.epoch = 1
    r.nextSeq = 3
    r.watermarks = { bot_admin: 2, bot_ops: 1, bot_dev: 1 }
    r.transcript = [
      { seq: 1, id: 'm1', from: 'user', name: 'You', text: '旧问题', kind: 'message', mentions: [], epoch: 1, round: 0, at: new Date().toISOString() },
      { seq: 2, id: 'm2', from: 'bot_admin', name: '管理员', text: '@服务器管理员 @AdminDev 请看旧问题', kind: 'message', mentions: ['bot_ops', 'bot_dev'], epoch: 1, round: 0, at: new Date().toISOString() },
      { seq: 3, id: 'm3', from: 'bot_ops', name: '服务器管理员', text: '@AdminDev @管理员 我也看完了旧问题', kind: 'message', mentions: ['bot_dev', 'bot_admin'], epoch: 1, round: 1, at: new Date().toISOString() },
    ]
  })

  let adminCalls = 0
  let opsCalls = 0
  let devCalls = 0
  let opsSawEpoch2WhenLaterCited = false

  agents.get(adminSid).setReply((prompt) => {
    adminCalls += 1
    if (prompt.includes('你们都沟通了什么')) {
      return '我来直接总结：刚才大家对齐了旧问题，目前没有未决事项。'
    }
    if (prompt.includes('帮我查下防火墙暴露面')) {
      // Task-fit analysis: not my specialty -> hand off via @服务器管理员!
      return '防火墙暴露面属于安全与运维专项，我先做初步判断，具体规则请 @服务器管理员 协助分析。'
    }
    return '(pass)'
  })
  agents.get(opsSid).setReply((prompt) => {
    opsCalls += 1
    if (prompt.includes('刚才大家对齐了旧问题')) {
      opsSawEpoch2WhenLaterCited = true
    }
    return '收到协同请求，防火墙暴露面已核查完毕，无需额外改动。'
  })
  agents.get(devSid).setReply(() => {
    devCalls += 1
    return '不应该被唤醒'
  })

  // 14a: Solo @管理员 -> ONLY bot_admin wakes (opsCalls === 0, devCalls === 0)!
  await rooms.send(hermesRoom.id, '@管理员 你们都沟通了什么')
  const soloSettled = await waitUntil(() => store.room(hermesRoom.id).status === 'settled', 4000)
  assert.equal(soloSettled, true, `expected settled after solo @, got ${store.room(hermesRoom.id).status}`)
  assert.equal(adminCalls, 1, 'Solo @管理员 must wake bot_admin exactly once')
  assert.equal(opsCalls, 0, 'Solo @管理员 MUST NOT wake bot_ops despite stale epoch=1 @mentions!')
  assert.equal(devCalls, 0, 'Solo @管理员 MUST NOT wake bot_dev despite stale epoch=1 @mentions!')
  assert.equal(store.room(hermesRoom.id).watermarks.bot_ops, 1, 'Unaddressed Bot watermark must stay intact (Hermes invariant)')

  // 14b: Solo @管理员 on specialist task -> bot_admin hands off to @服务器管理员; bot_dev stays at 0 calls;
  // bot_ops receives intact delta including epoch=2 reply!
  await rooms.send(hermesRoom.id, '@管理员 帮我查下防火墙暴露面')
  const handoffSettled = await waitUntil(() => store.room(hermesRoom.id).status === 'settled', 4000)
  assert.equal(handoffSettled, true)
  assert.equal(adminCalls, 2)
  assert.equal(opsCalls, 1, 'Specialist @服务器管理员 must be pulled in once via opt-in handoff')
  assert.equal(devCalls, 0, 'Uninvolved bot_dev must STILL have 0 calls')
  assert.equal(opsSawEpoch2WhenLaterCited, true, 'Intact watermark must deliver epoch=2 message when later cited')
  await rooms.remove(hermesRoom.id)

  // 14c: Simple "介绍一下自己" with Markdown table & parenthetical role @mentions MUST settle in Round 0!
  const introRoom = await rooms.save('', {
    name: '自我介绍防死循环验证群',
    memberIds: ['bot_admin', 'bot_ops', 'bot_dev'],
    mode: 'auto',
    leadBotId: 'bot_admin',
  })
  const iAdminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), introRoom.id)
  const iOpsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), introRoom.id)
  const iDevSid = await dispatcher.ensureRoomSession(store.bot('bot_dev'), introRoom.id)
  let iAdmin = 0, iOps = 0, iDev = 0
  agents.get(iAdminSid).setReply(() => {
    iAdmin += 1
    return '我是管理员（→ @服务器管理员 负责运维）。\n| 环节 | 谁执行 |\n|---|---|\n| 运维 | @服务器管理员 / @AdminDev |'
  })
  agents.get(iOpsSid).setReply(() => {
    iOps += 1
    return '我是服务器管理员，不负责开发（-> @AdminDev）。\n| 谁执行 | @管理员 |'
  })
  agents.get(iDevSid).setReply(() => {
    iDev += 1
    return '我是研发助手（归 @管理员 统筹）。'
  })
  await rooms.send(introRoom.id, '介绍一下自己')
  const introSettled = await waitUntil(() => store.room(introRoom.id).status === 'settled', 4000)
  assert.equal(introSettled, true, `expected intro room to settle cleanly, got ${store.room(introRoom.id).status}`)
  assert.equal(iAdmin, 1, 'Intro must run exactly 1 turn for bot_admin (no ping-pong, no extra Lead progress_review)')
  assert.equal(iOps, 1, 'Intro must run exactly 1 turn for bot_ops')
  assert.equal(iDev, 1, 'Intro must run exactly 1 turn for bot_dev')
  await rooms.remove(introRoom.id)

  // 14d: Hermes Direct-Address Nudge: explicitly @mentioned Bot replying `(pass)` is nudged once!
  const nudgeRoom = await rooms.save('', {
    name: '直呼点名防静默验证群',
    memberIds: ['bot_admin', 'bot_ops'],
    mode: 'auto',
  })
  const nOpsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), nudgeRoom.id)
  let nudgeCount = 0
  agents.get(nOpsSid).setReply((prompt) => {
    nudgeCount += 1
    if (nudgeCount === 1) return '(pass)'
    assert.ok(prompt.includes('explicitly addressed YOU'), 'Direct-address nudge suffix must be sent on retry')
    return '抱歉刚才误回 pass，我已检查完毕一切正常。'
  })
  await rooms.send(nudgeRoom.id, '@服务器管理员 汇报当前状态')
  const nudgeSettled = await waitUntil(() => store.room(nudgeRoom.id).status === 'settled', 4000)
  assert.equal(nudgeSettled, true)
  assert.equal(nudgeCount, 2)
  assert.ok(store.room(nudgeRoom.id).transcript.some(m => m.text.includes('我已检查完毕一切正常')))
  await rooms.remove(nudgeRoom.id)

  // 14e: Hermes Member Hold (`@服务器管理员 暂停` mutes bot_ops until directly re-addressed)
  const holdRoom = await rooms.save('', {
    name: '成员局部静音验证群',
    memberIds: ['bot_admin', 'bot_ops'],
    mode: 'auto',
  })
  const hAdminSid = await dispatcher.ensureRoomSession(store.bot('bot_admin'), holdRoom.id)
  const hOpsSid = await dispatcher.ensureRoomSession(store.bot('bot_ops'), holdRoom.id)
  let hAdminCalls = 0, hOpsCalls = 0
  agents.get(hAdminSid).setReply(() => { hAdminCalls += 1; return '管理员正常回答。' })
  agents.get(hOpsSid).setReply(() => { hOpsCalls += 1; return '服务器管理员恢复回答。' })

  await rooms.send(holdRoom.id, '@服务器管理员 暂停')
  await waitUntil(() => store.room(holdRoom.id).status === 'settled', 3000)
  assert.equal(hOpsCalls, 0, 'Held Bot must stay silent on stop directive')

  await rooms.send(holdRoom.id, '大家看下这个普通问题')
  await waitUntil(() => store.room(holdRoom.id).status === 'settled', 3000)
  assert.equal(hAdminCalls, 1)
  assert.equal(hOpsCalls, 0, 'Held Bot must remain silent on unaddressed message')

  await rooms.send(holdRoom.id, '@服务器管理员 现在帮我看一下')
  await waitUntil(() => store.room(holdRoom.id).status === 'settled', 3000)
  assert.equal(hOpsCalls, 1, 'Direct non-stop @mention must release the hold')
  await rooms.remove(holdRoom.id)

  // 14f: `team-collaboration` SKILL.md is scaffolded by syncBotFiles with Task-Fit First guidance
  const collabSkillPath = join(store.bot('bot_alpha').dir, '.dsh', 'skills', 'team-collaboration', 'SKILL.md')
  await syncBotFiles(store, store.bot('bot_alpha'), store.state)
  const collabContent = await readFile(collabSkillPath, 'utf8')
  assert.ok(collabContent.includes('name: team-collaboration'))
  assert.ok(collabContent.includes('Task-Fit Self-Assessment'))
  assert.ok(collabContent.includes('Hermes Opt-In'))
}

// --- 15. Phase-1 Security, Concurrency, Token & Memory Hardening Regression Suite ---
{
  // 15a. Fail-Closed API auth (503 without connection) & Content-Type enforcement (415)
  {
    const noAuthCtx = { ...ctx, get: (name) => (name === 'connection' ? undefined : ctx.get(name)) }
    const noAuthApi = new BotApi({ ctx: noAuthCtx, store, dispatcher, rooms: new Rooms(store, dispatcher, logger), logger })
    const res503 = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(v) { this.body = v } }
    await noAuthApi.handle({ method: 'GET', url: '/botmode/api/state', headers: {} }, res503)
    assert.equal(res503.statusCode, 503)

    const okApi = new BotApi({ ctx, store, dispatcher, rooms: new Rooms(store, dispatcher, logger), logger })
    const res415 = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(v) { this.body = v } }
    await okApi.handle({
      method: 'POST',
      url: '/botmode/api/command',
      headers: { 'content-type': 'text/plain' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
    }, res415)
    assert.equal(res415.statusCode, 415)
  }

  // 15b. MemoryPluginInstaller blocks git/npm argument injection & symlink escape
  {
    const installer = new MemoryPluginInstaller(join(root, 'sec-plugins'), new Set(['builtin']), logger)
    await assert.rejects(() => installer.install('git+--upload-pack=echo'), /Invalid git repository URL/i)
    await assert.rejects(() => installer.install('npm:--version'), /Invalid npm package specifier/i)

    const outsideSecret = join(root, 'outside-secret.js')
    await writeFile(outsideSecret, 'export function createProvider() { return {} }\n', 'utf8')
    const evilDir = join(root, 'evil-plugin')
    await mkdir(evilDir, { recursive: true })
    await writeFile(join(evilDir, 'plugin.json'), JSON.stringify({
      schemaVersion: 1, id: 'evil_sym', displayName: 'Evil', entry: 'index.js',
    }), 'utf8')
    await symlink(outsideSecret, join(evilDir, 'index.js'))
    await assert.rejects(() => installer.install(evilDir), /escapes plugin directory/i)
  }

  // 15c. `isStrictSubpath` & `removeBotDir` block root/sibling/traversal deletion
  {
    const outsideDir = join(root, 'do-not-delete')
    await mkdir(outsideDir, { recursive: true })
    assert.equal(isStrictSubpath(store.botsRoot, store.botsRoot), false)
    assert.equal(isStrictSubpath(store.botsRoot, `${store.botsRoot}-sibling`), false)
    assert.equal(isStrictSubpath(store.botsRoot, join(store.botsRoot, '..', 'do-not-delete')), false)
    await store.removeBotDir({ dir: store.botsRoot })
    await store.removeBotDir({ dir: join(store.botsRoot, '..', 'do-not-delete') })
    assert.ok(await readFile(join(store.root, 'state.json'), 'utf8'))
  }

  // 15d. SQLite Fallback: LIKE wildcard escape, 2-char Chinese hybrid search, room no-auto-preference & purgeAgent
  {
    const dbStore = new LocalFourLayerStore(join(root, 'sec_fallback.sqlite'))
    await dbStore.addAtomic({ teamId: 't1', agentId: 'b1', userId: 'u1', type: 'fact', content: '数据库主节点位于上海机房' })
    await dbStore.addAtomic({ teamId: 't1', agentId: 'b1', userId: 'u1', type: 'fact', content: '开放端口为 8420' })
    const wildHits = await dbStore.searchAtomic({ teamId: 't1', agentId: 'b1', userId: 'u1', query: '___' })
    assert.equal(wildHits.length, 0, 'LIKE wildcard ___ must be escaped and return 0 false matches')
    const hybridHits = await dbStore.searchAtomic({ teamId: 't1', agentId: 'b1', userId: 'u1', query: '数据库 端口' })
    assert.equal(hybridHits.length, 2, 'Mixed 3-char + 2-char query must recall both items')
    await dbStore.addConversation({
      teamId: 't1', agentId: 'b1', userId: 'u1', sessionId: 's_room', source: 'room',
      messages: [{ role: 'user', content: '注意以后必须记住端口规范 9999' }],
    })
    const roomPolluted = await dbStore.searchAtomic({ teamId: 't1', agentId: 'b1', userId: 'u1', query: '9999' })
    assert.equal(roomPolluted.length, 0, 'Group room turns must NOT auto-extract personal preference memories')
    await dbStore.purgeAgent({ teamId: 't1', agentId: 'b1' })
    const afterPurge = await dbStore.stats({ teamId: 't1', agentId: 'b1' })
    assert.equal(afterPurge.atomic, 0)
    assert.equal(afterPurge.conversations, 0)
    dbStore.close()
  }

  // 15e. Token accounting counts incremental uncached tokens (no quadratic cache inflation)
  {
    const usageAgent = fakeAgent('s_usage_test', [])
    const origFollowup = usageAgent.followup.bind(usageAgent)
    usageAgent.followup = (msg) => {
      usageAgent._last = msg
      let seq = usageAgent.session.events.length
      usageAgent.session.events.push({ type: 'assistant/attempt', seq: seq++, data: { usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50000, totalTokens: 51200 }, message: { content: [] } } })
      usageAgent.session.events.push({ type: 'assistant/message', seq: seq++, data: { usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50000, totalTokens: 51200 }, message: { content: [{ type: 'text', text: 'step1' }] } } })
      usageAgent.session.events.push({ type: 'assistant/message', seq: seq++, data: { usage: { inputTokens: 500, outputTokens: 300, cacheReadTokens: 51200, totalTokens: 52000 }, message: { content: [{ type: 'text', text: 'final' }] } } })
      usageAgent.session.events.push({ type: 'turn/end', seq: seq++, data: { reason: { kind: 'completed' } } })
    }
    void origFollowup
    agents.set('s_usage_test', usageAgent)
    const savedSid = store.bot('bot_alpha').sessionId
    store.bot('bot_alpha').sessionId = 's_usage_test'
    const res = await dispatcher.enqueue('bot_alpha', 'run tool loop', { skipMemoryPrefetch: true, skipMemorySync: true })
    store.bot('bot_alpha').sessionId = savedSid
    assert.equal(res.ok, true)
    assert.equal(res.metrics.tokensUsed, 2000, `expected exact uncached 2000, got ${res.metrics.tokensUsed}`)
    assert.equal(res.metrics.cacheReadTokens, 101200)
  }

  // 15f. message_agent: Hub-and-Spoke expectReply enforces MAX_AGENT_HOPS + failure callback + routine chain reset
  {
    const hopAgentA = fakeAgent('s_hop_a', [])
    const hopAgentB = fakeAgent('s_hop_b', [])
    agents.set('s_hop_a', hopAgentA)
    agents.set('s_hop_b', hopAgentB)
    const oldA = store.bot('bot_admin').sessionId
    const oldB = store.bot('bot_ops').sessionId
    store.bot('bot_admin').sessionId = 's_hop_a'
    store.bot('bot_ops').sessionId = 's_hop_b'

    dispatcher.dispatch('bot_admin', 'kickoff', { source: 'api', skipMemoryPrefetch: true, skipMemorySync: true })
    await wait(20)
    for (let i = 1; i <= MAX_AGENT_HOPS; i += 1) {
      const r = await dispatcher.messageAgent('bot_admin', 'bot_ops', `hub msg ${i}`, true)
      assert.equal(r.ok, true, `hop ${i} should succeed`)
      assert.equal(r.hops, i)
    }
    const over = await dispatcher.messageAgent('bot_admin', 'bot_ops', 'hub msg 5', true)
    assert.equal(over.ok, false)
    assert.equal(over.code, 'max_hops_exceeded')

    // Routine resets DM chain so repeated hourly status reports are not blocked as duplicate_in_chain
    dispatcher.dispatch('bot_admin', 'hourly check', { source: 'routine', skipMemoryPrefetch: true, skipMemorySync: true })
    await wait(20)
    const r1 = await dispatcher.messageAgent('bot_admin', 'bot_ops', 'all green', false)
    assert.equal(r1.ok, true)
    dispatcher.dispatch('bot_admin', 'hourly check', { source: 'routine', skipMemoryPrefetch: true, skipMemorySync: true })
    await wait(20)
    const r2 = await dispatcher.messageAgent('bot_admin', 'bot_ops', 'all green', false)
    assert.equal(r2.ok, true)

    store.bot('bot_admin').sessionId = oldA
    store.bot('bot_ops').sessionId = oldB
  }

  // 15g. Group Room approvals forbid session/always; primary session grant scoped strictly to sessionId:toolName
  {
    const ap = new Approvals(store, logger)
    await store.mutate((s) => { for (const b of s.bots) b.approvalPolicy = 'ask' })
    const roomReq = ap.ask(store.bot('bot_alpha'), { toolName: 'bash', reason: 'test' }, { roomId: 'room_sec', sessionId: 's_room_1' })
    await assert.rejects(() => ap.decide(ap.list()[0].id, 'session'), /only allow "once" or "deny"/i)
    await assert.rejects(() => ap.decide(ap.list()[0].id, 'always'), /only allow "once" or "deny"/i)
    await ap.decide(ap.list()[0].id, 'once')
    assert.equal(await roomReq, 'allowed-once')

    const p1 = ap.ask(store.bot('bot_alpha'), { toolName: 'web_fetch', reason: 'fetch' }, { sessionId: 's_pri_1' })
    await ap.decide(ap.list()[0].id, 'session')
    assert.equal(await p1, 'allowed-once')
    // Different tool (`bash`) in the same session MUST still require approval!
    const p2 = ap.ask(store.bot('bot_alpha'), { toolName: 'bash', reason: 'rm' }, { sessionId: 's_pri_1' })
    assert.equal(ap.list().length, 1, 'session grant for web_fetch must NOT auto-approve bash')
    await ap.decide(ap.list()[0].id, 'deny')
    assert.equal(await p2, 'rejected')
  }

  // 15h. Typo @mention does NOT wake whole room + multi/full-width space @mention matches + Cron Sunday 7
  {
    const members = [{ id: 'b1', name: '主机运维官' }, { id: 'b2', name: '暴露面与安全官' }]
    assert.deepEqual(parseMentions('@  主机运维官 汇报', members), { all: false, botIds: ['b1'] })
    assert.deepEqual(parseMentions('@　主机运维官 汇报', members), { all: false, botIds: ['b1'] })
    assert.deepEqual(findUnresolvedMentions('@运维管汇总一下', members), ['运维管汇总一下'])
    assert.ok(parseCron('0 9 * * 7'), 'POSIX Sunday 7 must be supported')
    assert.ok(parseCron('0 9 * * 7').weekdays.has(0))
  }

  // 15i. Soft-lock covers bash redirection & Unified Diff; rooms.validate rejects unsafe workDir
  {
    const tmpDir = join(root, 'proj')
    const lockedRoom = {
      workDir: tmpDir,
      subtasks: [{ taskId: 't1', ownerBotId: 'b1', ownerName: 'Alpha', paths: [join(tmpDir, 'src/app.js')], status: 'in_progress' }],
    }
    assert.ok(checkRoomWriteSoftLock({ room: lockedRoom, callerBotId: 'b2', toolName: 'bash', args: { command: 'echo x > src/app.js' }, baseDir: tmpDir }))
    assert.ok(checkRoomWriteSoftLock({ room: lockedRoom, callerBotId: 'b2', toolName: 'apply_patch', args: { patch: '--- a/src/app.js\n+++ b/src/app.js\n' }, baseDir: tmpDir }))
    const vRooms = new Rooms(store, dispatcher, logger)
    assert.notEqual(vRooms.validate({ memberIds: ['bot_admin', 'bot_ops'], workDir: '/' }), '')
    assert.notEqual(vRooms.validate({ memberIds: ['bot_admin', 'bot_ops'], workDir: store.root }), '')
  }

  // 15j. Cold-start recovery clears dead waiting_user(approval) & stale in_progress subtask locks
  {
    const coldRoot = await mkdtemp(join(tmpdir(), 'dsh-botmode-cold-'))
    const s1 = new BotStore(coldRoot)
    await s1.load()
    await s1.mutate((st) => {
      st.rooms.push({
        id: 'room_cold',
        name: 'Cold',
        memberIds: ['b1', 'b2'],
        status: 'waiting_user',
        pausedReason: 'approval',
        needsYou: true,
        subtasks: [{ taskId: 'lock1', ownerBotId: 'b1', ownerName: 'B1', paths: ['/tmp/a'], status: 'in_progress' }],
      })
    })
    const s2 = new BotStore(coldRoot)
    await s2.load()
    const recovered = s2.room('room_cold')
    assert.equal(recovered.status, 'stalled')
    assert.equal(recovered.pausedReason, 'host_restarted')
    assert.equal(recovered.subtasks[0].status, 'released')
    await rm(coldRoot, { recursive: true, force: true })
  }

  // 15k. All Bots live flat under General (常规); legacy custom sections collapse cleanly
  {
    const flatRoot = await mkdtemp(join(tmpdir(), 'dsh-botmode-flat-'))
    await writeFile(join(flatRoot, 'state.json'), JSON.stringify({
      version: 5,
      sections: [
        { id: 'general', name: 'General', nameZh: '常规', order: 0 },
        { id: 'sec_ops', name: 'Ops', nameZh: '运维', order: 1 },
      ],
      bots: [{ id: 'bot_legacy', name: 'LegacyOps', sectionId: 'sec_ops' }],
      rooms: [],
      routines: [],
    }), 'utf8')
    const sFlat = new BotStore(flatRoot)
    await sFlat.load()
    assert.equal(sFlat.state.sections.length, 1)
    assert.equal(sFlat.state.sections[0].id, 'general')
    assert.equal(sFlat.state.sections[0].nameZh, '常规')
    assert.equal(sFlat.bot('bot_legacy').sectionId, 'general')
    await rm(flatRoot, { recursive: true, force: true })
  }
}

await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
console.log('all host, group-room and memory-hub tests passed')
