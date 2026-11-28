/**
 * Schedule model for Routines: `cron` | `every` | `at`, with IANA time zones.
 *
 * Accepts friendly shorthands (what a Bot or a form is likely to produce) as well as the
 * structured object, and always normalizes to the structured form:
 *
 *   every 30m | every 2 hours | every 1d
 *   daily 09:00 | weekdays 09:00 | weekly mon 10:00 | monthly 1 08:30
 *   at 2026-12-01 09:00 | at 2026-12-01T09:00:00+08:00
 *   0 9 * * 1-5                       (raw five-field cron)
 */
import { createHash } from 'node:crypto'
import {
  defaultTimeZone,
  isValidTimeZone,
  nextCronTime,
  parseCron,
  describeCron,
  wallToInstant,
} from '../cron.js'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Top-of-hour cron jobs are spread by a stable per-job offset of up to this many ms. */
export const STAGGER_WINDOW_MS = 5 * MINUTE_MS

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

const fail = (message) => { throw new Error(message) }

const parseClock = (text) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

const parseDuration = (text) => {
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|s|sec|secs|second|seconds)$/i
    .exec(String(text ?? '').trim())
  if (!match) return undefined
  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  if (unit.startsWith('s')) return Math.round(value * 1000)
  if (unit.startsWith('m')) return Math.round(value * MINUTE_MS)
  if (unit.startsWith('h')) return Math.round(value * HOUR_MS)
  return Math.round(value * DAY_MS)
}

/** Parse `YYYY-MM-DD[ T]HH:MM[:SS][offset]`; naive values are read in `zone`. */
const parseAt = (text, zone) => {
  const raw = String(text ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(raw)
  if (!match) return undefined
  const [, year, month, day, hour = '0', minute = '0', second = '0', offset] = match
  if (offset) {
    const parsed = Date.parse(raw.replace(' ', 'T'))
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  if (!Number.isFinite(wall)) return undefined
  // Reject impossible calendar dates such as 2026-02-31.
  const check = new Date(wall)
  if (check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(day)) return undefined
  return wallToInstant(wall, zone)
}

const cronFor = ({ minute, hour }, dom = '*', dow = '*') => `${minute} ${hour} ${dom} * ${dow}`

/**
 * Normalize a shorthand string or a structured object into
 * `{ kind, cron?, everyMs?, at?, tz, exact, anchorAt? }`. Throws a readable Error on bad input.
 */
export const normalizeSchedule = (input, options = {}) => {
  const now = options.now instanceof Date ? options.now : new Date()
  let source = input
  if (typeof source === 'string') source = parseShorthand(source)
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    fail('Schedule is required. Use e.g. "every 30m", "daily 09:00", "weekdays 09:00", "at 2026-12-01 09:00" or a five-field cron.')
  }
  const zone = typeof source.tz === 'string' && source.tz.trim() !== ''
    ? source.tz.trim()
    : (options.tz || defaultTimeZone())
  if (!isValidTimeZone(zone)) fail(`Unknown time zone "${zone}". Use an IANA name such as "Asia/Shanghai".`)
  const kind = String(source.kind ?? (source.cron ? 'cron' : source.everyMs ? 'every' : source.at ? 'at' : ''))

  if (kind === 'cron') {
    const cron = String(source.cron ?? '').trim().replace(/\s+/g, ' ')
    if (parseCron(cron) === undefined || nextCronTime(cron, now, zone) === undefined) {
      fail('Invalid cron expression. Use five fields, e.g. "0 9 * * 1-5".')
    }
    return { kind: 'cron', cron, tz: zone, exact: source.exact === true }
  }
  if (kind === 'every') {
    const everyMs = typeof source.everyMs === 'number' ? source.everyMs : parseDuration(source.every)
    if (!Number.isFinite(everyMs) || everyMs < 1000) fail('Invalid interval. Use e.g. "every 30m".')
    const anchor = Date.parse(String(source.anchorAt ?? ''))
    return {
      kind: 'every',
      everyMs: Math.round(everyMs),
      tz: zone,
      exact: true,
      anchorAt: new Date(Number.isFinite(anchor) ? anchor : now.getTime()).toISOString(),
    }
  }
  if (kind === 'at') {
    const instant = typeof source.at === 'number' ? source.at : parseAt(source.at, zone) ?? Date.parse(String(source.at ?? ''))
    if (!Number.isFinite(instant)) fail('Invalid time. Use e.g. "at 2026-12-01 09:00".')
    return { kind: 'at', at: new Date(instant).toISOString(), tz: zone, exact: true }
  }
  return fail('Schedule kind must be cron, every or at.')
}

const parseShorthand = (text) => {
  const raw = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (raw === '') return undefined
  const lower = raw.toLowerCase()
  let match = /^every (.+)$/.exec(lower)
  if (match) {
    const everyMs = parseDuration(match[1])
    return everyMs === undefined ? undefined : { kind: 'every', everyMs }
  }
  match = /^(daily|weekdays) (\d{1,2}:\d{2})$/.exec(lower)
  if (match) {
    const clock = parseClock(match[2])
    if (!clock) return undefined
    return { kind: 'cron', cron: cronFor(clock, '*', match[1] === 'weekdays' ? '1-5' : '*') }
  }
  match = /^weekly (sun|mon|tue|wed|thu|fri|sat)[a-z]* (\d{1,2}:\d{2})$/.exec(lower)
  if (match) {
    const clock = parseClock(match[2])
    if (!clock) return undefined
    return { kind: 'cron', cron: cronFor(clock, '*', String(WEEKDAYS[match[1]])) }
  }
  match = /^monthly (\d{1,2}) (\d{1,2}:\d{2})$/.exec(lower)
  if (match) {
    const clock = parseClock(match[2])
    const dom = Number(match[1])
    if (!clock || dom < 1 || dom > 31) return undefined
    return { kind: 'cron', cron: cronFor(clock, String(dom), '*') }
  }
  match = /^at (.+)$/.exec(raw) ?? /^at (.+)$/i.exec(raw)
  if (match) return { kind: 'at', at: match[1] }
  if (raw.split(' ').length === 5) return { kind: 'cron', cron: raw }
  return undefined
}

/** Stable per-job offset (0..5 min, whole seconds) for `minute=0` cron jobs unless `exact`. */
export const staggerMs = (schedule, id = '') => {
  if (!schedule || schedule.kind !== 'cron' || schedule.exact === true) return 0
  const rule = parseCron(schedule.cron)
  if (!rule || rule.minutes.size !== 1 || !rule.minutes.has(0)) return 0
  const digest = createHash('sha1').update(String(id)).digest()
  return (digest.readUInt32BE(0) % (STAGGER_WINDOW_MS / 1000)) * 1000
}

/** Next fire time strictly after `from` (a Date), or undefined when the schedule is exhausted. */
export const nextRun = (schedule, from = new Date(), id = '') => {
  if (!schedule) return undefined
  if (schedule.kind === 'cron') {
    const offset = staggerMs(schedule, id)
    const base = nextCronTime(schedule.cron, new Date(from.getTime() - offset), schedule.tz)
    return base ? new Date(base.getTime() + offset) : undefined
  }
  if (schedule.kind === 'every') {
    const anchor = Date.parse(schedule.anchorAt)
    const step = schedule.everyMs
    if (!Number.isFinite(anchor) || !Number.isFinite(step) || step <= 0) return undefined
    const elapsed = from.getTime() - anchor
    const steps = elapsed < 0 ? 0 : Math.floor(elapsed / step) + 1
    return new Date(anchor + steps * step)
  }
  if (schedule.kind === 'at') {
    const at = Date.parse(schedule.at)
    return Number.isFinite(at) && at > from.getTime() ? new Date(at) : undefined
  }
  return undefined
}

/** The next `count` fire times, for previews shown right after a task is created. */
export const nextRuns = (schedule, count = 3, from = new Date(), id = '') => {
  const result = []
  let cursor = from
  for (let index = 0; index < count; index += 1) {
    const next = nextRun(schedule, cursor, id)
    if (!next) break
    result.push(next)
    cursor = next
  }
  return result
}

/** Smallest gap between consecutive fires, sampled; `Infinity` for one-shot schedules. */
export const minGapMs = (schedule, from = new Date()) => {
  if (!schedule) return Infinity
  if (schedule.kind === 'every') return schedule.everyMs
  if (schedule.kind === 'at') return Infinity
  const times = nextRuns({ ...schedule, exact: true }, 8, from)
  let gap = Infinity
  for (let index = 1; index < times.length; index += 1) {
    gap = Math.min(gap, times[index].getTime() - times[index - 1].getTime())
  }
  return gap
}

export const describeSchedule = (schedule) => {
  if (!schedule) return 'invalid schedule'
  if (schedule.kind === 'cron') return describeCron(schedule.cron)
  if (schedule.kind === 'every') {
    const ms = schedule.everyMs
    if (ms % DAY_MS === 0) return `every ${ms / DAY_MS}d`
    if (ms % HOUR_MS === 0) return `every ${ms / HOUR_MS}h`
    if (ms % MINUTE_MS === 0) return `every ${ms / MINUTE_MS}m`
    return `every ${Math.round(ms / 1000)}s`
  }
  return `at ${schedule.at}`
}

/** Legacy flat `cron` field kept in sync for older UI code: the expression, or a readable summary. */
export const legacyCronField = (schedule) => (schedule?.kind === 'cron' ? schedule.cron : describeSchedule(schedule))
