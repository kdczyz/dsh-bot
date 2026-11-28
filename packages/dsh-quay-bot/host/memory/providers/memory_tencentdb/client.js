/**
 * HTTP client for the memory-tencentdb v3 Gateway sidecar.
 *
 * Implements the exact v3 data-plane endpoints used by Hermes's
 * `memory_tencentdb` plugin with team_id / agent_id / user_id tenancy isolation:
 *   GET  /health
 *   POST /v3/conversation/add
 *   POST /v3/conversation/search
 *   POST /v3/atomic/search
 *   POST /v3/scenario/ls
 *   POST /v3/scenario/read
 *   POST /v3/core/read
 */

export class MemoryTencentdbClient {
  constructor({
    baseUrl = 'http://127.0.0.1:8420',
    apiKey = '',
    serviceId = 'default',
    timeoutMs = 8000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:8420').replace(/\/+$/, '')
    this.apiKey = String(apiKey || '').trim()
    this.serviceId = String(serviceId || 'default').trim() || 'default'
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 8000)
    this.fetchImpl = fetchImpl
  }

  #headers(json = true) {
    const headers = {
      authorization: `Bearer ${this.apiKey || 'local'}`,
      'x-tdai-service-id': this.serviceId,
    }
    if (json) headers['content-type'] = 'application/json'
    return headers
  }

  async #request(method, path, body, timeoutMs = this.timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.#headers(method !== 'GET'),
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        signal: controller.signal,
      })
      const rawText = await response.text()
      let payload
      try {
        payload = rawText === '' ? {} : JSON.parse(rawText)
      } catch (_error) {
        throw new Error(`Gateway ${path} returned non-JSON (${response.status}): ${rawText.slice(0, 200)}`)
      }
      if (!response.ok) {
        const msg = payload?.message || payload?.error || rawText.slice(0, 200)
        throw new Error(`Gateway ${path} returned HTTP ${response.status}: ${msg}`)
      }
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  async health(timeoutMs = 2500) {
    return this.#request('GET', '/health', undefined, timeoutMs)
  }

  async conversationAdd({ messages, sessionId = '', teamId = 'default', agentId = 'default', userId = 'default' }) {
    return this.#request('POST', '/v3/conversation/add', {
      team_id: teamId,
      agent_id: agentId,
      user_id: userId,
      session_id: sessionId,
      messages,
    })
  }

  async conversationSearch({ query, limit = 5, sessionId = '', teamId = 'default', agentId = 'default', userId = 'default' }) {
    const body = {
      team_id: teamId,
      agent_id: agentId,
      user_id: userId,
      query,
      limit,
    }
    if (sessionId) body.session_id = sessionId
    return this.#request('POST', '/v3/conversation/search', body)
  }

  async atomicSearch({ query, limit = 5, typeFilter = '', teamId = 'default', agentId = 'default', userId = 'default' }) {
    const body = {
      team_id: teamId,
      agent_id: agentId,
      user_id: userId,
      query,
      limit,
    }
    if (typeFilter) body.type = typeFilter
    return this.#request('POST', '/v3/atomic/search', body)
  }

  async scenarioLs({ teamId = 'default', agentId = 'default', userId = 'default' }) {
    return this.#request('POST', '/v3/scenario/ls', {
      team_id: teamId,
      agent_id: agentId,
      user_id: userId,
    })
  }

  async scenarioRead({ path, teamId = 'default', agentId = 'default', userId = 'default' }) {
    return this.#request('POST', '/v3/scenario/read', {
      team_id: teamId,
      agent_id: agentId,
      user_id: userId,
      path,
    })
  }

  async coreRead({ teamId = 'default', agentId = 'default', userId = 'default' }) {
    return this.#request('POST', '/v3/core/read', {
      team_id: teamId,
      agent_id: agentId,
      user_id: userId,
    })
  }
}
