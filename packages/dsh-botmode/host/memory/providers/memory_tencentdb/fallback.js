/**
 * Zero-dependency local four-layer SQLite + FTS5 memory store built on Node 22's
 * native `node:sqlite`.
 *
 * Mirrors the TencentDB Agent Memory tenancy model (`team_id`, `agent_id`,
 * `user_id`) across L0 conversations, L1 atomic memories, L2 scene notes and
 * L3 core persona summaries. Used both as:
 *   1. automatic local fallback when the 8420 memory-tencentdb Gateway is offline;
 *   2. the standalone `local_sqlite` memory provider plugin.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

let sqliteModulePromise = null
const loadSqlite = () => {
  if (!sqliteModulePromise) sqliteModulePromise = import('node:sqlite')
  return sqliteModulePromise
}

const sanitizeFtsQuery = (query) => {
  const cleaned = String(query ?? '')
    .replace(/["'`*():^~[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return ''
  // Trigram tokenizer works best with quoted terms >= 3 chars; fall back to LIKE for shorter terms.
  const parts = cleaned.split(' ').filter(part => part.length >= 3)
  if (parts.length === 0) return ''
  return parts.map(part => `"${part}"`).join(' OR ')
}

const normalizeKeywords = (query) => String(query ?? '')
  .trim()
  .split(/[\s,，。！？；：、/]+/)
  .map(part => part.trim())
  .filter(Boolean)
  .slice(0, 6)

const escapeLike = (value) => String(value ?? '').replace(/[\\%_]/g, '\\$&')

const MAX_FTS_INDEX_CHARS = 4000

/**
 * Heuristic fact extraction for local mode so completed turns automatically
 * populate L1 atomic facts without requiring an extra LLM round-trip.
 */
const extractAtomicCandidates = (userText, assistantText) => {
  const facts = []
  const push = (type, text) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (clean.length < 8 || clean.length > 600) return
    facts.push({ type, content: clean })
  }
  const userClean = String(userText ?? '').trim()
  const assistantClean = String(assistantText ?? '').trim()
  if (userClean && /(记住|注意|以后|约定|偏好|规范|端口|目录|路径|不要|必须|remember|prefer|always|never|rule|path|port)/i.test(userClean)) {
    push('preference', userClean.slice(0, 320))
  }
  if (assistantClean && /(结论|决定|已完成|创建了|修改了|路径|端口|方案|总结|decided|created|updated|fixed|summary)/i.test(assistantClean)) {
    const firstLine = assistantClean.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2).join(' ')
    push('fact', firstLine.slice(0, 360))
  }
  return facts
}

export class LocalFourLayerStore {
  #db = null
  #ftsEnabled = false

  constructor(dbPath) {
    this.dbPath = dbPath
  }

  async open() {
    if (this.#db) return this.#db
    mkdirSync(dirname(this.dbPath), { recursive: true })
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(this.dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec('PRAGMA wal_autocheckpoint = 256;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'chat',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_scope
        ON conversations(team_id, agent_id, user_id, id DESC);

      CREATE TABLE IF NOT EXISTS atomic_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'fact',
        content TEXT NOT NULL,
        scene TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_atomic_scope
        ON atomic_memories(team_id, agent_id, user_id, id DESC);

      CREATE TABLE IF NOT EXISTS scenes (
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (team_id, agent_id, user_id, path)
      );

      CREATE TABLE IF NOT EXISTS core_profiles (
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (team_id, agent_id, user_id)
      );
    `)
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS atomic_fts USING fts5(
          content,
          content='atomic_memories',
          content_rowid='id',
          tokenize='trigram'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
          content,
          content='conversations',
          content_rowid='id',
          tokenize='trigram'
        );
      `)
      this.#ftsEnabled = true
    } catch (_error) {
      this.#ftsEnabled = false
    }
    this.#db = db
    return db
  }

  get ftsEnabled() { return this.#ftsEnabled }

  async addConversation({ teamId = 'default', agentId = 'default', userId = 'default', sessionId = '', messages = [], source = 'chat' }) {
    const db = await this.open()
    const insertConv = db.prepare(`
      INSERT INTO conversations (team_id, agent_id, user_id, session_id, role, content, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertConvFts = this.#ftsEnabled
      ? db.prepare('INSERT INTO conversations_fts (rowid, content) VALUES (?, ?)')
      : null

    let lastUser = ''
    let lastAssistant = ''
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const msg of messages) {
        const content = String(msg?.content ?? '').trim()
        if (content === '') continue
        const role = String(msg?.role ?? 'user')
        const at = typeof msg?.timestamp === 'string' && msg.timestamp !== '' ? msg.timestamp : new Date().toISOString()
        const info = insertConv.run(teamId, agentId, userId, sessionId, role, content, source, at)
        if (insertConvFts) {
          try { insertConvFts.run(info.lastInsertRowid, content.slice(0, MAX_FTS_INDEX_CHARS)) } catch (_error) { /* best effort */ }
        }
        if (role === 'user') lastUser = content
        if (role === 'assistant') lastAssistant = content
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch (_err) { /* ignore */ }
      throw error
    }

    // Never auto-extract personal preferences from Group Room multi-bot deltas;
    // group rooms share state via transcript/notes/taskboard or explicit `memory_save`.
    if (source !== 'room') {
      const candidates = extractAtomicCandidates(lastUser, lastAssistant)
      for (const item of candidates) {
        await this.addAtomic({
          teamId,
          agentId,
          userId,
          type: item.type,
          content: item.content,
        })
      }
    }
    return { ok: true, count: messages.length }
  }

  async addAtomic({ teamId = 'default', agentId = 'default', userId = 'default', type = 'fact', content = '', scene = '' }) {
    const clean = String(content ?? '').trim()
    if (clean === '') return { ok: false, error: 'empty content' }
    const db = await this.open()
    const existing = db.prepare(`
      SELECT id FROM atomic_memories
      WHERE team_id = ? AND agent_id = ? AND user_id = ? AND content = ?
      LIMIT 1
    `).get(teamId, agentId, userId, clean)
    if (existing) return { ok: true, id: existing.id, deduplicated: true }
    const now = new Date().toISOString()
    const info = db.prepare(`
      INSERT INTO atomic_memories (team_id, agent_id, user_id, type, content, scene, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(teamId, agentId, userId, String(type || 'fact'), clean, String(scene || ''), now)
    if (this.#ftsEnabled) {
      try {
        db.prepare('INSERT INTO atomic_fts (rowid, content) VALUES (?, ?)').run(info.lastInsertRowid, clean)
      } catch (_error) { /* best effort */ }
    }
    if (scene) {
      await this.appendScene({ teamId, agentId, userId, path: scene.endsWith('.md') ? scene : `${scene}.md`, line: `- [${type}] ${clean}` })
    }
    return { ok: true, id: Number(info.lastInsertRowid) }
  }

  async appendScene({ teamId = 'default', agentId = 'default', userId = 'default', path, line }) {
    const db = await this.open()
    const row = db.prepare(`
      SELECT content FROM scenes WHERE team_id = ? AND agent_id = ? AND user_id = ? AND path = ?
    `).get(teamId, agentId, userId, path)
    const next = row ? `${row.content}\n${line}` : `# ${path.replace(/\.md$/, '')}\n\n${line}`
    db.prepare(`
      INSERT INTO scenes (team_id, agent_id, user_id, path, content, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, agent_id, user_id, path)
      DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(teamId, agentId, userId, path, next, new Date().toISOString())
  }

  async searchAtomic({ teamId = 'default', agentId = 'default', userId = 'default', query = '', limit = 5, typeFilter = '' }) {
    const db = await this.open()
    const cap = Math.max(1, Math.min(20, Number(limit) || 5))
    const ftsQuery = this.#ftsEnabled ? sanitizeFtsQuery(query) : ''
    let rows = []

    if (ftsQuery !== '') {
      try {
        const sql = typeFilter
          ? `SELECT m.id, m.type, m.content, m.scene, m.created_at
             FROM atomic_fts f JOIN atomic_memories m ON m.id = f.rowid
             WHERE f.atomic_fts MATCH ? AND m.team_id = ? AND m.agent_id = ? AND m.user_id = ? AND m.type = ?
             ORDER BY bm25(atomic_fts), m.id DESC LIMIT ?`
          : `SELECT m.id, m.type, m.content, m.scene, m.created_at
             FROM atomic_fts f JOIN atomic_memories m ON m.id = f.rowid
             WHERE f.atomic_fts MATCH ? AND m.team_id = ? AND m.agent_id = ? AND m.user_id = ?
             ORDER BY bm25(atomic_fts), m.id DESC LIMIT ?`
        rows = typeFilter
          ? db.prepare(sql).all(ftsQuery, teamId, agentId, userId, typeFilter, cap)
          : db.prepare(sql).all(ftsQuery, teamId, agentId, userId, cap)
      } catch (_error) {
        rows = []
      }
    }

    const keywords = normalizeKeywords(query)
    const shortKeywords = keywords.filter(kw => kw.length < 3)
    if (rows.length === 0 || (shortKeywords.length > 0 && rows.length < cap)) {
      const likeTerms = rows.length === 0 ? keywords : shortKeywords
      if (likeTerms.length > 0) {
        const likes = likeTerms.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ')
        const params = [teamId, agentId, userId]
        if (typeFilter) params.push(typeFilter)
        for (const kw of likeTerms) params.push(`%${escapeLike(kw)}%`)
        params.push(cap)
        const sql = `
          SELECT id, type, content, scene, created_at FROM atomic_memories
          WHERE team_id = ? AND agent_id = ? AND user_id = ?
            ${typeFilter ? 'AND type = ?' : ''}
            AND (${likes})
          ORDER BY id DESC LIMIT ?
        `
        const extra = db.prepare(sql).all(...params)
        if (rows.length === 0) {
          rows = extra
        } else {
          const seenIds = new Set(rows.map(r => r.id))
          for (const r of extra) {
            if (!seenIds.has(r.id) && rows.length < cap) {
              seenIds.add(r.id)
              rows.push(r)
            }
          }
        }
      }
    }

    return rows.map(row => ({
      id: row.id,
      type: row.type,
      content: row.content,
      scene: row.scene,
      createdAt: row.created_at,
    }))
  }

  async searchConversations({ teamId = 'default', agentId = 'default', userId = 'default', query = '', limit = 5, sessionId = '' }) {
    const db = await this.open()
    const cap = Math.max(1, Math.min(20, Number(limit) || 5))
    const ftsQuery = this.#ftsEnabled ? sanitizeFtsQuery(query) : ''
    let rows = []

    if (ftsQuery !== '') {
      try {
        const params = [ftsQuery, teamId, agentId, userId]
        if (sessionId) params.push(sessionId)
        params.push(cap)
        const sql = `
          SELECT c.id, c.role, c.content, c.session_id, c.created_at
          FROM conversations_fts f JOIN conversations c ON c.id = f.rowid
          WHERE f.conversations_fts MATCH ? AND c.team_id = ? AND c.agent_id = ? AND c.user_id = ?
            ${sessionId ? 'AND c.session_id = ?' : ''}
          ORDER BY bm25(conversations_fts), c.id DESC LIMIT ?
        `
        rows = db.prepare(sql).all(...params)
      } catch (_error) {
        rows = []
      }
    }

    const keywords = normalizeKeywords(query)
    const shortKeywords = keywords.filter(kw => kw.length < 3)
    if (rows.length === 0 || (shortKeywords.length > 0 && rows.length < cap)) {
      const likeTerms = rows.length === 0 ? keywords : shortKeywords
      if (likeTerms.length > 0) {
        const likes = likeTerms.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ')
        const params = [teamId, agentId, userId]
        if (sessionId) params.push(sessionId)
        for (const kw of likeTerms) params.push(`%${escapeLike(kw)}%`)
        params.push(cap)
        const sql = `
          SELECT id, role, content, session_id, created_at FROM conversations
          WHERE team_id = ? AND agent_id = ? AND user_id = ?
            ${sessionId ? 'AND session_id = ?' : ''}
            AND (${likes})
          ORDER BY id DESC LIMIT ?
        `
        const extra = db.prepare(sql).all(...params)
        if (rows.length === 0) {
          rows = extra
        } else {
          const seenIds = new Set(rows.map(r => r.id))
          for (const r of extra) {
            if (!seenIds.has(r.id) && rows.length < cap) {
              seenIds.add(r.id)
              rows.push(r)
            }
          }
        }
      }
    }

    return rows.map(row => ({
      id: row.id,
      role: row.role,
      content: row.content,
      sessionId: row.session_id,
      createdAt: row.created_at,
    }))
  }

  async listScenes({ teamId = 'default', agentId = 'default', userId = 'default' }) {
    const db = await this.open()
    const rows = db.prepare(`
      SELECT path, updated_at FROM scenes
      WHERE team_id = ? AND agent_id = ? AND user_id = ?
      ORDER BY updated_at DESC LIMIT 30
    `).all(teamId, agentId, userId)
    return rows.map(row => ({ path: row.path, updatedAt: row.updated_at }))
  }

  async readScene({ teamId = 'default', agentId = 'default', userId = 'default', path }) {
    const db = await this.open()
    const row = db.prepare(`
      SELECT content FROM scenes
      WHERE team_id = ? AND agent_id = ? AND user_id = ? AND path = ?
    `).get(teamId, agentId, userId, path)
    return row ? String(row.content) : ''
  }

  async readCore({ teamId = 'default', agentId = 'default', userId = 'default' }) {
    const db = await this.open()
    const row = db.prepare(`
      SELECT content FROM core_profiles
      WHERE team_id = ? AND agent_id = ? AND user_id = ?
    `).get(teamId, agentId, userId)
    return row ? String(row.content) : ''
  }

  async writeCore({ teamId = 'default', agentId = 'default', userId = 'default', content }) {
    const db = await this.open()
    db.prepare(`
      INSERT INTO core_profiles (team_id, agent_id, user_id, content, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id, agent_id, user_id)
      DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(teamId, agentId, userId, String(content ?? ''), new Date().toISOString())
  }

  async stats({ teamId, agentId } = {}) {
    const db = await this.open()
    if (teamId && agentId) {
      const conv = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE team_id = ? AND agent_id = ?').get(teamId, agentId)
      const atomic = db.prepare('SELECT COUNT(*) AS n FROM atomic_memories WHERE team_id = ? AND agent_id = ?').get(teamId, agentId)
      const scenes = db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE team_id = ? AND agent_id = ?').get(teamId, agentId)
      return { conversations: Number(conv?.n ?? 0), atomic: Number(atomic?.n ?? 0), scenes: Number(scenes?.n ?? 0) }
    }
    const conv = db.prepare('SELECT COUNT(*) AS n FROM conversations').get()
    const atomic = db.prepare('SELECT COUNT(*) AS n FROM atomic_memories').get()
    const scenes = db.prepare('SELECT COUNT(*) AS n FROM scenes').get()
    return { conversations: Number(conv?.n ?? 0), atomic: Number(atomic?.n ?? 0), scenes: Number(scenes?.n ?? 0) }
  }

  async purgeAgent({ teamId = 'default', agentId }) {
    if (!agentId) return
    const db = await this.open()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM conversations WHERE team_id = ? AND agent_id = ?').run(teamId, agentId)
      db.prepare('DELETE FROM atomic_memories WHERE team_id = ? AND agent_id = ?').run(teamId, agentId)
      db.prepare('DELETE FROM scenes WHERE team_id = ? AND agent_id = ?').run(teamId, agentId)
      db.prepare('DELETE FROM core_profiles WHERE team_id = ? AND agent_id = ?').run(teamId, agentId)
      if (this.#ftsEnabled) {
        try {
          db.exec("INSERT INTO atomic_fts(atomic_fts) VALUES('rebuild');")
          db.exec("INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild');")
        } catch (_err) { /* ignore */ }
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch (_err) { /* ignore */ }
      throw error
    }
  }

  close() {
    if (this.#db) {
      try { this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch (_error) { /* ignore */ }
      try { this.#db.close() } catch (_error) { /* ignore */ }
      this.#db = null
    }
  }
}
