/**
 * Group Rooms — Task-Driven Event-Driven Concurrent Actor Bus on Hermes primitives.
 *
 * Core architecture:
 * 1. Hermes Base Primitives:
 *    - Monotonic `nextSeq` Room Log with atomic CAS-capable `appendAtomic` + JSONL archive.
 *    - Isolated per-member hidden Group Sessions (`room.memberSessions[botId]`).
 *    - Monotonic `epoch` fencing for human Soft Steer & cancellation boundaries.
 * 2. Explicit Business Terminal States (replaces fixed `maxRounds` cutoffs):
 *    - `completed`: entered ONLY when an authorized Bot invokes `room_finish_task`.
 *    - `settled`: all active Bots have processed the latest `seq` via `(pass)` with
 *      zero running turns and zero pending human approvals/questions.
 *    - `waiting_user`: local branch suspension on `approval/request` or
 *      `ask_user_question`, or explicit `@user` escalation; auto-resumes on reply/approval.
 * 3. Pathological Soft-Pause Probes (`stalled` / `paused_error`, zero false-positives):
 *    - Consecutive Idle Text-Only Probe (`idle_spin`): 5 consecutive causal rounds with
 *      only plain-text chat and zero tool calls, file edits, or subtask claims.
 *    - Per-Bot Repeated Error Fingerprint (`paused_error`): 3 identical consecutive error
 *      signatures pause ONLY that Bot and broadcast a help alert to teammates.
 *    - Soft Token Budget Checkpoint (`token_budget`): pauses cleanly at `tokenLimit`
 *      preserving all sessions & watermarks; clicking Continue extends the checkpoint.
 * 4. Event-Driven Concurrent `BotActor`s + Snapshot Watermark Anti-Miss:
 *    - Idle Bots wake up concurrently on Room Log updates (eliminating slow-Bot head-of-line blocking).
 *    - Watermark advances strictly to pre-turn `snapshotSeq` while recording `selfSentSeqs`,
 *      so concurrent messages from teammates or human Soft Steer are never skipped.
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { appendJsonl, clampInt, isStrictSubpath, newId } from './store.js'
import {
  buildRoomTurnPrompt,
  classifyMemberHoldDirective,
  evaluateActorDelta,
  findUnresolvedMentions,
  GROUP_ADDRESSED_NUDGE_SUFFIX,
  hasUserEscalation,
  isPassReply,
  parseMentions,
  resolveEffectiveLeadId,
  resolveInitialResponders,
  selectDeltaMessages,
} from './room-protocol.js'
import { findSubtaskClaimConflicts, normalizeLeasePath } from './room-locks.js'

const FORBIDDEN_WORK_DIRS = new Set(['/', '/etc', '/proc', '/sys', '/dev', '/root', '/boot', '/usr', '/bin', '/sbin'])

const MAX_MEMBERS = 6
const MIN_MEMBERS = 2
const MAX_STORED_TRANSCRIPT = 500
const MAX_STORED_ACTIVITY = 120
const MAX_REPEAT_ERRORS = 3
const DEFAULT_TOKEN_LIMIT = 0
const DEFAULT_IDLE_ROUND_LIMIT = 5

class BotActor {
  constructor(botId, initialWatermark = 0) {
    this.botId = botId
    this.watermark = initialWatermark
    this.selfSentSeqs = new Set()
    /** @type {'idle' | 'running' | 'waiting_approval' | 'waiting_question' | 'paused_error'} */
    this.state = 'idle'
    this.inTurn = false
    this.activeRunToken = 0
    this.sessionId = ''
    this.startedAt = ''
    this.turnEpoch = 0
    this.actedEpoch = 0
    this.lastActedSeq = 0
    this.pausedError = ''
    this.errorStreak = { fingerprint: '', count: 0, lastSummary: '' }
    this.forceContinueTurn = false
    this.forceProgressReview = false
  }

  resetFault() {
    if (this.state === 'paused_error') {
      this.state = 'idle'
    }
    this.pausedError = ''
    this.errorStreak = { fingerprint: '', count: 0, lastSummary: '' }
  }

  publicView(bot) {
    return {
      botId: this.botId,
      botName: bot?.name ?? this.botId,
      role: bot?.role ?? '',
      color: bot?.color ?? '#4d6bfe',
      state: this.state,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      pausedError: this.pausedError,
      watermark: this.watermark,
    }
  }
}

export class Rooms {
  #buses = new Map() // roomId -> RoomBus state
  #approvalUnsub = null

  constructor(store, dispatcher, logger, approvals = null) {
    this.store = store
    this.dispatcher = dispatcher
    this.logger = logger
    this.approvals = approvals ?? null
    this.onDeliverables = null
    if (this.approvals) this.bindApprovals(this.approvals)
  }

  setArtifactHandler(handler) {
    this.onDeliverables = typeof handler === 'function' ? handler : null
  }

  bindApprovals(approvals) {
    if (this.#approvalUnsub) this.#approvalUnsub()
    this.approvals = approvals
    if (!approvals || typeof approvals.onChange !== 'function') return
    this.#approvalUnsub = approvals.onChange((event) => {
      this.#onInteractionStateChanged(event)
    })
  }

  state(roomId) {
    const bus = this.#buses.get(roomId)
    if (!bus) {
      return {
        running: false,
        stopping: false,
        epoch: this.store.room(roomId)?.epoch ?? 0,
        currentSpeakerId: '',
        speakingBotIds: [],
        actors: [],
      }
    }
    const actors = []
    const speakingBotIds = []
    for (const actor of bus.actors.values()) {
      const bot = this.store.bot(actor.botId)
      if (!bot) continue
      actors.push(actor.publicView(bot))
      if (actor.state === 'running' || actor.state === 'waiting_approval' || actor.state === 'waiting_question') {
        speakingBotIds.push(actor.botId)
      }
    }
    const running = bus.active && speakingBotIds.length > 0
    return {
      running: bus.active && (speakingBotIds.length > 0 || this.store.room(roomId)?.status === 'running'),
      stopping: bus.stopping === true,
      epoch: bus.epoch,
      currentSpeakerId: speakingBotIds[0] ?? '',
      speakingBotIds,
      actors,
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
    if (typeof draft.workDir === 'string' && draft.workDir.trim() !== '') {
      const rawWorkDir = draft.workDir.trim()
      if (!isAbsolute(rawWorkDir)) return 'Shared workspace workDir must be an absolute path.'
      const norm = resolve(rawWorkDir)
      const sshDir = resolve(homedir(), '.ssh')
      const storeRoot = this.store?.root ? resolve(this.store.root) : ''
      if (
        FORBIDDEN_WORK_DIRS.has(norm)
        || norm === sshDir || isStrictSubpath(sshDir, norm)
        || (storeRoot && (norm === storeRoot || isStrictSubpath(storeRoot, norm)))
      ) {
        return `Refused unsafe shared workspace path "${rawWorkDir}".`
      }
    }
    return ''
  }

  async save(roomId, draft) {
    const error = this.validate(draft)
    if (error !== '') throw new Error(error)
    return this.store.mutate((state) => {
      const now = new Date().toISOString()
      const maxRounds = draft.maxRounds !== undefined
        ? clampInt(draft.maxRounds, 0, 10_000, 0)
        : undefined
      const maxMessages = draft.maxMessages !== undefined
        ? clampInt(draft.maxMessages, 0, 100_000, 0)
        : undefined
      const defaultTokenLimit = state.settings?.groupChat?.defaultTokenLimit ?? DEFAULT_TOKEN_LIMIT
      const defaultIdleRoundLimit = state.settings?.groupChat?.defaultIdleRoundLimit ?? DEFAULT_IDLE_ROUND_LIMIT
      const tokenLimit = draft.tokenLimit !== undefined
        ? clampInt(draft.tokenLimit, 0, 1_000_000_000, defaultTokenLimit)
        : undefined
      const idleRoundLimit = draft.idleRoundLimit !== undefined
        ? clampInt(draft.idleRoundLimit, 1, 100, defaultIdleRoundLimit)
        : undefined
      const mode = draft.mode === 'everyone' || draft.mode === 'lead' ? draft.mode : 'auto'
      if (roomId && roomId !== '') {
        const room = state.rooms.find(item => item.id === roomId)
        if (!room) throw new Error('Unknown Group Room.')
        room.name = String(draft.name ?? room.name).trim() || room.name
        room.color = typeof draft.color === 'string' && draft.color !== '' ? draft.color : room.color
        room.purpose = typeof draft.purpose === 'string' ? draft.purpose.trim() : room.purpose
        room.notes = typeof draft.notes === 'string' ? draft.notes.trim() : room.notes
        if (typeof draft.workDir === 'string') room.workDir = draft.workDir.trim()
        room.memberIds = [...new Set(draft.memberIds)]
        room.mode = mode
        room.leadBotId = typeof draft.leadBotId === 'string' ? draft.leadBotId : ''
        room.budget = room.budget ?? {}
        if (maxRounds !== undefined) room.budget.maxRounds = maxRounds
        if (maxMessages !== undefined) room.budget.maxMessages = maxMessages
        if (tokenLimit !== undefined) {
          room.budget.tokenLimit = tokenLimit
          room.budget.tokenCheckpoint = tokenLimit > 0
            ? Math.max(tokenLimit, (room.budget.tokensUsed ?? 0) + tokenLimit)
            : 0
        }
        if (idleRoundLimit !== undefined) room.budget.idleRoundLimit = idleRoundLimit
        room.updatedAt = now
        return room
      }
      const effectiveTokenLimit = tokenLimit ?? defaultTokenLimit
      const room = {
        id: newId('room'),
        name: String(draft.name ?? '').trim() || 'Group',
        color: typeof draft.color === 'string' && draft.color !== '' ? draft.color : '#d97706',
        purpose: typeof draft.purpose === 'string' ? draft.purpose.trim() : '',
        notes: typeof draft.notes === 'string' ? draft.notes.trim() : '',
        workDir: typeof draft.workDir === 'string' ? draft.workDir.trim() : '',
        memberIds: [...new Set(draft.memberIds)],
        mode,
        leadBotId: typeof draft.leadBotId === 'string' ? draft.leadBotId : '',
        status: 'idle',
        settledReason: '',
        needsYou: false,
        pausedReason: '',
        completion: null,
        subtasks: [],
        progress: { goal: '', items: [], updatedBy: '', updatedAt: '' },
        epoch: 0,
        nextSeq: 0,
        transcript: [],
        activity: [],
        watermarks: {},
        memberSessions: {},
        budget: {
          rounds: 0,
          messages: 0,
          maxRounds: maxRounds ?? 0,
          maxMessages: maxMessages ?? 0,
          tokensUsed: 0,
          tokenLimit: effectiveTokenLimit,
          tokenCheckpoint: effectiveTokenLimit,
          idleRounds: 0,
          idleRoundLimit: idleRoundLimit ?? defaultIdleRoundLimit,
        },
        createdAt: now,
      }
      state.rooms.push(room)
      return room
    })
  }

  async remove(roomId) {
    await this.#hardStopBus(roomId)
    this.dispatcher.clearActiveRoom?.(roomId)
    await this.store.mutate((state) => {
      state.rooms = state.rooms.filter(room => room.id !== roomId)
    })
  }

  /**
   * Append a human message with Soft Steer semantics:
   * - Increments `room.epoch` (fencing stale @mentions from older in-flight turns).
   * - Does NOT hard-abort busy Bots running compilations/scripts; busy Bots finish
   *   their current step and pick up the new message immediately via snapshot watermark.
   * - Idle Bots matching the routing filter wake up concurrently right away.
   */
  async send(roomId, text) {
    const value = String(text ?? '').trim()
    if (value === '') throw new Error('Write a message first.')
    const room = this.store.room(roomId)
    if (!room) throw new Error('Unknown Group Room.')

    if (value === '/stop') {
      return this.control(roomId, 'stop')
    }

    let appended
    let newEpoch = 0
    let unresolvedMentions = []
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      const now = new Date().toISOString()
      stored.epoch = (stored.epoch ?? 0) + 1
      newEpoch = stored.epoch
      stored.nextSeq = (stored.nextSeq ?? 0) + 1
      const members = stored.memberIds.map(id => state.bots.find(b => b.id === id)).filter(Boolean)
      const parsed = parseMentions(value, members)
      if (!parsed.all && parsed.botIds.length === 0) {
        unresolvedMentions = findUnresolvedMentions(value, members)
      }
      appended = {
        seq: stored.nextSeq,
        id: newId('msg'),
        from: 'user',
        name: 'You',
        text: value,
        kind: 'message',
        mentions: parsed.botIds,
        epoch: newEpoch,
        round: 0,
        at: now,
      }
      stored.transcript.push(appended)
      stored.transcript = stored.transcript.slice(-MAX_STORED_TRANSCRIPT)
      const tokenLimit = stored.budget?.tokenLimit ?? DEFAULT_TOKEN_LIMIT
      const tokensUsed = stored.budget?.tokensUsed ?? 0
      const prevCheckpoint = stored.budget?.tokenCheckpoint ?? 0
      const nextCheckpoint = tokenLimit > 0
        ? (prevCheckpoint > 0 ? prevCheckpoint : tokensUsed + tokenLimit)
        : 0
      stored.budget = {
        rounds: 0,
        messages: 0,
        maxRounds: stored.budget?.maxRounds ?? 0,
        maxMessages: stored.budget?.maxMessages ?? 0,
        tokensUsed,
        tokenLimit,
        tokenCheckpoint: nextCheckpoint,
        idleRounds: 0,
        idleRoundLimit: stored.budget?.idleRoundLimit ?? DEFAULT_IDLE_ROUND_LIMIT,
      }
      stored.status = 'running'
      stored.settledReason = ''
      stored.needsYou = false
      stored.pausedReason = ''
      stored.completion = null
      stored.updatedAt = now
    })
    await this.#archiveEvent(roomId, { type: 'message.user', ...appended })

    // Guard against typos like `@运维管` silently broadcasting to every Bot in the room!
    if (unresolvedMentions.length > 0) {
      const liveMembers = this.#members(this.store.room(roomId))
      const available = liveMembers.map(m => `@${m.name}`).join('、')
      await this.appendAtomic(roomId, {
        from: 'system',
        name: 'System',
        text: `未找到群成员 ${unresolvedMentions.map(t => `@${t}`).join('、')}，本次未唤醒全员。可用成员：${available || '(无)'}（如需全员回应请使用 @所有人）。`,
        kind: 'system',
        epoch: newEpoch,
        round: 0,
      })
      await this.#markSettled(roomId, newEpoch, 'unresolved_mention')
      return this.store.room(roomId)
    }

    const bus = this.#ensureBus(roomId, newEpoch)
    const liveMembers = this.#members(this.store.room(roomId))
    const holdDir = classifyMemberHoldDirective(value, liveMembers)
    if (holdDir.holdAll) {
      for (const m of liveMembers) bus.heldBotIds.add(m.id)
    } else {
      for (const id of holdDir.hold) bus.heldBotIds.add(id)
    }
    if (holdDir.releaseAll) {
      bus.heldBotIds.clear()
    } else {
      for (const id of holdDir.release) bus.heldBotIds.delete(id)
    }
    const hadInFlight = [...bus.actors.values()].some(a => a.state === 'running')
    if (hadInFlight) {
      void this.#recordActivity(roomId, {
        kind: 'soft_steer',
        epoch: newEpoch,
        reason: 'user_interject',
      })
    }
    bus.epoch = newEpoch
    bus.active = true
    bus.stopping = false
    bus.finished = false
    bus.finishedByBotId = ''
    bus.escalationBot = null
    bus.softPausePending = null
    bus.progressReviewDone = false
    bus.epochErrors = 0
    bus.epochReplies = 0
    bus.epochProductiveTurns = 0
    bus.epochContributors = new Set()
    bus.roundStats.clear()
    bus.maxRoundsCap = (this.store.room(roomId)?.budget?.maxRounds ?? 0)
    bus.maxMessagesCap = (this.store.room(roomId)?.budget?.maxMessages ?? 0)
    for (const actor of bus.actors.values()) {
      // Preserve consecutive identical error streak across user retries unless explicitly resumed
      // or cleared by a successful turn, so repeated model/provider errors reliably trip `paused_error`.
      if (actor.state === 'paused_error') actor.state = 'idle'
      actor.pausedError = ''
      actor.actedEpoch = 0
      actor.lastActedSeq = 0
      actor.forceContinueTurn = false
      actor.forceProgressReview = false
    }
    this.dispatcher.setActiveRoomMembers?.(roomId, this.store.room(roomId)?.memberIds ?? [])
    this.#notifyBus(bus)
    return this.store.room(roomId)
  }

  async control(roomId, action, extra = {}) {
    const room = this.store.room(roomId)
    if (!room) throw new Error('Unknown Group Room.')

    if (action === 'stop') {
      await this.#hardStopBus(roomId)
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

    if (action === 'resume_bot') {
      const targetBotId = String(extra?.botId ?? '')
      const bus = this.#ensureBus(roomId, room.epoch ?? 1)
      const actor = bus.actors.get(targetBotId)
      if (actor) actor.resetFault()
      if (room.status === 'stalled' || room.status === 'paused' || room.status === 'waiting_user') {
        return this.control(roomId, 'continue')
      }
      this.#notifyBus(bus)
      return this.store.room(roomId)
    }

    if (action === 'continue') {
      const existingBus = this.#buses.get(roomId)
      const anyRunning = existingBus
        ? [...existingBus.actors.values()].some(a => a.state === 'running')
        : false
      if (existingBus?.active && anyRunning && !existingBus.stopping && room.status === 'running') {
        return room
      }

      let epoch = 0
      let latestText = ''
      let lastSpeakerId = ''
      let nextMaxRoundsCap = 0
      let nextMaxMessagesCap = 0
      await this.store.mutate((state) => {
        const stored = state.rooms.find(item => item.id === roomId)
        // Preserve the current discussion epoch so pending unread `@mentions` from the
        // paused discussion remain visible to `evaluateActorDelta` (Hermes `room.continued`).
        stored.epoch = Math.max(1, stored.epoch ?? 1)
        epoch = stored.epoch
        stored.status = 'running'
        stored.settledReason = ''
        stored.needsYou = false
        stored.pausedReason = ''
        stored.budget = stored.budget ?? {}
        stored.budget.idleRounds = 0
        // Extend soft token checkpoint by another full tranche
        const tokenLimit = stored.budget.tokenLimit ?? DEFAULT_TOKEN_LIMIT
        if (tokenLimit > 0) {
          stored.budget.tokenCheckpoint = (stored.budget.tokensUsed ?? 0) + tokenLimit
        }
        // Reset optional round/message counters for the fresh continuation window
        stored.budget.messages = 0
        stored.budget.rounds = 0
        nextMaxRoundsCap = stored.budget.maxRounds ?? 0
        nextMaxMessagesCap = stored.budget.maxMessages ?? 0
        stored.updatedAt = new Date().toISOString()
        const lastMsg = [...stored.transcript].reverse().find(m => m.kind === 'message')
        latestText = lastMsg ? lastMsg.text : ''
        lastSpeakerId = lastMsg && lastMsg.from !== 'user' ? lastMsg.from : ''
      })
      await this.#recordActivity(roomId, {
        kind: 'continued',
        epoch,
        reason: 'user_continue',
      })

      const bus = this.#ensureBus(roomId, epoch)
      bus.epoch = epoch
      bus.active = true
      bus.stopping = false
      bus.finished = false
      bus.finishedByBotId = ''
      bus.escalationBot = null
      bus.softPausePending = null
      bus.progressReviewDone = false
      bus.epochErrors = 0
      bus.epochReplies = 0
      bus.epochProductiveTurns = 0
      bus.epochContributors = new Set()
      bus.heldBotIds.clear()
      bus.roundStats.clear()
      // Aligned with Hermes `plan_next_task`: `Continue` grants another full tranche of
      // `maxRounds` while preserving the same discussion epoch so unread `@mentions` are never dropped.
      const prevRoundsCap = bus.maxRoundsCap || nextMaxRoundsCap
      bus.maxRoundsCap = nextMaxRoundsCap > 0 ? prevRoundsCap + nextMaxRoundsCap : 0
      bus.maxMessagesCap = nextMaxMessagesCap

      const liveRoom = this.store.room(roomId)
      const latestSeq = liveRoom?.nextSeq ?? 0
      const members = liveRoom ? this.#members(liveRoom) : []
      const epochMessages = (liveRoom?.transcript ?? []).filter(
        item => (Number(item.epoch) || 0) === epoch && item.seq <= latestSeq,
      )
      let anyActionableUnread = false
      for (const actor of bus.actors.values()) {
        actor.resetFault()
        const unread = (liveRoom?.transcript ?? []).filter(
          m => m.seq > actor.watermark && m.seq <= latestSeq && !actor.selfSentSeqs.has(m.seq) && m.from !== actor.botId,
        )
        if (unread.length > 0 && liveRoom) {
          const check = evaluateActorDelta({
            room: liveRoom,
            actorBotId: actor.botId,
            members,
            deltaItems: unread,
            pausedBotIds: new Set(),
            heldBotIds: bus.heldBotIds,
            currentEpoch: epoch,
            epochMessages,
            hasActedInEpoch: actor.actedEpoch === epoch,
            lastActedSeq: actor.actedEpoch === epoch ? actor.lastActedSeq : 0,
          })
          if (check.shouldRespond) anyActionableUnread = true
        }
      }

      // Only force a continuation turn on initial responders when no actor already
      // has an actionable unread `@mention` or kickoff pending in this epoch.
      if (liveRoom && !anyActionableUnread) {
        const initial = resolveInitialResponders(liveRoom, latestText, members, 0, lastSpeakerId)
        for (const botId of initial.botIds) {
          const actor = bus.actors.get(botId)
          if (actor) actor.forceContinueTurn = true
        }
      }

      this.dispatcher.setActiveRoomMembers?.(roomId, liveRoom?.memberIds ?? [])
      this.#notifyBus(bus)
      return this.store.room(roomId)
    }

    throw new Error(`Unknown room action "${action}".`)
  }

  /**
   * Shared Task Board & Path Soft-Lock tool handler (`claim_subtask`).
   */
  async claimSubtask(roomId, callerBot, input = {}) {
    const room = this.store.room(roomId)
    if (!room) return { ok: false, code: 'unknown_room', error: 'Group Room does not exist.' }
    if (!room.memberIds.includes(callerBot.id)) {
      return { ok: false, code: 'not_a_member', error: 'You are not a member of this Group Room.' }
    }

    const action = String(input.action ?? '').toLowerCase()
    if (action === 'list') {
      return { ok: true, subtasks: room.subtasks ?? [] }
    }

    const taskId = String(input.taskId ?? '').trim()
    if (taskId === '') {
      return { ok: false, code: 'invalid_task_id', error: 'taskId is required.' }
    }
    const rawStatus = String(input.status ?? 'in_progress').trim().toLowerCase()
    const nextStatus = rawStatus === 'completed' || rawStatus === 'done'
      ? 'completed'
      : rawStatus === 'released' || rawStatus === 'release'
        ? 'released'
        : 'in_progress'
    const requestedPaths = Array.isArray(input.paths)
      ? input.paths.map(p => String(p ?? '').trim()).filter(Boolean)
      : []
    const title = typeof input.title === 'string' ? input.title.trim() : ''

    let outcome
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored) {
        outcome = { ok: false, code: 'unknown_room', error: 'Group Room does not exist.' }
        return
      }
      stored.subtasks = Array.isArray(stored.subtasks) ? stored.subtasks : []

      const claimBaseDir = stored.workDir || callerBot.dir
      const normalizedPaths = requestedPaths
        .map(p => normalizeLeasePath(p, claimBaseDir))
        .filter(Boolean)

      if (nextStatus === 'in_progress') {
        const conflicts = findSubtaskClaimConflicts(stored, callerBot.id, normalizedPaths, claimBaseDir)
        if (conflicts.length > 0) {
          const detail = conflicts
            .map(c => `"${c.path}" 正由 @${c.ownerName} 占用（子任务：${c.taskId}）`)
            .join('；')
          outcome = {
            ok: false,
            code: 'path_locked',
            conflicts,
            error: `路径租约冲突：${detail}。请先在群里与对方同步，或认领其他不冲突的子任务。`,
          }
          return
        }
      }

      const existing = stored.subtasks.find(t => t.taskId === taskId)
      const effectiveLeadId = resolveEffectiveLeadId(stored, this.#members(stored))
      if (existing && existing.ownerBotId && existing.ownerBotId !== callerBot.id) {
        if (existing.status === 'in_progress' && callerBot.id !== effectiveLeadId) {
          outcome = {
            ok: false,
            code: 'subtask_owned_by_teammate',
            error: `Subtask "${taskId}" is currently owned by @${existing.ownerName}.`,
          }
          return
        }
      }

      const now = new Date().toISOString()
      if (existing) {
        if (title !== '') existing.title = title
        if (nextStatus === 'in_progress') {
          existing.ownerBotId = callerBot.id
          existing.ownerName = callerBot.name
          if (normalizedPaths.length > 0) existing.paths = normalizedPaths
        }
        existing.status = nextStatus
        existing.updatedAt = now
        outcome = { ok: true, subtask: { ...existing }, subtasks: stored.subtasks.slice() }
      } else {
        const created = {
          taskId,
          title,
          ownerBotId: callerBot.id,
          ownerName: callerBot.name,
          paths: normalizedPaths,
          status: nextStatus,
          updatedAt: now,
        }
        stored.subtasks.push(created)
        outcome = { ok: true, subtask: { ...created }, subtasks: stored.subtasks.slice() }
      }
      if (stored.budget) stored.budget.idleRounds = 0
      stored.updatedAt = now
    })

    if (outcome?.ok) {
      const bus = this.#buses.get(roomId)
      if (bus) bus.roundStats.clear()
      await this.#recordActivity(roomId, {
        kind: nextStatus === 'completed' ? 'subtask_completed' : nextStatus === 'released' ? 'subtask_released' : 'subtask_claimed',
        botId: callerBot.id,
        botName: callerBot.name,
        taskId,
        paths: requestedPaths,
        epoch: room.epoch ?? 0,
      })
    }
    return outcome
  }

  /**
   * Shared Task Progress Checklist tool handler (`room_task_progress`) used by
   * the `room-completion` skill to inspect/update milestones and verify whether
   * all requirements are satisfied before invoking `room_finish_task`.
   */
  async updateTaskProgress(roomId, callerBot, input = {}) {
    const room = this.store.room(roomId)
    if (!room) return { ok: false, code: 'unknown_room', error: 'Group Room does not exist.' }
    if (!room.memberIds.includes(callerBot.id)) {
      return { ok: false, code: 'not_a_member', error: 'You are not a member of this Group Room.' }
    }
    const action = String(input.action ?? 'get').trim().toLowerCase()
    const bus = this.#buses.get(roomId)
    const activeTeammates = bus
      ? [...bus.actors.values()]
        .filter(a => a.botId !== callerBot.id && (a.state === 'running' || a.state === 'waiting_approval' || a.state === 'waiting_question'))
        .map(a => ({ botId: a.botId, botName: this.store.bot(a.botId)?.name ?? a.botId, state: a.state }))
      : []

    if (action === 'get' || action === 'status') {
      const progress = room.progress ?? { goal: '', items: [], updatedBy: '', updatedAt: '' }
      const total = progress.items.length
      const doneCount = progress.items.filter(i => i.done).length
      const openSubtasks = (room.subtasks ?? []).filter(s => s.status === 'in_progress')
      const readyToFinish = activeTeammates.length === 0
        && openSubtasks.length === 0
        && (total === 0 || doneCount === total)
      return {
        ok: true,
        progress,
        doneCount,
        total,
        openSubtasks,
        activeTeammates,
        readyToFinish,
      }
    }

    let updatedProgress
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored) return
      const now = new Date().toISOString()
      const current = stored.progress ?? { goal: '', items: [], updatedBy: '', updatedAt: '' }
      const goal = typeof input.goal === 'string' && input.goal.trim() !== ''
        ? input.goal.trim()
        : current.goal
      const byId = new Map((current.items ?? []).map(item => [item.id, { ...item }]))
      if (Array.isArray(input.items)) {
        for (const raw of input.items) {
          if (!raw || typeof raw.id !== 'string' || raw.id.trim() === '') continue
          const id = raw.id.trim()
          const prev = byId.get(id)
          byId.set(id, {
            id,
            title: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : (prev?.title ?? id),
            owner: typeof raw.owner === 'string' ? raw.owner.trim() : (prev?.owner ?? callerBot.name),
            done: raw.done === true,
            note: typeof raw.note === 'string' ? raw.note.trim() : (prev?.note ?? ''),
          })
        }
      }
      updatedProgress = {
        goal,
        items: [...byId.values()].slice(0, 40),
        updatedBy: callerBot.name,
        updatedAt: now,
      }
      stored.progress = updatedProgress
      if (stored.budget) stored.budget.idleRounds = 0
      stored.updatedAt = now
    })

    if (bus) {
      bus.roundStats.clear()
      bus.progressReviewDone = false
    }
    const total = updatedProgress?.items?.length ?? 0
    const doneCount = (updatedProgress?.items ?? []).filter(i => i.done).length
    const openSubtasks = (this.store.room(roomId)?.subtasks ?? []).filter(s => s.status === 'in_progress')
    await this.#recordActivity(roomId, {
      kind: 'progress_updated',
      botId: callerBot.id,
      botName: callerBot.name,
      doneCount,
      total,
      epoch: room.epoch ?? 0,
    })
    return {
      ok: true,
      progress: updatedProgress,
      doneCount,
      total,
      openSubtasks,
      activeTeammates,
      readyToFinish: activeTeammates.length === 0 && openSubtasks.length === 0 && (total === 0 || doneCount === total),
    }
  }

  /**
   * Explicit Business Terminal Tool (`room_finish_task`).
   * The ONLY way a Group Room transitions to `completed` (never via chat text regex).
   */
  async finishTask(roomId, callerBot, input = {}) {
    const room = this.store.room(roomId)
    if (!room) return { ok: false, code: 'unknown_room', error: 'Group Room does not exist.' }
    if (!room.memberIds.includes(callerBot.id)) {
      return { ok: false, code: 'not_a_member', error: 'You are not a member of this Group Room.' }
    }
    const summary = String(input.summary ?? '').trim()
    if (summary === '') {
      return { ok: false, code: 'missing_summary', error: 'summary is required to finish the room task.' }
    }
    const deliverables = Array.isArray(input.deliverables)
      ? input.deliverables.map(d => String(d ?? '').trim()).filter(Boolean)
      : []
    const verification = typeof input.verification === 'string' ? input.verification.trim() : ''
    const force = input.force === true

    const members = this.#members(room)
    if (room.mode === 'lead' || (room.leadBotId && room.leadBotId !== '')) {
      const leadId = resolveEffectiveLeadId(room, members)
      if (leadId && callerBot.id !== leadId) {
        const leadName = this.store.bot(leadId)?.name ?? leadId
        return {
          ok: false,
          code: 'not_lead',
          error: `仅验收负责人 @${leadName} 可调用 room_finish_task 结束房间。请先通过 claim_subtask 将你的子任务标为 completed，并在群里 @${leadName} 进行验收。`,
        }
      }
    }

    const unfinishedTeammateTasks = (room.subtasks ?? []).filter(
      t => t.status === 'in_progress' && t.ownerBotId !== '' && t.ownerBotId !== callerBot.id,
    )
    if (unfinishedTeammateTasks.length > 0 && !force) {
      return {
        ok: false,
        code: 'subtasks_in_progress',
        pendingSubtasks: unfinishedTeammateTasks,
        error: `尚有队友负责的子任务处于进行中（${unfinishedTeammateTasks.map(t => `${t.taskId}: @${t.ownerName}`).join(', ')}），请确认验证后再收口，或传入 force: true。`,
      }
    }

    const bus = this.#buses.get(roomId)
    if (bus && !force) {
      const runningTeammates = [...bus.actors.values()]
        .filter(a => a.botId !== callerBot.id && (a.state === 'running' || a.state === 'waiting_approval' || a.state === 'waiting_question'))
        .map(a => this.store.bot(a.botId)?.name ?? a.botId)
      if (runningTeammates.length > 0) {
        return {
          ok: false,
          code: 'teammates_still_running',
          runningTeammates,
          error: `队友（${runningTeammates.map(n => `@${n}`).join(', ')}）仍在并行执行或等待审批中，请先回复 (pass) 等待其产出落盘后再调用 room_finish_task 验收（若确认无需等待可传 force: true）。`,
        }
      }
    }
    if (bus) {
      bus.finished = true
      bus.finishedByBotId = callerBot.id
      bus.active = false
    }

    let completionRecord
    let appendedMsg
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored) return
      const now = new Date().toISOString()
      // Release all active file locks upon formal task completion
      for (const task of stored.subtasks ?? []) {
        if (task.status === 'in_progress' && (force || task.ownerBotId === callerBot.id)) {
          task.status = 'completed'
          task.updatedAt = now
        }
      }
      completionRecord = {
        summary,
        deliverables,
        verification,
        finishedBy: callerBot.id,
        finishedByName: callerBot.name,
        epoch: stored.epoch ?? 0,
        at: now,
      }
      stored.completion = completionRecord
      stored.status = 'completed'
      stored.settledReason = 'task_completed'
      stored.needsYou = false
      stored.pausedReason = ''
      stored.nextSeq = (stored.nextSeq ?? 0) + 1
      const delivSuffix = deliverables.length > 0
        ? `\n交付物：${deliverables.join(', ')}`
        : ''
      appendedMsg = {
        seq: stored.nextSeq,
        id: newId('msg'),
        from: callerBot.id,
        name: callerBot.name,
        text: `[任务已完成] ${summary}${delivSuffix}`,
        kind: 'completion',
        deliverables,
        mentions: [],
        epoch: stored.epoch ?? 0,
        round: stored.budget?.rounds ?? 0,
        at: now,
      }
      stored.transcript.push(appendedMsg)
      stored.transcript = stored.transcript.slice(-MAX_STORED_TRANSCRIPT)
      stored.updatedAt = now
    })

    if (appendedMsg) {
      await this.#archiveEvent(roomId, { type: 'room.completed', ...appendedMsg, completion: completionRecord })
    }
    await this.#recordActivity(roomId, {
      kind: 'completed',
      botId: callerBot.id,
      botName: callerBot.name,
      summary: summary.slice(0, 200),
      deliverables,
      epoch: room.epoch ?? 0,
    })
    this.dispatcher.clearActiveRoom?.(roomId)
    if (this.onDeliverables && deliverables.length > 0) {
      void Promise.resolve(this.onDeliverables({
        room: this.store.room(roomId) || room,
        bot: callerBot,
        deliverables,
        messageId: appendedMsg?.id || '',
        at: completionRecord.at,
      })).catch(() => undefined)
    }
    return { ok: true, status: 'completed', completion: completionRecord }
  }

  /**
   * CAS-capable atomic Room Log append (`appendAtomic`).
   * Assigns a strictly monotonic `seq`, persists to `state.json` + JSONL archive,
   * and returns `{ seq, message, casConflict }`.
   */
  async appendAtomic(roomId, payload, options = {}) {
    let appended
    let casConflict = false
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored) return
      const currentSeq = stored.nextSeq ?? 0
      if (Number.isFinite(options.expectedLatestSeq) && currentSeq !== options.expectedLatestSeq) {
        casConflict = true
      }
      stored.nextSeq = currentSeq + 1
      const rawKind = payload.kind
      const kind = rawKind === 'error' || rawKind === 'system' || rawKind === 'completion'
        ? rawKind
        : 'message'
      appended = {
        seq: stored.nextSeq,
        id: newId('msg'),
        from: payload.from,
        name: payload.name,
        text: payload.text,
        kind,
        mentions: Array.isArray(payload.mentions) ? payload.mentions : [],
        epoch: payload.epoch ?? stored.epoch ?? 0,
        round: payload.round ?? 0,
        at: new Date().toISOString(),
      }
      stored.transcript.push(appended)
      stored.transcript = stored.transcript.slice(-MAX_STORED_TRANSCRIPT)
      if (options.incrementMessages === true) {
        stored.budget.messages = (stored.budget.messages ?? 0) + 1
      }
      if (Number.isFinite(payload.round)) {
        stored.budget.rounds = Math.max(stored.budget.rounds ?? 0, payload.round + 1)
      }
      stored.updatedAt = appended.at
    })
    if (appended) {
      const eventType = appended.kind === 'error'
        ? 'turn.error'
        : appended.kind === 'system'
          ? 'room.system'
          : 'message.member'
      await this.#archiveEvent(roomId, { type: eventType, ...appended })
    }
    return { seq: appended?.seq ?? 0, message: appended, casConflict }
  }

  #ensureBus(roomId, epoch) {
    let bus = this.#buses.get(roomId)
    const room = this.store.room(roomId)
    if (!bus) {
      bus = {
        roomId,
        epoch,
        active: true,
        stopping: false,
        finished: false,
        finishedByBotId: '',
        actors: new Map(),
        roundStats: new Map(), // round -> { textReplies, productiveSignals }
        escalationBot: null,
        softPausePending: null, // { status: 'stalled' | 'capped', reason, round }
        progressReviewDone: false,
        epochErrors: 0,
        epochReplies: 0,
        epochProductiveTurns: 0,
        epochContributors: new Set(),
        heldBotIds: new Set(),
        maxRoundsCap: room?.budget?.maxRounds ?? 0,
        maxMessagesCap: room?.budget?.maxMessages ?? 0,
      }
      this.#buses.set(roomId, bus)
    }
    this.#syncBusActors(bus, room)
    return bus
  }

  #syncBusActors(bus, room) {
    if (!room) return
    const memberSet = new Set(room.memberIds ?? [])
    for (const botId of memberSet) {
      if (!bus.actors.has(botId)) {
        const persistedWatermark = room.watermarks?.[botId] ?? 0
        bus.actors.set(botId, new BotActor(botId, persistedWatermark))
      }
    }
    for (const existingId of [...bus.actors.keys()]) {
      if (!memberSet.has(existingId)) {
        const actor = bus.actors.get(existingId)
        if (actor && actor.state === 'idle') bus.actors.delete(existingId)
      }
    }
  }

  async #hardStopBus(roomId) {
    const room = this.store.room(roomId)
    const bus = this.#buses.get(roomId)
    if (bus) {
      bus.stopping = true
      bus.active = false
      for (const actor of bus.actors.values()) {
        if (actor.sessionId) {
          this.dispatcher.cancelSession?.(actor.sessionId)
        }
      }
      // Detach the stopped bus immediately so any follow-up `send()` creates a fresh
      // bus instance and cannot collide with an in-flight turn's `finally` block.
      this.#buses.delete(roomId)
    }
    if (room?.memberSessions) {
      for (const sessionId of Object.values(room.memberSessions)) {
        if (sessionId) this.dispatcher.cancelSession?.(sessionId)
      }
    }
    this.approvals?.cancelForRoom?.(roomId)
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored || !Array.isArray(stored.subtasks)) return
      const now = new Date().toISOString()
      for (const task of stored.subtasks) {
        if (task.status === 'in_progress') {
          task.status = 'released'
          task.updatedAt = now
        }
      }
    }).catch(() => undefined)
  }

  #onInteractionStateChanged(event) {
    if (!event || !event.roomId) return
    const bus = this.#buses.get(event.roomId)
    if (!bus) return
    const actor = bus.actors.get(event.botId)
    if (!actor || !actor.inTurn) return

    const counts = this.approvals?.pendingCountForBot?.(event.botId, event.roomId) ?? { approvals: 0, questions: 0 }
    if (counts.questions > 0) {
      actor.state = 'waiting_question'
    } else if (counts.approvals > 0) {
      actor.state = 'waiting_approval'
    } else if (actor.state === 'waiting_approval' || actor.state === 'waiting_question') {
      actor.state = 'running'
    }

    void this.#syncWaitingUserRoomStatus(bus)
  }

  async #syncWaitingUserRoomStatus(bus) {
    const room = this.store.room(bus.roomId)
    if (!room || bus.stopping || bus.finished) return
    const actors = [...bus.actors.values()]
    const anyRunning = actors.some(a => a.state === 'running')
    const waitingApproval = actors.find(a => a.state === 'waiting_approval')
    const waitingQuestion = actors.find(a => a.state === 'waiting_question')

    if (!anyRunning && (waitingApproval || waitingQuestion)) {
      const reason = waitingQuestion ? 'question' : 'approval'
      if (room.status !== 'waiting_user' || room.pausedReason !== reason) {
        await this.store.mutate((state) => {
          const stored = state.rooms.find(item => item.id === bus.roomId)
          if (!stored || stored.status === 'completed') return
          stored.status = 'waiting_user'
          stored.needsYou = true
          stored.pausedReason = reason
          stored.updatedAt = new Date().toISOString()
        })
      }
    } else if (anyRunning && room.status === 'waiting_user' && !waitingApproval && !waitingQuestion) {
      await this.store.mutate((state) => {
        const stored = state.rooms.find(item => item.id === bus.roomId)
        if (!stored || stored.status !== 'waiting_user') return
        stored.status = 'running'
        stored.needsYou = false
        stored.pausedReason = ''
        stored.updatedAt = new Date().toISOString()
      })
      this.#notifyBus(bus)
    }
  }

  #notifyBus(bus) {
    const room = this.store.room(bus.roomId)
    if (!room || !bus.active || bus.stopping || bus.finished) return
    this.#syncBusActors(bus, room)
    this.dispatcher.setActiveRoomMembers?.(bus.roomId, room.memberIds)

    for (const actor of bus.actors.values()) {
      if (actor.state === 'idle') {
        void this.#stepActor(bus, actor)
      }
    }
    queueMicrotask(() => {
      void this.#checkConvergence(bus)
    })
  }

  /**
   * Core Event-Driven `BotActor.onRoomUpdated` state machine with Snapshot Watermark
   * Anti-Miss guarantee.
   */
  async #stepActor(bus, actor) {
    if (actor.state !== 'idle' || !bus.active || bus.stopping || bus.finished) return
    if (bus.escalationBot || bus.softPausePending) return

    const liveRoom = this.store.room(bus.roomId)
    if (!liveRoom || liveRoom.status === 'completed') return
    const speaker = this.store.bot(actor.botId)
    if (!speaker || !liveRoom.memberIds.includes(speaker.id)) return

    // 1. Capture snapshotSeq BEFORE launching the turn so concurrent teammate or
    //    human messages arriving during execution are never skipped!
    const snapshotSeq = liveRoom.nextSeq ?? 0
    const watermark = Math.max(actor.watermark, liveRoom.watermarks?.[speaker.id] ?? 0)
    actor.watermark = watermark

    const unreadItems = (liveRoom.transcript ?? []).filter(
      item => Number.isFinite(item.seq)
        && item.seq > watermark
        && item.seq <= snapshotSeq
        && !actor.selfSentSeqs.has(item.seq)
        && item.from !== speaker.id,
    )

    const forcedContinue = actor.forceContinueTurn === true
    const forcedProgressReview = actor.forceProgressReview === true
    if (unreadItems.length === 0 && !forcedContinue && !forcedProgressReview) {
      if (snapshotSeq > actor.watermark) {
        actor.watermark = snapshotSeq
        await this.#advanceWatermark(bus.roomId, speaker.id, snapshotSeq)
      }
      return
    }

    const members = this.#members(liveRoom)
    const pausedBotIds = new Set(
      [...bus.actors.values()].filter(a => a.state === 'paused_error').map(a => a.botId),
    )

    // 2. Hermes Zero-Token Epoch-Scoped Routing Filter:
    //    - Inspects ONLY current-epoch messages for routing so stale @mentions from
    //      earlier epochs can NEVER wake unaddressed Bots when a user solo-@s one Bot!
    //    - Leaves unaddressed peers' watermarks INTACT (Hermes invariant) so if they
    //      are cited later, they still receive the full bounded delta without missing a beat.
    const epochMessages = (liveRoom.transcript ?? []).filter(
      item => (Number(item.epoch) || 0) === bus.epoch && item.seq <= snapshotSeq,
    )
    let route
    if (forcedProgressReview) {
      route = { shouldRespond: true, directed: true, replyRequired: false, mentionedBy: '', triggerReason: 'progress_review', advanceWatermark: true }
    } else if (forcedContinue) {
      route = { shouldRespond: true, directed: false, replyRequired: false, mentionedBy: '', triggerReason: 'continued', advanceWatermark: true }
    } else {
      route = evaluateActorDelta({
        room: liveRoom,
        actorBotId: speaker.id,
        members,
        deltaItems: unreadItems,
        pausedBotIds,
        heldBotIds: bus.heldBotIds,
        currentEpoch: bus.epoch,
        epochMessages,
        hasActedInEpoch: actor.actedEpoch === bus.epoch,
        lastActedSeq: actor.actedEpoch === bus.epoch ? actor.lastActedSeq : 0,
      })
    }
    actor.forceContinueTurn = false
    actor.forceProgressReview = false

    if (!route.shouldRespond) {
      if (route.advanceWatermark === true && snapshotSeq > actor.watermark) {
        actor.watermark = snapshotSeq
        await this.#advanceWatermark(bus.roomId, speaker.id, snapshotSeq)
      }
      await this.#checkConvergence(bus)
      return
    }

    // Compute causal wave/round depth within the current epoch
    let turnRound = 0
    for (const item of unreadItems) {
      if (item.from !== 'user' && item.epoch === bus.epoch) {
        turnRound = Math.max(turnRound, (Number(item.round) || 0) + 1)
      }
    }

    // Optional soft caps (`maxMessages` / `maxRounds` when explicitly configured > 0)
    if (bus.maxMessagesCap > 0 && (liveRoom.budget?.messages ?? 0) >= bus.maxMessagesCap) {
      bus.softPausePending = { status: 'capped', reason: 'max_messages', round: turnRound }
      await this.#checkConvergence(bus)
      return
    }
    if (bus.maxRoundsCap > 0 && turnRound >= bus.maxRoundsCap) {
      bus.softPausePending = { status: 'capped', reason: 'max_rounds', round: bus.maxRoundsCap }
      await this.#checkConvergence(bus)
      return
    }

    // Prepare filtered delta lines for prompt injection
    const filteredTranscript = (liveRoom.transcript ?? []).filter(
      item => !actor.selfSentSeqs.has(item.seq) && item.from !== speaker.id,
    )
    const delta = selectDeltaMessages(filteredTranscript, watermark, snapshotSeq)
    const prompt = buildRoomTurnPrompt({
      room: liveRoom,
      speaker,
      members,
      delta,
      round: turnRound,
      directed: route.directed,
      replyRequired: route.replyRequired === true,
      triggerReason: route.triggerReason,
      mentionedBy: route.mentionedBy,
    })

    const turnEpoch = bus.epoch
    const runToken = ++actor.activeRunToken
    actor.inTurn = true
    actor.state = 'running'
    actor.turnEpoch = turnEpoch
    actor.startedAt = new Date().toISOString()

    try {
      const memoryQuery = delta.lines.slice(-3).join('\n') || liveRoom.purpose || liveRoom.name
      let result = await this.dispatcher.enqueue(speaker.id, prompt, {
        source: 'room',
        roomId: bus.roomId,
        memoryQuery,
        memoryUserText: delta.lines.join('\n') || liveRoom.name,
        onSessionResolved: (sessionId) => {
          if (actor.activeRunToken !== runToken) return
          actor.sessionId = sessionId
          const counts = this.approvals?.pendingCountForBot?.(speaker.id, bus.roomId)
          if (counts?.questions > 0) actor.state = 'waiting_question'
          else if (counts?.approvals > 0) actor.state = 'waiting_approval'
        },
      })

      // Record consumed tokens BEFORE checking `bus.stopping` so stopped turns never drop billing telemetry.
      const initialTokens = Number(result.metrics?.tokensUsed) || 0
      if (initialTokens > 0 && this.store.room(bus.roomId)) {
        await this.#recordTokensAndCheckBudget(bus, initialTokens, turnRound)
      }

      if (bus.stopping || this.#buses.get(bus.roomId) !== bus) return
      let afterRoom = this.store.room(bus.roomId)
      if (!afterRoom || !afterRoom.memberIds.includes(speaker.id)) return

      // Hermes Direct-Address Nudge: if the user explicitly `@mentioned` this Bot in Round 0
      // (`replyRequired`) and it returned `(pass)`, nudge it once so direct addresses never drop silently.
      if (
        result.ok
        && route.replyRequired === true
        && isPassReply(result.text)
        && afterRoom.epoch === turnEpoch
        && afterRoom.status !== 'completed'
        && !bus.finished
      ) {
        result = await this.dispatcher.enqueue(speaker.id, `${prompt}\n${GROUP_ADDRESSED_NUDGE_SUFFIX}`, {
          source: 'room',
          roomId: bus.roomId,
          memoryQuery,
          memoryUserText: delta.lines.join('\n') || liveRoom.name,
          onSessionResolved: (sessionId) => {
            if (actor.activeRunToken !== runToken) return
            actor.sessionId = sessionId
          },
        })
        const nudgeTokens = Number(result.metrics?.tokensUsed) || 0
        if (nudgeTokens > 0 && this.store.room(bus.roomId)) {
          await this.#recordTokensAndCheckBudget(bus, nudgeTokens, turnRound)
        }
        if (bus.stopping || this.#buses.get(bus.roomId) !== bus) return
        afterRoom = this.store.room(bus.roomId)
        if (!afterRoom || !afterRoom.memberIds.includes(speaker.id)) return
      }

      // Epoch Fence (Soft Steer): if the human sent a newer epoch while this Bot was
      // mid-turn, advance watermark ONLY to `snapshotSeq` (so the new human message is
      // read immediately next!) and fence out stale pre-steer @mentions/replies.
      if (afterRoom.epoch !== turnEpoch || bus.epoch !== turnEpoch) {
        actor.watermark = snapshotSeq
        await this.#advanceWatermark(bus.roomId, speaker.id, snapshotSeq)
        await this.#recordActivity(bus.roomId, {
          kind: 'superseded_turn',
          botId: speaker.id,
          botName: speaker.name,
          epoch: turnEpoch,
          reason: 'soft_steered',
        })
        return
      }

      // If `room_finish_task` was executed inside this turn, preserve the finisher's
      // full report message in the transcript before closing cleanly.
      if (afterRoom.status === 'completed' || bus.finished) {
        const finalText = result.ok ? String(result.text ?? '').trim() : ''
        if (bus.finishedByBotId === speaker.id && finalText !== '' && !isPassReply(finalText)) {
          const committed = await this.appendAtomic(bus.roomId, {
            from: speaker.id,
            name: speaker.name,
            text: finalText,
            kind: 'message',
            mentions: [],
            epoch: turnEpoch,
            round: turnRound,
          })
          if (committed.seq > 0) actor.selfSentSeqs.add(committed.seq)
        }
        actor.watermark = snapshotSeq
        await this.#advanceWatermark(bus.roomId, speaker.id, snapshotSeq)
        return
      }

      // Probe 2: Per-Bot Repeated Error Fingerprint (`MAX_REPEAT_ERRORS = 3`)
      const errorProbeEnabled = this.store.state?.settings?.groupChat?.enableErrorProbe !== false
      const errPrints = result.metrics?.errorFingerprints ?? []
      if (!result.ok || errPrints.length > 0) {
        const hitFault = errorProbeEnabled ? this.#updateBotErrorStreak(actor, errPrints, result.error) : false
        if (!result.ok) {
          bus.epochErrors = (bus.epochErrors ?? 0) + 1
          actor.watermark = snapshotSeq
          actor.actedEpoch = turnEpoch
          actor.lastActedSeq = Math.max(actor.lastActedSeq, snapshotSeq)
          await this.#advanceWatermark(bus.roomId, speaker.id, snapshotSeq)
          await this.appendAtomic(bus.roomId, {
            from: speaker.id,
            name: `${speaker.name} (error)`,
            text: result.error,
            kind: 'error',
            epoch: turnEpoch,
            round: turnRound,
          })
          await this.#recordActivity(bus.roomId, {
            kind: 'error',
            botId: speaker.id,
            botName: speaker.name,
            round: turnRound,
            epoch: turnEpoch,
            reason: result.error,
          })
          if (hitFault) {
            await this.#pauseFaultingActor(bus, actor, speaker, turnEpoch, turnRound)
          }
          return
        }
        if (hitFault) {
          actor.watermark = snapshotSeq
          await this.#advanceWatermark(bus.roomId, speaker.id, snapshotSeq)
          await this.#pauseFaultingActor(bus, actor, speaker, turnEpoch, turnRound)
          return
        }
      } else {
        actor.errorStreak = { fingerprint: '', count: 0, lastSummary: '' }
      }

      // Track productive tool/file/task signals for Probe 1 (`idle_spin`)
      const hasProductiveWork = (result.metrics?.toolCallCount ?? 0) > 0
        || (result.metrics?.mutatedFilesCount ?? 0) > 0
        || result.metrics?.taskBoardChanged === true
      if (hasProductiveWork) {
        bus.epochProductiveTurns = (bus.epochProductiveTurns ?? 0) + 1
      }
      this.#recordRoundSignal(bus, turnRound, { productive: hasProductiveWork, spokeText: false })

      const text = String(result.text ?? '').trim()
      if (isPassReply(text)) {
        actor.watermark = snapshotSeq
        actor.actedEpoch = turnEpoch
        actor.lastActedSeq = Math.max(actor.lastActedSeq, snapshotSeq)
        await this.#advanceWatermark(bus.roomId, speaker.id, snapshotSeq)
        await this.#recordActivity(bus.roomId, {
          kind: 'passed',
          botId: speaker.id,
          botName: speaker.name,
          round: turnRound,
          epoch: turnEpoch,
        })
        return
      }

      // Parse safe directive `@mentions` (for member messages, tables & role-reference parentheses are excluded!)
      const latestMembers = this.#members(this.store.room(bus.roomId) ?? afterRoom)
      const mentions = parseMentions(text, latestMembers, speaker.id, { isMemberMessage: true })

      // 4. Commit substantive reply atomically in Arrival Order
      const committed = await this.appendAtomic(bus.roomId, {
        from: speaker.id,
        name: speaker.name,
        text,
        kind: 'message',
        mentions: mentions.botIds,
        epoch: turnEpoch,
        round: turnRound,
      }, {
        expectedLatestSeq: snapshotSeq,
        incrementMessages: true,
      })

      if (committed.seq > 0) {
        actor.selfSentSeqs.add(committed.seq)
      }
      bus.epochReplies = (bus.epochReplies ?? 0) + 1
      bus.epochContributors?.add?.(speaker.id)
      // If a Bot generated substantive new progress after an earlier review, allow a future acceptance review.
      if (route.triggerReason !== 'progress_review' && (hasProductiveWork || mentions.botIds.length > 0)) {
        bus.progressReviewDone = false
      }

      // 5. CRITICAL WATERMARK INVARIANT:
      // Advance watermark & `lastActedSeq` strictly to `snapshotSeq` (or `committed.seq`
      // ONLY when zero concurrent messages arrived in `(snapshotSeq, committed.seq)`),
      // NEVER jumping over concurrent replies from teammates!
      const nextWatermark = committed.seq === snapshotSeq + 1 ? committed.seq : snapshotSeq
      actor.watermark = nextWatermark
      actor.actedEpoch = turnEpoch
      actor.lastActedSeq = Math.max(actor.lastActedSeq, nextWatermark)
      await this.#advanceWatermark(bus.roomId, speaker.id, nextWatermark)

      // Update Probe 1 (`idle_spin`): check consecutive pure-text tool-free rounds
      this.#recordRoundSignal(bus, turnRound, { productive: hasProductiveWork, spokeText: true })
      await this.#evaluateIdleSpinProbe(bus, turnRound)

      // Check explicit `@user` / `@你` human escalation (`waiting_user`).
      // IMPORTANT: If the Bot ALSO @mentioned teammates (`mentions.botIds.length > 0`),
      // keep autonomous peer-to-peer collaboration running instead of freezing the room!
      if (hasUserEscalation(text) && mentions.botIds.length === 0) {
        bus.escalationBot = speaker
      }

      // Check optional `maxMessages` cap if configured
      const updatedRoom = this.store.room(bus.roomId)
      if (bus.maxMessagesCap > 0 && (updatedRoom?.budget?.messages ?? 0) >= bus.maxMessagesCap) {
        bus.softPausePending = { status: 'capped', reason: 'max_messages', round: turnRound + 1 }
      }

      // Wake other idle actors immediately on the new message (unless pausing/escalating)
      if (!bus.escalationBot && !bus.softPausePending && !bus.finished) {
        for (const peer of bus.actors.values()) {
          if (peer.botId !== actor.botId && peer.state === 'idle') {
            queueMicrotask(() => { void this.#stepActor(bus, peer) })
          }
        }
      }
    } catch (error) {
      this.logger?.warn?.(`botmode: actor ${speaker.name} in room ${bus.roomId} failed: ${String(error)}`)
    } finally {
      if (actor.activeRunToken !== runToken || this.#buses.get(bus.roomId) !== bus) {
        return
      }
      actor.inTurn = false
      actor.sessionId = ''
      actor.startedAt = ''
      if (actor.state !== 'paused_error') {
        actor.state = 'idle'
      }

      // 6. Self-driving loop: check if new actionable messages (Soft Steer or peer @mention) arrived while busy!
      const currentRoom = this.store.room(bus.roomId)
      const latestSeq = currentRoom?.nextSeq ?? 0
      let shouldStepAgain = false
      if (
        !bus.stopping
        && !bus.finished
        && bus.active
        && actor.state === 'idle'
        && !bus.escalationBot
        && !bus.softPausePending
        && currentRoom
      ) {
        const moreUnread = (currentRoom.transcript ?? []).filter(
          m => m.seq > actor.watermark && m.seq <= latestSeq && !actor.selfSentSeqs.has(m.seq) && m.from !== actor.botId,
        )
        if (moreUnread.length > 0) {
          const curMembers = this.#members(currentRoom)
          const curPaused = new Set([...bus.actors.values()].filter(a => a.state === 'paused_error').map(a => a.botId))
          const curEpochMsgs = (currentRoom.transcript ?? []).filter(
            item => (Number(item.epoch) || 0) === bus.epoch && item.seq <= latestSeq,
          )
          const nextRoute = evaluateActorDelta({
            room: currentRoom,
            actorBotId: actor.botId,
            members: curMembers,
            deltaItems: moreUnread,
            pausedBotIds: curPaused,
            heldBotIds: bus.heldBotIds,
            currentEpoch: bus.epoch,
            epochMessages: curEpochMsgs,
            hasActedInEpoch: actor.actedEpoch === bus.epoch,
            lastActedSeq: actor.actedEpoch === bus.epoch ? actor.lastActedSeq : 0,
          })
          shouldStepAgain = nextRoute.shouldRespond
        }
      }

      if (shouldStepAgain) {
        queueMicrotask(() => { void this.#stepActor(bus, actor) })
      } else {
        queueMicrotask(() => { void this.#checkConvergence(bus) })
      }
    }
  }

  #updateBotErrorStreak(actor, errPrints, turnError = '') {
    const entries = errPrints.length > 0
      ? errPrints
      : [{ fingerprint: 'turn_err', summary: String(turnError || 'error') }]
    for (const item of entries) {
      if (actor.errorStreak.fingerprint === item.fingerprint) {
        actor.errorStreak.count += 1
        actor.errorStreak.lastSummary = item.summary
      } else {
        actor.errorStreak = {
          fingerprint: item.fingerprint,
          count: 1,
          lastSummary: item.summary,
        }
      }
      if (actor.errorStreak.count >= MAX_REPEAT_ERRORS) {
        return true
      }
    }
    return false
  }

  async #pauseFaultingActor(bus, actor, speaker, epoch, round) {
    actor.state = 'paused_error'
    actor.pausedError = actor.errorStreak.lastSummary || 'repeated error'
    // Release any file locks held by the faulting Bot so teammates can step in immediately.
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === bus.roomId)
      if (!stored || !Array.isArray(stored.subtasks)) return
      const now = new Date().toISOString()
      for (const task of stored.subtasks) {
        if (task.ownerBotId === speaker.id && task.status === 'in_progress') {
          task.status = 'released'
          task.updatedAt = now
        }
      }
    }).catch(() => undefined)
    await this.#recordActivity(bus.roomId, {
      kind: 'bot_paused_error',
      botId: speaker.id,
      botName: speaker.name,
      round,
      epoch,
      reason: actor.pausedError,
    })
    const helpMsg = `[异常探针 · 局部暂停] 成员 \`@${speaker.name}\` 连续 ${MAX_REPEAT_ERRORS} 次触发相同错误特征（${actor.pausedError}），已仅暂停该成员以拦截死循环。请群内其他成员介入排障或调整方案；若需人类协助请显式回复「@user」。`
    await this.appendAtomic(bus.roomId, {
      from: 'system',
      name: 'System',
      text: helpMsg,
      kind: 'system',
      epoch,
      round,
    })
    // Notify healthy idle teammates so they can step in immediately!
    for (const peer of bus.actors.values()) {
      if (peer.botId !== actor.botId && peer.state === 'idle') {
        queueMicrotask(() => { void this.#stepActor(bus, peer) })
      }
    }
  }

  #recordRoundSignal(bus, round, { productive, spokeText }) {
    let stat = bus.roundStats.get(round)
    if (!stat) {
      stat = { textReplies: 0, productiveSignals: 0 }
      bus.roundStats.set(round, stat)
    }
    if (productive) stat.productiveSignals += 1
    if (spokeText) stat.textReplies += 1
  }

  async #evaluateIdleSpinProbe(bus, upToRound) {
    const room = this.store.room(bus.roomId)
    if (!room) return
    const idleLimit = room.budget?.idleRoundLimit ?? DEFAULT_IDLE_ROUND_LIMIT
    let consecutiveIdle = 0
    for (let r = 0; r <= upToRound; r += 1) {
      const stat = bus.roundStats.get(r)
      if (!stat) continue
      if (stat.productiveSignals > 0) {
        consecutiveIdle = 0
      } else if (stat.textReplies > 0) {
        consecutiveIdle += 1
      }
    }
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === bus.roomId)
      if (stored?.budget) stored.budget.idleRounds = consecutiveIdle
    })
    if (consecutiveIdle >= idleLimit && !bus.softPausePending) {
      bus.softPausePending = { status: 'stalled', reason: 'idle_spin', round: upToRound + 1 }
    }
  }

  async #recordTokensAndCheckBudget(bus, tokensDelta, round) {
    let hitBudget = false
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === bus.roomId)
      if (!stored?.budget) return
      stored.budget.tokensUsed = (stored.budget.tokensUsed ?? 0) + tokensDelta
      const limit = stored.budget.tokenLimit ?? 0
      const checkpoint = stored.budget.tokenCheckpoint ?? limit
      if (limit > 0 && checkpoint > 0 && stored.budget.tokensUsed >= checkpoint) {
        hitBudget = true
      }
    })
    if (hitBudget && !bus.softPausePending) {
      bus.softPausePending = { status: 'stalled', reason: 'token_budget', round: round + 1 }
    }
  }

  /**
   * Global Convergence & Suspension Checker (`bus.checkConvergence()`):
   * - Treats `running`, `waiting_approval`, and `waiting_question` as active non-settled states!
   * - Applies pending `@user` escalations, soft-pause probes (`idle_spin`, `token_budget`, `capped`),
   *   or Hermes silent convergence (`settled`) only after all running turns drain cleanly.
   */
  async #checkConvergence(bus) {
    if (!bus.active || bus.stopping || bus.finished) return
    const room = this.store.room(bus.roomId)
    if (!room || room.status === 'completed') return

    const actors = [...bus.actors.values()]
    const anyRunning = actors.some(a => a.state === 'running')
    if (anyRunning) return

    // If any idle actor still has a pending forced continuation or progress review, wake it first!
    const forcedActor = actors.find(a => a.state === 'idle' && (a.forceContinueTurn || a.forceProgressReview))
    if (forcedActor) {
      void this.#stepActor(bus, forcedActor)
      return
    }

    // 1. Human approval or question pending -> suspend locally as `waiting_user`, NEVER settle!
    const waitingHuman = actors.find(a => a.state === 'waiting_approval' || a.state === 'waiting_question')
    if (waitingHuman) {
      await this.#syncWaitingUserRoomStatus(bus)
      return
    }

    // 2. Explicit `@user` escalation triggered
    if (bus.escalationBot) {
      const speaker = bus.escalationBot
      bus.escalationBot = null
      bus.active = false
      this.dispatcher.clearActiveRoom?.(bus.roomId)
      await this.#markWaitingUser(bus.roomId, bus.epoch, room.budget?.rounds ?? 0, 'mention', speaker)
      return
    }

    // 3. Soft-pause probe or optional cap triggered (`stalled` / `capped`)
    if (bus.softPausePending) {
      const pause = bus.softPausePending
      bus.softPausePending = null
      bus.active = false
      this.dispatcher.clearActiveRoom?.(bus.roomId)
      if (pause.status === 'capped') {
        await this.#markCapped(bus.roomId, bus.epoch, pause.round, pause.reason)
      } else {
        await this.#markStalled(bus.roomId, bus.epoch, pause.round, pause.reason)
      }
      return
    }

    // 4. Check if any healthy idle actor still has unread actionable messages in the current epoch
    const latestSeq = room.nextSeq ?? 0
    const members = this.#members(room)
    const pausedBotIds = new Set(actors.filter(a => a.state === 'paused_error').map(a => a.botId))
    const epochMessages = (room.transcript ?? []).filter(
      item => (Number(item.epoch) || 0) === bus.epoch && item.seq <= latestSeq,
    )

    for (const actor of actors) {
      if (actor.state !== 'idle') continue
      const unread = (room.transcript ?? []).filter(
        m => m.seq > actor.watermark && m.seq <= latestSeq && !actor.selfSentSeqs.has(m.seq) && m.from !== actor.botId,
      )
      if (unread.length === 0) continue
      const route = evaluateActorDelta({
        room,
        actorBotId: actor.botId,
        members,
        deltaItems: unread,
        pausedBotIds,
        heldBotIds: bus.heldBotIds,
        currentEpoch: bus.epoch,
        epochMessages,
        hasActedInEpoch: actor.actedEpoch === bus.epoch,
        lastActedSeq: actor.actedEpoch === bus.epoch ? actor.lastActedSeq : 0,
      })
      if (route.shouldRespond) {
        // Wake this idle actor instead of settling prematurely!
        void this.#stepActor(bus, actor)
        return
      }
      // Hermes invariant: keep unaddressed members' watermarks intact so a later @mention
      // still delivers the complete unread delta!
      if (route.advanceWatermark === true && latestSeq > actor.watermark) {
        actor.watermark = latestSeq
        await this.#advanceWatermark(bus.roomId, actor.botId, latestSeq)
      }
    }

    // Re-check bus liveness after awaits to prevent duplicate settlement races.
    if (!bus.active || bus.stopping || bus.finished || this.#buses.get(bus.roomId) !== bus) return
    if ([...bus.actors.values()].some(a => a.state === 'running' || a.state === 'waiting_approval' || a.state === 'waiting_question')) return

    // 5. All running work drained and zero unread actionable deltas remain!

    // 5a. Autonomous Progress Review (`room-completion` skill):
    // Triggered ONLY for substantive multi-Bot tasks (open progress checklist, active subtasks,
    // or multi-Bot productive tool/file turns) — NEVER for simple greetings, introductions, or
    // solo `@Bot` Q&A, which settle cleanly right away!
    const autoReviewEnabled = this.store.state?.settings?.groupChat?.autoProgressReview !== false
    const hasOpenChecklist = (room.progress?.items ?? []).some(item => !item.done)
    const hasActiveSubtasks = (room.subtasks ?? []).some(t => t.status === 'in_progress')
    const hasMultiBotTaskWork = Boolean(
      room.leadBotId
      && (bus.epochContributors?.size ?? 0) >= 2
      && ((bus.epochProductiveTurns ?? 0) > 0 || (room.progress?.items?.length ?? 0) > 0 || hasActiveSubtasks),
    )
    if (
      autoReviewEnabled
      && !bus.progressReviewDone
      && (bus.epochErrors ?? 0) === 0
      && (hasOpenChecklist || hasMultiBotTaskWork)
    ) {
      const reviewerId = resolveEffectiveLeadId(room, members)
      const reviewer = reviewerId ? bus.actors.get(reviewerId) : undefined
      if (reviewer && reviewer.state === 'idle' && !bus.heldBotIds.has(reviewerId)) {
        bus.progressReviewDone = true
        reviewer.forceProgressReview = true
        void this.#stepActor(bus, reviewer)
        return
      }
    }

    bus.active = false
    this.dispatcher.clearActiveRoom?.(bus.roomId)

    // Never disguise an epoch with unresolved turn errors (either all-error or broken handoff) as `settled`!
    if ((bus.epochErrors ?? 0) > 0) {
      await this.#markStalled(bus.roomId, bus.epoch, room.budget?.rounds ?? 0, 'turn_error')
      return
    }

    // If any Bot was fault-paused (`paused_error`) and teammates couldn't complete the task,
    // surface `stalled` (`bot_error`) so the human knows intervention is needed.
    if (pausedBotIds.size > 0) {
      await this.#markStalled(bus.roomId, bus.epoch, room.budget?.rounds ?? 0, 'bot_error')
      return
    }

    // Determine natural settlement reason (`no_mentions` in `lead` mode when Lead closed without @mention, else `silent_round`)
    let settledReason = 'silent_round'
    if (members.length === 0) {
      settledReason = 'empty_roster'
    } else if (room.mode === 'lead') {
      const lastMsg = [...(room.transcript ?? [])].reverse().find(m => m.kind === 'message')
      const leadId = resolveEffectiveLeadId(room, members)
      if (lastMsg && lastMsg.from === leadId && (lastMsg.mentions?.length ?? 0) === 0) {
        const passedInThisEpoch = (room.activity ?? []).some(a => a.epoch === bus.epoch && a.kind === 'passed')
        if (!passedInThisEpoch) settledReason = 'no_mentions'
      }
    }

    await this.#markSettled(bus.roomId, bus.epoch, settledReason)
  }

  #members(room) {
    return (room.memberIds ?? []).map(id => this.store.bot(id)).filter(Boolean)
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
      if (!stored || stored.epoch !== epoch || stored.status === 'completed') return
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
      if (!stored || stored.epoch !== epoch || stored.status === 'completed') return
      stored.status = 'capped'
      stored.settledReason = ''
      stored.needsYou = true
      stored.pausedReason = 'budget'
      stored.budget.rounds = Math.max(stored.budget.rounds ?? 0, rounds)
      stored.updatedAt = new Date().toISOString()
    })
  }

  async #markStalled(roomId, epoch, rounds, reason) {
    await this.#recordActivity(roomId, { kind: 'stalled', epoch, round: rounds, reason })
    await this.store.mutate((state) => {
      const stored = state.rooms.find(item => item.id === roomId)
      if (!stored || stored.epoch !== epoch || stored.status === 'completed') return
      stored.status = 'stalled'
      stored.settledReason = ''
      stored.needsYou = true
      stored.pausedReason = reason
      stored.budget.rounds = Math.max(stored.budget.rounds ?? 0, rounds)
      stored.updatedAt = new Date().toISOString()
    })
  }

  async #markWaitingUser(roomId, epoch, round, reason, speaker) {
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
      if (!stored || stored.epoch !== epoch || stored.status === 'completed') return
      stored.status = 'waiting_user'
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
