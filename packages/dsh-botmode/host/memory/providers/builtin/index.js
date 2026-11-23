/**
 * builtin — Pure file-based MEMORY.md mode (no external memory service).
 */
import { join } from 'node:path'
import { readTextFile, writeTextFile } from '../../../store.js'
import { MemoryProvider } from '../../protocol.js'

export class BuiltinMemoryProvider extends MemoryProvider {
  async health() {
    return { ok: true, mode: 'builtin', detail: 'Using per-Bot MEMORY.md files only' }
  }

  async searchMemory({ query, botDir = '' }) {
    if (!botDir) return { ok: true, items: [], text: 'No memories found for this query.' }
    const body = await readTextFile(join(botDir, 'MEMORY.md'), '')
    const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
    const matched = terms.length === 0
      ? lines.slice(-10)
      : lines.filter(line => terms.some(term => line.toLowerCase().includes(term))).slice(0, 10)
    const items = matched.map(content => ({ type: 'file', content }))
    return {
      ok: true,
      mode: 'builtin',
      items,
      text: items.length === 0 ? 'No memories found for this query.' : items.map(i => `- ${i.content}`).join('\n'),
    }
  }

  async saveMemory({ content, botDir = '' }) {
    const clean = String(content ?? '').trim()
    if (!botDir || clean === '') return { ok: false, error: 'Cannot save memory without bot directory and content.' }
    const path = join(botDir, 'MEMORY.md')
    const current = await readTextFile(path, '')
    const next = `${current.trimEnd()}\n- [${new Date().toISOString().slice(0, 10)}] ${clean}\n`
    await writeTextFile(path, next)
    return { ok: true, mode: 'builtin' }
  }
}

export function createProvider(manifest, config, host) {
  return new BuiltinMemoryProvider(manifest, config, host)
}
