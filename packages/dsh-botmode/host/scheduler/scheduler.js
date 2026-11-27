/**
 * Routine scheduler: one timer aimed at the earliest `nextAt`, a single-holder process lock and a
 * claim-before-execute protocol.
 *
 * Claim: when a task is due, its next `nextAt` (and counters) are persisted in ONE store mutation
 * *before* anything runs, so a crash or a slow tick can never fire the same occurrence twice
 * (at-most-once). Whatever happens to the Run afterwards is the Executor's business.
 *
 * Misfire (host was down / busy past the due time):
 *   late <= 90s            run normally
 *   90s < late <= graceMs  `run_once` -> one catch-up run, `skip` -> recorded as `missed`
 *   late > graceMs         recorded as `missed`
 * Overlap (previous run of the same task still open): `skip` | `queue` (at most one waiting) | `terminate`.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, stat, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'
import { newId } from '../store.js'
import { dayKey } from './model.js'
import { nextRun } from './schedule.js'
import { RoutineError } from './service.js'

const ON_TIME_SLACK_MS = 90_000
const MAX_IDLE_MS = 30_000
const MIN_REARM_MS = 1_000
const WARMUP_MS = 2_000
const LOCK_STALE_MS = 120_000

const iso = (value = new Date()) => (value instanceof Date ? value : new Date(value)).toISOString()

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Single-holder lock so two host processes sharing one state root never both fire tasks. */
export class SchedulerLock {
  held = false

  constructor(path) {
    this.path = path
    this.token = randomUUID()
  }

  async #create() {
    const handle = await open(this.path, 'wx')
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.token, at: iso() }))
    } finally {
      await handle.close()
    }
    this.held = true
    return true
  }

  async acquire() {
    try {
      if (this.held) {
        const now = new Date()
        await utimes(this.path, now, now)
        return true
      }
      await mkdir(dirname(this.path), { recursive: true })
      try {
        return await this.#create()
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      let info = {}
      try { info = JSON.parse(await readFile(this.path, 'utf8')) } catch (_error) { /* unreadable = stale */ }
      if (info.token === this.token) {
        this.held = true
        return true
      }
      const fresh = await stat(this.path).then(item => Date.now() - item.mtimeMs < LOCK_STALE_MS).catch(() => false)
      if (fresh && pidAlive(info.pid)) return false
      await rm(this.path, { force: true })
      return await this.#create().catch(() => false)
    } catch (_error) {
      // A lock-file problem must not silently stop all scheduling; run unguarded.
      this.held = false
      return true
    }
  }

  async release() {
    if (!this.held) return
    this.held = false
    try {
      const info = JSON.parse(await readFile(this.path, 'utf8'))
      if (info.token === this.token) await rm(this.path, { force: true })
    } catch (_error) { /* already gone */ }
  }
}

export class Scheduler {
  #timer
  #ticking = false
  #stopped = true

  constructor({ store, runs, executor, service, logger, lockPath }) {
    this.store = store
    this.runs = runs
    this.executor = executor
    this.service = service
    this.logger = logger
    this.lock = new SchedulerLock(lockPath)
  }

  start() {
    this.#stopped = false
    void this.runs.recoverInterrupted()
      .then((recovered) => {
        if (recovered.length > 0) this.logger?.warn?.(`botmode: ${recovered.length} routine run(s) were interrupted by a restart`)
      })
      .catch(() => undefined)
    this.#arm(WARMUP_MS)
    return () => {
      this.#stopped = true
      clearTimeout(this.#timer)
      this.#timer = undefined
      void this.lock.release()
    }
  }

  /** Re-aim the timer after tasks were added, changed or removed. */
  rearm() {
    if (!this.#stopped && !this.#ticking) this.#arm()
  }

  #arm(forcedDelay) {
    if (this.#stopped) return
    clearTimeout(this.#timer)
    let delay = forcedDelay
    if (delay === undefined) {
      const now = Date.now()
      let earliest = Infinity
      for (const routine of this.store.state.routines) {
        if (!routine.enabled || !routine.nextAt) continue
        const at = Date.parse(routine.nextAt)
        if (Number.isFinite(at)) earliest = Math.min(earliest, at)
      }
      delay = Number.isFinite(earliest) ? Math.min(MAX_IDLE_MS, Math.max(MIN_REARM_MS, earliest - now)) : MAX_IDLE_MS
    }
    this.#timer = setTimeout(() => { void this.tick() }, delay)
    this.#timer.unref?.()
  }

  async tick() {
    if (this.#ticking) return
    this.#ticking = true
    try {
      if (!(await this.lock.acquire())) return
      await this.store.load()
      const now = Date.now()
      await this.#expire(now)
      const due = this.store.state.routines
        .filter(routine => routine.enabled && routine.nextAt && Date.parse(routine.nextAt) <= now)
        .sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))
      for (const routine of due) {
        try {
          await this.#claim(routine, now)
        } catch (error) {
          this.logger?.warn?.(`botmode: routine ${routine.id} claim failed: ${String(error)}`)
        }
      }
    } catch (error) {
      this.logger?.warn?.(`botmode: routine tick failed: ${String(error)}`)
    } finally {
      this.#ticking = false
      this.#arm()
    }
  }

  async #expire(now) {
    const expired = this.store.state.routines.filter((routine) => {
      if (!routine.enabled) return false
      const at = Date.parse(routine.policy?.expiresAt ?? '')
      return Number.isFinite(at) && at <= now
    })
    if (expired.length === 0) return
    await this.store.mutate((state) => {
      for (const routine of state.routines) {
        if (expired.some(item => item.id === routine.id) && routine.enabled) {
          routine.enabled = false
          routine.nextAt = undefined
          routine.pausedReason = 'expired'
        }
      }
    })
  }

  #newRun(routine, trigger, scheduledFor) {
    return {
      runId: newId('run'),
      routineId: routine.id,
      botId: routine.botId,
      trigger,
      scheduledFor: scheduledFor ?? iso(),
      createdAt: iso(),
      status: 'queued',
      attempt: 0,
      session: routine.policy.session,
    }
  }

  /** Decide how an overlapping occurrence is handled. Returns a skip reason or '' to proceed. */
  #overlapReason(routine) {
    if (!this.executor.hasOpen(routine.id)) return ''
    const policy = routine.policy.overlap
    if (policy === 'terminate') {
      this.executor.terminate(routine.id)
      return ''
    }
    if (policy === 'queue') {
      const waiting = this.executor.openRuns(routine.id).filter(run => run.status === 'queued').length
      return waiting >= 1 ? 'overlap: a run is already waiting' : ''
    }
    return 'overlap: previous run still active'
  }

  #budgetExhausted(botId, today) {
    return this.service.runsToday(botId, today) >= this.service.settings.maxRunsPerDay
  }

  async #claim(routine, now) {
    const bot = this.store.bot(routine.botId)
    if (!bot) {
      await this.store.mutate((state) => {
        const stored = state.routines.find(item => item.id === routine.id)
        if (stored) {
          stored.enabled = false
          stored.nextAt = undefined
          stored.pausedReason = 'bot_missing'
        }
      })
      return
    }
    const dueAt = Date.parse(routine.nextAt)
    const late = now - dueAt
    const policy = routine.policy
    const today = dayKey(new Date(now))

    let decision = 'run'
    let trigger = 'schedule'
    let reason = ''
    if (late > ON_TIME_SLACK_MS) {
      if (late > policy.graceMs || policy.misfire === 'skip') {
        decision = 'missed'
        reason = `missed: ${Math.round(late / 1000)}s late`
      } else {
        trigger = 'catchup'
      }
    }
    if (decision === 'run') {
      reason = this.#overlapReason(routine)
      if (reason !== '') decision = 'skipped'
    }
    if (decision === 'run' && this.#budgetExhausted(bot.id, today)) {
      decision = 'skipped'
      reason = 'daily_budget_exhausted'
    }

    const next = nextRun(routine.schedule, new Date(now), routine.id)
    let finish = ''
    if (routine.schedule.kind === 'at' || next === undefined) {
      finish = decision === 'missed' ? 'missed' : (routine.schedule.kind === 'at' ? 'completed' : 'schedule_exhausted')
    }
    if (decision === 'run' && policy.repeat && routine.runCount + 1 >= policy.repeat) finish = 'completed'

    const run = this.#newRun(routine, trigger, routine.nextAt)
    const claimed = await this.store.mutate((state) => {
      const stored = state.routines.find(item => item.id === routine.id)
      // Changed or removed while we were deciding: leave it for the next tick.
      if (!stored || !stored.enabled || stored.nextAt !== routine.nextAt) return false
      stored.nextAt = finish === '' ? next?.toISOString() : undefined
      if (finish !== '') {
        stored.enabled = false
        stored.pausedReason = finish
      }
      if (decision === 'run') {
        stored.runCount += 1
        if (stored.budget.day !== today) stored.budget = { day: today, count: 0 }
        stored.budget.count += 1
      } else {
        stored.lastStatus = decision
        stored.lastError = reason
        stored.lastRunAt = iso(now)
      }
      stored.updatedAt = iso(now)
      return true
    })
    if (!claimed) return

    if (decision === 'run') {
      await this.runs.append(routine.id, { ...run })
      this.executor.submit(run)
      return
    }
    await this.runs.append(routine.id, { ...run, status: decision, error: reason, finishedAt: iso(now) })
    await this.runs.compact(routine.id, this.service.settings.keepRuns).catch(() => undefined)
  }

  /** Manual trigger (UI "Run now" or the Bot tool). Does not touch the regular schedule. */
  async runNow(routineId, actor = { kind: 'user' }) {
    const routine = this.service.get(actor, routineId)
    this.service.authorize(actor, 'run', routine)
    if (!this.store.bot(routine.botId)) throw new RoutineError('unknown_bot', 'Unknown Bot.')
    const today = dayKey()
    if (actor.kind === 'bot' && this.#budgetExhausted(routine.botId, today)) {
      throw new RoutineError('budget_exhausted', 'The daily run budget for this Bot is used up.')
    }
    const busy = this.#overlapReason(routine)
    if (busy !== '') throw new RoutineError('busy', 'This task is already running.')
    const run = this.#newRun(routine, 'manual', iso())
    await this.store.mutate((state) => {
      const stored = state.routines.find(item => item.id === routineId)
      if (!stored) throw new RoutineError('not_found', 'Unknown Routine.')
      stored.runCount += 1
      if (stored.budget.day !== today) stored.budget = { day: today, count: 0 }
      stored.budget.count += 1
      stored.updatedAt = iso()
    })
    await this.runs.append(routine.id, { ...run })
    this.executor.submit(run)
    return run
  }
}
