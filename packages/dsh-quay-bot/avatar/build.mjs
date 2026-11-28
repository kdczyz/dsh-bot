/**
 * Build script for the embedded Image-bot (Avatar Forge) module.
 *
 * Outputs:
 *   1. `avatar/dist/avatar-engine.js` — zero-dependency browser bundle (IIFE) exposing
 *      `<grok-bot>` and `window.__DSH_AVATAR_ENGINE__`.
 *   2. `avatar/catalog.json` — static 19-avatar catalog + 12 clay palettes consumed by
 *      the zero-dependency Node Host (`host/avatar.js`) and `/botmode/api/avatar/catalog`.
 *
 * Usage:
 *   node packages/dsh-botmode/avatar/build.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const entryPath = join(__dirname, 'src', 'entry.ts')
const distDir = join(__dirname, 'dist')
const bundlePath = join(distDir, 'avatar-engine.js')
const catalogPath = join(__dirname, 'catalog.json')

const esbuildCandidates = [
  process.env.ESBUILD_BIN,
  resolve(__dirname, 'node_modules/.bin/esbuild'),
  '/home/ubuntu/Desktop/Image-bot/node_modules/.bin/esbuild',
].filter(Boolean)

const esbuildBin = esbuildCandidates.find((p) => existsSync(p))
if (!esbuildBin) {
  throw new Error(`esbuild binary not found in: ${esbuildCandidates.join(', ')}`)
}

mkdirSync(distDir, { recursive: true })

// 1. Build browser IIFE bundle
execFileSync(esbuildBin, [
  entryPath,
  '--bundle',
  '--format=iife',
  '--global-name=__DSH_AVATAR_BUNDLE__',
  '--target=es2020',
  '--minify',
  `--outfile=${bundlePath}`,
], { stdio: 'inherit' })

// 2. Build a temporary CJS bundle to evaluate and emit `catalog.json` cleanly without tsx
const tmpCjs = join(distDir, '.catalog-gen.cjs')
execFileSync(esbuildBin, [
  entryPath,
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  `--outfile=${tmpCjs}`,
], { stdio: 'inherit' })

if (typeof globalThis.HTMLElement === 'undefined') {
  globalThis.HTMLElement = class {}
}
const require = createRequire(import.meta.url)
const mod = require(tmpCjs)
const catalog = {
  version: 1,
  defaultAvatarId: mod.DEFAULT_AVATAR_ID,
  defaultColor: mod.DEFAULT_AVATAR_COLOR,
  defaultEyeColor: mod.DEFAULT_AVATAR_EYE_COLOR,
  items: mod.ALL_AVATARS,
  palettes: mod.PALETTES,
  eyeSwatches: ['#151515', '#1b1b1b', '#ffffff', '#0a7cff', '#e11d48'],
  materials: ['flat', 'fluffy'],
  states: ['idle', 'thinking', 'working', 'waiting', 'blocked', 'done', 'alert'],
  moods: mod.EXPRESSIONS,
}
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')

// Clean up temporary CJS artifact
execFileSync('rm', ['-f', tmpCjs])
console.log(`Built avatar-engine.js and catalog.json (${catalog.items.length} avatars, ${catalog.palettes.length} palettes).`)
