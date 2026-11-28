/**
 * Delivery of Routine results and failure alerts.
 *
 * - `announce` (default): a durable notice in `state.routineNotices` (the Bot's inbox shown by the UI).
 * - `none`: nothing beyond the Run record.
 * - `room:<id>`: the Bot posts the result into that Group Room (it must still be a member).
 *
 * A reply of exactly `[SILENT]` (or the room `(pass)` token) means "nothing worth reporting" and is
 * never delivered. Failure alerts are sent only after retries are exhausted and are rate limited by
 * the caller (cooldown + same-error-once-a-day); a task set to `none` stays quiet on failure too.
 */
import { newId } from '../store.js'
import { isPassReply } from '../room-protocol.js'

export const MAX_NOTICES = 50
const NOTICE_TEXT_CHARS = 2000

export const isSilentReply = (text) => {
  const value = String(text ?? '').trim()
  return /^\[silent\]$/i.test(value) || isPassReply(value)
}

const oneLine = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)

export class Deliverer {
  constructor({ store, rooms, logger }) {
    this.store = store
    this.rooms = rooms
    this.logger = logger
  }

  async #notice(routine, run, kind, title, text) {
    await this.store.mutate((state) => {
      state.routineNotices = Array.isArray(state.routineNotices) ? state.routineNotices : []
      state.routineNotices.push({
        id: newId('notice'),
        kind,
        routineId: routine.id,
        routineName: routine.name,
        botId: routine.botId,
        runId: run.runId,
        sessionId: run.sessionId ?? '',
        title,
        text: String(text ?? '').slice(0, NOTICE_TEXT_CHARS),
        read: false,
        at: new Date().toISOString(),
      })
      state.routineNotices = state.routineNotices.slice(-MAX_NOTICES)
    })
  }

  /** @param event - `{ routine, run, outcome, alert, paused }` after the Run has settled. */
  async deliver({ routine, run, outcome, alert = false, paused = false }) {
    const mode = routine.policy?.deliver ?? 'announce'
    if (mode === 'none') return { delivered: 'none' }
    if (!outcome.ok) {
      if (!alert) return { delivered: 'none' }
      const lines = [`Run failed: ${oneLine(outcome.error, 400) || 'unknown error'}`]
      if (paused) lines.push(`The task was paused after ${routine.consecutiveFailures} consecutive failures.`)
      await this.#notice(routine, run, 'failure', `${routine.name} failed`, lines.join('\n'))
      return { delivered: 'announce' }
    }
    if (outcome.silent) return { delivered: 'none' }
    const text = String(outcome.text ?? '').trim()
    if (text === '') return { delivered: 'none' }

    if (mode.startsWith('room:')) {
      const roomId = mode.slice('room:'.length)
      const room = this.store.room(roomId)
      const bot = this.store.bot(routine.botId)
      if (room && bot && room.memberIds.includes(bot.id) && this.rooms?.appendAtomic) {
        try {
          await this.rooms.appendAtomic(roomId, {
            from: bot.id,
            name: bot.name,
            text: `[${routine.name}] ${text}`.slice(0, 8000),
            kind: 'message',
          })
          return { delivered: mode }
        } catch (error) {
          this.logger?.warn?.(`botmode: routine ${routine.id} room delivery failed: ${String(error)}`)
        }
      }
      // Fall through to the inbox when the room is gone or the Bot left it.
    }
    await this.#notice(routine, run, 'result', routine.name, text)
    return { delivered: 'announce' }
  }
}
