/**
 * memory_tencentdb — Built-in Hermes-style MemoryProvider plugin for dsh-botmode.
 *
 * Connects to the memory-tencentdb v3 Gateway (default http://127.0.0.1:8420)
 * using per-Bot tenancy isolation (`team_id`, `agent_id = bot.id`, `user_id`),
 * circuit-breaking on transient failures, and optional automatic local SQLite
 * FTS5 fallback when the Gateway is unreachable.
 */
import { join } from 'node:path'
import { MemoryProvider } from '../../protocol.js'
import { MemoryTencentdbClient } from './client.js'
import { LocalFourLayerStore } from './fallback.js'

const BREAKER_THRESHOLD = 5
const BREAKER_COOLDOWN_MS = 60_000
const HEALTH_PROBE_CACHE_MS = 10_000
const MAX_INFLIGHT_SYNCS = 6

const resolveHost = (config) => {
  const fromEnv = String(process.env.MEMORY_TENCENTDB_GATEWAY_HOST ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const fromCfg = String(config?.gatewayHost ?? '').trim()
  return fromCfg !== '' ? fromCfg : '127.0.0.1'
}

const resolvePort = (config) => {
  const fromEnv = Number(process.env.MEMORY_TENCENTDB_GATEWAY_PORT)
  if (Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) return fromEnv
  const fromCfg = Number(config?.gatewayPort)
  if (Number.isInteger(fromCfg) && fromCfg >= 1 && fromCfg <= 65535) return fromCfg
  return 8420
}

const resolveApiKey = (config) => {
  for (const key of ['MEMORY_TENCENTDB_GATEWAY_API_KEY', 'TDAI_GATEWAY_API_KEY']) {
    const val = String(process.env[key] ?? '').trim()
    if (val !== '') return val
  }
  return String(config?.gatewayApiKey ?? '').trim()
}

export class MemoryTencentdbProvider extends MemoryProvider {
  #client = null
  #fallback = null
  #gatewayOnline = false
  #lastHealthAt = 0
  #lastHealthDetail = null
  #failures = 0
  #breakerUntil = 0
  #inflightSyncs = new Set()

  constructor(manifest, config = {}, host = {}) {
    super(manifest, config, host)
    this.#initClient()
    const dataRoot = host?.dataRoot || join(process.cwd(), '.dsh-memory-data')
    this.#fallback = new LocalFourLayerStore(join(dataRoot, 'memory_tencentdb_fallback.sqlite'))
  }

  #initClient() {
    const host = resolveHost(this.config)
    const port = resolvePort(this.config)
    const apiKey = resolveApiKey(this.config)
    const serviceId = String(this.config?.serviceId ?? 'default').trim() || 'default'
    const timeoutMs = Math.max(1000, Number(this.config?.timeoutMs) || 8000)
    this.baseUrl = `http://${host}:${port}`
    this.#client = new MemoryTencentdbClient({
      baseUrl: this.baseUrl,
      apiKey,
      serviceId,
      timeoutMs,
      fetchImpl: this.host?.fetchImpl ?? globalThis.fetch,
    })
  }

  get #fallbackEnabled() {
    return this.config?.fallbackLocal !== false
  }

  get #recallLimit() {
    const num = Number(this.config?.recallLimit)
    return Number.isFinite(num) ? Math.max(1, Math.min(20, Math.trunc(num))) : 5
  }

  #isBreakerOpen() {
    if (this.#breakerUntil === 0) return false
    if (Date.now() >= this.#breakerUntil) {
      this.#breakerUntil = 0
      this.#failures = 0
      return false
    }
    return true
  }

  #recordSuccess() {
    this.#failures = 0
    this.#breakerUntil = 0
    this.#gatewayOnline = true
  }

  #recordFailure(error) {
    this.#failures += 1
    this.#gatewayOnline = false
    if (this.#failures >= BREAKER_THRESHOLD) {
      this.#breakerUntil = Date.now() + BREAKER_COOLDOWN_MS
      this.host?.logger?.warn?.(`botmode: memory_tencentdb circuit breaker opened (${this.#failures} failures): ${String(error)}`)
    }
  }

  async #probeGateway(force = false) {
    const now = Date.now()
    if (!force && now - this.#lastHealthAt < HEALTH_PROBE_CACHE_MS && this.#lastHealthDetail) {
      return this.#gatewayOnline
    }
    if (!force && this.#isBreakerOpen()) return false
    try {
      const payload = await this.#client.health(2500)
      const ok = payload?.status === 'ok' || payload?.status === 'degraded'
      this.#gatewayOnline = ok
      this.#lastHealthAt = now
      this.#lastHealthDetail = payload
      if (ok) this.#recordSuccess()
      return ok
    } catch (error) {
      this.#gatewayOnline = false
      this.#lastHealthAt = now
      this.#lastHealthDetail = { status: 'unreachable', error: error instanceof Error ? error.message : String(error) }
      this.#recordFailure(error)
      return false
    }
  }

  async initialize(_context) {
    await this.#probeGateway(true)
    if (!this.#gatewayOnline && this.#fallbackEnabled) {
      await this.#fallback.open()
    }
  }

  async isAvailable() {
    const online = await this.#probeGateway(false)
    return online || this.#fallbackEnabled
  }

  async health() {
    const online = await this.#probeGateway(true)
    if (online) {
      return {
        ok: true,
        mode: 'gateway',
        baseUrl: this.baseUrl,
        gateway: this.#lastHealthDetail,
        detail: `Connected to memory-tencentdb Gateway (${this.baseUrl})`,
      }
    }
    if (this.#fallbackEnabled) {
      const stats = await this.#fallback.stats().catch(() => ({}))
      return {
        ok: true,
        mode: 'fallback-local',
        baseUrl: this.baseUrl,
        gateway: this.#lastHealthDetail,
        stats,
        detail: `Gateway unreachable (${this.baseUrl}); running on local SQLite FTS5 fallback`,
      }
    }
    return {
      ok: false,
      mode: 'offline',
      baseUrl: this.baseUrl,
      gateway: this.#lastHealthDetail,
      detail: `Gateway unreachable (${this.baseUrl}) and local fallback is disabled`,
    }
  }

  systemPromptBlock({ teamId = 'dsh-botmode', agentId = 'default', userId = 'default' } = {}) {
    return [
      '# Memory Hub (memory_tencentdb)',
      `Active for Team=${teamId}, Agent=${agentId}, User=${userId}.`,
      'Four-layer semantic memory (L0 conversation logs, L1 atomic facts, L2 scene blocks, L3 core persona).',
      'Relevant memories are prefetched automatically before substantive turns.',
      'You can also call `memory_search` (or `memory_tencentdb_memory_search`), `memory_conversation_search`, `memory_read_scene`, or `memory_save` when needed.',
    ].join('\n')
  }

  async prefetch({ query, teamId = 'dsh-botmode', agentId = 'default', userId = 'default' }) {
    const text = String(query ?? '').trim()
    if (text === '') return { text: '', count: 0 }
    const limit = this.#recallLimit

    if (!this.#isBreakerOpen() && (this.#gatewayOnline || await this.#probeGateway(false))) {
      try {
        const [l1Res, l3Res, l2Res] = await Promise.allSettled([
          this.#client.atomicSearch({ query: text, limit, teamId, agentId, userId }),
          this.#client.coreRead({ teamId, agentId, userId }),
          this.#client.scenarioLs({ teamId, agentId, userId }),
        ])
        const allFailed = l1Res.status === 'rejected' && l3Res.status === 'rejected' && l2Res.status === 'rejected'
        if (allFailed) throw l1Res.reason
        this.#recordSuccess()

        const l1Items = l1Res.status === 'fulfilled' ? (l1Res.value?.data?.items ?? []) : []
        const coreText = l3Res.status === 'fulfilled' ? String(l3Res.value?.data?.content ?? '').trim() : ''
        const l2Entries = l2Res.status === 'fulfilled' ? (l2Res.value?.data?.entries ?? []) : []
        return this.#formatRecall({ l1Items, coreText, l2Entries, source: 'gateway' })
      } catch (error) {
        this.#recordFailure(error)
        if (!this.#fallbackEnabled) return { text: '', count: 0 }
      }
    }

    if (!this.#fallbackEnabled) return { text: '', count: 0 }
    const [l1Items, coreText, l2Entries] = await Promise.all([
      this.#fallback.searchAtomic({ teamId, agentId, userId, query: text, limit }),
      this.#fallback.readCore({ teamId, agentId, userId }),
      this.#fallback.listScenes({ teamId, agentId, userId }),
    ])
    return this.#formatRecall({ l1Items, coreText, l2Entries, source: 'fallback-local' })
  }

  #formatRecall({ l1Items, coreText, l2Entries, source }) {
    const parts = []
    if (Array.isArray(l1Items) && l1Items.length > 0) {
      const lines = l1Items.map(item => `- [${item.type || 'fact'}] ${item.content || ''}`).filter(Boolean)
      parts.push(`<relevant-memories>\n以下是当前对话召回的相关记忆（仅作参考）：\n\n${lines.join('\n')}\n</relevant-memories>`)
    }
    if (coreText) {
      parts.push(`<user-core>\n${coreText}\n</user-core>`)
    }
    if (Array.isArray(l2Entries) && l2Entries.length > 0) {
      const lines = l2Entries.map(entry => `- Scene: ${String(entry.path || '').replace(/\.md$/, '')}`)
      parts.push(`<scene-navigation>\nAvailable scenes:\n${lines.join('\n')}\n</scene-navigation>`)
    }
    return {
      text: parts.join('\n\n'),
      count: Array.isArray(l1Items) ? l1Items.length : 0,
      source,
    }
  }

  async syncTurn({ userText, assistantText, teamId = 'dsh-botmode', agentId = 'default', userId = 'default', sessionId = '', source = 'chat' }) {
    const u = String(userText ?? '').trim()
    const a = String(assistantText ?? '').trim()
    if (u === '' && a === '') return

    const now = Date.now()
    const messages = []
    if (u !== '') messages.push({ role: 'user', content: u, timestamp: new Date(now - 10).toISOString() })
    if (a !== '') messages.push({ role: 'assistant', content: a, timestamp: new Date(now).toISOString() })

    if (this.#inflightSyncs.size >= MAX_INFLIGHT_SYNCS) {
      const oldest = this.#inflightSyncs.values().next().value
      if (oldest) await Promise.race([oldest, new Promise(resolve => setTimeout(resolve, 2000))])
    }

    const task = (async () => {
      if (!this.#isBreakerOpen() && (this.#gatewayOnline || await this.#probeGateway(false))) {
        try {
          await this.#client.conversationAdd({ messages, sessionId, teamId, agentId, userId })
          this.#recordSuccess()
          return
        } catch (error) {
          this.#recordFailure(error)
        }
      }
      if (this.#fallbackEnabled) {
        await this.#fallback.addConversation({ teamId, agentId, userId, sessionId, messages, source })
      }
    })().catch((error) => {
      this.host?.logger?.warn?.(`botmode: memory_tencentdb syncTurn failed: ${String(error)}`)
    }).finally(() => {
      this.#inflightSyncs.delete(task)
    })

    this.#inflightSyncs.add(task)
    await task
  }

  async saveMemory({ content, type = 'fact', scene = '', teamId = 'dsh-botmode', agentId = 'default', userId = 'default', sessionId = '' }) {
    const clean = String(content ?? '').trim()
    if (clean === '') return { ok: false, error: 'Memory content is empty.' }

    // Mirror into local store when fallback is enabled, and push a structured
    // memory note to Gateway L0 so the v3 extraction pipeline indexes it too.
    let gatewaySynced = false
    if (!this.#isBreakerOpen() && (this.#gatewayOnline || await this.#probeGateway(false))) {
      try {
        await this.#client.conversationAdd({
          messages: [{
            role: 'user',
            content: `[Explicit Memory · ${type}${scene ? ` · scene:${scene}` : ''}] ${clean}`,
            timestamp: new Date().toISOString(),
          }],
          sessionId: sessionId || `mem:${agentId}`,
          teamId,
          agentId,
          userId,
        })
        this.#recordSuccess()
        gatewaySynced = true
      } catch (error) {
        this.#recordFailure(error)
      }
    }
    if (this.#fallbackEnabled) {
      await this.#fallback.addAtomic({ teamId, agentId, userId, type, content: clean, scene })
    }
    return {
      ok: gatewaySynced || this.#fallbackEnabled,
      mode: gatewaySynced ? 'gateway' : (this.#fallbackEnabled ? 'fallback-local' : 'offline'),
    }
  }

  async searchMemory({ query, limit, typeFilter = '', teamId = 'dsh-botmode', agentId = 'default', userId = 'default' }) {
    const q = String(query ?? '').trim()
    if (q === '') return { ok: false, error: 'Missing required parameter: query', items: [] }
    const cap = Math.max(1, Math.min(20, Number(limit) || this.#recallLimit))

    if (!this.#isBreakerOpen() && (this.#gatewayOnline || await this.#probeGateway(false))) {
      try {
        const result = await this.#client.atomicSearch({ query: q, limit: cap, typeFilter, teamId, agentId, userId })
        this.#recordSuccess()
        const items = result?.data?.items ?? []
        return {
          ok: true,
          mode: 'gateway',
          items,
          text: items.length === 0
            ? 'No memories found for this query.'
            : items.map(m => `- [${m.type || '?'}] ${m.content || ''}`).join('\n'),
        }
      } catch (error) {
        this.#recordFailure(error)
        if (!this.#fallbackEnabled) return { ok: false, error: String(error), items: [] }
      }
    }

    if (!this.#fallbackEnabled) return { ok: false, error: 'memory_tencentdb Gateway is unavailable.', items: [] }
    const items = await this.#fallback.searchAtomic({ teamId, agentId, userId, query: q, limit: cap, typeFilter })
    return {
      ok: true,
      mode: 'fallback-local',
      items,
      text: items.length === 0
        ? 'No memories found for this query.'
        : items.map(m => `- [${m.type || '?'}] ${m.content || ''}`).join('\n'),
    }
  }

  async searchConversations({ query, limit, sessionId = '', teamId = 'dsh-botmode', agentId = 'default', userId = 'default' }) {
    const q = String(query ?? '').trim()
    if (q === '') return { ok: false, error: 'Missing required parameter: query', items: [] }
    const cap = Math.max(1, Math.min(20, Number(limit) || this.#recallLimit))

    if (!this.#isBreakerOpen() && (this.#gatewayOnline || await this.#probeGateway(false))) {
      try {
        const result = await this.#client.conversationSearch({ query: q, limit: cap, sessionId, teamId, agentId, userId })
        this.#recordSuccess()
        const items = result?.data?.items ?? []
        return {
          ok: true,
          mode: 'gateway',
          items,
          text: items.length === 0
            ? 'No conversations found for this query.'
            : items.map(m => `[${m.role || '?'}] ${m.content || ''}`).join('\n'),
        }
      } catch (error) {
        this.#recordFailure(error)
        if (!this.#fallbackEnabled) return { ok: false, error: String(error), items: [] }
      }
    }

    if (!this.#fallbackEnabled) return { ok: false, error: 'memory_tencentdb Gateway is unavailable.', items: [] }
    const items = await this.#fallback.searchConversations({ teamId, agentId, userId, query: q, limit: cap, sessionId })
    return {
      ok: true,
      mode: 'fallback-local',
      items,
      text: items.length === 0
        ? 'No conversations found for this query.'
        : items.map(m => `[${m.role || '?'}] ${m.content || ''}`).join('\n'),
    }
  }

  async readScene({ sceneId, teamId = 'dsh-botmode', agentId = 'default', userId = 'default' }) {
    const raw = String(sceneId ?? '').trim()
    if (raw === '') {
      // List available scenes when sceneId is omitted
      if (!this.#isBreakerOpen() && (this.#gatewayOnline || await this.#probeGateway(false))) {
        try {
          const result = await this.#client.scenarioLs({ teamId, agentId, userId })
          this.#recordSuccess()
          const entries = result?.data?.entries ?? []
          return {
            ok: true,
            mode: 'gateway',
            entries,
            text: entries.length === 0
              ? 'No scenes available.'
              : entries.map(e => `- ${String(e.path || '').replace(/\.md$/, '')}`).join('\n'),
          }
        } catch (error) {
          this.#recordFailure(error)
        }
      }
      if (!this.#fallbackEnabled) return { ok: false, error: 'memory_tencentdb Gateway is unavailable.' }
      const entries = await this.#fallback.listScenes({ teamId, agentId, userId })
      return {
        ok: true,
        mode: 'fallback-local',
        entries,
        text: entries.length === 0
          ? 'No scenes available.'
          : entries.map(e => `- ${String(e.path || '').replace(/\.md$/, '')}`).join('\n'),
      }
    }

    const path = raw.endsWith('.md') ? raw : `${raw}.md`
    if (!this.#isBreakerOpen() && (this.#gatewayOnline || await this.#probeGateway(false))) {
      try {
        const result = await this.#client.scenarioRead({ path, teamId, agentId, userId })
        this.#recordSuccess()
        const content = String(result?.data?.content ?? '')
        return {
          ok: true,
          mode: 'gateway',
          text: content || `Scene '${raw}' is empty or not found.`,
        }
      } catch (error) {
        this.#recordFailure(error)
        if (!this.#fallbackEnabled) return { ok: false, error: String(error) }
      }
    }

    if (!this.#fallbackEnabled) return { ok: false, error: 'memory_tencentdb Gateway is unavailable.' }
    const content = await this.#fallback.readScene({ teamId, agentId, userId, path })
    return {
      ok: true,
      mode: 'fallback-local',
      text: content || `Scene '${raw}' is empty or not found.`,
    }
  }

  async onPreCompress({ bot, teamId = 'dsh-botmode', userId = 'default', sessionId = '', summary = '' }) {
    if (!summary) return ''
    await this.saveMemory({
      content: summary,
      type: 'checkpoint',
      scene: 'compaction',
      teamId,
      agentId: bot?.id || 'default',
      userId,
      sessionId,
    })
    return summary
  }

  async purgeAgent({ teamId = 'dsh-botmode', agentId }) {
    if (!agentId) return
    if (this.#fallbackEnabled) {
      await this.#fallback.purgeAgent({ teamId, agentId })
    }
  }

  async shutdown() {
    if (this.#inflightSyncs.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.#inflightSyncs]),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ])
    }
    this.#fallback?.close()
  }
}

export function createProvider(manifest, config, host) {
  return new MemoryTencentdbProvider(manifest, config, host)
}
