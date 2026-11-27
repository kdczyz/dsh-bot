/**
 * Bot-Mode MCP Registry & Priority Coordinator (`$DSH_HOME/botmode/mcp.json`).
 *
 * Implements shared MCP availability across Bot Mode and normal DSH Mode with
 * mode-specific precedence:
 *   - Bot Mode:    Bot MCP (`$DSH_HOME/botmode/mcp.json`) > Normal DSH MCP (`ctx.mcpManager`)
 *   - Normal Mode: Normal DSH MCP (`ctx.mcpManager`)      > Bot MCP (`$DSH_HOME/botmode/mcp.json`)
 *
 * When a server in `$DSH_HOME/botmode/mcp.json` has no name collision in normal
 * `ctx.mcpManager`, it is shared via `ctx.mcpManager.register()` so both modes
 * can call its tools (`mcp__<server>__<tool>`). When a same-name server exists
 * in both configs, normal mode keeps its own configured server while Bot Mode
 * tracks the conflict and marks Bot MCP as preferred.
 */
import { access, readFile } from 'node:fs/promises'
import { writeTextFile } from './store.js'

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

export const defaultMcpConfig = () => ({
  version: 1,
  priority: {
    botMode: ['bot', 'normal'],
    normalMode: ['normal', 'bot'],
  },
  servers: {},
})

const normalizeStringRecord = (input) => {
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [k, v] of Object.entries(input)) {
    if (typeof k === 'string' && k !== '' && typeof v === 'string') out[k] = v
  }
  return out
}

export function normalizeMcpServerEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const enabled = raw.disabled !== undefined ? raw.disabled !== true : raw.enabled !== false
  const hasUrl = typeof raw.url === 'string' && raw.url.trim() !== ''
  const hasCmd = typeof raw.command === 'string' && raw.command.trim() !== ''
  const transport = raw.transport === 'streamable-http' || raw.type === 'streamable-http' || (!hasCmd && hasUrl)
    ? 'streamable-http'
    : 'stdio'

  if (transport === 'stdio') {
    if (!hasCmd) return undefined
    return {
      transport: 'stdio',
      command: raw.command.trim(),
      args: Array.isArray(raw.args) ? raw.args.map(a => String(a)) : [],
      env: normalizeStringRecord(raw.env),
      cwd: typeof raw.cwd === 'string' ? raw.cwd.trim() : '',
      enabled,
      ...(Number.isFinite(Number(raw.startupTimeoutMs)) ? { startupTimeoutMs: Number(raw.startupTimeoutMs) } : {}),
      ...(Number.isFinite(Number(raw.toolCallTimeoutMs)) ? { toolCallTimeoutMs: Number(raw.toolCallTimeoutMs) } : {}),
    }
  }
  if (!hasUrl) return undefined
  return {
    transport: 'streamable-http',
    url: raw.url.trim(),
    headers: normalizeStringRecord(raw.headers),
    enabled,
    ...(Number.isFinite(Number(raw.startupTimeoutMs)) ? { startupTimeoutMs: Number(raw.startupTimeoutMs) } : {}),
    ...(Number.isFinite(Number(raw.toolCallTimeoutMs)) ? { toolCallTimeoutMs: Number(raw.toolCallTimeoutMs) } : {}),
  }
}

export function normalizeMcpConfig(raw) {
  const base = defaultMcpConfig()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const sourceMap = (raw.servers && typeof raw.servers === 'object' && !Array.isArray(raw.servers))
    ? raw.servers
    : ((raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)) ? raw.mcpServers : {})
  const servers = {}
  for (const [name, entry] of Object.entries(sourceMap)) {
    if (!SERVER_NAME_RE.test(name)) continue
    const normalized = normalizeMcpServerEntry(entry)
    if (normalized) servers[name] = normalized
  }
  return {
    ...base,
    servers,
  }
}

export class BotMcpRegistry {
  #config = defaultMcpConfig()
  #disposers = new Map() // serverName -> disposer registered into ctx.mcpManager
  #shadowedByNormal = new Set() // server names where normal mode already configured same name

  constructor(ctx, store, logger) {
    this.ctx = ctx
    this.store = store
    this.logger = logger
  }

  get configPath() {
    return this.store.mcpConfigPath
  }

  get config() {
    return this.#config
  }

  async ensureConfigFile() {
    const path = this.configPath
    try {
      await access(path)
    } catch (_error) {
      await writeTextFile(path, `${JSON.stringify(defaultMcpConfig(), null, 2)}\n`)
    }
  }

  async load() {
    await this.ensureConfigFile()
    try {
      const raw = JSON.parse(await readFile(this.configPath, 'utf8'))
      this.#config = normalizeMcpConfig(raw)
    } catch (error) {
      this.logger?.warn?.(`botmode: failed to parse ${this.configPath}, using empty MCP config: ${String(error)}`)
      this.#config = defaultMcpConfig()
    }
    return this.#config
  }

  async save(nextConfig) {
    this.#config = normalizeMcpConfig(nextConfig)
    await writeTextFile(this.configPath, `${JSON.stringify(this.#config, null, 2)}\n`)
    this.syncToHostManager()
    return this.#config
  }

  async saveServer(serverName, rawEntry) {
    const name = String(serverName ?? '').trim()
    if (!SERVER_NAME_RE.test(name)) {
      throw new Error(`Invalid MCP server name "${name}" (must match ${String(SERVER_NAME_RE)}).`)
    }
    const normalized = normalizeMcpServerEntry(rawEntry)
    if (!normalized) {
      throw new Error('Invalid MCP server entry: stdio requires "command", streamable-http requires "url".')
    }
    const nextServers = {
      ...this.#config.servers,
      [name]: normalized,
    }
    await this.save({ ...this.#config, servers: nextServers })
    return { ok: true, name, entry: normalized }
  }

  async deleteServer(serverName) {
    const name = String(serverName ?? '').trim()
    if (!name) throw new Error('MCP server name is required.')
    const nextServers = { ...this.#config.servers }
    delete nextServers[name]
    await this.save({ ...this.#config, servers: nextServers })
    return { ok: true, deleted: name }
  }

  async toggleServer(serverName, enabled) {
    const name = String(serverName ?? '').trim()
    const current = this.#config.servers[name]
    if (!current) throw new Error(`Unknown Bot MCP server "${name}".`)
    return this.saveServer(name, { ...current, enabled: enabled === true, disabled: enabled !== true })
  }

  async probeServer(serverName) {
    const name = String(serverName ?? '').trim()
    const entry = this.#config.servers[name]
    const manager = this.ctx?.get?.('mcpManager')
    if (!entry) {
      if (manager && typeof manager.probe === 'function') {
        const result = await manager.probe(name)
        return { ok: true, tier: 'normal', name, result }
      }
      throw new Error(`Unknown MCP server "${name}".`)
    }
    if (!this.#shadowedByNormal.has(name) && manager && typeof manager.probe === 'function') {
      try {
        const result = await manager.probe(name)
        return { ok: true, tier: 'bot', name, result }
      } catch (error) {
        return { ok: false, tier: 'bot', name, error: error instanceof Error ? error.message : String(error) }
      }
    }
    // Attempt direct McpClient.probeServer if running inside DSH host; fallback to config validation.
    try {
      const McpClient = await import('@deepseek-ai/dsh-mcp-client')
      if (typeof McpClient?.probeServer === 'function' && typeof McpClient?.Config === 'function') {
        const clientCfg = this.#toClientConfig(McpClient, name, entry)
        const result = await McpClient.probeServer(this.ctx, clientCfg)
        return { ok: true, tier: 'bot', name, result }
      }
    } catch (error) {
      if (error && error.code !== 'ERR_MODULE_NOT_FOUND') {
        return { ok: false, tier: 'bot', name, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return {
      ok: true,
      tier: 'bot',
      name,
      detail: `Config validated (${entry.transport})`,
      result: { validated: true, transport: entry.transport, note: 'Config validated (live probe unavailable outside DSH host).' },
    }
  }

  #toClientConfig(McpClient, name, entry) {
    const shared = {
      serverName: name,
      failOnStartupError: false,
      expandTemplates: true,
      ...(entry.startupTimeoutMs ? { startupTimeoutMs: entry.startupTimeoutMs } : {}),
      ...(entry.toolCallTimeoutMs ? { toolCallTimeoutMs: entry.toolCallTimeoutMs } : {}),
    }
    if (entry.transport === 'stdio') {
      return McpClient.Config({
        transport: 'stdio',
        command: entry.command,
        args: [...(entry.args ?? [])],
        env: { ...(entry.env ?? {}) },
        cwd: entry.cwd ?? '',
        ...shared,
      })
    }
    return McpClient.Config({
      transport: 'streamable-http',
      url: entry.url,
      headers: { ...(entry.headers ?? {}) },
      ...shared,
    })
  }

  /**
   * For any enabled Bot MCP server that collides by name with a normal-mode MCP server
   * (`#shadowedByNormal`), mount a Bot-scoped `dsh-mcp-client` instance directly on
   * `agentCtx` so Bot Mode genuinely overrides the normal-mode server's tools & prompt section.
   */
  async mountBotOverrides(agentCtx, options = {}) {
    const conflicts = [...this.#shadowedByNormal].filter((name) => {
      const entry = this.#config.servers[name]
      return entry && entry.enabled !== false
    })
    if (conflicts.length === 0 || !agentCtx || typeof agentCtx.plugin !== 'function') {
      return { mounted: [], dispose: () => {} }
    }
    let McpClient = options.mcpClientModule ?? null
    if (!McpClient) {
      try {
        McpClient = await import('@deepseek-ai/dsh-mcp-client')
      } catch (_error) {
        return { mounted: [], dispose: () => {} }
      }
    }
    const handles = []
    const mounted = []
    for (const name of conflicts) {
      const entry = this.#config.servers[name]
      try {
        const cfg = typeof McpClient.Config === 'function'
          ? this.#toClientConfig(McpClient, name, entry)
          : { serverName: name, ...entry }
        const handle = agentCtx.plugin(McpClient, cfg)
        handles.push(handle)
        mounted.push(name)
      } catch (error) {
        this.logger?.warn?.(`botmode: scoped Bot MCP override for "${name}" failed: ${String(error)}`)
      }
    }
    const dispose = () => {
      for (const h of handles) {
        try { void h?.dispose?.() } catch (_error) { /* ignore */ }
      }
    }
    if (typeof agentCtx.effect === 'function' && handles.length > 0) {
      agentCtx.effect(() => dispose, 'botmode: scoped Bot MCP overrides')
    }
    return { mounted, dispose }
  }

  publicConfig() {
    const manager = this.ctx?.get?.('mcpManager')
    const hostList = manager && typeof manager.list === 'function' ? manager.list() : []
    const normalList = hostList.filter(item => item && item.name && !this.#disposers.has(item.name) && item.configured !== false)
    const normalNames = new Set(normalList.map(item => item.name))
    const botServers = Object.entries(this.#config.servers).map(([name, entry]) => ({
      name,
      transport: entry.transport,
      command: entry.command || '',
      args: Array.isArray(entry.args) ? entry.args : [],
      url: entry.url || '',
      enabled: entry.enabled !== false,
      disabled: entry.enabled === false,
      overridesNormal: normalNames.has(name) || this.#shadowedByNormal.has(name),
    }))
    const normalServers = normalList.map(item => ({
      name: item.name,
      transport: item.config?.url ? 'streamable-http' : (item.transport || 'stdio'),
      command: item.config?.command || '',
      url: item.config?.url || '',
      overriddenInBotMode: Boolean(this.#config.servers[item.name] && this.#config.servers[item.name].enabled !== false),
    }))
    return {
      configPath: this.configPath,
      priority: this.#config.priority,
      serversConfig: this.#config.servers,
      botServers,
      normalServers,
      servers: this.listForMode('bot'),
    }
  }

  /**
   * Share enabled Bot MCP servers with DSH's `ctx.mcpManager` at lower precedence
   * than normal-mode configured servers (normal mode wins on name collision).
   */
  syncToHostManager(manager = this.ctx?.get?.('mcpManager')) {
    if (!manager || typeof manager.register !== 'function') return
    const existingList = typeof manager.list === 'function' ? manager.list() : []
    const normalConfigured = new Set(
      existingList.filter(item => item && item.configured === true).map(item => item.name),
    )

    // Dispose removed or disabled registrations first.
    for (const [name, dispose] of [...this.#disposers.entries()]) {
      const entry = this.#config.servers[name]
      if (!entry || entry.enabled === false || normalConfigured.has(name)) {
        try { dispose() } catch (_error) { /* ignore */ }
        this.#disposers.delete(name)
      }
    }

    this.#shadowedByNormal.clear()
    for (const [name, entry] of Object.entries(this.#config.servers)) {
      if (entry.enabled === false) continue
      if (normalConfigured.has(name)) {
        this.#shadowedByNormal.add(name)
        continue
      }
      if (this.#disposers.has(name)) continue
      try {
        const dispose = manager.register(name, entry)
        if (typeof dispose === 'function') this.#disposers.set(name, dispose)
      } catch (error) {
        this.logger?.warn?.(`botmode: could not share Bot MCP server "${name}" with mcpManager: ${String(error)}`)
      }
    }
  }

  /**
   * Return the merged MCP server summary ordered by mode precedence.
   * @param {'bot'|'normal'} mode
   */
  listForMode(mode = 'bot') {
    const manager = this.ctx?.get?.('mcpManager')
    const hostList = manager && typeof manager.list === 'function' ? manager.list() : []
    const hostMap = new Map(hostList.map(item => [item.name, item]))

    const botEntries = Object.entries(this.#config.servers)
      .filter(([, entry]) => entry.enabled !== false)
      .map(([name, entry]) => ({
        name,
        tier: 'bot',
        transport: entry.transport,
        status: hostMap.get(name)?.status?.state ?? 'configured',
        shadowedInNormalMode: this.#shadowedByNormal.has(name),
      }))

    const botNames = new Set(botEntries.map(e => e.name))
    const normalEntries = hostList
      .filter(item => item && item.configured === true)
      .map(item => ({
        name: item.name,
        tier: 'normal',
        transport: 'managed',
        status: item.status?.state ?? 'unknown',
        overriddenInBotMode: botNames.has(item.name),
      }))

    if (mode === 'normal') {
      const seen = new Set()
      const merged = []
      for (const item of [...normalEntries, ...botEntries]) {
        if (seen.has(item.name)) continue
        seen.add(item.name)
        merged.push(item)
      }
      return merged
    }

    // Bot Mode: Bot MCP entries take top priority; normal-mode MCP entries follow.
    const seen = new Set()
    const merged = []
    for (const item of [...botEntries, ...normalEntries]) {
      if (seen.has(item.name)) continue
      seen.add(item.name)
      merged.push(item)
    }
    return merged
  }

  /**
   * Compact system-prompt index block pointing Bots to the MCP library & precedence rules.
   */
  systemPromptIndexBlock() {
    const servers = this.listForMode('bot')
    const botServers = servers.filter(s => s.tier === 'bot')
    const normalServers = servers.filter(s => s.tier === 'normal')
    const lines = [
      '## MCP Library & Priority',
      `- Bot MCP config: \`${this.configPath}\` (shared with normal DSH MCP; **Bot Mode precedence: Bot MCP > Normal DSH MCP**).`,
      '- Invoke MCP tools directly via `mcp__<server>__<tool>` and inspect MCP resources via `list_mcp_resources` / `read_mcp_resource`.',
    ]
    if (botServers.length > 0) {
      lines.push(`- Active Bot MCP servers (highest priority): ${botServers.map(s => `\`${s.name}\` (${s.status})`).join(', ')}.`)
    }
    if (normalServers.length > 0) {
      lines.push(`- Shared normal-mode MCP servers (secondary priority): ${normalServers.map(s => `\`${s.name}\` (${s.status})`).join(', ')}.`)
    }
    if (servers.length === 0) {
      lines.push('- No external MCP servers are configured yet; add entries to the Bot MCP config when external integrations are needed.')
    }
    return lines.join('\n')
  }

  dispose() {
    for (const dispose of this.#disposers.values()) {
      try { dispose() } catch (_error) { /* ignore */ }
    }
    this.#disposers.clear()
    this.#shadowedByNormal.clear()
  }
}
