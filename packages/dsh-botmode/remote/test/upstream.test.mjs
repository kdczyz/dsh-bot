/**
 * 上游 token / cookie 自动续期测试。
 *
 * 这些用例专门验证「不需要人工 force、不需要等 30 天」的三条自动路径：
 *   1) cookie 临近过期 → 定时巡检自动重换；
 *   2) dsh web 重启换 token/换端口（日志变化）→ 自动重新发现并重换；
 *   3) 上游 401 → 立即重换。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { DEFAULTS } from '../src/config.mjs'
import { Upstream, parseLaunchEndpoint, parseLaunchLine } from '../src/upstream.mjs'
import { startFakeUpstream, tempHome } from './helpers.mjs'

const noopLogger = { info() {}, warn() {}, error() {} }

function makeConfig({ home, fake, logPath }) {
  return {
    ...structuredClone(DEFAULTS),
    home,
    stateDir: join(home, 'state'),
    logs: { ...DEFAULTS.logs, dir: join(home, 'logs') },
    listen: { host: '127.0.0.1', port: 0 },
    public: { ...DEFAULTS.public, mode: 'none' },
    upstream: {
      ...DEFAULTS.upstream,
      mode: 'auto',
      port: null,
      launchToken: null,
      log: logPath,
      discoverIntervalMs: 3_600_000,
      cookieRenewSkewSeconds: 600,
    },
  }
}

function launchLine(port, token) {
  return `dsh web: http://127.0.0.1:${String(port)}/?token=${token}\n`
}

test('parseLaunchLine：取最后一行，端口与 token 成对', () => {
  const text = [
    launchLine(1111, 'aaaa1111aaaa1111'),
    launchLine(2222, 'bbbb2222bbbb2222'),
  ].join('')
  const found = parseLaunchLine(text)
  assert.deepEqual(found, { port: 2222, launchToken: 'bbbb2222bbbb2222' })
})

test('parseLaunchEndpoint：支持非 127.0.0.1 监听地址（如 10.0.0.140:3080）', () => {
  const text = [
    'dsh web: http://127.0.0.1:3080/?token=aaaa1111aaaa1111\n',
    'dsh web: http://10.0.0.140:3080/?token=SALwuwdLwxCy7Wit_xminxInPyT6n474HbmaNUsMQto\n',
  ].join('')
  const found = parseLaunchEndpoint(text)
  assert.deepEqual(found, {
    host: '10.0.0.140',
    port: 3080,
    launchToken: 'SALwuwdLwxCy7Wit_xminxInPyT6n474HbmaNUsMQto',
  })
})

test('多候选日志自动检索存活的 dsh 网关（跳过死端口日志，绝不新开网关）', async () => {
  const fake = await startFakeUpstream()
  const home = tempHome()
  const deadLog = join(home.dir, 'dead.log')
  const liveLog = join(home.dir, 'live.log')
  writeFileSync(deadLog, launchLine(1, 'dead1111dead1111'))
  writeFileSync(liveLog, launchLine(fake.port, fake.token))
  const config = makeConfig({ home: home.dir, fake, logPath: null })
  config.upstream.log = null
  config.upstream.logs = [deadLog, liveLog]
  const upstream = new Upstream({ config, logger: noopLogger })
  try {
    await upstream.start()
    assert.equal(upstream.ready, true)
    assert.equal(upstream.info.host, '127.0.0.1')
    assert.equal(upstream.info.port, fake.port)
    assert.equal(upstream.info.logPath, liveLog)
  } finally {
    upstream.stop()
    await fake.close()
    home.cleanup()
  }
})

test('无日志文件时通过 upstream-hint.json 零配置自动绑定已启动网关', async () => {
  const fake = await startFakeUpstream()
  const home = tempHome()
  const stateDir = join(home.dir, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, 'upstream-hint.json'),
    JSON.stringify({ host: '127.0.0.1', port: fake.port, cookie: 'dsh-auth-hint=ok', updatedAt: Date.now() }),
  )
  const config = makeConfig({ home: home.dir, fake, logPath: null })
  config.upstream.log = null
  config.upstream.logs = [join(home.dir, 'missing.log')]
  const upstream = new Upstream({ config, logger: noopLogger })
  try {
    await upstream.start()
    assert.equal(upstream.ready, true)
    assert.equal(upstream.info.host, '127.0.0.1')
    assert.equal(upstream.info.port, fake.port)
    assert.equal(upstream.info.cookie, 'dsh-auth-hint=ok')
  } finally {
    upstream.stop()
    await fake.close()
    home.cleanup()
  }
})

test('首次发现即自动换取 cookie（30 天寿命记录在册）', async () => {
  const fake = await startFakeUpstream()
  const home = tempHome()
  const logPath = join(home.dir, 'web.log')
  writeFileSync(logPath, launchLine(fake.port, fake.token))
  const config = makeConfig({ home: home.dir, fake, logPath })
  const upstream = new Upstream({ config, logger: noopLogger })
  try {
    await upstream.start()
    assert.equal(upstream.ready, true)
    assert.equal(upstream.info.bootstraps, 1)
    assert.equal(upstream.info.port, fake.port)
    const ttl = upstream.info.cookieExpiresAt - Date.now()
    assert.ok(ttl > 29.9 * 86_400_000, `cookie 寿命应接近 30 天，实际 ${ttl}`)
  } finally {
    upstream.stop()
    await fake.close()
    home.cleanup()
  }
})

test('cookie 新鲜时不重复换取（避免每次巡检都打上游）', async () => {
  const fake = await startFakeUpstream()
  const home = tempHome()
  const logPath = join(home.dir, 'web.log')
  writeFileSync(logPath, launchLine(fake.port, fake.token))
  const upstream = new Upstream({ config: makeConfig({ home: home.dir, fake, logPath }), logger: noopLogger })
  try {
    await upstream.start()
    const before = upstream.info.bootstraps
    await upstream.ensure()
    await upstream.ensure()
    assert.equal(upstream.info.bootstraps, before)
  } finally {
    upstream.stop()
    await fake.close()
    home.cleanup()
  }
})

test('临近过期（剩余 < skew）时巡检自动重换，无需人工 force', async () => {
  const fake = await startFakeUpstream()
  const home = tempHome()
  const logPath = join(home.dir, 'web.log')
  writeFileSync(logPath, launchLine(fake.port, fake.token))
  const upstream = new Upstream({ config: makeConfig({ home: home.dir, fake, logPath }), logger: noopLogger })
  try {
    await upstream.start()
    const firstCookie = upstream.info.cookie
    const firstBootstraps = upstream.info.bootstraps
    // 模拟 29 天 23 小时 55 分：只剩 5 分钟，进入 10 分钟续期窗口
    upstream.info.cookieExpiresAt = Date.now() + 5 * 60_000
    await upstream.ensure()
    assert.equal(upstream.info.bootstraps, firstBootstraps + 1)
    assert.notEqual(upstream.info.cookie, firstCookie)
    const ttl = upstream.info.cookieExpiresAt - Date.now()
    assert.ok(ttl > 29.9 * 86_400_000, '重换后应重新获得完整 30 天寿命')
  } finally {
    upstream.stop()
    await fake.close()
    home.cleanup()
  }
})

test('dsh web 重启换 token → 日志变化触发重新发现与重换', async () => {
  const fake = await startFakeUpstream()
  const home = tempHome()
  const logPath = join(home.dir, 'web.log')
  writeFileSync(logPath, launchLine(fake.port, fake.token))
  const upstream = new Upstream({ config: makeConfig({ home: home.dir, fake, logPath }), logger: noopLogger })
  try {
    await upstream.start()
    const firstBootstraps = upstream.info.bootstraps
    const rotatedToken = `${fake.token}-rotated-${'x'.repeat(8)}`
    writeFileSync(logPath, launchLine(fake.port, rotatedToken))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await upstream.ensure()
    assert.equal(upstream.info.launchToken, rotatedToken)
    assert.equal(upstream.info.bootstraps, firstBootstraps + 1)
  } finally {
    upstream.stop()
    await fake.close()
    home.cleanup()
  }
})

test('上游 401 → onUnauthorized 立即重换并恢复访问', async () => {
  const fake = await startFakeUpstream()
  const home = tempHome()
  const logPath = join(home.dir, 'web.log')
  writeFileSync(logPath, launchLine(fake.port, fake.token))
  const upstream = new Upstream({ config: makeConfig({ home: home.dir, fake, logPath }), logger: noopLogger })
  try {
    await upstream.start()
    const before = upstream.info.bootstraps
    await upstream.onUnauthorized()
    assert.equal(upstream.info.bootstraps, before + 1)
    assert.equal(upstream.ready, true)
  } finally {
    upstream.stop()
    await fake.close()
    home.cleanup()
  }
})

test('日志不可用且未固定端口时给出明确错误（不静默连错实例）', async () => {
  const home = tempHome()
  mkdirSync(home.dir, { recursive: true })
  const config = makeConfig({ home: home.dir, fake: null, logPath: join(home.dir, 'missing.log') })
  const upstream = new Upstream({ config, logger: noopLogger })
  try {
    await assert.rejects(upstream.ensure({ force: true }), /未发现 dsh web 端口或 launch token/)
    assert.equal(upstream.ready, false)
  } finally {
    upstream.stop()
    home.cleanup()
  }
})

test('cloudflaredAssetName / cloudflaredBinaryName / cloudflaredDownloadUrls：三端与国内/官方源', async () => {
  const { cloudflaredAssetName, cloudflaredBinaryName, cloudflaredDownloadUrls } = await import('../src/tunnel.mjs')
  assert.deepEqual(cloudflaredAssetName('linux', 'x64'), { asset: 'cloudflared-linux-amd64', archive: false })
  assert.deepEqual(cloudflaredAssetName('linux', 'arm64'), { asset: 'cloudflared-linux-arm64', archive: false })
  assert.deepEqual(cloudflaredAssetName('darwin', 'arm64'), { asset: 'cloudflared-darwin-arm64.tgz', archive: true })
  assert.deepEqual(cloudflaredAssetName('darwin', 'x64'), { asset: 'cloudflared-darwin-amd64.tgz', archive: true })
  assert.deepEqual(cloudflaredAssetName('win32', 'x64'), { asset: 'cloudflared-windows-amd64.exe', archive: false })
  assert.deepEqual(cloudflaredAssetName('win32', 'arm64'), { asset: 'cloudflared-windows-amd64.exe', archive: false })
  assert.deepEqual(cloudflaredAssetName('win32', 'ia32'), { asset: 'cloudflared-windows-386.exe', archive: false })
  assert.equal(cloudflaredBinaryName('win32'), 'cloudflared.exe')
  assert.equal(cloudflaredBinaryName('darwin'), 'cloudflared')
  assert.equal(cloudflaredBinaryName('linux'), 'cloudflared')

  const mirrorUrls = cloudflaredDownloadUrls('cloudflared-darwin-arm64.tgz', 'mirror')
  assert.ok(mirrorUrls.length >= 4)
  assert.ok(mirrorUrls[0].startsWith('https://cdn.gh-proxy.com/'))
  const officialUrls = cloudflaredDownloadUrls('cloudflared-darwin-arm64.tgz', 'official')
  assert.deepEqual(officialUrls, ['https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz'])
})

test('免日志 Electron 内嵌网关（authMode=none）可通过 upstream-hint.json 自动对接', async () => {
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    if (req.url === '/botmode/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const home = tempHome()
  let upstream = null
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const stateDir = join(home.dir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'upstream-hint.json'), JSON.stringify({
      host: '127.0.0.1',
      port,
      cookie: null,
      authMode: 'none',
      updatedAt: Date.now(),
    }))
    const config = makeConfig({ home: home.dir, fake: null, logPath: null })
    config.upstream.logs = [join(home.dir, 'missing.log')]
    upstream = new Upstream({ config, logger: noopLogger })
    await upstream.start()
    assert.equal(upstream.ready, true)
    assert.equal(upstream.info.port, port)
    assert.equal(upstream.info.authless, true)
    assert.equal(upstream.info.cookie, null)
  } finally {
    upstream?.stop()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    home.cleanup()
  }
})