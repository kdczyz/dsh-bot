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
import { closeSync, existsSync, globSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statfsSync } from 'node:fs'
import net from 'node:net'
import os, { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { withFileLock } from './store.js'

const execFileAsync = promisify(execFile)
const DEFAULT_GATEWAY = 'http://127.0.0.1:6200'
const REQUIRED_GATEWAY_API_VERSION = 4
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const __dirname = dirname(fileURLToPath(import.meta.url))
// Keep in sync with botscreen/requirements.txt. Checking every runtime import avoids
// half-bootstrapped environments where the gateway process starts but immediately exits.
const PY_DEPS_CHECK = 'import fastapi, uvicorn, multipart, pydantic, PIL, Xlib, websockets, httpx'
const _pyChecked = new Map()

let _lastLocalCpuSample = null
let _lastLocalCpuPct = null

function readProcCpuJiffies() {
  try {
    const raw = readFileSync('/proc/stat', 'utf8')
    const first = raw.split('\n')[0] || ''
    if (!first.startsWith('cpu ')) return null
    const parts = first.trim().split(/\s+/).slice(1).map(Number).filter(Number.isFinite)
    if (parts.length < 4) return null
    const idle = parts[3] + (parts[4] || 0)
    const total = parts.reduce((acc, v) => acc + v, 0)
    return { total, idle }
  } catch (_error) {
    return null
  }
}

function readLocalMemInfo() {
  const out = {}
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8')
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':')
      if (idx === -1) continue
      const key = line.slice(0, idx).trim()
      const val = Number.parseInt(line.slice(idx + 1).trim().split(/\s+/)[0] || '', 10)
      if (Number.isFinite(val)) out[key] = val
    }
  } catch (_error) { /* non-linux fallback */ }
  return out
}

function formatLocalUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const zh = []
  const en = []
  if (days) { zh.push(`${days}天`); en.push(`${days}d`) }
  if (hours || days) { zh.push(`${hours}小时`); en.push(`${hours}h`) }
  zh.push(`${minutes}分`)
  en.push(`${minutes}m`)
  if (!days && !hours) { zh.push(`${secs}秒`); en.push(`${secs}s`) }
  return { formatted: zh.join(' '), formatted_en: en.join(' '), days, hours, minutes, secs }
}

/**
 * Pure Node.js fallback collector for the local Host machine when the local
 * BotScreen gateway is unavailable or pinned to an older non-replaceable build.
 * Never used for remote gateways.
 */
export function collectLocalHostSystem(diskPaths = ['/']) {
  const MIB = 1024 * 1024
  const GIB = 1024 * 1024 * 1024
  const nowSec = Date.now() / 1000
  const cores = Math.max(1, (os.cpus() || []).length || 1)
  const [l1, l5, l15] = os.loadavg()
  const loadAvg = {
    '1m': Math.round(l1 * 100) / 100,
    '5m': Math.round(l5 * 100) / 100,
    '15m': Math.round(l15 * 100) / 100,
  }

  let cpuPct = null
  let estimated = false
  const cur = readProcCpuJiffies()
  const nowMs = Date.now()
  if (cur) {
    if (_lastLocalCpuSample && (nowMs - _lastLocalCpuSample.at) < 150 && _lastLocalCpuPct !== null) {
      cpuPct = _lastLocalCpuPct
    } else if (_lastLocalCpuSample && cur.total > _lastLocalCpuSample.total) {
      const totalDiff = cur.total - _lastLocalCpuSample.total
      const idleDiff = Math.max(0, cur.idle - _lastLocalCpuSample.idle)
      cpuPct = Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100))
      _lastLocalCpuSample = { ...cur, at: nowMs }
      _lastLocalCpuPct = cpuPct
    } else {
      _lastLocalCpuSample = { ...cur, at: nowMs }
    }
  }
  if (cpuPct === null) {
    cpuPct = Math.max(0, Math.min(100, (l1 / cores) * 100))
    estimated = true
  }

  const memRaw = readLocalMemInfo()
  const totalBytes = memRaw.MemTotal ? memRaw.MemTotal * 1024 : os.totalmem()
  const availBytes = memRaw.MemAvailable ? memRaw.MemAvailable * 1024 : os.freemem()
  const freeBytes = memRaw.MemFree ? memRaw.MemFree * 1024 : os.freemem()
  const usedBytes = Math.max(0, totalBytes - availBytes)
  const memPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0
  const totalMb = Math.floor(totalBytes / MIB)
  const usedMb = Math.floor(usedBytes / MIB)
  const availMb = Math.floor(availBytes / MIB)
  const minFreeMb = Math.max(0, Number.parseInt(process.env.BOTSCREEN_MIN_FREE_MB || '1024', 10) || 1024)
  const blocker = (minFreeMb > 0 && availMb < minFreeMb)
    ? `内存不足，暂不拉起虚拟屏：可用 ${availMb} MB / 限额 ${totalMb} MB，需要至少 ${minFreeMb} MB（BOTSCREEN_MIN_FREE_MB）。`
    : null

  const cleanPaths = (Array.isArray(diskPaths) ? diskPaths : [diskPaths])
    .map(p => String(p || '').trim())
    .filter((p, i, arr) => p !== '' && arr.indexOf(p) === i)
  if (cleanPaths.length === 0) cleanPaths.push('/')

  const mounts = cleanPaths.map((p) => {
    try {
      const st = statfsSync(p)
      const bsize = Number(st.bsize || st.frsize || 4096)
      const total = Number(st.blocks || 0) * bsize
      const free = Number(st.bavail ?? st.bfree ?? 0) * bsize
      const used = Math.max(0, total - Number(st.bfree ?? st.bavail ?? 0) * bsize)
      const pct = total > 0 ? Math.round((used / total) * 1000) / 10 : 0
      return {
        path: p,
        total_bytes: total,
        used_bytes: used,
        free_bytes: free,
        total_gb: Math.round((total / GIB) * 100) / 100,
        used_gb: Math.round((used / GIB) * 100) / 100,
        free_gb: Math.round((free / GIB) * 100) / 100,
        usage_percent: pct,
        ok: true,
      }
    } catch (error) {
      return {
        path: p,
        total_bytes: null,
        used_bytes: null,
        free_bytes: null,
        total_gb: null,
        used_gb: null,
        free_gb: null,
        usage_percent: null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
  const primaryDisk = mounts.find(m => m.ok) || mounts[0]

  const upSecs = Math.max(0, Math.floor(os.uptime()))
  const upFmt = formatLocalUptime(upSecs)
  const bootIso = new Date(Math.max(0, Date.now() - upSecs * 1000)).toISOString()

  return {
    available: true,
    ok: true,
    degraded: true,
    source: 'host-fallback',
    hostname: os.hostname(),
    os: os.type(),
    arch: os.arch(),
    kernel: os.release(),
    platform: `${os.type()}-${os.release()}-${os.arch()}`,
    cgroup: false,
    timestamp: nowSec,
    collected_at: new Date().toISOString(),
    available_mb: availMb,
    limit_mb: totalMb,
    min_free_mb: minFreeMb,
    blocker,
    cpu: {
      usage_percent: Math.round(cpuPct * 10) / 10,
      cores,
      load_avg: loadAvg,
      estimated,
    },
    memory: {
      total_bytes: totalBytes,
      used_bytes: usedBytes,
      available_bytes: availBytes,
      free_bytes: freeBytes,
      total_mb: totalMb,
      used_mb: usedMb,
      available_mb: availMb,
      limit_mb: totalMb,
      usage_percent: memPct,
      swap_total_mb: Math.floor(((memRaw.SwapTotal || 0) * 1024) / MIB),
      swap_used_mb: Math.floor((Math.max(0, (memRaw.SwapTotal || 0) - (memRaw.SwapFree || 0)) * 1024) / MIB),
      min_free_mb: minFreeMb,
      blocker,
      cgroup_limited: false,
      source: 'host',
    },
    disk: {
      path: primaryDisk.path,
      total_bytes: primaryDisk.total_bytes,
      used_bytes: primaryDisk.used_bytes,
      free_bytes: primaryDisk.free_bytes,
      total_gb: primaryDisk.total_gb,
      used_gb: primaryDisk.used_gb,
      free_gb: primaryDisk.free_gb,
      usage_percent: primaryDisk.usage_percent,
      mounts,
    },
    uptime: {
      seconds: upSecs,
      days: upFmt.days,
      hours: upFmt.hours,
      minutes: upFmt.minutes,
      secs: upFmt.secs,
      formatted: upFmt.formatted,
      formatted_en: upFmt.formatted_en,
      boot_time: bootIso,
    },
  }
}

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
    'Xvfb', 'xauth', 'xdotool', 'xclip', 'openbox',
  ]
  const missingBins = requiredBins.filter(name =>
    !runQuiet('sh', ['-c', `command -v ${name} >/dev/null 2>&1`], { timeout: 10_000 }),
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
    const isExplicitRoot = Boolean(botscreenRoot && dir === resolve(botscreenRoot))
    const pyCandidates = [
      join(dir, '.venv', 'bin', 'python'),
      ...(isExplicitRoot ? [] : [join(pluginRoot, '.venv', 'bin', 'python')]),
      defaultVenvPython,
      ...(isExplicitRoot ? [] : [join(repoRoot, '.venv', 'bin', 'python')]),
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

function findLocalGatewayPidsOnPort(port, hintedPid = 0) {
  const pids = new Set()
  const isBotscreenProc = (pid) => {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+/g, ' ')
      return cmd.includes('botscreen') || cmd.includes('uvicorn')
    } catch (_e) {
      return false
    }
  }
  if (hintedPid > 0 && isBotscreenProc(hintedPid)) pids.add(hintedPid)

  const inodes = new Set()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const lines = readFileSync(table, 'utf8').split('\n').slice(1)
      for (const line of lines) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 10 || cols[3] !== '0A') continue
        const hexPort = (cols[1].split(':')[1] || '')
        if (Number.parseInt(hexPort, 16) === port && cols[9] !== '0') {
          inodes.add(`socket:[${cols[9]}]`)
        }
      }
    } catch (_e) { /* non-linux or unreadable */ }
  }
  if (inodes.size === 0) return [...pids]

  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      if (pid === process.pid) continue
      let fds
      try { fds = readdirSync(`/proc/${pid}/fd`) } catch (_e) { continue }
      for (const fd of fds) {
        try {
          const link = readlinkSync(`/proc/${pid}/fd/${fd}`)
          if (inodes.has(link) && isBotscreenProc(pid)) {
            pids.add(pid)
            break
          }
        } catch (_e) { /* ignore */ }
      }
    }
  } catch (_e) { /* ignore */ }
  return [...pids]
}

function isPortListening(host, port, timeoutMs = 400) {
  return new Promise((resolvePort) => {
    const sock = net.connect({ host: host || '127.0.0.1', port })
    const done = (open) => {
      sock.destroy()
      resolvePort(open)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

export class ScreenBridge {
  #tokens = new Map() // botId -> agent_token
  #epochs = new Map() // botId -> epoch
  #locks = new Map() // botId -> Promise chain
  #gatewayAvailable = null
  #autoSpawn = false
  #explicitAutoSpawn = undefined
  #defaultGatewayUrl = DEFAULT_GATEWAY
  #defaultAdminToken = ''
  #botscreenRoot = ''
  #pythonBin = ''
  #logDir = ''
  #bootPromise = null
  #lastError = ''
  #bootAttempted = false

  constructor({ approvals, logger, gatewayUrl, adminToken, autoSpawn, botscreenRoot, pythonBin, logDir } = {}) {
    this.approvals = approvals || null
    this.logger = logger || null
    this.#defaultGatewayUrl = String(gatewayUrl || process.env.BOTSCREEN_GATEWAY || DEFAULT_GATEWAY).replace(/\/$/, '')
    this.#defaultAdminToken = String(adminToken ?? process.env.BOTSCREEN_ADMIN_TOKEN ?? '').trim()
    this.gatewayUrl = this.#defaultGatewayUrl
    this.adminToken = this.#defaultAdminToken
    this.#botscreenRoot = String(botscreenRoot || '').trim()
    this.#pythonBin = String(pythonBin || '').trim()
    this.#logDir = String(logDir || '').trim()
    this.#explicitAutoSpawn = typeof autoSpawn === 'boolean' ? autoSpawn : undefined
    // A different root/python combination may replace a previously probed executable.
    // Drop global interpreter probes for explicitly supplied environments so reinstalls
    // and embedded test fixtures re-evaluate their actual dependencies.
    for (const python of [this.#pythonBin, join(this.#botscreenRoot, 'screen-venv', 'bin', 'python')]) {
      if (python) _pyChecked.delete(python)
    }

    this.#refreshAutoSpawn()
  }

  #refreshAutoSpawn() {
    // Default auto-spawn is enabled for the standard local gateway (or when explicit root/autoSpawn is given),
    // while preserving safe isolation for tests running against mock gateways on ephemeral ports.
    const envOpt = process.env.BOTSCREEN_AUTO_START
    if (typeof this.#explicitAutoSpawn === 'boolean') {
      this.#autoSpawn = this.#explicitAutoSpawn
    } else if (envOpt === '0' || envOpt === 'false') {
      this.#autoSpawn = false
    } else if (envOpt === '1' || envOpt === 'true' || this.#botscreenRoot !== '') {
      this.#autoSpawn = true
    } else {
      this.#autoSpawn = this.#isDefaultLocalGateway()
    }
  }

  configure({ gatewayUrl, adminToken } = {}) {
    const nextUrl = typeof gatewayUrl === 'string' && gatewayUrl.trim() !== ''
      ? gatewayUrl.trim().replace(/\/+$/, '')
      : this.#defaultGatewayUrl
    const nextToken = typeof adminToken === 'string' && adminToken.trim() !== ''
      ? adminToken.trim()
      : this.#defaultAdminToken
    const changed = nextUrl !== this.gatewayUrl || nextToken !== this.adminToken
    if (changed) {
      this.gatewayUrl = nextUrl
      this.adminToken = nextToken
      this.#gatewayAvailable = null
      this.#lastError = ''
      this.#bootAttempted = false
      this.#tokens.clear()
      this.#epochs.clear()
      this.#refreshAutoSpawn()
    }
    return {
      gatewayUrl: this.gatewayUrl,
      hasAdminToken: Boolean(this.adminToken),
      changed,
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

  async #evictOutdatedLocalGateway(host, port, hintedPid = 0) {
    try {
      await fetch(`${this.gatewayUrl}/api/admin/shutdown`, {
        method: 'POST',
        headers: this.#adminHeaders(),
        signal: AbortSignal.timeout(1200),
      }).catch(() => undefined)
    } catch (_e) { /* ignore */ }

    const pids = findLocalGatewayPidsOnPort(port, hintedPid)
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM') } catch (_e) { /* ignore */ }
    }

    const waitDeadline = Date.now() + 3000
    let escalated = false
    while (Date.now() < waitDeadline) {
      const open = await isPortListening(host, port)
      if (!open) return true
      if (!escalated && Date.now() + 1000 >= waitDeadline) {
        escalated = true
        for (const pid of findLocalGatewayPidsOnPort(port, hintedPid)) {
          try { process.kill(pid, 'SIGKILL') } catch (_e) { /* ignore */ }
        }
      }
      await new Promise(r => setTimeout(r, 150))
    }
    return !(await isPortListening(host, port))
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
    const bootLockPath = join(logBase, `botscreen-boot-${port || 6200}.lock`)
    return withFileLock(bootLockPath, async () => {
      // Re-check health after acquiring cross-process boot lock in case another instance just started it.
      const recheck = await this.health()
      if (recheck.available) {
        this.#lastError = ''
        return { available: true, spawned: false }
      }
      if (recheck.outdated) {
        this.logger?.info?.(`botmode: replacing outdated local BotScreen gateway (v${recheck.foundVersion || 1}) at ${this.gatewayUrl}`)
        const freed = await this.#evictOutdatedLocalGateway(host || '127.0.0.1', port || 6200, recheck.pid || 0)
        if (!freed) {
          this.#lastError = `端口 ${port || 6200} 被旧版网关占用且无法自动停止（可能由 root/systemd 启动），请手动重启该服务以加载新版接口`
          return { available: false, spawned: false, error: this.#lastError }
        }
      }
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
            BOTSCREEN_BOTS: process.env.BOTSCREEN_BOTS ?? '',
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
    }, { timeoutMs: Math.max(20_000, timeoutMs + 5_000), staleMs: 60_000 })
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
      const apiVersion = Number(data?.api_version || 1)
      const caps = Array.isArray(data?.capabilities) ? data.capabilities : []
      const outdated = apiVersion < REQUIRED_GATEWAY_API_VERSION
        || (caps.length > 0 && (!caps.includes('tile_stream') || !caps.includes('system_info')))
      if (outdated && this.#autoSpawn && this.isLocalGateway()) {
        this.#gatewayAvailable = false
        const msg = `检测到旧版网关 (v${apiVersion}) 占用端口，缺少 ensure / 增量帧 / 主机系统信息路由`
        return {
          available: false,
          outdated: true,
          foundVersion: apiVersion,
          pid: Number(data?.pid || 0),
          gatewayUrl: this.gatewayUrl,
          error: msg,
        }
      }
      const available = data?.ok !== false
      this.#gatewayAvailable = available
      this.#lastError = available ? '' : `BotScreen 缺少系统组件: ${(data?.missing || []).join(', ') || 'unknown'}`
      return { available, outdated, gatewayUrl: this.gatewayUrl, ...data }
    } catch (error) {
      this.#gatewayAvailable = false
      return { available: false, gatewayUrl: this.gatewayUrl, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async #withSystemGatewayRetry(fn) {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      await this.ensureGateway().catch(() => undefined)
    }
    try {
      return await fn()
    } catch (error) {
      if ((error?.status === 404 || error?.status === undefined) && this.canAutoStart()) {
        this.#gatewayAvailable = false
        const ready = await this.ensureGateway().catch(() => ({ available: false }))
        if (ready?.available) {
          return await fn()
        }
      }
      throw error
    }
  }

  async listScreens() {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      const probe = await this.health()
      if (!probe.available && !this.#bootPromise) {
        void this.ensureGateway()
      }
      if (!probe.available) {
        return {
          available: false,
          gatewayUrl: this.gatewayUrl,
          autoStartable: this.canAutoStart(),
          starting: Boolean(this.#bootPromise),
          screens: [],
          host: null,
          error: this.#lastError || probe.error || '',
        }
      }
    }
    try {
      const data = await this.#json('/api/screens', {
        headers: this.#adminHeaders(),
        timeoutMs: 3000,
      })
      // If a local gateway responded without full host telemetry (legacy v2/v3 build),
      // trigger an async health/upgrade check so the next poll gets full host info.
      if (data?.host && !data.host.cpu && this.canAutoStart() && !this.#bootPromise) {
        void this.health().then((probe) => {
          if (probe?.outdated && !this.#bootPromise) void this.ensureGateway()
        }).catch(() => undefined)
      }
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

  async getSystemInfo({ diskPaths, timeoutMs = 5000 } = {}) {
    const qs = Array.isArray(diskPaths) && diskPaths.length > 0
      ? `?disk_path=${encodeURIComponent(diskPaths.join(','))}`
      : (typeof diskPaths === 'string' && diskPaths.trim() !== ''
        ? `?disk_path=${encodeURIComponent(diskPaths.trim())}`
        : '')
    try {
      const data = await this.#withSystemGatewayRetry(() => this.#json(`/api/system${qs}`, {
        headers: this.#adminHeaders(),
        timeoutMs,
      }))
      this.#gatewayAvailable = true
      this.#lastError = ''
      return {
        available: true,
        source: 'gateway',
        gatewayUrl: this.gatewayUrl,
        ...data,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return {
        available: false,
        ok: false,
        source: 'gateway',
        gatewayUrl: this.gatewayUrl,
        error: msg,
        status: error?.status,
      }
    }
  }

  async getSystemConfig({ timeoutMs = 5000 } = {}) {
    return this.#withSystemGatewayRetry(() => this.#json('/api/system/config', {
      headers: this.#adminHeaders(),
      timeoutMs,
    }))
  }

  async updateSystemConfig(patch = {}, { timeoutMs = 8000 } = {}) {
    const body = {}
    if (typeof patch.enabled === 'boolean') body.enabled = patch.enabled
    if (Array.isArray(patch.diskPaths)) body.disk_paths = patch.diskPaths
    else if (Array.isArray(patch.disk_paths)) body.disk_paths = patch.disk_paths
    else if (typeof patch.diskPath === 'string') body.disk_path = patch.diskPath
    else if (typeof patch.disk_path === 'string') body.disk_path = patch.disk_path
    if (patch.refreshIntervalSec !== undefined) body.stream_interval_sec = Number(patch.refreshIntervalSec)
    else if (patch.stream_interval_sec !== undefined) body.stream_interval_sec = Number(patch.stream_interval_sec)
    if (patch.frameRate !== undefined) body.frame_rate = Number(patch.frameRate)
    else if (patch.frame_rate !== undefined) body.frame_rate = Number(patch.frame_rate)
    if (typeof patch.pushUrl === 'string') body.push_url = patch.pushUrl
    else if (typeof patch.push_url === 'string') body.push_url = patch.push_url
    if (patch.pushIntervalSec !== undefined) body.push_interval_sec = Number(patch.pushIntervalSec)
    else if (patch.push_interval_sec !== undefined) body.push_interval_sec = Number(patch.push_interval_sec)
    if (typeof patch.pushToken === 'string') body.push_token = patch.pushToken
    else if (typeof patch.push_token === 'string') body.push_token = patch.push_token

    return this.#withSystemGatewayRetry(() => this.#json('/api/system/config', {
      method: 'PUT',
      headers: this.#adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      timeoutMs,
    }))
  }

  async pushSystemInfo({ url, token, diskPaths, timeoutMs = 10_000 } = {}) {
    const body = {}
    if (typeof url === 'string' && url.trim() !== '') body.url = url.trim()
    if (typeof token === 'string' && token.trim() !== '') body.token = token.trim()
    if (Array.isArray(diskPaths) && diskPaths.length > 0) body.disk_paths = diskPaths
    else if (typeof diskPaths === 'string' && diskPaths.trim() !== '') body.disk_path = diskPaths.trim()

    return this.#withSystemGatewayRetry(() => this.#json('/api/system/push', {
      method: 'POST',
      headers: this.#adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      timeoutMs,
    }))
  }

  async openSystemStream({ interval, diskPaths, signal } = {}) {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      const ready = await this.ensureGateway()
      if (!ready.available) throw new Error(ready.error || 'BotScreen gateway unavailable')
    }
    const params = new URLSearchParams()
    if (interval !== undefined && Number.isFinite(Number(interval))) {
      params.set('interval', String(Number(interval)))
    }
    if (Array.isArray(diskPaths) && diskPaths.length > 0) {
      params.set('disk_path', diskPaths.join(','))
    } else if (typeof diskPaths === 'string' && diskPaths.trim() !== '') {
      params.set('disk_path', diskPaths.trim())
    }
    const qs = params.toString() ? `?${params.toString()}` : ''
    const connect = () => fetch(`${this.gatewayUrl}/api/system/stream${qs}`, {
      headers: this.#adminHeaders({ accept: 'text/event-stream' }),
      signal,
    })
    let res = await connect()
    if (res.status === 404 && this.canAutoStart()) {
      this.#gatewayAvailable = false
      const ready = await this.ensureGateway().catch(() => ({ available: false }))
      if (ready?.available) {
        res = await connect()
      }
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      const err = new Error(detail || `system stream ${res.status}`)
      err.status = res.status
      throw err
    }
    this.#gatewayAvailable = true
    return res
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
      // Gateway may have stopped or been replaced by an outdated v1 gateway (404 on /ensure); auto-upgrade & retry.
      if ((error?.status === undefined || error?.status === 404) && this.canAutoStart()) {
        this.#gatewayAvailable = false
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
      if (error?.status === 404) {
        throw new Error(`BotScreen 网关 (${this.gatewayUrl}) 运行的是旧版服务，不存在 /api/screens/${botId}/ensure 注册路由，请重启或升级网关。`)
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
    return this.#withLock(botId, async () => {
      const send = () => this.#json(`/api/screens/${encodeURIComponent(botId)}/human_input`, {
        method: 'POST',
        headers: this.#adminHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(input || {}),
        timeoutMs: 15_000,
      })
      try {
        return await send()
      } catch (error) {
        if (error?.status === 404 || error?.status === undefined) {
          await this.ensure(botId)
          return send()
        }
        throw error
      }
    })
  }

  async openTileStream(botId, { format = 'jpeg', signal } = {}) {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      const ready = await this.ensureGateway()
      if (!ready.available) throw new Error(ready.error || 'BotScreen gateway unavailable')
    }
    const url = `${this.gatewayUrl}/api/screens/${encodeURIComponent(botId)}/stream?fmt=${encodeURIComponent(format)}`
    const connect = () => fetch(url, {
      headers: this.#adminHeaders({ accept: 'text/event-stream' }),
      signal,
    })
    let res = await connect()
    if (res.status === 404 && this.canAutoStart()) {
      this.#gatewayAvailable = false
      const ready = await this.ensureGateway()
      if (ready.available) {
        await this.ensure(botId)
        res = await connect()
      }
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      const err = new Error(detail || `stream ${res.status}`)
      err.status = res.status
      throw err
    }
    this.#gatewayAvailable = true
    return res
  }

  async preview(botId, { cached = true, onlyCached = false, ifNoneMatch = '' } = {}) {
    const params = new URLSearchParams()
    if (cached) params.set('cached', '1')
    if (onlyCached) params.set('only_cached', '1')
    const qs = params.toString() ? `?${params.toString()}` : ''
    const extraHeaders = ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}
    const res = await this.#req(`/api/screens/${encodeURIComponent(botId)}/preview${qs}`, {
      headers: this.#adminHeaders(extraHeaders),
      timeoutMs: 10_000,
    })
    const etag = res.headers.get('etag') || ''
    const width = Number(res.headers.get('x-screen-width'))
    const height = Number(res.headers.get('x-screen-height'))
    if (res.status === 304) {
      return {
        notModified: true,
        etag,
        frozen: res.headers.get('x-screen-frozen') === 'true',
        width: Number.isFinite(width) && width > 0 ? width : undefined,
        height: Number.isFinite(height) && height > 0 ? height : undefined,
      }
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const err = new Error(detail || `preview ${res.status}`)
      err.status = res.status
      throw err
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    return {
      notModified: false,
      buffer,
      etag,
      mimeType: (res.headers.get('content-type') || 'image/jpeg').split(';')[0],
      frozen: res.headers.get('x-screen-frozen') === 'true',
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
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

  // ---- Bot Avatar gateway transport --------------------------------------

  async syncAvatar(botId, avatar) {
    if (!botId || !avatar || typeof avatar !== 'object') return { skipped: true }
    try {
      return await this.#json(`/api/screens/${encodeURIComponent(botId)}/avatar`, {
        method: 'PUT',
        headers: this.#adminHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(avatar),
        timeoutMs: 3000,
      })
    } catch (_error) {
      return { skipped: true, bot_id: botId }
    }
  }

  async getAvatar(botId) {
    try {
      return await this.#json(`/api/screens/${encodeURIComponent(botId)}/avatar`, {
        headers: this.#adminHeaders(),
        timeoutMs: 3000,
      })
    } catch (_error) {
      return { bot_id: botId, avatar: null }
    }
  }

  async deleteAvatar(botId) {
    try {
      return await this.#json(`/api/screens/${encodeURIComponent(botId)}/avatar`, {
        method: 'DELETE',
        headers: this.#adminHeaders(),
        timeoutMs: 3000,
      })
    } catch (_error) {
      return { deleted: botId, skipped: true }
    }
  }

  async listAvatars() {
    try {
      return await this.#json('/api/avatars', {
        headers: this.#adminHeaders(),
        timeoutMs: 3000,
      })
    } catch (_error) {
      return { avatars: {} }
    }
  }

  // ---- Agent Reply Artifact gateway transport ----------------------------

  artifactDownloadUrl(artifactId, { botId = '', inline = false, filename = '' } = {}) {
    const base = botId
      ? `${this.gatewayUrl}/api/screens/${encodeURIComponent(botId)}/artifacts/${encodeURIComponent(artifactId)}/download`
      : `${this.gatewayUrl}/api/artifacts/${encodeURIComponent(artifactId)}/download`
    const params = new URLSearchParams()
    if (inline) params.set('inline', '1')
    if (filename) params.set('filename', filename)
    const qs = params.toString()
    return qs ? `${base}?${qs}` : base
  }

  async publishArtifact(botId, artifact = {}) {
    if (!botId) throw new Error('botId is required to publish an artifact')
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      await this.ensureGateway().catch(() => undefined)
    }
    const path = `/api/screens/${encodeURIComponent(botId)}/artifacts`
    if (Buffer.isBuffer(artifact.buffer) || artifact.buffer instanceof Uint8Array) {
      const form = new FormData()
      const filename = artifact.filename || artifact.name || 'artifact.bin'
      const mimeType = artifact.mimeType || artifact.mime_type || 'application/octet-stream'
      form.append('file', new Blob([artifact.buffer], { type: mimeType }), filename)
      if (artifact.artifactId || artifact.artifact_id || artifact.id) {
        form.append('artifact_id', String(artifact.artifactId || artifact.artifact_id || artifact.id))
      }
      if (artifact.title) form.append('title', String(artifact.title))
      if (filename) form.append('filename', String(filename))
      if (artifact.kind) form.append('kind', String(artifact.kind))
      if (artifact.type || artifact.artifactType || artifact.artifact_type) {
        form.append('artifact_type', String(artifact.artifact_type || artifact.artifactType || artifact.type))
      }
      if (mimeType) form.append('mime_type', String(mimeType))
      if (artifact.roomId || artifact.room_id) form.append('room_id', String(artifact.room_id || artifact.roomId))
      if (artifact.roomName || artifact.room_name) form.append('room_name', String(artifact.room_name || artifact.roomName))
      if (artifact.messageId || artifact.message_id) form.append('message_id', String(artifact.message_id || artifact.messageId))
      if (artifact.sourcePath || artifact.source_path) form.append('source_path', String(artifact.source_path || artifact.sourcePath))
      if (artifact.metadata && typeof artifact.metadata === 'object') {
        form.append('metadata', JSON.stringify(artifact.metadata))
      }
      return this.#json(path, {
        method: 'POST',
        headers: this.#adminHeaders(),
        body: form,
        timeoutMs: 45_000,
      })
    }

    const payload = {
      ...(artifact.artifactId || artifact.artifact_id || artifact.id
        ? { artifact_id: String(artifact.artifactId || artifact.artifact_id || artifact.id) }
        : {}),
      title: String(artifact.title ?? ''),
      ...(artifact.filename || artifact.name ? { filename: String(artifact.filename || artifact.name) } : {}),
      kind: String(artifact.kind || 'artifact'),
      artifact_type: String(artifact.artifact_type || artifact.artifactType || artifact.type || ''),
      ...(artifact.mimeType || artifact.mime_type ? { mime_type: String(artifact.mime_type || artifact.mimeType) } : {}),
      content: typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content ?? ''),
      encoding: String(artifact.encoding || 'utf-8'),
      room_id: String(artifact.room_id || artifact.roomId || ''),
      room_name: String(artifact.room_name || artifact.roomName || ''),
      message_id: String(artifact.message_id || artifact.messageId || ''),
      source_path: String(artifact.source_path || artifact.sourcePath || ''),
      metadata: artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {},
    }
    return this.#json(path, {
      method: 'POST',
      headers: this.#adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    })
  }

  async listArtifacts({ botId = '', roomId = '', kind = '', limit = 100, timeoutMs = 8000 } = {}) {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      await this.ensureGateway().catch(() => undefined)
    }
    const params = new URLSearchParams()
    if (roomId) params.set('room_id', roomId)
    if (kind) params.set('kind', kind)
    if (Number.isFinite(Number(limit))) params.set('limit', String(Math.max(1, Math.min(500, Math.trunc(Number(limit))))))
    const qs = params.toString() ? `?${params.toString()}` : ''
    const path = botId
      ? `/api/screens/${encodeURIComponent(botId)}/artifacts${qs}`
      : `/api/artifacts${qs}`
    return this.#json(path, {
      headers: this.#adminHeaders(),
      timeoutMs,
    })
  }

  async getArtifact(artifactId, { botId = '', timeoutMs = 8000 } = {}) {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      await this.ensureGateway().catch(() => undefined)
    }
    const path = botId
      ? `/api/screens/${encodeURIComponent(botId)}/artifacts/${encodeURIComponent(artifactId)}`
      : `/api/artifacts/${encodeURIComponent(artifactId)}`
    return this.#json(path, {
      headers: this.#adminHeaders(),
      timeoutMs,
    })
  }

  async openArtifactDownloadStream(artifactId, { botId = '', inline = false, filename = '', signal } = {}) {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      await this.ensureGateway().catch(() => undefined)
    }
    const url = this.artifactDownloadUrl(artifactId, { botId, inline, filename })
    const res = await fetch(url, {
      headers: this.#adminHeaders(),
      signal: signal || AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const err = new Error(detail || `artifact download failed (${res.status})`)
      err.status = res.status
      throw err
    }
    this.#gatewayAvailable = true
    return res
  }

  async downloadArtifact(artifactId, { botId = '', inline = false, filename = '', signal } = {}) {
    const res = await this.openArtifactDownloadStream(artifactId, { botId, inline, filename, signal })
    const buffer = Buffer.from(await res.arrayBuffer())
    const disp = res.headers.get('content-disposition') || ''
    const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disp)
    const asciiMatch = /filename="([^"]+)"/i.exec(disp)
    let resolvedName = filename || artifactId
    try {
      if (utf8Match?.[1]) resolvedName = decodeURIComponent(utf8Match[1])
      else if (asciiMatch?.[1]) resolvedName = asciiMatch[1]
    } catch (_error) { /* keep fallback */ }
    return {
      buffer,
      mimeType: res.headers.get('content-type') || 'application/octet-stream',
      contentDisposition: disp,
      filename: resolvedName,
      artifactId: res.headers.get('x-artifact-id') || artifactId,
      botId: res.headers.get('x-bot-id') || botId,
      sha256: res.headers.get('x-artifact-sha256') || '',
      kind: res.headers.get('x-artifact-kind') || '',
      size: buffer.byteLength,
      source: res.headers.get('x-artifact-source') || 'gateway',
    }
  }

  async openArtifactsBundleStream({ artifactIds = [], botId = '', roomId = '', filename = '', signal } = {}) {
    if (this.#gatewayAvailable !== true && this.canAutoStart()) {
      await this.ensureGateway().catch(() => undefined)
    }
    const body = {}
    if (Array.isArray(artifactIds) && artifactIds.length > 0) body.artifact_ids = artifactIds
    if (botId) body.bot_id = botId
    if (roomId) body.room_id = roomId
    if (filename) body.filename = filename
    const res = await fetch(`${this.gatewayUrl}/api/artifacts/bundle`, {
      method: 'POST',
      headers: this.#adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(90_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const err = new Error(detail || `artifact bundle failed (${res.status})`)
      err.status = res.status
      throw err
    }
    this.#gatewayAvailable = true
    return res
  }

  async deleteArtifact(artifactId, { botId = '', timeoutMs = 10_000 } = {}) {
    const path = botId
      ? `/api/screens/${encodeURIComponent(botId)}/artifacts/${encodeURIComponent(artifactId)}`
      : `/api/artifacts/${encodeURIComponent(artifactId)}`
    return this.#json(path, {
      method: 'DELETE',
      headers: this.#adminHeaders(),
      timeoutMs,
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
