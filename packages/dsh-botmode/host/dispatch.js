/**
 * Serial delivery of turns into Bot sessions.
 *
 * Every path that makes a Bot speak — a user message from the Bot page, a
 * teammate's `message_agent`, a Group Room turn, a Routine — goes through this
 * one per-Bot FIFO queue. Two turns never write the same Session or the same
 * memory file concurrently, and a Busy Bot queues instead of forking a second
 * Session.
 */
import { randomUUID } from 'node:crypto'
import { writeTextFile } from './store.js'
import { modelAcceptsImages, resolveBotSelection } from './models.js'

const TURN_TIMEOUT_MS = 15 * 60 * 1000
const MAX_REPLY_CHARS = 16_000

const textOfBlocks = (blocks) => {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

export const makeUserMessage = (text, content) => ({
  id: randomUUID(),
  role: 'user',
  content: content ?? [{ type: 'text', text }],
  source: { kind: 'user' },
})

export class Dispatcher {
  #chains = new Map()
  #queue = new Map()
  #roomBots = new Set()
  #running = new Set()
  #last = new Map()

  constructor(ctx, store, logger, onAgent) {
    this.ctx = ctx
    this.store = store
    this.logger = logger
    this.onAgent = onAgent
  }

  isBusy(botId) {
    return this.#running.has(botId) || (this.#queue.get(botId) ?? 0) > 0
  }

  queueDepth(botId) { return this.#queue.get(botId) ?? 0 }

  inRoom(botId) { return this.#roomBots.has(botId) }

  status() {
    const busy = {}
    for (const bot of this.store.state.bots) {
      if (this.isBusy(bot.id)) busy[bot.id] = { running: this.#running.has(bot.id), queued: this.queueDepth(bot.id) }
    }
    return { busy, last: Object.fromEntries(this.#last) }
  }

  lastResult(botId) { return this.#last.get(botId) }

  /** Queue one turn and return its settled result. */
  enqueue(botId, text, options = {}) {
    const previous = this.#chains.get(botId) ?? Promise.resolve()
    this.#queue.set(botId, (this.#queue.get(botId) ?? 0) + 1)
    const run = previous.then(async () => {
      this.#queue.set(botId, Math.max(0, (this.#queue.get(botId) ?? 1) - 1))
      return this.#runTurn(botId, text, options)
    }).catch((error) => {
      const result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      this.#last.set(botId, result)
      return result
    }).finally(() => {
      if ((this.#queue.get(botId) ?? 0) === 0) this.#queue.delete(botId)
    })
    this.#chains.set(botId, run.then(() => undefined, () => undefined))
    return run
  }

  /** Fire-and-forget delivery used by the HTTP API and teammate tools. */
  dispatch(botId, text, options = {}) {
    const bot = this.store.bot(botId)
    if (!bot) return { ok: false, error: 'unknown bot' }
    const queued = this.queueDepth(botId)
    void this.enqueue(botId, text, options)
    return { ok: true, accepted: true, queued }
  }

  /** Create or resume the Bot's canonical Session and return its id. */
  async ensureSession(bot) {
    const agent = await this.#resolveAgent(bot)
    return agent.session.id
  }

  async #resolveAgent(bot) {
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new Error('sessionController is not available')
    if (typeof bot.sessionId === 'string' && bot.sessionId !== '') {
      const resolved = await controller.resolveAgent(bot.sessionId)
      if (resolved && resolved.agent) {
        this.#announce(resolved.agent, bot)
        return resolved.agent
      }
    }
    await this.store.ensureBotDir(bot)
    const created = await controller.create({ cwd: bot.dir })
    if (!created || typeof created.sessionId !== 'string') throw new Error('Session creation failed')
    await this.store.mutate((state) => {
      const stored = state.bots.find(item => item.id === bot.id)
      if (stored) {
        stored.sessionId = created.sessionId
        stored.updatedAt = new Date().toISOString()
      }
    })
    bot.sessionId = created.sessionId
    const resolved = await controller.resolveAgent(created.sessionId)
    if (resolved && resolved.agent) {
      this.#announce(resolved.agent, bot)
      return resolved.agent
    }
    throw new Error(resolved && resolved.error ? resolved.error.message : 'Session could not be resumed')
  }

  #announce(agent, bot) {
    try {
      this.onAgent?.(agent, bot)
    } catch (error) {
      this.logger?.warn?.(`botmode: could not configure ${bot?.name ?? 'a Bot'}: ${String(error)}`)
    }
  }

  async #runTurn(botId, text, options) {
    const bot = this.store.bot(botId)
    if (!bot) return { ok: false, error: 'unknown bot' }
    const prompt = String(text ?? '').trim()
    const images = Array.isArray(options.images) ? options.images : []
    if (prompt === '' && images.length === 0) return { ok: false, error: 'empty message' }
    this.#running.add(botId)
    if (options.roomId) this.#roomBots.add(botId)
    const startedAt = new Date().toISOString()
    try {
      const agent = await this.#resolveAgent(bot)
      const selection = this.#applyModel(bot, agent)
      const content = await this.#promptContent(prompt, images, selection)
      const session = agent.session
      const beforeSeq = (session.ownEvents().at(-1)?.seq ?? -1) + 1
      const message = makeUserMessage(prompt, content)
      agent.followup(message)
      await this.#waitIdle(agent)
      try { await this.ctx.sessions.flush(session) } catch (_error) { /* durability is best effort here */ }
      const reply = this.#replySince(session, beforeSeq)
      const failure = this.#failureSince(session, beforeSeq)
      if (failure !== '') {
        const result = { ok: false, error: failure, startedAt, source: options.source ?? 'chat' }
        await this.store.mutate((state) => {
          const stored = state.bots.find(item => item.id === botId)
          if (stored) {
            stored.lastTurnAt = new Date().toISOString()
            stored.lastError = failure
          }
        }).catch(() => undefined)
        this.#last.set(botId, result)
        return result
      }
      const result = {
        ok: true,
        text: reply,
        messageId: message.id,
        sessionId: session.id,
        startedAt,
        source: options.source ?? 'chat',
      }
      await this.store.mutate((state) => {
        const stored = state.bots.find(item => item.id === bot.id)
        if (!stored) return
        stored.lastTurnAt = new Date().toISOString()
        stored.lastReply = reply.slice(0, 4_000)
        stored.lastError = ''
      })
      this.#last.set(botId, result)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.mutate((state) => {
        const stored = state.bots.find(item => item.id === bot.id)
        if (stored) stored.lastError = message
      }).catch(() => undefined)
      const result = { ok: false, error: message, startedAt, source: options.source ?? 'chat' }
      this.#last.set(botId, result)
      return result
    } finally {
      this.#running.delete(botId)
      if (options.roomId) this.#roomBots.delete(botId)
    }
  }

  /**
   * Bind the Bot's own model, or the DSH default when it has none. Returning the
   * selection lets the same turn use it for the image-input capability check.
   */
  #applyModel(bot, agent) {
    const selection = resolveBotSelection(this.ctx, bot)
    if (!selection) return undefined
    try {
      const current = agent.model?.current?.()
      const same = current
        && current.provider === selection.provider
        && current.model === selection.model
        && (current.reasoningEffort ?? '') === (selection.reasoningEffort ?? '')
      if (!same) agent.model?.select(selection)
      return selection
    } catch (error) {
      this.logger?.warn?.(`botmode: model selection for ${bot.name} failed: ${String(error)}`)
      return selection
    }
  }

  /**
   * Turn a text prompt plus already-uploaded image references into admitted
   * message content. A route that declares text-only input is refused here,
   * before anything enters the Session log.
   */
  async #promptContent(prompt, images, selection) {
    if (images.length === 0) return undefined
    const accepts = await modelAcceptsImages(this.ctx, selection)
    if (accepts === false) {
      const label = selection ? `${selection.provider}/${selection.model}` : 'this model'
      throw new Error(`Model "${label}" does not accept image input. Give this Bot a vision model first.`)
    }
    const attachments = this.ctx.get('attachments')
    if (!attachments || typeof attachments.admitPromptContent !== 'function') {
      throw new Error('Image input is unavailable in this Host.')
    }
    const parts = []
    if (prompt !== '') parts.push({ type: 'text', text: prompt })
    for (const image of images) {
      parts.push({ type: 'image', attachment: image, encodedBytes: Number(image.bytes) || 0 })
    }
    return attachments.admitPromptContent(parts)
  }

  async #waitIdle(agent) {
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('turn timed out after 15 minutes')), TURN_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      await Promise.race([agent.whenIdle(), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The first failed turn end since `beforeSeq`, flattened to a message. */
  #failureSince(session, beforeSeq) {
    for (const event of session.ownEvents()) {
      if (event.seq < beforeSeq || event.type !== 'turn/end') continue
      const reason = event.data?.reason
      if (reason?.kind !== 'error') continue
      const error = reason.error
      return typeof error?.message === 'string' && error.message !== '' ? error.message : 'the model call failed'
    }
    return ''
  }

  #replySince(session, beforeSeq) {
    const events = session.ownEvents()
    let text = ''
    for (const event of events) {
      if (event.seq < beforeSeq) continue
      if (event.type !== 'assistant/message') continue
      const value = textOfBlocks(event.data?.message?.content)
      if (value !== '') text = value
    }
    return text
  }

  cancel(botId) {
    const controller = this.ctx.get('sessionController')
    const bot = this.store.bot(botId)
    if (!controller || !bot || !bot.sessionId) return { ok: false, error: 'no live session' }
    const agent = this.ctx.get('agents')?.get?.(bot.sessionId)
    if (!agent) return { ok: false, error: 'not running' }
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  /** Deliver one teammate message; returns a receipt immediately. */
  async messageAgent(senderBotId, targetToken, message, expectReply) {
    const state = this.store.state
    const sender = state.bots.find(bot => bot.id === senderBotId)
    if (!sender) return { ok: false, error: 'this Session is not a Bot' }
    if (this.inRoom(sender.id)) return { ok: false, error: 'message_agent is unavailable inside a Group Room' }
    const token = oneLine(targetToken)
    const target = state.bots.find(bot => bot.id === token)
      ?? state.bots.find(bot => bot.name.toLowerCase() === token.toLowerCase())
      ?? state.bots.find(bot => bot.name.toLowerCase().startsWith(token.toLowerCase()))
    if (!target) return { ok: false, error: `no Bot named "${token}"` }
    if (target.id === sender.id) return { ok: false, error: 'cannot message yourself' }
    const body = [
      `[Message from ${sender.name}${sender.role ? ` (${sender.role})` : ''}]`,
      String(message ?? '').trim(),
      '',
      expectReply
        ? `Reply to ${sender.name} with message_agent when you have an answer; do not answer in your own chat only.`
        : 'No answer is required unless you have something the sender must know.',
    ].join('\n')
    const queued = this.queueDepth(target.id)
    const pending = this.enqueue(target.id, body, { source: 'agent' })
    if (expectReply) {
      void pending.then(async (result) => {
        if (!result.ok) return
        let reply = result.text
        let path = ''
        if (reply.length > MAX_REPLY_CHARS) {
          path = `${sender.dir || this.store.botsRoot}/message-reply-${Date.now()}.md`
          await writeTextFile(path, reply).catch(() => { path = '' })
          reply = `${reply.slice(0, MAX_REPLY_CHARS)}\n\n[truncated; full reply at ${path}]`
        }
        await this.enqueue(sender.id, [
          `[Reply from ${target.name}]`,
          reply,
        ].join('\n\n'), { source: 'agent' })
      })
    }
    return { ok: true, delivered: true, queued, target: { id: target.id, name: target.name } }
  }
}