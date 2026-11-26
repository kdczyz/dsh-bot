/**
 * Approval & Human-Question bridge for Bot Sessions (primary & Group Rooms).
 *
 * A Bot runs in a Session the Harness UI never shows directly (especially hidden
 * Group Room sessions), so composed UI answerers cannot reach the human without
 * a broker. This broker intercepts both:
 *   1. `approval/request` -> tool permission approvals (`once / session / always / deny`)
 *   2. `user-questions/request` -> `ask_user_question` interactive prompts
 *
 * Group Room requests suspend ONLY the calling Bot branch (`waiting_approval` /
 * `waiting_question`) without timing out prematurely after 2 minutes, while
 * primary 1:1/Routine sessions keep a 2-minute unattended safety timeout.
 */
import { randomUUID } from 'node:crypto'

const PRIMARY_DECISION_TIMEOUT_MS = 2 * 60 * 1000

export class Approvals {
  #pending = new Map()
  #questions = new Map()
  #screenHelps = new Map()
  #sessionGrants = new Set()
  #listeners = new Set()

  constructor(store, logger) {
    this.store = store
    this.logger = logger
  }

  /** Subscribe to `(event) => void` for real-time BotActor state transitions. */
  onChange(listener) {
    if (typeof listener !== 'function') return () => {}
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #emit(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (_error) {
        /* listener errors must never break approval resolution */
      }
    }
  }

  list() {
    return [...this.#pending.values()].map(item => ({
      id: item.id,
      botId: item.botId,
      botName: item.botName,
      roomId: item.roomId || '',
      toolName: item.toolName,
      callId: item.callId,
      reason: item.reason,
      createdAt: item.createdAt,
    }))
  }

  listQuestions() {
    return [...this.#questions.values()].map(item => ({
      id: item.id,
      botId: item.botId,
      botName: item.botName,
      roomId: item.roomId || '',
      callId: item.callId || '',
      questions: item.questions,
      createdAt: item.createdAt,
    }))
  }

  listScreenHelps() {
    return [...this.#screenHelps.values()].map(item => ({
      id: item.id,
      botId: item.botId,
      botName: item.botName,
      roomId: item.roomId || '',
      category: item.category,
      reason: item.reason,
      previewDataUrl: item.previewDataUrl || '',
      state: item.state || 'NEED_HUMAN',
      createdAt: item.createdAt,
    }))
  }

  pendingCountForBot(botId, roomId = '') {
    let approvals = 0
    let questions = 0
    let screenHelps = 0
    for (const item of this.#pending.values()) {
      if (item.botId === botId && (roomId === '' || item.roomId === roomId)) approvals += 1
    }
    for (const item of this.#questions.values()) {
      if (item.botId === botId && (roomId === '' || item.roomId === roomId)) questions += 1
    }
    for (const item of this.#screenHelps.values()) {
      if (item.botId === botId && (roomId === '' || item.roomId === roomId)) screenHelps += 1
    }
    return { approvals, questions, screenHelps, total: approvals + questions + screenHelps }
  }

  /** Answer one tool approval request belonging to a Bot Session. */
  ask(bot, request, meta = {}) {
    const roomId = typeof meta.roomId === 'string' ? meta.roomId : ''
    const toolName = String(request?.toolName ?? 'tool')
    const sessionId = typeof meta.sessionId === 'string' && meta.sessionId !== ''
      ? meta.sessionId
      : (request?.agent?.session?.id ?? (roomId !== '' ? `room:${roomId}:${bot.id}` : (bot.sessionId || `bot:${bot.id}`)))
    const grantKey = `${sessionId}:${toolName}`
    if (bot.approvalPolicy === 'always' && roomId === '') return 'allowed-once'
    if (roomId === '' && this.#sessionGrants.has(grantKey)) return 'allowed-once'
    if (bot.approvalPolicy === 'never') return 'rejected'

    const id = `ap_${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const timeoutMs = Number.isFinite(meta.timeoutMs)
      ? meta.timeoutMs
      : (roomId !== '' ? 0 : PRIMARY_DECISION_TIMEOUT_MS)

    return new Promise((resolve) => {
      let timer = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id)
          this.logger?.warn?.(`botmode: approval ${id} for ${bot.name} timed out`)
          this.#emit({ kind: 'approval_settled', id, botId: bot.id, roomId, outcome: 'timeout' })
          resolve('rejected')
        }, timeoutMs)
        timer.unref?.()
      }

      this.#pending.set(id, {
        id,
        botId: bot.id,
        botName: bot.name,
        roomId,
        sessionId,
        toolName,
        callId: request?.callId,
        reason: typeof request?.reason === 'string' ? request.reason : '',
        createdAt: new Date().toISOString(),
        settle: (value) => {
          if (timer) clearTimeout(timer)
          if (!this.#pending.has(id)) return
          this.#pending.delete(id)
          this.#emit({ kind: 'approval_settled', id, botId: bot.id, roomId, outcome: value })
          resolve(value)
        },
      })

      this.#emit({ kind: 'approval_pending', id, botId: bot.id, roomId, toolName })

      request?.signal?.addEventListener?.('abort', () => {
        const entry = this.#pending.get(id)
        if (entry) entry.settle('cancelled')
      }, { once: true })
    })
  }

  /**
   * Bridge a `user-questions/request` (`ask_user_question`) call for a Bot Session.
   * Suspends only the calling Bot until the human answers in the Bot Mode UI.
   */
  askQuestion(bot, request, meta = {}) {
    const roomId = typeof meta.roomId === 'string' ? meta.roomId : ''
    const rawQuestions = Array.isArray(request?.questions) ? request.questions : []
    const questions = rawQuestions.map((q, idx) => ({
      id: typeof q.id === 'string' && q.id !== '' ? q.id : `q_${idx + 1}`,
      header: typeof q.header === 'string' ? q.header : '',
      question: String(q.question ?? ''),
      detail: typeof q.detail === 'string' ? q.detail : '',
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? q.options.map(opt => ({
          label: String(opt.label ?? ''),
          description: typeof opt.description === 'string' ? opt.description : '',
        })).filter(opt => opt.label !== '')
        : [],
    }))

    const id = `uq_${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const callId = String(request?.wait?.callId ?? request?.callId ?? '')
    const timeoutMs = Number.isFinite(meta.timeoutMs)
      ? meta.timeoutMs
      : (roomId !== '' ? 0 : PRIMARY_DECISION_TIMEOUT_MS)

    return new Promise((resolve, reject) => {
      let timer = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const entry = this.#questions.get(id)
          if (entry) {
            const timeoutErr = new Error('ask_user_question timed out waiting for user answer')
            timeoutErr.name = 'UserQuestionError'
            timeoutErr.code = 'ASK_ABORTED'
            entry.settle(null, timeoutErr)
          }
        }, timeoutMs)
        timer.unref?.()
      }

      this.#questions.set(id, {
        id,
        botId: bot.id,
        botName: bot.name,
        roomId,
        callId,
        questions,
        createdAt: new Date().toISOString(),
        settle: (answerPayload, err = null) => {
          if (timer) clearTimeout(timer)
          if (!this.#questions.has(id)) return
          this.#questions.delete(id)
          this.#emit({
            kind: 'question_settled',
            id,
            botId: bot.id,
            roomId,
            outcome: err ? 'cancelled' : 'answered',
          })
          if (err) reject(err)
          else resolve(answerPayload)
        },
      })

      this.#emit({ kind: 'question_pending', id, botId: bot.id, roomId, questions })

      request?.signal?.addEventListener?.('abort', () => {
        const entry = this.#questions.get(id)
        if (entry) {
          const abortErr = new Error('ask_user_question was aborted before the user answered')
          abortErr.name = 'UserQuestionError'
          abortErr.code = 'ASK_ABORTED'
          entry.settle(null, abortErr)
        }
      }, { once: true })
    })
  }

  /**
   * Apply a human decision to a pending tool approval.
   * Aligned with Hermes Hosted Rooms: Group Room approvals are strictly limited
   * to `once | deny` so room actions never widen a Bot's standing permissions.
   * @param id - pending request id.
   * @param decision - once | session | always | deny.
   */
  async decide(id, decision) {
    const entry = this.#pending.get(id)
    if (!entry) throw new Error('This approval is no longer pending.')
    if (entry.roomId && (decision === 'session' || decision === 'always')) {
      throw new Error('Group Room approvals only allow "once" or "deny".')
    }
    const bot = this.store.bot(entry.botId)
    if (decision === 'deny') {
      entry.settle('rejected')
      return { id, decision }
    }
    if (decision === 'session') {
      this.#sessionGrants.add(`${entry.sessionId}:${entry.toolName}`)
      entry.settle('allowed-once')
      return { id, decision }
    }
    if (decision === 'always') {
      if (bot) {
        bot.approvalPolicy = 'always'
        await this.store.mutate((state) => {
          const stored = state.bots.find(item => item.id === entry.botId)
          if (stored) stored.approvalPolicy = 'always'
        })
      }
      entry.settle('allowed-once')
      return { id, decision }
    }
    if (decision === 'once') {
      entry.settle('allowed-once')
      return { id, decision }
    }
    throw new Error(`Unknown approval decision "${decision}".`)
  }

  /**
   * Submit human answers for a pending `ask_user_question` request.
   * @param id - pending question request id (`uq_...`).
   * @param rawAnswers - array of `{ id, selected?: string[], custom?: string }` or `'cancel'`.
   */
  async decideQuestion(id, rawAnswers) {
    const entry = this.#questions.get(id)
    if (!entry) throw new Error('This question is no longer pending.')
    if (rawAnswers === 'cancel' || rawAnswers?.cancel === true) {
      const abortErr = new Error('ask_user_question was dismissed by the user')
      abortErr.name = 'UserQuestionError'
      abortErr.code = 'ASK_ABORTED'
      entry.settle(null, abortErr)
      return { id, cancelled: true }
    }
    const list = Array.isArray(rawAnswers) ? rawAnswers : (Array.isArray(rawAnswers?.answers) ? rawAnswers.answers : [])
    const byId = new Map(list.filter(item => item && typeof item.id === 'string').map(item => [item.id, item]))
    const answers = entry.questions.map((q) => {
      const supplied = byId.get(q.id)
      const selected = Array.isArray(supplied?.selected)
        ? supplied.selected.filter(v => typeof v === 'string' && v !== '')
        : []
      const custom = typeof supplied?.custom === 'string' && supplied.custom.trim() !== ''
        ? supplied.custom.trim()
        : undefined
      return {
        id: q.id,
        selected,
        ...(custom !== undefined ? { custom } : {}),
      }
    })
    entry.settle({ answers })
    return { id, answers }
  }

  /**
   * Suspend a Bot turn when its virtual screen needs human intervention (captcha,
   * login, MFA, or active human takeover). Resolves once the human clicks
   * "Done & Hand back" in the UI card.
   */
  askScreenHelp(bot, meta = {}) {
    const roomId = typeof meta.roomId === 'string' ? meta.roomId : ''
    const category = String(meta.category ?? 'manual').trim() || 'manual'
    const reason = String(meta.reason ?? 'Need human assistance on virtual screen').trim()
    const previewDataUrl = typeof meta.previewDataUrl === 'string' ? meta.previewDataUrl : ''
    const state = typeof meta.state === 'string' && meta.state !== '' ? meta.state : 'NEED_HUMAN'

    // Deduplicate if the same Bot already has an active screen help card open
    for (const existing of this.#screenHelps.values()) {
      if (existing.botId === bot.id && existing.roomId === roomId) {
        if (previewDataUrl) existing.previewDataUrl = previewDataUrl
        if (reason) existing.reason = reason
        return existing.promise
      }
    }

    const id = `sh_${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const timeoutMs = Number.isFinite(meta.timeoutMs) ? meta.timeoutMs : 0

    let settleFn
    const promise = new Promise((resolve, reject) => {
      let timer = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const entry = this.#screenHelps.get(id)
          if (entry) entry.settle({ released: false, cancelled: true, note: 'Timed out waiting for human release.' })
        }, timeoutMs)
        timer.unref?.()
      }

      const settle = (payload, err = null) => {
        if (timer) clearTimeout(timer)
        if (!this.#screenHelps.has(id)) return
        this.#screenHelps.delete(id)
        this.#emit({
          kind: 'screen_help_settled',
          id,
          botId: bot.id,
          roomId,
          outcome: err ? 'cancelled' : (payload?.cancelled ? 'cancelled' : 'released'),
        })
        if (err) reject(err)
        else resolve(payload)
      }
      settleFn = settle

      const entry = {
        id,
        botId: bot.id,
        botName: bot.name,
        roomId,
        category,
        reason,
        previewDataUrl,
        state,
        createdAt: new Date().toISOString(),
        settle,
        promise: null,
      }
      this.#screenHelps.set(id, entry)

      this.#emit({ kind: 'screen_help_pending', id, botId: bot.id, roomId, category, reason })

      meta.signal?.addEventListener?.('abort', () => {
        const cur = this.#screenHelps.get(id)
        if (cur) cur.settle({ released: false, cancelled: true, note: 'Aborted while waiting for human intervention.' })
      }, { once: true })
    })
    const created = this.#screenHelps.get(id)
    if (created) created.promise = promise
    return promise
  }

  async decideScreenHelp(id, decision = 'release', note = '') {
    const entry = this.#screenHelps.get(id)
    if (!entry) throw new Error('This screen takeover request is no longer pending.')
    const cancelled = decision === 'cancel' || decision === 'deny'
    entry.settle({
      released: !cancelled,
      cancelled,
      note: typeof note === 'string' ? note.trim() : '',
    })
    return { id, botId: entry.botId, decision: cancelled ? 'cancel' : 'release' }
  }

  cancelForBot(botId) {
    if (!botId) return
    for (const entry of [...this.#pending.values()]) {
      if (entry.botId === botId) entry.settle('cancelled')
    }
    for (const entry of [...this.#questions.values()]) {
      if (entry.botId === botId) {
        const abortErr = new Error('Bot was stopped or removed while waiting for human answer')
        abortErr.name = 'UserQuestionError'
        abortErr.code = 'ASK_ABORTED'
        entry.settle(null, abortErr)
      }
    }
    for (const entry of [...this.#screenHelps.values()]) {
      if (entry.botId === botId) {
        entry.settle({ released: false, cancelled: true, note: 'Bot stopped or removed.' })
      }
    }
  }

  cancelForRoom(roomId) {
    if (!roomId) return
    for (const entry of [...this.#pending.values()]) {
      if (entry.roomId === roomId) entry.settle('cancelled')
    }
    for (const entry of [...this.#questions.values()]) {
      if (entry.roomId === roomId) {
        const abortErr = new Error('Room stopped while waiting for human answer')
        abortErr.name = 'UserQuestionError'
        abortErr.code = 'ASK_ABORTED'
        entry.settle(null, abortErr)
      }
    }
    for (const entry of [...this.#screenHelps.values()]) {
      if (entry.roomId === roomId) {
        entry.settle({ released: false, cancelled: true, note: 'Room stopped.' })
      }
    }
  }

  clear() {
    for (const entry of [...this.#pending.values()]) entry.settle('cancelled')
    for (const entry of [...this.#questions.values()]) {
      const abortErr = new Error('Plugin shutting down')
      abortErr.name = 'UserQuestionError'
      abortErr.code = 'ASK_ABORTED'
      entry.settle(null, abortErr)
    }
    for (const entry of [...this.#screenHelps.values()]) {
      entry.settle({ released: false, cancelled: true, note: 'Plugin shutting down.' })
    }
    this.#sessionGrants.clear()
  }
}
