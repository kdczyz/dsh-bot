/**
 * Bot identity files and the prompt block a Bot sees about itself and its team.
 *
 * Every Bot owns one directory:
 *   bot.json    machine-readable record (mirrors the roster document)
 *   SOUL.md     persona, role and standing instructions for people and the model
 *   MEMORY.md   durable notes the Bot writes for itself
 *   TEAM.md     the roster view used by the Bot's chat
 *   .dsh/skills/team/SKILL.md   how to reach teammates with `message_agent`
 */
import { join } from 'node:path'
import { readTextFile, writeTextFile } from './store.js'

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const sectionLine = (bot, state) => {
  const section = state.sections.find(item => item.id === bot.sectionId)
  return section ? (section.nameZh && section.nameZh !== '' ? section.nameZh : section.name) : 'General'
}

export const renderSoul = (bot, state) => {
  const teammates = state.bots.filter(member => member.id !== bot.id)
  const roster = teammates.length === 0
    ? '- (no other Bots yet)'
    : teammates.map(member => `- ${member.name}${member.role ? ` — ${member.role}` : ''} (id: ${member.id})`).join('\n')
  return [
    `# ${bot.name}`,
    '',
    bot.role ? `Role: ${bot.role}` : '',
    `Group: ${sectionLine(bot, state)}`,
    '',
    '## Standing instructions',
    '',
    bot.instructions || '(none yet)',
    '',
    '## Team',
    '',
    'You are one Bot in a team. Every Bot has its own workspace, its own memory scope',
    'and its own permanent chat. Talk to teammates with the `message_agent` tool:',
    '',
    '- `message_agent` target `<name or id>`, message `...` posts an asynchronous message',
    '  into that Bot\'s permanent chat. It returns `dispatched` at once; the reply arrives',
    '  later in your chat when you asked for it with `expectReply`.',
    '- `bot_team` lists the roster, your own id and the Group Rooms you belong to.',
    '- `memory_search`, `memory_conversation_search`, `memory_read_scene` and `memory_save`',
    '  access the team Memory Hub scoped to your own Bot identity.',
    '',
    'Rules:',
    '- Never claim a teammate did something you did not see in your chat.',
    '- One message per request; do not ping-pong a teammate endlessly (a hop guard applies).',
    '- Inside a Group Room you run in an isolated room session and cannot use `message_agent`;',
    '  answer in the room with @Name to hand off, or reply `(pass)` when you have nothing new to add.',
    '',
    '## Teammates',
    '',
    roster,
    '',
  ].filter(line => line !== undefined).join('\n')
}

export const renderTeam = (state) => {
  const rows = state.bots.map(bot => `- ${bot.name}${bot.role ? ` — ${bot.role}` : ''} (${sectionLine(bot, state)}, id: ${bot.id})`)
  return ['# Team', '', rows.length === 0 ? '- (no Bots yet)' : rows.join('\n'), ''].join('\n')
}

export const renderTeamSkill = () => [
  '---',
  'name: team',
  'description: Assess task fit against your own role first, collaborate with teammates via @mentions in Group Rooms or message_agent in 1:1 chats, list the roster, and search team memory.',
  'whenToUse: Before starting any task in a team or Group Room — evaluate whether the request fits your role, and only hand off or pull in another Bot when it belongs to their specialty.',
  '---',
  '',
  '# Team Communication & Task-Fit Skill',
  '',
  '## 1. Analyze Task Fit Before Acting (Mandatory First Step)',
  'Before running heavy commands or drafting long plans, compare the user\'s request against your own role (`SOUL.md`) and the team roster (`bot_team`):',
  '- **Fits your role fully**: Execute and answer cleanly on your own. Do NOT drag unrelated teammates into the thread.',
  '- **Partially fits your role**: Complete the part inside your domain, then explicitly invoke `@TeammateName` (in Group Rooms) or `message_agent` (in 1:1 chats) to ask the right specialist to analyze or handle the remaining part.',
  '- **Does NOT fit your role**:',
  '  - In a Group Room when the user did **not** directly `@mention` you: reply `(pass)` so the right specialist takes over without noise.',
  '  - In a Group Room when the user **directly `@mentioned` you**: do NOT reply `(pass)`; briefly explain why another Bot is better suited and explicitly `@TeammateName` to collaborate or hand off.',
  '  - In 1:1 chat: call `message_agent` to consult or delegate to the right specialist with full self-contained context.',
  '',
  '## 2. 1:1 Chat Tools (`message_agent` / `bot_team`)',
  '1. `bot_team` action="roster" — inspect who is on the team and what each Bot owns.',
  '2. `message_agent` target="<name or id>" message="..." — asynchronous delivery into that Bot\'s permanent chat.',
  '3. `message_agent` with `expectReply: true` — wait asynchronously for the teammate\'s reply in your chat.',
  '4. `memory_search` / `memory_save` — recall or store long-term memories scoped to your Bot.',
  '',
  '## 3. Group Room `@mention` Discipline (Hermes Bot Mode)',
  '- Inside a Group Room, **never** call `message_agent`; coordinate directly in the room.',
  '- Writing `@TeammateName` in normal prose is an **active wake-up signal** that schedules another LLM turn for that Bot.',
  '- ONLY write bare `@TeammateName` when you genuinely need that teammate to analyze, verify, or execute next.',
  '- When merely describing role boundaries, ownership tables (`| ... |`), self-introductions, or items waiting for human approval, write plain names or backticked `` `@Name` `` — NEVER bare `@Name`!',
  '- Match the user\'s scope: for simple questions or self-introductions, answer concisely and let the room settle via `(pass)`.',
  '',
].join('\n')

export const renderTeamCollaborationSkill = () => [
  '---',
  'name: team-collaboration',
  'description: Hermes-style Group Room collaboration protocol: evaluate task-fit first, use @mentions strictly for intentional handoffs/joint analysis when a task does not fit your role, and prevent runaway ping-pong loops.',
  'whenToUse: Every time you receive a message or task inside a Group Room before deciding whether to execute, hand off via @mention, or reply (pass).',
  '---',
  '',
  '# Group Room Task-Fit & `@mention` Collaboration Skill',
  '',
  'Follow this 3-step decision flow on every Group Room turn:',
  '',
  '## Step 1: Task-Fit Self-Assessment (先评估是否适合自己做)',
  'Check the user\'s request against your role, permissions, and workspace:',
  '1. **Core fit (我最合适)**: Execute directly with concise evidence and deliver the answer. Do not wake teammates unnecessarily.',
  '2. **Cross-domain fit (需要联合分析)**: Complete your own domain\'s facts/checks first, then explicitly write `@SpecialistName` in prose with the exact question or handoff they need to analyze.',
  '3. **Out of domain (不适合我做)**:',
  '   - If the user did **not** address you directly: reply with exactly `(pass)` so the right specialist answers cleanly.',
  '   - If the user **explicitly `@mentioned` you**: explain in 1–2 sentences why it falls outside your domain and immediately `@SpecialistName` to bring the right Bot into the discussion.',
  '',
  '## Step 2: Scope Guard (严控问题边界，避免小题大做)',
  '- If the user asks a simple question, greeting, status recap, or self-introduction (e.g. "介绍一下自己", "你们聊了什么"): answer **only** what was asked.',
  '- Do **NOT** launch unrequested multi-round audits or create a heavy `room_task_progress` checklist for simple Q&A.',
  '',
  '## Step 3: Strict Hermes Opt-In `@mention` Hygiene (防互相 `@` 死循环)',
  '- In Hermes Bot Mode, Round 1+ is strictly **opt-in**: only Bots explicitly `@mentioned` in prose are woken for the next turn.',
  '- Never put bare `@TeammateName` inside self-introductions, role-division tables, or "waiting for human approval" summaries unless you actually want that Bot to run another turn right now. Use plain names or `` `@TeammateName` `` for passive references.',
  '- Once your part is answered and no teammate action is required, end without `@mentions` (or reply `(pass)` on subsequent follow-ups) so the room converges naturally.',
  '',
].join('\n')

export const renderRoomCompletionSkill = () => [
  '---',
  'name: room-completion',
  'description: Evaluate Group Room task progress autonomously on multi-step tasks, keep teammates collaborating until verified and merged, and call room_finish_task to terminate the room once done.',
  'whenToUse: Inside a Group Room on substantive multi-Bot engineering/ops tasks when tracking progress, consolidating deliverables, or deciding whether the group has completed the user goal.',
  '---',
  '',
  '# Group Room Autonomous Progress & Completion Skill',
  '',
  'Follow this protocol on **multi-step collaborative tasks** (for simple Q&A or self-introductions, just answer concisely and let the room settle naturally without creating heavy checklists):',
  '',
  '## 1. Track Progress on Multi-Step Tasks (`room_task_progress`)',
  '- On complex multi-Bot tasks, call `room_task_progress({ action: "update", goal, items: [{ id, title, owner, done, note }] })` to maintain a shared checklist of every deliverable required by the user.',
  '- Call `room_task_progress({ action: "get" })` before closing to confirm zero open items remain.',
  '',
  '## 2. Keep Teammates Moving — Never Prematurely `@user`',
  '- While teammates still have genuine cross-checks, table merges, or unresolved subtasks, **address only the needed specialist with `@TeammateName`** and **do NOT write `@user` in the same message**.',
  '- Only write `@user` alone (with zero teammate mentions) if the entire team is genuinely blocked on an irreversible decision or missing credential that cannot be resolved internally.',
  '- If the user asked to "inspect / analyze / compile a plan for my review", delivering the **single merged, deduplicated final plan** IS completing the task — do NOT pause halfway after each Bot posts its separate draft!',
  '',
  '## 3. Formal Completion Gate (`room_finish_task`)',
  'Check these 4 conditions before closing a multi-step task:',
  '1. Every requirement in the user\'s request has been fulfilled and cross-checked across teammates.',
  '2. Overlapping or fragmented teammate outputs have been merged into one clear, final summary/deliverable.',
  '3. All active `room_task_progress` checklist items and `claim_subtask` items are marked done/completed.',
  '4. No teammate is still actively executing a blocking step.',
  '',
  'Once all 4 conditions hold:',
  '- Post the crisp consolidated final summary (if not already posted), and **immediately call `room_finish_task({ summary, deliverables, verification })`**.',
  '- Calling `room_finish_task` is the **ONLY** way to formally terminate the Group Room in `completed` state; never rely on writing "task completed" in plain text.',
  '- If you are not the Lead Bot in a Lead-assigned room, mark your subtask done and `@LeadName` to run final acceptance and invoke `room_finish_task`.',
  '',
].join('\n')

export const syncBotFiles = async (store, bot, state) => {
  await store.ensureBotDir(bot)
  const dir = bot.dir
  await writeTextFile(join(dir, 'bot.json'), `${JSON.stringify(bot, null, 2)}\n`)
  await writeTextFile(join(dir, 'SOUL.md'), renderSoul(bot, state))
  const memoryPath = join(dir, 'MEMORY.md')
  const memory = await readTextFile(memoryPath, '')
  if (memory === '') {
    await writeTextFile(memoryPath, [
      `# ${bot.name} — memory`,
      '',
      'Durable notes this Bot keeps for itself. Edit this file when something must survive',
      'the current chat.',
      '',
    ].join('\n'))
  }
  await writeTextFile(join(dir, '.dsh', 'skills', 'team', 'SKILL.md'), renderTeamSkill())
  await writeTextFile(join(dir, '.dsh', 'skills', 'team-collaboration', 'SKILL.md'), renderTeamCollaborationSkill())
  await writeTextFile(join(dir, '.dsh', 'skills', 'room-completion', 'SKILL.md'), renderRoomCompletionSkill())
}

export const syncTeamFiles = async (store, state) => {
  await writeTextFile(join(store.botsRoot, 'TEAM.md'), renderTeam(state))
  await writeTextFile(join(store.botsRoot, 'roster.json'), `${JSON.stringify(state.bots.map(bot => ({
    id: bot.id,
    name: bot.name,
    role: bot.role,
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
  const formatBlock = renderResponseFormatProtocol(state?.settings)
  const room = isRoomSession && options.roomId ? store.room(options.roomId) : undefined
  const effectiveWorkspace = (room?.workDir && room.workDir.trim() !== '')
    ? room.workDir.trim()
    : (bot.dir || '(unknown)')
  const rules = isRoomSession
    ? [
      `- This is an isolated Group Room session for ${bot.name}. Your active working directory is ${effectiveWorkspace}.`,
      '- Follow the `team-collaboration` skill (Hermes Bot Mode): before acting, evaluate whether the task fits your role. Handle what fits you; if it belongs to another specialist, hand off or invite joint analysis via `@TeammateName`; if unaddressed and outside your role, reply `(pass)`.',
      '- Match the user\'s scope: for simple questions or self-introductions, answer concisely without launching unrequested audits or creating heavy progress checklists.',
      '- Treat bare `@TeammateName` strictly as an action wake-up signal. Never put bare `@Name` in role tables, passive descriptions, or self-introductions — use plain names or `` `@Name` `` instead.',
      '- Multiple Bots may execute concurrently in this room. Before editing shared files, call `claim_subtask({ taskId, title, paths })` to lock your target paths; mark `status: "completed"` when finished.',
      '- On multi-step collaborative tasks, follow the `room-completion` skill: track milestones with `room_task_progress`, keep collaborating until merged and verified, avoid casual `@user` during peer handoffs, and call `room_finish_task({ summary, deliverables })` to formally end the room once complete.',
      '- Never call `message_agent` here; address teammates in the room with `@Name`.',
      '- Reply with exactly `(pass)` when consensus is reached or you have nothing new to add.',
      '- Do not leak private 1:1 conversations into the group room.',
      '- Prefer the tools you were given; if a tool is missing you may not use it.',
    ]
    : [
      `- Your permanent chat is this Session; it never resets. Your workspace is ${bot.dir || '(unknown)'}.`,
      '- Use `message_agent` for teammate contact. Keep each message self-contained.',
      '- Inside a Group Room you run in a separate room session and reply there instead of using `message_agent`.',
      '- Prefer the tools you were given; if a tool is missing you may not use it.',
    ]

  return [
    soul.trim() || `# ${bot.name}\n\n${bot.role || ''}\n\n${bot.instructions || ''}`,
    '',
    '## Team roster',
    '',
    roster,
    '',
    '## Working rules',
    '',
    ...rules,
    '',
    '## Virtual Screen (Dedicated Linux Desktop)',
    '',
    '- You have your own dedicated 1280×720 Linux virtual screen (`screen_screenshot`, `screen_open_app`, `screen_click`, `screen_type`, `screen_key`, `screen_scroll`, `screen_drag`, `screen_windows`). Perform browser, GUI, login, and desktop automation inside your virtual screen.',
    '- Note: for terminal windows, use `paste_key: "shift+Insert"` with `screen_type`; for browsers/GUI apps, use default `ctrl+v`.',
    '- **Human Takeover Rule**: Whenever you hit a blocker you cannot solve autonomously (CAPTCHA/slider verification, MFA/SMS/QR login, payment/sensitive authorization, repeated failure, or ambiguous confirmation), do NOT guess blindly. Immediately call `screen_request_help({ category, reason })` — this pops a takeover card for the human operator, waits until they complete it and hand control back, and returns the updated screenshot so you can continue.',
    formatBlock !== '' ? `\n${formatBlock}` : '',
    memoryHubBlock !== '' ? `\n${memoryHubBlock}` : '',
    memory.trim() !== '' ? `\n## Your memory (MEMORY.md)\n\n${memory.trim()}` : '',
    '',
  ].join('\n')
}

export const botBrief = (bot) => `${bot.name}${bot.role ? ` — ${oneLine(bot.role)}` : ''}`
