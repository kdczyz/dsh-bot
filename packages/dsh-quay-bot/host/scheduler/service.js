/**
 * Routine CRUD with permissions, quotas and guard rails. The single entry point shared by the UI/HTTP
 * (`actor.kind === 'user'`), the `/botmode routine` command and the Bot tool (`actor.kind === 'bot'`).
 *
 * A Bot actor is always scoped to its own tasks: another Bot's task is indistinguishable from a missing
 * one. Human-created tasks are read-only (plus `run`) for the Bot unless `settings.routines.botEditUserTasks`.
 * Tasks cannot be created or changed from inside a Routine run, which stops self-multiplying schedules.
 */
import { newId } from '../store.js'
import { DEFAULT_ROUTINE_SETTINGS, defaultPolicy, normalizePolicy } from './model.js'
import { legacyCronField, minGapMs, nextRun, normalizeSchedule } from './schedule.js'

export class RoutineError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RoutineError'
    this.code = code
  }
}

/** Prompt patterns refused for Bot-authored tasks (they run unattended with the Bot's tools). */
const INJECTION_PATTERNS = [
  ['override_instructions', /(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|system)\s+(instructions?|prompts?|rules?)/i],
  ['override_instructions', /忽略(以上|之前|上面|先前)(的)?(所有)?(指令|提示|规则)/],
  ['secret_exfiltration', /(exfiltrat\w*|upload|send|post|leak)\b.{0,60}(api[_ -]?keys?|secrets?|tokens?|passwords?|credentials?|\.ssh|id_rsa|\.env\b)/i],
  ['secret_exfiltration', /(发送|上传|外传|泄露).{0,20}(密钥|口令|密码|令牌|token|凭据)/i],
  ['remote_shell', /(curl|wget)[^\n|]*\|\s*(ba|z)?sh\b/i],
  ['sensitive_files', /(\.ssh\/id_|~\/\.aws|\/etc\/shadow|\/etc\/passwd)/i],
  ['destructive_command', /\brm\s+-rf\s+(\/|~)/i],
  ['disable_safeguards', /(disable|bypass|skip|turn off)\s+(the\s+)?(approvals?|permissions?|safety|guard\w*|sandbox)/i],
]

export const scanPrompt = (text) => {
  for (const [label, pattern] of INJECTION_PATTERNS) {
    if (pattern.test(String(text ?? ''))) return label
  }
  return undefined
}

const iso = (value = new Date()) => (value instanceof Date ? value : new Date(value)).toISOString()

const MUTATING = new Set(['create', 'update', 'remove', 'pause', 'resume'])

export class TaskService {
  constructor({ store, runs, rooms, onChange, logger }) {
    this.store = store
    this.runs = runs
    this.rooms = rooms
    this.onChange = onChange
    this.logger = logger
  }

  get settings() {
    return this.store.state.settings?.routines ?? DEFAULT_ROUTINE_SETTINGS
  }

  #changed() {
    try { this.onChange?.() } catch (_error) { /* a listener must never break CRUD */ }
  }

  /** Throws unless `actor` may perform `op` on `routine` (omit `routine` for `create`). */
  authorize(actor, op, routine) {
    if (actor?.kind !== 'bot') return
    if (MUTATING.has(op) && actor.sessionKind === 'routine') {
      throw new RoutineError('recursion_blocked', 'Scheduled runs cannot create or change scheduled tasks; ask the user or do it from your own chat.')
    }
    if (!routine) return
    if (routine.botId !== actor.botId) throw new RoutineError('not_found', 'Unknown Routine.')
    if (routine.origin?.kind === 'user' && MUTATING.has(op) && this.settings.botEditUserTasks !== true) {
      throw new RoutineError('read_only', 'This task was created by the user and is read-only for you; you may list it, read its history, or run it.')
    }
  }

  get(actor, routineId) {
    const routine = this.store.routine(routineId)
    if (!routine) throw new RoutineError('not_found', 'Unknown Routine.')
    if (actor?.kind === 'bot' && routine.botId !== actor.botId) throw new RoutineError('not_found', 'Unknown Routine.')
    return routine
  }

  list(actor, filter = {}) {
    const botId = actor?.kind === 'bot' ? actor.botId : (filter.botId ?? '')
    return this.store.state.routines.filter(routine => botId === '' || routine.botId === botId)
  }

  /** Runs started today by a Bot (all its tasks), for the daily budget. */
  runsToday(botId, today) {
    let total = 0
    for (const routine of this.store.state.routines) {
      if (routine.botId === botId && routine.budget?.day === today) total += routine.budget.count
    }
    return total
  }

  #activeCount(botId, exceptId = '') {
    return this.store.state.routines.filter(routine => routine.botId === botId && routine.enabled && routine.id !== exceptId).length
  }

  #validateRoomDelivery(bot, deliver) {
    if (!deliver.startsWith('room:')) return
    const room = this.store.room(deliver.slice('room:'.length))
    if (!room || !room.memberIds.includes(bot.id)) {
      throw new RoutineError('invalid_delivery', 'Delivery room not found, or the Bot is not a member of it.')
    }
  }

  /** Build the validated fields shared by create and update. */
  #prepare({ actor, bot, input, existing, now }) {
    const settings = this.settings
    const isBot = actor?.kind === 'bot'

    const rawName = input.name !== undefined ? String(input.name ?? '').trim() : undefined
    const name = (rawName ?? existing?.name ?? '').slice(0, 80) || `${bot.name} routine`

    const prompt = input.prompt !== undefined ? String(input.prompt ?? '').trim() : (existing?.prompt ?? '')

    let scheduleInput = input.schedule
    if (scheduleInput === undefined && typeof input.cron === 'string' && input.cron.trim() !== '') {
      scheduleInput = { kind: 'cron', cron: input.cron }
    }
    let schedule = existing?.schedule
    let scheduleChanged = false
    if (scheduleInput !== undefined || !existing) {
      try {
        schedule = normalizeSchedule(scheduleInput, {
          now,
          tz: typeof input.tz === 'string' && input.tz.trim() !== '' ? input.tz.trim() : existing?.schedule?.tz,
        })
      } catch (error) {
        // Keep the long-standing wording for a bad five-field expression.
        throw new RoutineError('invalid_schedule', error.message)
      }
      scheduleChanged = true
    }

    if (prompt === '') throw new RoutineError('invalid_prompt', 'The routine needs an instruction.')
    if (prompt.length > settings.maxPromptChars) {
      throw new RoutineError('prompt_too_long', `The instruction is too long (${prompt.length} > ${settings.maxPromptChars} characters).`)
    }
    if (isBot && (input.prompt !== undefined || !existing)) {
      const hit = scanPrompt(prompt)
      if (hit) throw new RoutineError('prompt_rejected', `The instruction was rejected by the safety scan (${hit}). Unattended tasks must not override instructions, touch secrets or run remote scripts.`)
    }

    if (scheduleChanged && isBot) {
      const gap = minGapMs(schedule, now)
      if (gap < settings.minIntervalMs) {
        throw new RoutineError('interval_too_short', `Schedule fires too often: the minimum interval is ${Math.round(settings.minIntervalMs / 60_000)} minutes.`)
      }
    }
    if (scheduleChanged && schedule.kind === 'at' && Date.parse(schedule.at) <= now.getTime()) {
      throw new RoutineError('time_in_past', 'The scheduled time is in the past.')
    }

    const base = existing?.policy ?? defaultPolicy('fresh')
    const requested = input.policy && typeof input.policy === 'object' ? { ...input.policy } : {}
    if (isBot) {
      // A Bot must not pre-authorize tools for its own unattended runs.
      delete requested.allowTools
    }
    const policy = normalizePolicy(requested, base)
    this.#validateRoomDelivery(bot, policy.deliver)

    const origin = existing?.origin ?? (isBot
      ? { kind: 'bot', botId: actor.botId, chat: 'primary' }
      : { kind: 'user', botId: '', chat: '' })

    // Bot-authored recurring tasks expire unless a human renews them.
    if (origin.kind === 'bot' && schedule.kind !== 'at' && settings.botExpiryDays > 0) {
      const limit = now.getTime() + settings.botExpiryDays * 86_400_000
      const requestedAt = Date.parse(policy.expiresAt ?? '')
      if (!existing && !Number.isFinite(requestedAt)) policy.expiresAt = iso(limit)
      else if (Number.isFinite(requestedAt) && requestedAt > limit && isBot) policy.expiresAt = iso(limit)
    }

    return { name, prompt, schedule, scheduleChanged, policy, origin }
  }

  async create(actor, input = {}) {
    this.authorize(actor, 'create')
    const botId = actor?.kind === 'bot' ? actor.botId : String(input.botId ?? '')
    const bot = this.store.bot(botId)
    if (!bot) throw new RoutineError('unknown_bot', 'Unknown Bot.')
    const now = new Date()
    const enabled = input.enabled !== false
    const id = newId('routine')
    const draft = this.#prepare({ actor, bot, input, existing: undefined, now })
    if (actor?.kind === 'bot' && enabled && this.#activeCount(bot.id) >= this.settings.maxPerBot) {
      throw new RoutineError('quota_exceeded', `You already have ${this.settings.maxPerBot} active scheduled tasks; remove or pause one first.`)
    }
    const next = nextRun(draft.schedule, now, id)
    if (next === undefined) throw new RoutineError('invalid_schedule', 'Invalid cron expression. Use five fields, e.g. "0 9 * * 1-5".')
    const routine = await this.store.mutate((state) => {
      const created = {
        id,
        botId: bot.id,
        name: draft.name,
        kind: 'agent',
        prompt: draft.prompt,
        cron: legacyCronField(draft.schedule),
        schedule: draft.schedule,
        enabled,
        origin: draft.origin,
        policy: draft.policy,
        nextAt: enabled ? next.toISOString() : undefined,
        lastRunAt: undefined,
        lastStatus: '',
        lastError: '',
        runCount: 0,
        consecutiveFailures: 0,
        pausedReason: '',
        lastAlertAt: '',
        lastAlertKey: '',
        namedSessionId: '',
        runSessions: [],
        budget: { day: '', count: 0 },
        createdAt: iso(now),
        updatedAt: iso(now),
      }
      state.routines.push(created)
      return created
    })
    this.#changed()
    return routine
  }

  async update(actor, routineId, patch = {}) {
    const existing = this.get(actor, routineId)
    this.authorize(actor, 'update', existing)
    const bot = actor?.kind === 'user' && patch.botId !== undefined && String(patch.botId) !== ''
      ? this.store.bot(String(patch.botId))
      : this.store.bot(existing.botId)
    if (!bot) throw new RoutineError('unknown_bot', 'Unknown Bot.')
    const now = new Date()
    const draft = this.#prepare({ actor, bot, input: patch, existing, now })
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled !== false
    const reenabled = enabled && !existing.enabled
    if (actor?.kind === 'bot' && enabled && this.#activeCount(bot.id, existing.id) >= this.settings.maxPerBot) {
      throw new RoutineError('quota_exceeded', `You already have ${this.settings.maxPerBot} active scheduled tasks; remove or pause one first.`)
    }
    if (reenabled) this.#checkResumable(actor, existing, draft.policy, now)
    const recompute = draft.scheduleChanged || reenabled
    let next = existing.nextAt ? new Date(existing.nextAt) : undefined
    if (enabled && recompute) {
      next = nextRun(draft.schedule, now, existing.id)
      if (next === undefined) throw new RoutineError('invalid_schedule', 'Invalid cron expression. Use five fields, e.g. "0 9 * * 1-5".')
    }
    const updated = await this.store.mutate((state) => {
      const stored = state.routines.find(item => item.id === routineId)
      if (!stored) throw new RoutineError('not_found', 'Unknown Routine.')
      stored.botId = bot.id
      stored.name = draft.name
      stored.prompt = draft.prompt
      stored.schedule = draft.schedule
      stored.cron = legacyCronField(draft.schedule)
      stored.policy = draft.policy
      stored.enabled = enabled
      stored.nextAt = enabled ? next?.toISOString() : undefined
      if (reenabled) {
        stored.pausedReason = ''
        stored.consecutiveFailures = 0
      }
      if (!enabled && existing.enabled && stored.pausedReason === '') stored.pausedReason = 'paused'
      stored.updatedAt = iso(now)
      return stored
    })
    this.#changed()
    return updated
  }

  /** Expired Bot tasks must be renewed by a human; the user's own resume renews automatically. */
  #checkResumable(actor, existing, policy, now) {
    const expiresAt = Date.parse(policy.expiresAt ?? '')
    if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) return
    if (actor?.kind === 'bot') {
      throw new RoutineError('expired', 'This task has expired and only the user can renew it.')
    }
    const days = this.settings.botExpiryDays > 0 ? this.settings.botExpiryDays : 30
    policy.expiresAt = iso(now.getTime() + days * 86_400_000)
  }

  async setEnabled(actor, routineId, enabled) {
    const existing = this.get(actor, routineId)
    this.authorize(actor, enabled ? 'resume' : 'pause', existing)
    return this.update(actor, routineId, { enabled: enabled === true })
  }

  /** Human renewal of an expiring task: extend by the configured days and re-enable it. */
  async renew(routineId, days) {
    this.get({ kind: 'user' }, routineId)
    const span = Number.isFinite(Number(days)) && Number(days) > 0
      ? Number(days)
      : (this.settings.botExpiryDays > 0 ? this.settings.botExpiryDays : 30)
    const expiresAt = iso(Date.now() + span * 86_400_000)
    return this.update({ kind: 'user' }, routineId, { enabled: true, policy: { expiresAt } })
  }

  async remove(actor, routineId) {
    const existing = this.get(actor, routineId)
    this.authorize(actor, 'remove', existing)
    await this.store.mutate((state) => {
      state.routines = state.routines.filter(routine => routine.id !== routineId)
    })
    await this.runs.remove(routineId).catch(() => undefined)
    this.#changed()
    return { routineId }
  }

  /** Drop every task of a Bot (used when the Bot is deleted). */
  async removeForBot(botId) {
    const ids = this.store.state.routines.filter(routine => routine.botId === botId).map(routine => routine.id)
    if (ids.length === 0) return []
    await this.store.mutate((state) => {
      state.routines = state.routines.filter(routine => routine.botId !== botId)
    })
    for (const id of ids) await this.runs.remove(id).catch(() => undefined)
    this.#changed()
    return ids
  }
}
