/**
 * Host-side bridge to the BotScreen virtual display gateway (`127.0.0.1:6200`).
 *
 * Responsibilities:
 * - Dynamic per-Bot virtual screen registration (`ensure`) and cleanup (`purge`)
 * - Agent-token caching and per-Bot operation serialization
 * - Automatic 423 Locked -> `approvals.askScreenHelp` suspension so human takeover
 *   never crashes an in-flight Bot turn
 * - Management proxy helpers for the Bot Mode UI (preview, start, freeze, thaw,
 *   takeover, release, brake, human_input, files, audit)
 */
import { Buffer } from 'node:buffer'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, globSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_GATEWAY = 'http://127.0.0.1:6200'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const __dirname = dirname(fileURLToPath(import.meta.url))
// Keep in sync with botscreen/requirements.txt. Checking every runtime import avoids
// half-bootstrapped environments where the gateway process starts but immediately exits.
const PY_DEPS_CHECK = 'import fastapi, uvicorn, multipart, PIL, Xlib, websockets, httpx, mss'
const _pyChecked = new Map()

const AUTO_SYSTEM_PACKAGES = [
  'xvfb', 'x11vnc', 'websockify', 'novnc', 'xauth',
  'xfwm4', 'xfdesktop4', 'xfconf', 'dbus-x11', 'tint2', 'picom', 'pcmanfm',
  'xterm', 'xdotool', 'xclip',
  'glib-networking', 'gvfs', 'gvfs-daemons', 'feh',
  'adwaita-icon-theme', 'fonts-noto-color-emoji', 'fonts-noto-cjk',
]

function hasPythonDepsSync(py) {
  if (_pyChecked.has(py)) return _pyChecked.get(py)
  try {
    execFileSync(py, ['-c', PY_DEPS_CHECK], { stdio: 'ignore', timeout: 4000 })
    _pyChecked.set(py, true)
    return true
  } catch (_error) {
    _pyChecked.set(py, false)
    return false
  }
}

function isUsableVenv(python) {
  if (python === 'python3' || !existsSync(python)) return false
  try {
    execFileSync(python, ['-c', 'import sys; raise SystemExit(0 if sys.prefix != sys.base_prefix else 1)'], {
      stdio: 'ignore',
      timeout: 4000,
    })
    return true
  } catch (_error) {
    return false
  }
}

function runQuiet(cmd, args, options = {}) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 120_000, ...options })
    return true
  } catch (_error) {
    return false
  }
}

function findVenvWheel(dir) {
  const matches = globSync(join(dir, 'pip-*.whl'))
  return matches[0] ? join(dir, matches[0]) : ''
}

async function ensurePipInVenv(python, pluginRoot) {
  if (runQuiet(python, ['-m', 'pip', '--version'], { timeout: 30_000 })) return
  // `ensurepip` exists on most distributions but is absent on minimal Python builds.
  if (runQuiet(python, ['-m', 'ensurepip', '--upgrade'], { timeout: 120_000 })
    && runQuiet(python, ['-m', 'pip', '--version'], { timeout: 30_000 })) return
  // The bundle vendors pip/setuptools wheels so a fresh install works even when the
  // host Python has no ensurepip and no pip of its own. PYTHONPATH is used only for
  // this bootstrap; `--ignore-installed` forces pip into the venv site-packages.
  const vendorDir = join(pluginRoot, 'vendor', 'pip')
  const seedWheel = findVenvWheel(vendorDir)
  if (!seedWheel) throw new Error('venv 缺少 pip，且未找到 ensurepip 或内置 pip wheel')
  const pythonRoot = resolve(dirname(python), '..')
  const runtimeVendor = join(pythonRoot, 'vendor', 'pip')
  const env = { ...process.env }
  // Tests and embedded installs can place the wheels next to the venv rather than
  // in the installed plugin bundle.
  const wheelDirs = [runtimeVendor, vendorDir]
  const seedDir = wheelDirs.find(dir => findVenvWheel(dir))
  const activeVendor = seedDir || vendorDir
  const activeWheel = seedDir ? findVenvWheel(seedDir) : seedWheel
  env.PYTHONPATH = env.PYTHONPATH ? `${activeWheel}${env.PYTHONPATH.includes(activeWheel) ? '' : `:${activeWheel}`}:${env.PYTHONPATH}` : activeWheel
  await execFileAsync(python, [
    '-m', 'pip', 'install', '--no-index', '--find-links', activeVendor,
    '--ignore-installed', '--upgrade', 'pip', 'setuptools',
  ], { env, timeout: 180_000 })
  if (!runQuiet(python, ['-m', 'pip', '--version'], { timeout: 30_000 })) {
    throw new Error('vendored pip wheel 安装后仍无法使用 python -m pip')
  }
}

function ensureSystemDependencies(logger) {
  if (process.env.BOTSCREEN_AUTO_INSTALL_DEPS === '0') {
    logger?.warn?.('botmode: system dependency auto-install disabled by BOTSCREEN_AUTO_INSTALL_DEPS=0')
    return
  }
  const requiredBins = [
    'Xvfb', 'x11vnc', 'websockify', 'xauth', 'xdotool', 'xclip', 'xfwm4',
    'xterm', 'feh', 'VNC_WEB_DIR',
  ]
  const missingBins = requiredBins.filter(name =>
    name === 'VNC_WEB_DIR'
      ? !existsSync(join(process.env.BOTSCREEN_VNC_WEB || '/usr/share/novnc', 'vnc.html'))
      : !runQuiet('sh', ['-c', `command -v ${name} >/dev/null 2>&1`], { timeout: 10_000 }),
  )
  if (!missingBins.length) return
  if (!runQuiet('sh', ['-c', 'command -v apt-get >/dev/null 2>&1'], { timeout: 10_000 })) {
    logger?.warn?.(`botmode: missing BotScreen system components (${missingBins.join(', ')}); install them manually`)
    return
  }
  const sudo = runQuiet('sh', ['-c', 'command -v sudo >/dev/null 2>&1 && sudo -n true'], { timeout: 10_000 })
    ? ['sudo', '-n']
    : []
  logger?.info?.(`botmode: installing BotScreen system components: ${missingBins.join(', ')}`)
  if (!runQuiet('apt-get', ['update', '-qq'], { timeout: 300_000 })) {
    throw new Error('apt-get update 失败，无法自动安装 BotScreen 系统依赖')
  }
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
  const installCmd = sudo.length ? sudo[0] : 'apt-get'
  const installArgs = sudo.length
    ? [...sudo.slice(1), 'apt-get', 'install', '-y', '--no-install-recommends', ...AUTO_SYSTEM_PACKAGES]
    : ['install', '-y', '--no-install-recommends', ...AUTO_SYSTEM_PACKAGES]
  if (!runQuiet(installCmd, installArgs, { env, timeout: 900_000 })) {
    throw new Error('apt-get install 失败，无法自动安装 BotScreen 系统依赖')
  }
}

function findBotscreenRuntime({ botscreenRoot, pythonBin, logDir } = {}) {
  const pluginRoot = resolve(__dirname, '..')
  const repoRoot = resolve(__dirname, '..', '..', '..')
  const candidates = [
    botscreenRoot,
    process.env.BOTSCREEN_ROOT,
    pluginRoot, // bundled inside @local/dsh-botmode
    repoRoot,
    '/opt/botscreen',
    join(homedir(), 'Desktop', 'dsh- bot'),
    join(homedir(), 'botscreen'),
  ].filter(Boolean)

  const seen = new Set()
  for (const rawDir of candidates) {
    const dir = resolve(rawDir)
    if (seen.has(dir)) continue
    seen.add(dir)
    if (!existsSync(join(dir, 'botscreen', '__main__.py'))) continue
    const explicitPy = [pythonBin, process.env.BOTSCREEN_PYTHON].find(
      p => p && (p === 'python3' || existsSync(p)),
    )
    if (explicitPy) {
      return { root: dir, python: explicitPy, needsBootstrap: false }
    }

    const venvBase = logDir || join(homedir(), '.dsh', 'botmode')
    const defaultVenvPython = join(venvBase, 'screen-venv', 'bin', 'python')
    const pyCandidates = [
      join(dir, '.venv', 'bin', 'python'),
      join(pluginRoot, '.venv', 'bin', 'python'),
      defaultVenvPython,
      join(repoRoot, '.venv', 'bin', 'python'),
      'python3',
    ].filter(Boolean)

    // Prefer an interpreter that already has the required Python packages
    for (const py of pyCandidates) {
      if ((py === 'python3' || existsSync(py)) && hasPythonDepsSync(py)) {
        return { root: dir, python: py, needsBootstrap: false }
      }
    }
    // Otherwise allow auto-bootstrapping a dedicated venv using python3. If a
    // candidate venv already exists but is broken/half-created, still bootstrap it
    // (bootstrapVenv now deletes and recreates invalid venvs safely).
    if (existsSync(join(dir, 'botscreen', 'requirements.txt'))) {
      const brokenVenv = pyCandidates.find(py => py !== 'python3' && existsSync(py) && !isUsableVenv(py))
      return { root: dir, python: brokenVenv || defaultVenvPython, needsBootstrap: true }
    }
    const fallback = pyCandidates.find(p => p === 'python3' || existsSync(p))
    if (fallback) return { root: dir, python: fallback, needsBootstrap: false }
  }
  return null
}

async function bootstrapVenv(runtime, logDir, logPath) {
  const venvDir = resolve(dirname(runtime.python), '..')
  const pluginRoot = resolve(__dirname, '..')
  const reqFile = join(runtime.root, 'botscreen', 'requirements.txt')
  const invalidVenv = !isUsableVenv(runtime.python)
  if (!invalidVenv) {
    // Nothing to do: keep the existing interpreter and its pip as-is.
  } else {
    // Minimal Python builds can leave a half-created venv after `venv` fails because
    // ensurepip is missing. Remove it first so pip can be seeded from the vendor dir.
    if (existsSync(venvDir)) rmSync(venvDir, { recursive: true, force: true })
    await execFileAsync('python3', ['-m', 'venv', '--without-pip', venvDir], { timeout: 60_000 })
  }
  await ensurePipInVenv(runtime.python, pluginRoot)
  await execFileAsync(runtime.python, ['-m', 'pip', 'install', '-q', '-r', reqFile], { timeout: 300_000 })
  _pyChecked.delete(runtime.python)
  return runtime.python
}

function readLogTail(logPath, maxBytes = 1200) {
  try {
    const raw = readFileSync(logPath, 'utf8')
    return raw.slice(-maxBytes).trim()
  } catch (_error) {
    return ''
  }
}

export class ScreenBridge {
  #tokens = new Map() // botId -> agent_token
  #epochs = new Map() // botId -> epoch
  #locks = new Map() // botId -> Promise chain
  #gatewayAvailable = null
  #autoSpawn = false
  #botscreenRoot = ''
  #pythonBin = ''
  #logDir = ''
  #bootPromise = null
  #lastError = ''
  #bootAttempted = false

  constructor({ approvals, logger, gatewayUrl, adminToken, autoSpawn, botscreenRoot, pythonBin, logDir } = {}) {
    this.approvals = approvals || null
    this.logger = logger || null
    this.gatewayUrl = String(gatewayUrl || process.env.BOTSCREEN_GATEWAY || DEFAULT_GATEWAY).replace(/\/$/, '')
    this.adminToken = String(adminToken ?? process.env.BOTSCREEN_ADMIN_TOKEN ?? '').trim()
    this.#botscreenRoot = String(botscreenRoot || '').trim()
    this.#pythonBin = String(pythonBin || '').trim()
    this.#logDir = String(logDir || '').trim()
    // A different root/python combination may replace a previously probed executable.
    // Drop global interpreter probes for explicitly supplied environments so reinstalls
    // and embedded test fixtures re-evaluate their actual dependencies.
    for (const python of [this.#pythonBin, join(this.#botscreenRoot, 'screen-venv', 'bin', 'python')]) {
      if (python) _pyChecked.delete(python)
    }

    // Default auto-spawn is enabled for the standard local gateway (or when explicit root/autoSpawn is given),
    // while preserving safe isolation for tests running against mock gateways on ephemeral ports.
    const envOpt = process.env.BOTSCREEN_AUTO_START
    if (typeof autoSpawn === 'boolean') {
      this.#autoSpawn = autoSpawn
    } else if (envOpt === '0' || envOpt === 'false') {
      this.#autoSpawn = false
    } else if (envOpt === '1' || envOpt === 'true' || this.#botscreenRoot !== '') {
      this.#autoSpawn = true
    } else {
      this.#autoSpawn = this.#isDefaultLocalGateway()
    }
  }

  #parsedGateway() {
    try {
      const url = new URL(this.gatewayUrl)
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      return { host: url.hostname, port, valid: true }
    } catch (_error) {
      return { host: '', port: 6200, valid: false }
    }
  }

  isLocalGateway() {
    const { host, valid } = this.#parsedGateway()
    return valid && LOCAL_HOSTS.has(host.toLowerCase())
  }

  #isDefaultLocalGateway() {
    const { port } = this.#parsedGateway()
    return this.isLocalGateway() && port === 6200
  }

  canAutoStart() {
    if (!this.#autoSpawn || !this.isLocalGateway()) return false
    return findBotscreenRuntime({
      botscreenRoot: this.#botscreenRoot,
      pythonBin: this.#pythonBin,
      logDir: this.#logDir,
    }) !== null
  }

  diagnostics() {
    return {
      autoStartable: this.canAutoStart(),
      starting: Boolean(this.#bootPromise),
      error: this.#lastError,
    }
  }

  async ensureGateway({ timeoutMs = 15_000 } = {}) {
    if (this.#bootPromise) return this.#bootPromise
    this.#bootPromise = this.#ensureGatewayInner({ timeoutMs }).finally(() => {
      this.#bootPromise = null
    })
    return this.#bootPromise
  }

  async #ensureGatewayInner({ timeoutMs }) {
    const quick = await this.health()
    if (quick.available) {
      this.#lastError = ''
      return { available: true, spawned: false }
    }
    if (!this.#autoSpawn || !this.isLocalGateway()) {
      this.#lastError = quick.error || 'BotScreen gateway unavailable'
      return { available: false, spawned: false, error: this.#lastError }
    }
    const runtime = findBotscreenRuntime({
      botscreenRoot: this.#botscreenRoot,
      pythonBin: this.#pythonBin,
      logDir: this.#logDir,
    })
    if (!runtime) {
      this.#lastError = '未找到内置 botscreen 服务目录或 Python3 环境'
      return { available: false, spawned: false, error: this.#lastError }
    }

    this.#bootAttempted = true
    const { host, port } = this.#parsedGateway()
    const logBase = this.#logDir || join(homedir(), '.dsh', 'botmode')
    let logFd = null
    const logPath = join(logBase, 'botscreen-gateway.log')
    try {
      mkdirSync(logBase, { recursive: true })
      logFd = openSync(logPath, 'a')
    } catch (_error) {
      logFd = null
    }

    if (runtime.needsBootstrap) {
      try {
        this.logger?.info?.(`botmode: bootstrapping embedded BotScreen Python venv at ${logBase}`)
        await bootstrapVenv(runtime, logBase, logPath)
      } catch (err) {
        if (logFd !== null) {
          try { closeSync(logFd) } catch (_e) { /* ignore */ }
        }
        this.#lastError = `BotScreen Python 依赖初始化失败: ${err instanceof Error ? err.message : String(err)}`
        return { available: false, spawned: false, error: this.#lastError }
      }
    }
    try {
      ensureSystemDependencies(this.logger)
    } catch (err) {
      if (logFd !== null) {
        try { closeSync(logFd) } catch (_e) { /* ignore */ }
      }
      this.#lastError = `BotScreen 系统依赖初始化失败: ${err instanceof Error ? err.message : String(err)}`
      return { available: false, spawned: false, error: this.#lastError }
    }

    this.logger?.info?.(`botmode: auto-starting BotScreen gateway at ${this.gatewayUrl} from ${runtime.root}`)
    let exitedCode = null
    let spawnError = ''
    try {
      const child = spawn(runtime.python, ['-m', 'botscreen'], {
        cwd: runtime.root,
        env: {
          ...process.env,
          PYTHONPATH: process.env.PYTHONPATH ? `${runtime.root}:${process.env.PYTHONPATH}` : runtime.root,
          BOTSCREEN_HOST: process.env.BOTSCREEN_HOST || host || '127.0.0.1',
          BOTSCREEN_PORT: process.env.BOTSCREEN_PORT || String(port || 6200),
          PYTHONUNBUFFERED: '1',
        },
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
      })
      child.on('error', (err) => {
        spawnError = err instanceof Error ? err.message : String(err)
      })
      child.on('exit', (code) => {
        exitedCode = code
      })
      child.unref()
    } finally {
      if (logFd !== null) {
        try { closeSync(logFd) } catch (_e) { /* ignore */ }
      }
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (spawnError) {
        this.#lastError = `无法拉起 BotScreen: ${spawnError}`
        return { available: false, spawned: true, error: this.#lastError }
      }
      if (exitedCode !== null) {
        const tail = readLogTail(logPath)
        const reason = tail ? tail.split('\n').slice(-4).join(' | ') : `exit code ${exitedCode}`
        this.#lastError = `BotScreen 启动失败 (${reason})`
        return { available: false, spawned: true, error: this.#lastError }
      }
      const probe = await this.health()
      if (probe.available) {
        this.#lastError = ''
        return { available: true, spawned: true }
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
    }

    this.#lastError = `BotScreen 在 ${Math.round(timeoutMs / 1000)}s 内未就绪（日志: ${logPath}）`
    return { available: false, spawned: true, error: this.#lastError }
  }

  async warmUp() {
    if (!this.#autoSpawn || !this.isLocalGateway()) return { available: false, skipped: true }
    return this.ensureGateway({ timeoutMs: 12_000 })
  }

  #adminHeaders(extra = {}) {
    const headers = { ...extra }
    if (this.adminToken) headers['X-Admin-Token'] = this.adminToken
    return headers
  }

  async #withLock(botId, fn) {
    const prev = this.#locks.get(botId) || Promise.resolve()
    let release
    const next = new Promise(resolve => { release = resolve })
    const chained = prev.then(() => next, () => next)
    this.#locks.set(botId, chained)
    try {
      await prev.catch(() => {})
      return await fn()
    } finally {
      release()
      if (this.#locks.get(botId) === chained) this.#locks.delete(botId)
    }
  }

  async #req(path, { method = 'GET', headers = {}, body, timeoutMs = 20_000 } = {}) {
    const url = `${this.gatewayUrl}${path}`
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    this.#gatewayAvailable = true
    return res
  }

  async #json(path, opts = {}) {
    const res = await this.#req(path, opts)
    const ct = res.headers.get('content-type') || ''
    const data = ct.includes('json') ? await res.json() : await res.text()
    if (!res.ok) {
      const msg = typeof data === 'object' ? (data.detail || data.error || JSON.stringify(data)) : String(data)
      const err = new Error(`BotScreen ${res.status}: ${msg}`)
      err.status = res.status
      err.payload = data
      throw err
    }
    return data
  }

  async health() {
    try {
      const data = await this.#json('/healthz', { timeoutMs: 2500 })
      const available = data?.ok !== false
      this.#gatewayAvailable = available
      this.#lastError = available ? '' : `BotScreen 缺少系统组件: ${(data?.missing || []).join(', ') || 'unknown'}`
      return { available, gatewayUrl: this.gatewayUrl, ...data }
    } catch (error) {
      this.#gatewayAvailable = false
      return { available: false, gatewayUrl: this.gatewayUrl, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async listScreens() {
    try {
      const data = await this.#json('/api/screens', {
        headers: this.#adminHeaders(),
        timeoutMs: 3000,
      })
      this.#gatewayAvailable = true
      this.#lastError = ''
      return {
        available: true,
        gatewayUrl: this.gatewayUrl,
        autoStartable: this.canAutoStart(),
        starting: false,
        error: '',
        ...data,
      }
    } catch (error) {
      this.#gatewayAvailable = false
      const msg = error instanceof Error ? error.message : String(error)
      if (!this.#lastError) this.#lastError = msg
      if (this.canAutoStart() && !this.#bootAttempted && !this.#bootPromise) {
        void this.warmUp()
      }
      return {
        available: false,
        gatewayUrl: this.gatewayUrl,
        autoStartable: this.canAutoStart(),
        starting: Boolean(this.#bootPromise),
        screens: [],
        host: null,
        error: this.#lastError || msg,
      }
    }
  }

  async ensure(botId, { autoStart = false } = {}) {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      const ready = await this.ensureGateway()
      if (!ready.available) {
        throw new Error(ready.error || 'BotScreen gateway unavailable')
      }
    }
    const qs = autoStart ? '?auto_start=1' : ''
    try {
      const data = await this.#json(`/api/screens/${encodeURIComponent(botId)}/ensure${qs}`, {
        method: 'POST',
        headers: this.#adminHeaders(),
        timeoutMs: 25_000,
      })
      this.#gatewayAvailable = true
      this.#lastError = ''
      if (data?.agent_token) this.#tokens.set(botId, data.agent_token)
      if (Number.isFinite(Number(data?.epoch))) this.#epochs.set(botId, Number(data.epoch))
      return data
    } catch (error) {
      // Gateway may have stopped since last check; retry once after auto-starting.
      if (error?.status === undefined && this.canAutoStart()) {
        const ready = await this.ensureGateway()
        if (ready.available) {
          const data = await this.#json(`/api/screens/${encodeURIComponent(botId)}/ensure${qs}`, {
            method: 'POST',
            headers: this.#adminHeaders(),
            timeoutMs: 25_000,
          })
          if (data?.agent_token) this.#tokens.set(botId, data.agent_token)
          if (Number.isFinite(Number(data?.epoch))) this.#epochs.set(botId, Number(data.epoch))
          return data
        }
      }
      throw error
    }
  }

  async getStatus(botId) {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      await this.ensureGateway().catch(() => undefined)
    }
    try {
      return await this.#json(`/api/screens/${encodeURIComponent(botId)}`, {
        headers: this.#adminHeaders(),
        timeoutMs: 3000,
      })
    } catch (error) {
      if (error?.status === 404) return this.ensure(botId)
      throw error
    }
  }

  async start(botId, apps) {
    await this.ensure(botId)
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/start`, {
      method: 'POST',
      headers: this.#adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(apps ? { apps } : {}),
      timeoutMs: 30_000,
    })
  }

  async stop(botId) {
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/stop`, {
      method: 'POST',
      headers: this.#adminHeaders(),
      timeoutMs: 15_000,
    })
  }

  async freeze(botId) {
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/freeze`, {
      method: 'POST',
      headers: this.#adminHeaders(),
      timeoutMs: 15_000,
    })
  }

  async thaw(botId) {
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/thaw`, {
      method: 'POST',
      headers: this.#adminHeaders(),
      timeoutMs: 15_000,
    })
  }

  async takeover(botId, reason = 'human') {
    await this.ensure(botId)
    const data = await this.#json(`/api/screens/${encodeURIComponent(botId)}/takeover?reason=${encodeURIComponent(reason)}`, {
      method: 'POST',
      headers: this.#adminHeaders(),
      timeoutMs: 25_000,
    })
    if (data?.stream_url && data.stream_url.startsWith('/')) {
      data.gateway_stream_url = `${this.gatewayUrl}${data.stream_url}`
    }
    return data
  }

  async release(botId) {
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/release`, {
      method: 'POST',
      headers: this.#adminHeaders(),
      timeoutMs: 10_000,
    })
  }

  async brake(botId) {
    const data = await this.#json(`/api/screens/${encodeURIComponent(botId)}/brake`, {
      method: 'POST',
      headers: this.#adminHeaders(),
      timeoutMs: 10_000,
    })
    this.#tokens.delete(botId)
    return data
  }

  async purge(botId) {
    try {
      const data = await this.#json(`/api/screens/${encodeURIComponent(botId)}`, {
        method: 'DELETE',
        headers: this.#adminHeaders(),
        timeoutMs: 15_000,
      })
      this.#tokens.delete(botId)
      this.#epochs.delete(botId)
      return data
    } catch (_error) {
      return { deleted: botId, skipped: true }
    }
  }

  async humanInput(botId, input) {
    await this.ensure(botId)
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/human_input`, {
      method: 'POST',
      headers: this.#adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input || {}),
      timeoutMs: 15_000,
    })
  }

  async preview(botId, { cached = true } = {}) {
    const qs = cached ? '?cached=1' : ''
    const res = await this.#req(`/api/screens/${encodeURIComponent(botId)}/preview${qs}`, {
      headers: this.#adminHeaders(),
      timeoutMs: 10_000,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const err = new Error(detail || `preview ${res.status}`)
      err.status = res.status
      throw err
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    return {
      buffer,
      mimeType: (res.headers.get('content-type') || 'image/jpeg').split(';')[0],
      frozen: res.headers.get('x-screen-frozen') === 'true',
    }
  }

  async previewDataUrl(botId) {
    try {
      const { buffer, mimeType } = await this.preview(botId, { cached: true })
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch (_error) {
      return ''
    }
  }

  async audit(botId, limit = 30) {
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/audit?limit=${Math.max(1, Math.min(200, Number(limit) || 30))}`, {
      headers: this.#adminHeaders(),
      timeoutMs: 8000,
    })
  }

  async listFiles(botId) {
    await this.ensure(botId)
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/files`, {
      headers: this.#adminHeaders(),
      timeoutMs: 8000,
    })
  }

  async uploadFile(botId, filename, buffer, mimeType = 'application/octet-stream') {
    await this.ensure(botId)
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimeType }), filename || 'upload.bin')
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/files`, {
      method: 'POST',
      headers: this.#adminHeaders(),
      body: form,
      timeoutMs: 30_000,
    })
  }

  async downloadFile(botId, name) {
    const res = await this.#req(`/api/screens/${encodeURIComponent(botId)}/files/${encodeURIComponent(name)}`, {
      headers: this.#adminHeaders(),
      timeoutMs: 30_000,
    })
    if (!res.ok) {
      const err = new Error(`File download failed (${res.status})`)
      err.status = res.status
      throw err
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') || 'application/octet-stream',
      name,
    }
  }

  async deleteFile(botId, name) {
    return this.#json(`/api/screens/${encodeURIComponent(botId)}/files/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: this.#adminHeaders(),
      timeoutMs: 10_000,
    })
  }

  // ---- Agent-facing operations -------------------------------------------

  async #agentToken(botId, forceRefresh = false) {
    if (!forceRefresh && this.#tokens.has(botId)) return this.#tokens.get(botId)
    const ensured = await this.ensure(botId)
    if (!ensured?.agent_token) throw new Error(`Missing agent token for ${botId}`)
    return ensured.agent_token
  }

  async #agentCall(bot, path, { method = 'GET', jsonBody, signal, retryOn401 = true } = {}) {
    const botId = bot.id
    let token = await this.#agentToken(botId)
    const headers = { 'X-Agent-Token': token }
    if (jsonBody !== undefined) headers['content-type'] = 'application/json'

    let res = await this.#req(path, {
      method,
      headers,
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
      timeoutMs: 45_000,
    })

    if (res.status === 401 && retryOn401) {
      token = await this.#agentToken(botId, true)
      headers['X-Agent-Token'] = token
      res = await this.#req(path, {
        method,
        headers,
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        timeoutMs: 45_000,
      })
    }

    if (res.status === 423) {
      const body = await res.json().catch(() => ({}))
      if (!this.approvals) {
        const err = new Error(body.hint || 'Human in control (423 Locked)')
        err.status = 423
        throw err
      }
      const previewDataUrl = await this.previewDataUrl(botId)
      const outcome = await this.approvals.askScreenHelp(bot, {
        category: 'human_takeover',
        reason: body.hint || '人类正在接管该虚拟屏，请等待人类完成操作并交还控制权。',
        previewDataUrl,
        state: body.state || 'HUMAN_TAKEOVER',
        signal,
      })
      if (!outcome?.released) {
        return { abortedByHuman: true, note: outcome?.note || 'Cancelled by human' }
      }
      // Retry once after human released control
      return this.#agentCall(bot, path, { method, jsonBody, signal, retryOn401: false })
    }

    return res
  }

  async screenshot(bot, { format = 'jpeg', includeFocus = false, signal } = {}) {
    return this.#withLock(bot.id, async () => {
      await this.ensure(bot.id)
      const res = await this.#agentCall(
        bot,
        `/api/agent/${encodeURIComponent(bot.id)}/screenshot?fmt=${encodeURIComponent(format)}&include_focus=${includeFocus ? '1' : '0'}`,
        { signal },
      )
      if (res?.abortedByHuman) return res
      if (!res.ok) throw new Error(`screenshot failed (${res.status}): ${await res.text()}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      const epoch = Number(res.headers.get('x-lease-epoch') || 0)
      if (epoch) this.#epochs.set(bot.id, epoch)
      let focused = {}
      try { focused = JSON.parse(res.headers.get('x-focused-window') || '{}') } catch (_e) { focused = {} }
      return {
        ok: true,
        buffer,
        mimeType: (res.headers.get('content-type') || 'image/jpeg').split(';')[0],
        width: Number(res.headers.get('x-screen-width') || 1280),
        height: Number(res.headers.get('x-screen-height') || 720),
        state: res.headers.get('x-screen-state') || 'AGENT_ACTIVE',
        resumedFromLongFreeze: res.headers.get('x-resumed-from-long-freeze') === 'true',
        focusedWindow: focused,
        epoch,
      }
    })
  }

  async #postAction(bot, endpoint, payload, { signal, observe = false } = {}) {
    return this.#withLock(bot.id, async () => {
      await this.ensure(bot.id)
      const res = await this.#agentCall(bot, `/api/agent/${encodeURIComponent(bot.id)}/${endpoint}`, {
        method: 'POST',
        jsonBody: payload,
        signal,
      })
      if (res?.abortedByHuman) return res
      if (!res.ok) throw new Error(`${endpoint} failed (${res.status}): ${await res.text()}`)
      const data = await res.json()
      if (Number.isFinite(Number(data?.epoch))) this.#epochs.set(bot.id, Number(data.epoch))
      if (observe) {
        await new Promise(r => setTimeout(r, 350))
        const shotRes = await this.#agentCall(
          bot,
          `/api/agent/${encodeURIComponent(bot.id)}/screenshot?fmt=jpeg&include_focus=1`,
          { signal },
        )
        if (shotRes?.ok) {
          data.screenshot = {
            buffer: Buffer.from(await shotRes.arrayBuffer()),
            mimeType: (shotRes.headers.get('content-type') || 'image/jpeg').split(';')[0],
            width: Number(shotRes.headers.get('x-screen-width') || 1280),
            height: Number(shotRes.headers.get('x-screen-height') || 720),
          }
        }
      }
      return data
    })
  }

  click(bot, { x, y, button = 1, double = false, observe = false, signal }) {
    return this.#postAction(bot, 'click', { x, y, button, double }, { observe, signal })
  }

  type(bot, { text = '', press_enter = false, paste_key = 'ctrl+v', observe = false, signal }) {
    return this.#postAction(bot, 'type', { text, press_enter, paste_key }, { observe, signal })
  }

  key(bot, { combo, observe = false, signal }) {
    return this.#postAction(bot, 'key', { combo }, { observe, signal })
  }

  scroll(bot, { x = 640, y = 360, clicks = 3, observe = false, signal }) {
    return this.#postAction(bot, 'scroll', { x, y, clicks }, { observe, signal })
  }

  drag(bot, { x1, y1, x2, y2, button = 1, observe = false, signal }) {
    return this.#postAction(bot, 'drag', { x1, y1, x2, y2, button }, { observe, signal })
  }

  openApp(bot, { app = 'chrome', url, observe = true, signal }) {
    return this.#postAction(bot, 'open_app', { app, url: url || null }, { observe, signal })
  }

  async windows(bot, { signal } = {}) {
    return this.#withLock(bot.id, async () => {
      await this.ensure(bot.id)
      const res = await this.#agentCall(bot, `/api/agent/${encodeURIComponent(bot.id)}/windows`, { signal })
      if (res?.abortedByHuman) return res
      if (!res.ok) throw new Error(`windows failed (${res.status}): ${await res.text()}`)
      return res.json()
    })
  }

  async requestHelp(bot, { category = 'manual', reason, roomId = '', signal } = {}) {
    await this.ensure(bot.id)
    const token = await this.#agentToken(bot.id)
    // Capture screenshot BEFORE switching to NEED_HUMAN (or right after, NEED_HUMAN allows screenshots)
    const reqRes = await this.#req(`/api/agent/${encodeURIComponent(bot.id)}/request_help`, {
      method: 'POST',
      headers: { 'X-Agent-Token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: `[${category}] ${reason}` }),
      timeoutMs: 15_000,
    })
    if (!reqRes.ok) throw new Error(`request_help failed (${reqRes.status}): ${await reqRes.text()}`)
    const previewDataUrl = await this.previewDataUrl(bot.id)

    if (!this.approvals) {
      throw new Error('Human takeover bridge is unavailable.')
    }
    const outcome = await this.approvals.askScreenHelp(bot, {
      category,
      reason,
      previewDataUrl,
      state: 'NEED_HUMAN',
      roomId,
      signal,
    })

    // Ensure screen is released on gateway and capture post-human screenshot
    if (outcome?.released) {
      await this.release(bot.id).catch(() => undefined)
      const shot = await this.screenshot(bot, { format: 'jpeg', includeFocus: true, signal }).catch(() => null)
      return {
        ok: true,
        released: true,
        note: outcome.note || '',
        screenshot: shot?.ok ? shot : null,
      }
    }
    return {
      ok: false,
      released: false,
      cancelled: true,
      note: outcome?.note || 'Human cancelled takeover request.',
    }
  }
}
