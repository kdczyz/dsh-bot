/**
 * A small five-field cron evaluator.
 *
 * Supported per field: `*`, `n`, `a-b`, `a-b/step`, `* /step`, comma lists, and
 * three-letter weekday names. Fields are minute, hour, day-of-month, month,
 * day-of-week. The evaluator jumps field by field through wall-clock time of a
 * given IANA time zone (default: the host's local zone) with a bounded hard
 * stop, so a malformed or impossible rule simply never fires instead of
 * spinning.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const boundsOf = (index) => {
  if (index === 0) return [0, 59]
  if (index === 1) return [0, 23]
  if (index === 2) return [1, 31]
  if (index === 3) return [1, 12]
  return [0, 7]
}

const parseValue = (token, index) => {
  const lower = token.toLowerCase()
  if (index === 3 && MONTHS.includes(lower)) return MONTHS.indexOf(lower) + 1
  if (index === 4 && DAYS.includes(lower)) return DAYS.indexOf(lower)
  const value = Number(lower)
  return Number.isInteger(value) ? value : undefined
}

const parseField = (text, index) => {
  const [min, max] = boundsOf(index)
  const allowed = new Set()
  for (const part of String(text).split(',')) {
    const [rangeText, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step <= 0) return undefined
    let from
    let to
    if (rangeText === '*') {
      from = min
      to = max
    } else if (rangeText.includes('-')) {
      const [a, b] = rangeText.split('-')
      from = parseValue(a, index)
      to = parseValue(b, index)
    } else {
      from = parseValue(rangeText, index)
      to = from
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) return undefined
    if (from < min || to > max || from > to) return undefined
    for (let value = from; value <= to; value += step) {
      // Standard POSIX cron treats both 0 and 7 as Sunday.
      allowed.add(index === 4 && value === 7 ? 0 : value)
    }
  }
  return allowed.size === 0 ? undefined : allowed
}

export const parseCron = (expression) => {
  const fields = String(expression ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const parsed = fields.map(parseField)
  if (parsed.some(field => field === undefined)) return undefined
  return { minutes: parsed[0], hours: parsed[1], days: parsed[2], months: parsed[3], weekdays: parsed[4] }
}

const DAY_MS = 86_400_000

const formatters = new Map()
const formatterOf = (zone) => {
  let formatter = formatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(zone, formatter)
  }
  return formatter
}

export const defaultTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch (_error) {
    return 'UTC'
  }
}

export const isValidTimeZone = (zone) => {
  if (typeof zone !== 'string' || zone.trim() === '') return false
  try {
    formatterOf(zone.trim())
    return true
  } catch (_error) {
    return false
  }
}

/** Wall-clock of an instant in `zone`, expressed as a "fake UTC" millisecond value (second precision). */
export const wallClockMs = (instantMs, zone) => {
  const parts = {}
  for (const part of formatterOf(zone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

const offsetAt = (instantMs, zone) => wallClockMs(instantMs, zone) - Math.floor(instantMs / 1000) * 1000

/**
 * Convert a wall-clock time in `zone` back to an instant.
 * - A repeated wall time (DST fall-back) resolves to its first occurrence.
 * - A skipped wall time (DST spring-forward gap) resolves to the first valid minute after the gap.
 */
export const wallToInstant = (wallMs, zone) => {
  const earlier = wallMs - offsetAt(wallMs - DAY_MS, zone)
  const later = wallMs - offsetAt(wallMs + DAY_MS, zone)
  const exact = [...new Set([earlier, later])]
    .filter(candidate => wallClockMs(candidate, zone) === wallMs)
    .sort((a, b) => a - b)
  if (exact.length > 0) return exact[0]
  let lo = Math.min(earlier, later)
  let hi = Math.max(earlier, later)
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2)
    if (wallClockMs(mid, zone) >= wallMs) hi = mid
    else lo = mid
  }
  return Math.ceil(hi / 60_000) * 60_000
}

const dayMatches = (rule, date) => {
  const domRestricted = rule.days.size !== 31
  const dowRestricted = rule.weekdays.size !== 7
  const dom = rule.days.has(date.getUTCDate())
  const dow = rule.weekdays.has(date.getUTCDay())
  // Standard cron semantics: when both day fields are restricted, either may match.
  if (domRestricted && dowRestricted) return dom || dow
  if (domRestricted) return dom
  if (dowRestricted) return dow
  return true
}

/** Field-jumping search in wall-clock space (fake UTC); never spins on an impossible rule. */
const nextWallMatch = (rule, startWallMs) => {
  const limit = startWallMs + 9 * 366 * DAY_MS
  let t = startWallMs
  for (let guard = 0; t < limit && guard < 200_000; guard += 1) {
    const d = new Date(t)
    const y = d.getUTCFullYear()
    const m = d.getUTCMonth()
    const day = d.getUTCDate()
    if (!rule.months.has(m + 1)) { t = Date.UTC(y, m + 1, 1); continue }
    if (!dayMatches(rule, d)) { t = Date.UTC(y, m, day + 1); continue }
    if (!rule.hours.has(d.getUTCHours())) { t = Date.UTC(y, m, day, d.getUTCHours() + 1); continue }
    if (!rule.minutes.has(d.getUTCMinutes())) { t += 60_000; continue }
    return t
  }
  return undefined
}

/**
 * Next occurrence strictly after `from` in `zone` (defaults to the host's local zone), or
 * undefined when none is found. Wall-clock semantics: a time skipped by a DST jump fires at the
 * first valid minute after the gap; a repeated time fires only once.
 */
export const nextCronTime = (expression, from = new Date(), zone = undefined) => {
  const rule = parseCron(expression)
  if (rule === undefined) return undefined
  const resolvedZone = typeof zone === 'string' && zone.trim() !== '' ? zone.trim() : defaultTimeZone()
  if (!isValidTimeZone(resolvedZone)) return undefined
  const fromMs = from.getTime()
  let wall = Math.floor(wallClockMs(fromMs, resolvedZone) / 60_000) * 60_000 + 60_000
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const matched = nextWallMatch(rule, wall)
    if (matched === undefined) return undefined
    const instant = wallToInstant(matched, resolvedZone)
    if (instant > fromMs) return new Date(instant)
    wall = matched + 60_000
  }
  return undefined
}

export const describeCron = (expression) => {
  const rule = parseCron(expression)
  if (rule === undefined) return 'invalid cron'
  const pad = (value) => String(value).padStart(2, '0')
  const minutes = [...rule.minutes].sort((a, b) => a - b)
  const hours = [...rule.hours].sort((a, b) => a - b)
  if (minutes.length === 1 && hours.length === 1) return `daily at ${pad(hours[0])}:${pad(minutes[0])}`
  return expression
}