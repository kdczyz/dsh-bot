/**
 * Agent reply artifact extraction, safe ID/filename/MIME inference and
 * workspace-confined deliverable file resolution.
 */
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
export const SAFE_ARTIFACT_ID_RE = /^[A-Za-z0-9._-]{1,96}$/

const EXT_BY_TYPE = {
  html: 'html',
  htm: 'html',
  markdown: 'md',
  md: 'md',
  json: 'json',
  yaml: 'yaml',
  yml: 'yml',
  xml: 'xml',
  svg: 'svg',
  csv: 'csv',
  tsv: 'tsv',
  python: 'py',
  py: 'py',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  css: 'css',
  sql: 'sql',
  shell: 'sh',
  sh: 'sh',
  bash: 'sh',
  pdf: 'pdf',
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  webp: 'webp',
  gif: 'gif',
  zip: 'zip',
  text: 'txt',
  txt: 'txt',
  code: 'txt',
}

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function isValidArtifactId(id) {
  return typeof id === 'string' && SAFE_ARTIFACT_ID_RE.test(id) && id !== '.' && id !== '..'
}

export function stableArtifactId(prefix, seed) {
  const hash = createHash('sha256').update(String(seed ?? '')).digest('hex').slice(0, 14)
  return `${prefix}_${hash}`
}

export function makeReplyArtifactId({ botId = '', roomId = '', messageId = '', index = 0, title = '', content = '' }) {
  const key = messageId
    ? `msg:${roomId}:${botId}:${messageId}:${index}`
    : `body:${roomId}:${botId}:${title}:${createHash('sha256').update(String(content ?? '')).digest('hex')}`
  return stableArtifactId('art', key)
}

export function makeDeliverableArtifactId(roomId, filePath) {
  return stableArtifactId('deliv', `${String(roomId ?? '')}:${String(filePath ?? '').trim()}`)
}

export function sanitizeArtifactFilename(rawName, title = '', type = '') {
  const stripped = String(rawName ?? '').trim().replace(/\\/g, '/')
  let base = stripped ? basename(stripped) : ''
  base = base.replace(/[\x00-\x1f\x7f"<>|*?:/\\]+/g, '_').replace(/^[ .]+|[ .]+$/g, '')
  if (base) return base.slice(0, 180)
  const fromTitle = String(title ?? '')
    .trim()
    .replace(/[\x00-\x1f\x7f"<>|*?:/\\]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 120) || 'artifact'
  const ext = EXT_BY_TYPE[String(type ?? '').trim().toLowerCase()] || ''
  if (ext && !fromTitle.toLowerCase().endsWith(`.${ext}`)) {
    return `${fromTitle}.${ext}`
  }
  return fromTitle
}

export function inferArtifactMimeType(filename = '', type = '', explicit = '') {
  const cleanExplicit = String(explicit ?? '').replace(/[\r\n]+/g, '').trim()
  if (cleanExplicit) return cleanExplicit
  const ext = extname(String(filename ?? '')).toLowerCase()
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext]
  const tExt = EXT_BY_TYPE[String(type ?? '').trim().toLowerCase()]
  if (tExt && MIME_BY_EXT[`.${tExt}`]) return MIME_BY_EXT[`.${tExt}`]
  return 'application/octet-stream'
}

export function buildContentDisposition(filename, inline = false) {
  const safe = sanitizeArtifactFilename(filename)
  let ascii = safe.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, "'").replace(/^[ .]+|[ .]+$/g, '')
  if (!ascii) {
    const ext = extname(safe)
    ascii = `artifact${/^\.[A-Za-z0-9]{1,12}$/.test(ext) ? ext : ''}`
  }
  const disp = inline ? 'inline' : 'attachment'
  return `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

/**
 * Extract all `<artifact ...>...</artifact>` blocks from an Agent reply.
 */
export function extractXmlArtifacts(text, meta = {}) {
  if (typeof text !== 'string' || !text.includes('<artifact')) return []
  const out = []
  const re = /<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/gi
  let idx = 0
  for (const match of text.matchAll(re)) {
    const attrs = match[1] || ''
    const title = (/title="([^"]+)"/i.exec(attrs)?.[1] ?? /title='([^']+)'/i.exec(attrs)?.[1] ?? 'Artifact').trim()
    const type = (/type="([^"]+)"/i.exec(attrs)?.[1] ?? /type='([^']+)'/i.exec(attrs)?.[1] ?? 'code').trim().toLowerCase()
    const explicitFile = (/filename="([^"]+)"/i.exec(attrs)?.[1] ?? /filename='([^']+)'/i.exec(attrs)?.[1] ?? '').trim()
    const content = String(match[2] ?? '').replace(/^\r?\n/, '').replace(/\r?\n$/, '')
    const filename = sanitizeArtifactFilename(explicitFile, title, type)
    const mimeType = inferArtifactMimeType(filename, type)
    const artifactId = makeReplyArtifactId({
      botId: meta.botId || '',
      roomId: meta.roomId || '',
      messageId: meta.messageId || '',
      index: idx,
      title,
      content,
    })
    out.push({
      id: artifactId,
      artifactId,
      kind: 'artifact',
      title,
      type,
      filename,
      mimeType,
      size: Buffer.byteLength(content, 'utf8'),
      content,
      preview: content.trim().slice(0, 400),
      botId: meta.botId || '',
      botName: meta.botName || '',
      roomId: meta.roomId || '',
      roomName: meta.roomName || '',
      messageId: meta.messageId || '',
      at: meta.at || new Date().toISOString(),
    })
    idx += 1
  }
  return out
}

/**
 * Resolve a deliverable or workspace file path strictly inside `allowedRoots`,
 * verifying realpath to block symlink escapes and rejecting directories or oversized files.
 */
export async function resolveSafeWorkspaceFile(filePath, allowedRoots = []) {
  const raw = String(filePath ?? '').trim()
  if (!raw) return null
  const roots = []
  for (const dir of allowedRoots) {
    if (typeof dir !== 'string' || dir.trim() === '') continue
    try {
      const rp = await realpath(resolve(dir))
      if (!roots.includes(rp)) roots.push(rp)
    } catch (_error) {
      // ignore nonexistent root
    }
  }
  if (roots.length === 0) return null

  const candidates = []
  if (isAbsolute(raw)) {
    candidates.push(resolve(raw))
  } else {
    for (const root of roots) {
      candidates.push(resolve(root, raw))
    }
  }

  for (const candidate of candidates) {
    let realTarget
    try {
      realTarget = await realpath(candidate)
    } catch (_error) {
      continue
    }
    const inside = roots.some((root) => {
      const rel = relative(root, realTarget)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
    if (!inside) continue
    try {
      const info = await stat(realTarget)
      if (!info.isFile()) continue
      if (info.size > MAX_ARTIFACT_BYTES) {
        const err = new Error(`Artifact file exceeds max size (${MAX_ARTIFACT_BYTES} bytes)`)
        err.status = 413
        throw err
      }
      return { path: realTarget, size: info.size, mtimeMs: info.mtimeMs }
    } catch (error) {
      if (error?.status === 413) throw error
    }
  }
  return null
}
