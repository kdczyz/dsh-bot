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
    'You are one Bot in a team. Every Bot has its own workspace, its own memory and its',
    'own permanent chat. Talk to teammates with the `message_agent` tool:',
    '',
    '- `message_agent` target `<name or id>`, message `...` posts an asynchronous message',
    '  into that Bot\'s permanent chat. It returns `dispatched` at once; the reply arrives',
    '  later in your chat when you asked for it with `expectReply`.',
    '- `bot_team` lists the roster, your own id and the Sections.',
    '',
    'Rules:',
    '- Never claim a teammate did something you did not see in your chat.',
    '- One message per request; do not ping-pong a teammate more than twice.',
    '- When you are inside a Group Room you cannot use `message_agent`; answer in the room.',
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
  'description: Message the other Bots on this machine, list the roster, and hand work to a teammate.',
  'whenToUse: When a request belongs to another Bot, when you need a decision from a teammate, or before starting work someone else may own.',
  '---',
  '',
  '# Team',
  '',
  'Use the `message_agent` tool to reach a teammate.',
  '',
  '1. `bot_team` action="roster" — who is on the team and what each one owns.',
  '2. `message_agent` target="<name or id>" message="..." — asynchronous delivery into that Bot\'s permanent chat.',
  '3. `message_agent` with `expectReply: true` — the teammate\'s answer arrives later in your chat.',
  '',
  'Rules:',
  '- Include the context the other Bot cannot see.',
  '- Do not resend the same request; wait for the reply.',
  '- Inside a Group Room, answer in the room instead.',
  '',
].join('\n')

export const syncBotFiles = async (store, bot, state) => {
  await store.ensureBotDir(bot)
  const dir = bot.dir
  await writeTextFile(join(dir, 'bot.json'), `${JSON.stringify(bot, null, 2)}\n`)
  await writeTextFile(join(dir, 'SOUL.md'), renderSoul(bot, state))
  const memoryPaths = join(dir, 'MEMORY.md')
  const memory = await readTextFile(memoryPaths, '')
  if (memory === '') {
    await writeTextFile(memoryPaths, [
      `# ${bot.name} — memory`,
      '',
      'Durable notes this Bot keeps for itself. Edit this file when something must survive',
      'the current chat.',
      '',
    ].join('\n'))
  }
  await writeTextFile(join(dir, '.dsh', 'skills', 'team', 'SKILL.md'), renderTeamSkill())
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

export const personaBlock = async (store, bot, state) => {
  const dir = bot.dir
  const soul = dir ? await readTextFile(join(dir, 'SOUL.md'), '') : ''
  const memory = dir ? await readTextFile(join(dir, 'MEMORY.md'), '') : ''
  const teammates = state.bots.filter(member => member.id !== bot.id)
  const roster = teammates.length === 0
    ? '(no other Bots yet)'
    : teammates.map(member => `- ${member.name}${member.role ? ` — ${member.role}` : ''} [id: ${member.id}]`).join('\n')
  return [
    soul.trim() || `# ${bot.name}\n\n${bot.role || ''}\n\n${bot.instructions || ''}`,
    '',
    '## Team roster',
    '',
    roster,
    '',
    '## Working rules',
    '',
    `- Your permanent chat is this Session; it never resets. Your workspace is ${bot.dir || '(unknown)'}.`,
    '- Use `message_agent` for teammate contact. Keep each message self-contained.',
    '- Inside a Group Room you cannot use `message_agent`; reply in the room and use @Name to hand off.',
    '- Prefer the tools you were given; if a tool is missing you may not use it.',
    memory.trim() !== '' ? `\n## Your memory\n\n${memory.trim()}` : '',
    '',
  ].join('\n')
}

export const botBrief = (bot) => `${bot.name}${bot.role ? ` — ${oneLine(bot.role)}` : ''}`