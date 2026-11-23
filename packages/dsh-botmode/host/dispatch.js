/**
 * Serial delivery of turns into Bot sessions (primary & hidden Group Room sessions).
 *
 * Improvements over v0.4:
 * - Per-Session FIFO queues (`bot:<id>` for primary chat, `room:<roomId>:<botId>`
 *   for isolated hidden Group Room sessions) so group chats never pollute a
 *   Bot's private chat or block unrelated rooms.
 * - Accurate `inRoom(botId)` reflecting active room membership rather than only
 *   the momentary execution window of one speaker.
 * - Hermes-style MemoryManager lifecycle integration (`prefetch` before turns,
 *   async `syncTurn` after substantive turns).
 * - `message_agent` loop guard (`MAX_AGENT_HOPS`, per-chain dedup hash,
 *   ambiguous-target refusal, and session-based Group Room enforcement).
 */
import { createHash, randomUUID } from 'node:crypto'
import { newId, writeTextFile } from './store.js'
import { modelAcceptsImages, resolveBotSelection } from './models.js'
import { isPassReply } from './room-protocol.js'

const TURN_TIMEOUT_MS = 15 * 60 * 1000
const MAX_REPLY_CHARS = 16_000
export const MAX_AGENT_HOPS = 4

const textOfBlocks = (blocks) => {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const messageFingerprint = (senderId, targetId, message) => {
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return createHash('sha256').update(`${senderId}->${targetId}:${normalized}`).digest('hex').slice(0, 16)
}

export const makeUserMessage = (text, content) => ({
  id: randomUUID(),
  role: 'user',
  content: content ?? [{ type: 'text', text }],
  source: { kind: 'user' },
})

export class Dispatcher {
  #chains = new Map() // queueKey -> Promise
  #queue = new Map() // queueKey -> queued count
  #runningKeys = new Set() // active queueKeys
  #speakingRoomBots = new Set() // botIds currently executing a room turn
  #activeRooms = new Map() // roomId -> Set<botId>
  #last = new Map() // botId -> last result
  #dmChains = new Map() // botId -> { chainId, hops, lastSenderId, seen: Set<string> }

  constructor(ctx, store, logger, onAgent, memory = null) {
    this.ctx = ctx
    this.store = store
    this.logger = logger
    this.onAgent = onAgent
    this.memory = memory
  }

  setMemoryManager(memory) {
    this.memory = memory
  }

  /** Called by Rooms when a room starts or stops driving a discussion. */
  setActiveRoomMembers(roomId, memberIds) {
    if (!roomId) return
    this.#activeRooms.set(roomId, new Set(Array.isArray(memberIds) ? memberIds : []))
  }

  clearActiveRoom(roomId) {
    this.#activeRooms.delete(roomId)
  }

  #queueKey(botId, options = {}) {
    return options.roomId ? `room:${options.roomId}:${botId}` : `bot:${botId}`
  }

  isRunning(botId) {
    if (this.#runningKeys.has(`bot:${botId}`)) return true
    for (const key of this.#runningKeys) {
      if (key.endsWith(`:${botId}`)) return true
    }
    return false
  }

  queueDepth(botId) {
    let total = 0
    for (const [key, depth] of this.#queue.entries()) {
      if (key === `bot:${botId}` || key.endsWith(`:${botId}`)) total += depth
    }
    return total
  }

  isBusy(botId) {
    return this.isRunning(botId) || this.queueDepth(botId) > 0
  }

  /** True when this Bot belongs to any currently running Group Room or is speaking in one. */
  inRoom(botId) {
    if (this.#speakingRoomBots.has(botId)) return true
    for (const members of this.#activeRooms.values()) {
      if (members.has(botId)) return true
    }
    return false
  }

  roomSpeaking(botId) {
    return this.#speakingRoomBots.has(botId)
  }

  activeRoomId(botId) {
    for (const [roomId, members] of this.#activeRooms.entries()) {
      if (members.has(botId)) return roomId
    }
    return ''
  }

  status() {
    const busy = {}
    for (const bot of this.store.state.bots) {
      if (this.isBusy(bot.id)) {
        busy[bot.id] = {
          running: this.isRunning(bot.id),
          queued: this.queueDepth(bot.id),
        }
      }
    }
    return { busy, last: Object.fromEntries(this.#last) }
  }

  lastResult(botId) { return this.#last.get(botId) }

  /** Queue one turn on the target Session's FIFO and return its settled result. */
  enqueue(botId, text, options = {}) {
    const key = this.#queueKey(botId, options)
    const previous = this.#chains.get(key) ?? Promise.resolve()
    this.#queue.set(key, (this.#queue.get(key) ?? 0) + 1)
    const run = previous.then(async () => {
      this.#queue.set(key, Math.max(0, (this.#queue.get(key) ?? 1) - 1))
      return this.#runTurn(botId, text, options, key)
    }).catch((error) => {
      const result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      this.#last.set(botId, result)
      return result
    }).finally(() => {
      if ((this.#queue.get(key) ?? 0) === 0) this.#queue.delete(key)
    })
    this.#chains.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  /** Fire-and-forget delivery used by the HTTP API and teammate tools. */
  dispatch(botId, text, options = {}) {
    const bot = this.store.bot(botId)
    if (!bot) return { ok: false, error: 'unknown bot' }
    // A fresh human message resets the DM loop-guard chain for this Bot.
    if (options.source === 'api' || options.source === 'command' || options.source === 'chat' || options.source === 'service') {
      this.#dmChains.set(botId, { chainId: newId('chain'), hops: 0, lastSenderId: '', seen: new Set() })
    }
    const queued = this.queueDepth(botId)
    void this.enqueue(botId, text, options)
    return { ok: true, accepted: true, queued }
  }

  /** Create or resume the Bot's canonical primary Session and return its id. */
  async ensureSession(bot) {
    const agent = await this.#resolveAgent(bot, {})
    return agent.session.id
  }

  /** Create or resume the Bot's isolated hidden Group Room Session and return its id. */
  async ensureRoomSession(bot, roomId) {
    const agent = await this.#resolveAgent(bot, { roomId })
    return agent.session.id
  }

  async #resolveAgent(bot, options = {}) {
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new Error('sessionController is not available')

    const roomId = typeof options.roomId === 'string' ? options.roomId : ''
    if (roomId !== '') {
      const room = this.store.room(roomId)
      const existingRoomSessionId = room?.memberSessions?.[bot.id] ?? ''
      if (existingRoomSessionId !== '') {
        const resolved = await controller.resolveAgent(existingRoomSessionId)
        if (resolved && resolved.agent) {
          this.#announce(resolved.agent, bot, { kind: 'room', roomId })
          return resolved.agent
        }
      }
      await this.store.ensureBotDir(bot)
      const created = await controller.create({ cwd: bot.dir, title: `Group: ${room?.name || roomId}` })
      if (!created || typeof created.sessionId !== 'string') throw new Error('Room session creation failed')
      await this.store.mutate((state) => {
        const storedRoom = state.rooms.find(item => item.id === roomId)
        if (storedRoom) {
          storedRoom.memberSessions = storedRoom.memberSessions ?? {}
          storedRoom.memberSessions[bot.id] = created.sessionId
          storedRoom.updatedAt = new Date().toISOString()
        }
      })
      const resolved = await controller.resolveAgent(created.sessionId)
      if (resolved && resolved.agent) {
        this.#announce(resolved.agent, bot, { kind: 'room', roomId })
        return resolved.agent
      }
      throw new Error(resolved && resolved.error ? resolved.error.message : 'Room session could not be resumed')
    }

    if (typeof bot.sessionId === 'string' && bot.sessionId !== '') {
      const resolved = await controller.resolveAgent(bot.sessionId)
      if (resolved && resolved.agent) {
        this.#announce(resolved.agent, bot, { kind: 'primary', roomId: '' })
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
      this.#announce(resolved.agent, bot, { kind: 'primary', roomId: '' })
      return resolved.agent
    }
    throw new Error(resolved && resolved.error ? resolved.error.message : 'Session could not be resumed')
  }

  #announce(agent, bot, meta) {
    try {
      this.onAgent?.(agent, bot, meta)
    } catch (error) {
      this.logger?.warn?.(`botmode: could not configure ${bot?.name ?? 'a Bot'}: ${String(error)}`)
    }
  }

  async #runTurn(botId, text, options, queueKey) {
    const bot = this.store.bot(botId)
    if (!bot) return { ok: false, error: 'unknown bot' }
    const rawPrompt = String(text ?? '').trim()
    const images = Array.isArray(options.images) ? options.images : []
    if (rawPrompt === '' && images.length === 0) return { ok: false, error: 'empty message' }

    this.#runningKeys.add(queueKey)
    if (options.roomId) this.#speakingRoomBots.add(botId)
    const startedAt = new Date().toISOString()
    try {
      const agent = await this.#resolveAgent(bot, options)
      const selection = this.#applyModel(bot, agent)
      const session = agent.session
      options.onSessionResolved?.(session.id)

      // Hermes-style memory prefetch (skipped for trivial prompts or if explicitly disabled).
      let finalPrompt = rawPrompt
      if (this.memory && options.skipMemoryPrefetch !== true) {
        const recallQuery = String(options.memoryQuery ?? rawPrompt).trim()
        if (recallQuery !== '') {
          const recall = await this.memory.prefetchForBot(bot, recallQuery, {
            sessionId: session.id,
            source: options.source ?? 'chat',
            roomId: options.roomId ?? '',
          })
          if (recall && typeof recall.text === 'string' && recall.text.trim() !== '') {
            finalPrompt = `${recall.text.trim()}\n\n${rawPrompt}`
          }
        }
      }

      const content = await this.#promptContent(finalPrompt, images, selection)
      const beforeSeq = (session.ownEvents().at(-1)?.seq ?? -1) + 1
      const message = makeUserMessage(finalPrompt, content)
      agent.followup(message)
      await this.#waitIdle(agent)
      try { await this.ctx.sessions.flush(session) } catch (_error) { /* durability is best effort here */ }
      const { reply, allTexts } = this.#replySince(session, beforeSeq)
      const failure = this.#failureSince(session, beforeSeq)
      if (failure !== '') {
        const result = { ok: false, error: failure, sessionId: session.id, startedAt, source: options.source ?? 'chat' }
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
        allTexts,
        messageId: message.id,
        sessionId: session.id,
        startedAt,
        source: options.source ?? 'chat',
      }

      // Async non-blocking turn sync into the global Memory Hub (isolated by bot.id).
      if (this.memory && options.skipMemorySync !== true) {
        const shouldSkip = Boolean(options.roomId && isPassReply(reply))
        if (!shouldSkip && reply.trim() !== '') {
          const userSyncText = String(options.memoryUserText ?? rawPrompt)
          void this.memory.syncTurnForBot(bot, userSyncText, reply, {
            sessionId: session.id,
            source: options.source ?? 'chat',
            roomId: options.roomId ?? '',
          }).catch(() => undefined)
        }
      }

      await this.store.mutate((state) => {
        const stored = state.bots.find(item => item.id === bot.id)
        if (!stored) return
        stored.lastTurnAt = new Date().toISOString()
        // Do not overwrite the primary chat preview with `(pass)` room silence.
        if (!options.roomId || !isPassReply(reply)) {
          stored.lastReply = reply.slice(0, 4_000)
        }
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
      this.#runningKeys.delete(queueKey)
      if (options.roomId) this.#speakingRoomBots.delete(botId)
    }
  }

  /**
   * Bind the Bot's own model, or the DSH default when it has none.
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
    const allTexts = []
    for (const event of events) {
      if (event.seq < beforeSeq) continue
      if (event.type !== 'assistant/message') continue
      const value = textOfBlocks(event.data?.message?.content)
      if (value !== '') allTexts.push(value)
    }
    const reply = allTexts.length > 0 ? allTexts[allTexts.length - 1] : ''
    return { reply, allTexts }
  }

  /** Cancel a live Agent by exact Session ID (used by Group Rooms to stop only the room session). */
  cancelSession(sessionId) {
    if (!sessionId) return { ok: false, error: 'no live session' }
    const agent = this.ctx.get('agents')?.get?.(sessionId)
    if (!agent) return { ok: false, error: 'not running' }
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  cancel(botId) {
    const bot = this.store.bot(botId)
    if (!bot || !bot.sessionId) return { ok: false, error: 'no live session' }
    return this.cancelSession(bot.sessionId)
  }

  /** Deliver one teammate message with Hermes-style hop & dedup loop guards. */
  async messageAgent(senderBotId, targetToken, message, expectReply, callerSessionId = '') {
    const state = this.store.state
    const sender = state.bots.find(bot => bot.id === senderBotId)
    if (!sender) return { ok: false, code: 'not_a_bot', error: 'this Session is not a Bot' }

    // Enforce Group Room isolation strictly by Session ownership (or active room speaking).
    if ((callerSessionId && this.store.roomByMemberSession(callerSessionId)) || this.roomSpeaking(sender.id)) {
      return {
        ok: false,
        code: 'unavailable_in_room',
        error: 'message_agent is unavailable inside a Group Room; reply directly in the room with @Name.',
      }
    }

    const token = oneLine(targetToken)
    if (token === '') return { ok: false, code: 'invalid_target', error: 'target is required' }

    let target = state.bots.find(bot => bot.id === token)
      ?? state.bots.find(bot => bot.name.toLowerCase() === token.toLowerCase())
    if (!target) {
      const prefixMatches = state.bots.filter(bot => bot.name.toLowerCase().startsWith(token.toLowerCase()))
      if (prefixMatches.length > 1) {
        return {
          ok: false,
          code: 'ambiguous_target',
          error: `Ambiguous target "${token}". Matching Bots: ${prefixMatches.map(b => `${b.name} (${b.id})`).join(', ')}.`,
        }
      }
      target = prefixMatches[0]
    }
    if (!target) return { ok: false, code: 'unknown_target', error: `no Bot named "${token}"` }
    if (target.id === sender.id) return { ok: false, code: 'self_message', error: 'cannot message yourself' }

    // Chain loop guard: enforce max hops and duplicate-content detection.
    const senderChain = this.#dmChains.get(sender.id) ?? { chainId: newId('chain'), hops: 0, lastSenderId: '', seen: new Set() }
    const nextHops = senderChain.hops + 1
    if (nextHops > MAX_AGENT_HOPS) {
      return {
        ok: false,
        code: 'max_hops_exceeded',
        error: `Teammate message hop budget (${MAX_AGENT_HOPS}) reached in this chain. Wait for the user before starting another relay.`,
        hops: senderChain.hops,
        maxHops: MAX_AGENT_HOPS,
      }
    }
    const fingerprint = messageFingerprint(sender.id, target.id, message)
    if (senderChain.seen.has(fingerprint)) {
      return {
        ok: false,
        code: 'duplicate_in_chain',
        error: 'An identical message was already sent to this teammate in the current chain; wait for their reply instead of resending.',
      }
    }
    senderChain.seen.add(fingerprint)
    this.#dmChains.set(sender.id, senderChain)

    // Reply-is-final guard: if replying directly back to the teammate who just
    // messaged us, downgrade expectReply to false to prevent polite ping-pong.
    const isDirectBounce = senderChain.lastSenderId === target.id
    const effectiveExpectReply = expectReply === true && !isDirectBounce

    this.#dmChains.set(target.id, {
      chainId: senderChain.chainId,
      hops: nextHops,
      lastSenderId: sender.id,
      seen: senderChain.seen,
    })

    const body = [
      `[Message from ${sender.name}${sender.role ? ` (${sender.role})` : ''} · hop ${nextHops}/${MAX_AGENT_HOPS}]`,
      String(message ?? '').trim(),
      '',
      effectiveExpectReply
        ? `Reply directly as your final message; the dispatcher will deliver your answer back to ${sender.name}. Do not call message_agent back to ${sender.name}.`
        : 'Notify-only message. No reply back is required unless you have a critical blocker.',
    ].join('\n')

    const queued = this.queueDepth(target.id)
    const pending = this.enqueue(target.id, body, { source: 'agent' })
    if (effectiveExpectReply) {
      void pending.then(async (result) => {
        if (!result.ok) return
        let reply = result.text
        if (isPassReply(reply)) return
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
    return {
      ok: true,
      delivered: true,
      queued,
      hops: nextHops,
      maxHops: MAX_AGENT_HOPS,
      downgradedNotifyOnly: expectReply === true && isDirectBounce,
      target: { id: target.id, name: target.name },
    }
  }
}
