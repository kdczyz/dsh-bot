/**
 * Headless checks for the Host half. Run with:
 *   node packages/dsh-botmode/test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotStore } from '../host/store.js'
import { nextCronTime, parseCron } from '../host/cron.js'
import { Dispatcher } from '../host/dispatch.js'
import { Rooms } from '../host/rooms.js'
import { BotApi } from '../host/api.js'
import { syncBotFiles, personaBlock } from '../host/persona.js'
import { Approvals } from '../host/approvals.js'
import { botModelCatalog, modelAcceptsImages, resolveBotSelection } from '../host/models.js'

const root = await mkdtemp(join(tmpdir(), 'botmode-test-'))
const logger = { info() {}, warn() {}, error() {} }

const store = new BotStore(root)
await store.load()

// --- cron ------------------------------------------------------------------
assert.equal(parseCron('0 9 * * 1-5').hours.has(9), true)
assert.equal(parseCron('bad'), undefined)
{
  const from = new Date(2026, 10, 23, 8, 0, 0) // Monday 08:00 local
  const next = nextCronTime('0 9 * * 1-5', from)
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 0)
  assert.equal(next.getDay(), 1)
}

// --- store + persona -------------------------------------------------------
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

// --- fake agent/controller -------------------------------------------------
function fakeAgent(id, log = []) {
  const events = []
  let reply = ''
  let busy = false
  const session = {
    id,
    ownEvents: () => events.slice(),
    events,
    header: { id },
  }
  const agent = {
    session,
    model: { selected: [], select(selection) { this.selected.push(selection) } },
    ctx: { effect(fn) { return fn() }, get() { return undefined } },
    followup(message) {
      busy = true
      log.push(`start:${message.content[0].text}`)
      setTimeout(() => {
        const seq = events.length
        events.push({ type: 'user/message', seq, time: Date.now(), data: message })
        events.push({
          type: 'assistant/message', seq: seq + 1, time: Date.now(),
          data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: reply }] }, stream: [] },
        })
        busy = false
      }, 5)
      this._last = message
    },
    whenIdle() {
      return new Promise((resolve) => {
        const check = () => {
          if (busy) { setTimeout(check, 2); return }
          log.push(`end:${this._last.content[0].text}`)
          resolve()
        }
        check()
      })
    },
    cancel() {},
    setReply(value) { reply = value },
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
          agents.set(id, fakeAgent(id))
          return { sessionId: id }
        },
        async resolveAgent(id) {
          const agent = agents.get(id)
          return agent ? { agent } : { error: new Error('not found') }
        },
      }
    }
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
// log is attached below before the FIFO check
const result = await dispatcher.enqueue('bot_alpha', 'hello')
assert.equal(result.ok, true)
assert.equal(result.text, 'alpha reply')
assert.deepEqual(agents.get('s_alpha').model.selected.at(-1), { provider: 'prov', model: 'default-model' })

// FIFO: two turns do not interleave.
agents.get('s_alpha').setReply('second')
order.length = 0
const first = dispatcher.enqueue('bot_alpha', 'one')
const second = dispatcher.enqueue('bot_alpha', 'two')
await Promise.all([first, second])
assert.deepEqual(order, ['start:one', 'end:one', 'start:two', 'end:two'])

// --- per-Bot model: DSH default, pinned model, image capability ------------
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

// --- model catalog ---------------------------------------------------------
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
  assert.equal(catalog.default.model, 'a1')
  assert.equal(catalog.groups[0].models[0].vision, false)
  assert.equal(catalog.groups[0].models[1].vision, true)
  assert.deepEqual(catalog.groups[0].models[0].reasoning.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(catalog.failures[0].id, 'broken')
  assert.deepEqual(resolveBotSelection(modelCtx, { model: { provider: '', model: '', reasoningEffort: '' } }), { provider: 'alpha', model: 'a1' })
  assert.deepEqual(resolveBotSelection(modelCtx, { model: { provider: 'custom', model: 'c1', reasoningEffort: 'high' } }), { provider: 'custom', model: 'c1', reasoningEffort: 'high' })
  assert.equal(await modelAcceptsImages(modelCtx, { provider: 'alpha', model: 'a2' }), true)
  assert.equal(await modelAcceptsImages(modelCtx, { provider: 'alpha', model: 'a1' }), false)
}

// --- rooms -----------------------------------------------------------------
let beta
await store.mutate((state) => {
  beta = {
    id: 'bot_beta', name: 'Beta', role: 'Writing', instructions: '',
    color: '#222222', sectionId: 'general', hidden: false, pinned: false, order: 1,
    dir: '', sessionId: 's_beta', model: { provider: '', model: '', reasoningEffort: '' },
    tools: { allow: [], deny: [] }, skills: [], createdAt: new Date().toISOString(),
  }
  state.bots.push(beta)
})
agents.set('s_beta', fakeAgent('s_beta'))
let counter = 0
const roomDispatcher = {
  async enqueue(botId, prompt) {
    counter += 1
    return { ok: true, text: `reply ${counter} from ${botId}` }
  },
  inRoom: () => true,
}
const rooms = new Rooms(store, roomDispatcher, logger)
const room = await rooms.save('', { name: 'Desk', memberIds: ['bot_alpha', 'bot_beta'], mode: 'auto' })
await rooms.send(room.id, 'what should we do?')
await new Promise(resolve => setTimeout(resolve, 60))
const settled = store.room(room.id)
assert.equal(settled.transcript[0].from, 'user')
assert.ok(settled.transcript.length >= 2)
assert.equal(settled.status, 'idle')
await rooms.remove(room.id)

// --- approvals -------------------------------------------------------------
{
  const approvals = new Approvals(store, logger)
  const alphaBot = store.bot('bot_alpha')
  const pending = approvals.ask(alphaBot, { toolName: 'bash', reason: 'rm -rf build' })
  assert.equal(approvals.list().length, 1)
  assert.equal(approvals.list()[0].toolName, 'bash')
  await approvals.decide(approvals.list()[0].id, 'always')
  assert.equal(await pending, 'allowed-once')
  assert.equal(store.bot('bot_alpha').approvalPolicy, 'always')
  assert.equal(approvals.ask(store.bot('bot_alpha'), { toolName: 'bash' }), 'allowed-once')
  const denied = new Approvals(store, logger)
  store.bot('bot_beta').approvalPolicy = 'never'
  assert.equal(denied.ask(store.bot('bot_beta'), { toolName: 'bash' }), 'rejected')
}

// --- api -------------------------------------------------------------------
const api = new BotApi({ ctx, store, dispatcher, rooms, approvals: new Approvals(store, logger), routines: { save: async () => ({}), remove: async () => {}, setEnabled: async () => ({}), runNow: async () => ({}) }, logger })
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
  assert.ok(payload.state.bots.some(bot => bot.name === 'Alpha'))
  assert.ok(Array.isArray(payload.state.tools))
}
{
  const res = fakeResponse()
  await api.handle(fakeRequest('GET', '/botmode/api/models'), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.ok(payload.catalog.groups.some(group => group.id === 'prov'))
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
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.attachment.mediaType, 'image/png')
  assert.equal(payload.attachment.name, 'shot.png')
}
{
  const res = fakeResponse()
  await api.handle(fakeRequest('POST', '/botmode/api/command', { type: 'bot.dispatch', botId: 'bot_alpha', text: 'ping' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).ok, true)
}
await rm(root, { recursive: true, force: true })
console.log('host tests passed')