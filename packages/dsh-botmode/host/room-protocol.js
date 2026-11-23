/**
 * Pure protocol helpers for Group Room routing, mention parsing, silence
 * normalization, speaker rotation and incremental delta prompts.
 *
 * Kept pure (no I/O, no timers, no store references) so every routing decision
 * is deterministic and directly unit-testable.
 */

export const MAX_DELTA_MESSAGES = 24
export const MAX_DELTA_CHARS = 24_000

const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Identifier character class (Unicode letters, numbers, underscore, hyphen).
const IDENT_RE = /[\p{L}\p{N}_-]/u
const BEFORE_AT_DISALLOW_RE = /[\p{L}\p{N}_.]/u

/**
 * Strip non-directive segments before scanning for `@mention` or `@user`:
 * - fenced code blocks (```...```)
 * - inline code spans (`...`)
 * - markdown blockquotes (`> ...`)
 * - quoted examples inside 「...」 / 『...』 / “...” / "..."
 *
 * This prevents examples like `比如「@服务器管理员 扫描脚本怎么切」` from
 * falsely waking another Bot or pausing the room.
 */
export function stripNonDirectiveText(text) {
  let out = String(text ?? '')
  // 1. Fenced code blocks
  out = out.replace(/```[\s\S]*?```/g, ' ')
  // 2. Inline code spans
  out = out.replace(/`[^`\n]*`/g, ' ')
  // 3. Markdown blockquote lines
  out = out.replace(/^[ \t]*>.*$/gm, ' ')
  // 4. Quoted examples (non-greedy, single-paragraph)
  out = out.replace(/「[^」\n]*」/g, ' ')
  out = out.replace(/『[^』\n]*』/g, ' ')
  out = out.replace(/“[^”\n]*”/g, ' ')
  out = out.replace(/"[^"\n]*"/g, ' ')
  return out
}

/**
 * Normalize a reply and determine whether it is an explicit silence token.
 * Accepts `(pass)`, `（pass）`, `[NO_REPLY]`, `【NO_REPLY】`, `[SILENT]`,
 * optional markdown backticks/emphasis, trailing sentence punctuation, or empty text.
 */
export function isPassReply(text) {
  let value = String(text ?? '').trim()
  if (value === '') return true
  // Strip outer backticks / bold / italic markers
  value = value.replace(/^[`*_~\s]+|[`*_~\s]+$/g, '').trim()
  // Strip trailing sentence punctuation
  value = value.replace(/[.。!！?？;；,，\s]+$/g, '').trim()
  // Unwrap one pair of half-width or full-width brackets/parentheses
  const wrapped = /^(\(|（|\[|【|<)(.*)(\)|）|\]|】|>)$/.exec(value)
  if (wrapped) value = wrapped[2].trim()
  const token = value.replace(/[\s_-]+/g, '').toLowerCase()
  return token === '' || token === 'pass' || token === 'noreply' || token === 'silent' || token === 'skip'
}

/**
 * True when the directive portion of `text` explicitly escalates to the human
 * via `@user`, `@human` or `@你` (half-width `@` or full-width `＠`).
 */
export function hasUserEscalation(text) {
  const cleaned = stripNonDirectiveText(text)
  const pattern = /[@＠](user|human|你)/giu
  for (const match of cleaned.matchAll(pattern)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const prev = start > 0 ? cleaned[start - 1] : ''
    const next = end < cleaned.length ? cleaned[end] : ''
    if (prev !== '' && BEFORE_AT_DISALLOW_RE.test(prev)) continue
    if (next !== '' && IDENT_RE.test(next)) continue
    return true
  }
  return false
}

const hasAllMention = (cleaned) => {
  const pattern = /[@＠](all|everyone|所有人|全员)/giu
  for (const match of cleaned.matchAll(pattern)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const prev = start > 0 ? cleaned[start - 1] : ''
    const next = end < cleaned.length ? cleaned[end] : ''
    if (prev !== '' && BEFORE_AT_DISALLOW_RE.test(prev)) continue
    if (next !== '' && IDENT_RE.test(next)) continue
    return true
  }
  return false
}

/**
 * Parse directive `@mentions` from `text` against the room's member list.
 *
 * Matches longer names before shorter names and masks matched spans so a
 * mention of `@服务器管理员` can never also trigger a Bot named `管理员`.
 *
 * @param {string} text
 * @param {Array<{ id: string, name: string }>} members
 * @param {string} [excludeBotId]
 * @returns {{ all: boolean, botIds: string[] }}
 */
export function parseMentions(text, members, excludeBotId = '') {
  const cleaned = stripNonDirectiveText(text)
  const list = Array.isArray(members) ? members : []
  const all = hasAllMention(cleaned)
  if (all) {
    return {
      all: true,
      botIds: list.filter(member => member.id !== excludeBotId).map(member => member.id),
    }
  }

  // Build candidate tokens sorted longest-first so prefixes never shadow longer names.
  const tokens = []
  for (const member of list) {
    if (!member || typeof member.id !== 'string') continue
    if (typeof member.name === 'string' && member.name.trim() !== '') {
      tokens.push({ botId: member.id, token: member.name.trim() })
    }
    tokens.push({ botId: member.id, token: member.id })
  }
  tokens.sort((a, b) => b.token.length - a.token.length)

  const chars = [...cleaned]
  // Track which character indices have already been consumed by a longer match.
  const consumed = new Uint8Array(cleaned.length)
  const hits = [] // { index, botId }

  for (const entry of tokens) {
    if (entry.botId === excludeBotId) continue
    const regex = new RegExp(`[@＠]${escapeRegex(entry.token)}`, 'giu')
    for (const match of cleaned.matchAll(regex)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      let overlap = false
      for (let i = start; i < end; i += 1) {
        if (consumed[i] === 1) { overlap = true; break }
      }
      if (overlap) continue
      const prev = start > 0 ? cleaned[start - 1] : ''
      const next = end < cleaned.length ? cleaned[end] : ''
      // Reject emails like `ops@admin.com` and prefix collisions like `@管理员2`
      if (prev !== '' && BEFORE_AT_DISALLOW_RE.test(prev)) continue
      if (next !== '' && IDENT_RE.test(next)) continue
      for (let i = start; i < end; i += 1) consumed[i] = 1
      hits.push({ index: start, botId: entry.botId })
    }
  }

  // Preserve the textual mention order and deduplicate.
  void chars
  hits.sort((a, b) => a.index - b.index)
  const botIds = []
  for (const hit of hits) {
    if (!botIds.includes(hit.botId)) botIds.push(hit.botId)
  }
  return { all: false, botIds }
}

/**
 * Deterministic round-robin rotation: shifts the member order by `round % len`
 * so the first member in the roster does not always speak first.
 */
export function rotateGroupSpeakers(memberIds, round = 0) {
  if (!Array.isArray(memberIds) || memberIds.length === 0) return []
  const offset = ((Number(round) || 0) % memberIds.length + memberIds.length) % memberIds.length
  if (offset === 0) return memberIds.slice()
  return [...memberIds.slice(offset), ...memberIds.slice(0, offset)]
}

/**
 * Decide which members should be scheduled for round 0 after a user message or continue.
 *
 * Rules:
 * - Explicit `@all`/`@everyone` -> all members (rotated for `round`).
 * - Explicit `@Member` -> only the mentioned members (zero tokens for others).
 * - No explicit mention:
 *   - `mode === 'lead'` -> only `leadBotId` (or first member).
 *   - `mode === 'auto'` or `mode === 'everyone'` -> all members (rotated for `round`).
 */
export function resolveInitialResponders(room, text, members, round = 0, excludeBotId = '') {
  const validMembers = Array.isArray(members) ? members : []
  if (validMembers.length === 0) return { botIds: [], directedIds: new Set(), reason: 'empty' }

  const parsed = text ? parseMentions(text, validMembers, excludeBotId) : { all: false, botIds: [] }
  if (parsed.all) {
    return {
      botIds: rotateGroupSpeakers(validMembers.map(m => m.id), round),
      directedIds: new Set(validMembers.map(m => m.id)),
      reason: 'mention_all',
    }
  }
  if (parsed.botIds.length > 0) {
    return {
      botIds: parsed.botIds,
      directedIds: new Set(parsed.botIds),
      reason: 'mention',
    }
  }
  if (room.mode === 'lead') {
    const leadId = room.leadBotId && validMembers.some(m => m.id === room.leadBotId)
      ? room.leadBotId
      : (validMembers.find(m => m.name.toLowerCase().includes('lead'))?.id ?? validMembers[0].id)
    return {
      botIds: leadId ? [leadId] : [],
      directedIds: new Set(leadId ? [leadId] : []),
      reason: 'lead',
    }
  }
  // `auto` & `everyone`: everyone enters the round-0 candidate pool, strictly serial.
  return {
    botIds: rotateGroupSpeakers(validMembers.map(m => m.id), round),
    directedIds: new Set(),
    reason: 'open_round',
  }
}

/**
 * Extract the incremental delta messages visible to `speakerId` strictly within
 * `(lastReadSeq, deliveredThrough]`, skipping any messages already authored by
 * this speaker at the same seq if needed.
 */
export function selectDeltaMessages(transcript, lastReadSeq, deliveredThrough, maxMessages = MAX_DELTA_MESSAGES, maxChars = MAX_DELTA_CHARS) {
  const unseen = (Array.isArray(transcript) ? transcript : []).filter(
    item => Number.isFinite(item.seq) && item.seq > lastReadSeq && item.seq <= deliveredThrough,
  )
  let omitted = 0
  let slice = unseen
  if (slice.length > maxMessages) {
    omitted += slice.length - maxMessages
    slice = slice.slice(-maxMessages)
  }
  const formatted = []
  let totalChars = 0
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const item = slice[i]
    const from = item.from === 'user' ? 'User' : (item.name || 'Bot')
    const line = `[#${item.seq}] ${from}: ${item.text}`
    if (totalChars + line.length > maxChars && formatted.length > 0) {
      omitted += i + 1
      break
    }
    formatted.unshift(line)
    totalChars += line.length + 1
  }
  return {
    lines: formatted,
    omitted,
    count: unseen.length,
  }
}

/**
 * Build the incremental user-role prompt delivered into a member's hidden Group Session.
 */
export function buildRoomTurnPrompt({
  room,
  speaker,
  members,
  delta,
  round,
  directed,
  triggerReason,
  mentionedBy,
}) {
  const roster = members
    .map(member => `${member.id === speaker.id ? '→ ' : ''}@${member.name}${member.role ? ` (${member.role})` : ''}`)
    .join(', ')

  const header = [
    `[Group Room "${room.name}" · Round ${round + 1}/${room.budget?.maxRounds ?? 3}]`,
    `You are @${speaker.name}${speaker.role ? ` (${speaker.role})` : ''}. Participants: ${roster}, and User.`,
  ]
  if (typeof room.purpose === 'string' && room.purpose.trim() !== '') {
    header.push(`Room purpose: ${room.purpose.trim()}`)
  }
  if (typeof room.notes === 'string' && room.notes.trim() !== '') {
    header.push(`Shared room notes: ${room.notes.trim()}`)
  }

  const deltaLines = []
  if (delta.omitted > 0) {
    deltaLines.push(`[${delta.omitted} earlier message(s) omitted to stay within context budget]`)
  }
  if (delta.lines.length > 0) {
    deltaLines.push(...delta.lines)
  } else {
    deltaLines.push('(no new messages since your last turn)')
  }

  let cue = ''
  if (triggerReason === 'continued') {
    cue = 'The user clicked Continue to extend the discussion budget. Pick up cleanly from the latest messages.'
  } else if (mentionedBy) {
    cue = `@${mentionedBy} directly mentioned you in the group. Respond to their handoff with your concrete result, decision, or blocker.`
  } else if (directed) {
    cue = 'You were directly addressed in this round. Provide a concise, concrete answer.'
  } else {
    cue = 'Review the new group messages. Contribute only if you have new information, a concrete action, or a helpful perspective.'
  }

  const silenceRule = directed
    ? 'If this is already resolved or requires no action from you, reply with exactly (pass).'
    : 'If consensus is reached or you have nothing genuinely new to add, reply with exactly (pass) so the room can settle quietly.'

  return [
    ...header,
    '',
    'New messages since your last turn (oldest first):',
    ...deltaLines,
    '',
    cue,
    '',
    'Rules:',
    '- Speak only as yourself. Do not repeat points already made.',
    '- To hand off to a specific teammate in the next turn, write @TheirName directly (do not wrap real handoffs inside quotes or code blocks).',
    '- Only write @user when you genuinely need a human decision or intervention.',
    `- ${silenceRule}`,
    '- Never call message_agent inside a Group Room; reply in the room instead.',
  ].join('\n')
}
