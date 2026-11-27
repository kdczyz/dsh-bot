/**
 * Supervisor：把 KeyRing / SessionStore / Upstream / Edge / Tunnel 串成一条链路，并负责：
 *   - 上游 launch token 与 cookie 的自动续期；
 *   - 对外 PSK 的定时轮换 + 向在线会话推送新密钥；
 *   - 隧道 URL 变化后重新生成链接；
 *   - 运行态落盘（runtime.json / link.txt）与优雅退出。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertConfig } from './config.mjs'
import { KeyRing, keyRingPath } from './keys.mjs'
import { SessionStore } from './sessions.mjs'
import { Upstream } from './upstream.mjs'
import { createEdge } from './proxy.mjs'
import { Tunnel } from './tunnel.mjs'
import { ensureDir, httpRequest, writeJsonAtomic } from './util.mjs'

export async function startSupervisor({ config, logger }) {
  assertConfig(config)
  ensureDir(config.stateDir)
  ensureDir(config.logs.dir)

  const runtimePath = join(config.stateDir, 'runtime.json')
  const linkPath = join(config.home, 'link.txt')

  const keys = new KeyRing({
    statePath: keyRingPath(config.stateDir),
    logger,
    rotateHours: config.tokens.rotateHours,
    graceMinutes: config.tokens.graceMinutes,
    relayRotateHours: config.e2e.relayKeyRotateHours,
  })

  const sessions = new SessionStore({
    ttlMs: config.e2e.sessionTtlHours * 3_600_000,
    challengeTtlMs: config.e2e.handshakeTtlSeconds * 1_000,
    logger,
  })

  const upstream = new Upstream({ config, logger })
  await upstream.start()
  const upstreamReady = await upstream.waitReady({ timeoutMs: 20_000 })
  if (!upstreamReady) logger.warn('upstream not ready yet; relay will keep retrying', { log: config.upstream.log })

  const edge = createEdge({ config, keys, sessions, upstream, logger })
  const address = await edge.listen()
  logger.info('relay listening', { address: `${address.address}:${String(address.port)}` })

  const runtime = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: 1,
    listen: { host: config.listen.host, port: address.port },
    publicUrl: null,
    link: null,
    appLink: null,
    tunnel: null,
    pskKid: keys.activePsk()?.kid ?? null,
  }

  const persist = () => {
    const link = runtime.publicUrl ? keys.link(runtime.publicUrl) : null
    runtime.link = link
    runtime.pskKid = keys.activePsk()?.kid ?? null
    runtime.tunnel = tunnel.status()
    // App 直连通道只在使用者显式开启时暴露；token 长期复用，避免已连接设备失效
    runtime.appLink = config.proxy.appBridge && runtime.publicUrl ? keys.appLink(runtime.publicUrl) : null
    writeJsonAtomic(runtimePath, runtime)
    if (link) {
      writeFileSync(linkPath, `${link}\n`, { mode: 0o600 })
    }
  }

  const tunnel = new Tunnel({
    config,
    logger,
    onUrl: (url) => {
      runtime.publicUrl = url
      persist()
      logger.info('public endpoint ready', { url, link: runtime.link })
    },
    onState: (state) => {
      runtime.tunnelState = state
      persist()
    },
  })

  let rotationTimer = null
  let renewTimer = null

  const startRotation = () => {
    rotationTimer = setInterval(() => {
      try {
        keys.reload()
        if (config.proxy.appBridge && runtime.publicUrl) {
          const appLink = keys.appLink(runtime.publicUrl)
          if (appLink !== runtime.appLink) {
            runtime.appLink = appLink
            persist()
            logger.info('app link rotated', { appLink })
          }
        }
        const next = keys.rotatePsk()
        if (next && next.kid !== runtime.pskKid) {
          // 推送新 PSK：WS 在线会话立即收到，HTTP 会话在下一次响应元数据里收到
          for (const session of sessions.all()) {
            sessions.setRenewal(session, next)
            edge.pushRenewal(session, { kid: next.kid, psk: next.psk })
          }
          persist()
          logger.info('psk rotated and pushed', { kid: next.kid, sessions: sessions.size })
        }
        keys.rotateRelayIdentityIfDue()
      } catch (error) {
        logger.error('rotation failed', { error: String(error?.message ?? error) })
      }
    }, 60_000)
    rotationTimer.unref?.()
  }

  const startUpstreamWatch = () => {
    renewTimer = setInterval(async () => {
      if (!upstream.ready) return
      const exp = upstream.info.cookieExpiresAt
      if (!exp) return
      if (exp - Date.now() < config.upstream.cookieRenewSkewSeconds * 1000) {
        try {
          await upstream.ensure({ force: true })
        } catch (error) {
          logger.warn('scheduled upstream renewal failed', { error: String(error?.message ?? error) })
        }
      }
    }, 30_000)
    renewTimer.unref?.()
  }

  const shutdown = async (signal = 'manual') => {
    logger.info('shutting down', { signal })
    if (existsSync(runtimePath)) rmSync(runtimePath, { force: true })
    clearInterval(rotationTimer)
    clearInterval(renewTimer)
    try {
      await tunnel.stop()
    } catch {}
    try {
      upstream.stop()
    } catch {}
    try {
      sessions.close()
    } catch {}
    try {
      await edge.close()
    } catch {}
    logger.info('stopped')
  }

  const onSignal = (signal) => {
    shutdown(signal)
      .catch((error) => logger.error('shutdown error', { error: String(error?.message ?? error) }))
      .finally(() => process.exit(0))
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))

  persist()
  await tunnel.start()
  if (config.public.mode === 'none') {
    runtime.publicUrl = config.proxy.publicUrl ?? null
    persist()
  }
  startRotation()
  startUpstreamWatch()

  return {
    keys,
    sessions,
    upstream,
    edge,
    tunnel,
    runtime,
    runtimePath,
    linkPath,
    async status() {
      const local = await httpRequest(`http://127.0.0.1:${String(address.port)}/__dsh/health`, { timeoutMs: 3000 }).catch(
        () => null,
      )
      const remote = runtime.publicUrl
        ? await httpRequest(`${runtime.publicUrl}/__dsh/health`, { timeoutMs: 10_000 }).catch(() => null)
        : null
      return {
        pid: process.pid,
        listen: runtime.listen,
        publicUrl: runtime.publicUrl,
        link: runtime.link,
        appLink: runtime.appLink ?? null,
        localHealth: local ? Boolean(JSON.parse(local.body.toString('utf8')).ok) : false,
        remoteHealth: remote ? Boolean(JSON.parse(remote.body.toString('utf8')).ok) : false,
        tunnel: tunnel.status(),
        upstream: upstream.describe(),
        keys: keys.describe(),
        sessions: sessions.size,
        edge: edge.describe(),
      }
    },
    shutdown,
  }
}