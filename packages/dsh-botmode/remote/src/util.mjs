/**
 * 通用工具：base64url、原子写、日志、HTTP 小工具。
 */
import { createHash, randomBytes as nodeRandom, timingSafeEqual } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const b64u = (buf) => Buffer.from(buf).toString('base64url')
export const unb64u = (str) => Buffer.from(String(str), 'base64url')
export const randomBytes = (n) => nodeRandom(n)
export const randomToken = (n = 32) => b64u(nodeRandom(n))
export const sha256 = (buf) => createHash('sha256').update(buf).digest()

export function safeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a))
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`waitFor ${label} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`)
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 写入临时文件 → fsync → rename，避免半截 JSON。 */
export function writeJsonAtomic(path, value, { mode = 0o600 } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`)
  const payload = `${JSON.stringify(value, null, 2)}\n`
  const fd = openSync(tmp, 'w', mode)
  try {
    writeSync(fd, payload)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (error) {
    if (process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'EEXIST')) {
      try { rmSync(path, { force: true }) } catch {}
      renameSync(tmp, path)
    } else {
      try { rmSync(tmp, { force: true }) } catch {}
      throw error
    }
  }
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

export function createLogger({ stream = process.stdout, name = 'dsh-remote' } = {}) {
  const write = (level, message, fields) => {
    const entry = { ts: new Date().toISOString(), level, msg: message, ...(fields ?? {}) }
    stream.write(`${JSON.stringify(entry)}\n`)
  }
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (prefix, extra) => createLogger({ stream, name: `${name}/${prefix}`, ...extra }),
  }
}

export function parseDuration(text, fallbackMs) {
  if (typeof text === 'number' && Number.isFinite(text)) return text
  if (typeof text !== 'string' || text.trim() === '') return fallbackMs
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(text.trim())
  if (!match) return fallbackMs
  const value = Number(match[1])
  const unit = (match[2] ?? 'ms').toLowerCase()
  const factor = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[unit] ?? 1
  return Math.round(value * factor)
}

/** 逐条解析 Set-Cookie，返回 [{name, value, maxAge, expires, secure, httpOnly, path}]。 */
export function parseSetCookie(headers) {
  const list = headers['set-cookie']
  if (!list) return []
  const raw = Array.isArray(list) ? list : [list]
  return raw.map((line) => {
    const parts = String(line).split(';')
    const [pair, ...attrs] = parts
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    const out = { name, value, raw: String(line) }
    for (const attr of attrs) {
      const at = attr.indexOf('=')
      const key = (at === -1 ? attr : attr.slice(0, at)).trim().toLowerCase()
      const val = at === -1 ? '' : attr.slice(at + 1).trim()
      if (key === 'max-age') out.maxAge = Number(val)
      else if (key === 'expires') out.expires = Date.parse(val)
      else if (key === 'secure') out.secure = true
      else if (key === 'httponly') out.httpOnly = true
      else if (key === 'path') out.path = val
    }
    return out
  })
}

export function formatCookie(cookie) {
  return `${cookie.name}=${cookie.value}`
}

/** 极简 HTTP 请求（GET/POST），返回 {status, headers, body}。 */
export async function httpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 15_000, redirect = 'manual' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method, headers, body, redirect, signal: controller.signal })
    const buffer = Buffer.from(await response.arrayBuffer())
    const out = {}
    for (const [key, value] of response.headers.entries()) {
      if (out[key] === undefined) out[key] = value
      else out[key] = [].concat(out[key], value)
    }
    return { status: response.status, headers: out, body: buffer }
  } catch (error) {
    const cause = error?.cause?.message ?? error?.cause?.code
    throw new Error(`request ${url} failed: ${String(error?.message ?? error)}${cause ? ` (${String(cause)})` : ''}`)
  } finally {
    clearTimeout(timer)
  }
}