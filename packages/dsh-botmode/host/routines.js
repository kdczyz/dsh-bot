/**
 * Host-level persistent Routines.
 *
 * The shipped scheduler follows a live Session; a cold Bot would stop firing.
 * This scheduler lives in the Host, evaluates five-field cron itself, and wakes
 * the Bot's canonical Session through the same Dispatcher every other path
 * uses. All timers are created inside the plugin effect, so an unload or HMR
 * replacement disposes them and no ghost routine survives.
 */
import { nextCronTime } from './cron.js'
import { newId } from './store.js'

const TICK_MS = 20_000

export class Routines {
  #timer

  constructor(ctx, store, dispatcher, logger) {
    this.ctx = ctx
    this.store = store
    this.dispatcher = dispatcher
    this.logger = logger
  }

  start() {
    const tick = () => { void this.tick() }
    this.#timer = setInterval(tick, TICK_MS)
    this.#timer.unref?.()
    // Catch up once shortly after load without blocking plugin activation.
    const warmup = setTimeout(tick, 2_000)
    warmup.unref?.()
    return () => {
      clearInterval(this.#timer)
      clearTimeout(warmup)
      this.#timer = undefined
    }
  }

  async save(routineId, draft) {
    const bot = this.store.bot(draft.botId)
    if (!bot) throw new Error('Unknown Bot.')
    const cron = String(draft.cron ?? '').trim()
    const next = nextCronTime(cron, new Date())
    if (next === undefined) throw new Error('Invalid cron expression. Use five fields, e.g. "0 9 * * 1-5".')
    const prompt = String(draft.prompt ?? '').trim()
    if (prompt === '') throw new Error('The routine needs an instruction.')
    return this.store.mutate((state) => {
      const now = new Date().toISOString()
      if (routineId && routineId !== '') {
        const stored = state.routines.find(item => item.id === routineId)
        if (!stored) throw new Error('Unknown Routine.')
        stored.botId = bot.id
        stored.name = String(draft.name ?? stored.name).trim() || stored.name
        stored.cron = cron
        stored.prompt = prompt
        stored.enabled = draft.enabled !== false
        stored.nextAt = stored.enabled ? next.toISOString() : undefined
        return stored
      }
      const routine = {
        id: newId('routine'),
        botId: bot.id,
        name: String(draft.name ?? '').trim() || `${bot.name} routine`,
        cron,
        prompt,
        enabled: draft.enabled !== false,
        nextAt: next.toISOString(),
        createdAt: now,
      }
      state.routines.push(routine)
      return routine
    })
  }

  async remove(routineId) {
    await this.store.mutate((state) => {
      state.routines = state.routines.filter(routine => routine.id !== routineId)
    })
  }

  async setEnabled(routineId, enabled) {
    const routine = this.store.routine(routineId)
    if (!routine) throw new Error('Unknown Routine.')
    return this.store.mutate((state) => {
      const stored = state.routines.find(item => item.id === routineId)
      stored.enabled = enabled === true
      stored.nextAt = stored.enabled
        ? (nextCronTime(stored.cron, new Date())?.toISOString())
        : undefined
      return stored
    })
  }

  async runNow(routineId) {
    const routine = this.store.routine(routineId)
    if (!routine) throw new Error('Unknown Routine.')
    const bot = this.store.bot(routine.botId)
    if (!bot) throw new Error('Unknown Bot.')
    this.dispatcher.dispatch(bot.id, routine.prompt, { source: 'routine' })
    await this.store.mutate((state) => {
      const stored = state.routines.find(item => item.id === routineId)
      stored.lastRunAt = new Date().toISOString()
      stored.lastStatus = 'manual'
    })
    return this.store.routine(routineId)
  }

  async tick() {
    try {
      await this.store.load()
    } catch (error) {
      this.logger?.warn?.(`botmode: routine load failed: ${String(error)}`)
      return
    }
    const now = Date.now()
    const due = this.store.state.routines.filter(routine => {
      if (routine.enabled !== true || !routine.nextAt) return false
      const at = Date.parse(routine.nextAt)
      return Number.isFinite(at) && at <= now
    })
    for (const routine of due) {
      const bot = this.store.bot(routine.botId)
      if (!bot) continue
      this.dispatcher.dispatch(bot.id, routine.prompt, { source: 'routine' })
      const next = nextCronTime(routine.cron, new Date(now))
      await this.store.mutate((state) => {
        const stored = state.routines.find(item => item.id === routine.id)
        if (!stored) return
        stored.lastRunAt = new Date(now).toISOString()
        stored.lastStatus = 'dispatched'
        stored.nextAt = next ? next.toISOString() : undefined
        if (!next) stored.enabled = false
      })
    }
  }
}