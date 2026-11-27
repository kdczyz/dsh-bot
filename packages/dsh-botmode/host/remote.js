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
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { qrDataUrl, qrSvg } from './qr.js'

const execFileAsync = promisify(execFile)

const DEFAULT_HOME = process.env.DSH_REMOTE_HOME || join(homedir(), '.dsh-remote')
const BIN_CANDIDATES = [
  process.env.DSH_REMOTE_BIN,
  join(process.cwd(), 'bin', 'dsh-remote.mjs'),
  join(homedir(), 'Desktop', 'dsh-remote', 'bin', 'dsh-remote.mjs'),
  join(homedir(), 'dsh-remote', 'bin', 'dsh-remote.mjs'),
].filter(Boolean)

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
  constructor({ home = DEFAULT_HOME, bin, logger = console } = {}) {
    this.home = home
    this.bin = bin || BIN_CANDIDATES.find((candidate) => existsSync(candidate)) || BIN_CANDIDATES[1]
    this.logger = logger
    this.runtimePath = join(home, 'state', 'runtime.json')
    this.linkPath = join(home, 'link.txt')
    this.lastAction = null
  }

  async #run(args, { timeoutMs = 90_000 } = {}) {
    const env = { ...process.env, DSH_REMOTE_HOME: this.home }
    const startedAt = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [this.bin, ...args], {
        timeout: timeoutMs,
        env,
        cwd: dirname(dirname(this.bin)),
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
    await this.#run(['up'], { timeoutMs: 120_000 })
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
    await this.#run(['stop'], { timeoutMs: 30_000 })
    await sleep(800)
    return { ...(await this.status()), stopped: true }
  }

  /** 校验手输链接 / 扫码内容。 */
  inspectLink(text) {
    return inspectLink(text)
  }
}