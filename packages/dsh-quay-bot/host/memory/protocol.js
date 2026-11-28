/**
 * Hermes-aligned pluggable MemoryProvider contract for dsh-botmode.
 *
 * Every memory plugin (bundled under `host/memory/providers/<id>/` or
 * downloaded into `$DSH_HOME/botmode/memory-plugins/<id>/`) ships a
 * `plugin.json` manifest plus an ESM entry exporting `createProvider(config, host)`.
 *
 * All Bots share one active provider at a time (single-select, matching
 * Hermes `memory.provider`), while scoping data per Bot via `agentId`,
 * `teamId`, `userId` and `sessionId`.
 */

export const MEMORY_PLUGIN_SCHEMA_VERSION = 1

export const TRIVIAL_PROMPT_RE = /^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k|好|好的|收到|谢谢|感谢|明白|继续|开始|嗯|行|可以|pass|\(pass\)|（pass）|\[no_reply\])[\s!?.:;,"'~\u2018\u2019\u201c\u201d\u2014\u2013\u2026()[\]{}<>*&^%$#@!+=`\u00a0。，！？、；：]*$/iu

/**
 * Skip memory prefetch for empty text, slash commands, or bare acknowledgements
 * to save latency and avoid injecting noisy context into trivial replies.
 */
export function isTrivialPrompt(text) {
  const stripped = String(text ?? '').trim()
  if (stripped === '' || stripped.startsWith('/')) return true
  return TRIVIAL_PROMPT_RE.test(stripped)
}

export function normalizeProviderId(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_')
}

/**
 * Validate a memory plugin's `plugin.json` manifest.
 * @returns {{ ok: true, manifest: object } | { ok: false, error: string }}
 */
export function validatePluginManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'plugin.json must be a JSON object.' }
  }
  const id = normalizeProviderId(raw.id ?? raw.name)
  if (id === '' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    return { ok: false, error: 'plugin.json requires a valid `id` (letters, digits, _ or -).' }
  }
  const entry = typeof raw.entry === 'string' && raw.entry.trim() !== '' ? raw.entry.trim() : 'index.js'
  if (entry.startsWith('/') || entry.includes('..')) {
    return { ok: false, error: 'plugin.json `entry` must be a relative path inside the plugin directory.' }
  }
  const configSchema = Array.isArray(raw.configSchema)
    ? raw.configSchema.filter(item => item && typeof item.key === 'string' && item.key !== '')
    : []
  const aliases = Array.isArray(raw.aliases)
    ? [...new Set(raw.aliases.map(normalizeProviderId).filter(Boolean))]
    : []
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter(item => typeof item === 'string' && item !== '')
    : []
  return {
    ok: true,
    manifest: {
      schemaVersion: Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : MEMORY_PLUGIN_SCHEMA_VERSION,
      id,
      displayName: typeof raw.displayName === 'string' && raw.displayName.trim() !== '' ? raw.displayName.trim() : id,
      version: typeof raw.version === 'string' && raw.version.trim() !== '' ? raw.version.trim() : '1.0.0',
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      author: typeof raw.author === 'string' ? raw.author.trim() : '',
      homepage: typeof raw.homepage === 'string' ? raw.homepage.trim() : '',
      entry,
      aliases,
      tools,
      configSchema,
    },
  }
}

/**
 * Redact secret fields in provider config before sending state to the browser.
 */
export function maskProviderConfig(config, configSchema = []) {
  const secretKeys = new Set(
    (Array.isArray(configSchema) ? configSchema : [])
      .filter(field => field && field.secret === true)
      .map(field => field.key),
  )
  const out = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (secretKeys.has(key) && typeof value === 'string' && value !== '') {
      out[key] = value.length <= 6 ? '******' : `${value.slice(0, 2)}••••${value.slice(-2)}`
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Base class documenting the MemoryProvider lifecycle methods.
 * Custom plugins may extend this class or return any plain object implementing
 * the same methods.
 */
export class MemoryProvider {
  constructor(manifest, config = {}, host = {}) {
    this.manifest = manifest
    this.id = manifest.id
    this.displayName = manifest.displayName || manifest.id
    this.config = { ...config }
    this.host = host
  }

  /** Fast local readiness check (no heavy network blocking if avoidable). */
  async isAvailable() { return true }

  /** Detailed health probe for UI status badges & `memory.test`. */
  async health() {
    const ok = await this.isAvailable()
    return { ok, mode: this.id, detail: ok ? 'ready' : 'unavailable' }
  }

  /** Initialize connections, local DBs, or background loops once on activation. */
  async initialize(_context) {}

  /** Static system prompt block injected once per live Agent (prompt-cache friendly). */
  systemPromptBlock(_context) { return '' }

  /**
   * Recall relevant memory before a Bot turn.
   * @param {{ query: string, teamId: string, agentId: string, userId: string, sessionId: string, botName?: string }} ctx
   * @returns {Promise<{ text: string, count: number, source?: string } | string>}
   */
  async prefetch(_ctx) { return { text: '', count: 0 } }

  /**
   * Persist one completed turn asynchronously.
   * @param {{ userText: string, assistantText: string, teamId: string, agentId: string, userId: string, sessionId: string, source?: string, roomId?: string }} ctx
   */
  async syncTurn(_ctx) {}

  /** Explicit save hook (triggered by `memory_save` tool or mirroring `MEMORY.md`). */
  async saveMemory(_ctx) { return { ok: false, error: `${this.id} does not support explicit memory_save` } }

  /** Explicit search hook (triggered by `memory_search` tool & UI search test). */
  async searchMemory(_ctx) { return { ok: true, items: [], text: '' } }

  /** Conversation search hook (triggered by `memory_conversation_search`). */
  async searchConversations(_ctx) { return { ok: true, items: [], text: '' } }

  /** Scene listing/reading hook (triggered by `memory_read_scene`). */
  async readScene(_ctx) { return { ok: false, error: `${this.id} does not expose scene blocks` } }

  /** Hook fired before `/new` or `/reset` compacts a permanent Bot chat. */
  async onPreCompress(_ctx) { return '' }

  /** Hook fired at session boundaries. */
  async onSessionEnd(_ctx) {}

  /** Provider-specific tool schemas (optional; core registers unified memory tools). */
  getToolSchemas() { return [] }

  /** Dispatch a provider-specific tool call. */
  async handleToolCall(toolName, _args, _ctx) {
    return JSON.stringify({ error: `Provider "${this.id}" does not handle tool "${toolName}".` })
  }

  /** Release resources when switching providers or unloading the plugin. */
  async shutdown() {}
}
