/**
 * Curated memory plugin catalog for one-click install / switching alongside
 * arbitrary npm packages, Git repositories, tarballs and local plugin folders.
 *
 * Each catalog entry materializes a real, self-contained DSH memory plugin
 * (`plugin.json` + ESM `index.js`) under `$DSH_HOME/botmode/memory-plugins/<id>/`
 * so users can inspect, customize, switch or uninstall it just like any other
 * downloaded memory plugin.
 */

export const MEMORY_CATALOG = [
  {
    id: 'mem0_http',
    displayName: 'Mem0 Cloud / Self-Hosted',
    version: '1.0.0',
    description: '对接 Mem0 REST API（支持 api.mem0.ai 云端或自托管 Mem0 服务），按 agent_id / user_id 为每个 Bot 隔离检索与写入记忆。',
    homepage: 'https://docs.mem0.ai',
    installSource: 'catalog:mem0_http',
    tags: ['cloud', 'self-hosted', 'rest'],
  },
  {
    id: 'http_memory',
    displayName: 'Generic HTTP Memory Adapter',
    version: '1.0.0',
    description: '通用 HTTP 记忆库适配器（支持对接 Honcho / Hindsight / RetainDB / 自建记忆网关的 /search、/add、/health 端点）。',
    homepage: '',
    installSource: 'catalog:http_memory',
    tags: ['custom', 'http', 'adapter'],
  },
]

const MEM0_PLUGIN_JSON = {
  schemaVersion: 1,
  id: 'mem0_http',
  displayName: 'Mem0 Cloud / Self-Hosted',
  version: '1.0.0',
  description: 'Mem0 REST API 记忆库插件，按 agent_id 为每个 Bot 隔离记忆。',
  author: 'dsh-botmode catalog',
  homepage: 'https://docs.mem0.ai',
  entry: 'index.js',
  aliases: ['mem0'],
  tools: ['memory_search', 'memory_save'],
  configSchema: [
    {
      key: 'baseUrl',
      label: 'API Base URL',
      type: 'text',
      default: 'https://api.mem0.ai',
      description: 'Mem0 API 根地址（云端 https://api.mem0.ai 或自托管地址）',
    },
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'text',
      secret: true,
      default: '',
      description: 'Mem0 Authorization Token（Token <apiKey>）',
    },
    {
      key: 'recallLimit',
      label: '单次召回条数',
      type: 'integer',
      default: 5,
      minimum: 1,
      maximum: 20,
      description: '每轮 prefetch 检索的最大记忆条数',
    },
  ],
}

const MEM0_INDEX_JS = `/**
 * Mem0 REST API MemoryProvider plugin (generated from dsh-botmode catalog).
 */
export function createProvider(manifest, config = {}, host = {}) {
  const fetchImpl = host.fetchImpl || globalThis.fetch
  const baseUrl = String(config.baseUrl || 'https://api.mem0.ai').replace(/\\/+$/, '')
  const apiKey = String(config.apiKey || process.env.MEM0_API_KEY || '').trim()
  const recallLimit = Math.max(1, Math.min(20, Number(config.recallLimit) || 5))

  const headers = () => ({
    'content-type': 'application/json',
    ...(apiKey ? { authorization: \`Token \${apiKey}\` } : {}),
  })

  const post = async (path, body) => {
    const res = await fetchImpl(\`\${baseUrl}\${path}\`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.detail || data?.message || \`HTTP \${res.status}\`)
    return data
  }

  return {
    id: manifest.id,
    displayName: manifest.displayName,
    manifest,
    async isAvailable() { return baseUrl !== '' },
    async health() {
      if (!apiKey && baseUrl.includes('api.mem0.ai')) {
        return { ok: false, mode: 'mem0', detail: 'Missing Mem0 API key' }
      }
      return { ok: true, mode: 'mem0', baseUrl, detail: \`Mem0 configured (\${baseUrl})\` }
    },
    async initialize() {},
    systemPromptBlock({ teamId, agentId } = {}) {
      return \`# Memory Hub (Mem0)\\nActive for Team=\${teamId || 'default'}, Agent=\${agentId || 'default'}. Use memory_search and memory_save to query or store long-term facts.\`
    },
    async prefetch({ query, agentId = 'default', userId = 'default' }) {
      const q = String(query || '').trim()
      if (!q) return { text: '', count: 0 }
      try {
        const res = await post('/v1/memories/search/', {
          query: q,
          agent_id: agentId,
          user_id: userId,
          limit: recallLimit,
        })
        const items = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : [])
        if (items.length === 0) return { text: '', count: 0 }
        const lines = items.map(item => \`- \${item.memory || item.content || JSON.stringify(item)}\`)
        return {
          text: \`<relevant-memories>\\n\${lines.join('\\n')}\\n</relevant-memories>\`,
          count: items.length,
          source: 'mem0',
        }
      } catch (_error) {
        return { text: '', count: 0 }
      }
    },
    async syncTurn({ userText, assistantText, agentId = 'default', userId = 'default' }) {
      const messages = []
      if (userText) messages.push({ role: 'user', content: String(userText) })
      if (assistantText) messages.push({ role: 'assistant', content: String(assistantText) })
      if (messages.length === 0) return
      await post('/v1/memories/', { messages, agent_id: agentId, user_id: userId }).catch(() => {})
    },
    async searchMemory({ query, limit, agentId = 'default', userId = 'default' }) {
      const res = await post('/v1/memories/search/', {
        query: String(query || ''),
        agent_id: agentId,
        user_id: userId,
        limit: Number(limit) || recallLimit,
      })
      const items = (Array.isArray(res) ? res : (res?.results || [])).map(item => ({
        type: 'mem0',
        content: item.memory || item.content || '',
      }))
      return {
        ok: true,
        mode: 'mem0',
        items,
        text: items.length === 0 ? 'No memories found.' : items.map(i => \`- \${i.content}\`).join('\\n'),
      }
    },
    async saveMemory({ content, agentId = 'default', userId = 'default' }) {
      await post('/v1/memories/', {
        messages: [{ role: 'user', content: String(content || '') }],
        agent_id: agentId,
        user_id: userId,
      })
      return { ok: true, mode: 'mem0' }
    },
    async shutdown() {},
  }
}
`

const HTTP_MEMORY_PLUGIN_JSON = {
  schemaVersion: 1,
  id: 'http_memory',
  displayName: 'Generic HTTP Memory Adapter',
  version: '1.0.0',
  description: '通用 HTTP 记忆库适配器（GET /health、POST /search、POST /sync、POST /save）。',
  author: 'dsh-botmode catalog',
  homepage: '',
  entry: 'index.js',
  aliases: ['http', 'custom_http'],
  tools: ['memory_search', 'memory_save'],
  configSchema: [
    {
      key: 'baseUrl',
      label: '服务地址 (Base URL)',
      type: 'text',
      default: 'http://127.0.0.1:8787',
      description: '外部记忆库 HTTP 服务根地址',
    },
    {
      key: 'apiKey',
      label: 'Bearer API Key',
      type: 'text',
      secret: true,
      default: '',
      description: '可选 Bearer Token',
    },
    {
      key: 'searchPath',
      label: '检索路径',
      type: 'text',
      default: '/search',
      description: 'POST 检索接口路径',
    },
    {
      key: 'syncPath',
      label: '同步路径',
      type: 'text',
      default: '/sync',
      description: 'POST 对话同步接口路径',
    },
    {
      key: 'savePath',
      label: '写入路径',
      type: 'text',
      default: '/save',
      description: 'POST 显式保存记忆接口路径',
    },
    {
      key: 'healthPath',
      label: '健康检查路径',
      type: 'text',
      default: '/health',
      description: 'GET 健康检查接口路径',
    },
    {
      key: 'recallLimit',
      label: '单次召回条数',
      type: 'integer',
      default: 5,
      minimum: 1,
      maximum: 20,
      description: '每轮 prefetch 检索的最大条数',
    },
  ],
}

const HTTP_MEMORY_INDEX_JS = `/**
 * Generic HTTP MemoryProvider plugin (generated from dsh-botmode catalog).
 */
export function createProvider(manifest, config = {}, host = {}) {
  const fetchImpl = host.fetchImpl || globalThis.fetch
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:8787').replace(/\\/+$/, '')
  const apiKey = String(config.apiKey || '').trim()
  const searchPath = String(config.searchPath || '/search')
  const syncPath = String(config.syncPath || '/sync')
  const savePath = String(config.savePath || '/save')
  const healthPath = String(config.healthPath || '/health')
  const recallLimit = Math.max(1, Math.min(20, Number(config.recallLimit) || 5))

  const headers = (json = true) => ({
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(apiKey ? { authorization: \`Bearer \${apiKey}\` } : {}),
  })

  const post = async (path, body) => {
    const res = await fetchImpl(\`\${baseUrl}\${path}\`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.error || data?.message || \`HTTP \${res.status}\`)
    return data
  }

  return {
    id: manifest.id,
    displayName: manifest.displayName,
    manifest,
    async isAvailable() { return baseUrl !== '' },
    async health() {
      try {
        const res = await fetchImpl(\`\${baseUrl}\${healthPath}\`, { headers: headers(false) })
        return { ok: res.ok, mode: 'http', baseUrl, detail: res.ok ? \`Connected (\${baseUrl})\` : \`HTTP \${res.status}\` }
      } catch (error) {
        return { ok: false, mode: 'http', baseUrl, detail: String(error) }
      }
    },
    async initialize() {},
    systemPromptBlock({ teamId, agentId } = {}) {
      return \`# Memory Hub (\${manifest.displayName})\\nActive for Team=\${teamId || 'default'}, Agent=\${agentId || 'default'}.\`
    },
    async prefetch({ query, teamId, agentId, userId, sessionId }) {
      const q = String(query || '').trim()
      if (!q) return { text: '', count: 0 }
      try {
        const res = await post(searchPath, { query: q, limit: recallLimit, teamId, agentId, userId, sessionId })
        const items = Array.isArray(res?.items) ? res.items : (Array.isArray(res?.data?.items) ? res.data.items : [])
        if (items.length === 0) return { text: '', count: 0 }
        const lines = items.map(item => \`- \${typeof item === 'string' ? item : (item.content || item.memory || JSON.stringify(item))}\`)
        return { text: \`<relevant-memories>\\n\${lines.join('\\n')}\\n</relevant-memories>\`, count: items.length, source: 'http' }
      } catch (_error) {
        return { text: '', count: 0 }
      }
    },
    async syncTurn({ userText, assistantText, teamId, agentId, userId, sessionId }) {
      await post(syncPath, { userText, assistantText, teamId, agentId, userId, sessionId }).catch(() => {})
    },
    async searchMemory({ query, limit, teamId, agentId, userId }) {
      const res = await post(searchPath, { query, limit: Number(limit) || recallLimit, teamId, agentId, userId })
      const raw = Array.isArray(res?.items) ? res.items : (Array.isArray(res?.data?.items) ? res.data.items : [])
      const items = raw.map(item => (typeof item === 'string' ? { type: 'memory', content: item } : { type: item.type || 'memory', content: item.content || item.memory || '' }))
      return { ok: true, mode: 'http', items, text: items.length === 0 ? 'No memories found.' : items.map(i => \`- \${i.content}\`).join('\\n') }
    },
    async saveMemory({ content, type, scene, teamId, agentId, userId }) {
      await post(savePath, { content, type, scene, teamId, agentId, userId })
      return { ok: true, mode: 'http' }
    },
    async shutdown() {},
  }
}
`

export function getCatalogTemplate(catalogId) {
  if (catalogId === 'mem0_http') {
    return { manifest: MEM0_PLUGIN_JSON, indexJs: MEM0_INDEX_JS }
  }
  if (catalogId === 'http_memory') {
    return { manifest: HTTP_MEMORY_PLUGIN_JSON, indexJs: HTTP_MEMORY_INDEX_JS }
  }
  return undefined
}
