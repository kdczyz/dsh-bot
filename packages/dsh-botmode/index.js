/**
 * Host half of Bot mode.
 *
 * A Bot lives in its own workspace directory:
 *
 *   <bots root>/<Bot>/
 *     AGENTS.md            persona + standing instructions (DSH reads it as project instructions)
 *     SOUL.md              the same persona, for people
 *     bot.json             name, role, colour, created time
 *     TEAM.md              the roster and the post protocol
 *     .dsh/skills/team/SKILL.md   the team skill every Bot loads
 *
 * The Client creates the directory and the workspace; `/botmode scaffold` writes the
 * files into the Bot session's own working directory. `team_board` is the shared board
 * that lets Bots on this machine leave messages for each other.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const inject = ['commands', 'tools']

const BOT_FILE = 'bot.json'
const TEAM_DIR = '.team'
const BOARD_FILE = 'board.jsonl'
const BOARD_KEEP = 200

const readJson = async (path, fallback) => {
  try {
    const raw = await readFile(path, 'utf8')
    const value = JSON.parse(raw)
    return value ?? fallback
  } catch (_error) {
    return fallback
  }
}

const botOf = (cwd) => {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const file = join(cwd, BOT_FILE)
  return existsSync(file) ? { dir: cwd, name: basename(cwd), file } : undefined
}

const botRoot = (cwd) => dirname(cwd)

const boardPath = (cwd) => join(botRoot(cwd), TEAM_DIR, BOARD_FILE)

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const scaffoldFiles = ({ name, role, instructions, color, team }) => {
  const roster = Array.isArray(team) && team.length > 0
    ? team.map(member => `- ${member.name}${member.role ? ` — ${member.role}` : ''}`).join('\n')
    : '- (no other Bots yet)'
  const persona = [
    `# ${name}`,
    '',
    role ? `Role: ${role}` : '',
    '',
    '## Standing instructions',
    '',
    instructions || '(none yet)',
    '',
    '## Team',
    '',
    'You are one Bot in a team that shares this machine. Every Bot has its own workspace',
    'and its own chat. You talk to the others through the `team_board` tool:',
    '',
    '- `team_board` action="roster" lists the Bots and their roles.',
    '- `team_board` action="read" shows what the others posted lately.',
    '- `team_board` action="post" text="@Name …" leaves a message for a teammate.',
    '',
    'Read the board when a task may involve a teammate; post when you need one.',
    'Never claim a teammate did something you did not see on the board.',
    '',
    '## Teammates',
    '',
    roster,
    '',
  ].join('\n')
  const teamSkill = [
    '---',
    'name: team',
    'description: Talk to the other Bots on this machine through the shared team board.',
    'whenToUse: When you need a teammate, when a request touches another Bot\'s role, or before starting work someone else may already have done.',
    '---',
    '',
    '# Team board',
    '',
    'Every Bot on this machine shares one board. Use the `team_board` tool.',
    '',
    '1. `team_board` `action="roster"` — who is on the team and what each one owns.',
    '2. `team_board` `action="read"` — the latest posts (newest last).',
    '3. `team_board` `action="post"` with `text` — leave a message. Start it with `@Name`',
    '   to address one Bot; anyone can read it.',
    '',
    'Rules:',
    '- Post what you need, with the context the other Bot cannot see.',
    '- Do not repost the same request; read the board first.',
    '- A Bot only reads the board when it runs, so treat a post as a note, not a call.',
    '- Answer a request addressed to you by posting back with `@Name`.',
    '',
  ].join('\n')
  const teamMd = [
    '# Team',
    '',
    roster,
    '',
    'Bots talk through the `team_board` tool. Each Bot works in its own workspace.',
    '',
  ].join('\n')
  return {
    'AGENTS.md': persona,
    'SOUL.md': persona,
    [BOT_FILE]: `${JSON.stringify({ name, role: role || '', color: color || '', createdAt: new Date().toISOString() }, null, 2)}\n`,
    'TEAM.md': teamMd,
    '.dsh/skills/team/SKILL.md': teamSkill,
  }
}

const writeScaffold = async (cwd, payload) => {
  const files = scaffoldFiles(payload)
  for (const [relative, content] of Object.entries(files)) {
    const target = join(cwd, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

const boardLines = async (cwd, limit) => {
  const path = boardPath(cwd)
  let raw = ''
  try {
    raw = await readFile(path, 'utf8')
  } catch (_error) {
    return []
  }
  const lines = raw.split('\n').filter(line => line.trim() !== '')
  const take = Math.max(1, Math.min(Number(limit) || 20, 100))
  return lines.slice(-take).map((line) => {
    try {
      return JSON.parse(line)
    } catch (_error) {
      return { text: line }
    }
  })
}

const rosterOf = async (cwd) => {
  const root = botRoot(cwd)
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (_error) {
    return []
  }
  const bots = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const meta = await readJson(join(root, entry.name, BOT_FILE), undefined)
    if (meta === undefined) continue
    bots.push({ name: meta.name || entry.name, role: meta.role || '', dir: join(root, entry.name) })
  }
  return bots.sort((a, b) => a.name.localeCompare(b.name))
}

export function apply(ctx) {
  ctx.commands.register({
    name: 'botmode',
    description: 'Write or update this Bot\'s workspace files (persona, team skill).',
    input: { hint: 'scaffold <json>' },
    handler: async ({ agent, rawInput }) => {
      const input = String(rawInput ?? '').trim()
      const space = input.indexOf(' ')
      const action = (space === -1 ? input : input.slice(0, space)).toLowerCase()
      const rest = space === -1 ? '' : input.slice(space + 1).trim()
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') {
        return { kind: 'error', text: 'This Session has no working directory.' }
      }
      if (action === 'scaffold') {
        let payload
        try {
          payload = JSON.parse(rest)
        } catch (_error) {
          return { kind: 'error', text: 'scaffold needs a JSON payload.' }
        }
        if (typeof payload?.name !== 'string' || payload.name.trim() === '') {
          return { kind: 'error', text: 'scaffold needs a name.' }
        }
        const team = await rosterOf(cwd)
        await writeScaffold(cwd, {
          name: payload.name.trim(),
          role: typeof payload.role === 'string' ? payload.role : '',
          instructions: typeof payload.instructions === 'string' ? payload.instructions : '',
          color: typeof payload.color === 'string' ? payload.color : '',
          team: team.filter(member => member.dir !== cwd),
        })
        return { kind: 'success', text: `Wrote Bot files into ${cwd}.` }
      }
      return { kind: 'error', text: 'Unknown action. Use scaffold.' }
    },
  })

  const when = ({ agent }) => botOf(agent?.session?.header?.cwd) !== undefined

  ctx.tools.register({
    name: 'team_board',
    description: 'Read and post on the shared board of the Bots on this machine. Use it to see who else is on the team, what they posted lately, and to leave a message for a teammate.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['roster', 'read', 'post'],
        description: 'roster: Bots and roles. read: recent posts. post: append your message.',
      },
      text: { type: 'string', description: 'For post: the message. Start with @Name to address one Bot.' },
      limit: { type: 'number', description: 'For read: how many posts to return (default 20, max 100).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd
      const bot = botOf(cwd)
      if (bot === undefined) return 'This Session is not a Bot workspace.'
      const action = String(args?.action ?? '')
      if (action === 'roster') {
        const bots = await rosterOf(cwd)
        if (bots.length === 0) return 'No Bots found.'
        return bots.map(member => `${member.name}${member.role ? ` — ${member.role}` : ''}`).join('\n')
      }
      if (action === 'read') {
        const posts = await boardLines(cwd, args?.limit)
        if (posts.length === 0) return 'The board is empty.'
        return posts.map(post => `[${post.at || '?'}] ${post.from || '?'}: ${oneLine(post.text)}`).join('\n')
      }
      if (action === 'post') {
        const text = String(args?.text ?? '').trim()
        if (text === '') return 'Write the message in text.'
        const path = boardPath(cwd)
        await mkdir(dirname(path), { recursive: true })
        const record = { at: new Date().toISOString(), from: bot.name, text }
        await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
        return `Posted as ${bot.name}.`
      }
      return 'Unknown action. Use roster, read or post.'
    },
  }, { when })
}