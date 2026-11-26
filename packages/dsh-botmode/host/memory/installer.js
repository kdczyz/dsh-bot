/**
 * Memory plugin installer & uninstaller.
 *
 * Installs third-party or catalog memory plugins into
 * `$DSH_HOME/botmode/memory-plugins/<id>/` as standard DSH memory plugin folders
 * (`plugin.json` + ESM `index.js`), validating both the manifest and dynamic
 * ESM import before committing the directory atomically.
 *
 * Supported sources:
 *   - `catalog:<id>`                 curated templates (e.g. `catalog:mem0_http`)
 *   - `/path/to/plugin-dir`          local directory containing `plugin.json`
 *   - `https://.../plugin.tgz`       remote tarball archive
 *   - `https://github.com/...`       git repository (shallow clone)
 *   - `npm:<package[@version]>`      npm package fetched via `npm pack`
 */
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { normalizeProviderId, validatePluginManifest } from './protocol.js'
import { getCatalogTemplate } from './catalog.js'
import { isStrictSubpath } from '../store.js'

const execFileAsync = promisify(execFile)
const MAX_TARBALL_BYTES = 32 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000
const SAFE_NPM_SPEC_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:@[a-z0-9-._~^>=<*]+)?$/i

const extractSafeTarball = async (tgzPath, extractDir) => {
  const { stdout } = await execFileAsync('tar', ['-tzf', tgzPath], { timeout: 30_000 })
  for (const rawEntry of stdout.split(/\r?\n/)) {
    const entry = rawEntry.trim()
    if (entry === '') continue
    if (entry.startsWith('/') || entry.startsWith('\\') || /(^|[\\/])\.\.([\\/]|$)/.test(entry)) {
      throw new Error(`Refused unsafe archive path "${entry}".`)
    }
  }
  await execFileAsync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', tgzPath, '-C', extractDir], { timeout: 60_000 })
}

const downloadBoundedBuffer = async (url, maxBytes) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Archive exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`)
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new Error(`Archive exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`)
    return buf
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`Archive exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks, total)
}

const exists = async (path) => {
  try { await stat(path); return true } catch (_error) { return false }
}

const findPluginRoot = async (dir) => {
  const candidates = [
    dir,
    join(dir, 'package'),
    join(dir, 'dsh-memory-plugin'),
    join(dir, 'plugin'),
  ]
  for (const candidate of candidates) {
    if (await exists(join(candidate, 'plugin.json'))) return candidate
  }
  // One level deep scan (common for GitHub tarballs with top-level repo folder)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = join(dir, entry.name)
    if (await exists(join(nested, 'plugin.json'))) return nested
    if (await exists(join(nested, 'dsh-memory-plugin', 'plugin.json'))) return join(nested, 'dsh-memory-plugin')
  }
  return undefined
}

const loadAndValidateDir = async (dir) => {
  const manifestPath = join(dir, 'plugin.json')
  if (!await exists(manifestPath)) {
    throw new Error('Memory plugin package is missing `plugin.json`.')
  }
  let raw
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid plugin.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  const checked = validatePluginManifest(raw)
  if (!checked.ok) throw new Error(checked.error)
  const manifest = checked.manifest
  const entryPath = resolve(dir, manifest.entry)
  if (!isStrictSubpath(dir, entryPath)) {
    throw new Error('Plugin entry escapes plugin directory.')
  }
  if (!await exists(entryPath)) {
    throw new Error(`Plugin entry "${manifest.entry}" not found.`)
  }
  const realDir = await realpath(dir)
  const realEntry = await realpath(entryPath)
  if (!isStrictSubpath(realDir, realEntry)) {
    throw new Error('Plugin entry symlink escapes plugin directory.')
  }
  // Smoke-import the ESM entry to verify syntax and exported factory.
  const mod = await import(`${pathToFileURL(entryPath).href}?verify=${Date.now()}`)
  const factory = mod.createProvider ?? mod.default
  if (typeof factory !== 'function') {
    throw new Error(`Plugin entry "${manifest.entry}" must export \`createProvider(manifest, config, host)\` or a default factory/class.`)
  }
  return manifest
}

export class MemoryPluginInstaller {
  constructor(pluginsRoot, bundledIds = new Set(), logger = undefined) {
    this.pluginsRoot = pluginsRoot
    this.bundledIds = bundledIds
    this.logger = logger
  }

  /**
   * Download/copy, validate and install a memory plugin from `source`.
   * @param {string} rawSource
   * @param {{ overwrite?: boolean, idOverride?: string }} [options]
   */
  async install(rawSource, options = {}) {
    const source = String(rawSource ?? '').trim()
    if (source === '') throw new Error('Provide a memory plugin source (catalog:<id>, local path, git URL, tarball URL or npm:<pkg>).')

    await mkdir(this.pluginsRoot, { recursive: true })
    const stage = await mkdtemp(join(tmpdir(), 'dsh-mem-install-'))
    try {
      let pluginSourceDir
      if (source.startsWith('catalog:')) {
        const catalogId = normalizeProviderId(source.slice('catalog:'.length))
        const tpl = getCatalogTemplate(catalogId)
        if (!tpl) throw new Error(`Unknown catalog memory plugin "${catalogId}".`)
        pluginSourceDir = join(stage, catalogId)
        await mkdir(pluginSourceDir, { recursive: true })
        await writeFile(join(pluginSourceDir, 'plugin.json'), `${JSON.stringify(tpl.manifest, null, 2)}\n`, 'utf8')
        await writeFile(join(pluginSourceDir, tpl.manifest.entry || 'index.js'), tpl.indexJs, 'utf8')
      } else if (source.startsWith('npm:')) {
        const pkg = source.slice('npm:'.length).trim()
        if (pkg === '' || pkg.startsWith('-') || !SAFE_NPM_SPEC_RE.test(pkg)) {
          throw new Error('Invalid npm package specifier.')
        }
        const packDir = join(stage, 'pack')
        const extractDir = join(stage, 'extract')
        await mkdir(packDir, { recursive: true })
        await mkdir(extractDir, { recursive: true })
        const { stdout } = await execFileAsync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir, '--', pkg], { timeout: 120_000 })
        const tgzName = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
        if (!tgzName) throw new Error('npm pack did not produce a tarball.')
        await extractSafeTarball(join(packDir, tgzName), extractDir)
        pluginSourceDir = await findPluginRoot(extractDir)
        if (!pluginSourceDir) throw new Error(`npm package "${pkg}" does not contain a DSH memory plugin (plugin.json missing).`)
      } else if (/^https?:\/\/.+\.(tgz|tar\.gz)(\?.*)?$/i.test(source)) {
        const tgzBuf = await downloadBoundedBuffer(source, MAX_TARBALL_BYTES)
        const tgzPath = join(stage, 'plugin.tgz')
        const extractDir = join(stage, 'extract')
        await mkdir(extractDir, { recursive: true })
        await writeFile(tgzPath, tgzBuf)
        await extractSafeTarball(tgzPath, extractDir)
        pluginSourceDir = await findPluginRoot(extractDir)
        if (!pluginSourceDir) throw new Error('Downloaded archive does not contain plugin.json.')
      } else if (/^(git\+|https?:\/\/|ssh:\/\/|git@)/i.test(source)) {
        const repoUrl = source.startsWith('git+') ? source.slice(4).trim() : source
        if (repoUrl === '' || repoUrl.startsWith('-') || !/^(https?:\/\/|ssh:\/\/|git@)/i.test(repoUrl)) {
          throw new Error('Invalid git repository URL.')
        }
        const cloneDir = join(stage, 'repo')
        await execFileAsync('git', ['clone', '--depth', '1', '-c', 'core.symlinks=false', '--', repoUrl, cloneDir], { timeout: 120_000 })
        await rm(join(cloneDir, '.git'), { recursive: true, force: true })
        pluginSourceDir = await findPluginRoot(cloneDir)
        if (!pluginSourceDir) throw new Error('Cloned repository does not contain plugin.json.')
      } else {
        const localPath = resolve(source.startsWith('file://') ? new URL(source).pathname : source)
        if (!await exists(localPath)) throw new Error(`Local plugin path does not exist: ${localPath}`)
        const copyDir = join(stage, 'local')
        await cp(localPath, copyDir, { recursive: true })
        pluginSourceDir = await findPluginRoot(copyDir)
        if (!pluginSourceDir) throw new Error(`Directory "${localPath}" does not contain plugin.json.`)
      }

      const manifest = await loadAndValidateDir(pluginSourceDir)
      const targetId = options.idOverride ? normalizeProviderId(options.idOverride) : manifest.id
      if (this.bundledIds.has(targetId)) {
        throw new Error(`Cannot overwrite bundled memory provider "${targetId}".`)
      }
      const targetDir = join(this.pluginsRoot, targetId)
      if (!isStrictSubpath(this.pluginsRoot, targetDir)) {
        throw new Error('Invalid target plugin id.')
      }
      if (await exists(targetDir)) {
        if (options.overwrite !== true) {
          throw new Error(`Memory plugin "${targetId}" is already installed. Uninstall it first or pass overwrite: true.`)
        }
        await rm(targetDir, { recursive: true, force: true })
      }

      // Write install metadata for provenance.
      await writeFile(
        join(pluginSourceDir, '.install.json'),
        `${JSON.stringify({ source, installedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      )
      await cp(pluginSourceDir, targetDir, { recursive: true })
      this.logger?.info?.(`botmode: installed memory plugin "${targetId}" from ${source}`)
      return { id: targetId, dir: targetDir, manifest }
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async uninstall(providerId) {
    const id = normalizeProviderId(providerId)
    if (id === '') throw new Error('Specify a memory plugin id to uninstall.')
    if (this.bundledIds.has(id)) {
      throw new Error(`Built-in memory provider "${id}" cannot be uninstalled.`)
    }
    const targetDir = join(this.pluginsRoot, id)
    if (!isStrictSubpath(this.pluginsRoot, targetDir) || !await exists(targetDir)) {
      throw new Error(`Installed memory plugin "${id}" was not found.`)
    }
    await rm(targetDir, { recursive: true, force: true })
    this.logger?.info?.(`botmode: uninstalled memory plugin "${id}"`)
    return { id, removed: true }
  }
}
