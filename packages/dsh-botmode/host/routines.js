/**
 * Host-level persistent Routines (scheduled tasks).
 *
 * The shipped scheduler follows a live Session; a cold Bot would stop firing. This one lives in the
 * Host, evaluates schedules itself and wakes the Bot through the same Dispatcher every other path
 * uses. All timers are created inside the plugin effect, so an unload or HMR replacement disposes
 * them and no ghost routine survives.
 *
 * This file is the facade; the parts live in `./scheduler/`:
 *   schedule.js  schedule parsing + next-run maths (cron / every / at, time zones, stagger)
 *   model.js     stored shape, policy defaults, `settings.routines`
 *   service.js   CRUD with permissions, quotas and guard rails (UI, command and Bot tool share it)
 *   scheduler.js timer, process lock, claim-before-execute, misfire/overlap/budget decisions
 *   executor.js  one Run: concurrency gate, real result, timeout, retry/backoff, auto-pause
 *   deliver.js   result / failure delivery, `[SILENT]`
 *   runs.js      per-task Run history (JSONL)
 */
import { join } from 'node:path'
import { Deliverer } from './scheduler/deliver.js'
import { Executor } from './scheduler/executor.js'
import { RunLog } from './scheduler/runs.js'
import { Scheduler } from './scheduler/scheduler.js'
import { RoutineError, TaskService } from './scheduler/service.js'
import { dayKey } from './scheduler/model.js'
import { describeSchedule, nextRuns, normalizeSchedule } from './scheduler/schedule.js'

const USER = Object.freeze({ kind: 'user' })
const clip = (value, limit) => String(value ?? '').slice(0, limit)

export class Routines {
  constructor(ctx, store, dispatcher, logger, deps = {}) {
    this.ctx = ctx
    this.store = store
    this.dispatcher = dispatcher
    this.logger = logger
    this.runs = new RunLog(join(store.root, 'routine-runs'), logger)
    this.deliverer = new Deliverer({ store, rooms: deps.rooms, logger })
    this.service = new TaskService({
      store,
      runs: this.runs,
      rooms: deps.rooms,
      onChange: () => this.scheduler.rearm(),
      logger,
    })
    this.executor = new Executor({
      store,
      dispatcher,
      runs: this.runs,
      deliverer: this.deliverer,
      logger,
      onSettled: () => this.scheduler.rearm(),
    })
    this.scheduler = new Scheduler({
      store,
      runs: this.runs,
      executor: this.executor,
      service: this.service,
      logger,
      lockPath: join(store.root, 'routine-runs', '.scheduler.lock'),
    })
  }

  start() {
    const stop = this.scheduler.start()
    return () => {
      stop()
      this.executor.dispose()
    }
  }

  tick() { return this.scheduler.tick() }

  // ---- Human / HTTP surface (legacy-compatible) ----------------------------------------------

  async save(routineId, draft = {}) {
    const input = {
      botId: draft.botId,
      name: draft.name,
      cron: draft.cron,
      schedule: draft.schedule,
      tz: draft.tz,
      prompt: draft.prompt,
      enabled: draft.enabled !== false,
      policy: draft.policy,
    }
    if (routineId && routineId !== '') return this.service.update(USER, routineId, input)
    // Until the UI shows run history and the inbox, tasks created through the legacy form keep
    // posting into the Bot's chat (visible); Bot-authored tasks default to isolated `fresh` sessions.
    if (input.policy === undefined) input.policy = { session: 'primary' }
    return this.service.create(USER, input)
  }

  async remove(routineId) {
    await this.service.remove(USER, routineId)
  }

  async setEnabled(routineId, enabled) {
    return this.service.setEnabled(USER, routineId, enabled === true)
  }

  async runNow(routineId) {
    await this.scheduler.runNow(routineId, USER)
    return this.store.routine(routineId)
  }

  async renew(routineId, days) {
    return this.service.renew(routineId, days)
  }

  history(routineId, limit = 20) {
    return this.runs.list(routineId, Math.min(200, Math.max(1, Number(limit) || 20)))
  }

  /** Validate a schedule for the UI form and return its next three fire times. */
  previewSchedule(input, tz) {
    const schedule = normalizeSchedule(input, { tz })
    return {
      schedule,
      description: describeSchedule(schedule),
      nextRuns: nextRuns(schedule, 3).map(date => date.toISOString()),
    }
  }

  async markNoticesRead(ids) {
    const all = ids === undefined || ids === 'all'
    const wanted = new Set(Array.isArray(ids) ? ids : [])
    await this.store.mutate((state) => {
      for (const notice of state.routineNotices ?? []) {
        if (all || wanted.has(notice.id)) notice.read = true
      }
    })
  }

  async clearNotices() {
    await this.store.mutate((state) => { state.routineNotices = [] })
  }

  async removeForBot(botId) {
    for (const routine of this.store.state.routines) {
      if (routine.botId === botId) this.executor.terminate(routine.id)
    }
    return this.service.removeForBot(botId)
  }

  // ---- Approval bridge hooks -----------------------------------------------------------------

  /** Tools a human pre-authorized for this task's unattended runs. */
  allowsTool(routineId, toolName) {
    return this.store.routine(routineId)?.policy?.allowTools?.includes(toolName) === true
  }

  noteApprovalDenied(runId, toolName) {
    this.executor.noteDenied(runId, toolName)
  }

  // ---- Bot tool surface ----------------------------------------------------------------------

  #view(routine, actor) {
    const readOnly = routine.origin?.kind === 'user' && this.service.settings.botEditUserTasks !== true
    return {
      id: routine.id,
      name: routine.name,
      enabled: routine.enabled,
      createdBy: routine.origin?.kind ?? 'user',
      readOnly: actor?.kind === 'bot' ? readOnly : undefined,
      schedule: { ...routine.schedule, description: describeSchedule(routine.schedule) },
      prompt: clip(routine.prompt, 500),
      nextAt: routine.nextAt,
      lastRunAt: routine.lastRunAt,
      lastStatus: routine.lastStatus,
      lastError: clip(routine.lastError, 300),
      runCount: routine.runCount,
      consecutiveFailures: routine.consecutiveFailures,
      pausedReason: routine.pausedReason,
      expiresAt: routine.policy.expiresAt,
      policy: {
        session: routine.policy.session,
        overlap: routine.policy.overlap,
        misfire: routine.policy.misfire,
        deliver: routine.policy.deliver,
        timeoutMs: routine.policy.timeoutMs,
        retries: routine.policy.retry.transientMax,
      },
    }
  }

  #runView(run) {
    return {
      runId: run.runId,
      status: run.status,
      trigger: run.trigger,
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      attempt: run.attempt,
      error: clip(run.error, 300),
      silent: run.silent === true,
      replyPreview: clip(run.replyPreview, 300),
      sessionId: run.sessionId,
    }
  }

  /**
   * Entry point of the `scheduled_tasks` Bot tool. `caller` is `{ bot, kind, sessionId }` as resolved
   * from the calling Session; the Bot id never comes from the tool arguments.
   */
  async toolCall(caller, args = {}) {
    const botId = caller.bot.id
    // A Routine that runs inside the Bot's primary chat is still an unattended run.
    const insideRun = caller.kind === 'routine'
      || this.executor.openRuns().some(run => run.botId === botId && run.status === 'running' && run.session === 'primary')
    const actor = { kind: 'bot', botId, sessionKind: insideRun ? 'routine' : caller.kind }
    const action = String(args?.action ?? 'list')
    const id = String(args?.id ?? '')
    try {
      switch (action) {
        case 'list': {
          const tasks = this.service.list(actor).map(routine => this.#view(routine, actor))
          const settings = this.service.settings
          return {
            ok: true,
            tasks,
            limits: {
              activeTasks: tasks.filter(task => task.enabled).length,
              maxActiveTasks: settings.maxPerBot,
              runsToday: this.service.runsToday(botId, dayKey()),
              maxRunsPerDay: settings.maxRunsPerDay,
              minIntervalMinutes: Math.round(settings.minIntervalMs / 60_000),
            },
          }
        }
        case 'get': {
          const routine = this.service.get(actor, id)
          const recent = await this.runs.list(routine.id, 5)
          return { ok: true, task: this.#view(routine, actor), recentRuns: recent.map(run => this.#runView(run)) }
        }
        case 'create': {
          const routine = await this.service.create(actor, args)
          return {
            ok: true,
            task: this.#view(routine, actor),
            nextRuns: nextRuns(routine.schedule, 3, new Date(), routine.id).map(date => date.toISOString()),
          }
        }
        case 'update': {
          const routine = await this.service.update(actor, id, args)
          return {
            ok: true,
            task: this.#view(routine, actor),
            nextRuns: routine.enabled ? nextRuns(routine.schedule, 3, new Date(), routine.id).map(date => date.toISOString()) : [],
          }
        }
        case 'pause':
        case 'resume': {
          const routine = await this.service.setEnabled(actor, id, action === 'resume')
          return { ok: true, task: this.#view(routine, actor) }
        }
        case 'run': {
          const run = await this.scheduler.runNow(id, actor)
          return { ok: true, runId: run.runId, status: run.status }
        }
        case 'remove': {
          await this.service.remove(actor, id)
          return { ok: true, removed: id }
        }
        case 'history': {
          const routine = this.service.get(actor, id)
          const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10))
          const runs = await this.runs.list(routine.id, limit)
          return { ok: true, taskId: routine.id, runs: runs.map(run => this.#runView(run)) }
        }
        default:
          return { ok: false, code: 'unknown_action', error: `Unknown action "${action}". Use list, get, create, update, pause, resume, run, remove or history.` }
      }
    } catch (error) {
      if (error instanceof RoutineError) return { ok: false, code: error.code, error: error.message }
      return { ok: false, code: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }
}
