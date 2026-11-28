#!/usr/bin/env node
/**
 * dsh-remote CLI
 *
 *   dsh-remote up [--foreground|--detach]   启动整条链路（relay + tunnel）
 *   dsh-remote stop [--all]                         停止
 *   dsh-remote status [--json]              运行态
 *   dsh-remote link [--rotate] [--legacy|--app]   打印/轮换公网加密链接
 *   dsh-remote rotate [--psk|--identity|--app]    立即轮换密钥
 *   dsh-remote tunnel [status|--stop --all]
  dsh-remote doctor                       自检
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadConfig, assertConfig } from '../src/config.mjs'
import { createLogger, ensureDir, httpRequest, readJson, sleep, writeJsonAtomic } from '../src/util.mjs'
import { KeyRing, keyRingPath } from '../src/keys.mjs'
import { startSupervisor } from '../src/supervisor.mjs'
import { parseLaunchEndpoint } from '../src/upstream.mjs'
import { readFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const command = args[0] && !args[0].startsWith('-') ? args[0] : 'help'
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const option = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

const config = loadConfig({
  configPath: option('config'),
  cli: option('port') ? { listen: { port: Number(option('port')) } } : {},
})

const execFileAsync = promisify(execFile)
const logger = createLogger({ name: 'dsh-remote' })
const runtimeDir = config.stateDir
const runtimePath = join(runtimeDir, 'runtime.json')
const pidPath = join(runtimeDir, 'relay.pid')
const linkPath = join(config.home, 'link.txt')

function readRuntime() {
  return readJson(runtimePath, null)
}

async function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function cmdUp() {
  assertConfig(config)
  if (!flags.has('--foreground')) {
    const runtime = readRuntime()
    if (runtime && (await isAlive(runtime.pid))) {
      const health = await httpRequest(`http://127.0.0.1:${String(runtime.listen.port)}/__dsh/health`, {
        timeoutMs: 2000,
      }).catch(() => null)
      if (health?.status === 200) {
        console.log(`已在运行 pid=${runtime.pid}`)
        console.log(`链接: ${runtime.link ?? '(隧道尚未就绪)'}`)
        return
      }
      console.log(`实例 pid=${runtime.pid} 仍在退出中，稍后重试`)
      return
    }
    ensureDir(config.logs.dir)
    const logFile = join(config.logs.dir, 'relay.log')
    const out = openSync(logFile, 'a')
    const scriptPath = fileURLToPath(import.meta.url)
    const childEnv = process.versions?.electron
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      : process.env
    let child
    try {
      child = spawn(
        process.execPath,
        [scriptPath, 'up', '--foreground', '--config', config.configPath ?? join(config.home, 'config.json')],
        {
          detached: true,
          windowsHide: true,
          stdio: ['ignore', out, out],
          env: childEnv,
        },
      )
    } finally {
      closeSync(out)
    }
    child.unref()
    await sleep(1200)
    const started = readRuntime()
    if (started?.pid) {
      console.log(`已后台启动 pid=${started.pid}`)
      if (started.link) console.log(`链接: ${started.link}`)
      console.log(`日志: ${logFile}`)
    } else {
      console.log(`已后台启动 pid=${child.pid}，日志: ${logFile}（隧道就绪后 link.txt 会更新）`)
    }
    return
  }

  const supervisor = await startSupervisor({ config, logger })
  process.stdout.write(`relay: http://${config.listen.host}:${String(supervisor.runtime.listen.port)}\n`)
  if (supervisor.runtime.link) process.stdout.write(`link: ${supervisor.runtime.link}\n`)
  else process.stdout.write('link: 等待隧道分配域名…\n')
  await new Promise(() => {})
}

async function stopTunnelProcess({ config, logger }) {
  const tunnelFile = join(config.stateDir, 'tunnel.json')
  const saved = readJson(tunnelFile, null)
  if (config.public.mode === 'funnel') {
    await execFileAsync('tailscale', ['funnel', 'reset'], { timeout: 15_000 }).catch(() => {})
    writeJsonAtomic(tunnelFile, { mode: 'funnel', port: config.listen.port, url: null })
    return
  }
  let pid = saved?.pid ?? null
  if (!pid) pid = await findCloudflaredForPort(config)
  if (!pid) return
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`已停止隧道进程 pid=${pid}`)
  } catch {}
  writeJsonAtomic(tunnelFile, { ...saved, pid: null, url: null })
}

async function cmdStop() {
  const runtime = readRuntime()
  if (!runtime) {
    console.log('未发现运行中的实例')
    return
  }
  if (!(await isAlive(runtime.pid))) {
    console.log(`pid ${runtime.pid} 已不存在，清理运行态`)
    writeJsonAtomic(runtimePath, { ...runtime, stoppedAt: new Date().toISOString() })
    return
  }
  try {
    process.kill(runtime.pid, 'SIGTERM')
  } catch {}
  if (flags.has('--all')) {
    // 等待 relay 退出后再收隧道，避免它自己在退出流程里又重启
    for (let i = 0; i < 50; i += 1) {
      if (!(await isAlive(runtime.pid))) break
      await sleep(100)
    }
    await stopTunnelProcess({ config, logger })
  }
  for (let i = 0; i < 30; i += 1) {
    if (!(await isAlive(runtime.pid))) break
    await sleep(100)
  }
  if (await isAlive(runtime.pid)) {
    try { process.kill(runtime.pid, 'SIGKILL') } catch {}
    for (let i = 0; i < 20; i += 1) {
      if (!(await isAlive(runtime.pid))) break
      await sleep(100)
    }
  }
  if (existsSync(runtimePath) && !(await isAlive(runtime.pid))) writeJsonAtomic(runtimePath, null)
  console.log(`已停止 pid=${runtime.pid}`)
}

/** state 里丢了 pid 时，按命令行匹配兜底找到本端口的 cloudflared。 */
async function findCloudflaredForPort(config) {
  if (process.platform !== 'linux') return null
  const needle = `--url http://${config.listen.host}:${String(config.listen.port)}`
  try {
    const { readdir, readFile } = await import('node:fs/promises')
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/u.test(entry)) continue
      let cmd = ''
      try {
        cmd = (await readFile(`/proc/${entry}/cmdline`)).toString('utf8').split('\0').join(' ')
      } catch {
        continue
      }
      if (cmd.includes('cloudflared') && cmd.includes(needle)) return Number(entry)
    }
  } catch {}
  return null
}

async function cmdTunnel() {
  const tunnelFile = join(config.stateDir, 'tunnel.json')
  const saved = readJson(tunnelFile, null)
  if (flags.has('--stop') || args[1] === 'stop') {
    if (!flags.has('--all')) {
      console.log('保留隧道（链接不变）。要真正关闭请加 --all。')
      return
    }
    await stopTunnelProcess({ config, logger })
    return
  }
  const alive = saved?.pid ? await isAlive(saved.pid) : false
  console.log(JSON.stringify({
    mode: config.public.mode,
    persistAcrossRestart: config.tunnel.persistAcrossRestart !== false,
    state: saved ?? null,
    pidAlive: alive,
  }, null, 2))
}

async function cmdStatus() {
  const runtime = readRuntime()
  if (!runtime) {
    console.log(JSON.stringify({ running: false }))
    return
  }
  const alive = await isAlive(runtime.pid)
  const local = await httpRequest(`http://127.0.0.1:${String(runtime.listen.port)}/__dsh/health`, { timeoutMs: 2000 }).catch(
    () => null,
  )
  const remote = runtime.publicUrl
    ? await httpRequest(`${runtime.publicUrl}/__dsh/health`, { timeoutMs: 8000 }).catch(() => null)
    : null
  const report = {
    running: alive,
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    listen: runtime.listen,
    publicUrl: runtime.publicUrl,
    link: runtime.link,
    appLink: runtime.appLink ?? null,
    localHealth: local?.status === 200,
    remoteHealth: remote?.status === 200,
    tunnel: runtime.tunnel,
    pskKid: runtime.pskKid,
  }
  if (flags.has('--json')) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  const line = (key, value) => console.log(`${key.padEnd(14)} ${value}`)
  line('运行', alive ? '是' : '否')
  line('pid', report.pid)
  line('本地监听', `http://127.0.0.1:${String(report.listen.port)}`)
  line('公网地址', report.publicUrl ?? '(未就绪)')
  line('访问链接', report.link ?? '(未就绪)')
  if (report.appLink) line('App 链接', report.appLink)
  line('本地健康', report.localHealth ? 'OK' : 'FAIL')
  line('公网健康', report.remoteHealth ? 'OK' : 'FAIL')
  line('隧道', `${report.tunnel?.mode ?? '-'} / ${report.tunnel?.state ?? '-'}`)
  line('PSK kid', report.pskKid ?? '-')
}

async function cmdLink() {
  const runtime = readRuntime()
  const publicUrl = runtime?.publicUrl ?? config.proxy.publicUrl
  const keyring = new KeyRing({
    statePath: keyRingPath(runtimeDir),
    rotateHours: config.tokens.rotateHours,
    graceMinutes: config.tokens.graceMinutes,
  })
  if (flags.has('--rotate')) {
    const next = keyring.rotatePsk(Date.now(), { force: true })
    console.log(`PSK 已轮换: kid=${next.kid}`)
  }
  if (!publicUrl) {
    console.log('隧道尚未就绪：先运行 dsh-remote up，或设置 proxy.publicUrl')
    return
  }
  if (flags.has('--app')) {
    if (!config.proxy.appBridge) {
      console.log('App 直连通道未启用：config.proxy.appBridge=true 后再试')
      return
    }
    console.log(keyring.appLink(publicUrl))
    return
  }
  if (flags.has('--legacy')) {
    if (!config.proxy.legacyToken) {
      console.log('legacy 通道未启用：config.proxy.legacyToken=true 后再试')
      return
    }
    console.log(keyring.legacyLink(publicUrl))
    return
  }
  const link = keyring.link(publicUrl)
  console.log(link)
  if (runtime) {
    writeJsonAtomic(runtimePath, { ...runtime, link, pskKid: keyring.activePsk()?.kid ?? null })
  }
}

async function cmdRotate() {
  const keyring = new KeyRing({
    statePath: keyRingPath(runtimeDir),
    rotateHours: config.tokens.rotateHours,
    graceMinutes: config.tokens.graceMinutes,
    relayRotateHours: config.e2e.relayKeyRotateHours,
  })
  if (flags.has('--app')) {
    if (!config.proxy.appBridge) {
      console.log('App 直连通道未启用：config.proxy.appBridge=true 后再试')
      return
    }
    const token = keyring.rotateAppToken()
    const runtime = readRuntime()
    const base = runtime?.publicUrl ?? config.proxy.publicUrl
    console.log(token ? `${base}/?token=${token}` : '(隧道未就绪)')
    return
  }
  if (flags.has('--identity')) {
    keyring.rotateRelayIdentityIfDue(Date.now() + config.e2e.relayKeyRotateHours * 3_600_000)
    console.log(`relay 身份已轮换: kid=${keyring.identity.kid}`)
    return
  }
  const next = keyring.rotatePsk(Date.now(), { force: true })
  console.log(`PSK 已轮换: kid=${next.kid}, 旧密钥进入 ${config.tokens.graceMinutes} 分钟宽限`)
  const runtime = readRuntime()
  if (runtime?.publicUrl) console.log(`新链接: ${keyring.link(runtime.publicUrl)}（长驻进程会在 60s 内装载并推送）`)
}

async function cmdDoctor() {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  add('node', Number(process.versions.node.split('.')[0]) >= 22, `node ${process.versions.node}`)
  const cloudflared = await new Promise((resolve) => {
    const child = spawn(config.public.cloudflared ?? 'cloudflared', ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let text = ''
    child.stdout?.on('data', (chunk) => {
      text += chunk
    })
    child.on('error', () => resolve({ ok: false, text: 'not found' }))
    child.on('exit', (code) => resolve({ ok: code === 0, text: text.trim() }))
  })
  add('cloudflared', cloudflared.ok, cloudflared.text)

  try {
    assertConfig(config)
    add('config', true, config.configPath ?? '(defaults)')
  } catch (error) {
    add('config', false, String(error?.message ?? error))
  }

  const keyring = new KeyRing({
    statePath: keyRingPath(runtimeDir),
    rotateHours: config.tokens.rotateHours,
    graceMinutes: config.tokens.graceMinutes,
  })
  const active = keyring.activePsk()
  add(
    'psk',
    Boolean(active) && active.expiresAt > Date.now(),
    active ? `kid=${active.kid} 到期 ${new Date(active.expiresAt).toISOString()}` : '无可用 PSK',
  )

  let found = { host: null, port: null, launchToken: null }
  if (config.upstream.mode === 'fixed') {
    found = { host: config.upstream.host, port: config.upstream.port, launchToken: config.upstream.launchToken }
  } else {
    const logs = config.upstream.log ? [config.upstream.log] : (config.upstream.logs ?? [])
    for (const logPath of logs) {
      if (!logPath || !existsSync(logPath)) continue
      const tail = await readFile(logPath, 'utf8').catch(() => '')
      const parsed = parseLaunchEndpoint(tail)
      if (parsed) { found = parsed; break }
    }
  }
  add('upstream', Boolean(found?.port && found?.launchToken), found?.port ? `${found.host ?? '127.0.0.1'}:${found.port} token=${String(found.launchToken).slice(0, 6)}…` : '未发现')

  const runtime = readRuntime()
  add('runtime', Boolean(runtime && (await isAlive(runtime.pid))), runtime ? `pid=${runtime.pid}` : '未启动')

  if (runtime) {
    const local = await httpRequest(`http://127.0.0.1:${String(runtime.listen.port)}/__dsh/health`, { timeoutMs: 2000 }).catch(
      () => null,
    )
    add('local-health', local?.status === 200, local ? `HTTP ${local.status}` : 'unreachable')
    if (runtime.publicUrl) {
      const remote = await httpRequest(`${runtime.publicUrl}/__dsh/health`, { timeoutMs: 8000 }).catch(() => null)
      add('public-health', remote?.status === 200, remote ? `HTTP ${remote.status}` : 'unreachable')
      const link = runtime.link ?? keyring.link(runtime.publicUrl)
      const unlock = await httpRequest(link.replace(/#.*$/u, '/'), {
        timeoutMs: 8000,
        headers: { accept: 'text/html' },
      }).catch(() => null)
      add('unlock-page', unlock?.status === 401, unlock ? `HTTP ${unlock.status}（401 表示需要密钥，符合预期）` : 'unreachable')
    }
  }

  for (const check of checks) {
    console.log(`${check.ok ? '✔' : '✖'} ${check.name.padEnd(15)} ${check.detail}`)
  }
  const failed = checks.filter((check) => !check.ok)
  if (failed.length > 0) process.exitCode = 1
}

async function main() {
  switch (command) {
    case 'up':
      return cmdUp()
    case 'stop':
      return cmdStop()
    case 'tunnel':
      return cmdTunnel()
    case 'status':
      return cmdStatus()
    case 'link':
      return cmdLink()
    case 'rotate':
      return cmdRotate()
    case 'doctor':
      return cmdDoctor()
    default:
      console.log(`dsh-remote — DSH 网关 → Cloudflare 隧道（自动续期 + 端到端加密）

用法:
  dsh-remote up [--foreground|--detach] [--config <file>] [--port <n>]
  dsh-remote stop [--all] [--all]      # 默认保留隧道，重启后链接不变
  dsh-remote status [--json]
  dsh-remote link [--rotate] [--legacy|--app]
  dsh-remote rotate [--psk|--identity|--app]
  dsh-remote tunnel [status|--stop --all]
  dsh-remote doctor

环境变量:
  DSH_REMOTE_HOME, DSH_REMOTE_LISTEN_PORT, DSH_REMOTE_TUNNEL_MODE,
  DSH_REMOTE_PUBLIC_HOSTNAME, DSH_REMOTE_TUNNEL_TOKEN, DSH_REMOTE_UPSTREAM_LOG,
  DSH_REMOTE_UPSTREAM_PORT, DSH_REMOTE_UPSTREAM_TOKEN, DSH_REMOTE_E2E
`)
  }
}

main().catch((error) => {
  console.error(`dsh-remote: ${String(error?.message ?? error)}`)
  process.exitCode = 1
})