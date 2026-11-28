/**
 * local_sqlite — Zero-dependency local SQLite FTS5 memory provider plugin.
 */
import { join } from 'node:path'
import { MemoryProvider } from '../../protocol.js'
import { LocalFourLayerStore } from '../memory_tencentdb/fallback.js'

export class LocalSqliteMemoryProvider extends MemoryProvider {
  #store

  constructor(manifest, config = {}, host = {}) {
    super(manifest, config, host)
    const dataRoot = host?.dataRoot || join(process.cwd(), '.dsh-memory-data')
    this.#store = new LocalFourLayerStore(join(dataRoot, 'local_sqlite_memory.sqlite'))
  }

  get #recallLimit() {
    const num = Number(this.config?.recallLimit)
    return Number.isFinite(num) ? Math.max(1, Math.min(20, Math.trunc(num))) : 6
  }

  async initialize() {
    await this.#store.open()
  }

  async isAvailable() { return true }

  async health() {
    await this.#store.open()
    const stats = await this.#store.stats()
    return {
      ok: true,
      mode: 'local-sqlite',
      ftsEnabled: this.#store.ftsEnabled,
      stats,
      detail: `Local SQLite FTS5 ready (${stats.atomic} memories, ${stats.conversations} turns)`,
    }
  }

  systemPromptBlock({ teamId = 'dsh-botmode', agentId = 'default' } = {}) {
    return [
      '# Memory Hub (local_sqlite)',
      `Active for Team=${teamId}, Agent=${agentId}.`,
      'Local SQLite FTS5 memory store. Relevant facts are prefetched automatically; use `memory_search`, `memory_conversation_search`, `memory_read_scene`, or `memory_save` for explicit recall and persistence.',
    ].join('\n')
  }

  async prefetch({ query, teamId = 'dsh-botmode', agentId = 'default', userId = 'default' }) {
    const q = String(query ?? '').trim()
    if (q === '') return { text: '', count: 0 }
    const [items, scenes] = await Promise.all([
      this.#store.searchAtomic({ teamId, agentId, userId, query: q, limit: this.#recallLimit }),
      this.#store.listScenes({ teamId, agentId, userId }),
    ])
    const parts = []
    if (items.length > 0) {
      parts.push(`<relevant-memories>\n以下是当前对话召回的相关记忆（仅作参考）：\n\n${items.map(i => `- [${i.type}] ${i.content}`).join('\n')}\n</relevant-memories>`)
    }
    if (scenes.length > 0) {
      parts.push(`<scene-navigation>\nAvailable scenes:\n${scenes.map(s => `- Scene: ${s.path.replace(/\.md$/, '')}`).join('\n')}\n</scene-navigation>`)
    }
    return { text: parts.join('\n\n'), count: items.length, source: 'local-sqlite' }
  }

  async syncTurn({ userText, assistantText, teamId = 'dsh-botmode', agentId = 'default', userId = 'default', sessionId = '', source = 'chat' }) {
    const messages = []
    const now = Date.now()
    if (String(userText ?? '').trim() !== '') messages.push({ role: 'user', content: String(userText).trim(), timestamp: new Date(now - 10).toISOString() })
    if (String(assistantText ?? '').trim() !== '') messages.push({ role: 'assistant', content: String(assistantText).trim(), timestamp: new Date(now).toISOString() })
    if (messages.length === 0) return
    await this.#store.addConversation({ teamId, agentId, userId, sessionId, messages, source })
  }

  async saveMemory({ content, type = 'fact', scene = '', teamId = 'dsh-botmode', agentId = 'default', userId = 'default' }) {
    return this.#store.addAtomic({ teamId, agentId, userId, type, content, scene })
  }

  async searchMemory({ query, limit, typeFilter = '', teamId = 'dsh-botmode', agentId = 'default', userId = 'default' }) {
    const items = await this.#store.searchAtomic({ teamId, agentId, userId, query, limit: limit || this.#recallLimit, typeFilter })
    return {
      ok: true,
      mode: 'local-sqlite',
      items,
      text: items.length === 0 ? 'No memories found for this query.' : items.map(m => `- [${m.type}] ${m.content}`).join('\n'),
    }
  }

  async searchConversations({ query, limit, sessionId = '', teamId = 'dsh-botmode', agentId = 'default', userId = 'default' }) {
    const items = await this.#store.searchConversations({ teamId, agentId, userId, query, limit: limit || this.#recallLimit, sessionId })
    return {
      ok: true,
      mode: 'local-sqlite',
      items,
      text: items.length === 0 ? 'No conversations found for this query.' : items.map(m => `[${m.role}] ${m.content}`).join('\n'),
    }
  }

  async readScene({ sceneId, teamId = 'dsh-botmode', agentId = 'default', userId = 'default' }) {
    const raw = String(sceneId ?? '').trim()
    if (raw === '') {
      const entries = await this.#store.listScenes({ teamId, agentId, userId })
      return { ok: true, entries, text: entries.length === 0 ? 'No scenes available.' : entries.map(e => `- ${e.path.replace(/\.md$/, '')}`).join('\n') }
    }
    const path = raw.endsWith('.md') ? raw : `${raw}.md`
    const content = await this.#store.readScene({ teamId, agentId, userId, path })
    return { ok: true, text: content || `Scene '${raw}' is empty or not found.` }
  }

  async purgeAgent({ teamId = 'dsh-botmode', agentId }) {
    if (!agentId) return
    await this.#store.purgeAgent({ teamId, agentId })
  }

  async shutdown() {
    this.#store.close()
  }
}

export function createProvider(manifest, config, host) {
  return new LocalSqliteMemoryProvider(manifest, config, host)
}
