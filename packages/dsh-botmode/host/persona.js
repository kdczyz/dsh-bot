/**
 * Bot identity files, zero-redundancy bootstrap memory, and the structured
 * system prompt block that links every Bot to its Memory Hub, Skills library,
 * and MCP library.
 *
 * Orthogonal three-tier architecture (zero duplication across layers):
 *   L1 · System Prompt (`personaBlock`) — static constitution, routing rules,
 *        precedence pointers to Skills & MCP libraries, and memory contract.
 *   L2 · Initial Memory (`MEMORY.md` + Memory Hub bootstrap seed) — physical
 *        library paths, compact capability dispatch index, and evolving dynamic
 *        slots (preferences, verified environment facts, lessons, active assets).
 *   L3 · Skills Library (`builtin-skills/` + `$DSH_HOME/botmode/skills/` +
 *        `<bot.dir>/.dsh/skills/` + shared normal skills) — detailed SOPs loaded
 *        on demand via `skill({ name })`.
 */
import { join } from 'node:path'
import { readTextFile, writeTextFile } from './store.js'
import { BUILTIN_SKILLS_ROOT } from './isolation.js'

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const LEGACY_MEMORY_MARKER = 'Durable notes this Bot keeps for itself. Edit this file when something must survive'

const sectionLine = (bot, state) => {
  const section = state.sections.find(item => item.id === bot.sectionId)
  return section ? (section.nameZh && section.nameZh !== '' ? section.nameZh : section.name) : 'General'
}

export const renderSoul = (bot, state) => [
  `# ${bot.name}`,
  '',
  bot.role ? `Role: ${bot.role}` : '',
  `Group: ${sectionLine(bot, state)}`,
  '',
  '## Standing instructions',
  '',
  bot.instructions || '(none yet)',
  '',
].filter(line => line !== undefined).join('\n')

export const renderTeam = (state) => {
  const rows = state.bots.map(bot => `- ${bot.name}${bot.role ? ` — ${bot.role}` : ''} (${sectionLine(bot, state)}, id: ${bot.id})`)
  return ['# Team', '', rows.length === 0 ? '- (no Bots yet)' : rows.join('\n'), ''].join('\n')
}

/**
 * Render the structured initial `MEMORY.md` for a Bot.
 * Stores ONLY runtime anchors, a compact capability dispatch index, and dynamic
 * operational slots — never duplicating static rules from the system prompt.
 */
export const renderInitialMemory = (bot, store) => {
  const botDir = bot?.dir || '(unassigned)'
  const sharedSkills = store?.skillsRoot || '$DSH_HOME/botmode/skills'
  const mcpPath = store?.mcpConfigPath || '$DSH_HOME/botmode/mcp.json'
  return [
    `# ${bot.name} — Operational Memory`,
    '',
    '## Bootstrap Anchors',
    `- Bot ID: \`${bot.id}\` | Role: ${bot.role || '(general)'}`,
    `- Workspace: \`${botDir}\``,
    `- Skills Library (Bot priority > Shared): \`${botDir}/.dsh/skills\` → \`${sharedSkills}\` → \`${BUILTIN_SKILLS_ROOT}\` → shared DSH/Agents skills`,
    `- MCP Library (Bot priority > Shared): \`${mcpPath}\` → shared DSH MCP servers`,
    '',
    '## Capability Dispatch Index (Load via `skill` or call MCP directly)',
    '| Domain | Primary Skill / Entry | Key Tools |',
    '|---|---|---|',
    '| Browser & Desktop Automation (L1→L4 circuit breaker + takeover) | `browser-desktop-automation` (+ shared `agent-browser` / `webapp-testing`) | `bash`, `screen_*`, `screen_request_help` |',
    '| Team Comms, Bot CRUD & Multi-Bot Group Rooms | `bot-team-control` | `bot_team`, `message_agent`, `bot_manage`, `room_manage` |',
    '| Group Room Task-Fit & Formal Completion | `team-collaboration`, `room-completion` | `claim_subtask`, `room_task_progress`, `room_finish_task` |',
    '| Persistent Automated Schedules | `scheduled-routines` | `scheduled_tasks` |',
    '| External Integrations (MCP) | Bot MCP library > shared DSH MCP | `mcp__<server>__<tool>`, `list_mcp_resources`, `read_mcp_resource` |',
    '| Long-Term Memory Recall & Persistence | Memory Hub + this file | `memory_search`, `memory_conversation_search`, `memory_read_scene`, `memory_save` |',
    '',
    '## Verified Environment & User Preferences',
    '- (Record durable user preferences and verified machine facts here; e.g. system Chrome `/usr/bin/google-chrome`, preferred output style.)',
    '',
    '## Operational Lessons & Active Assets',
    '- (Record failure workarounds, active `scheduled_tasks` IDs, and recurring Group Room IDs here. Do NOT copy static system-prompt rules.)',
    '',
  ].join('\n')
}

/**
 * Idempotently seed the Bot's Memory Hub (`scene: "bot-bootstrap"`) with a compact,
 * searchable capability & library index so `memory_search` / `memory_read_scene`
 * immediately connects to the Skills & MCP libraries without duplicating static rules.
 */
export const seedInitialMemoryHub = async (memory, store, bot) => {
  if (!memory || !bot || typeof memory.saveMemoryForBot !== 'function') return { ok: false, skipped: true }
  try {
    const existing = typeof memory.readSceneForBot === 'function'
      ? await memory.readSceneForBot(bot, { sceneId: 'bot-bootstrap' }).catch(() => null)
      : null
    if (existing?.ok && typeof existing.text === 'string' && existing.text.includes('bot-bootstrap-v1')) {
      return { ok: true, skipped: true }
    }
    const content = [
      '[bot-bootstrap-v1]',
      `Bot=${bot.name}(${bot.id}) Workspace=${bot.dir || ''}.`,
      `SkillsPriority: ${bot.dir ? `${bot.dir}/.dsh/skills` : '<bot>/.dsh/skills'} > ${store?.skillsRoot || '$DSH_HOME/botmode/skills'} > ${BUILTIN_SKILLS_ROOT} > shared normal skills.`,
      'BuiltinSkills: browser-desktop-automation (L1 CLI -> L2 agent-browser/OSS -> L3 screen_* -> L4 screen_request_help), bot-team-control (message_agent/bot_manage/room_manage), team-collaboration, room-completion, scheduled-routines (scheduled_tasks).',
      `MCPPriority: ${store?.mcpConfigPath || '$DSH_HOME/botmode/mcp.json'} > shared DSH MCP (invoke mcp__<server>__<tool> / list_mcp_resources).`,
    ].join(' ')
    return await memory.saveMemoryForBot(bot, {
      content,
      type: 'workflow',
      scene: 'bot-bootstrap',
    })
  } catch (_error) {
    return { ok: false, skipped: true }
  }
}

const readBuiltinSkill = async (skillName) => readTextFile(join(BUILTIN_SKILLS_ROOT, skillName, 'SKILL.md'), '')

export const renderTeamSkill = () => [
  '---',
  'name: team',
  'description: Alias pointer to bot-team-control & team-collaboration for teammate messaging, Bot CRUD, and Group Room coordination.',
  'whenToUse: When consulting teammates in 1:1 chats or coordinating inside Group Rooms.',
  '---',
  '',
  '# Team Communication Quick Pointer',
  '',
  '- For 1:1 messaging (`message_agent`), Bot roster CRUD (`bot_manage`), and creating/driving Group Rooms (`room_manage`), load `skill({ name: "bot-team-control" })`.',
  '- For Group Room Task-Fit evaluation and `@mention` hygiene, load `skill({ name: "team-collaboration" })`.',
  '- For multi-step Group Room milestone tracking and formal completion (`room_finish_task`), load `skill({ name: "room-completion" })`.',
  '',
].join('\n')

export const syncBotFiles = async (store, bot, state) => {
  await store.ensureBotDir(bot)
  const dir = bot.dir
  await writeTextFile(join(dir, 'bot.json'), `${JSON.stringify(bot, null, 2)}\n`)
  await writeTextFile(join(dir, 'SOUL.md'), renderSoul(bot, state))
  const memoryPath = join(dir, 'MEMORY.md')
  const memory = await readTextFile(memoryPath, '')
  const trimmed = memory.trim()
  if (trimmed === '' || trimmed.includes(LEGACY_MEMORY_MARKER)) {
    await writeTextFile(memoryPath, renderInitialMemory(bot, store))
  }
  // Keep local compatibility copies of core room skills synced from the single-source built-in library.
  const [collabSkill, completionSkill] = await Promise.all([
    readBuiltinSkill('team-collaboration'),
    readBuiltinSkill('room-completion'),
  ])
  if (collabSkill) {
    await writeTextFile(join(dir, '.dsh', 'skills', 'team-collaboration', 'SKILL.md'), collabSkill)
  }
  if (completionSkill) {
    await writeTextFile(join(dir, '.dsh', 'skills', 'room-completion', 'SKILL.md'), completionSkill)
  }
}

export const syncTeamFiles = async (store, state) => {
  await writeTextFile(join(store.botsRoot, 'TEAM.md'), renderTeam(state))
  await writeTextFile(join(store.botsRoot, 'roster.json'), `${JSON.stringify(state.bots.map(bot => ({
    id: bot.id,
    name: bot.name,
    role: bot.role,
    color: bot.color,
    avatar: bot.avatar,
    sectionId: bot.sectionId,
    sessionId: bot.sessionId,
    dir: bot.dir,
  })), null, 2)}\n`)
}

/**
 * Render the Bot Output Formatting Protocol block injected into Bot system prompts
 * based on modular toggles in `state.settings.responseFormat`.
 */
export const renderResponseFormatProtocol = (settings) => {
  const rf = settings?.responseFormat
  if (rf && rf.enabled === false) return ''
  const lines = [
    '## Response Format & Rich Media Protocol',
    '',
    'Write clear, scannable, human-facing replies. Do NOT dump raw tool logs or verbose chain-of-thought into the final reply text; present conclusions, structured data, and actionable outputs cleanly using these supported formats:',
  ]
  if (!rf || rf.extendedMarkdown !== false) {
    lines.push(
      '- **Extended Markdown**: Use GFM tables (`| Col |`) for comparisons; callouts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`) for alerts/risks; `<details><summary>Title</summary>...</details>` to fold long logs or appendix details; fenced ```` ```diff ```` blocks (`+` / `-`) to show code changes cleanly.',
    )
  }
  if (!rf || rf.diagramsAndMath !== false) {
    lines.push(
      '- **Diagrams & Math**: Use fenced ```` ```mermaid ```` blocks (`flowchart LR/TD`, `sequenceDiagram`, `stateDiagram-v2`) for workflows/architectures, and `$...$` / `$$...$$` for mathematical formulas.',
    )
  }
  if (!rf || rf.artifacts !== false) {
    lines.push(
      '- **Artifacts (Structured Preview Cards)**: For standalone deliverables (HTML preview, full source file, report, JSON config), wrap them in `<artifact type="code|html|markdown|json" title="Short Title">...</artifact>` so the UI renders a dedicated preview/download card instead of crowding the chat bubble.',
    )
  }
  if (!rf || rf.structuredCards !== false) {
    lines.push(
      '- **Structured UI Cards**: For KPI dashboards, server metrics, or generated files, you may emit fenced JSON blocks:',
      '  - ```` ```metrics ````: `{"title":"System Status","items":[{"label":"CPU","value":"34%","delta":"-4%","tone":"ok|warn|err"}]}`',
      '  - ```` ```file ````: `{"name":"report.csv","path":"/abs/or/rel/path","size":"24 KB","mime":"text/csv","description":"Summary"}`',
      '  - ```` ```card ````: `{"title":"Card Title","subtitle":"Optional","badge":"OK","fields":[{"label":"Key","value":"Value"}],"note":"Optional note"}`',
    )
  }
  if (!rf || rf.multimodal !== false) {
    lines.push(
      '- **Multimodal Outputs**: Reference generated images with standard Markdown `![alt](url-or-path)` and audio/video files with descriptive links so the UI embeds them inline.',
    )
  }
  return lines.join('\n')
}

export const personaBlock = async (store, bot, state, options = {}) => {
  const dir = bot.dir
  const soul = dir ? await readTextFile(join(dir, 'SOUL.md'), '') : ''
  const memory = dir ? await readTextFile(join(dir, 'MEMORY.md'), '') : ''
  const teammates = state.bots.filter(member => member.id !== bot.id)
  const roster = teammates.length === 0
    ? '(no other Bots yet)'
    : teammates.map(member => `- ${member.name}${member.role ? ` — ${member.role}` : ''} [id: ${member.id}]`).join('\n')
  const isRoomSession = options.kind === 'room'
  const memoryHubBlock = typeof options.memoryPromptBlock === 'string' ? options.memoryPromptBlock.trim() : ''
  const mcpPromptBlock = typeof options.mcpPromptBlock === 'string' ? options.mcpPromptBlock.trim() : ''
  const formatBlock = renderResponseFormatProtocol(state?.settings)
  const room = isRoomSession && options.roomId ? store.room(options.roomId) : undefined
  const effectiveWorkspace = (room?.workDir && room.workDir.trim() !== '')
    ? room.workDir.trim()
    : (bot.dir || '(unknown)')

  const executionProtocol = [
    '## Execution Protocol, Skills & Memory Contract',
    '',
    '1. **Assess → Recall → Load Skill → Execute → Persist**:',
    '   - Compare the request against your role and scope before acting.',
    '   - Check your operational memory (`MEMORY.md` below + `memory_search` / `memory_read_scene`) for prior context, user preferences, verified paths, or known pitfalls.',
    '   - When a task matches any skill in `<available_skills>` or the Capability Dispatch Index in your memory, call `skill({ name })` FIRST to load the authoritative SOP instead of guessing procedures.',
    '2. **Skills Library & Mode Precedence**:',
    `   - Resolution order in Bot Mode: \`${bot.dir ? `${bot.dir}/.dsh/skills` : '<bot>/.dsh/skills'}\` → \`${store?.skillsRoot || '$DSH_HOME/botmode/skills'}\` → \`${BUILTIN_SKILLS_ROOT}\` → shared normal-mode skills (e.g. \`agent-browser\`, \`webapp-testing\`).`,
    '   - Built-in Bot skills always outrank same-name normal-mode skills: `browser-desktop-automation` (progressive L1→L4 web/GUI automation & human takeover), `bot-team-control` (1:1 comms, Bot CRUD, Group Room creation), `team-collaboration`, `room-completion`, and `scheduled-routines` (persistent schedules via `scheduled_tasks`).',
    '3. **Memory Hygiene (Zero Redundancy)**:',
    '   - Persist only high-signal, evolving facts via `memory_save` or `MEMORY.md` (user preferences, verified environment facts, failure lessons, active routine/room IDs).',
    '   - NEVER copy static system-prompt rules or full `SKILL.md` texts into memory.',
    '4. **Safety & Human Takeover Boundary**:',
    '   - Never fabricate tool outputs or claim a teammate completed work without observed evidence.',
    '   - On hard GUI/web blockers (real CAPTCHA, QR/SMS/MFA login, real payment, irreversible authorization, or 3 consecutive GUI failures), stop guessing and escalate via `screen_request_help` per `browser-desktop-automation`.',
  ]

  const rules = isRoomSession
    ? [
      `- **Isolated Group Room Session**: You are ${bot.name}; active working directory is \`${effectiveWorkspace}\`. Never leak private 1:1 chats here.`,
      '- **No `message_agent` in Rooms**: Coordinate strictly inside the room. Follow `team-collaboration` (Task-Fit first, match user scope, bare `@Name` ONLY as an intentional wake-up signal, plain name or `` `@Name` `` for passive references, `(pass)` when nothing new to add).',
      '- **Concurrency & Completion**: Lock shared target paths with `claim_subtask` before concurrent edits (release with `status: "completed"`). On multi-step tasks, follow `room-completion` (`room_task_progress` + `room_finish_task`).',
    ]
    : [
      `- **Permanent 1:1 Session**: This chat never resets; your workspace is \`${bot.dir || '(unknown)'}\`.`,
      '- **Team & Automation**: Use `bot-team-control` (`message_agent` / `bot_manage` / `room_manage`) for delegation, scaling Bots, or creating Group Rooms; use `scheduled-routines` (`scheduled_tasks`) for recurring or delayed jobs.',
      '- **Virtual Screen**: You own a dedicated 1280×720 Linux virtual desktop (`screen_*`). Load `browser-desktop-automation` before non-trivial web or GUI automation.',
    ]

  return [
    soul.trim() || `# ${bot.name}\n\n${bot.role || ''}\n\n${bot.instructions || ''}`,
    '',
    '## Team Roster',
    '',
    roster,
    '',
    ...executionProtocol,
    '',
    ...(mcpPromptBlock !== '' ? [mcpPromptBlock, ''] : []),
    '## Session Rules',
    '',
    ...rules,
    formatBlock !== '' ? `\n${formatBlock}` : '',
    memoryHubBlock !== '' ? `\n${memoryHubBlock}` : '',
    memory.trim() !== '' ? `\n## Your Operational Memory (MEMORY.md)\n\n${memory.trim()}` : '',
    '',
  ].join('\n')
}

export const botBrief = (bot) => `${bot.name}${bot.role ? ` — ${oneLine(bot.role)}` : ''}`
