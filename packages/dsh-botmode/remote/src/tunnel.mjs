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

export function cloudflaredBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

export function cloudflaredAssetName(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') {
    if (arch === 'x64') return { asset: 'cloudflared-linux-amd64', archive: false }
    if (arch === 'arm64') return { asset: 'cloudflared-linux-arm64', archive: false }
    if (arch === 'arm') return { asset: 'cloudflared-linux-arm', archive: false }
    if (arch === 'ia32') return { asset: 'cloudflared-linux-386', archive: false }
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return { asset: 'cloudflared-darwin-arm64.tgz', archive: true }
    if (arch === 'x64') return { asset: 'cloudflared-darwin-amd64.tgz', archive: true }
  }
  if (platform === 'win32') {
    if (arch === 'x64' || arch === 'arm64') return { asset: 'cloudflared-windows-amd64.exe', archive: false }
    if (arch === 'ia32') return { asset: 'cloudflared-windows-386.exe', archive: false }
  }
  return null
}

function systemCloudflaredCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared']
  }
  if (platform === 'linux') {
    return ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared']
  }
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const list = [
      join(pf, 'cloudflared', 'cloudflared.exe'),
      join(pf86, 'cloudflared', 'cloudflared.exe'),
    ]
    if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'cloudflared', 'cloudflared.exe'))
    return list
  }
  return []
}

async function isRunnableBinary(cmd) {
  try {
    await execFileAsync(cmd, ['--version'], { timeout: 5_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

export function cloudflaredDownloadUrls(asset, source = 'mirror') {
  const direct = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`
  const mirrors = [
    `https://cdn.gh-proxy.com/${direct}`,
    `https://hk.gh-proxy.com/${direct}`,
    `https://gh-proxy.com/${direct}`,
    `https://ghfast.top/${direct}`,
    `https://v6.gh-proxy.com/${direct}`,
  ]
  if (source === 'official') return [direct]
  if (source === 'mirror') return mirrors
  return [...mirrors, direct]
}

/** 读取环境变量或 macOS 系统代理（scutil --proxy），让 Electron GUI 进程也能走系统代理。 */
export async function detectSystemProxy(platform = process.platform, env = process.env) {
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], { timeout: 3_000 })
      const text = String(stdout ?? '')
      const pick = (key) => new RegExp(`\\b${key}\\s*:\\s*([^\\s\\n]+)`).exec(text)?.[1] ?? ''
      if (pick('HTTPSEnable') === '1' && pick('HTTPSProxy') && pick('HTTPSPort')) {
        return `http://${pick('HTTPSProxy')}:${pick('HTTPSPort')}`
      }
      if (pick('HTTPEnable') === '1' && pick('HTTPProxy') && pick('HTTPPort')) {
        return `http://${pick('HTTPProxy')}:${pick('HTTPPort')}`
      }
      if (pick('SOCKSEnable') === '1' && pick('SOCKSProxy') && pick('SOCKSPort')) {
        return `socks5h://${pick('SOCKSProxy')}:${pick('SOCKSPort')}`
      }
    } catch {}
  }
  return null
}

/** 仅检测本机是否已有可用 cloudflared（不触发任何下载）。 */
export async function findInstalledCloudflared({ configured = 'cloudflared', home } = {}) {
  const defaultName = cloudflaredBinaryName()
  const preferred = String(configured || defaultName).trim() || defaultName
  if (await isRunnableBinary(preferred)) return preferred
  if (preferred !== defaultName && (await isRunnableBinary(defaultName))) return defaultName

  for (const candidate of systemCloudflaredCandidates()) {
    if (existsSync(candidate) && (await isRunnableBinary(candidate))) return candidate
  }

  if (home) {
    const localBin = join(home, 'bin', defaultName)
    if (existsSync(localBin) && (await isRunnableBinary(localBin))) return localBin
  }
  return null
}

async function downloadToFile(url, destPath, { proxy = null, maxTimeSec = 180 } = {}) {
  const curlBin = process.platform === 'win32'
    ? 'curl.exe'
    : (existsSync('/usr/bin/curl') ? '/usr/bin/curl' : 'curl')
  const curlArgs = [
    '-fsSL',
    '--connect-timeout', '10',
    '--speed-limit', '10240',
    '--speed-time', '18',
    '--max-time', String(maxTimeSec),
  ]
  if (proxy) curlArgs.push('-x', proxy)
  curlArgs.push('-o', destPath, url)
  try {
    await execFileAsync(curlBin, curlArgs, { timeout: (maxTimeSec + 10) * 1000, windowsHide: true })
    const info = await stat(destPath).catch(() => null)
    if (info && info.size > 100_000) return
    throw new Error(`下载文件不完整 (${info?.size ?? 0} bytes)`)
  } catch (curlError) {
    await rm(destPath, { force: true }).catch(() => {})
    // 只有宿主机根本没有 curl 时才回退 Node fetch；网络错误直接暴露给上层切换镜像源，避免重复干等超时
    if (curlError?.code !== 'ENOENT') {
      const detail = String(curlError?.stderr || curlError?.message || curlError).trim().split('\n').pop()
      throw new Error(detail || 'curl 下载失败')
    }
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(maxTimeSec * 1000),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length <= 100_000) {
      throw new Error(`下载文件不完整 (${bytes.length} bytes)`)
    }
    await writeFile(destPath, bytes)
  }
}

/**
 * 解析可用的 cloudflared 可执行文件；宿主机未预装时按用户选择的源（`mirror` 国内镜像源 / `official` GitHub 官方源）
 * 自动下载到 `<home>/bin/cloudflared(.exe)`，兼容 Linux / macOS / Windows 三端及 macOS 系统代理。
 */
export async function ensureCloudflaredBinary({
  configured = 'cloudflared',
  home,
  source = 'mirror',
  allowAutoInstall = true,
  logger,
} = {}) {
  const existing = await findInstalledCloudflared({ configured, home })
  if (existing) return existing

  const defaultName = cloudflaredBinaryName()
  const preferred = String(configured || defaultName).trim() || defaultName
  if (!allowAutoInstall || process.env.DSH_REMOTE_AUTO_INSTALL_CLOUDFLARED === '0') return preferred

  const spec = cloudflaredAssetName()
  if (!spec) {
    throw new Error(`未找到 cloudflared 且当前平台暂不支持自动下载 (${process.platform}/${process.arch})`)
  }
  const binDir = join(home, 'bin')
  const localBin = join(binDir, defaultName)
  ensureDir(binDir)
  const normalizedSource = source === 'official' ? 'official' : (source === 'auto' ? 'auto' : 'mirror')
  const urls = cloudflaredDownloadUrls(spec.asset, normalizedSource)
  const systemProxy = await detectSystemProxy()
  const tmpDownload = `${localBin}.${process.pid}.${Date.now()}.${spec.archive ? 'tgz' : 'tmp'}`
  let downloadedUrl = null
  const errors = []
  for (const url of urls) {
    // 官方源优先走系统代理（若存在），国内镜像源优先直连（失败后再尝试系统代理）
    const proxyPlans = normalizedSource === 'official'
      ? (systemProxy ? [systemProxy, null] : [null])
      : (systemProxy ? [null, systemProxy] : [null])
    for (const proxy of proxyPlans) {
      logger?.info?.('cloudflared not found; downloading automatically', {
        url,
        source: normalizedSource,
        proxy: proxy ? 'system' : 'direct',
        target: localBin,
      })
      try {
        await downloadToFile(url, tmpDownload, { proxy, maxTimeSec: 180 })
        downloadedUrl = url
        break
      } catch (error) {
        errors.push(`${url}${proxy ? ' (proxy)' : ''} -> ${String(error?.message ?? error).slice(0, 120)}`)
        await rm(tmpDownload, { force: true }).catch(() => {})
      }
    }
    if (downloadedUrl) break
  }
  if (!downloadedUrl) {
    const label = normalizedSource === 'official' ? 'GitHub 官方源' : '国内镜像源'
    throw new Error(`从${label}下载 cloudflared 失败（可尝试切换另一个下载源）：${errors.slice(0, 3).join(' | ')}`)
  }
  if (spec.archive) {
    const tarBin = existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar'
    try {
      await execFileAsync(tarBin, ['-xzf', tmpDownload, '-C', binDir], { timeout: 30_000, windowsHide: true })
    } finally {
      await rm(tmpDownload, { force: true }).catch(() => {})
    }
    if (process.platform !== 'win32') {
      await chmod(localBin, 0o755).catch(() => {})
    }
    if (process.platform === 'darwin') {
      await execFileAsync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', localBin], { timeout: 5_000 }).catch(() => {})
    }
  } else {
    if (process.platform !== 'win32') {
      await chmod(tmpDownload, 0o755).catch(() => {})
    } else {
      await rm(localBin, { force: true }).catch(() => {})
    }
    await rename(tmpDownload, localBin)
  }
  if (!(await isRunnableBinary(localBin))) {
    throw new Error(`已下载 cloudflared 至 ${localBin} 但无法执行`)
  }
  logger?.info?.('cloudflared ready', { path: localBin, source: downloadedUrl })
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
    let command
    try {
      command = await ensureCloudflaredBinary({
        configured: this.config.public.cloudflared || 'cloudflared',
        home: this.config.home,
        source: this.config.public.downloadSource || 'mirror',
        logger: this.logger,
      })
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      this.state = 'error'
      this.logger.error('cloudflared preparation failed', { error: this.lastError })
      this.onState(this.state)
      this.#scheduleRestart()
      return
    }
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
        windowsHide: true,
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