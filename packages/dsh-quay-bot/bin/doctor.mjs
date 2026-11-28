#!/usr/bin/env node
/**
 * dsh-quay-bot · doctor
 *
 * Zero-dependency preflight for the bundled BotScreen gateway. Everything this script
 * checks is normally handled automatically the first time the plugin boots; run it when
 * you want to know *why* the virtual desktop is not coming up.
 *
 *   npx dsh-quay-bot            # report
 *   npx dsh-quay-bot --json     # machine-readable
 *   npx dsh-quay-bot --fix-hint # only print the exact copy-paste commands
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const JSON_OUT = process.argv.includes('--json')
const HINT_ONLY = process.argv.includes('--fix-hint')

/** Keep in sync with `host/screen.js` → REQUIRED_BINS / AUTO_SYSTEM_PACKAGES. */
const REQUIRED_BINS = [
  'Xvfb', 'xauth', 'xdotool', 'xclip', 'openbox',
  'tint2', 'picom', 'pcmanfm', 'xterm', 'xfwm4', 'xfdesktop4',
  'x11vnc', 'websockify', 'feh',
]
const APT_PACKAGES = [
  'xvfb', 'x11vnc', 'websockify', 'novnc', 'xauth',
  'xfwm4', 'xfdesktop4', 'xfconf', 'dbus-x11', 'tint2', 'picom', 'pcmanfm',
  'xterm', 'xdotool', 'xclip',
  'glib-networking', 'gvfs', 'gvfs-daemons', 'feh',
  'adwaita-icon-theme', 'fonts-noto-color-emoji', 'fonts-noto-cjk',
]
const PY_IMPORTS = ['fastapi', 'uvicorn', 'multipart', 'PIL', 'Xlib', 'websockets', 'httpx', 'mss']

function which(bin) {
  try {
    return execFileSync('sh', ['-c', `command -v ${bin} 2>/dev/null`], { encoding: 'utf8', timeout: 8000 }).trim()
  } catch {
    return ''
  }
}

function pythonInfo() {
  const candidates = [process.env.BOTSCREEN_PYTHON, join(process.env.HOME || '', '.dsh', 'botmode', 'screen-venv', 'bin', 'python'), 'python3'].filter(Boolean)
  for (const py of candidates) {
    if (py !== 'python3' && !existsSync(py)) continue
    try {
      const version = execFileSync(py, ['-V'], { encoding: 'utf8', timeout: 8000 }).trim()
      let imports = 'missing'
      try {
        execFileSync(py, ['-c', `import ${PY_IMPORTS.join(', ')}`], { stdio: 'ignore', timeout: 15000 })
        imports = 'ok'
      } catch { /* keep missing */ }
      return { python: py, version, imports }
    } catch { /* next */ }
  }
  return { python: '', version: '', imports: 'no-python' }
}

function wheelSets() {
  const base = join(ROOT, 'vendor', 'wheels')
  const arch = process.arch === 'arm64' ? 'linux-aarch64' : process.arch === 'x64' ? 'linux-x86_64' : ''
  return ['any', arch].filter(Boolean).map(dir => {
    const path = join(base, dir)
    const present = existsSync(path)
    let wheels = 0
    if (present) {
      try {
        wheels = readdirSync(path).filter(name => name.endsWith('.whl')).length
      } catch { wheels = 0 }
    }
    return { dir, present, wheels }
  })
}

async function gatewayHealth() {
  const url = process.env.BOTSCREEN_GATEWAY || 'http://127.0.0.1:6200'
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { url, ok: false, status: res.status }
    const body = await res.json()
    return { url, ok: true, apiVersion: body.api_version }
  } catch (error) {
    return { url, ok: false, error: String(error?.message || error) }
  }
}

const missingBins = REQUIRED_BINS.filter(bin => !which(bin))
const py = pythonInfo()
const health = await gatewayHealth()
const nodeMajor = Number(process.versions.node.split('.')[0])
const nodeOk = nodeMajor >= 22
const pythonOk = Boolean(py.python)
const depsOk = py.imports === 'ok'
const binsOk = missingBins.length === 0
const wheelsOk = wheelSets().every(set => set.present)
/* The gateway bootstraps Python deps from the bundle and installs the system packages
   itself, so missing bins/deps are fixable on the next boot; only Node and Python block. */
const serviceable = nodeOk && pythonOk && (depsOk || wheelsOk)
const offlineCoversInterpreter = py.version.startsWith('Python 3.12')

const report = {
  package: 'dsh-quay-bot',
  root: ROOT,
  node: { version: process.version, ok: nodeOk, need: '>=22.13' },
  python: { ...py, ok: pythonOk, depsOk },
  systemBins: { missing: missingBins, ok: binsOk },
  bundledWheels: wheelSets(),
  gateway: health,
  offlineCoversInterpreter,
  serviceable,
}

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(serviceable ? 0 : 1)
}

const mark = ok => (ok ? '✓' : '✗')
if (!HINT_ONLY) {
  console.log('dsh-quay-bot doctor\n')
  console.log(`${mark(nodeOk)} node ${process.version} (need >= 22.13)`)
  console.log(`${mark(pythonOk)} python ${py.python || '(not found)'} ${py.version}`)
  console.log(`${mark(depsOk)} python deps (fastapi uvicorn python-multipart pillow python-xlib websockets httpx mss)${depsOk ? '' : (wheelsOk ? ' · will install from bundled wheels' : ' · will install from PyPI')}`)
  console.log(`${mark(binsOk)} system bins${missingBins.length ? ` · missing: ${missingBins.join(', ')} (auto-installed on boot)` : ''}`)
  console.log(`${mark(health.ok)} gateway ${health.url}${health.ok ? ` · api v${health.apiVersion}` : ''}`)
  for (const set of report.bundledWheels) console.log(`${mark(set.present)} bundled wheels vendor/wheels/${set.dir}`)
  const note = offlineCoversInterpreter || depsOk ? '' : '\nnote: bundled wheels cover CPython 3.12 only; this interpreter gets its deps from PyPI on first boot.'
  console.log(`${serviceable ? '\nready — the plugin installs and boots without further setup' : '\nnot ready — see the commands below'}${note}\n`)
}

const hints = []
if (!nodeOk) hints.push('# upgrade Node.js to >= 22.13 (DSH itself needs >= 24.9)')
if (!pythonOk) hints.push('sudo apt-get install -y python3 python3-venv')
if (missingBins.length) hints.push(`sudo apt-get install -y --no-install-recommends ${APT_PACKAGES.join(' ')}`)
if (pythonOk && !depsOk) {
  hints.push(`# deps are installed automatically on first boot; to do it now:`)
  hints.push(`python3 -m venv ~/.dsh/botmode/screen-venv && ~/.dsh/botmode/screen-venv/bin/pip install -r ${join(ROOT, 'botscreen', 'requirements.txt')}`)
}
if (hints.length) {
  console.log('# suggested commands')
  for (const line of hints) console.log(line)
}
process.exit(serviceable ? 0 : 1)
process.exit(ready ? 0 : 1)