/**
 * 上游 DSH web 发现与自动续期。
 *
 * DSH 每个 web 进程只有一枚内存态 launch token，且浏览器 cookie 有 30 天绝对寿命。
 * 本模块：
 *   1) 从 dsh web 日志（或显式配置）发现 端口 + launch token；
 *   2) 用 launch token 换取上游会话 cookie，由 relay 统一持有并注入；
 *   3) cookie 临近过期或上游返回 401 时自动重新换取（= token 自动续期，浏览器无感）；
 *   4) 检测 dsh 重启（日志出现新 token / 进程端口变化）后自动重新绑定。
 */
import { open, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readdir, readFile as readFileSyncSafe } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { formatCookie, httpRequest, parseSetCookie, readJson, sleep } from './util.mjs'

const TOKEN_RE = /http:\/\/([0-9A-Za-z._-]+|\[[0-9a-fA-F:]+\]):(\d+)\/\?token=([A-Za-z0-9_-]{16,})/g
const COOKIE_PREFIX = 'dsh-auth-'

function normalizeConnectHost(raw) {
  const cleaned = String(raw ?? '').trim().replace(/^\[|\]$/gu, '')
  if (!cleaned || cleaned === '0.0.0.0' || cleaned === '::') return '127.0.0.1'
  return cleaned
}

function probeTcp(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: normalizeConnectHost(host), port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function readTail(path, bytes = 4 * 1024 * 1024) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const start = Math.max(0, info.size - bytes)
    const length = info.size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

export function parseLaunchEndpoint(text) {
  let last = null
  for (const match of String(text).matchAll(TOKEN_RE)) {
    last = {
      host: normalizeConnectHost(match[1]),
      port: Number(match[2]),
      launchToken: match[3],
    }
  }
  return last
}

export function parseLaunchLine(text) {
  const found = parseLaunchEndpoint(text)
  return found ? { port: found.port, launchToken: found.launchToken } : null
}

export class Upstream {
  constructor({ config, logger }) {
    this.config = config
    this.logger = logger
    this.info = {
      host: normalizeConnectHost(config.upstream.host),
      port: config.upstream.port ?? null,
      launchToken: config.upstream.launchToken ?? null,
      logPath: config.upstream.log ?? null,
      cookie: null,
      cookieExpiresAt: null,
      cookieRefreshedAt: null,
      lastError: null,
      lastDiscoverAt: null,
      discoveries: 0,
      bootstraps: 0,
    }
    this.logCache = new Map() // logPath -> { mtimeMs, size, found }
    this.refreshing = null
    this.timer = null
    this.stopped = false
  }

  get origin() {
    return `http://${this.info.host}:${this.info.port}`
  }

  get ready() {
    return Boolean(this.info.port && this.info.cookie)
  }

  async start() {
    await this.ensure({ force: true }).catch((error) => {
      this.info.lastError = String(error?.message ?? error)
      this.logger?.warn?.('upstream bootstrap failed; will retry', { error: this.info.lastError })
    })
    this.timer = setInterval(() => {
      this.ensure().catch((error) => {
        this.info.lastError = String(error?.message ?? error)
        this.logger?.warn?.('upstream refresh failed', { error: this.info.lastError })
      })
    }, this.config.upstream.discoverIntervalMs)
    this.timer.unref?.()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  /** 串行化：同一时刻只跑一次发现/续期。 */
  ensure({ force = false } = {}) {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.#ensureInner({ force }).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  async #ensureInner({ force }) {
    if (this.stopped) return
    const discovered = await this.#discover()
    const nextHost = discovered.host ? normalizeConnectHost(discovered.host) : this.info.host
    const hostChanged = nextHost !== this.info.host
    const portChanged = Boolean(discovered.port) && discovered.port !== this.info.port
    const tokenChanged = Boolean(discovered.launchToken) && discovered.launchToken !== this.info.launchToken
    if (discovered.host) this.info.host = nextHost
    if (discovered.port) this.info.port = discovered.port
    if (discovered.launchToken) this.info.launchToken = discovered.launchToken
    if (discovered.logPath) this.info.logPath = discovered.logPath

    // 免日志兜底路径：当宿主 dsh-botmode 直接写入了已鉴权的 upstream-hint.json（如裸跑 dsh web 未重定向日志）
    if (discovered.fromHint && discovered.cookie) {
      const cookieChanged = discovered.cookie !== this.info.cookie
      if (force || hostChanged || portChanged || cookieChanged || !this.info.cookie) {
        this.info.cookie = discovered.cookie
        this.info.cookieExpiresAt = Date.now() + 24 * 3_600_000
        this.info.cookieRefreshedAt = Date.now()
        this.info.bootstraps += 1
        this.info.lastError = null
        this.logger?.info?.('upstream bound via host hint (no log file required)', {
          host: this.info.host,
          port: this.info.port,
          bootstraps: this.info.bootstraps,
        })
      }
      return
    }

    const now = Date.now()
    const skew = this.config.upstream.cookieRenewSkewSeconds * 1000
    const expiring = !this.info.cookieExpiresAt || this.info.cookieExpiresAt - skew < now
    if (!force && !hostChanged && !portChanged && !tokenChanged && !expiring) return

    if (!this.info.port || !this.info.launchToken) {
      throw new Error('未发现 dsh web 端口或 launch token')
    }
    await this.#bootstrap()
  }

  async #readHostHint() {
    const stateDir = this.config?.stateDir
    if (!stateDir) return null
    const hintPath = join(stateDir, 'upstream-hint.json')
    if (!existsSync(hintPath)) return null
    const hint = readJson(hintPath, null)
    const host = normalizeConnectHost(hint?.host)
    const port = Number(hint?.port)
    const cookie = typeof hint?.cookie === 'string' && hint.cookie.trim() ? hint.cookie.trim() : null
    const launchToken = typeof hint?.launchToken === 'string' && hint.launchToken.trim() ? hint.launchToken.trim() : null
    if (!Number.isInteger(port) || port <= 0 || (!cookie && !launchToken)) return null
    if (!(await probeTcp(host, port))) return null
    return {
      host,
      port,
      launchToken,
      cookie,
      fromHint: !launchToken && Boolean(cookie),
      mtimeMs: Number(hint?.updatedAt) || Date.now(),
    }
  }

  async #readLogCandidate(logPath) {
    if (!logPath || !existsSync(logPath)) return null
    try {
      const info = await stat(logPath)
      const cached = this.logCache.get(logPath)
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        return cached.found ? { ...cached.found, mtimeMs: info.mtimeMs, logPath } : null
      }
      const found = parseLaunchEndpoint(await readTail(logPath))
      this.logCache.set(logPath, { mtimeMs: info.mtimeMs, size: info.size, found })
      if (found) {
        this.info.discoveries += 1
        return { ...found, mtimeMs: info.mtimeMs, logPath }
      }
      return null
    } catch (error) {
      this.logger?.warn?.('read upstream log failed', { logPath, error: String(error?.message ?? error) })
      return null
    }
  }

  async #discover() {
    this.info.lastDiscoverAt = Date.now()
    if (this.config.upstream.mode === 'fixed') {
      return {
        host: normalizeConnectHost(this.config.upstream.host),
        port: this.config.upstream.port,
        launchToken: this.config.upstream.launchToken,
      }
    }
    // 显式指定了单一日志文件时严格只读取该日志（兼容自定义部署与测试隔离）。
    if (this.config.upstream.log) {
      const explicit = await this.#readLogCandidate(this.config.upstream.log)
      if (explicit) return explicit
      const procs = await this.#listRunningDshWeb()
      if (procs.length > 0) {
        const newest = procs[0]
        return { host: newest.host, port: newest.port, launchToken: this.info.launchToken }
      }
      return {}
    }

    // 自动检索模式：扫描所有候选日志并与当前存活的 dsh web 进程匹配，绝不新开网关。
    const candidateLogs = Array.isArray(this.config.upstream.logs) ? this.config.upstream.logs : []
    const candidates = []
    for (const logPath of candidateLogs) {
      const item = await this.#readLogCandidate(logPath)
      if (item) candidates.push(item)
    }
    if (candidates.length === 1) {
      if (await probeTcp(candidates[0].host, candidates[0].port)) return candidates[0]
      const hint = await this.#readHostHint()
      return hint ?? candidates[0]
    }
    if (candidates.length > 1) {
      const procs = await this.#listRunningDshWeb()
      const scored = await Promise.all(candidates.map(async (item, index) => {
        const alive = await probeTcp(item.host, item.port)
        const exactProc = procs.some((p) => p.port === item.port && (!p.host || p.host === item.host))
        const hostMatch = procs.some((p) => p.host && p.host === item.host)
        const score = (alive ? 1000 : 0) + (exactProc ? 500 : 0) + (hostMatch ? 100 : 0) - index
        return { item, alive, score }
      }))
      scored.sort((a, b) => (b.score - a.score) || (b.item.mtimeMs - a.item.mtimeMs))
      if (scored[0].alive) return scored[0].item
      const hint = await this.#readHostHint()
      return hint ?? scored[0].item
    }

    const hint = await this.#readHostHint()
    if (hint) return hint

    const procs = await this.#listRunningDshWeb()
    if (procs.length > 0) {
      return { host: procs[0].host, port: procs[0].port, launchToken: this.info.launchToken }
    }
    return {}
  }

  /** 扫描 /proc 找出当前存活的 dsh web 进程（最新优先）。 */
  async #listRunningDshWeb() {
    let entries = []
    try {
      entries = await readdir('/proc')
    } catch {
      return []
    }
    const found = []
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue
      let cmd
      try {
        cmd = (await readFileSyncSafe(`/proc/${entry}/cmdline`)).toString('utf8').split('\0').filter(Boolean)
      } catch {
        continue
      }
      const at = cmd.findIndex((part) => part === 'web')
      if (at === -1 || !cmd.some((part) => part.endsWith('/dsh') || part === 'dsh')) continue
      const hostAt = cmd.indexOf('--host')
      const host = hostAt !== -1 && cmd[hostAt + 1] ? normalizeConnectHost(cmd[hostAt + 1]) : null
      const portAt = cmd.indexOf('--port')
      const rawPort = portAt !== -1 ? Number(cmd[portAt + 1]) : null
      const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : null
      let startedAt = 0
      try {
        startedAt = (await stat(`/proc/${entry}`)).birthtimeMs
      } catch {}
      found.push({ pid: Number(entry), host, port, startedAt })
    }
    found.sort((a, b) => (b.port ? 1 : 0) - (a.port ? 1 : 0) || b.startedAt - a.startedAt)
    return found
  }

  async #bootstrap() {
    const url = `${this.origin}/?token=${encodeURIComponent(this.info.launchToken)}`
    const response = await httpRequest(url, { redirect: 'manual', timeoutMs: 10_000 })
    if (response.status !== 303 && response.status !== 200) {
      throw new Error(`launch token 被拒绝: HTTP ${response.status}`)
    }
    const cookies = parseSetCookie(response.headers).filter(
      (cookie) => cookie.name.startsWith(COOKIE_PREFIX) || (cookie.httpOnly && cookie.maxAge),
    )
    if (cookies.length === 0) {
      if (response.status === 200) {
        // 上游可能直接接受 token（部分版本），退回 URL 注入模式
        this.info.cookie = null
        this.info.cookieExpiresAt = Date.now() + 3_600_000
        this.logger?.warn?.('upstream did not set a session cookie; relying on token injection')
        return
      }
      throw new Error('上游未返回会话 cookie')
    }
    const cookie = cookies[0]
    const maxAgeMs = Number.isFinite(cookie.maxAge) ? cookie.maxAge * 1000 : 30 * 86_400_000
    this.info.cookie = formatCookie(cookie)
    this.info.cookieExpiresAt = Date.now() + maxAgeMs
    this.info.cookieRefreshedAt = Date.now()
    this.info.bootstraps += 1
    this.info.lastError = null
    this.logger?.info?.('upstream cookie refreshed', {
      host: this.info.host,
      port: this.info.port,
      cookie: cookie.name,
      expiresAt: new Date(this.info.cookieExpiresAt).toISOString(),
      bootstraps: this.info.bootstraps,
    })
  }

  /** 上游 401 时调用：立刻重新换取 cookie。 */
  async onUnauthorized() {
    this.logger?.warn?.('upstream returned 401/403; re-bootstrapping')
    await this.ensure({ force: true })
  }

  /** 等待上游可用（用于启动顺序）。 */
  async waitReady({ timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.ready) return true
      await this.ensure().catch(() => {})
      if (this.ready) return true
      await sleep(500)
    }
    return false
  }

  describe() {
    return {
      ...this.info,
      cookie: this.info.cookie ? `${this.info.cookie.split('=')[0]}=<redacted>` : null,
      cookieExpiresAt: this.info.cookieExpiresAt ? new Date(this.info.cookieExpiresAt).toISOString() : null,
      cookieRefreshedAt: this.info.cookieRefreshedAt ? new Date(this.info.cookieRefreshedAt).toISOString() : null,
      ready: this.ready,
    }
  }
}