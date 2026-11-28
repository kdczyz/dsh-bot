/**
 * 桌面端「Remote」入口：把 dsh-remote 网关（Cloudflare 隧道 + 端到端加密）包成一层薄控制面。
 *
 * 这里不重新实现隧道，只做四件事：
 *   1. 读运行态（`~/.dsh-remote/state/runtime.json`、`link.txt`）并探活；
 *   2. 需要时调用 `dsh-remote up` 起网关，等到本地 /__dsh/health 为 200 再返回；
 *   3. 轮换对外密钥（`dsh-remote rotate`）并回传新链接；
 *   4. 把链接渲染成二维码（host/qr.js），供客户端直接显示。
 *
 * 进程调用一律 execFile + 参数数组，不经过 shell。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { qrDataUrl, qrSvg } from './qr.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLED_BIN = join(HERE, '..', 'remote', 'bin', 'dsh-remote.mjs')

const DEFAULT_HOME = process.env.DSH_REMOTE_HOME || join(homedir(), '.dsh-remote')
const BIN_CANDIDATES = [
  process.env.DSH_REMOTE_BIN,
  BUNDLED_BIN,
  join(process.cwd(), 'bin', 'dsh-remote.mjs'),
  join(homedir(), 'Desktop', 'dsh-remote', 'bin', 'dsh-remote.mjs'),
  join(homedir(), 'dsh-remote', 'bin', 'dsh-remote.mjs'),
].filter(Boolean)

function systemNodeCandidates(platform = process.platform, env = process.env) {
  const list = []
  if (env.DSH_NODE_BIN) list.push(env.DSH_NODE_BIN)
  if (platform === 'win32') {
    list.push('node.exe', 'node')
    const pf = env.ProgramFiles || 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const localAppData = env.LOCALAPPDATA
    list.push(join(pf, 'nodejs', 'node.exe'))
    list.push(join(pf86, 'nodejs', 'node.exe'))
    if (localAppData) list.push(join(localAppData, 'Programs', 'nodejs', 'node.exe'))
    if (env.NVM_SYMLINK) list.push(join(env.NVM_SYMLINK, 'node.exe'))
    if (env.VOLTA_HOME) list.push(join(env.VOLTA_HOME, 'bin', 'node.exe'))
  } else if (platform === 'darwin') {
    list.push(
      'node',
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/opt/local/bin/node',
      join(homedir(), '.volta', 'bin', 'node'),
      join(homedir(), '.asdf', 'shims', 'node'),
    )
  } else {
    list.push(
      'node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      join(homedir(), '.volta', 'bin', 'node'),
      join(homedir(), '.asdf', 'shims', 'node'),
    )
  }
  return [...new Set(list.filter(Boolean))]
}

async function probeNodeMajor(command, extraEnv = {}) {
  try {
    const { stdout } = await execFileAsync(command, ['-p', 'process.versions.node'], {
      timeout: 5_000,
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    })
    const match = /^(\d+)\./.exec(String(stdout ?? '').trim())
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

let cachedNodeRuntime = null

/**
 * 解析可执行 dsh-remote.mjs 的 Node 运行时（兼容 Linux / macOS / Windows 及 Electron 桌面端）：
 * - 非 Electron 环境：直接使用当前 `process.execPath`；
 * - Electron 环境（macOS `.app` / Windows `.exe` / Linux 桌面端）：
 *   1) 优先选用宿主机已安装的独立 `node` (>= 20)，避免 Electron 关闭 `RunAsNode` fuse 或拉起新 GUI 窗口；
 *   2) 宿主机未安装 `node` 时，回退到 `process.execPath` 并注入 `ELECTRON_RUN_AS_NODE=1`。
 */
export async function resolveNodeRuntime({
  execPath = process.execPath,
  isElectron = Boolean(process.versions?.electron),
  platform = process.platform,
  env = process.env,
  probe = probeNodeMajor,
  useCache = true,
} = {}) {
  if (!isElectron) {
    return { command: execPath, extraEnv: {} }
  }
  if (useCache && cachedNodeRuntime) return cachedNodeRuntime
  for (const candidate of systemNodeCandidates(platform, env)) {
    const major = await probe(candidate, {})
    if (major >= 20) {
      const resolved = { command: candidate, extraEnv: {} }
      if (useCache) cachedNodeRuntime = resolved
      return resolved
    }
  }
  const electronFallback = { command: execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }
  if (useCache) cachedNodeRuntime = electronFallback
  return electronFallback
}

async function atomicWriteFile(filePath, content, { mode = 0o600 } = {}) {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, { encoding: 'utf8', mode })
  if (process.platform !== 'win32') {
    await chmod(tmp, mode).catch(() => {})
  }
  try {
    await rename(tmp, filePath)
  } catch (error) {
    if (process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'EEXIST')) {
      await rm(filePath, { force: true }).catch(() => {})
      await rename(tmp, filePath)
    } else {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }
}

function hasRelayCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader.trim()) return false
  return cookieHeader
    .split(';')
    .some((part) => part.trim().startsWith('dsh-auth-relay='))
}

function normalizeSocketHost(raw) {
  const s = String(raw ?? '').trim().replace(/^::ffff:/i, '')
  if (!s || s === '::' || s === '::1' || s === '0.0.0.0') return '127.0.0.1'
  return s
}

function extractDshAuthCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader.trim()) return ''
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    // 跳过 dsh-remote 自身的 relay cookie，避免自循环；只取宿主机真实 dsh-auth-* cookie
    if (name.startsWith('dsh-auth-') && name !== 'dsh-auth-relay') {
      return trimmed
    }
  }
  return ''
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function readText(path) {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return null
  }
}

async function probe(url, timeoutMs = 1500) {
  if (!url) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    return response.status === 200
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function parseGatewayLink(link) {
  if (typeof link !== 'string' || link.trim() === '') return null
  const value = link.trim()
  const keyMatch = /#k=([A-Za-z0-9_-]{16,})/.exec(value)
  const tokenMatch = /[?&]token=([^&\s]+)/.exec(value)
  let url = null
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol)) return null
  return {
    url: `${url.origin}${url.pathname === '/' ? '/' : url.pathname}`,
    origin: url.origin,
    key: keyMatch ? keyMatch[1] : null,
    token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null,
    full: value,
  }
}

/** 校验用户输入的链接（二维码 / 手动输入共用）。 */
export function inspectLink(text) {
  const value = String(text ?? '').trim()
  if (!value) return { valid: false, kind: null, reason: 'empty' }
  if (/^ssh:\/\//i.test(value) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.:[\]-]+$/.test(value)) {
    return { valid: true, kind: 'ssh', full: value }
  }
  const parsed = parseGatewayLink(value)
  if (!parsed) return { valid: false, kind: null, reason: 'unsupported' }
  return {
    valid: Boolean(parsed.key || parsed.token),
    kind: 'gateway',
    hasKey: Boolean(parsed.key),
    hasToken: Boolean(parsed.token),
    origin: parsed.origin,
    full: parsed.full,
    reason: parsed.key || parsed.token ? null : 'missing-credential',
  }
}

export class RemoteGateway {
  constructor({ home = DEFAULT_HOME, bin, logger = console, serviceName = 'dsh-remote.service', useSystemd } = {}) {
    this.home = home
    this.bin = bin || BIN_CANDIDATES.find((candidate) => existsSync(candidate)) || BIN_CANDIDATES[1]
    this.logger = logger
    this.serviceName = serviceName
    this.useSystemd = useSystemd ?? (home === DEFAULT_HOME && !bin && process.platform === 'linux')
    this.runtimePath = join(home, 'state', 'runtime.json')
    this.hintPath = join(home, 'state', 'upstream-hint.json')
    this.configPath = join(home, 'config.json')
    this.linkPath = join(home, 'link.txt')
    this.lastAction = null
  }

  /**
   * 记录当前活跃 `dsh web` / Electron 内嵌网关的真实监听地址与鉴权信息到 `state/upstream-hint.json`。
   * 即使用户在 Linux / macOS / Windows 裸跑 `dsh web` 或桌面端（无日志文件），dsh-remote 也能零配置自动对接。
   */
  async recordUpstreamHintFromRequest(req) {
    try {
      const port = Number(req?.socket?.localPort)
      if (!Number.isInteger(port) || port <= 0) return false
      const host = normalizeSocketHost(req?.socket?.localAddress)
      const cookieHeader = req?.headers?.cookie
      const cookie = extractDshAuthCookie(cookieHeader)
      // 跳过仅来自 dsh-remote 自身的 relay 请求，避免自循环或覆盖真实 cookie
      if (!cookie && hasRelayCookie(cookieHeader)) return false
      if (!cookie) {
        const existing = await readJson(this.hintPath)
        if (existing && existing.port === port && existing.host === host && existing.cookie) {
          return false
        }
      }
      const payload = {
        host,
        port,
        cookie: cookie || null,
        authMode: cookie ? 'cookie' : 'none',
        pid: process.pid,
        updatedAt: Date.now(),
      }
      await atomicWriteFile(this.hintPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  async #ensureDefaultConfig() {
    if (existsSync(this.configPath)) return this.configPath
    const homeDir = homedir()
    const defaults = {
      version: 1,
      listen: { host: '127.0.0.1', port: 44691 },
      public: { mode: 'quick' },
      upstream: {
        mode: 'auto',
        log: null,
        logs: [
          join(homeDir, 'logs', 'dsh-web.log'),
          join(homeDir, '.dsh', 'logs', 'dsh-web.log'),
          join(homeDir, '.dsh-app-remote', 'web.log'),
        ],
        discoverIntervalMs: 3000,
      },
      proxy: { appBridge: true, hostRewrite: true },
      tunnel: { persistAcrossRestart: true },
    }
    await atomicWriteFile(this.configPath, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 })
    return this.configPath
  }

  async #hasSystemdUserBus() {
    if (!this.useSystemd || !this.serviceName) return false
    try {
      await execFileAsync('systemctl', ['--user', 'show-environment'], { timeout: 3000 })
      return true
    } catch {
      return false
    }
  }

  async #hasSystemdService() {
    if (!this.useSystemd || !this.serviceName) return false
    try {
      await execFileAsync('systemctl', ['--user', 'cat', this.serviceName], { timeout: 3000 })
      return true
    } catch {
      return false
    }
  }

  /**
   * Linux + systemd --user 环境下首次启动时自动安装独立的 `dsh-remote.service`，
   * 让 dsh-remote / cloudflared 脱离 dsh-web.service 的 cgroup，避免 dsh 重启导致隧道断联。
   */
  async #ensureSystemdService() {
    if (await this.#hasSystemdService()) return true
    if (!(await this.#hasSystemdUserBus())) return false
    if (!this.bin || !existsSync(this.bin)) return false
    try {
      const runtime = await resolveNodeRuntime()
      const unitDir = join(homedir(), '.config', 'systemd', 'user')
      const unitPath = join(unitDir, this.serviceName)
      const logDir = join(this.home, 'logs')
      await mkdir(unitDir, { recursive: true })
      await mkdir(logDir, { recursive: true })
      const workDir = dirname(dirname(this.bin))
      const envLines = [
        `Environment=HOME=${homedir()}`,
        'Environment=NODE_ENV=production',
        `Environment=DSH_REMOTE_HOME=${this.home}`,
      ]
      if (runtime.extraEnv.ELECTRON_RUN_AS_NODE) {
        envLines.push(`Environment=ELECTRON_RUN_AS_NODE=${runtime.extraEnv.ELECTRON_RUN_AS_NODE}`)
      }
      const unitBody = [
        '[Unit]',
        'Description=dsh-remote — DSH Gateway Remote Tunnel (auto-managed by dsh-botmode)',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        ...envLines,
        `WorkingDirectory=${workDir}`,
        `ExecStart="${runtime.command}" "${this.bin}" up --foreground --config "${this.configPath}"`,
        'Restart=always',
        'RestartSec=3',
        `StandardOutput=append:${join(logDir, 'relay.log')}`,
        `StandardError=append:${join(logDir, 'relay.log')}`,
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n')
      await writeFile(unitPath, unitBody, 'utf8')
      await execFileAsync('systemctl', ['--user', 'daemon-reload'], { timeout: 10_000 })
      await execFileAsync('systemctl', ['--user', 'enable', this.serviceName], { timeout: 10_000 }).catch(() => {})
      return true
    } catch (error) {
      this.logger?.warn?.(`botmode: auto-install ${this.serviceName} failed, falling back: ${String(error?.message ?? error)}`)
      return false
    }
  }

  async #resolveWorkDir() {
    const candidate = this.bin ? dirname(dirname(this.bin)) : null
    if (candidate && existsSync(candidate)) return candidate
    await mkdir(this.home, { recursive: true }).catch(() => {})
    return existsSync(this.home) ? this.home : homedir()
  }

  async #runDetachedUp({ timeoutMs = 120_000 } = {}) {
    await this.#ensureDefaultConfig().catch(() => {})
    if (await this.#ensureSystemdService()) {
      const startedAt = Date.now()
      await execFileAsync('systemctl', ['--user', 'start', this.serviceName], { timeout: 30_000 })
      this.lastAction = { args: ['systemctl', '--user', 'start', this.serviceName], ok: true, at: new Date().toISOString(), ms: Date.now() - startedAt }
      return
    }
    if (this.useSystemd) {
      try {
        const runtime = await resolveNodeRuntime()
        const unit = `dsh-remote-detached-${Date.now()}`
        const env = { ...process.env, ...runtime.extraEnv, DSH_REMOTE_HOME: this.home }
        const cwd = await this.#resolveWorkDir()
        const startedAt = Date.now()
        await execFileAsync(
          'systemd-run',
          ['--user', '--scope', `--unit=${unit}`, '--', runtime.command, this.bin, 'up'],
          { timeout: timeoutMs, env, cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        )
        this.lastAction = { args: ['systemd-run', 'up'], ok: true, at: new Date().toISOString(), ms: Date.now() - startedAt }
        return
      } catch (error) {
        this.logger?.warn?.(`botmode: systemd-run scope launch failed, falling back to direct up: ${String(error?.message ?? error)}`)
      }
    }
    await this.#run(['up'], { timeoutMs })
  }

  async #run(args, { timeoutMs = 90_000 } = {}) {
    const startedAt = Date.now()
    if (!this.bin || !existsSync(this.bin)) {
      const message = `未找到内置 dsh-remote 脚本（${this.bin ?? '未配置'}）`
      this.lastAction = { args, ok: false, at: new Date().toISOString(), ms: 0, error: message }
      throw new Error(`dsh-remote ${args.join(' ')} 失败：${message}`)
    }
    const runtime = await resolveNodeRuntime()
    const env = { ...process.env, ...runtime.extraEnv, DSH_REMOTE_HOME: this.home }
    const cwd = await this.#resolveWorkDir()
    try {
      const { stdout, stderr } = await execFileAsync(runtime.command, [this.bin, ...args], {
        timeout: timeoutMs,
        env,
        cwd,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      this.lastAction = { args, ok: true, at: new Date().toISOString(), ms: Date.now() - startedAt }
      return { ok: true, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() }
    } catch (error) {
      this.lastAction = {
        args,
        ok: false,
        at: new Date().toISOString(),
        ms: Date.now() - startedAt,
        error: String(error?.stderr || error?.message || error),
      }
      throw new Error(`dsh-remote ${args.join(' ')} 失败：${String(error?.stderr || error?.message || error).slice(0, 500)}`)
    }
  }

  /** 运行态 + 链接 + 二维码。 */
  async status({ qr = true } = {}) {
    const runtime = await readJson(this.runtimePath)
    let link = await readText(this.linkPath)
    if (!link && runtime?.link) link = runtime.link
    const running = Boolean(runtime && isAlive(runtime.pid))
    const port = runtime?.listen?.port ?? null
    const health = running && port ? await probe(`http://127.0.0.1:${port}/__dsh/health`) : false
    const parsed = parseGatewayLink(link)
    const payload = {
      ok: true,
      running,
      healthy: health,
      pid: runtime?.pid ?? null,
      port,
      publicUrl: runtime?.publicUrl ?? parsed?.origin ?? null,
      link: link || null,
      appLink: runtime?.appLink ?? null,
      appBridge: Boolean(runtime?.appLink),
      token: parsed?.key || parsed?.token || null,
      keyKind: parsed?.key ? 'psk' : parsed?.token ? 'legacy-token' : null,
      pskKid: runtime?.pskKid ?? null,
      tunnel: runtime?.tunnel
        ? { mode: runtime.tunnel.mode, state: runtime.tunnel.state, url: runtime.tunnel.url, restarts: runtime.tunnel.restarts }
        : null,
      startedAt: runtime?.startedAt ?? null,
      bin: this.bin,
      home: this.home,
      lastAction: this.lastAction,
      checkedAt: new Date().toISOString(),
    }
    if (qr && link) {
      try {
        payload.svg = qrSvg(link)
        payload.qrDataUrl = qrDataUrl(link)
      } catch (error) {
        payload.qrError = String(error?.message ?? error)
      }
    }
    if (qr && payload.appLink) {
      try {
        payload.appQrDataUrl = qrDataUrl(payload.appLink)
      } catch (error) {
        payload.appQrError = String(error?.message ?? error)
      }
    }
    return payload
  }

  /** 确保网关在线（已在线且健康则直接复用）。 */
  async up() {
    const before = await this.status({ qr: false })
    if (before.running && before.healthy && before.link) {
      return { ...(await this.status()), started: false, message: '网关已在线' }
    }
    await this.#runDetachedUp({ timeoutMs: 120_000 })
    return this.#waitFor({ timeoutMs: 90_000, expectPid: null }).then((state) => ({ ...state, started: true }))
  }

  async #waitFor({ timeoutMs = 90_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      last = await this.status({ qr: false })
      if (last.running && last.healthy && last.link) return this.status()
      await sleep(1200)
    }
    return { ...(last ?? (await this.status())), timeout: true }
  }

  /** 轮换对外密钥；等新链接出现再返回。 */
  async rotate() {
    const before = await this.status({ qr: false })
    await this.#run(['rotate', '--psk'], { timeoutMs: 30_000 })
    const deadline = Date.now() + 90_000
    let latest = before
    while (Date.now() < deadline) {
      await sleep(1500)
      latest = await this.status({ qr: false })
      if (latest.link && latest.link !== before.link && !latest.timeout) {
        return { ...(await this.status()), rotated: true }
      }
    }
    return { ...(await this.status()), rotated: latest.link !== before.link, timeout: latest.link === before.link }
  }

  /** 轮换 App 直连令牌（明文通道兜底）。 */
  async rotateApp() {
    const before = await this.status({ qr: false })
    if (!before.appLink) return { ...before, rotated: false, error: 'app-bridge-disabled' }
    await this.#run(['rotate', '--app'], { timeoutMs: 30_000 })
    const deadline = Date.now() + 90_000
    let latest = before
    while (Date.now() < deadline) {
      await sleep(1500)
      latest = await this.status({ qr: false })
      if (latest.appLink && latest.appLink !== before.appLink) return { ...(await this.status()), rotated: true }
    }
    return { ...(await this.status()), rotated: latest.appLink !== before.appLink, timeout: latest.appLink === before.appLink }
  }

  async down() {
    const before = await this.status({ qr: false })
    if (!before.running) return { ...before, stopped: false, message: '网关未在运行' }
    if (await this.#hasSystemdService()) {
      const startedAt = Date.now()
      await execFileAsync('systemctl', ['--user', 'stop', this.serviceName], { timeout: 30_000 })
      this.lastAction = { args: ['systemctl', '--user', 'stop', this.serviceName], ok: true, at: new Date().toISOString(), ms: Date.now() - startedAt }
    } else {
      await this.#run(['stop'], { timeoutMs: 30_000 })
    }
    await sleep(800)
    return { ...(await this.status()), stopped: true }
  }

  /** 校验手输链接 / 扫码内容。 */
  inspectLink(text) {
    return inspectLink(text)
  }
}