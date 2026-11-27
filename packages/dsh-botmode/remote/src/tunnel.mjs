/**
 * cloudflared 隧道守护进程。
 *
 * quick 模式：免 Cloudflare 账号，临时域名，URL 变化即重新分发链接；
 * named 模式：固定域名，隧道 token 支持由 refreshCommand 动态取最新值（token 自动续期），
 *             token 变化时重启 connector 使其生效。
 */
import { exec, execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFile } from 'node:fs'
import { chmod, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureDir, httpRequest, readJson, sleep, writeJsonAtomic } from './util.mjs'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/giu

function cloudflaredAssetName(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') {
    if (arch === 'x64') return { asset: 'cloudflared-linux-amd64', archive: false }
    if (arch === 'arm64') return { asset: 'cloudflared-linux-arm64', archive: false }
    if (arch === 'arm') return { asset: 'cloudflared-linux-arm', archive: false }
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return { asset: 'cloudflared-darwin-arm64.tgz', archive: true }
    if (arch === 'x64') return { asset: 'cloudflared-darwin-amd64.tgz', archive: true }
  }
  return null
}

async function isRunnableBinary(cmd) {
  try {
    await execFileAsync(cmd, ['--version'], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/**
 * 解析可用的 cloudflared 可执行文件；宿主机未预装时自动按架构下载到 `<home>/bin/cloudflared`，
 * 实现真正零配置即装即用。可通过 `DSH_REMOTE_AUTO_INSTALL_CLOUDFLARED=0` 关闭自动下载。
 */
export async function ensureCloudflaredBinary({ configured = 'cloudflared', home, logger } = {}) {
  const preferred = String(configured || 'cloudflared').trim() || 'cloudflared'
  if (await isRunnableBinary(preferred)) return preferred

  const binDir = join(home, 'bin')
  const localBin = join(binDir, 'cloudflared')
  if (existsSync(localBin) && (await isRunnableBinary(localBin))) return localBin

  if (process.env.DSH_REMOTE_AUTO_INSTALL_CLOUDFLARED === '0') return preferred

  const spec = cloudflaredAssetName()
  if (!spec) {
    throw new Error(`未找到 cloudflared 且当前平台暂不支持自动下载 (${process.platform}/${process.arch})`)
  }
  ensureDir(binDir)
  const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${spec.asset}`
  logger?.info?.('cloudflared not found; downloading automatically', { url: downloadUrl, target: localBin })
  const response = await fetch(downloadUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`自动下载 cloudflared 失败: HTTP ${response.status} (${downloadUrl})`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (spec.archive) {
    const tgzPath = `${localBin}.${process.pid}.tgz`
    await writeFile(tgzPath, bytes)
    try {
      await execFileAsync('tar', ['-xzf', tgzPath, '-C', binDir], { timeout: 30_000 })
    } finally {
      await rm(tgzPath, { force: true }).catch(() => {})
    }
    await chmod(localBin, 0o755)
  } else {
    const tmpPath = `${localBin}.${process.pid}.tmp`
    await writeFile(tmpPath, bytes, { mode: 0o755 })
    await chmod(tmpPath, 0o755)
    await rename(tmpPath, localBin)
  }
  if (!(await isRunnableBinary(localBin))) {
    throw new Error(`已下载 cloudflared 至 ${localBin} 但无法执行`)
  }
  logger?.info?.('cloudflared ready', { path: localBin })
  return localBin
}

export class Tunnel {
  constructor({ config, logger, onUrl = () => {}, onState = () => {} }) {
    this.config = config
    this.logger = logger
    this.onUrl = onUrl
    this.onState = onState
    this.child = null
    this.currentUrl = null
    this.state = 'idle'
    this.failures = 0
    this.restarts = 0
    this.lastError = null
    this.stopped = false
    this.restartTimer = null
    this.healthTimer = null
    this.tokenRefreshAt = 0
    this.token = config.public.tunnelToken ?? null
    this.readyWaiters = []
    this.attached = false
    this.owner = null
    this.statePath = join(config.stateDir, 'tunnel.json')
  }

  /** 落盘隧道身份，供 relay 重启后 attach；quick 的 URL 只有原进程还活着才有意义。 */
  #persist(extra = {}) {
    try {
      ensureDir(this.config.stateDir)
      writeJsonAtomic(this.statePath, {
        mode: this.config.public.mode,
        port: this.config.listen.port,
        url: this.currentUrl,
        // attach 场景没有 child 句柄，真正的 pid 存在 owner 里，否则会写出 pid:null 导致之后无法收隧道
        pid: this.child?.pid ?? this.owner ?? null,
        startedAt: new Date().toISOString(),
        attached: this.attached,
        ...extra,
      })
    } catch (error) {
      this.logger.warn('persist tunnel state failed', { error: String(error?.message ?? error) })
    }
  }

  status() {
    return {
      mode: this.config.public.mode,
      state: this.state,
      url: this.currentUrl,
      hostname: this.config.public.hostname,
      pid: this.child?.pid ?? null,
      attached: this.attached,
      persistAcrossRestart: this.config.tunnel.persistAcrossRestart !== false,
      restarts: this.restarts,
      failures: this.failures,
      tokenSource: this.config.public.refreshCommand ? 'refreshCommand' : this.token ? 'config' : null,
      lastError: this.lastError,
    }
  }

  async start() {
    this.stopped = false
    const mode = this.config.public.mode
    if (mode === 'none') {
      this.state = 'disabled'
      return null
    }
    if (mode === 'funnel') {
      await this.#startFunnel()
      return this.currentUrl
    }
    if (mode === 'quick' && (await this.#tryAttach())) return this.currentUrl
    await this.#spawn()
    return this.currentUrl
  }

  /** relay 重启后复用仍在运行的 cloudflared，域名保持不变。 */
  async #tryAttach() {
    const saved = readJson(this.statePath, null)
    if (!saved || saved.mode !== 'quick' || !saved.url || !saved.pid) return false
    if (Number(saved.port) !== Number(this.config.listen.port)) return false
    let alive = false
    try {
      process.kill(saved.pid, 0)
      alive = true
    } catch {}
    if (!alive) return false
    this.currentUrl = saved.url
    this.attached = true
    this.owner = saved.pid
    this.state = 'running'
    this.onState(this.state)
    if (!(await probe(`${saved.url}/__dsh/health`))) {
      this.logger.warn('existing tunnel process is alive but unhealthy; replacing it', { pid: saved.pid, url: saved.url })
      try {
        process.kill(saved.pid, 'SIGTERM')
      } catch {}
      this.currentUrl = null
      this.attached = false
      await sleep(800)
      return false
    }
    this.logger.info('attached to running cloudflared', { pid: saved.pid, url: saved.url })
    this.#persist()
    this.onUrl(saved.url)
    this.#startHealthLoop()
    return true
  }

  /** Tailscale Funnel：域名固定在 <machine>.<tailnet>.ts.net，relay 重启不影响入口。 */
  async #startFunnel() {
    const dns = await selfDnsName()
    if (!dns) throw new Error('无法从 `tailscale status --json` 读取本机 DNSName')
    this.currentUrl = `https://${dns}`
    this.state = 'starting'
    this.onState(this.state)
    this.logger.info('enabling tailscale funnel', { port: this.config.listen.port, url: this.currentUrl })
    try {
      await execFileAsync('tailscale', ['funnel', '--bg', String(this.config.listen.port)], {
        timeout: 25_000,
        maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      const detail = `${String(error?.stdout ?? '')}${String(error?.stderr ?? '')}`.trim()
      if (/not enabled|enable, visit/i.test(detail)) {
        const enableUrl = /https:\/\/login\.tailscale\.com\S+/u.exec(detail)?.[0] ?? '(见 tailscale 输出)'
        throw new Error(`Tailscale Funnel 未在 tailnet 启用，先打开 ${enableUrl} 启用一次`)
      }
      if (error?.killed || error?.signal) {
        // 命令在启用前会阻塞等待，超时按「未启用」处理
        throw new Error('tailscale funnel 未完成（可能需要在管理后台启用 Funnel）')
      }
      throw new Error(`tailscale funnel 失败：${detail || String(error?.message ?? error)}`)
    }
    this.state = 'running'
    this.onState(this.state)
    this.attached = false
    this.#persist()
    const ok = await waitHealthy(`${this.currentUrl}/__dsh/health`, this.config.tunnel.urlWaitMs)
    if (!ok) this.logger.warn('funnel enabled but health check failed yet', { url: this.currentUrl })
    this.onUrl(this.currentUrl)
    this.#startHealthLoop()
  }

  async #refreshToken() {
    if (!this.config.public.refreshCommand) return this.token
    try {
      const { stdout } = await execAsync(this.config.public.refreshCommand, { timeout: 30_000, maxBuffer: 1024 * 1024 })
      const value = stdout.trim().split('\n').filter(Boolean).pop() ?? null
      if (value && value !== this.token) {
        this.logger.info('tunnel token refreshed', { length: value.length })
        this.token = value
      }
      this.tokenRefreshAt = Date.now()
    } catch (error) {
      this.logger.warn('tunnel token refresh failed', { error: String(error?.message ?? error) })
    }
    return this.token
  }

  #args() {
    const target = `http://${this.config.listen.host}:${String(this.config.listen.port)}`
    if (this.config.public.mode === 'quick') {
      return { args: ['tunnel', '--url', target, '--no-autoupdate'], env: {} }
    }
    const args = ['tunnel', '--no-autoupdate', 'run']
    const env = {}
    if (this.config.public.configFile) args.push('--config', this.config.public.configFile)
    if (this.token) args.push('--token', this.token)
    return { args, env }
  }

  async #spawn() {
    if (this.stopped) return
    this.state = 'starting'
    this.onState(this.state)
    if (this.config.public.mode === 'named' && this.config.public.refreshCommand) await this.#refreshToken()
    const { args, env } = this.#args()
    const command = await ensureCloudflaredBinary({
      configured: this.config.public.cloudflared || 'cloudflared',
      home: this.config.home,
      logger: this.logger,
    })
    this.logger.info('starting cloudflared', { command, mode: this.config.public.mode })
    ensureDir(this.config.logs.dir)
    const logPath = join(this.config.logs.dir, 'tunnel.log')
    let logOffset = 0
    try {
      logOffset = (await stat(logPath)).size
    } catch {}
    // 日志落文件而不是管道：relay 退出后 cloudflared 继续存活，管道关闭不会把它带走
    const fd = openSync(logPath, 'a')
    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', fd, fd],
        detached: true,
        env: { ...process.env, ...stripUndefined(env) },
      })
    } finally {
      closeSync(fd)
    }
    child.unref()
    this.child = child
    this.attached = false
    this.#persist()
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (this.stopped) return
      this.state = 'exited'
      this.lastError = `cloudflared exited code=${code} signal=${signal}`
      this.logger.warn('cloudflared exited', { code, signal })
      this.onState(this.state)
      this.#scheduleRestart()
    })
    child.on('error', (error) => {
      this.lastError = String(error?.message ?? error)
      this.logger.error('cloudflared spawn failed', { error: this.lastError })
      this.#scheduleRestart()
    })
    this.failures = 0
    this.state = 'running'
    this.onState(this.state)
    this.#startHealthLoop()
    if (this.config.public.mode === 'quick') {
      try {
        const url = await this.#waitForUrlFromLog(logPath, logOffset)
        this.currentUrl = url
        this.#persist()
        this.onUrl(url)
      } catch (error) {
        this.lastError = String(error?.message ?? error)
        this.logger.error('cloudflared did not yield a URL', { error: this.lastError })
        this.#restart('no-url')
      }
    } else if (this.config.public.hostname) {
      this.currentUrl = `https://${this.config.public.hostname}`
      this.#persist()
      this.onUrl(this.currentUrl)
    }
  }

  /** 从 cloudflared 日志文件里等 quick 域名（子进程已 detach，不能依赖管道）。 */
  async #waitForUrlFromLog(logPath, offset = 0, timeoutMs = this.config.tunnel.urlWaitMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error('tunnel stopped before URL was assigned')
      const text = await readLogTail(logPath, undefined, offset)
      const matches = [...text.matchAll(URL_RE)]
      if (matches.length > 0) return matches[matches.length - 1][0].replace(/\/+$/u, '')
      if (this.lastError && /failed|error|unauthorized/iu.test(this.lastError)) {
        // 继续等，cloudflared 会重试；只在超时时把最后一行错误带出去
      }
      await sleep(400)
    }
    throw new Error(`等待 cloudflared URL 超时（${timeoutMs}ms），见 ${logPath}`)
  }

  #startHealthLoop() {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = setInterval(() => {
      this.#healthCheck().catch((error) => {
        this.logger.warn('health check error', { error: String(error?.message ?? error) })
      })
    }, this.config.tunnel.healthIntervalMs)
    this.healthTimer.unref?.()
  }

  async #healthCheck() {
    if (this.state !== 'running' || !this.currentUrl || this.stopped) return
    const target = `${this.currentUrl}/__dsh/health`
    try {
      const response = await httpRequest(target, { timeoutMs: this.config.tunnel.healthTimeoutMs })
      if (response.status === 200) {
        this.failures = 0
        return
      }
      throw new Error(`HTTP ${response.status}`)
    } catch (error) {
      this.failures += 1
      this.lastError = String(error?.message ?? error)
      this.logger.warn('tunnel health failed', { failures: this.failures, error: this.lastError })
      if (this.failures >= this.config.tunnel.unhealthyThreshold) this.#restart('unhealthy')
    }
  }

  #scheduleRestart() {
    if (this.stopped) return
    const delay = Math.min(
      this.config.tunnel.maxBackoffMs,
      this.config.tunnel.restartBackoffMs * 2 ** Math.min(this.restarts, 6),
    )
    this.restarts += 1
    this.state = 'backoff'
    this.onState(this.state)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.#spawn().catch((error) => this.logger.error('restart failed', { error: String(error?.message ?? error) }))
    }, delay)
    this.restartTimer.unref?.()
  }

  #restart(reason) {
    if (this.stopped) return
    this.logger.warn('restarting tunnel', { reason })
    this.currentUrl = null
    const child = this.child
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch {}
    } else {
      this.#scheduleRestart()
    }
  }

  async stop({ keepProcess = this.config.tunnel.persistAcrossRestart !== false } = {}) {
    this.stopped = true
    clearInterval(this.healthTimer)
    clearTimeout(this.restartTimer)
    if (this.config.public.mode === 'funnel') {
      // Funnel 配置留在 tailscaled 里，重启 relay 直接复用；真正关闭用 `dsh-remote tunnel stop --all`
      if (!keepProcess) {
        await execFileAsync('tailscale', ['funnel', 'reset'], { timeout: 15_000 }).catch(() => {})
        this.#persist({ url: null })
      }
      this.child = null
      return
    }
    const child = this.child
    this.child = null
    if (this.attached || !child) return
    if (keepProcess) {
      // 保留 cloudflared（以及它的固定域名），只退出 relay
      this.logger.info('keeping cloudflared alive for link reuse', { pid: child.pid, url: this.currentUrl })
      return
    }
    child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      sleep(5000).then(() => false),
    ])
    if (!exited) {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
  }
}

async function probe(url, timeoutMs = 4000) {
  try {
    const response = await httpRequest(url, { timeoutMs })
    return response.status === 200
  } catch {
    return false
  }
}

async function waitHealthy(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(url)) return true
    await sleep(1500)
  }
  return false
}

/** 读取本机 Tailscale DNSName（去掉结尾点）。 */
export async function selfDnsName() {
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    const name = JSON.parse(stdout)?.Self?.DNSName
    return typeof name === 'string' && name.length > 0 ? name.replace(/\.$/u, '').toLowerCase() : null
  } catch {
    return null
  }
}

async function readLogTail(path, bytes = 256 * 1024, offset = 0) {
  try {
    const info = await stat(path)
    const from = Math.max(Number(offset) || 0, info.size - bytes, 0)
    const buffer = await new Promise((resolve, reject) => {
      readFile(path, (error, data) => (error ? reject(error) : resolve(data)))
    })
    return buffer.subarray(from).toString('utf8')
  } catch {
    return ''
  }
}

function stripUndefined(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return out
}