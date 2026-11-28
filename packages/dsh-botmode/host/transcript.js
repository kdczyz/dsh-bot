/**
 * Fold one Bot Session into the turns the Bot page renders.
 *
 * The Bot page cannot bind these Sessions through the Client Session service:
 * a Bot Session lives under the Bot's own directory, so the Host-side Session
 * list never carries it and `sessions.retain()` refuses it. The Host already
 * owns the events, so it folds them here and the page renders the result with
 * the same components the live transcript uses.
 *
 * The shape mirrors what the Client builds from its own event stream:
 *   { kind: 'user',      key, text, images? }
 *   { kind: 'assistant', key, blocks, streaming: false }
 *   { kind: 'error' | 'notice', key, text }
 * so reasoning rows, tool rows and their arguments/output survive a reload.
 */

const TEXT = 'text'
const REASONING = 'reasoning'
const TOOL_CALL = 'tool-call'
const IMAGE = 'image'

const DEFAULT_REASONING_CHARS = 6000
const DEFAULT_OUTPUT_CHARS = 20000
const DEFAULT_ARGUMENT_CHARS = 8000

const arrayOf = (value) => (Array.isArray(value) ? value : [])

const clip = (text, max) => {
  const value = String(text ?? '')
  if (!Number.isInteger(max) || max <= 0 || value.length <= max) return value
  return `${value.slice(0, max)}\n…`
}

const contentOf = (value) => arrayOf(value)

const partsOf = (content) => contentOf(content).filter(part => part && typeof part === 'object')

const textOf = (parts) => partsOf(parts)
  .filter(part => part.type === TEXT && typeof part.text === 'string')
  .map(part => part.text.trim())
  .filter(text => text !== '')
  .join('\n\n')

const imageCountOf = (parts) => partsOf(parts).filter(part => part.type === IMAGE).length

const userSourceOf = (data) => {
  const source = data && typeof data === 'object' ? data.source : undefined
  if (source && typeof source === 'object' && typeof source.kind === 'string' && source.kind !== '') return source.kind
  return 'user'
}

const seqOf = (event, fallback) => {
  const seq = event && typeof event === 'object' ? event.seq : undefined
  return Number.isInteger(seq) ? seq : fallback
}

/** Assistant content parts become blocks: reasoning, prose and tool calls. */
const blocksOf = (content, argumentChars) => {
  const blocks = []
  for (const part of partsOf(content)) {
    if (part.type === REASONING && typeof part.text === 'string' && part.text.trim() !== '') {
      blocks.push({ kind: 'reasoning', text: clip(part.text, DEFAULT_REASONING_CHARS) })
      continue
    }
    if (part.type === TEXT && typeof part.text === 'string' && part.text.trim() !== '') {
      blocks.push({ kind: 'text', text: part.text })
      continue
    }
    if (part.type === TOOL_CALL) {
      const raw = part.arguments
      blocks.push({
        kind: 'tool',
        callId: String(part.id || part.callId || ''),
        name: String(part.name || 'tool'),
        arguments: clip(typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}), argumentChars),
      })
    }
  }
  return blocks
}

/**
 * Fold Session events into render-ready turns.
 * @param events - raw Session events, oldest first.
 * @param options - max turns to keep (`{ limit }`, 0 keeps all) or a bare limit.
 *                  `after` emits only turns newer than that event seq, so a
 *                  polling reader pays for the new turn rather than the log.
 */
export const foldTranscript = (events, options = 120) => {
  const opts = typeof options === 'number' ? { limit: options } : (options || {})
  const limit = Number.isInteger(opts.limit) ? opts.limit : 120
  const after = Number.isInteger(opts.after) ? opts.after : -1
  const turns = []
  const calls = new Map()
  const list = arrayOf(events)
  for (let index = 0; index < list.length; index += 1) {
    const event = list[index]
    if (!event || typeof event !== 'object') continue
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'user/message') {
      // 'user' is the only source that carries something the reader typed;
      // every other kind is a Host injection replaying into the prompt.
      if (userSourceOf(data) !== 'user') continue
      const text = textOf(data.content)
      const images = imageCountOf(data.content)
      if (text === '' && images === 0) continue
      turns.push({
        kind: 'user',
        key: `u${seqOf(event, index)}`,
        seq: seqOf(event, index),
        text,
        ...images > 0 ? { images } : {},
      })
      continue
    }
    if (event.type === 'assistant/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const blocks = blocksOf(message.content, DEFAULT_ARGUMENT_CHARS)
      if (blocks.length === 0) continue
      turns.push({
        kind: 'assistant',
        key: `a${seqOf(event, index)}`,
        seq: seqOf(event, index),
        blocks,
        streaming: false,
      })
      continue
    }
    if (event.type === 'tool/call') {
      const callId = String(data.callId || '')
      if (callId === '') continue
      const raw = data.arguments
      calls.set(callId, {
        callId,
        name: String(data.name || 'tool'),
        arguments: clip(typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}), DEFAULT_ARGUMENT_CHARS),
        status: 'running',
        output: '',
        isError: false,
      })
      continue
    }
    if (event.type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const callId = String(message.toolCallId || (message.source && message.source.callId) || '')
      if (callId === '') continue
      const existing = calls.get(callId) || {
        callId,
        name: String(message.name || 'tool'),
        arguments: '',
        status: 'done',
        output: '',
        isError: false,
      }
      existing.status = message.isError === true ? 'error' : 'done'
      existing.isError = message.isError === true
      existing.output = clip(textOf(message.content), DEFAULT_OUTPUT_CHARS)
      calls.set(callId, existing)
      continue
    }
    if (event.type === 'turn/end') {
      const reason = data.reason && typeof data.reason === 'object' ? data.reason : {}
      if (reason.kind === 'error') {
        const failed = reason.error && reason.error.message ? reason.error.message : 'The turn failed.'
        turns.push({ kind: 'error', key: `e${seqOf(event, index)}`, seq: seqOf(event, index), text: String(failed) })
      } else if (reason.kind === 'aborted') {
        turns.push({ kind: 'notice', key: `n${seqOf(event, index)}`, seq: seqOf(event, index), text: 'stopped' })
      }
    }
  }
  // A tool block already knows its name from the assistant message; the call
  // record adds the settled status and output the reader expands.
  for (const turn of turns) {
    if (turn.kind !== 'assistant') continue
    turn.blocks = turn.blocks.map((block) => {
      if (block.kind !== 'tool') return block
      const call = calls.get(block.callId)
      if (call === undefined) {
        return {
          ...block,
          call: { callId: block.callId, name: block.name, arguments: block.arguments, status: 'done', output: '', isError: false },
        }
      }
      return { ...block, name: block.name || call.name, call }
    })
  }
  const fresh = after < 0 ? turns : turns.filter(turn => turn.seq > after)
  if (Number.isInteger(limit) && limit > 0 && fresh.length > limit) return fresh.slice(-limit)
  return fresh
}

/** Read the events of one Session from the live agent when present, else persistence. */
const readEvents = async (ctx, sessionId) => {
  const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  if (live && typeof live.snapshotEvents === 'function') {
    try {
      const events = live.snapshotEvents()
      if (Array.isArray(events) && events.length > 0) return events
    } catch (_error) {
      // A live Session that refuses its snapshot falls through to the stored log.
    }
  }
  const query = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (query && typeof query.load === 'function') {
    try {
      const snapshot = await query.load(sessionId)
      const events = snapshot && typeof snapshot === 'object' ? snapshot.events : undefined
      if (Array.isArray(events)) return events
    } catch (_error) {
      return []
    }
  }
  return []
}

/**
 * Fold one Session id into render-ready turns.
 * @returns {Promise<{cursor: number, turns: Array<object>}>} newest event seq and
 *   the oldest-first turns a reader still needs.
 */
export const readBotTranscript = async (ctx, sessionId, options = {}) => {
  if (typeof sessionId !== 'string' || sessionId === '') return { cursor: -1, turns: [] }
  const events = await readEvents(ctx, sessionId)
  const seqs = events.map(event => (event && Number.isInteger(event.seq) ? event.seq : -1))
  const cursor = seqs.length === 0 ? -1 : seqs[seqs.length - 1]
  return { cursor, turns: foldTranscript(events, options) }
}