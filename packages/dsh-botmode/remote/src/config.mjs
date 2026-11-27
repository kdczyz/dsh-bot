/**
 * 配置装载：defaults < 配置文件 < 环境变量 < CLI 覆盖。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { readJson } from './util.mjs'

export const DEFAULTS = Object.freeze({
  version: 1,
  home: '~/.dsh-remote',
  listen: { host: '127.0.0.1', port: 44691 },
  public: {
    // quick: 免账号 trycloudflare 临时域名；named: 需要 CF 账号/域名/隧道 token
    mode: 'quick',                 // quick | named | funnel | none
    hostname: null,
    tunnelToken: null,
    /** 可选：隧道重启前执行的命令，stdout 即最新 tunnel token（用于 token 自动续期） */
    refreshCommand: null,
    cloudflared: 'cloudflared',
    configFile: null,
  },
  upstream: {
    // auto: 检索已启动的 dsh web 网关（从候选日志 + /proc 匹配存活进程，绝不新开网关）；fixed: 使用显式配置
    mode: 'auto',
    host: '127.0.0.1',
    port: null,
    launchToken: null,
    log: null,
    logs: [
      '~/logs/dsh-web.log',
      '~/.dsh/logs/dsh-web.log',
      '~/.dsh-app-remote/web.log',
    ],
    discoverIntervalMs: 5000,
    /** 上游 cookie 提前多少秒续期 */
    cookieRenewSkewSeconds: 600,
  },
  e2e: {
    enabled: true,
    relayKeyRotateHours: 24,
    sessionTtlHours: 12,
    handshakeTtlSeconds: 120,
    maxFrameBytes: 262144,
    maxInflightBytes: 64 * 1024 * 1024,
  },
  tokens: {
    rotateHours: 12,
    graceMinutes: 60,
    /** 对外链接（含 #k= 密钥）的展示有效期，过期仍可用但不再主动分发 */
    linkTtlDays: 30,
  },
  proxy: {
    maxBodyBytes: 64 * 1024 * 1024,
    legacyToken: false,
    /** App 直连通道：`?token=` 明文握手（Cloudflare 可见），供 Android 客户端扫码连接 */
    appBridge: true,
    hostRewrite: true,
    publicUrl: null,
  },
  tunnel: {
    /** 重启网关（relay）时保留底层隧道进程，链接不变；`stop --all` 才真正关闭 */
    persistAcrossRestart: true,
    healthIntervalMs: 20_000,
    healthTimeoutMs: 15_000,
    unhealthyThreshold: 3,
    restartBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    urlWaitMs: 45_000,
  },
  logs: { dir: 'logs', keepFiles: 14 },
})

export function expandHome(path) {
  if (typeof path !== 'string' || path === '') return path
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function deepMerge(base, override) {
  if (override === undefined) return base
  if (Array.isArray(override)) return override.slice()
  if (override === null || typeof override !== 'object') return override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = deepMerge(base?.[key], value)
  }
  return out
}

function envOverrides(env) {
  const out = {}
  const put = (path, value, cast = (v) => v) => {
    if (value === undefined || value === '') return
    let cursor = out
    for (let i = 0; i < path.length - 1; i += 1) {
      cursor[path[i]] ??= {}
      cursor = cursor[path[i]]
    }
    cursor[path[path.length - 1]] = cast(value)
  }
  put(['home'], env.DSH_REMOTE_HOME)
  put(['listen', 'host'], env.DSH_REMOTE_LISTEN_HOST)
  put(['listen', 'port'], env.DSH_REMOTE_LISTEN_PORT, Number)
  put(['public', 'mode'], env.DSH_REMOTE_TUNNEL_MODE)
  put(['public', 'hostname'], env.DSH_REMOTE_PUBLIC_HOSTNAME)
  put(['public', 'tunnelToken'], env.DSH_REMOTE_TUNNEL_TOKEN)
  put(['public', 'refreshCommand'], env.DSH_REMOTE_TUNNEL_REFRESH_COMMAND)
  put(['upstream', 'host'], env.DSH_REMOTE_UPSTREAM_HOST)
  put(['upstream', 'port'], env.DSH_REMOTE_UPSTREAM_PORT, Number)
  put(['upstream', 'launchToken'], env.DSH_REMOTE_UPSTREAM_TOKEN)
  put(['upstream', 'log'], env.DSH_REMOTE_UPSTREAM_LOG)
  put(['proxy', 'publicUrl'], env.DSH_REMOTE_PUBLIC_URL)
  put(['e2e', 'enabled'], env.DSH_REMOTE_E2E, (v) => v !== '0' && v !== 'false')
  put(['proxy', 'legacyToken'], env.DSH_REMOTE_LEGACY_TOKEN, (v) => v === '1' || v === 'true')
  put(['proxy', 'appBridge'], env.DSH_REMOTE_APP_BRIDGE, (v) => v !== '0' && v !== 'false')
  return out
}

export function loadConfig({ configPath, cli = {}, env = process.env } = {}) {
  const candidates = []
  if (configPath) candidates.push(expandHome(configPath))
  if (env.DSH_REMOTE_CONFIG) candidates.push(expandHome(env.DSH_REMOTE_CONFIG))
  candidates.push(resolve(process.cwd(), 'dsh-remote.config.json'))

  let fileConfig = {}
  let usedPath = null
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      fileConfig = readJson(candidate, {}) ?? {}
      usedPath = candidate
      break
    }
  }

  const homeEarly = fileConfig.home ?? env.DSH_REMOTE_HOME ?? DEFAULTS.home
  const home = expandHome(homeEarly)
  const homeConfig = join(home, 'config.json')
  if (!usedPath && existsSync(homeConfig)) {
    fileConfig = readJson(homeConfig, {}) ?? {}
    usedPath = homeConfig
  }

  const merged = deepMerge(deepMerge(DEFAULTS, fileConfig), envOverrides(env))
  const config = deepMerge(merged, cli)

  config.home = expandHome(config.home)
  config.configPath = usedPath
  config.stateDir = join(config.home, 'state')
  const rawLogsDir = String(config.logs.dir ?? 'logs')
  config.logs.dir = isAbsolute(rawLogsDir) || rawLogsDir.startsWith('~')
    ? expandHome(rawLogsDir)
    : join(config.home, rawLogsDir)
  config.upstream.log = config.upstream.log ? expandHome(config.upstream.log) : null
  const rawUpstreamLogs = Array.isArray(config.upstream.logs) ? config.upstream.logs : []
  config.upstream.logs = [...new Set(rawUpstreamLogs.filter(Boolean).map(expandHome))]
  config.listen.port = Number(config.listen.port)
  return config
}

export function assertConfig(config) {
  if (!Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65535) {
    throw new Error(`listen.port 非法: ${config.listen.port}`)
  }
  if (!['quick', 'named', 'funnel', 'none'].includes(config.public.mode)) {
    throw new Error(`public.mode 必须是 quick|named|funnel|none，收到 ${config.public.mode}`)
  }
  if (config.public.mode === 'funnel') {
    config.public.hostname = config.public.hostname ?? null
  }
  if (config.public.mode === 'named' && !config.public.tunnelToken && !config.public.refreshCommand) {
    throw new Error('named 模式需要 public.tunnelToken 或 public.refreshCommand')
  }
  if (!['auto', 'fixed'].includes(config.upstream.mode)) {
    throw new Error(`upstream.mode 必须是 auto|fixed，收到 ${config.upstream.mode}`)
  }
  if (config.upstream.mode === 'fixed' && (!config.upstream.port || !config.upstream.launchToken)) {
    throw new Error('fixed 模式需要 upstream.port 与 upstream.launchToken')
  }
  if (!(config.tokens.graceMinutes >= 0)) throw new Error('tokens.graceMinutes 不能为负')
  return config
}