/**
 * Routine data model: normalization of stored records (including legacy `{ cron }` records),
 * default policy, and the `settings.routines` limits.
 */
import { legacyCronField, normalizeSchedule } from './schedule.js'

export const ROUTINE_SESSION_MODES = ['fresh', 'named', 'primary']
export const ROUTINE_OVERLAP = ['skip', 'queue', 'terminate']
export const ROUTINE_MISFIRE = ['skip', 'run_once']

export const DEFAULT_ROUTINE_SETTINGS = Object.freeze({
  /** Active (enabled) tasks per Bot. */
  maxPerBot: 10,
  /** Shortest allowed gap between two fires of one Bot-created task. */
  minIntervalMs: 5 * 60_000,
  /** Runs per Bot per local day, silent runs included. */
  maxRunsPerDay: 48,
  /** Bot-created recurring tasks pause after this many days unless renewed (0 = never). */
  botExpiryDays: 30,
  /** Consecutive failed runs before a task is paused automatically. */
  autoPauseAfter: 5,
  /** Routine runs allowed to execute at the same time, host-wide. */
  maxConcurrent: 2,
  maxPromptChars: 4000,
  /** Whether a Bot may edit or delete tasks a human created for it. */
  botEditUserTasks: false,
  /** Fresh-session records kept per task before the oldest are forgotten. */
  keepRunSessions: 20,
  /** Run history entries kept per task. */
  keepRuns: 50,
})

const clampInt = (value, min, max, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

export const normalizeRoutineSettings = (input) => {
  const defaults = DEFAULT_ROUTINE_SETTINGS
  const source = input && typeof input === 'object' ? input : {}
  return {
    maxPerBot: clampInt(source.maxPerBot, 1, 200, defaults.maxPerBot),
    minIntervalMs: clampInt(source.minIntervalMs, 1000, 86_400_000, defaults.minIntervalMs),
    maxRunsPerDay: clampInt(source.maxRunsPerDay, 1, 10_000, defaults.maxRunsPerDay),
    botExpiryDays: clampInt(source.botExpiryDays, 0, 3650, defaults.botExpiryDays),
    autoPauseAfter: clampInt(source.autoPauseAfter, 1, 100, defaults.autoPauseAfter),
    maxConcurrent: clampInt(source.maxConcurrent, 1, 16, defaults.maxConcurrent),
    maxPromptChars: clampInt(source.maxPromptChars, 100, 100_000, defaults.maxPromptChars),
    botEditUserTasks: source.botEditUserTasks === true,
    keepRunSessions: clampInt(source.keepRunSessions, 1, 200, defaults.keepRunSessions),
    keepRuns: clampInt(source.keepRuns, 5, 1000, defaults.keepRuns),
  }
}

export const defaultPolicy = (session = 'fresh') => ({
  session,
  overlap: 'skip',
  misfire: 'run_once',
  graceMs: 3_600_000,
  timeoutMs: 15 * 60_000,
  retry: { transientMax: 3, delaysMs: [30_000, 60_000, 300_000] },
  backoffMs: [30_000, 60_000, 300_000, 900_000, 3_600_000],
  deliver: 'announce',
  allowTools: [],
  memorySync: false,
  repeat: null,
  expiresAt: null,
  deleteAfterRun: false,
})

const numberList = (value, fallback) => {
  if (!Array.isArray(value)) return fallback.slice()
  const list = value.map(Number).filter(item => Number.isFinite(item) && item >= 0).slice(0, 12)
  return list.length > 0 ? list : fallback.slice()
}

const isoOrNull = (value) => {
  if (typeof value !== 'string' || value === '') return null
  return Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null
}

export const normalizeDeliver = (value) => {
  const text = String(value ?? 'announce').trim()
  if (text === 'none' || text === 'announce') return text
  if (/^room:.+/.test(text)) return text
  return 'announce'
}

/** Merge a (possibly partial / untrusted) policy over the defaults, clamping every field. */
export const normalizePolicy = (input, base = defaultPolicy()) => {
  const source = input && typeof input === 'object' ? input : {}
  const retry = source.retry && typeof source.retry === 'object' ? source.retry : {}
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
  return {
    session: pick(source.session, ROUTINE_SESSION_MODES, base.session),
    overlap: pick(source.overlap, ROUTINE_OVERLAP, base.overlap),
    misfire: pick(source.misfire, ROUTINE_MISFIRE, base.misfire),
    graceMs: clampInt(source.graceMs, 0, 7 * 86_400_000, base.graceMs),
    timeoutMs: clampInt(source.timeoutMs, 5000, 15 * 60_000, base.timeoutMs),
    retry: {
      transientMax: clampInt(retry.transientMax, 0, 10, base.retry.transientMax),
      delaysMs: numberList(retry.delaysMs, base.retry.delaysMs),
    },
    backoffMs: numberList(source.backoffMs, base.backoffMs),
    deliver: source.deliver === undefined ? base.deliver : normalizeDeliver(source.deliver),
    allowTools: Array.isArray(source.allowTools)
      ? [...new Set(source.allowTools.map(item => String(item).trim()).filter(Boolean))].slice(0, 50)
      : base.allowTools.slice(),
    memorySync: source.memorySync === undefined ? base.memorySync : source.memorySync === true,
    repeat: source.repeat === undefined
      ? base.repeat
      : (Number.isFinite(Number(source.repeat)) && Number(source.repeat) > 0 ? Math.trunc(Number(source.repeat)) : null),
    expiresAt: source.expiresAt === undefined ? base.expiresAt : isoOrNull(source.expiresAt),
    deleteAfterRun: source.deleteAfterRun === undefined ? base.deleteAfterRun : source.deleteAfterRun === true,
  }
}

const normalizeOrigin = (origin) => {
  const source = origin && typeof origin === 'object' ? origin : {}
  return {
    kind: source.kind === 'bot' ? 'bot' : 'user',
    botId: typeof source.botId === 'string' ? source.botId : '',
    chat: typeof source.chat === 'string' ? source.chat : '',
  }
}

const normalizeRunSessions = (list) => (Array.isArray(list)
  ? list
    .filter(item => item && typeof item.sessionId === 'string' && item.sessionId !== '')
    .map(item => ({
      sessionId: item.sessionId,
      runId: typeof item.runId === 'string' ? item.runId : '',
      at: typeof item.at === 'string' ? item.at : '',
    }))
  : [])

/**
 * Normalize one stored routine. Legacy records (`{ cron }` only, no `policy`) keep the old
 * behaviour: they run inside the Bot's primary chat (`policy.session = 'primary'`).
 */
export const normalizeRoutine = (routine) => {
  if (!routine || typeof routine.id !== 'string' || typeof routine.botId !== 'string') return undefined
  const legacy = routine.policy === undefined && routine.schedule === undefined
  let schedule
  try {
    schedule = normalizeSchedule(
      routine.schedule ?? { kind: 'cron', cron: typeof routine.cron === 'string' ? routine.cron : '0 9 * * *' },
      { tz: routine.schedule?.tz },
    )
  } catch (_error) {
    // A stored schedule that no longer parses must not crash loading; keep the record paused.
    schedule = { kind: 'cron', cron: typeof routine.cron === 'string' ? routine.cron : '0 9 * * *', tz: routine.schedule?.tz || 'UTC', exact: false }
  }
  const policy = normalizePolicy(routine.policy, defaultPolicy(legacy ? 'primary' : 'fresh'))
  return {
    id: routine.id,
    botId: routine.botId,
    name: typeof routine.name === 'string' ? routine.name : 'Routine',
    kind: 'agent',
    prompt: typeof routine.prompt === 'string' ? routine.prompt : '',
    cron: legacyCronField(schedule),
    schedule,
    enabled: routine.enabled !== false,
    origin: normalizeOrigin(routine.origin),
    policy,
    lastRunAt: typeof routine.lastRunAt === 'string' ? routine.lastRunAt : undefined,
    nextAt: typeof routine.nextAt === 'string' ? routine.nextAt : undefined,
    lastStatus: typeof routine.lastStatus === 'string' ? routine.lastStatus : '',
    lastError: typeof routine.lastError === 'string' ? routine.lastError : '',
    runCount: clampInt(routine.runCount, 0, Number.MAX_SAFE_INTEGER, 0),
    consecutiveFailures: clampInt(routine.consecutiveFailures, 0, 100_000, 0),
    pausedReason: typeof routine.pausedReason === 'string' ? routine.pausedReason : '',
    lastAlertAt: typeof routine.lastAlertAt === 'string' ? routine.lastAlertAt : '',
    lastAlertKey: typeof routine.lastAlertKey === 'string' ? routine.lastAlertKey : '',
    namedSessionId: typeof routine.namedSessionId === 'string' ? routine.namedSessionId : '',
    runSessions: normalizeRunSessions(routine.runSessions),
    budget: {
      day: typeof routine.budget?.day === 'string' ? routine.budget.day : '',
      count: clampInt(routine.budget?.count, 0, 1_000_000, 0),
    },
    createdAt: typeof routine.createdAt === 'string' ? routine.createdAt : new Date().toISOString(),
    updatedAt: typeof routine.updatedAt === 'string' ? routine.updatedAt : (typeof routine.createdAt === 'string' ? routine.createdAt : new Date().toISOString()),
  }
}

/** Local calendar day key (host zone) used for the per-Bot daily run budget. */
export const dayKey = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
