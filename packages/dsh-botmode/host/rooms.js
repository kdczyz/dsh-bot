/**
 * Group Rooms: a bounded, strictly serial conversation between 2–6 Bots.
 *
 * One user message opens a dispatch budget (3 rounds / 10 Bot messages). Bots
 * speak one at a time; every reply is appended to the room transcript and the
 * next speaker reads the recent window. A reply may hand off with `@Name`,
 * escalate with `@user`, or stay silent with `[NO_REPLY]`. Hitting the budget
 * pauses the room for a human Continue/Stop instead of looping forever.
 */
import { newId } from './store.js'

const MAX_MEMBERS = 6
const MIN_MEMBERS = 2
const TRANSCRIPT_WINDOW = 10

const mentionPattern = (name) => new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')

export class Rooms {
  #runtime = new Map()

  constructor(store, dispatcher, logger) {
    this.store = store
    this.dispatcher = dispatcher
    this.logger = logger
  }

  state(roomId) {
    const runtime = this.#runtime.get(roomId)
    return { running: runtime?.running === true, stopping: runtime?.stop === true }
  }

  validate(draft) {
    const memberIds = [...new Set(Array.isArray(draft.memberIds) ? draft.memberIds : [])]
    if (memberIds.length < MIN_MEMBERS) return 'A Group Room needs at least two Bots.'
    if (memberIds.length > MAX_MEMBERS) return 'A Group Room holds at most six Bots.'
    for (const id of memberIds) {
      if (!this.store.bot(id)) return `Unknown Bot "${id}".`
    }
    if (draft.leadBotId && !memberIds.includes(draft.leadBotId)) return 'The lead must be a member.'
    return ''
  }

  async save(roomId, draft) {
    const error = this.validate(draft)
    if (error !== '') throw new Error(error)
    return this.store.mutate((state) => {
      const now = new Date().toISOString()
      if (roomId && roomId !== '') {
        const room = state.rooms.find(item => item.id === roomId)
        if (!room) throw new Error('Unknown Group Room.')
        room.name = String(draft.name ?? room.name).trim() || room.name
        room.color = typeof draft.color === 'string' && draft.color !== '' ? draft.color : room.color
        room.memberIds = [...new Set(draft.memberIds)]
        room.mode = draft.mode === 'everyone' || draft.mode === 'lead' ? draft.mode : 'auto'
        room.leadBotId = typeof draft.leadBotId === 'string' ? draft.leadBotId : ''
        room.updatedAt = now
        return room
      }
      const room = {
        id: newId('room'),
        name: String(draft.name ?? '').trim() || 'Group',
        color: typeof draft.color === 'string' && draft.color !== '' ? draft.color : '#d97706',
        memberIds: [...new Set(draft.memberIds)],
        mode: draft.mode === 'everyone' || draft.mode === 'lead' ? draft.mode : 'auto',
        leadBotId: typeof draft.leadBotId === 'string' ? draft.leadBotId : '',
        status: 'idle',
        needsYou: false,
        pausedReason: '',
        transcript: [],
        budget: { rounds: 0, messages: 0, maxRounds: 3, maxMessages: 10 },
        createdAt: now,
      }
      state.rooms.push(room)
      return room
    })
  }

  async remove(roomId) {
    this.#runtime.get(roomId) && (this.#runtime.get(roomId).stop = true)
    await this.store.mutate((state) => {
      state.rooms = state.rooms.filter(room => room.id !== roomId)
    })
  }

  async send(roomId, text) {
    const value = String(text ?? '').trim()
    if (value === '') throw new Error('Write a message first.')
    const room = this.store.room(roomId)
    if (!room) throw new Error('Unknown Group Room.')
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      stored.transcript.push({
        id: newId('msg'),
        from: 'user',
        name: 'You',
        text: value,
        at: new Date().toISOString(),
      })
      stored.transcript = stored.transcript.slice(-200)
      stored.budget = { rounds: 0, messages: 0, maxRounds: 3, maxMessages: 10 }
      stored.status = 'running'
      stored.needsYou = false
      stored.pausedReason = ''
      stored.updatedAt = new Date().toISOString()
    })
    this.#start(roomId, value)
    return this.store.room(roomId)
  }

  async control(roomId, action) {
    const room = this.store.room(roomId)
    if (!room) throw new Error('Unknown Group Room.')
    if (action === 'stop') {
      const runtime = this.#runtime.get(roomId)
      if (runtime) runtime.stop = true
      await this.store.mutate((state) => {
        const stored = state.rooms.find(item => item.id === roomId)
        stored.status = 'idle'
        stored.needsYou = false
        stored.pausedReason = ''
        stored.updatedAt = new Date().toISOString()
      })
      return this.store.room(roomId)
    }
    if (action === 'continue') {
      if (this.#runtime.get(roomId)?.running === true) return room
      await this.store.mutate((state) => {
        const stored = state.rooms.find(item => item.id === roomId)
        stored.status = 'running'
        stored.needsYou = false
        stored.pausedReason = ''
        stored.budget.messages = 0
        stored.budget.rounds = 0
        stored.updatedAt = new Date().toISOString()
      })
      this.#start(roomId, '')
      return this.store.room(roomId)
    }
    throw new Error(`Unknown room action "${action}".`)
  }

  #start(roomId, userText) {
    if (this.#runtime.get(roomId)?.running === true) return
    const runtime = { running: true, stop: false }
    this.#runtime.set(roomId, runtime)
    void this.#run(roomId, userText, runtime)
      .catch((error) => this.logger?.warn?.(`botmode: room ${roomId} stopped: ${String(error)}`))
      .finally(() => {
        runtime.running = false
      })
  }

  #members(room) {
    return room.memberIds.map(id => this.store.bot(id)).filter(Boolean)
  }

  #initialQueue(room, userText) {
    const members = this.#members(room)
    const mentioned = []
    for (const bot of members) {
      if (userText !== '' && mentionPattern(bot.name).test(userText)) mentioned.push(bot.id)
      if (userText !== '' && new RegExp(`@${bot.id}`, 'i').test(userText)) mentioned.push(bot.id)
    }
    const unique = [...new Set(mentioned)]
    if (unique.length > 0) return unique
    if (room.mode === 'everyone') return members.map(bot => bot.id)
    const lead = room.leadBotId !== '' ? room.leadBotId : (members.find(bot => bot.name.toLowerCase().includes('lead'))?.id ?? members[0]?.id)
    return lead ? [lead] : []
  }

  #prompt(room, bot, userText) {
    const members = this.#members(room)
    const roster = members.map(member => `${member.id === bot.id ? '→ ' : ''}${member.name}${member.role ? ` (${member.role})` : ''}`).join(', ')
    const window = room.transcript.slice(-TRANSCRIPT_WINDOW).map((item) => {
      const from = item.from === 'user' ? 'User' : (item.name || 'Bot')
      return `${from}: ${item.text}`
    }).join('\n')
    const ask = userText !== ''
      ? `The user just said:\n${userText}`
      : 'The user asked the room to continue from where it stopped.'
    return [
      `[Group Room "${room.name}"]`,
      `You are ${bot.name}${bot.role ? ` (${bot.role})` : ''}. Members: ${roster}.`,
      '',
      'Recent transcript:',
      window || '(empty)',
      '',
      ask,
      '',
      'Answer as yourself in at most one short paragraph. Do not speak for other members.',
      'To ask a specific member to answer next, write @TheirName. To ask the human, write @user.',
      'If you have nothing useful to add, reply with exactly [NO_REPLY].',
      'Do not use message_agent inside a Group Room.',
    ].join('\n')
  }

  async #run(roomId, userText, runtime) {
    let pending = this.#initialQueue(this.store.room(roomId), userText)
    let rounds = 0
    while (!runtime.stop) {
      const room = this.store.room(roomId)
      if (!room) break
      if (pending.length === 0) {
        rounds += 1
        if (rounds >= room.budget.maxRounds) break
        if (room.mode === 'everyone') {
          const members = this.#members(room)
          pending = members.map(bot => bot.id)
        } else {
          break
        }
      }
      const speakerId = pending.shift()
      const speaker = this.store.bot(speakerId)
      if (!speaker) continue
      if (room.budget.messages >= room.budget.maxMessages) {
        await this.#pause(roomId, 'budget')
        break
      }
      const prompt = this.#prompt(room, speaker, userText)
      const result = await this.dispatcher.enqueue(speaker.id, prompt, { source: 'room', roomId })
      userText = ''
      if (runtime.stop) break
      if (!result.ok) {
        await this.#append(roomId, {
          id: newId('msg'),
          from: speaker.id,
          name: `${speaker.name} (error)`,
          text: result.error,
          at: new Date().toISOString(),
        })
        continue
      }
      let text = String(result.text ?? '').trim()
      if (text === '' || /^\[NO_REPLY\]$/i.test(text)) continue
      const silent = /^\[?NO_REPLY\]?\s*$/i.test(text)
      if (silent) continue
      await this.#append(roomId, {
        id: newId('msg'),
        from: speaker.id,
        name: speaker.name,
        text,
        at: new Date().toISOString(),
      })
      await this.store.mutate((state) => {
        const stored = state.rooms.find(item => item.id === roomId)
        stored.budget.messages += 1
        stored.updatedAt = new Date().toISOString()
      })
      const escalation = /@user\b/i.test(text) || /@你\b/.test(text)
      if (escalation) {
        await this.#pause(roomId, 'mention')
        break
      }
      const members = this.#members(room)
      for (const member of members) {
        if (member.id === speaker.id) continue
        if (mentionPattern(member.name).test(text) || new RegExp(`@${member.id}`, 'i').test(text)) {
          if (!pending.includes(member.id)) pending.push(member.id)
        }
      }
    }
    if (!runtime.stop) {
      const room = this.store.room(roomId)
      if (room && room.status === 'running') {
        await this.store.mutate((state) => {
          const stored = state.rooms.find(item => item.id === roomId)
          stored.status = 'idle'
          stored.updatedAt = new Date().toISOString()
        })
      }
    }
    runtime.running = false
  }

  async #append(roomId, message) {
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored) return
      stored.transcript.push(message)
      stored.transcript = stored.transcript.slice(-200)
      stored.updatedAt = new Date().toISOString()
    })
  }

  async #pause(roomId, reason) {
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored) return
      stored.status = 'paused'
      stored.needsYou = true
      stored.pausedReason = reason
      stored.updatedAt = new Date().toISOString()
    })
  }
}