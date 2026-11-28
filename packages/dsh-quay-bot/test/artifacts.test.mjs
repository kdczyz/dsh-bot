import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BotStore } from '../host/store.js'
import { ScreenBridge } from '../host/screen.js'
import { BotApi } from '../host/api.js'
import { extractXmlArtifacts, makeDeliverableArtifactId } from '../host/artifacts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')
const venvPy = join(repoRoot, '.venv', 'bin', 'python')

async function findFreePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(800) })
      if (r.ok) return r.json()
    } catch (_error) {
      // retry
    }
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`gateway at ${url} did not become healthy within ${timeoutMs}ms`)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'botmode-artifacts-test-'))
const dataRoot = join(tempRoot, 'gw-data')
const storeRoot = join(tempRoot, 'store')
const workDir = join(tempRoot, 'workspace')
const port = await findFreePort()
const gatewayUrl = `http://127.0.0.1:${port}`
const adminToken = 'test-artifact-admin-token'

const gwProc = spawn(venvPy, ['-m', 'botscreen'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PYTHONPATH: repoRoot,
    BOTSCREEN_DATA_ROOT: dataRoot,
    BOTSCREEN_HOST: '127.0.0.1',
    BOTSCREEN_PORT: String(port),
    BOTSCREEN_BOTS: '',
    BOTSCREEN_ADMIN_TOKEN: adminToken,
    PYTHONUNBUFFERED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let gwLogs = ''
gwProc.stdout.on('data', d => { gwLogs += d.toString() })
gwProc.stderr.on('data', d => { gwLogs += d.toString() })

try {
  // 1. Verify real Python BotScreen gateway healthz capabilities
  const health = await waitForHealth(gatewayUrl)
  assert.ok(health.api_version >= 4, `expected api_version >= 4, got ${health.api_version}`)
  assert.ok(health.capabilities.includes('artifacts'))
  assert.ok(health.capabilities.includes('artifact_download'))

  // Verify admin auth enforcement on gateway artifact routes
  const unauthRes = await fetch(`${gatewayUrl}/api/artifacts`)
  assert.equal(unauthRes.status, 401)

  // 2. Setup BotStore, ScreenBridge & BotApi against real gateway
  const store = new BotStore(storeRoot)
  await store.load()
  const bot = { id: 'bot_art_01', name: '报告助手', role: 'Analyst', dir: workDir }
  await store.mutate((s) => {
    s.bots.push(bot)
    s.rooms.push({
      id: 'room_art_01',
      name: '巡检协作群',
      memberIds: [bot.id],
      mode: 'lead',
      leadBotId: bot.id,
      workDir,
      status: 'completed',
      transcript: [
        {
          seq: 1,
          id: 'msg_art_01',
          from: bot.id,
          name: bot.name,
          kind: 'message',
          text: '已完成巡检，产物如下：\n<artifact type="html" title="巡检报告"><h1>System OK</h1></artifact>',
          at: new Date().toISOString(),
        },
      ],
      completion: {
        summary: '巡检完成',
        deliverables: ['metrics.csv'],
        finishedBy: bot.id,
        finishedByName: bot.name,
        at: new Date().toISOString(),
      },
    })
  })
  await store.ensureBotDir(bot)
  await writeFile(join(workDir, 'metrics.csv'), 'metric,value\ncpu,12.5\nmem,48.2\n', 'utf8')
  await writeFile(join(workDir, 'summary.md'), '# Weekly Summary\n\nAll green.\n', 'utf8')

  const screen = new ScreenBridge({
    logger: console,
    gatewayUrl,
    adminToken,
    autoSpawn: false,
  })
  const api = new BotApi({
    ctx: { get: (k) => (k === 'connection' ? { requestRejection: () => undefined } : undefined) },
    store,
    dispatcher: { status: () => ({ busy: {}, last: {} }), inRoom: () => false },
    rooms: { state: () => ({}) },
    routines: {},
    screen,
    logger: console,
  })

  const runApiReq = async ({ method = 'GET', url, headers = {}, body = '' }) => {
    const req = (async function* () {
      if (body) yield Buffer.isBuffer(body) ? body : Buffer.from(body)
    })()
    req.method = method
    req.url = url
    req.headers = headers
    const outHeaders = {}
    const chunks = []
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader: (k, v) => { outHeaders[String(k).toLowerCase()] = String(v) },
      write: (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''))) },
      end: (chunk) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || '')))
        res.writableEnded = true
      },
    }
    await api.handle(req, res)
    return { status: res.statusCode, headers: outHeaders, body: Buffer.concat(chunks) }
  }

  // 3. Publish JSON text artifact through Host API -> Gateway
  const pubResp = await runApiReq({
    method: 'POST',
    url: '/botmode/api/artifacts',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      botId: bot.id,
      title: '接口测试报告',
      type: 'markdown',
      content: '# 测试通过\n\n- 延迟: 12ms\n',
    }),
  })
  assert.equal(pubResp.status, 200)
  const pubJson = JSON.parse(pubResp.body.toString('utf8'))
  assert.equal(pubJson.ok, true)
  assert.equal(pubJson.gatewaySynced, true)
  assert.ok(pubJson.artifact.artifactId)
  assert.ok(pubJson.artifact.downloadUrl.startsWith('/botmode/api/artifacts/download?id='))
  assert.ok(pubJson.artifact.gatewayDownloadUrl.startsWith(`${gatewayUrl}/api/artifacts/`))
  const mdArtId = pubJson.artifact.artifactId

  // 4. Download via Host API (both query and REST routes) -> streamed from Gateway
  const dlResp = await runApiReq({
    method: 'GET',
    url: `/botmode/api/artifacts/download?id=${encodeURIComponent(mdArtId)}`,
  })
  assert.equal(dlResp.status, 200)
  assert.equal(dlResp.headers['x-artifact-source'], 'gateway')
  assert.equal(dlResp.headers['x-artifact-id'], mdArtId)
  assert.equal(dlResp.headers['x-content-type-options'], 'nosniff')
  assert.ok(dlResp.headers['content-disposition'].includes('attachment;'))
  assert.ok(dlResp.headers['content-disposition'].includes(encodeURIComponent('接口测试报告.md')))
  assert.equal(dlResp.body.toString('utf8'), '# 测试通过\n\n- 延迟: 12ms\n')

  const restDlResp = await runApiReq({
    method: 'GET',
    url: `/botmode/api/artifacts/${encodeURIComponent(mdArtId)}/download?inline=1`,
  })
  assert.equal(restDlResp.status, 200)
  assert.ok(restDlResp.headers['content-disposition'].includes('inline;'))
  assert.equal(restDlResp.body.toString('utf8'), '# 测试通过\n\n- 延迟: 12ms\n')

  // 5. Direct Gateway Range request (206 Partial Content)
  const rangeRes = await fetch(`${gatewayUrl}/api/artifacts/${encodeURIComponent(mdArtId)}/download`, {
    headers: { 'X-Admin-Token': adminToken, Range: 'bytes=0-5' },
  })
  assert.equal(rangeRes.status, 206)
  const rangeBuf = Buffer.from(await rangeRes.arrayBuffer())
  assert.equal(rangeBuf.byteLength, 6)

  // 6. Publish binary file via raw body upload
  const pngStub = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  const binPubResp = await runApiReq({
    method: 'POST',
    url: `/botmode/api/artifacts?botId=${encodeURIComponent(bot.id)}&name=${encodeURIComponent('chart.png')}`,
    headers: { 'content-type': 'image/png' },
    body: pngStub,
  })
  assert.equal(binPubResp.status, 200)
  const binArtId = JSON.parse(binPubResp.body.toString('utf8')).artifact.artifactId
  const binDl = await screen.downloadArtifact(binArtId)
  assert.deepEqual(binDl.buffer, pngStub)
  assert.equal(binDl.mimeType, 'image/png')

  // 7. Workspace filePath publish + path traversal rejection
  const wsPubResp = await runApiReq({
    method: 'POST',
    url: '/botmode/api/artifacts',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      botId: bot.id,
      filePath: 'summary.md',
    }),
  })
  assert.equal(wsPubResp.status, 200)
  const wsJson = JSON.parse(wsPubResp.body.toString('utf8'))
  assert.equal(wsJson.gatewaySynced, true)
  const wsDl = await screen.downloadArtifact(wsJson.artifact.artifactId)
  assert.equal(wsDl.buffer.toString('utf8'), '# Weekly Summary\n\nAll green.\n')

  const traversalResp = await runApiReq({
    method: 'POST',
    url: '/botmode/api/artifacts',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      botId: bot.id,
      filePath: '../../../../../../etc/passwd',
    }),
  })
  assert.equal(traversalResp.status, 400)

  // 8. Lazy sync on download for room `<artifact>` and room `deliverables`
  const extractedXml = extractXmlArtifacts(
    '已完成巡检，产物如下：\n<artifact type="html" title="巡检报告"><h1>System OK</h1></artifact>',
    { botId: bot.id, roomId: 'room_art_01', messageId: 'msg_art_01' },
  )
  assert.equal(extractedXml.length, 1)
  const lazyXmlId = extractedXml[0].id
  const lazyXmlResp = await runApiReq({
    method: 'GET',
    url: `/botmode/api/artifacts/download?id=${encodeURIComponent(lazyXmlId)}`,
  })
  assert.equal(lazyXmlResp.status, 200)
  assert.equal(lazyXmlResp.headers['x-artifact-source'], 'gateway')
  assert.equal(lazyXmlResp.body.toString('utf8'), '<h1>System OK</h1>')

  const delivId = makeDeliverableArtifactId('room_art_01', 'metrics.csv')
  const lazyDelivResp = await runApiReq({
    method: 'GET',
    url: `/botmode/api/artifacts/download?id=${encodeURIComponent(delivId)}`,
  })
  assert.equal(lazyDelivResp.status, 200)
  assert.equal(lazyDelivResp.headers['x-artifact-source'], 'gateway')
  assert.equal(lazyDelivResp.body.toString('utf8'), 'metric,value\ncpu,12.5\nmem,48.2\n')

  // 9. List artifacts via Host API
  const listResp = await runApiReq({ method: 'GET', url: '/botmode/api/artifacts' })
  assert.equal(listResp.status, 200)
  const listJson = JSON.parse(listResp.body.toString('utf8'))
  assert.equal(listJson.ok, true)
  assert.equal(listJson.gatewayAvailable, true)
  assert.ok(listJson.artifacts.some(a => a.id === mdArtId))
  assert.ok(listJson.artifacts.some(a => a.id === lazyXmlId))
  assert.ok(listJson.artifacts.some(a => a.id === delivId))
  assert.equal(listJson.endpoints.hostDownload, '/botmode/api/artifacts/download')
  assert.equal(listJson.endpoints.gatewayDownload, `${gatewayUrl}/api/artifacts/{artifact_id}/download`)

  // 10. Bundle ZIP download via Host API -> Gateway
  const bundleResp = await runApiReq({
    method: 'POST',
    url: '/botmode/api/artifacts/bundle',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [mdArtId, lazyXmlId, delivId], filename: 'pack.zip' }),
  })
  assert.equal(bundleResp.status, 200)
  assert.equal(bundleResp.headers['content-type'], 'application/zip')
  assert.equal(bundleResp.headers['x-artifact-count'], '3')
  assert.equal(bundleResp.headers['x-artifact-source'], 'gateway')
  // ZIP magic bytes PK\x03\x04
  assert.equal(bundleResp.body[0], 0x50)
  assert.equal(bundleResp.body[1], 0x4b)

  // 11. Agent-facing gateway endpoints with X-Agent-Token
  const ensured = await screen.ensure(bot.id)
  assert.ok(ensured.agent_token)
  const badAgentRes = await fetch(`${gatewayUrl}/api/agent/${encodeURIComponent(bot.id)}/artifacts`, {
    method: 'POST',
    headers: { 'X-Agent-Token': 'wrong-token', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x', content: 'hello' }),
  })
  assert.equal(badAgentRes.status, 401)

  const agentPubRes = await fetch(`${gatewayUrl}/api/agent/${encodeURIComponent(bot.id)}/artifacts`, {
    method: 'POST',
    headers: { 'X-Agent-Token': ensured.agent_token, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'agent-direct',
      type: 'json',
      content: JSON.stringify({ ok: true, count: 42 }),
    }),
  })
  assert.equal(agentPubRes.status, 200)
  const agentArt = (await agentPubRes.json()).artifact
  const agentDlRes = await fetch(`${gatewayUrl}${agentArt.agent_download_url}`, {
    headers: { 'X-Agent-Token': ensured.agent_token },
  })
  assert.equal(agentDlRes.status, 200)
  assert.deepEqual(JSON.parse(await agentDlRes.text()), { ok: true, count: 42 })

  // 12. Delete artifact via Host API
  const delResp = await runApiReq({
    method: 'DELETE',
    url: `/botmode/api/artifacts/${encodeURIComponent(mdArtId)}`,
  })
  assert.equal(delResp.status, 200)
  assert.equal(JSON.parse(delResp.body.toString('utf8')).deleted, true)
  const afterDel = await runApiReq({
    method: 'GET',
    url: `/botmode/api/artifacts/download?id=${encodeURIComponent(mdArtId)}`,
  })
  assert.equal(afterDel.status, 404)

  // 13. Command interface: artifact.publish, artifact.list, artifact.delete
  const cmdPub = await api.command({
    type: 'artifact.publish',
    botId: bot.id,
    title: 'cmd-output',
    artifactType: 'text',
    content: 'hello from command',
  })
  assert.equal(cmdPub.gatewaySynced, true)
  const cmdList = await api.command({ type: 'artifact.list', botId: bot.id })
  assert.ok(cmdList.artifacts.some(a => a.id === cmdPub.artifact.id))
  const cmdDel = await api.command({ type: 'artifact.delete', artifactId: cmdPub.artifact.id, botId: bot.id })
  assert.equal(cmdDel.deleted, true)

  console.log('✓ artifacts.test.mjs all assertions passed')
} catch (error) {
  console.error('Gateway logs:\n', gwLogs)
  throw error
} finally {
  gwProc.kill('SIGTERM')
  await new Promise(r => setTimeout(r, 200))
  await rm(tempRoot, { recursive: true, force: true })
}
