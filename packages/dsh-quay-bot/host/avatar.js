/**
 * Host-side Bot Avatar catalog, validation, normalization & randomizer.
 *
 * Strictly aligned with:
 *   1. Embedded Image-bot (Avatar Forge) 19-avatar catalog & 12 clay palettes
 *   2. `public-bot` Android client's 12-field `BotAvatarPrefs` schema:
 *      { avatarId, customJson, color, eyeColor, material, clay, yaw, pitch,
 *        orbit, badge, depth, followPointer }
 *
 * Zero external runtime dependencies: reads prebuilt `avatar/catalog.json` and
 * `avatar/dist/avatar-engine.js` directly via Node's `fs`.
 */
import { readFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AVATAR_ROOT = join(__dirname, '..', 'avatar')
const CATALOG_PATH = join(AVATAR_ROOT, 'catalog.json')
const BUNDLE_PATH = join(AVATAR_ROOT, 'dist', 'avatar-engine.js')

const MAX_CUSTOM_JSON_BYTES = 32 * 1024
const VALID_MATERIALS = new Set(['flat', 'fluffy'])
const SVG_PATH_RE = /^[0-9eE.+\-,\sMmLlHhVvCcSsQqTtAaZz]+$/

let _catalogCache = null
let _bundleCache = null

export function avatarCatalog() {
  if (_catalogCache) return _catalogCache
  const raw = readFileSync(CATALOG_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  _catalogCache = parsed
  return _catalogCache
}

export function avatarBundleScript() {
  if (_bundleCache !== null) return _bundleCache
  _bundleCache = readFileSync(BUNDLE_PATH, 'utf8')
  return _bundleCache
}

function catalogMaps() {
  const cat = avatarCatalog()
  const idSet = new Set()
  const byId = new Map()
  for (const item of cat.items || []) {
    if (item && typeof item.id === 'string') {
      idSet.add(item.id)
      byId.set(item.id, item)
    }
  }
  return { cat, idSet, byId }
}

/** Normalize `#rgb` / `#rrggbb` to lowercase `#rrggbb`, or return null if invalid. */
export function normalizeHex(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  const short = /^#([0-9a-fA-F]{3})$/.exec(trimmed)
  if (short) {
    const [r, g, b] = short[1]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(trimmed)
  if (full) return `#${full[1].toLowerCase()}`
  return null
}

/** Pick a high-contrast eye ink color (`#1b1b1b` or `#ffffff`) for a body hex color. */
export function autoEyeHex(bodyHex) {
  const hex = normalizeHex(bodyHex) || '#ff8a1f'
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum < 0.22 ? '#f8fafc' : '#1b1b1b'
}

/** Resolve a built-in avatarId (accepts bare shape names like `circle` -> `shape-circle`). */
export function resolveCatalogAvatarId(rawId) {
  const { idSet } = catalogMaps()
  if (typeof rawId !== 'string') return null
  const key = rawId.trim().toLowerCase()
  if (!key) return null
  if (idSet.has(key)) return key
  if (idSet.has(`shape-${key}`)) return `shape-${key}`
  return null
}

/** Validate a custom `version: 1` Image-bot / Avatar Forge definition JSON string. */
export function validateCustomAvatarJson(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: '' }
  if (typeof raw !== 'string') return { ok: false, error: 'customJson must be a string.' }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: '' }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_CUSTOM_JSON_BYTES) {
    return { ok: false, error: 'customJson exceeds 32 KB limit.' }
  }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (_err) {
    return { ok: false, error: 'customJson is not valid JSON.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'customJson must be a JSON object.' }
  }
  if (parsed.version !== 1) {
    return { ok: false, error: 'customJson.version must be 1.' }
  }
  if (!parsed.body || typeof parsed.body !== 'object' || typeof parsed.body.path !== 'string') {
    return { ok: false, error: 'customJson.body.path must be a non-empty SVG path string.' }
  }
  const pathStr = parsed.body.path.trim()
  if (pathStr === '' || pathStr.length > 6000) {
    return { ok: false, error: 'customJson.body.path must be between 1 and 6000 characters.' }
  }
  if (!SVG_PATH_RE.test(pathStr)) {
    return { ok: false, error: 'customJson.body.path contains unsupported characters.' }
  }
  const eyes = parsed.eyes
  if (!eyes || typeof eyes !== 'object' || Array.isArray(eyes)) {
    return { ok: false, error: 'customJson.eyes must be an object with x, y, spacing, scale.' }
  }
  const x = Number(eyes.x)
  const y = Number(eyes.y)
  const spacing = Number(eyes.spacing)
  const scale = Number(eyes.scale)
  if (![x, y, spacing, scale].every(Number.isFinite)) {
    return { ok: false, error: 'customJson.eyes x/y/spacing/scale must be finite numbers.' }
  }
  if (scale < 0.6 || scale > 1.8) {
    return { ok: false, error: 'customJson.eyes.scale must be within 0.6..1.8.' }
  }
  if (spacing <= 0 || spacing > 40) {
    return { ok: false, error: 'customJson.eyes.spacing must be within (0, 40].' }
  }
  const id = typeof parsed.id === 'string' && parsed.id.trim() !== ''
    ? parsed.id.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)
    : 'custom'
  const name = typeof parsed.name === 'string' && parsed.name.trim() !== ''
    ? parsed.name.trim().replace(/[\u0000-\u001f<>]/g, '').slice(0, 40)
    : 'Custom'
  const normalized = {
    version: 1,
    id: id || 'custom',
    name: name || 'Custom',
    body: { path: pathStr },
    eyes: { x, y, spacing, scale },
  }
  return { ok: true, value: JSON.stringify(normalized) }
}

const clampNum = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

const hash32 = (text) => {
  let h = 2166136261 >>> 0
  const str = String(text ?? '')
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** Default fallback avatar object matching `public-bot`'s `BotAvatarPrefs`. */
export function defaultAvatar(overrides = {}) {
  const cat = avatarCatalog()
  const color = normalizeHex(overrides.color) || cat.defaultColor || '#ff8a1f'
  return {
    avatarId: resolveCatalogAvatarId(overrides.avatarId) || cat.defaultAvatarId || 'mochi',
    customJson: '',
    color,
    eyeColor: normalizeHex(overrides.eyeColor) || autoEyeHex(color),
    material: 'flat',
    clay: true,
    yaw: 0,
    pitch: 0,
    orbit: false,
    badge: false,
    depth: 6,
    followPointer: true,
  }
}

/** Deterministic avatar for migrating legacy Bots that predate the `avatar` field. */
export function deterministicAvatar(seed, preferredColor = '') {
  const cat = avatarCatalog()
  const items = cat.items || []
  const palettes = cat.palettes || []
  const h = hash32(seed || 'bot')
  const pickedItem = items.length > 0 ? items[h % items.length] : { id: 'mochi' }
  const pickedPalette = palettes.length > 0 ? palettes[(h >>> 4) % palettes.length] : null
  const color = normalizeHex(preferredColor) || pickedPalette?.base || cat.defaultColor || '#ff8a1f'
  const eyeColor = pickedPalette && normalizeHex(preferredColor) === normalizeHex(pickedPalette.base)
    ? (normalizeHex(pickedPalette.eye) || autoEyeHex(color))
    : autoEyeHex(color)
  return {
    avatarId: pickedItem.id,
    customJson: '',
    color,
    eyeColor,
    material: 'flat',
    clay: true,
    yaw: 0,
    pitch: 0,
    orbit: false,
    badge: false,
    depth: 6,
    followPointer: true,
  }
}

/**
 * Randomly generate a balanced Bot avatar from the 19-avatar catalog and 12 clay palettes.
 * Prefers unused `avatarId`s (and unused `(avatarId, color)` pairs) relative to `existingBots`.
 */
export function randomAvatar({ existingBots = [], preferredColor = '' } = {}) {
  const cat = avatarCatalog()
  const items = cat.items || []
  const palettes = (cat.palettes || []).filter((p) => p && normalizeHex(p.base))
  const usedIds = new Set()
  const usedPairs = new Set()
  for (const bot of existingBots) {
    const av = bot?.avatar
    if (av && typeof av.avatarId === 'string') {
      usedIds.add(av.avatarId)
      if (typeof av.color === 'string') {
        usedPairs.add(`${av.avatarId}:${av.color.toLowerCase()}`)
      }
    }
  }

  const unusedItems = items.filter((item) => !usedIds.has(item.id))
  const itemPool = unusedItems.length > 0 ? unusedItems : items
  const pickedItem = itemPool.length > 0
    ? itemPool[randomInt(itemPool.length)]
    : { id: cat.defaultAvatarId || 'mochi' }

  const explicitColor = normalizeHex(preferredColor)
  let color = explicitColor
  let eyeColor = null
  if (!color) {
    // Prefer vivid palettes that haven't been paired with this avatarId yet
    const vividPalettes = palettes.filter((p) => p.id !== 'obsidian' && p.id !== 'pearl')
    const basePool = vividPalettes.length > 0 ? vividPalettes : palettes
    const unusedPalettes = basePool.filter((p) => !usedPairs.has(`${pickedItem.id}:${p.base.toLowerCase()}`))
    const palPool = unusedPalettes.length > 0 ? unusedPalettes : basePool
    const pickedPal = palPool.length > 0 ? palPool[randomInt(palPool.length)] : null
    color = normalizeHex(pickedPal?.base) || cat.defaultColor || '#ff8a1f'
    eyeColor = normalizeHex(pickedPal?.eye) || autoEyeHex(color)
  } else {
    const matchedPal = palettes.find((p) => normalizeHex(p.base) === color)
    eyeColor = normalizeHex(matchedPal?.eye) || autoEyeHex(color)
  }

  return {
    avatarId: pickedItem.id,
    customJson: '',
    color,
    eyeColor,
    material: 'flat',
    clay: true,
    yaw: 0,
    pitch: 0,
    orbit: false,
    badge: false,
    depth: 6,
    followPointer: true,
  }
}

/** True when the client explicitly supplied a custom avatar configuration (not empty / random). */
export function hasExplicitAvatar(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  if (raw.mode === 'random' || raw.random === true) return false
  const keys = [
    'avatarId', 'customJson', 'color', 'eyeColor', 'material',
    'clay', 'yaw', 'pitch', 'orbit', 'badge', 'depth', 'followPointer',
  ]
  return keys.some((k) => {
    const v = raw[k]
    if (v === undefined || v === null) return false
    if (typeof v === 'string') return v.trim() !== ''
    return true
  })
}

/**
 * Normalize an arbitrary avatar input into the canonical 12-field `BotAvatarPrefs` object.
 * When `strict` is true, invalid `customJson` or unknown non-empty values throw an Error.
 */
export function normalizeAvatar(raw, { fallback, strict = false } = {}) {
  const base = fallback ? { ...defaultAvatar(), ...fallback } : defaultAvatar()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base

  const resolvedId = raw.avatarId !== undefined
    ? resolveCatalogAvatarId(raw.avatarId)
    : base.avatarId
  if (strict && raw.avatarId !== undefined && String(raw.avatarId).trim() !== '' && !resolvedId) {
    throw new Error(`Unknown avatarId "${String(raw.avatarId)}".`)
  }

  let customJson = base.customJson || ''
  if (raw.customJson !== undefined) {
    const checked = validateCustomAvatarJson(raw.customJson)
    if (!checked.ok) {
      if (strict) throw new Error(checked.error)
      customJson = ''
    } else {
      customJson = checked.value
    }
  }

  const parsedColor = raw.color !== undefined ? normalizeHex(raw.color) : normalizeHex(base.color)
  if (strict && raw.color !== undefined && String(raw.color).trim() !== '' && !parsedColor) {
    throw new Error(`Invalid avatar color "${String(raw.color)}". Expected #rgb or #rrggbb.`)
  }
  const color = parsedColor || base.color

  const parsedEye = raw.eyeColor !== undefined ? normalizeHex(raw.eyeColor) : normalizeHex(base.eyeColor)
  if (strict && raw.eyeColor !== undefined && String(raw.eyeColor).trim() !== '' && !parsedEye) {
    throw new Error(`Invalid avatar eyeColor "${String(raw.eyeColor)}". Expected #rgb or #rrggbb.`)
  }
  const eyeColor = parsedEye || (raw.color !== undefined && raw.eyeColor === undefined ? autoEyeHex(color) : base.eyeColor)

  const material = typeof raw.material === 'string' && VALID_MATERIALS.has(raw.material.trim().toLowerCase())
    ? raw.material.trim().toLowerCase()
    : base.material

  const badge = raw.badge === undefined
    ? Boolean(base.badge)
    : (raw.badge === true || raw.badge === 'red' || raw.badge === 'blue')

  return {
    avatarId: resolvedId || base.avatarId,
    customJson,
    color,
    eyeColor,
    material,
    clay: raw.clay === undefined ? Boolean(base.clay) : Boolean(raw.clay),
    yaw: Number(clampNum(raw.yaw, -0.9, 0.9, base.yaw).toFixed(4)),
    pitch: Number(clampNum(raw.pitch, -0.6, 0.6, base.pitch).toFixed(4)),
    orbit: raw.orbit === undefined ? Boolean(base.orbit) : Boolean(raw.orbit),
    badge,
    depth: Number(clampNum(raw.depth, 0, 14, base.depth).toFixed(2)),
    followPointer: raw.followPointer === undefined ? Boolean(base.followPointer) : Boolean(raw.followPointer),
  }
}
