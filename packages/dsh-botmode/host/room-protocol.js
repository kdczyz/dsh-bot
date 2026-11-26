/**
 * Pure protocol helpers for Group Room routing, mention parsing, silence
 * normalization, speaker rotation and incremental delta prompts.
 *
 * Kept pure (no I/O, no timers, no store references) so every routing decision
 * is deterministic and directly unit-testable.
 */

import { createHash } from 'node:crypto'
import { formatRoomTaskBoard } from './room-locks.js'

export const MAX_DELTA_MESSAGES = 24
export const MAX_DELTA_CHARS = 24_000

const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Identifier character class (Unicode letters, numbers, underscore, hyphen).
const IDENT_RE = /[\p{L}\p{N}_-]/u
const ASCII_IDENT_RE = /[A-Za-z0-9_-]/
const ENDS_WITH_CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]$/u
const BEFORE_AT_DISALLOW_RE = /[\p{L}\p{N}_.]/u

// Aligned with Hermes `hosted_room_discussion.py::_MEMBER_CONTROL_FRAME_RE` &
// `group-round-prompt.ts::MEMBER_CONTROL_FRAME_RE`: relabels control-frame openers
// inside republished teammate messages so a peer reply cannot spoof harness directives.
const MEMBER_CONTROL_FRAME_RE = /\[(?=\/?OUT-OF-BAND USER MESSAGE|CONTEXT COMPACTION|CONTEXT SUMMARY\]|PRIOR CONTEXT|Runtime note:|System note:|System:|SYSTEM\]|IMPORTANT:|Planning state preserved|ASYNC DELEGATION|Autonomous Progress Review|Group Room )/gi

export function relabelMemberControlFrames(text) {
  return String(text ?? '').replace(MEMBER_CONTROL_FRAME_RE, '[member-quoted ')
}

/**
 * Strip non-directive segments before scanning for `@mention` or `@user`:
 * - fenced code blocks (```...```)
 * - inline code spans (`...`)
 * - markdown blockquotes (`> ...`)
 * - quoted examples inside 「...」 / 『...』 / “...” / "..."
 * - (for Bot replies only, `isMemberMessage: true`): Markdown table rows (`| ... |`)
 *   and parenthetical ownership notes like `(→ @HostOps)` / `（→ @主机运维官）` so
 *   role tables or self-introductions never trigger accidental ping-pong wakeups!
 *
 * Human messages (`isMemberMessage: false`) NEVER strip tables or parentheses so
 * every human `@Bot` directive is honored 100%.
 */
export function stripNonDirectiveText(text, options = {}) {
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
  if (options?.isMemberMessage === true) {
    // 5. Markdown table rows in Bot prose (commonly list role ownership / "谁执行")
    out = out.replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ')
    // 6. Parenthetical role-reference notes like `（→ @主机运维官）` or `(-> @Ops)`
    out = out.replace(/[（(][ \t]*(?:→|->|-->|=>|归|由|交由|见|ref:?)[ \t]*[^)）\n]*[)）]/giu, ' ')
  }
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
  const pattern = /[@＠][ \t]?(user|human|你)/giu
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
  const pattern = /[@＠][ \t]?(all|everyone|所有人|全员)/giu
  for (const match of cleaned.matchAll(pattern)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const prev = start > 0 ? cleaned[start - 1] : ''
    const next = end < cleaned.length ? cleaned[end] : ''
    if (prev !== '' && BEFORE_AT_DISALLOW_RE.test(prev)) continue
    const isCjk = ENDS_WITH_CJK_RE.test(match[1])
    if (next !== '' && (isCjk ? ASCII_IDENT_RE.test(next) : IDENT_RE.test(next))) continue
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
export function parseMentions(text, members, excludeBotId = '', options = {}) {
  const cleaned = stripNonDirectiveText(text, options)
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
    const regex = new RegExp(`[@＠][ \\t\\u3000]*${escapeRegex(entry.token)}`, 'giu')
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
      // Reject emails like `ops@admin.com` and prefix collisions like `@管理员2`.
      // For CJK Bot names (e.g. `@主机运维官汇总一下`), allow immediately following Chinese prose
      // because candidate tokens are already matched longest-first with span masking!
      if (prev !== '' && BEFORE_AT_DISALLOW_RE.test(prev)) continue
      const isCjkToken = ENDS_WITH_CJK_RE.test(entry.token)
      if (next !== '' && (isCjkToken ? ASCII_IDENT_RE.test(next) : IDENT_RE.test(next))) continue
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
 * Detect explicit unresolved `@token` attempts (e.g. typos like `@运维管` instead
 * of `@主机运维官`) while ignoring emails, `@user`/`@你`, `@all`/`@everyone`, and matched/self mentions.
 */
export function findUnresolvedMentions(text, members, excludeBotId = '', options = {}) {
  const cleaned = stripNonDirectiveText(text, options)
  const list = Array.isArray(members) ? members : []
  const parsed = parseMentions(text, list, excludeBotId, options)
  if (parsed.all || parsed.botIds.length > 0) return []
  const selfTokens = new Set(
    list
      .filter(m => m && m.id === excludeBotId)
      .flatMap(m => [String(m.name ?? '').trim().toLowerCase(), String(m.id ?? '').trim().toLowerCase()])
      .filter(Boolean),
  )
  const unresolved = []
  const rawAtRe = /[@＠][ \t\u3000]*([^\s,，。！？；：、()（）【】[\]<>《》"'`]{1,32})/gu
  for (const match of cleaned.matchAll(rawAtRe)) {
    const start = match.index ?? 0
    const prev = start > 0 ? cleaned[start - 1] : ''
    if (prev !== '' && BEFORE_AT_DISALLOW_RE.test(prev)) continue
    const candidate = String(match[1] ?? '').trim()
    if (candidate === '') continue
    const lower = candidate.toLowerCase()
    if (
      lower === 'user' || lower === 'human' || lower === '你' || lower === '用户' || lower === '我'
      || lower === 'all' || lower === 'everyone' || lower === '所有人' || lower === '全体'
      || selfTokens.has(lower)
    ) {
      continue
    }
    if (!unresolved.includes(candidate)) unresolved.push(candidate)
  }
  return unresolved
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

export function resolveEffectiveLeadId(room, members) {
  const validMembers = Array.isArray(members) ? members : []
  if (validMembers.length === 0) return ''
  if (room?.leadBotId && validMembers.some(m => m.id === room.leadBotId)) {
    return room.leadBotId
  }
  return validMembers.find(m => String(m.name ?? '').toLowerCase().includes('lead'))?.id ?? validMembers[0].id
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
    const leadId = resolveEffectiveLeadId(room, validMembers)
    return {
      botIds: leadId ? [leadId] : [],
      directedIds: new Set(leadId ? [leadId] : []),
      reason: 'lead',
    }
  }
  // `auto` & `everyone`: everyone enters the round-0 candidate pool concurrently.
  return {
    botIds: rotateGroupSpeakers(validMembers.map(m => m.id), round),
    directedIds: new Set(),
    reason: 'open_round',
  }
}

/**
 * Aligned with Hermes `group-rounds.ts::classifyGroupHoldDirective`:
 * Inspects a HUMAN message for member hold directives (`stop @Bot`, `@Bot 暂停`, `@all stop`)
 * vs normal direct mentions that release a held member.
 */
export function classifyMemberHoldDirective(text, members) {
  const validMembers = Array.isArray(members) ? members : []
  const cleaned = stripNonDirectiveText(text, { isMemberMessage: false })
  const parsed = parseMentions(cleaned, validMembers, '', { isMemberMessage: false })
  if (!parsed.all && parsed.botIds.length === 0) {
    return { hold: [], holdAll: false, release: [], releaseAll: false }
  }
  const hasStop = /(?:^|[\s，。！？,.;:：])(stop|halt|pause|静音|暂停|停止|闭嘴|别说了|停下|先停)(?:$|[\s，。！？,.;:：])/iu.test(cleaned)
    || /[@＠][^\s，。！？,.;:：]{1,24}[\s，,]*?(?:停|暂停|停止|静音|闭嘴|stop|halt|pause)(?:$|[\s，。！？,.;:：])/iu.test(cleaned)
    || /(?:停|暂停|停止|静音|stop|halt|pause)[\s，,]*?[@＠]/iu.test(cleaned)
  if (hasStop) {
    return {
      hold: parsed.all ? [] : parsed.botIds,
      holdAll: parsed.all,
      release: [],
      releaseAll: false,
    }
  }
  return {
    hold: [],
    holdAll: false,
    release: parsed.all ? [] : parsed.botIds,
    releaseAll: parsed.all,
  }
}

/**
 * Hermes-aligned Zero-Token Actor Routing Filter (`evaluateActorDelta`):
 *
 * Strictly mirrors `gateway/hosted_room_discussion.py::plan_next_task` &
 * `_unaddressed_member_mentions` plus `group-rounds.ts::resolveGroupResponders`:
 *
 * 1. **Epoch-Scoped Routing (Fixes solo-@ waking other Bots from stale epochs)**:
 *    Routing ONLY inspects messages belonging to `currentEpoch` (the latest user
 *    discussion). Unread messages from older epochs stay in the member's delta
 *    context if/when the member is later cited, but NEVER wake unaddressed Bots!
 *
 * 2. **Round 0 (User Kickoff)**:
 *    - Human `@all`/`@everyone`/`@所有人` -> every member wakes (`replyRequired: true`).
 *    - Human explicit `@BotA` -> ONLY `BotA` wakes (`replyRequired: true`).
 *      Unmentioned peers return `shouldRespond: false, advanceWatermark: false`
 *      so their watermark remains intact (zero tokens now; full delta if cited later).
 *    - Human unaddressed message -> `lead` mode wakes only Lead; `auto`/`everyone`
 *      wakes members to perform Task-Fit self-assessment (work if fit, `(pass)` if not).
 *
 * 3. **Round 1+ (Strict Opt-In — `_unaddressed_member_mentions`)**:
 *    Once a Bot has acted in this epoch (or teammates have replied), ONLY peers
 *    who were explicitly `@mentioned` by a teammate in this epoch AND have NOT
 *    posted/acted since that mention (`latestCitedSeq > lastActedSeq`) get another turn!
 *    (Exceptions: `system` fault-rescue broadcast, or Lead reviewing unmentioned worker
 *    reports in `lead` mode.)
 */
export function evaluateActorDelta({
  room,
  actorBotId,
  members,
  deltaItems,
  pausedBotIds,
  heldBotIds,
  currentEpoch,
  epochMessages,
  hasActedInEpoch = false,
  lastActedSeq = 0,
}) {
  const validMembers = Array.isArray(members) ? members : []
  if (heldBotIds instanceof Set && heldBotIds.has(actorBotId)) {
    return { shouldRespond: false, directed: false, replyRequired: false, mentionedBy: '', triggerReason: 'held', advanceWatermark: false }
  }

  const targetEpoch = Number.isFinite(currentEpoch) ? currentEpoch : (Number(room?.epoch) || 0)
  const rawDelta = (Array.isArray(deltaItems) ? deltaItems : []).filter(
    item => item && item.kind !== 'error' && item.kind !== 'completion',
  )
  const rawEpoch = Array.isArray(epochMessages)
    ? epochMessages.filter(item => item && item.kind !== 'error' && item.kind !== 'completion')
    : null

  // Scope routing strictly to the current epoch whenever epoch metadata exists.
  const scopeSource = rawEpoch ?? rawDelta
  const scopedItems = targetEpoch > 0 && scopeSource.some(item => Number.isFinite(item.epoch))
    ? scopeSource.filter(item => (Number(item.epoch) || 0) === targetEpoch)
    : scopeSource

  if (scopedItems.length === 0) {
    return { shouldRespond: false, directed: false, replyRequired: false, mentionedBy: '', triggerReason: 'empty', advanceWatermark: false }
  }

  // Locate the current discussion's human kickoff message (if any in this epoch).
  let latestUserMsg = null
  for (let i = scopedItems.length - 1; i >= 0; i -= 1) {
    if (scopedItems[i].from === 'user' && scopedItems[i].kind === 'message') {
      latestUserMsg = scopedItems[i]
      break
    }
  }
  const discussionFloorSeq = latestUserMsg?.seq ?? 0
  const discussionItems = discussionFloorSeq > 0
    ? scopedItems.filter(item => !Number.isFinite(item.seq) || item.seq >= discussionFloorSeq)
    : scopedItems

  // Track latest system broadcast & Hermes `_unaddressed_member_mentions` in this epoch.
  // CRITICAL CONCURRENCY INVARIANT: compare `latestCitedSeq` against `seenThroughSeq`
  // (`lastActedSeq`, i.e., the highest seq this actor actually READ before replying),
  // NOT its own concurrent `committed.seq` (a slow Bot writing seq=3 after reading only
  // snapshotSeq=1 has NOT yet seen a teammate's concurrent @mention at seq=2!).
  let latestSystemSeq = 0
  let latestCitedSeq = 0
  let mentionedBy = ''
  const seenThroughSeq = Number(lastActedSeq) || 0
  let latestUnmentionedMemberSeq = 0

  for (const item of discussionItems) {
    const seq = Number(item.seq) || 0
    if (item.kind === 'system') {
      if (seq >= latestSystemSeq) latestSystemSeq = seq
      continue
    }
    if (item.from === 'user' || item.from === actorBotId) continue
    const parsed = parseMentions(item.text, validMembers, item.from, { isMemberMessage: true })
    if (parsed.all || parsed.botIds.includes(actorBotId)) {
      if (seq >= latestCitedSeq) {
        latestCitedSeq = seq
        mentionedBy = item.name || ''
      }
    } else if (parsed.botIds.length === 0 && seq > latestUnmentionedMemberSeq) {
      latestUnmentionedMemberSeq = seq
    }
  }

  // 1. Explicit peer @mention in current discussion not yet seen by this actor (Hermes opt-in!)
  if (latestCitedSeq > seenThroughSeq) {
    return {
      shouldRespond: true,
      directed: true,
      replyRequired: false,
      mentionedBy,
      triggerReason: 'mention',
      advanceWatermark: true,
    }
  }

  // 2. System fault-rescue broadcast in current discussion (e.g. a teammate hit 3 identical errors)
  if (latestSystemSeq > seenThroughSeq) {
    return {
      shouldRespond: true,
      directed: false,
      replyRequired: false,
      mentionedBy: '',
      triggerReason: 'system_fallback',
      advanceWatermark: true,
    }
  }

  // 3. Round 0 (this actor has NOT yet acted in the current discussion) -> strictly governed by user message!
  const effectiveActed = hasActedInEpoch || (discussionFloorSeq > 0 && seenThroughSeq >= discussionFloorSeq)
  if (!effectiveActed && latestUserMsg) {
    const userParsed = parseMentions(latestUserMsg.text, validMembers, '', { isMemberMessage: false })
    if (userParsed.all) {
      return {
        shouldRespond: true,
        directed: true,
        replyRequired: true,
        mentionedBy: '',
        triggerReason: 'user',
        advanceWatermark: true,
      }
    }
    if (userParsed.botIds.length > 0) {
      if (userParsed.botIds.includes(actorBotId)) {
        return {
          shouldRespond: true,
          directed: true,
          replyRequired: true,
          mentionedBy: '',
          triggerReason: 'user',
          advanceWatermark: true,
        }
      }
      // Human explicitly @mentioned someone else -> 0 tokens, keep watermark intact (Hermes invariant!)
      return {
        shouldRespond: false,
        directed: false,
        replyRequired: false,
        mentionedBy: '',
        triggerReason: 'directed_to_others',
        advanceWatermark: false,
      }
    }
    if (findUnresolvedMentions(latestUserMsg.text, validMembers, '', { isMemberMessage: false }).length > 0) {
      // Human typed an unrecognized @mention (e.g. typo) -> do NOT broadcast-wake the whole room!
      return {
        shouldRespond: false,
        directed: false,
        replyRequired: false,
        mentionedBy: '',
        triggerReason: 'unresolved_mention',
        advanceWatermark: true,
      }
    }
    // Unaddressed user kickoff
    if (room?.mode === 'lead') {
      const leadId = resolveEffectiveLeadId(room, validMembers)
      if (actorBotId === leadId) {
        return {
          shouldRespond: true,
          directed: true,
          replyRequired: false,
          mentionedBy: '',
          triggerReason: 'user',
          advanceWatermark: true,
        }
      }
      return {
        shouldRespond: false,
        directed: false,
        replyRequired: false,
        mentionedBy: '',
        triggerReason: 'lead_only',
        advanceWatermark: false,
      }
    }
    // `auto` & `everyone`: open Round-0 kickoff (each Bot evaluates Task-Fit first!)
    return {
      shouldRespond: true,
      directed: false,
      replyRequired: false,
      mentionedBy: '',
      triggerReason: 'user',
      advanceWatermark: true,
    }
  }

  // 4. Round 1+: Lead review when a worker posted an unmentioned report in `lead` mode
  if (room?.mode === 'lead') {
    const leadId = resolveEffectiveLeadId(room, validMembers)
    if (actorBotId === leadId && latestUnmentionedMemberSeq > seenThroughSeq) {
      return {
        shouldRespond: true,
        directed: false,
        replyRequired: false,
        mentionedBy: '',
        triggerReason: 'lead_review',
        advanceWatermark: true,
      }
    }
  }

  // 5. Fallback for legacy synthetic deltaItems without a user message in scope
  if (!latestUserMsg && !effectiveActed && latestUnmentionedMemberSeq > seenThroughSeq && room?.mode !== 'lead') {
    return {
      shouldRespond: true,
      directed: false,
      replyRequired: false,
      mentionedBy: '',
      triggerReason: 'round',
      advanceWatermark: true,
    }
  }

  // Strict Hermes Opt-In: nobody explicitly cited this Bot -> stay quiet & keep watermark intact!
  return {
    shouldRespond: false,
    directed: false,
    replyRequired: false,
    mentionedBy: '',
    triggerReason: 'not_cited',
    advanceWatermark: false,
  }
}

/**
 * Compute a stable 16-hex fingerprint for an error signature (tool name + command/path + normalized error summary)
 * used by the Per-Bot Repeated Error Probe (`MAX_REPEAT_ERRORS = 3`).
 */
export function computeErrorFingerprint(toolName, targetSummary, errorText) {
  const normalize = (value) => String(value ?? '')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<ts>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 240)
  const raw = `${normalize(toolName)}|${normalize(targetSummary)}|${normalize(errorText)}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
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
    const from = item.from === 'user' ? 'User (user)' : `@${item.name || 'Bot'}`
    const safeText = item.from === 'user' ? item.text : relabelMemberControlFrames(item.text)
    const line = `[#${item.seq}] ${from}: ${safeText}`
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
 * Aligned with Hermes `group-round-prompt.ts::GROUP_ADDRESSED_NUDGE_SUFFIX`:
 * Sent once if a Bot explicitly addressed by the user (`@Bot` / `@all`) returns `(pass)`.
 */
export const GROUP_ADDRESSED_NUDGE_SUFFIX = [
  '',
  'You just replied "(pass)", but the user explicitly addressed YOU in this turn (@you or @all).',
  'A direct address from the user cannot be silently passed. Reply now with ONE concrete message:',
  '- If this task fits your role, answer or execute it directly.',
  '- If this task is NOT suitable for your role, briefly explain why and `@Mention` the most suitable teammate to collaborate or take over.',
].join('\n')

/**
 * Build the incremental user-role prompt delivered into a member's hidden Group Session.
 */
export function buildRoomTurnPrompt({
  room,
  speaker,
  members,
  delta,
  round = 0,
  directed,
  replyRequired = false,
  triggerReason,
  mentionedBy,
}) {
  const effectiveLeadId = (room?.mode === 'lead' || room?.leadBotId)
    ? resolveEffectiveLeadId(room, members)
    : ''
  const roster = members
    .map((member) => {
      const prefix = member.id === speaker.id ? '→ ' : ''
      const leadTag = member.id === effectiveLeadId ? ' [Lead]' : ''
      return `${prefix}@${member.name}${member.role ? ` (${member.role})` : ''}${leadTag}`
    })
    .join(', ')

  const maxRounds = Number(room.budget?.maxRounds) || 0
  const modeLabel = maxRounds > 0
    ? `Round ${round + 1}/${maxRounds}`
    : `Epoch ${room.epoch || 1} · Hermes Bot Mode`
  const header = [
    `[Group Room "${room.name}" · ${modeLabel}]`,
    `You are @${speaker.name}${speaker.role ? ` (${speaker.role})` : ''}. Participants: ${roster}, and User.`,
  ]
  if (typeof room.workDir === 'string' && room.workDir.trim() !== '') {
    header.push(`Shared project workspace: ${room.workDir.trim()}`)
  }
  if (typeof room.purpose === 'string' && room.purpose.trim() !== '') {
    header.push(`Room purpose: ${room.purpose.trim()}`)
  }
  if (typeof room.notes === 'string' && room.notes.trim() !== '') {
    header.push(`Shared room notes: ${room.notes.trim()}`)
  }

  const taskBoardText = formatRoomTaskBoard(room)
  const boardSection = taskBoardText !== ''
    ? ['', 'Shared task board & active file leases:', taskBoardText]
    : []

  const progressItems = Array.isArray(room?.progress?.items) ? room.progress.items : []
  const progressSection = progressItems.length > 0
    ? [
      '',
      `Shared task progress checklist${room.progress.goal ? ` (${room.progress.goal})` : ''}:`,
      ...progressItems.map(item => `- [${item.done ? 'x' : ' '}] ${item.id}: ${item.title}${item.owner ? ` (${item.owner})` : ''}${item.note ? ` — ${item.note}` : ''}`),
    ]
    : []

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
  if (triggerReason === 'progress_review') {
    cue = [
      '[Autonomous Progress Review · room-completion skill]',
      'All currently active teammates have finished their latest step, and the task is not yet marked completed.',
      'Evaluate the overall progress against the user\'s request:',
      '1) If teammates still have unmerged drafts, unresolved cross-checks, or missing deliverables, coordinate the next step directly with `@TeammateName` (do NOT pause for the human).',
      '2) If all required work/reports are complete (or ready to be merged into one final consolidated answer right now), produce the final consolidated summary and IMMEDIATELY call `room_finish_task({ summary, deliverables })` to terminate this room cleanly.',
      '3) If this was a simple question/introduction with no further action needed, reply `(pass)` so the room settles immediately.',
    ].join('\n')
  } else if (triggerReason === 'continued') {
    cue = 'The user resumed the room. Pick up cleanly from the latest messages and active subtasks.'
  } else if (mentionedBy) {
    cue = `@${mentionedBy} directly mentioned you in the group. First assess whether this request fits your role: handle your part directly, or explain what belongs elsewhere and @mention the right teammate.`
  } else if (triggerReason === 'lead_review') {
    cue = 'As the Lead Bot, review the new teammate deliverables. Verify results, @mention teammates only if follow-up action is genuinely needed, or call room_finish_task(summary, deliverables) once all work is verified.'
  } else if (replyRequired) {
    cue = [
      'The user directly addressed YOU. Do NOT reply "(pass)".',
      'First assess whether this request fits your role (`team-collaboration` skill):',
      '- If it fits your role, answer or execute it concisely and completely (no unnecessary `@mentions`).',
      '- If part or all of the task belongs to another Bot\'s specialty, explain briefly and `@TeammateName` to pull that Bot in for joint analysis or execution.',
    ].join('\n')
  } else if (directed) {
    cue = 'You were directly addressed. First check if this fits your role; answer concisely or hand off with `@TeammateName` if another specialist should handle it.'
  } else {
    cue = 'First evaluate whether the user\'s message fits your role and scope (`team-collaboration` skill). Only reply if this belongs to you or you have essential value to add; otherwise reply `(pass)` so the right specialist handles it cleanly.'
  }

  const silenceRule = replyRequired
    ? 'Do NOT reply `(pass)` when directly addressed by the user; if you are not the right Bot for the task, explain why and `@Mention` the suitable teammate.'
    : 'Passing is good! If the task does not fit your role, or is already answered with nothing genuinely new to add, reply with exactly `(pass)` so the room settles quietly.'

  const canFinish = effectiveLeadId === '' || effectiveLeadId === speaker.id
  const finishRule = canFinish
    ? 'For multi-step engineering/ops tasks, track milestones with `room_task_progress` and call `room_finish_task({ summary, deliverables })` once verified. For simple questions or introductions, answer directly without creating a heavy progress checklist.'
    : 'For multi-step tasks, update your progress via `room_task_progress` / `claim_subtask` and `@LeadName` only when ready for final acceptance. For simple questions or introductions, answer directly and do NOT create heavy checklists.'

  return [
    ...header,
    ...boardSection,
    ...progressSection,
    '',
    'New messages since your last turn (oldest first):',
    ...deltaLines,
    '',
    cue,
    '',
    'Rules (Hermes Bot Mode + team-collaboration skill):',
    '- **Task-Fit First**: Before acting on any task, check whether it matches YOUR role/tools. Handle what fits you; if it belongs to another specialist, hand off or invite them to analyze together via `@TheirName`.',
    '- **Scope Guard**: Match the user\'s scope! If the user asks a simple question, greeting, or self-introduction ("介绍一下自己"), answer ONLY that question concisely — do NOT launch unrequested deep audits or invent new multi-step projects.',
    '- **Strict Opt-In `@mention` Discipline**: Writing `@TeammateName` wakes that Bot for another turn! ONLY write `@TeammateName` in prose when you genuinely need them to act or analyze next. When merely describing roles, responsibilities, tables, or waiting items, write their plain name or `` `@Name` `` — NEVER bare `@Name`!',
    '- Speak only as yourself. Do not repeat points already made.',
    '- Before modifying shared files concurrently, call `claim_subtask({ taskId, title, paths })` to lock those file paths; update with `status: "completed"` when done so locks release.',
    `- ${finishRule}`,
    '- Do NOT casually write `@user` in intermediate peer collaboration messages; only write `@user` alone (without teammate mentions) when truly blocked on a human decision.',
    `- ${silenceRule}`,
    '- Present concise, well-formatted replies (tables, callouts `> [!TIP|WARNING]`, `<details>`, ````diff````, ````mermaid````, `<artifact>`, or ````metrics````/````file```` cards when helpful); do NOT paste raw noisy tool execution transcripts into the group chat.',
    '- Never call `message_agent` inside a Group Room; coordinate directly in the room.',
  ].join('\n')
}
