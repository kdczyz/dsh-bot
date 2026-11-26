/**
 * A small five-field cron evaluator.
 *
 * Supported per field: `*`, `n`, `a-b`, `a-b/step`, `* /step`, comma lists, and
 * three-letter weekday names. Fields are minute, hour, day-of-month, month,
 * day-of-week. The evaluator walks local wall-clock minutes forward with a
 * bounded hard stop, so a malformed or impossible rule simply never fires
 * instead of spinning.
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

const matches = (rule, date) => {
  if (!rule.minutes.has(date.getMinutes())) return false
  if (!rule.hours.has(date.getHours())) return false
  if (!rule.months.has(date.getMonth() + 1)) return false
  const domRestricted = rule.days.size !== 31
  const dowRestricted = rule.weekdays.size !== 7
  const dom = rule.days.has(date.getDate())
  const dow = rule.weekdays.has(date.getDay())
  // Standard cron semantics: when both day fields are restricted, either may match.
  if (domRestricted && dowRestricted) return dom || dow
  if (domRestricted) return dom
  if (dowRestricted) return dow
  return true
}

/** Next local-wall-clock occurrence strictly after `from`, or undefined when none is found. */
export const nextCronTime = (expression, from = new Date()) => {
  const rule = parseCron(expression)
  if (rule === undefined) return undefined
  const start = new Date(from.getTime())
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)
  // Five years of minutes is a generous bound for any plausible rule.
  for (let index = 0; index < 5 * 366 * 24 * 60; index += 1) {
    if (matches(rule, start)) return new Date(start.getTime())
    start.setMinutes(start.getMinutes() + 1)
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