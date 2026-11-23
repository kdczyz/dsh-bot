/**
 * Group Rooms — Hermes-style deterministic Zero-Token Router state machine.
 *
 * Five core mechanisms implemented purely in code:
 * 1. Shared Room Log + Per-Member Hidden Group Sessions (`room.memberSessions`)
 *    + append-only JSONL archive (`rooms/<roomId>.jsonl`).
 * 2. Deterministic Responder Resolution + Strict Serial Execution + Cross-Round
 *    Round-Robin rotation (`round % len`) + directive `@mention` handoff
 *    (stripping code blocks, quotes and blockquotes so examples never misfire).
 * 3. Per-Member Watermark / Delta Feed captured *before* submitting each turn
 *    (`deliveredThrough`) so concurrent interjections are never missed.
 * 4. Explicit `(pass)` / `[NO_REPLY]` Silence Protocol (hidden from bubbles,
 *    recorded in room activity) + Silent-Round Natural Convergence (`settled`).
 * 5. Hard Caps (`maxRounds` / `maxMessages`, configurable per room, surfaced
 *    explicitly as `capped`, never disguised as `settled` or `idle`),
 *    Single-Drive Lock, real turn cancellation on `stop`, and Epoch Supersession
 *    when the human interjects mid-discussion.
 */
import { appendJsonl, clampInt, newId } from './store.js'
import {
  buildRoomTurnPrompt,
  hasUserEscalation,
  isPassReply,
  parseMentions,
  resolveInitialResponders,
  rotateGroupSpeakers,
  selectDeltaMessages,
} from './room-protocol.js'

const MAX_MEMBERS = 6
const MIN_MEMBERS = 2
const MAX_STORED_TRANSCRIPT = 500
const MAX_STORED_ACTIVITY = 100

export class Rooms {
  #runtime = new Map() // roomId -> { running, stop, superseded, epoch, currentSessionId, currentSpeakerId, pendingRestart }

  constructor(store, dispatcher, logger) {
    this.store = store
    this.dispatcher = dispatcher
    this.logger = logger
  }

  state(roomId) {
    const runtime = this.#runtime.get(roomId)
    return {
      running: runtime?.running === true,
      stopping: runtime?.stop === true,
      epoch: runtime?.epoch ?? 0,
      currentSpeakerId: runtime?.currentSpeakerId ?? '',
    }
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
      const maxRounds = clampInt(draft.maxRounds, 1, 20, undefined)
      const maxMessages = clampInt(draft.maxMessages, 1, 60, undefined)
      const mode = draft.mode === 'everyone' || draft.mode === 'lead' ? draft.mode : 'auto'
      if (roomId && roomId !== '') {
        const room = state.rooms.find(item => item.id === roomId)
        if (!room) throw new Error('Unknown Group Room.')
        room.name = String(draft.name ?? room.name).trim() || room.name
        room.color = typeof draft.color === 'string' && draft.color !== '' ? draft.color : room.color
        room.purpose = typeof draft.purpose === 'string' ? draft.purpose.trim() : room.purpose
        room.notes = typeof draft.notes === 'string' ? draft.notes.trim() : room.notes
        room.memberIds = [...new Set(draft.memberIds)]
        room.mode = mode
        room.leadBotId = typeof draft.leadBotId === 'string' ? draft.leadBotId : ''
        if (maxRounds !== undefined) room.budget.maxRounds = maxRounds
        if (maxMessages !== undefined) room.budget.maxMessages = maxMessages
        room.updatedAt = now
        return room
      }
      const room = {
        id: newId('room'),
        name: String(draft.name ?? '').trim() || 'Group',
        color: typeof draft.color === 'string' && draft.color !== '' ? draft.color : '#d97706',
        purpose: typeof draft.purpose === 'string' ? draft.purpose.trim() : '',
        notes: typeof draft.notes === 'string' ? draft.notes.trim() : '',
        memberIds: [...new Set(draft.memberIds)],
        mode,
        leadBotId: typeof draft.leadBotId === 'string' ? draft.leadBotId : '',
        status: 'idle',
        settledReason: '',
        needsYou: false,
        pausedReason: '',
        epoch: 0,
        nextSeq: 0,
        transcript: [],
        activity: [],
        watermarks: {},
        memberSessions: {},
        budget: {
          rounds: 0,
          messages: 0,
          maxRounds: maxRounds ?? 3,
          maxMessages: maxMessages ?? 10,
        },
        createdAt: now,
      }
      state.rooms.push(room)
      return room
    })
  }

  async remove(roomId) {
    const runtime = this.#runtime.get(roomId)
    if (runtime) {
      runtime.stop = true
      runtime.pendingRestart = null
      if (runtime.currentSessionId) this.dispatcher.cancelSession?.(runtime.currentSessionId)
    }
    this.dispatcher.clearActiveRoom?.(roomId)
    await this.store.mutate((state) => {
      state.rooms = state.rooms.filter(room => room.id !== roomId)
    })
  }

  /**
   * Append a human message, increment the room epoch, supersede any in-flight
   * older epoch safely, and schedule a fresh bounded discussion.
   */
  async send(roomId, text) {
    const value = String(text ?? '').trim()
    if (value === '') throw new Error('Write a message first.')
    const room = this.store.room(roomId)
    if (!room) throw new Error('Unknown Group Room.')

    let appended
    let newEpoch = 0
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      const now = new Date().toISOString()
      stored.epoch = (stored.epoch ?? 0) + 1
      newEpoch = stored.epoch
      stored.nextSeq = (stored.nextSeq ?? 0) + 1
      appended = {
        seq: stored.nextSeq,
        id: newId('msg'),
        from: 'user',
        name: 'You',
        text: value,
        kind: 'message',
        epoch: newEpoch,
        round: 0,
        at: now,
      }
      stored.transcript.push(appended)
      stored.transcript = stored.transcript.slice(-MAX_STORED_TRANSCRIPT)
      stored.budget = {
        rounds: 0,
        messages: 0,
        maxRounds: stored.budget?.maxRounds ?? 3,
        maxMessages: stored.budget?.maxMessages ?? 10,
      }
      stored.status = 'running'
      stored.settledReason = ''
      stored.needsYou = false
      stored.pausedReason = ''
      stored.updatedAt = now
    })
    await this.#archiveEvent(roomId, { type: 'message.user', ...appended })

    this.#scheduleDrive(roomId, {
      epoch: newEpoch,
      triggerText: value,
      triggerReason: 'user',
    })
    return this.store.room(roomId)
  }

  async control(roomId, action) {
    const room = this.store.room(roomId)
    if (!room) throw new Error('Unknown Group Room.')

    if (action === 'stop') {
      const runtime = this.#runtime.get(roomId)
      if (runtime) {
        runtime.stop = true
        runtime.pendingRestart = null
        if (runtime.currentSessionId) {
          this.dispatcher.cancelSession?.(runtime.currentSessionId)
        }
      }
      this.dispatcher.clearActiveRoom?.(roomId)
      await this.#recordActivity(roomId, {
        kind: 'cancelled',
        epoch: room.epoch ?? 0,
        reason: 'user_stop',
      })
      await this.store.mutate((state) => {
        const stored = state.rooms.find(item => item.id === roomId)
        if (!stored) return
        stored.status = 'idle'
        stored.settledReason = ''
        stored.needsYou = false
        stored.pausedReason = ''
        stored.updatedAt = new Date().toISOString()
      })
      return this.store.room(roomId)
    }

    if (action === 'continue') {
      const currentRuntime = this.#runtime.get(roomId)
      if (currentRuntime?.running === true && !currentRuntime.stop) return room
      let epoch = 0
      let latestText = ''
      let lastSpeakerId = ''
      await this.store.mutate((state) => {
        const stored = state.rooms.find(item => item.id === roomId)
        stored.epoch = (stored.epoch ?? 0) + 1
        epoch = stored.epoch
        stored.status = 'running'
        stored.settledReason = ''
        stored.needsYou = false
        stored.pausedReason = ''
        stored.budget.messages = 0
        stored.budget.rounds = 0
        stored.updatedAt = new Date().toISOString()
        const lastMsg = [...stored.transcript].reverse().find(m => m.kind !== 'error')
        latestText = lastMsg ? lastMsg.text : ''
        lastSpeakerId = lastMsg && lastMsg.from !== 'user' ? lastMsg.from : ''
      })
      await this.#recordActivity(roomId, {
        kind: 'continued',
        epoch,
        reason: 'user_continue',
      })
      this.#scheduleDrive(roomId, {
        epoch,
        triggerText: latestText,
        triggerReason: 'continued',
        excludeBotId: lastSpeakerId,
      })
      return this.store.room(roomId)
    }

    throw new Error(`Unknown room action "${action}".`)
  }

  /**
   * Single-Drive Guarantee + Epoch Supersession:
   * - If no driver is active for `roomId`, start one immediately.
   * - If an older driver is still finishing one turn, mark it superseded and
   *   store `pendingRestart`; as soon as the in-flight turn settles and releases
   *   its Session safely, the `finally` block launches the new epoch immediately.
   */
  #scheduleDrive(roomId, plan) {
    const existing = this.#runtime.get(roomId)
    if (existing?.running === true) {
      existing.stop = true
      existing.superseded = true
      existing.pendingRestart = plan
      void this.#recordActivity(roomId, {
        kind: 'cancelled',
        epoch: existing.epoch,
        reason: 'epoch_superseded',
      })
      return
    }
    this.#launchDriver(roomId, plan)
  }

  #launchDriver(roomId, plan) {
    const runtime = {
      running: true,
      stop: false,
      superseded: false,
      epoch: plan.epoch,
      currentSessionId: '',
      currentSpeakerId: '',
      pendingRestart: null,
    }
    this.#runtime.set(roomId, runtime)
    const room = this.store.room(roomId)
    if (room) this.dispatcher.setActiveRoomMembers?.(roomId, room.memberIds)

    void this.#run(roomId, plan, runtime)
      .catch((error) => this.logger?.warn?.(`botmode: room ${roomId} stopped with error: ${String(error)}`))
      .finally(() => {
        runtime.running = false
        runtime.currentSessionId = ''
        runtime.currentSpeakerId = ''
        const nextPlan = runtime.pendingRestart
        runtime.pendingRestart = null
        if (nextPlan && this.store.room(roomId)) {
          this.#launchDriver(roomId, nextPlan)
        } else {
          this.dispatcher.clearActiveRoom?.(roomId)
        }
      })
  }

  #members(room) {
    return room.memberIds.map(id => this.store.bot(id)).filter(Boolean)
  }

  async #run(roomId, plan, runtime) {
    const initialRoom = this.store.room(roomId)
    if (!initialRoom) return
    const maxRounds = initialRoom.budget?.maxRounds ?? 3
    const maxMessages = initialRoom.budget?.maxMessages ?? 10

    // Track per-run mention timestamps (`botId -> { seq, byName }`) and last
    // spoke seq (`botId -> seq`) so we only pull teammates into the next round
    // when they were mentioned *after* their last reply.
    const mentionReq = new Map()
    const lastSpokeSeq = new Map()
    const ownSpokenSeqs = new Map() // botId -> Set<seq>
    let allMentionSeq = 0

    let round = 0
    const firstMembers = this.#members(initialRoom)
    const initial = resolveInitialResponders(initialRoom, plan.triggerText, firstMembers, 0, plan.excludeBotId || '')
    // On `continue`, if the last speaker was a bot that didn't mention anyone,
    // avoid immediately re-picking only that same speaker.
    let currentRoundQueue = initial.botIds.map(botId => ({
      botId,
      directed: initial.directedIds.has(botId),
      mentionedBy: '',
    }))

    if (currentRoundQueue.length === 0) {
      await this.#markSettled(roomId, runtime.epoch, 'empty_roster')
      return
    }

    while (!runtime.stop) {
      const room = this.store.room(roomId)
      if (!room || room.epoch !== runtime.epoch) break

      // Update active membership in case room settings changed mid-run.
      this.dispatcher.setActiveRoomMembers?.(roomId, room.memberIds)

      let spokeCountThisRound = 0
      let roundEndedEarly = false

      for (const task of currentRoundQueue) {
        if (runtime.stop) { roundEndedEarly = true; break }
        const liveRoom = this.store.room(roomId)
        if (!liveRoom || liveRoom.epoch !== runtime.epoch) { roundEndedEarly = true; break }

        if ((liveRoom.budget?.messages ?? 0) >= maxMessages) {
          await this.#markCapped(roomId, runtime.epoch, round, 'max_messages')
          return
        }

        const speaker = this.store.bot(task.botId)
        if (!speaker || !liveRoom.memberIds.includes(speaker.id)) continue

        // Watermark anti-miss rule: capture `deliveredThrough` BEFORE calling the model!
        const deliveredThrough = liveRoom.nextSeq ?? 0
        const lastReadSeq = liveRoom.watermarks?.[speaker.id] ?? 0
        const speakerOwn = ownSpokenSeqs.get(speaker.id)
        const filteredTranscript = speakerOwn
          ? liveRoom.transcript.filter(item => !speakerOwn.has(item.seq))
          : liveRoom.transcript
        const delta = selectDeltaMessages(filteredTranscript, lastReadSeq, deliveredThrough)

        const members = this.#members(liveRoom)
        const prompt = buildRoomTurnPrompt({
          room: liveRoom,
          speaker,
          members,
          delta,
          round,
          directed: task.directed,
          triggerReason: round === 0 ? plan.triggerReason : 'round',
          mentionedBy: task.mentionedBy,
        })

        // Use the most recent delta lines as the concise memory recall query
        // instead of the full system-framing wrapper.
        const memoryQuery = delta.lines.slice(-3).join('\n') || plan.triggerText
        runtime.currentSpeakerId = speaker.id

        const result = await this.dispatcher.enqueue(speaker.id, prompt, {
          source: 'room',
          roomId,
          memoryQuery,
          memoryUserText: delta.lines.join('\n') || plan.triggerText,
          onSessionResolved: (sessionId) => {
            runtime.currentSessionId = sessionId
          },
        })
        runtime.currentSpeakerId = ''
        runtime.currentSessionId = ''

        if (runtime.stop) { roundEndedEarly = true; break }
        const afterRoom = this.store.room(roomId)
        if (!afterRoom || afterRoom.epoch !== runtime.epoch) { roundEndedEarly = true; break }

        if (!result.ok) {
          await this.#advanceWatermark(roomId, speaker.id, deliveredThrough)
          await this.#appendMessage(roomId, {
            from: speaker.id,
            name: `${speaker.name} (error)`,
            text: result.error,
            kind: 'error',
            epoch: runtime.epoch,
            round,
          })
          await this.#recordActivity(roomId, {
            kind: 'error',
            botId: speaker.id,
            botName: speaker.name,
            round,
            epoch: runtime.epoch,
            reason: result.error,
          })
          continue
        }

        const text = String(result.text ?? '').trim()
        if (isPassReply(text)) {
          // Advance watermark strictly to `deliveredThrough` (not room.nextSeq)
          // so any message inserted while this Bot was thinking is preserved.
          await this.#advanceWatermark(roomId, speaker.id, deliveredThrough)
          await this.#recordActivity(roomId, {
            kind: 'passed',
            botId: speaker.id,
            botName: speaker.name,
            round,
            epoch: runtime.epoch,
          })
          continue
        }

        // Substantive reply: append to shared Room Log and increment message count.
        const appended = await this.#appendMessage(roomId, {
          from: speaker.id,
          name: speaker.name,
          text,
          kind: 'message',
          epoch: runtime.epoch,
          round,
        }, { incrementMessages: true })

        spokeCountThisRound += 1
        lastSpokeSeq.set(speaker.id, appended.seq)
        if (!ownSpokenSeqs.has(speaker.id)) ownSpokenSeqs.set(speaker.id, new Set())
        ownSpokenSeqs.get(speaker.id).add(appended.seq)

        // Advance watermark safely: if no concurrent message slipped in between
        // `deliveredThrough` and `appended.seq`, advance past our own message;
        // otherwise advance only to `deliveredThrough` so we never skip an interjection.
        const nextWatermark = appended.seq === deliveredThrough + 1 ? appended.seq : deliveredThrough
        await this.#advanceWatermark(roomId, speaker.id, nextWatermark)

        // Check human escalation (`@user` / `@你`) after stripping quotes/code blocks.
        if (hasUserEscalation(text)) {
          await this.#markPaused(roomId, runtime.epoch, round, 'mention', speaker)
          return
        }

        // Parse directive `@mention` handoffs against current members.
        const latestMembers = this.#members(this.store.room(roomId) ?? afterRoom)
        const mentions = parseMentions(text, latestMembers, speaker.id)
        if (mentions.all) {
          allMentionSeq = appended.seq
          for (const targetId of mentions.botIds) {
            mentionReq.set(targetId, { seq: appended.seq, byName: speaker.name })
          }
        } else {
          for (const targetId of mentions.botIds) {
            mentionReq.set(targetId, { seq: appended.seq, byName: speaker.name })
          }
        }

        // Enforce maxMessages immediately upon reaching the cap.
        const updatedRoom = this.store.room(roomId)
        if ((updatedRoom?.budget?.messages ?? 0) >= maxMessages) {
          await this.#markCapped(roomId, runtime.epoch, round + 1, 'max_messages')
          return
        }
      }

      if (roundEndedEarly || runtime.stop) break

      // Persist completed round count.
      const completedRounds = round + 1
      await this.store.mutate((state) => {
        const stored = state.rooms.find(item => item.id === roomId)
        if (!stored || stored.epoch !== runtime.epoch) return
        stored.budget.rounds = completedRounds
        stored.updatedAt = new Date().toISOString()
      })

      // Rule 4: Natural Convergence — if an entire round produced zero replies
      // (everyone passed), settle immediately and hand control back to the user.
      if (spokeCountThisRound === 0) {
        await this.#markSettled(roomId, runtime.epoch, 'silent_round')
        return
      }

      // Compute who should speak in the next round (`round + 1`).
      const liveRoom = this.store.room(roomId)
      if (!liveRoom || liveRoom.epoch !== runtime.epoch) break
      const members = this.#members(liveRoom)
      const memberIdSet = new Set(members.map(m => m.id))

      // Collect teammates who were explicitly mentioned *after* their last reply.
      const pendingMentions = []
      for (const [botId, info] of mentionReq.entries()) {
        if (!memberIdSet.has(botId)) continue
        const spokeSeq = lastSpokeSeq.get(botId) ?? 0
        if (info.seq > spokeSeq) {
          pendingMentions.push({ botId, seq: info.seq, byName: info.byName })
        }
      }
      pendingMentions.sort((a, b) => a.seq - b.seq)

      const nextRound = round + 1
      let nextQueue = []
      if (allMentionSeq > 0 && pendingMentions.length > 0 && allMentionSeq >= pendingMentions[0].seq) {
        const rotated = rotateGroupSpeakers(members.map(m => m.id), nextRound)
        nextQueue = rotated
          .filter(id => (mentionReq.get(id)?.seq ?? 0) > (lastSpokeSeq.get(id) ?? 0))
          .map(botId => ({
            botId,
            directed: true,
            mentionedBy: mentionReq.get(botId)?.byName ?? '',
          }))
      } else if (pendingMentions.length > 0) {
        // Explicit @mentions: schedule ONLY the mentioned teammates (zero tokens for others).
        nextQueue = pendingMentions.map(item => ({
          botId: item.botId,
          directed: true,
          mentionedBy: item.byName,
        }))
      } else if (liveRoom.mode === 'lead') {
        // In `lead` mode, no further @mentions means the handoff chain is complete.
        await this.#markSettled(roomId, runtime.epoch, 'no_mentions')
        return
      } else {
        // In `auto` / `everyone` mode, rotate the full roster so everyone can
        // review the latest replies and either add value or reply `(pass)` to settle.
        const rotated = rotateGroupSpeakers(members.map(m => m.id), nextRound)
        nextQueue = rotated.map(botId => ({
          botId,
          directed: false,
          mentionedBy: '',
        }))
      }

      if (nextQueue.length === 0) {
        await this.#markSettled(roomId, runtime.epoch, 'completed')
        return
      }

      // Rule 5: Hard Round Cap — if another round is needed beyond `maxRounds`,
      // mark explicitly as `capped` (never disguised as `settled` or `idle`).
      if (nextRound >= maxRounds) {
        await this.#markCapped(roomId, runtime.epoch, completedRounds, 'max_rounds')
        return
      }

      round = nextRound
      currentRoundQueue = nextQueue
    }
  }

  async #advanceWatermark(roomId, botId, seq) {
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored) return
      stored.watermarks = stored.watermarks ?? {}
      const prev = stored.watermarks[botId] ?? 0
      if (seq > prev) stored.watermarks[botId] = seq
    })
  }

  async #appendMessage(roomId, payload, options = {}) {
    let appended
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored) return
      stored.nextSeq = (stored.nextSeq ?? 0) + 1
      appended = {
        seq: stored.nextSeq,
        id: newId('msg'),
        from: payload.from,
        name: payload.name,
        text: payload.text,
        kind: payload.kind === 'error' ? 'error' : 'message',
        epoch: payload.epoch ?? stored.epoch ?? 0,
        round: payload.round ?? 0,
        at: new Date().toISOString(),
      }
      stored.transcript.push(appended)
      stored.transcript = stored.transcript.slice(-MAX_STORED_TRANSCRIPT)
      if (options.incrementMessages === true) {
        stored.budget.messages = (stored.budget.messages ?? 0) + 1
      }
      stored.updatedAt = appended.at
    })
    if (appended) {
      await this.#archiveEvent(roomId, {
        type: appended.kind === 'error' ? 'turn.error' : 'message.member',
        ...appended,
      })
    }
    return appended
  }

  async #recordActivity(roomId, event) {
    const entry = {
      id: newId('act'),
      ...event,
      at: new Date().toISOString(),
    }
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored) return
      stored.activity = stored.activity ?? []
      stored.activity.push(entry)
      stored.activity = stored.activity.slice(-MAX_STORED_ACTIVITY)
    }).catch(() => undefined)
    await this.#archiveEvent(roomId, { type: `room.${entry.kind}`, ...entry })
  }

  async #markSettled(roomId, epoch, reason) {
    await this.#recordActivity(roomId, { kind: 'settled', epoch, reason })
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored || stored.epoch !== epoch) return
      stored.status = 'settled'
      stored.settledReason = reason
      stored.needsYou = false
      stored.pausedReason = ''
      stored.updatedAt = new Date().toISOString()
    })
  }

  async #markCapped(roomId, epoch, rounds, reason) {
    await this.#recordActivity(roomId, { kind: 'capped', epoch, round: rounds, reason })
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored || stored.epoch !== epoch) return
      stored.status = 'capped'
      stored.settledReason = ''
      stored.needsYou = true
      stored.pausedReason = 'budget'
      stored.budget.rounds = Math.max(stored.budget.rounds ?? 0, rounds)
      stored.updatedAt = new Date().toISOString()
    })
  }

  async #markPaused(roomId, epoch, round, reason, speaker) {
    await this.#recordActivity(roomId, {
      kind: 'escalation',
      botId: speaker?.id,
      botName: speaker?.name,
      round,
      epoch,
      reason,
    })
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored || stored.epoch !== epoch) return
      stored.status = 'paused'
      stored.settledReason = ''
      stored.needsYou = true
      stored.pausedReason = reason
      stored.updatedAt = new Date().toISOString()
    })
  }

  async #archiveEvent(roomId, record) {
    try {
      await appendJsonl(this.store.roomLogPath(roomId), record)
    } catch (_error) {
      /* JSONL archiving is best-effort durability */
    }
  }
}
