/**
 * MemoryManager — Hermes-style global single-select Memory Hub for all Bots.
 *
 * Responsibilities:
 * 1. Discover bundled memory plugins (`host/memory/providers/<id>/`) plus
 *    user-installed plugins (`$DSH_HOME/botmode/memory-plugins/<id>/`).
 *    Bundled plugins take precedence over external ones by id (Hermes rule).
 * 2. Activate ONE global MemoryProvider shared by all Bots, scoping every read
 *    and write per Bot via `(teamId, agentId = bot.id, userId, sessionId)`.
 * 3. Drive lifecycle hooks: `initialize`, `systemPromptBlock`, `prefetch`,
 *    `syncTurn`, `onPreCompress`, `onSessionEnd`, `shutdown`.
 * 4. Hot-swap providers when the user switches, configures, installs or
 *    uninstalls a memory plugin.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  isTrivialPrompt,
  maskProviderConfig,
  normalizeProviderId,
  validatePluginManifest,
} from './protocol.js'
import { MEMORY_CATALOG } from './catalog.js'
import { MemoryPluginInstaller } from './installer.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLED_DIR = join(HERE, 'providers')

const readManifestFromDir = async (dir, bundled) => {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf8'))
    const checked = validatePluginManifest(raw)
    if (!checked.ok) return undefined
    let installMeta
    if (!bundled) {
      try {
        installMeta = JSON.parse(await readFile(join(dir, '.install.json'), 'utf8'))
      } catch (_error) {
        installMeta = undefined
      }
    }
    return {
      ...checked.manifest,
      bundled,
      dir,
      entryPath: resolve(dir, checked.manifest.entry),
      installedSource: installMeta?.source ?? '',
      installedAt: installMeta?.installedAt ?? '',
    }
  } catch (_error) {
    return undefined
  }
}

export class MemoryManager {
  #registry = new Map() // id -> descriptor
  #aliases = new Map() // alias -> canonical id
  #activeId = ''
  #activeProvider = null
  #lastHealth = null
  #lastRecallByBot = new Map()
  #initPromise = null
  #loadNonce = 0

  constructor(store, logger, options = {}) {
    this.store = store
    this.logger = logger
    this.bundledDir = options.bundledDir || BUNDLED_DIR
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.installer = new MemoryPluginInstaller(
      store.memoryPluginsRoot,
      new Set(['memory_tencentdb', 'local_sqlite', 'builtin']),
      logger,
    )
  }

  get activeId() { return this.#activeId }

  get activeProvider() { return this.#activeProvider }

  async #scanDir(rootDir, bundled) {
    const found = []
    let entries = []
    try {
      entries = await readdir(rootDir, { withFileTypes: true })
    } catch (_error) {
      return found
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue
      const descriptor = await readManifestFromDir(join(rootDir, entry.name), bundled)
      if (descriptor) found.push(descriptor)
    }
    return found
  }

  /** Re-discover all bundled and downloaded memory plugins. */
  async discover() {
    const bundled = await this.#scanDir(this.bundledDir, true)
    const external = await this.#scanDir(this.store.memoryPluginsRoot, false)
    const nextRegistry = new Map()
    const nextAliases = new Map()
    const bundledIds = new Set()

    for (const item of bundled) {
      nextRegistry.set(item.id, item)
      bundledIds.add(item.id)
      nextAliases.set(item.id, item.id)
      for (const alias of item.aliases) {
        if (!nextAliases.has(alias)) nextAliases.set(alias, item.id)
      }
    }
    for (const item of external) {
      if (nextRegistry.has(item.id)) continue // Bundled wins (Hermes precedence)
      nextRegistry.set(item.id, item)
      nextAliases.set(item.id, item.id)
      for (const alias of item.aliases) {
        if (!nextAliases.has(alias)) nextAliases.set(alias, item.id)
      }
    }

    this.#registry = nextRegistry
    this.#aliases = nextAliases
    this.installer.bundledIds = bundledIds
    return [...this.#registry.values()]
  }

  resolveId(name) {
    const key = normalizeProviderId(name)
    if (key === '') return 'memory_tencentdb'
    return this.#aliases.get(key) ?? (this.#registry.has(key) ? key : '')
  }

  /** Ensure discovery and active provider initialization have completed. */
  async ensureReady() {
    if (this.#activeProvider) return this.#activeProvider
    if (this.#initPromise) return this.#initPromise
    this.#initPromise = (async () => {
      await this.store.load()
      await this.discover()
      const desired = this.store.state.memory?.provider || 'memory_tencentdb'
      const resolved = this.resolveId(desired) || 'memory_tencentdb'
      await this.#activate(resolved)
      return this.#activeProvider
    })().finally(() => {
      this.#initPromise = null
    })
    return this.#initPromise
  }

  async #activate(providerId) {
    const descriptor = this.#registry.get(providerId)
    if (!descriptor) throw new Error(`Unknown memory provider "${providerId}".`)

    if (this.#activeProvider) {
      try { await this.#activeProvider.shutdown?.() } catch (_error) { /* best effort */ }
      this.#activeProvider = null
    }

    const config = this.#effectiveConfig(descriptor)
    const host = {
      logger: this.logger,
      dataRoot: this.store.memoryDataRoot,
      pluginsRoot: this.store.memoryPluginsRoot,
      fetchImpl: this.fetchImpl,
    }
    this.#loadNonce += 1
    const mod = await import(`${pathToFileURL(descriptor.entryPath).href}?v=${this.#loadNonce}`)
    const factory = mod.createProvider ?? mod.default
    if (typeof factory !== 'function') {
      throw new Error(`Memory plugin "${descriptor.id}" has no valid factory export.`)
    }
    const instance = factory.prototype && typeof factory.prototype.initialize === 'function'
      ? new factory(descriptor, config, host)
      : factory(descriptor, config, host)
    await instance.initialize?.({
      teamId: this.store.state.memory?.teamId || 'dsh-botmode',
      userId: this.store.state.memory?.userId || 'default',
    })
    this.#activeId = descriptor.id
    this.#activeProvider = instance
    this.#lastHealth = await this.#probeHealth(instance)
    return instance
  }

  #effectiveConfig(descriptor) {
    const defaults = {}
    for (const field of descriptor.configSchema ?? []) {
      if ('default' in field) defaults[field.key] = field.default
    }
    const stored = this.store.state.memory?.providersConfig?.[descriptor.id] ?? {}
    return { ...defaults, ...stored }
  }

  async #probeHealth(provider) {
    if (!provider) return { ok: false, mode: 'none', detail: 'No active memory provider' }
    try {
      const result = typeof provider.health === 'function'
        ? await provider.health()
        : { ok: await provider.isAvailable?.() !== false, mode: provider.id, detail: 'ready' }
      return { ...result, checkedAt: new Date().toISOString() }
    } catch (error) {
      return {
        ok: false,
        mode: 'error',
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      }
    }
  }

  async select(providerId) {
    await this.store.load()
    await this.discover()
    const resolved = this.resolveId(providerId)
    if (resolved === '') throw new Error(`Unknown memory provider "${providerId}".`)
    await this.store.mutate((state) => {
      state.memory.provider = resolved
    })
    await this.#activate(resolved)
    return this.status()
  }

  async configure(patch = {}) {
    await this.store.load()
    await this.discover()
    const targetId = patch.providerId ? this.resolveId(patch.providerId) : (this.#activeId || this.store.state.memory.provider)
    if (patch.providerId && targetId === '') {
      throw new Error(`Unknown memory provider "${patch.providerId}".`)
    }
    const descriptor = this.#registry.get(targetId)
    const secretKeys = new Set((descriptor?.configSchema ?? []).filter(f => f.secret).map(f => f.key))

    await this.store.mutate((state) => {
      if (typeof patch.teamId === 'string' && patch.teamId.trim() !== '') state.memory.teamId = patch.teamId.trim()
      if (typeof patch.userId === 'string' && patch.userId.trim() !== '') state.memory.userId = patch.userId.trim()
      if (typeof patch.prefetchEnabled === 'boolean') state.memory.prefetchEnabled = patch.prefetchEnabled
      if (typeof patch.syncEnabled === 'boolean') state.memory.syncEnabled = patch.syncEnabled
      if (typeof patch.syncGroupRooms === 'boolean') state.memory.syncGroupRooms = patch.syncGroupRooms
      if (patch.config && typeof patch.config === 'object' && targetId) {
        const prev = state.memory.providersConfig[targetId] ?? {}
        const next = { ...prev }
        for (const [key, value] of Object.entries(patch.config)) {
          // Skip masked placeholders returned by the UI so secrets aren't clobbered.
          if (secretKeys.has(key) && typeof value === 'string' && (value.includes('••••') || value === '******')) {
            continue
          }
          next[key] = value
        }
        state.memory.providersConfig[targetId] = next
      }
    })

    if (targetId === this.#activeId || !this.#activeProvider) {
      await this.#activate(this.resolveId(this.store.state.memory.provider) || 'memory_tencentdb')
    }
    return this.status()
  }

  async install(source, options = {}) {
    await this.store.load()
    await this.discover()
    const installed = await this.installer.install(source, options)
    await this.discover()
    if (options.activate === true) {
      await this.select(installed.id)
    }
    return {
      installed: {
        id: installed.id,
        displayName: installed.manifest.displayName,
        version: installed.manifest.version,
        dir: installed.dir,
      },
      memory: await this.status(),
    }
  }

  async uninstall(providerId) {
    await this.store.load()
    await this.discover()
    const id = this.resolveId(providerId) || normalizeProviderId(providerId)
    const wasActive = id === this.#activeId
    if (wasActive && this.#activeProvider) {
      await this.#activeProvider.shutdown?.().catch(() => undefined)
      this.#activeProvider = null
    }
    await this.installer.uninstall(id)
    await this.discover()
    if (wasActive) {
      await this.store.mutate((state) => {
        state.memory.provider = 'memory_tencentdb'
      })
      await this.#activate('memory_tencentdb')
    }
    return this.status()
  }

  async test(providerId = '') {
    await this.ensureReady()
    const target = providerId ? this.resolveId(providerId) : this.#activeId
    if (target === '') throw new Error(`Unknown memory provider "${providerId}".`)
    if (target === this.#activeId && this.#activeProvider) {
      this.#lastHealth = await this.#probeHealth(this.#activeProvider)
      return { providerId: target, health: this.#lastHealth }
    }
    // Non-active provider: instantiate temporarily to test health without changing active provider.
    const descriptor = this.#registry.get(target)
    const mod = await import(`${pathToFileURL(descriptor.entryPath).href}?test=${Date.now()}`)
    const factory = mod.createProvider ?? mod.default
    const temp = factory.prototype && typeof factory.prototype.initialize === 'function'
      ? new factory(descriptor, this.#effectiveConfig(descriptor), {
        logger: this.logger,
        dataRoot: this.store.memoryDataRoot,
        pluginsRoot: this.store.memoryPluginsRoot,
        fetchImpl: this.fetchImpl,
      })
      : factory(descriptor, this.#effectiveConfig(descriptor), {
        logger: this.logger,
        dataRoot: this.store.memoryDataRoot,
        pluginsRoot: this.store.memoryPluginsRoot,
        fetchImpl: this.fetchImpl,
      })
    try {
      await temp.initialize?.({})
      const health = await this.#probeHealth(temp)
      return { providerId: target, health }
    } finally {
      await temp.shutdown?.().catch(() => undefined)
    }
  }

  // -- Per-Bot lifecycle bridges ---------------------------------------------

  #scope(bot, extra = {}) {
    const cfg = this.store.state.memory ?? {}
    return {
      teamId: cfg.teamId || 'dsh-botmode',
      agentId: bot?.id || 'default',
      botName: bot?.name || '',
      botDir: bot?.dir || '',
      userId: cfg.userId || 'default',
      sessionId: extra.sessionId || bot?.sessionId || '',
      source: extra.source || 'chat',
      roomId: extra.roomId || '',
    }
  }

  systemPromptBlockForBot(bot) {
    if (!this.#activeProvider || typeof this.#activeProvider.systemPromptBlock !== 'function') return ''
    try {
      return String(this.#activeProvider.systemPromptBlock(this.#scope(bot)) ?? '').trim()
    } catch (_error) {
      return ''
    }
  }

  async prefetchForBot(bot, query, options = {}) {
    const cfg = this.store.state.memory
    if (!cfg || cfg.prefetchEnabled === false) return { text: '', count: 0 }
    if (isTrivialPrompt(query)) return { text: '', count: 0 }
    try {
      const provider = await this.ensureReady()
      if (!provider || typeof provider.prefetch !== 'function') return { text: '', count: 0 }
      const raw = await provider.prefetch({
        ...this.#scope(bot, options),
        query: String(query ?? ''),
      })
      const result = typeof raw === 'string'
        ? { text: raw, count: raw.trim() === '' ? 0 : 1, source: provider.id }
        : { text: String(raw?.text ?? ''), count: Number(raw?.count ?? 0), source: raw?.source || provider.id }
      if (bot?.id) {
        this.#lastRecallByBot.set(bot.id, {
          provider: provider.id,
          source: result.source,
          count: result.count,
          at: new Date().toISOString(),
        })
      }
      return result
    } catch (error) {
      this.logger?.warn?.(`botmode: memory prefetch for ${bot?.name ?? 'bot'} failed: ${String(error)}`)
      return { text: '', count: 0 }
    }
  }

  async syncTurnForBot(bot, userText, assistantText, options = {}) {
    const cfg = this.store.state.memory
    if (!cfg || cfg.syncEnabled === false) return
    if (options.roomId && cfg.syncGroupRooms !== true) return
    try {
      const provider = await this.ensureReady()
      if (!provider || typeof provider.syncTurn !== 'function') return
      await provider.syncTurn({
        ...this.#scope(bot, options),
        userText: String(userText ?? ''),
        assistantText: String(assistantText ?? ''),
      })
    } catch (error) {
      this.logger?.warn?.(`botmode: memory syncTurn for ${bot?.name ?? 'bot'} failed: ${String(error)}`)
    }
  }

  async onPreCompressForBot(bot, summary, options = {}) {
    try {
      const provider = await this.ensureReady()
      if (!provider || typeof provider.onPreCompress !== 'function') return ''
      return String(await provider.onPreCompress({
        ...this.#scope(bot, options),
        bot,
        summary: String(summary ?? ''),
      }) ?? '')
    } catch (error) {
      this.logger?.warn?.(`botmode: memory onPreCompress failed: ${String(error)}`)
      return ''
    }
  }

  async searchMemoryForBot(bot, { query, limit, typeFilter = '' }) {
    const provider = await this.ensureReady()
    if (!provider || typeof provider.searchMemory !== 'function') {
      return { ok: false, error: 'Active memory provider does not support search.', items: [] }
    }
    return provider.searchMemory({
      ...this.#scope(bot),
      query: String(query ?? ''),
      limit,
      typeFilter: String(typeFilter ?? ''),
    })
  }

  async searchConversationsForBot(bot, { query, limit, sessionId = '' }) {
    const provider = await this.ensureReady()
    if (!provider || typeof provider.searchConversations !== 'function') {
      return { ok: false, error: 'Active memory provider does not support conversation search.', items: [] }
    }
    return provider.searchConversations({
      ...this.#scope(bot, { sessionId }),
      query: String(query ?? ''),
      limit,
    })
  }

  async readSceneForBot(bot, { sceneId = '' }) {
    const provider = await this.ensureReady()
    if (!provider || typeof provider.readScene !== 'function') {
      return { ok: false, error: 'Active memory provider does not support scene blocks.' }
    }
    return provider.readScene({
      ...this.#scope(bot),
      sceneId: String(sceneId ?? ''),
    })
  }

  async saveMemoryForBot(bot, { content, type = 'fact', scene = '' }) {
    const provider = await this.ensureReady()
    if (!provider || typeof provider.saveMemory !== 'function') {
      return { ok: false, error: 'Active memory provider does not support explicit save.' }
    }
    return provider.saveMemory({
      ...this.#scope(bot),
      content: String(content ?? ''),
      type: String(type || 'fact'),
      scene: String(scene || ''),
    })
  }

  async purgeBot(botId) {
    if (!botId) return
    this.#lastRecallByBot.delete(botId)
    try {
      const provider = await this.ensureReady()
      if (provider && typeof provider.purgeAgent === 'function') {
        const cfg = this.store.state.memory ?? {}
        await provider.purgeAgent({
          teamId: cfg.teamId || 'dsh-botmode',
          agentId: botId,
        })
      }
    } catch (error) {
      this.logger?.warn?.(`botmode: memory purgeBot(${botId}) failed: ${String(error)}`)
    }
  }

  publicSummary() {
    const cfg = this.store.state.memory ?? {}
    const providers = [...this.#registry.values()].map(desc => ({
      id: desc.id,
      displayName: desc.displayName,
      version: desc.version,
      description: desc.description,
      author: desc.author,
      homepage: desc.homepage,
      bundled: desc.bundled,
      aliases: desc.aliases,
      tools: desc.tools,
      configSchema: desc.configSchema,
      config: maskProviderConfig(this.#effectiveConfig(desc), desc.configSchema),
      installedSource: desc.installedSource || '',
      installedAt: desc.installedAt || '',
      active: desc.id === this.#activeId,
    }))
    return {
      provider: this.#activeId || cfg.provider || 'memory_tencentdb',
      teamId: cfg.teamId || 'dsh-botmode',
      userId: cfg.userId || 'default',
      prefetchEnabled: cfg.prefetchEnabled !== false,
      syncEnabled: cfg.syncEnabled !== false,
      syncGroupRooms: cfg.syncGroupRooms === true,
      health: this.#lastHealth,
      pluginsRoot: this.store.memoryPluginsRoot,
      providers,
      catalog: MEMORY_CATALOG.map(entry => ({
        ...entry,
        installed: this.#registry.has(entry.id),
      })),
      recentRecall: Object.fromEntries(this.#lastRecallByBot),
    }
  }

  async status() {
    await this.ensureReady()
    this.#lastHealth = await this.#probeHealth(this.#activeProvider)
    return this.publicSummary()
  }

  async shutdown() {
    if (this.#activeProvider) {
      try { await this.#activeProvider.shutdown?.() } catch (_error) { /* ignore */ }
      this.#activeProvider = null
    }
  }
}
