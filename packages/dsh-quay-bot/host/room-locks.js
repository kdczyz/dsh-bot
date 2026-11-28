/**
 * Shared Task Board & Path Soft-Lock primitives for concurrent Group Room Bots.
 *
 * Prevents two concurrent Bots from silently overwriting the same file while
 * executing subtasks in parallel. Supports exact file paths, directory prefix
 * leases, and extraction across DSH file-mutating tools (`write`, `edit`,
 * `apply_patch`, `str_replace_editor`).
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MUTATING_FILE_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'str_replace_editor',
  'write_file',
  'edit_file',
])

const SHELL_TOOLS = new Set([
  'bash',
  'sh',
  'shell',
  'exec',
  'run_command',
  'terminal',
])

const extractShellMutatedPaths = (command, baseDir = '') => {
  const cmd = String(command ?? '')
  if (cmd === '') return []
  const out = new Set()
  const add = (raw) => {
    const cleaned = String(raw ?? '').trim().replace(/^['"]|['"]$/g, '')
    if (!cleaned || cleaned.startsWith('-') || cleaned === '/dev/null' || cleaned.startsWith('&')) return
    const norm = normalizeLeasePath(cleaned, baseDir)
    if (norm) out.add(norm)
  }
  // Redirections `> file`, `>> file`, `1> file`, `>| file`
  for (const m of cmd.matchAll(/(?:^|[\s;&|])(?:\d?>>?|\d?>\|)\s*(['"]?[^'"\s;|&<>]+['"]?)/g)) {
    add(m[1])
  }
  // `tee [-a] file`
  for (const m of cmd.matchAll(/(?:^|[|;&\s])tee\s+(?:-[a-zA-Z]+\s+)*(['"]?[^'"\s;|&<>]+['"]?)/g)) {
    add(m[1])
  }
  // `sed -i ... file` (last non-flag arg before pipe/semicolon)
  for (const m of cmd.matchAll(/(?:^|[|;&\s])sed\s+[^|;&]*?-i(?:\S*)?\s+[^|;&]+?\s+(['"]?[^'"\s;|&<>-]+['"]?)(?=\s*(?:[|;&]|$))/g)) {
    add(m[1])
  }
  return [...out]
}

const toPosix = (value) => String(value ?? '').replace(/\\/g, '/')

/**
 * Normalize a claimed or targeted file/directory path into a canonical absolute
 * POSIX-slash string so relative and absolute references match deterministically.
 */
export function normalizeLeasePath(rawPath, baseDir = '') {
  const trimmed = String(rawPath ?? '').trim()
  if (trimmed === '') return ''
  const root = typeof baseDir === 'string' && baseDir.trim() !== '' ? baseDir.trim() : process.cwd()
  const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed)
  const posix = toPosix(resolved)
  return posix.length > 1 ? posix.replace(/\/+$/, '') : posix
}

/**
 * Format a path relative to `baseDir` when inside it, otherwise return the path.
 */
export function displayLeasePath(absPath, baseDir = '') {
  if (!absPath) return ''
  if (typeof baseDir === 'string' && baseDir.trim() !== '') {
    const rel = toPosix(relative(resolve(baseDir.trim()), absPath))
    if (rel !== '' && !rel.startsWith('..')) return rel
    if (rel === '') return '.'
  }
  return toPosix(absPath)
}

/**
 * True when two normalized paths refer to the same file or one encloses the other
 * as a parent directory lease.
 */
export function pathsConflict(pathA, pathB) {
  if (!pathA || !pathB) return false
  if (pathA === pathB) return true
  const prefixA = pathA === '/' ? '/' : `${pathA}/`
  const prefixB = pathB === '/' ? '/' : `${pathB}/`
  return pathB.startsWith(prefixA) || pathA.startsWith(prefixB)
}

/**
 * Extract all target file paths from a DSH tool invocation's arguments when the
 * tool mutates files on disk. Read-only calls (e.g. `str_replace_editor` `view`)
 * return an empty array.
 */
export function extractMutatedPathsFromTool(toolName, args, baseDir = '') {
  const name = String(toolName ?? '').trim()
  if (!args || typeof args !== 'object') return []
  if (SHELL_TOOLS.has(name)) {
    return extractShellMutatedPaths(args.command ?? args.cmd ?? args.script ?? '', baseDir)
  }
  if (!MUTATING_FILE_TOOLS.has(name)) return []

  if (name === 'str_replace_editor') {
    const cmd = String(args.command ?? '').trim().toLowerCase()
    if (cmd === 'view' || cmd === '') return []
    const norm = normalizeLeasePath(args.path, baseDir)
    return norm ? [norm] : []
  }

  if (name === 'apply_patch') {
    const out = new Set()
    if (typeof args.path === 'string') {
      const direct = normalizeLeasePath(args.path, baseDir)
      if (direct) out.add(direct)
    }
    const patchText = String(args.patch ?? args.input ?? args.diff ?? '')
    if (patchText !== '') {
      const markerRe = /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):\s+(.+)$/gm
      for (const match of patchText.matchAll(markerRe)) {
        const candidate = normalizeLeasePath(match[1], baseDir)
        if (candidate) out.add(candidate)
      }
      // Also recognize standard Unified Diff headers (`+++ b/path` / `--- a/path`)
      const unifiedRe = /^(?:\+\+\+|---)\s+(?:[ab]\/)?([^\t\r\n]+)$/gm
      for (const match of patchText.matchAll(unifiedRe)) {
        const rawPath = match[1].trim()
        if (rawPath === '/dev/null' || rawPath === '') continue
        const candidate = normalizeLeasePath(rawPath, baseDir)
        if (candidate) out.add(candidate)
      }
    }
    return [...out]
  }

  // `write`, `edit`, `write_file`, `edit_file`
  const raw = args.path ?? args.file_path ?? args.filePath ?? args.target_file ?? ''
  const norm = normalizeLeasePath(raw, baseDir)
  return norm ? [norm] : []
}

/**
 * Check whether `callerBotId` is blocked from mutating a path leased by another
 * active subtask in `room`. Returns `undefined` when allowed, or a localized
 * human/model-readable soft-lock message when blocked.
 */
export function checkRoomWriteSoftLock({ room, callerBotId, toolName, args, baseDir = '' }) {
  if (!room || !callerBotId) return undefined
  const subtasks = Array.isArray(room.subtasks) ? room.subtasks : []
  if (subtasks.length === 0) return undefined

  const effectiveBase = room.workDir || baseDir
  const targets = extractMutatedPathsFromTool(toolName, args, effectiveBase)
  if (targets.length === 0) return undefined

  for (const target of targets) {
    for (const subtask of subtasks) {
      if (!subtask || subtask.status !== 'in_progress') continue
      if (!subtask.ownerBotId || subtask.ownerBotId === callerBotId) continue
      const leasedPaths = Array.isArray(subtask.paths) ? subtask.paths : []
      for (const rawLease of leasedPaths) {
        const leased = normalizeLeasePath(rawLease, effectiveBase)
        if (pathsConflict(leased, target)) {
          const shown = displayLeasePath(target, effectiveBase)
          const owner = subtask.ownerName || subtask.ownerBotId
          return `文件 "${shown}" 正由 @${owner} 编辑中（子任务：${subtask.taskId}），请先在群里 @${owner} 同步或处理其他子任务。`
        }
      }
    }
  }
  return undefined
}

/**
 * Check whether claiming `requestedPaths` for `callerBotId` collides with any
 * active (`in_progress`) subtask owned by another Bot in `room`.
 */
export function findSubtaskClaimConflicts(room, callerBotId, requestedPaths, baseDir = '') {
  const conflicts = []
  if (!room || !Array.isArray(requestedPaths) || requestedPaths.length === 0) return conflicts
  const effectiveBase = room.workDir || baseDir
  const subtasks = Array.isArray(room.subtasks) ? room.subtasks : []

  for (const rawCandidate of requestedPaths) {
    const candidate = normalizeLeasePath(rawCandidate, effectiveBase)
    if (!candidate) continue
    for (const subtask of subtasks) {
      if (!subtask || subtask.status !== 'in_progress') continue
      if (!subtask.ownerBotId || subtask.ownerBotId === callerBotId) continue
      for (const rawLease of subtask.paths || []) {
        const leased = normalizeLeasePath(rawLease, effectiveBase)
        if (pathsConflict(leased, candidate)) {
          conflicts.push({
            path: displayLeasePath(candidate, effectiveBase),
            taskId: subtask.taskId,
            ownerBotId: subtask.ownerBotId,
            ownerName: subtask.ownerName || subtask.ownerBotId,
          })
        }
      }
    }
  }
  return conflicts
}

/**
 * Format the room's shared task board & file leases for injection into room prompts.
 */
export function formatRoomTaskBoard(room) {
  const subtasks = Array.isArray(room?.subtasks) ? room.subtasks : []
  const visible = subtasks.filter(item => item.status === 'in_progress' || item.status === 'completed')
  if (visible.length === 0) return ''
  const baseDir = room?.workDir || ''
  return visible.map((item) => {
    const badge = item.status === 'completed' ? '[DONE]' : '[LOCKED/IN_PROGRESS]'
    const paths = (item.paths || []).map(p => displayLeasePath(normalizeLeasePath(p, baseDir), baseDir)).filter(Boolean)
    const pathSuffix = paths.length > 0 ? ` · paths: ${paths.join(', ')}` : ''
    const titleSuffix = item.title ? ` — ${item.title}` : ''
    return `- ${badge} ${item.taskId}${titleSuffix} (owner: @${item.ownerName || item.ownerBotId})${pathSuffix}`
  }).join('\n')
}
