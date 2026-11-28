/**
 * Executes one Routine Run from claim to settlement.
 *
 * Lifecycle: queued -> running -> ok | error | timeout (or skipped / interrupted).
 *  - A host-wide semaphore (`settings.routines.maxConcurrent`) bounds simultaneous Runs; Runs beyond it
 *    wait FIFO in `queued`. A retry backoff releases the slot while it waits.
 *  - The Run waits for the real turn result via `Dispatcher.enqueue`. The turn timeout starts when the
 *    turn actually begins (inside the Dispatcher), so time spent queued never counts.
 *  - Transient failures (network, rate limits, overload, timeouts) are retried with the task's delays;
 *    permanent ones (denied approval, deleted Bot, bad config) fail at once.
 *  - After the final attempt: consecutive-failure accounting, exponential backoff of the next fire,
 *    auto-pause, failure alert (cooldown protected), result delivery, history compaction.
 */
import { createHash } from 'node:crypto'
import { DEFAULT_ROUTINE_SETTINGS } from './model.js'
import { isSilentReply } from './deliver.js'
import { nextRun } from './schedule.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const TRANSIENT_RE = /timed? ?out|timeout|etimedout|econn|enotfound|eai_again|socket hang up|rate.?limit|too many requests|\b429\b|overload|\b50[234]\b|temporar|network|fetch failed|unavailable/i
const PERMANENT_RE = /approval|denied|unknown bot|unknown routine|not found|invalid|no adapter|cannot switch|api key|unauthori[sz]ed|forbidden|\b40[13]\b|quota exceeded|insufficient/i

export const classifyFailure = (message) => {
  const text = String(message ?? '')
  const timeout = /timed? ?out|timeout/i.test(text)
  const permanent = PERMANENT_RE.test(text) && !timeout
  const transient = !permanent && (timeout || TRANSIENT_RE.test(text))
  return { timeout, permanent, transient }
}

const fingerprint = (message) => createHash('sha1')
  .update(String(message ?? '').replace(/\d+/g, '#').toLowerCase().slice(0, 300))
  .digest('hex')
  .slice(0, 12)

const iso = (value = new Date()) => (value instanceof Date ? value : new Date(value)).toISOString()

export const buildRunPrompt = (routine, run) => [
  `[Scheduled task: ${routine.name}]`,
  `This is an unattended ${run.trigger === 'manual' ? 'manual' : 'scheduled'} run (run ${run.runId}).`
    + ' Nobody is watching, so do not ask questions: do the work and reply with a concise result.',
  'If there is nothing worth reporting, reply with exactly `[SILENT]` and nothing else.',
  '',
  routine.prompt,
].join('\n')

export class Executor {
  #active = 0
  #waiters = []
  #open = new Map() // routineId -> Set<entry>
  #timers = new Set()
  #disposed = false

  constructor({ store, dispatcher, runs, deliverer, logger, onSettled }) {
    this.store = store
    this.dispatcher = dispatcher
    this.runs = runs
    this.deliverer = deliverer
    this.logger = logger
    this.onSettled = onSettled
  }

  #settings() {
    return this.store.state.settings?.routines ?? DEFAULT_ROUTINE_SETTINGS
  }

  /** Open (queued or running) Runs of one routine, or of everything when omitted. */
  openRuns(routineId) {
    if (routineId) return [...(this.#open.get(routineId) ?? [])].map(entry => entry.run)
    return [...this.#open.values()].flatMap(set => [...set].map(entry => entry.run))
  }

  hasOpen(routineId) { return (this.#open.get(routineId)?.size ?? 0) > 0 }

  runningCount() { return this.#active }

  /** Start driving a freshly claimed (`queued`) Run in the background. */
  submit(run) {
    const entry = { run, terminated: false, promise: undefined }
    const set = this.#open.get(run.routineId) ?? new Set()
    set.add(entry)
    this.#open.set(run.routineId, set)
    entry.promise = this.#drive(entry)
      .catch((error) => {
        this.logger?.warn?.(`botmode: routine run ${run.runId} crashed: ${String(error)}`)
      })
      .finally(() => {
        set.delete(entry)
        if (set.size === 0 && this.#open.get(run.routineId) === set) this.#open.delete(run.routineId)
      })
    return entry
  }

  /** Wait for every currently open Run (used by tests and orderly shutdown). */
  async drain() {
    for (let guard = 0; guard < 100; guard += 1) {
      const pending = [...this.#open.values()].flatMap(set => [...set].map(entry => entry.promise))
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  /** Overlap policy `terminate`: cancel the live Run(s) of a routine. */
  terminate(routineId) {
    for (const entry of this.#open.get(routineId) ?? []) {
      entry.terminated = true
      if (entry.run.sessionId) this.dispatcher.cancelSession?.(entry.run.sessionId)
    }
  }

  /** The approval bridge reports a denied tool so the Run can say why it could not finish. */
  noteDenied(runId, toolName) {
    for (const set of this.#open.values()) {
      for (const entry of set) {
        if (entry.run.runId !== runId) continue
        entry.run.denied = [...new Set([...(entry.run.denied ?? []), String(toolName)])]
      }
    }
  }

  dispose() {
    this.#disposed = true
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    for (const waiter of this.#waiters.splice(0)) waiter()
  }

  #acquire() {
    if (this.#active < this.#settings().maxConcurrent) {
      this.#active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.#waiters.push(() => {
        this.#active += 1
        resolve()
      })
    })
  }

  #release() {
    this.#active = Math.max(0, this.#active - 1)
    while (this.#waiters.length > 0 && this.#active < this.#settings().maxConcurrent) {
      this.#waiters.shift()()
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer)
        resolve()
      }, ms)
      this.#timers.add(timer)
    })
  }

  async #snapshot(run) {
    await this.runs.append(run.routineId, { ...run })
  }

  async #drive(entry) {
    const { run } = entry
    let outcome
    let attempt = 0
    for (;;) {
      attempt += 1
      await this.#acquire()
      try {
        if (this.#disposed) {
          outcome = { ok: false, status: 'interrupted', error: 'host_shutdown', permanent: true }
          break
        }
        run.status = 'running'
        run.attempt = attempt
        run.startedAt = run.startedAt ?? iso()
        await this.#snapshot(run)
        outcome = await this.#attempt(entry)
      } finally {
        this.#release()
      }
      if (outcome.ok || entry.terminated || outcome.permanent) break
      const policy = this.store.routine(run.routineId)?.policy
      const retry = policy?.retry ?? { transientMax: 0, delaysMs: [] }
      if (!outcome.transient || attempt > retry.transientMax) break
      const delays = retry.delaysMs.length > 0 ? retry.delaysMs : [30_000]
      const delay = delays[Math.min(attempt - 1, delays.length - 1)]
      run.status = 'queued'
      run.error = outcome.error
      run.retryAt = iso(Date.now() + delay)
      await this.#snapshot(run)
      await this.#sleep(delay)
      if (this.#disposed) {
        outcome = { ok: false, status: 'interrupted', error: 'host_shutdown', permanent: true }
        break
      }
    }
    await this.#finalize(entry, outcome)
  }

  async #attempt(entry) {
    const { run } = entry
    const routine = this.store.routine(run.routineId)
    if (!routine) return { ok: false, status: 'error', error: 'unknown routine (deleted)', permanent: true }
    const bot = this.store.bot(routine.botId)
    if (!bot) return { ok: false, status: 'error', error: 'unknown bot', permanent: true }
    let result
    try {
      result = await this.dispatcher.enqueue(bot.id, buildRunPrompt(routine, run), {
        source: 'routine',
        routineId: routine.id,
        runId: run.runId,
        sessionMode: routine.policy.session,
        timeoutMs: routine.policy.timeoutMs,
        memoryQuery: routine.prompt,
        memoryUserText: routine.prompt,
        skipMemorySync: routine.policy.memorySync !== true,
        onSessionResolved: (sessionId) => { run.sessionId = sessionId },
      })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (entry.terminated) return { ok: false, status: 'error', error: 'terminated_by_overlap', permanent: true }
    if (result?.sessionId && !run.sessionId) run.sessionId = result.sessionId
    if (result?.ok) {
      const text = String(result.text ?? '')
      return {
        ok: true,
        status: 'ok',
        text,
        silent: isSilentReply(text),
        metrics: result.metrics
          ? { toolCallCount: result.metrics.toolCallCount ?? 0, tokensUsed: result.metrics.tokensUsed ?? 0 }
          : undefined,
      }
    }
    const message = String(result?.error ?? 'unknown error')
    const kind = classifyFailure(message)
    const denied = run.denied?.length > 0 ? `approval_denied:${run.denied.join(',')}` : ''
    return {
      ok: false,
      status: kind.timeout ? 'timeout' : 'error',
      error: denied !== '' ? `${denied} (${message})` : message,
      transient: kind.transient && denied === '',
      permanent: kind.permanent || denied !== '',
    }
  }

  async #finalize(entry, outcome) {
    const { run } = entry
    const settings = this.#settings()
    const finishedAt = iso()
    run.status = outcome.status ?? (outcome.ok ? 'ok' : 'error')
    run.error = outcome.ok ? '' : String(outcome.error ?? '')
    run.finishedAt = finishedAt
    run.silent = outcome.silent === true
    run.replyPreview = outcome.ok ? String(outcome.text ?? '').slice(0, 1000) : ''
    run.metrics = outcome.metrics
    run.warnings = run.denied?.length > 0 ? run.denied.map(tool => `approval_denied:${tool}`) : undefined
    delete run.denied
    delete run.retryAt
    await this.#snapshot(run)

    const countsAsFailure = !outcome.ok && run.status !== 'interrupted' && !entry.terminated
    let alert = false
    let paused = false
    let removed = false
    let after
    await this.store.mutate((state) => {
      const stored = state.routines.find(item => item.id === run.routineId)
      if (!stored) return
      stored.lastRunAt = run.startedAt ?? finishedAt
      stored.lastStatus = run.status
      stored.lastError = run.error
      stored.updatedAt = finishedAt
      if (outcome.ok) {
        const recovering = stored.consecutiveFailures > 0
        stored.consecutiveFailures = 0
        // Success resets the backoff: go back to the regular cadence.
        if (recovering && stored.enabled) stored.nextAt = nextRun(stored.schedule, new Date(), stored.id)?.toISOString()
        if (stored.policy.deleteAfterRun === true && stored.schedule.kind === 'at') {
          state.routines = state.routines.filter(item => item.id !== stored.id)
          removed = true
        }
      } else if (countsAsFailure) {
        stored.consecutiveFailures += 1
        const ladder = stored.policy.backoffMs
        if (stored.enabled && stored.schedule.kind !== 'at' && ladder.length > 0) {
          const wait = ladder[Math.min(stored.consecutiveFailures, ladder.length) - 1]
          const earliest = Date.now() + wait
          const planned = Date.parse(stored.nextAt ?? '')
          if (!Number.isFinite(planned) || planned < earliest) stored.nextAt = iso(earliest)
        }
        if (stored.enabled && stored.consecutiveFailures >= settings.autoPauseAfter) {
          stored.enabled = false
          stored.nextAt = undefined
          stored.pausedReason = `auto_paused: ${stored.consecutiveFailures} consecutive failures`
          paused = true
        }
        // Alert only once retries are exhausted, at most hourly, and the same error at most daily.
        const key = fingerprint(run.error)
        const since = Date.now() - (Date.parse(stored.lastAlertAt) || 0)
        const sameToday = stored.lastAlertKey === key && since < DAY_MS
        if (paused || (since >= HOUR_MS && !sameToday)) {
          alert = true
          stored.lastAlertAt = finishedAt
          stored.lastAlertKey = key
        }
      }
      after = { ...stored, policy: stored.policy }
    })

    if (after) {
      try {
        await this.deliverer.deliver({ routine: after, run, outcome, alert, paused })
      } catch (error) {
        this.logger?.warn?.(`botmode: routine ${run.routineId} delivery failed: ${String(error)}`)
      }
    }
    try {
      if (removed) await this.runs.remove(run.routineId)
      else await this.runs.compact(run.routineId, settings.keepRuns)
    } catch (error) {
      this.logger?.warn?.(`botmode: routine ${run.routineId} history cleanup failed: ${String(error)}`)
    }
    try { this.onSettled?.(run.routineId) } catch (_error) { /* never break settlement */ }
  }
}
