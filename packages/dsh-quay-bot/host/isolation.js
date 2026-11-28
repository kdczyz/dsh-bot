/**
 * Isolation & Priority Boundary between Bot Mode and normal DSH Mode.
 *
 * Enforces five boundaries without mutating DSH host files:
 *   1. Prompt isolation      — strips normal-mode/third-party prompt sections
 *                              (`dsh-purge*`, `prompt-inject.md`, `ui:deliverable-file-references`,
 *                              `harness-dev-context`, `web-surface`, etc.), suppresses
 *                              `globalThis.__dshPurgeHungPrompt` ONLY during Bot steps via
 *                              `AsyncLocalStorage`, and drops normal-mode `agent-instructions`.
 *   2. Tool isolation        — Bot-only tools are registered strictly in each Bot's scoped
 *                              `agent.ctx` (never leaked into global `ctx.tools`), while
 *                              normal-mode-only non-MCP tools are denied in Bot sessions.
 *   3. Shared Skills with    — Bot Mode and normal DSH Mode share skills with reversed precedence:
 *      Mode Priority           • Bot Mode:    Bot local > Bot shared > Bot built-in > Normal skills
 *                              • Normal Mode: Normal skills > Bot shared > Bot built-in (rank 900)
 *   4. Shared MCP with       — Bot Mode and normal DSH Mode share MCP servers & tools with
 *      Mode Priority           reversed precedence:
 *                              • Bot Mode:    Bot MCP (`$DSH_HOME/botmode/mcp.json`) > Normal MCP
 *                              • Normal Mode: Normal MCP > Bot MCP
 *   5. Session/UI isolation  — Bot sessions and Bot directories are filtered out of normal-mode
 *                              `sessionController.list`, `sessionController.search`, and
 *                              `workspaceRegistry` so Bot chats never appear in the normal sidebar.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Packaged Bot Mode built-in skills library (`packages/dsh-botmode/builtin-skills`). */
export const BUILTIN_SKILLS_ROOT = resolve(HERE, '..', 'builtin-skills')
export const BOTMODE_NORMAL_SKILL_PROVIDER = 'botmode-skills'
/** Lower priority than DSH bundled skills (600) so normal-mode skills ALWAYS win in normal mode. */
export const BOTMODE_NORMAL_SKILL_RANK = 900

const botStepStorage = new AsyncLocalStorage()

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_GESTURE_RE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * Non-MCP tools that belong exclusively to normal DSH Mode (or normal-mode plugins)
 * and must NEVER be visible or callable inside Bot sessions.
 * Note: MCP tools (`mcp__*`) and MCP resource tools are intentionally shared across modes.
 */
export const NORMAL_MODE_ONLY_TOOLS = new Set([
  // Normal-mode dsh-purge community plugin
  'purge_apply',
  'purge_revert',
  'purge_status',
  // Normal-mode plugin manager / deliverable presenter / subagent & team orchestration
  'plugin_manager',
  'present',
  'subagent',
  'subagent_fork',
  'workflow',
  'send_message',
  'list_agents',
  'wait_agent',
  'create_worktree',
  'list_subagent_models',
])

/**
 * Base host tool prompt sections allowed inside Bot sessions ONLY when the
 * corresponding tool is actually active for that Bot.
 */
const ALLOWED_BASE_TOOL_SECTIONS = new Map([
  ['tool:bash', 'bash'],
  ['tool:pwsh', 'pwsh'],
  ['tool:read', 'read'],
  ['tool:write', 'write'],
  ['tool:edit', 'edit'],
  ['tool:apply_patch', 'apply_patch'],
  ['tool:glob', 'glob'],
  ['tool:grep', 'grep'],
  ['tool:jobs', 'job_list'],
  ['tool:web_search', 'web_search'],
  ['tool:web_fetch', 'web_fetch'],
  ['tool:goal', 'create_goal'],
  ['tool:schedule', 'schedule_create'],
  ['context:file-reference', null],
])

/**
 * Runtime context entries allowed inside Bot sessions.
 * Normal-mode UI / source-checkout contexts (`harness:source`, `web:surface`, etc.)
 * are excluded by omission.
 */
const ALLOWED_BOT_CONTEXT_PREFIXES = [
  'working-directory',
  'working_directory',
  'approval',
  'sandbox',
  'time',
  'botmode:',
]

/** Path normalization helper for reliable boundary checks. */
const normPath = (value) => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  try {
    return resolve(trimmed)
  } catch (_error) {
    return trimmed
  }
}

const isSameOrSubpath = (parentDir, candidatePath) => {
  const parent = normPath(parentDir)
  const target = normPath(candidatePath)
  if (!parent || !target) return false
  if (parent === target) return true
  const rel = relative(parent, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Return true when `candidatePath` belongs to Bot Mode (current bot dirs,
 * `$DSH_HOME/botmode/...`, or legacy `$DSH_HOME/bot/DSH-Bots/...`).
 */
export function isBotManagedPath(store, candidatePath) {
  const target = normPath(candidatePath)
  if (!target) return false
  if (store?.root && isSameOrSubpath(store.root, target)) return true
  const dshHome = store?.root ? dirname(normPath(store.root)) : ''
  if (dshHome) {
    if (isSameOrSubpath(join(dshHome, 'bot', 'DSH-Bots'), target)) return true
  }
  const normalizedSlashes = target.replaceAll('\\', '/')
  if (/\/\.dsh\/botmode(\/|$)/.test(normalizedSlashes)) return true
  if (/\/\.dsh\/bot\/DSH-Bots(\/|$)/.test(normalizedSlashes)) return true
  const bots = Array.isArray(store?.state?.bots) ? store.state.bots : []
  for (const bot of bots) {
    if (bot?.dir && isSameOrSubpath(bot.dir, target)) return true
  }
  return false
}

/**
 * Return true when a session (identified by `sessionId` and/or `cwd`) belongs to Bot Mode.
 */
export function isBotSession(store, sessionId, cwd = '') {
  if (typeof sessionId === 'string' && sessionId !== '') {
    if (store?.botByAnySession?.(sessionId)) return true
    if (store?.allBotSessionIds?.().has(sessionId)) return true
  }
  if (cwd && isBotManagedPath(store, cwd)) return true
  return false
}

/**
 * True when a tool belongs exclusively to normal DSH Mode and must NOT be exposed in Bot Mode.
 * MCP tools (`mcp__*`) and MCP resource tools are intentionally shared across both modes
 * (with Bot MCP prioritized in Bot Mode and normal MCP prioritized in normal mode).
 */
export function isNormalModeOnlyTool(toolName) {
  const name = String(toolName ?? '').trim()
  if (name === '') return false
  return NORMAL_MODE_ONLY_TOOLS.has(name)
}

/**
 * True when a system prompt section is allowed inside a Bot session.
 * Uses a strict allowlist so normal-mode / third-party prompt sections
 * (`dsh-purge*`, `deployment:persona-*`, `ui:deliverable-file-references`,
 * `harness-dev-context`, `web-surface`, etc.) can never leak in, while shared
 * MCP sections (`mcp:*`, `mcp-resource-servers`) are admitted.
 */
export function isAllowedBotPromptSection(section, activeToolNames = null) {
  if (!section || typeof section !== 'object') return false
  const name = String(section.name ?? '').trim()
  const text = typeof section.text === 'string' ? section.text : ''
  // Hard content guard against known normal-mode override blocks even if renamed.
  if (text.includes('<dsh_boost') || text.includes('## Capability selection by task (mandatory)')) {
    return false
  }
  if (name.startsWith('botmode:')) return true
  if (name === 'mcp-resource-servers' || name.startsWith('mcp:')) return true
  if (!ALLOWED_BASE_TOOL_SECTIONS.has(name)) return false
  const requiredTool = ALLOWED_BASE_TOOL_SECTIONS.get(name)
  if (requiredTool === null) return true
  if (activeToolNames && activeToolNames.size > 0) {
    return activeToolNames.has(requiredTool)
  }
  return true
}

/**
 * True when a dynamic runtime context entry is allowed inside a Bot session.
 */
export function isAllowedBotPromptContext(entry) {
  if (!entry || typeof entry !== 'object') return false
  const name = String(entry.name ?? '').trim().toLowerCase()
  if (name === '') return false
  if (name.includes('harness') || name.includes('web-surface') || name.includes('web:surface') || name.includes('purge')) {
    return false
  }
  return ALLOWED_BOT_CONTEXT_PREFIXES.some(prefix => name === prefix || name.startsWith(prefix))
}

/**
 * Sanitize an assembled `{ sections, contexts, tools, variables }` object for a Bot session.
 * Strips all normal-mode prompt sections, normal-mode contexts, and normal-mode / normal-MCP tools.
 */
export function sanitizeBotAssembly(assembly, options = {}) {
  if (!assembly || typeof assembly !== 'object') return assembly
  const allowedBotMcpTools = options.allowedBotMcpTools instanceof Set ? options.allowedBotMcpTools : null
  const rawTools = Array.isArray(assembly.tools) ? assembly.tools : []
  const tools = rawTools.filter(tool => tool && !isNormalModeOnlyTool(tool.name, allowedBotMcpTools))
  const activeToolNames = new Set(tools.map(tool => String(tool.name ?? '')).filter(Boolean))

  const rawSections = Array.isArray(assembly.sections) ? assembly.sections : []
  const sections = rawSections.filter(section => isAllowedBotPromptSection(section, activeToolNames))

  const rawContexts = Array.isArray(assembly.contexts) ? assembly.contexts : []
  const contexts = rawContexts.filter(entry => isAllowedBotPromptContext(entry))

  return {
    ...assembly,
    sections,
    contexts,
    ...(Array.isArray(assembly.tools) ? { tools } : {}),
  }
}

/**
 * Run `fn` inside a Bot step execution context so `globalThis.__dshPurgeHungPrompt`
 * returns `""` for this Bot step without affecting concurrent normal-mode steps.
 */
export function runInBotStep(fn) {
  return botStepStorage.run(true, fn)
}

export function isInsideBotStep() {
  return botStepStorage.getStore() === true
}

/**
 * Transparently guard `globalThis.__dshPurgeHungPrompt` (patched into `dsh-agent-loop`
 * by `dsh-purge-community`) so it returns `""` during Bot steps while behaving 100%
 * identically for normal-mode sessions. Safe against later reassignments by `dsh-purge`.
 */
export function installPurgeHungGuard(target = globalThis) {
  const existingDesc = Object.getOwnPropertyDescriptor(target, '__dshPurgeHungPrompt')
  if (existingDesc && existingDesc.configurable === false) {
    return () => {}
  }
  let underlying = existingDesc && 'value' in existingDesc
    ? existingDesc.value
    : (existingDesc && typeof existingDesc.get === 'function' ? existingDesc.get() : undefined)

  const wrappedGetter = () => {
    if (typeof underlying !== 'function') return underlying
    return function botmodeGuardedPurgeHungPrompt(...args) {
      if (botStepStorage.getStore() === true) return ''
      return underlying.apply(this, args)
    }
  }

  Object.defineProperty(target, '__dshPurgeHungPrompt', {
    configurable: true,
    enumerable: existingDesc ? existingDesc.enumerable : true,
    get: wrappedGetter,
    set(nextVal) {
      underlying = nextVal
    },
  })

  return () => {
    try {
      if (existingDesc) {
        Object.defineProperty(target, '__dshPurgeHungPrompt', {
          ...existingDesc,
          ...('value' in existingDesc ? { value: underlying } : {}),
        })
      } else if (underlying === undefined) {
        delete target.__dshPurgeHungPrompt
      } else {
        Object.defineProperty(target, '__dshPurgeHungPrompt', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: underlying,
        })
      }
    } catch (_error) { /* best effort restore */ }
  }
}

const wrappedStepAgents = new WeakSet()

/**
 * Wrap a single Bot Agent instance's `step(decision)` so that:
 *   1. `decision.assembly` is sanitized AFTER every `system-prompt/assemble` hook and
 *      monkey-patched `systemPrompt.assemble()` wrapper (e.g. `dsh-purge` assemble guard).
 *   2. Execution runs inside `botStepStorage` so `globalThis.__dshPurgeHungPrompt()`
 *      is suppressed exclusively for this Bot step.
 * Normal-mode Agents are never touched.
 */
export function wrapBotAgentStep(agent, options = {}) {
  if (!agent || typeof agent.step !== 'function' || wrappedStepAgents.has(agent)) return () => {}
  wrappedStepAgents.add(agent)
  const originalStep = agent.step
  const wrapped = function botmodeIsolatedStep(decision, ...rest) {
    const cleanDecision = decision && typeof decision === 'object' && decision.assembly
      ? { ...decision, assembly: sanitizeBotAssembly(decision.assembly, options) }
      : decision
    return botStepStorage.run(true, () => originalStep.call(this, cleanDecision, ...rest))
  }
  agent.step = wrapped
  return () => {
    if (agent.step === wrapped) {
      delete agent.step
      if (agent.step !== originalStep) agent.step = originalStep
    }
    wrappedStepAgents.delete(agent)
  }
}

// ============================================================================
// Bot-Mode Isolated Skills Engine
// ============================================================================

const escapeAttr = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')

const escapeText = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')

/**
 * Minimal, zero-dependency YAML frontmatter parser for Bot `SKILL.md` files.
 * Supports flat keys (`name`, `description`, `whenToUse`, `user-invocable`,
 * `disable-model-invocation`) and folded/quoted strings.
 */
export function parseSkillFrontmatter(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  const endIdx = text.indexOf('\n---', 4)
  if (endIdx < 0) return null
  const afterClose = text.slice(endIdx + 4)
  if (afterClose !== '' && !afterClose.startsWith('\n')) return null
  const header = text.slice(4, endIdx)
  const body = afterClose.replace(/^\n/, '').trim()
  const data = {}
  const lines = header.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].trim()
    let val = match[2].trim()
    if (val === '|' || val === '>') {
      const block = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i += 1
        block.push(lines[i].replace(/^\s{1,2}/, ''))
      }
      val = (val === '>' ? block.join(' ') : block.join('\n')).trim()
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
      val = val.slice(1, -1)
    }
    data[key] = val
  }
  return { data, body }
}

const parseBool = (value, fallback) => {
  if (typeof value === 'boolean') return value
  const lower = String(value ?? '').trim().toLowerCase()
  if (lower === 'true' || lower === 'yes' || lower === '1') return true
  if (lower === 'false' || lower === 'no' || lower === '0') return false
  return fallback
}

async function parseBotSkillFile(filePath, source, directory) {
  let content
  try {
    const real = await realpath(filePath)
    content = await readFile(real, 'utf8')
  } catch (_error) {
    return undefined
  }
  const parsed = parseSkillFrontmatter(content)
  if (!parsed) return undefined
  const name = String(parsed.data.name ?? '').trim()
  const description = String(parsed.data.description ?? '').trim()
  if (!name || !description || !SKILL_NAME_RE.test(name)) return undefined
  const whenToUse = typeof parsed.data.whenToUse === 'string' && parsed.data.whenToUse.trim() !== ''
    ? parsed.data.whenToUse.trim()
    : undefined
  const modelInvocable = !parseBool(parsed.data['disable-model-invocation'], false)
  const userInvocable = parseBool(parsed.data['user-invocable'], true)
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    invocation: { modelInvocable, userInvocable },
    source,
    provider: 'botmode',
    resourceBase: { kind: 'directory', path: directory },
    path: filePath,
    content: parsed.body,
  }
}

async function scanBotSkillDir(rootDir, source) {
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch (_error) {
    return []
  }
  const results = []
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(rootDir, entry.name)
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const info = await stat(full)
        isDir = info.isDirectory()
        isFile = info.isFile()
      } catch (_error) {
        continue
      }
    }
    let skill
    if (isDir) {
      skill = await parseBotSkillFile(join(full, 'SKILL.md'), source, full)
    } else if (isFile && entry.name.endsWith('.md')) {
      skill = await parseBotSkillFile(full, source, rootDir)
    }
    if (skill) results.push(skill)
  }
  return results
}

function resolveNormalSkillRoots(store, options = {}) {
  const dshHome = typeof options.dshHome === 'string' && options.dshHome.trim() !== ''
    ? options.dshHome.trim()
    : (store?.root ? dirname(normPath(store.root)) : (process.env.DSH_HOME || join(homedir(), '.dsh')))
  const agentsHome = typeof options.agentsHome === 'string' && options.agentsHome.trim() !== ''
    ? options.agentsHome.trim()
    : (process.env.AGENTS_HOME || join(homedir(), '.agents'))
  return [
    { path: join(dshHome, 'skills'), source: 'normal-dsh', tier: 'normal', rank: 400 },
    { path: join(agentsHome, 'skills'), source: 'normal-agents', tier: 'normal', rank: 500 },
  ]
}

/**
 * Return the ordered list of skill directories visible in Bot Mode (highest precedence first):
 *   1. Bot-local skills (`<bot.dir>/.dsh/skills`, `<bot.dir>/skills`) — rank 10..15
 *   2. Bot Mode shared library (`$DSH_HOME/botmode/skills`)           — rank 20
 *   3. Bot Mode built-in library (`packages/dsh-botmode/builtin-skills`) — rank 30
 *   4. Normal DSH / Agents shared skills (`$DSH_HOME/skills`, `~/.agents/skills`) — rank 400..500
 */
export function botSkillRoots(store, bot, options = {}) {
  const roots = []
  if (bot?.dir) {
    roots.push({ path: join(bot.dir, '.dsh', 'skills'), source: 'bot-local', tier: 'bot', rank: 10 })
    roots.push({ path: join(bot.dir, 'skills'), source: 'bot-local', tier: 'bot', rank: 15 })
  }
  if (store?.skillsRoot) {
    roots.push({ path: store.skillsRoot, source: 'botmode-shared', tier: 'bot', rank: 20 })
  }
  roots.push({ path: BUILTIN_SKILLS_ROOT, source: 'botmode-builtin', tier: 'bot', rank: 30 })
  if (options.includeNormalSkills !== false) {
    roots.push(...resolveNormalSkillRoots(store, options))
  }
  return roots
}

/**
 * Discover all skills visible in Bot Mode with strict precedence:
 *   Bot skills (local > shared > built-in) ALWAYS override same-name normal-mode skills,
 *   while non-conflicting normal-mode skills (filesystem + host `ctx.skills` such as office/dsh-doc)
 *   remain shared and callable at lower priority.
 *
 * Per-Bot disabled skills (`bot.disabledSkills`) are excluded by default so the model
 * never sees or calls them; pass `{ includeDisabled: true }` (e.g. for Settings UI)
 * to include them with `enabled: false`.
 */
export async function discoverBotSkills(store, bot, options = {}) {
  const latestBot = (bot?.id && store?.bot?.(bot.id)) ? store.bot(bot.id) : bot
  const disabledSet = new Set(Array.isArray(latestBot?.disabledSkills) ? latestBot.disabledSkills : [])
  const includeDisabled = options.includeDisabled === true
  const roots = botSkillRoots(store, latestBot, options)
  const seen = new Map()
  for (const root of roots) {
    const items = await scanBotSkillDir(root.path, root.source)
    for (const item of items) {
      if (!seen.has(item.name)) {
        const enabled = !disabledSet.has(item.name)
        seen.set(item.name, {
          ...item,
          tier: root.tier,
          rank: root.rank,
          enabled,
          editable: root.source === 'bot-local' || root.source === 'botmode-shared',
        })
      }
    }
  }
  // Merge non-filesystem normal-mode skills (e.g. dsh-skill-office, preset bundled skills)
  // at lowest priority in Bot Mode, skipping our own provider to prevent recursion.
  const hostSkills = options.hostSkills
  if (options.includeNormalSkills !== false && hostSkills && typeof hostSkills.list === 'function') {
    try {
      const listed = await hostSkills.list({ cwd: latestBot?.dir, scope: options.agent })
      for (const summary of listed || []) {
        if (!summary || !summary.name || summary.provider === BOTMODE_NORMAL_SKILL_PROVIDER) continue
        if (seen.has(summary.name)) continue
        const enabled = !disabledSet.has(summary.name)
        seen.set(summary.name, {
          name: summary.name,
          description: summary.description,
          ...(summary.whenToUse ? { whenToUse: summary.whenToUse } : {}),
          invocation: summary.invocation ?? { modelInvocable: true, userInvocable: true },
          source: summary.source || 'normal-host',
          provider: summary.provider || 'host',
          ...(summary.resourceBase ? { resourceBase: summary.resourceBase } : {}),
          ...(summary.path ? { path: summary.path } : {}),
          tier: 'normal',
          rank: 600,
          enabled,
          editable: false,
          _fromHostRegistry: true,
        })
      }
    } catch (_error) { /* best effort normal-skill merge */ }
  }
  return [...seen.values()]
    .filter(item => includeDisabled || item.enabled !== false)
    .sort((a, b) => {
      const tierDiff = (a.tier === 'bot' ? 0 : 1) - (b.tier === 'bot' ? 0 : 1)
      if (tierDiff !== 0) return tierDiff
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
}

export async function loadBotSkill(store, bot, skillName, options = {}) {
  if (!SKILL_NAME_RE.test(String(skillName ?? ''))) return undefined
  const latestBot = (bot?.id && store?.bot?.(bot.id)) ? store.bot(bot.id) : bot
  const disabledSet = new Set(Array.isArray(latestBot?.disabledSkills) ? latestBot.disabledSkills : [])
  if (options.includeDisabled !== true && disabledSet.has(skillName)) return undefined
  const all = await discoverBotSkills(store, latestBot, options)
  const found = all.find(item => item.name === skillName)
  if (!found) return undefined
  if (found._fromHostRegistry && options.hostSkills && typeof options.hostSkills.get === 'function') {
    const loaded = await options.hostSkills.get(skillName, { cwd: latestBot?.dir, scope: options.agent })
    if (!loaded) return undefined
    return {
      ...loaded,
      tier: 'normal',
      rank: 600,
      enabled: !disabledSet.has(skillName),
    }
  }
  return found
}

/**
 * Read the raw `SKILL.md` file contents (including frontmatter) for Settings UI editing.
 */
export async function readBotSkillRaw(store, bot, skillName, options = {}) {
  const name = String(skillName ?? '').trim()
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `Invalid skill name "${name}"` }
  const found = await loadBotSkill(store, bot, name, { ...options, includeDisabled: true })
  if (!found) return { ok: false, error: `Skill "${name}" not found` }
  let raw = ''
  if (found.path) {
    try {
      raw = await readFile(found.path, 'utf8')
    } catch (_error) { /* fallback to reconstructed markdown below */ }
  }
  if (!raw) {
    raw = [
      '---',
      `name: ${found.name}`,
      `description: ${found.description || ''}`,
      ...(found.whenToUse ? [`whenToUse: ${found.whenToUse}`] : []),
      '---',
      '',
      found.content || '',
      '',
    ].join('\n')
  }
  return {
    ok: true,
    skill: {
      name: found.name,
      description: found.description,
      source: found.source,
      tier: found.tier,
      enabled: found.enabled !== false,
      editable: found.editable === true,
      path: found.path || '',
      raw,
    },
  }
}

/**
 * Create or update a custom Bot skill in either:
 *   - `scope: 'shared'` → `$DSH_HOME/botmode/skills/<name>/SKILL.md`
 *   - `scope: 'bot'`    → `<bot.dir>/.dsh/skills/<name>/SKILL.md`
 * Built-in skills inside the package are never mutated.
 */
export async function saveBotSkillFile(store, bot, { scope = 'shared', name, content }) {
  const cleanName = String(name ?? '').trim()
  if (!SKILL_NAME_RE.test(cleanName)) {
    return { ok: false, error: 'Skill name must be lowercase kebab-case (e.g. "my-workflow").' }
  }
  const raw = String(content ?? '').replace(/\r\n/g, '\n').trim()
  if (!raw) return { ok: false, error: 'SKILL.md content cannot be empty.' }
  const parsed = parseSkillFrontmatter(raw)
  if (!parsed) {
    return { ok: false, error: 'SKILL.md must begin with valid YAML frontmatter (--- ... ---).' }
  }
  const fmName = String(parsed.data.name ?? '').trim()
  const fmDesc = String(parsed.data.description ?? '').trim()
  if (fmName !== cleanName) {
    return { ok: false, error: `Frontmatter name ("${fmName}") must match skill name ("${cleanName}").` }
  }
  if (!fmDesc) {
    return { ok: false, error: 'Frontmatter must include a non-empty description.' }
  }
  const baseRoot = scope === 'bot'
    ? (bot?.dir ? join(bot.dir, '.dsh', 'skills') : '')
    : (store?.skillsRoot || '')
  if (!baseRoot) return { ok: false, error: scope === 'bot' ? 'Target Bot workspace is unavailable.' : 'Shared skills directory is unavailable.' }
  const skillDir = resolve(baseRoot, cleanName)
  if (!isSameOrSubpath(baseRoot, skillDir) || normPath(skillDir) === normPath(baseRoot) || isSameOrSubpath(BUILTIN_SKILLS_ROOT, skillDir)) {
    return { ok: false, error: 'Invalid target skill directory.' }
  }
  await mkdir(skillDir, { recursive: true })
  const filePath = join(skillDir, 'SKILL.md')
  await writeFile(filePath, `${raw}\n`, 'utf8')
  return { ok: true, name: cleanName, scope, path: filePath }
}

/**
 * Delete a custom Bot skill from `$DSH_HOME/botmode/skills/<name>` or `<bot.dir>/.dsh/skills/<name>`.
 * Built-in packaged skills (`BUILTIN_SKILLS_ROOT`) and normal-mode skills are protected.
 */
export async function deleteBotSkillFile(store, bot, { scope = 'shared', name }) {
  const cleanName = String(name ?? '').trim()
  if (!SKILL_NAME_RE.test(cleanName)) {
    return { ok: false, error: 'Invalid skill name.' }
  }
  const baseRoot = scope === 'bot'
    ? (bot?.dir ? join(bot.dir, '.dsh', 'skills') : '')
    : (store?.skillsRoot || '')
  if (!baseRoot) return { ok: false, error: 'Skill storage root is unavailable.' }
  const skillDir = resolve(baseRoot, cleanName)
  if (!isSameOrSubpath(baseRoot, skillDir) || normPath(skillDir) === normPath(baseRoot) || isSameOrSubpath(BUILTIN_SKILLS_ROOT, skillDir)) {
    return { ok: false, error: 'Refused to delete protected skill path.' }
  }
  await rm(skillDir, { recursive: true, force: true })
  return { ok: true, name: cleanName, scope }
}

/**
 * Register Bot Mode's shared + built-in skill libraries into DSH's global `ctx.skills`
 * at `BOTMODE_NORMAL_SKILL_RANK` (900 — lower priority than every normal-mode skill),
 * so normal mode can also use Bot skills while normal-mode skills always win on name collision.
 */
export function registerBotSkillsForNormalMode(ctx, store) {
  const skills = ctx?.get?.('skills') ?? ctx?.skills
  if (!skills || typeof skills.registerProvider !== 'function') return () => {}
  return skills.registerProvider(() => ({
    name: BOTMODE_NORMAL_SKILL_PROVIDER,
    async list() {
      const roots = [
        ...(store?.skillsRoot ? [{ path: store.skillsRoot, source: 'botmode-shared', rank: BOTMODE_NORMAL_SKILL_RANK }] : []),
        { path: BUILTIN_SKILLS_ROOT, source: 'botmode-builtin', rank: BOTMODE_NORMAL_SKILL_RANK + 10 },
      ]
      const seen = new Set()
      const candidates = []
      for (const root of roots) {
        const items = await scanBotSkillDir(root.path, root.source)
        for (const item of items) {
          if (seen.has(item.name)) continue
          seen.add(item.name)
          candidates.push({
            name: item.name,
            description: item.description,
            ...(item.whenToUse ? { whenToUse: item.whenToUse } : {}),
            invocation: item.invocation,
            provider: BOTMODE_NORMAL_SKILL_PROVIDER,
            source: root.source,
            rank: root.rank,
            locator: item,
            resourceBase: item.resourceBase,
            path: item.path,
          })
        }
      }
      return candidates
    },
    async get(candidate) {
      const item = candidate?.locator
      if (!item) return undefined
      return {
        name: item.name,
        description: item.description,
        ...(item.whenToUse ? { whenToUse: item.whenToUse } : {}),
        invocation: item.invocation,
        source: item.source,
        provider: BOTMODE_NORMAL_SKILL_PROVIDER,
        resourceBase: item.resourceBase,
        path: item.path,
        content: item.content,
      }
    },
  }))
}

export function renderBotSkillContent(skill) {
  const basePath = skill?.resourceBase?.path || ''
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...(basePath
      ? [
        `Base directory for this skill: ${escapeText(basePath)}`,
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      ]
      : ['Resources for this skill are managed by Bot Mode. Load referenced resources only as needed.']),
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

const catalogDigest = (entries) => {
  const canonical = entries.map(e => JSON.stringify([e.name, e.description])).join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

const trimDesc = (value, max = 500) => {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`
}

export function renderBotSkillCatalogMessage(entries, isUpdate = false) {
  const lines = entries.map((entry) => {
    const badge = entry.tier === 'bot' ? '[bot-priority]' : '[shared]'
    return `- \`${entry.name}\` ${badge}: ${escapeText(entry.description)}`
  })
  const text = [
    '<system-reminder>',
    isUpdate
      ? 'The available skill catalog changed (Bot Mode precedence: Bot skills > shared normal-mode skills). This complete catalog replaces every earlier available-skills list in this session:'
      : 'A skill is a reusable set of task-specific instructions. The following skills are available in this Bot session (Bot Mode precedence: `[bot-priority]` > `[shared]`):',
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    entries.length === 0
      ? 'No skills are currently available through the `skill` tool.'
      : 'If the user names a skill, or the task clearly matches a skill\'s description, call the `skill` tool with the exact skill name before taking task actions. Prefer `[bot-priority]` skills over `[shared]` ones when both apply.',
    '</system-reminder>',
  ].join('\n')
  return {
    id: `botmode-skill-catalog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'botmode-skill-catalog',
      form: 'catalog',
      entries,
      digest: catalogDigest(entries),
      ...(isUpdate ? { update: true } : {}),
    },
  }
}

function extractUserSkillGestures(messages) {
  const names = []
  for (const msg of messages || []) {
    if (msg?.source?.kind !== 'user') continue
    for (const block of msg.content || []) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      for (const match of block.text.matchAll(SKILL_GESTURE_RE)) {
        const name = match[2]
        if (name && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}

function lastPublishedBotSkillCatalogDigest(agent) {
  try {
    const events = agent?.session?.ownEvents?.()
    if (!Array.isArray(events)) return { published: false, digest: '' }
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev?.type === 'user/message' && ev?.data?.source?.kind === 'botmode-skill-catalog') {
        const src = ev.data.source
        return {
          published: true,
          digest: typeof src.digest === 'string'
            ? src.digest
            : (Array.isArray(src.entries) ? catalogDigest(src.entries) : ''),
        }
      }
    }
  } catch (_error) { /* ignore */ }
  return { published: false, digest: '' }
}

/**
 * Filter normal-mode pre-step message injections (`agent-instructions`, normal `skill-catalog`,
 * normal `skill-invocation`, `dsh-purge*`) and append Bot-priority merged skill catalog & `/skill` invocations.
 */
export async function isolateBotPreStepMessages({
  store,
  bot,
  agent,
  hostSkills = null,
  incomingMessages,
  decisionMessages,
  skillOptions = {},
}) {
  const blockedKinds = new Set([
    'agent-instructions',
    'skill-catalog',
    'skill-invocation',
    'dsh-purge',
    'dsh-purge-inject',
  ])
  const cleaned = (Array.isArray(decisionMessages) ? decisionMessages : []).filter((msg) => {
    const kind = String(msg?.source?.kind ?? '')
    if (blockedKinds.has(kind)) return false
    if (kind.startsWith('dsh-purge')) return false
    return true
  })

  const lookupOpts = { ...skillOptions, hostSkills, agent }
  const skills = await discoverBotSkills(store, bot, lookupOpts)
  const modelSkills = skills.filter(sk => sk.invocation?.modelInvocable !== false)
  const entries = modelSkills.map(sk => ({
    name: sk.name,
    description: trimDesc(sk.description),
    tier: sk.tier === 'bot' ? 'bot' : 'normal',
  }))
  const digest = catalogDigest(entries)
  const prev = lastPublishedBotSkillCatalogDigest(agent)

  const additions = []
  if (entries.length > 0 && prev.digest !== digest) {
    additions.push(renderBotSkillCatalogMessage(entries, prev.published))
  }

  // Handle explicit `/skill-name` user gestures with Bot > Normal precedence.
  const gestures = extractUserSkillGestures(incomingMessages)
  for (const name of gestures) {
    const skill = await loadBotSkill(store, bot, name, lookupOpts)
    if (!skill || skill.invocation?.userInvocable === false) continue
    additions.push({
      id: `botmode-skill-invoke-${name}-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: renderBotSkillContent(skill) }],
      source: { kind: 'botmode-skill-invocation', name, form: 'instructions' },
    })
  }

  return [...cleaned, ...additions]
}

/**
 * Build the scoped `skill` tool definition registered on each Bot's `agent.ctx`.
 * Registering a scoped tool named `"skill"` shadows DSH's default `dsh-tool-skill`
 * so Bot Mode controls exact resolution priority:
 *   Bot local > Bot shared > Bot built-in > Shared normal-mode skills.
 */
export function createBotScopedSkillTool(store, bot, options = {}) {
  return {
    name: 'skill',
    description: 'Load the full instructions for a skill (Bot Mode precedence: Bot skills > shared normal-mode skills). Call before acting on a matching task.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name from the available skills list.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          provider: { type: 'string' },
          resourceBase: { type: 'object' },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderBotSkillContent(value) }],
    },
    async execute(args, exec) {
      const name = String(args?.name ?? '').trim()
      if (!SKILL_NAME_RE.test(name)) {
        throw new Error(`invalid skill name "${name}"`)
      }
      const skill = await loadBotSkill(store, bot, name, {
        ...options,
        agent: exec?.agent ?? options.agent,
      })
      if (!skill) {
        throw new Error(`Skill "${name}" is unknown or unavailable`)
      }
      if (skill.invocation?.modelInvocable === false) {
        throw new Error(`Skill "${name}" is not available for model invocation`)
      }
      return {
        name: skill.name,
        provider: skill.provider || 'botmode',
        ...(skill.resourceBase ? { resourceBase: { ...skill.resourceBase } } : {}),
        content: skill.content,
      }
    },
  }
}

// ============================================================================
// Host-Side Session & Workspace Sidebar Isolation
// ============================================================================

/**
 * Ensure Bot sessions and Bot workspaces never leak into normal-mode sidebar lists,
 * workspace lists, or normal-mode session search.
 */
export function installSessionAndWorkspaceIsolation(ctx, store, readyPromise, logger) {
  const disposers = []

  // 1. Filter normal-mode `sessionController.list` and `sessionController.search`.
  const wrapSessionController = (controller) => {
    if (!controller || controller.__botmodeIsolated) return
    controller.__botmodeIsolated = true
    const origList = typeof controller.list === 'function' ? controller.list.bind(controller) : null
    const origSearch = typeof controller.search === 'function' ? controller.search.bind(controller) : null

    if (origList) {
      controller.list = async function botmodeFilteredList(request, signal) {
        await readyPromise?.catch?.(() => undefined)
        const res = await origList(request, signal)
        if (!res || !Array.isArray(res.items)) return res
        const items = res.items.filter(item => !isBotSession(store, item?.sessionId, item?.cwd))
        return items.length === res.items.length ? res : { ...res, items }
      }
    }
    if (origSearch) {
      controller.search = async function botmodeFilteredSearch(request, signal) {
        await readyPromise?.catch?.(() => undefined)
        const res = await origSearch(request, signal)
        if (!res || !Array.isArray(res.items)) return res
        const items = res.items.filter(item => !isBotSession(store, item?.sessionId, item?.cwd))
        return items.length === res.items.length ? res : { ...res, items }
      }
    }

    disposers.push(() => {
      try {
        if (origList) controller.list = origList
        if (origSearch) controller.search = origSearch
        delete controller.__botmodeIsolated
      } catch (_error) { /* ignore */ }
    })
  }

  // 2. Purge Bot directories from normal-mode `workspaceRegistry` and detach any Bot
  //    session IDs that were attached to a normal project workspace (e.g. Room `workDir`).
  const pruneBotWorkspaces = async (registry) => {
    if (!registry || typeof registry.list !== 'function') return
    await readyPromise?.catch?.(() => undefined)
    try {
      const workspaces = registry.list()
      for (const ws of workspaces) {
        if (!ws) continue
        if (ws.path && isBotManagedPath(store, ws.path)) {
          if (typeof registry.delete === 'function') {
            await Promise.resolve(registry.delete(ws.id)).catch(() => undefined)
          }
          continue
        }
        const sids = Array.isArray(ws.sessionIds) ? [...ws.sessionIds] : []
        for (const sid of sids) {
          if (isBotSession(store, sid, '') && typeof ws.detachSession === 'function') {
            await Promise.resolve(ws.detachSession(sid)).catch(() => undefined)
          }
        }
      }
    } catch (error) {
      logger?.warn?.(`botmode: workspace isolation prune warning: ${String(error)}`)
    }
  }

  // 3. Also wrap `workspaceController` snapshot/list if present so Bot entries never stream to normal sidebar.
  const wrapWorkspaceRegistry = (registry) => {
    if (!registry || registry.__botmodeIsolated) return
    registry.__botmodeIsolated = true
    const origList = typeof registry.list === 'function' ? registry.list.bind(registry) : null
    if (origList) {
      registry.list = function botmodeFilteredWorkspaces(...args) {
        const rows = origList(...args)
        if (!Array.isArray(rows)) return rows
        return rows.filter(ws => !(ws?.path && isBotManagedPath(store, ws.path)))
      }
    }
    void pruneBotWorkspaces({ list: origList || (() => []), delete: registry.delete?.bind(registry) })
    disposers.push(() => {
      try {
        if (origList) registry.list = origList
        delete registry.__botmodeIsolated
      } catch (_error) { /* ignore */ }
    })
  }

  const sc = ctx.get?.('sessionController')
  if (sc) wrapSessionController(sc)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionController'], (scope) => {
      wrapSessionController(scope.sessionController)
    })
    ctx.inject(['workspaceRegistry'], (scope) => {
      wrapWorkspaceRegistry(scope.workspaceRegistry)
    })
  } else {
    const wr = ctx.get?.('workspaceRegistry')
    if (wr) wrapWorkspaceRegistry(wr)
  }

  return () => {
    for (const off of disposers.splice(0)) {
      try { off() } catch (_error) { /* ignore */ }
    }
  }
}

export { lstat }
