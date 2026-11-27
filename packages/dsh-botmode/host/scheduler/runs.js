/**
 * Per-routine Run history as append-only JSONL.
 *
 * Every state transition of a Run appends one line; reading collapses lines by `runId` (last wins),
 * which keeps writes cheap and crash-safe. After a Run settles the file is compacted to the most
 * recent `keep` Runs. `state.json` never carries Run history, so it cannot bloat.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pidAlive, withFileLock } from '../store.js'

const OPEN_STATUSES = new Set(['queued', 'running'])
export const isOpenStatus = (status) => OPEN_STATUSES.has(status)

const safeName = (value) => String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'routine'

export class RunLog {
  #chains = new Map()

  /** @param root - directory that holds one `<routineId>.jsonl` per routine. */
  constructor(root, logger) {
    this.root = root
    this.logger = logger
  }

  #path(routineId) { return join(this.root, `${safeName(routineId)}.jsonl`) }

  #serial(routineId, task) {
    const key = safeName(routineId)
    const previous = this.#chains.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => undefined)
    this.#chains.set(key, tail)
    void tail.then(() => { if (this.#chains.get(key) === tail) this.#chains.delete(key) })
    return run
  }

  #lockPath(routineId) { return `${this.#path(routineId)}.lock` }

  /** Append the current full snapshot of a Run (a Run record is always written whole). */
  append(routineId, record) {
    return this.#serial(routineId, () => withFileLock(this.#lockPath(routineId), async () => {
      await mkdir(this.root, { recursive: true })
      await appendFile(this.#path(routineId), `${JSON.stringify(record)}\n`, 'utf8')
    }))
  }

  async #readAll(routineId) {
    let text = ''
    try {
      text = await readFile(this.#path(routineId), 'utf8')
    } catch (_error) {
      return []
    }
    const byId = new Map()
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line)
        if (record && typeof record.runId === 'string') byId.set(record.runId, record)
      } catch (_error) { /* a torn trailing line from a crash is ignored */ }
    }
    return [...byId.values()]
  }

  /** Newest first. */
  async list(routineId, limit = 20) {
    const all = await this.#readAll(routineId)
    all.sort((a, b) => Date.parse(b.createdAt ?? b.startedAt ?? 0) - Date.parse(a.createdAt ?? a.startedAt ?? 0))
    return all.slice(0, Math.max(1, limit))
  }

  async get(routineId, runId) {
    return (await this.#readAll(routineId)).find(record => record.runId === runId)
  }

  /** Rewrite the file with one line per Run, keeping the newest `keep`. */
  compact(routineId, keep = 50) {
    return this.#serial(routineId, () => withFileLock(this.#lockPath(routineId), async () => {
      const all = await this.#readAll(routineId)
      all.sort((a, b) => Date.parse(a.createdAt ?? a.startedAt ?? 0) - Date.parse(b.createdAt ?? b.startedAt ?? 0))
      const kept = all.slice(-Math.max(1, keep))
      const temp = `${this.#path(routineId)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      await writeFile(temp, kept.map(record => JSON.stringify(record)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
      await rename(temp, this.#path(routineId))
    }))
  }

  remove(routineId) {
    return this.#serial(routineId, () => withFileLock(this.#lockPath(routineId), async () => {
      await rm(this.#path(routineId), { force: true })
    }))
  }

  /**
   * After a crash/restart no Run can still be live: close every `queued`/`running` Run as
   * `interrupted` unless its `ownerPid` is another still-alive Host process.
   * Returns the affected `{ routineId, runId }` pairs.
   */
  async recoverInterrupted() {
    let names = []
    try {
      names = (await readdir(this.root)).filter(name => name.endsWith('.jsonl'))
    } catch (_error) {
      return []
    }
    const recovered = []
    for (const name of names) {
      const routineId = name.slice(0, -'.jsonl'.length)
      const open = (await this.#readAll(routineId)).filter(record => isOpenStatus(record.status))
      for (const record of open) {
        const ownerPid = Number.isInteger(record.ownerPid) && record.ownerPid > 0 ? record.ownerPid : 0
        if (ownerPid > 0 && ownerPid !== process.pid && pidAlive(ownerPid)) continue
        await this.append(routineId, {
          ...record,
          status: 'interrupted',
          error: record.error || 'host_restarted',
          finishedAt: new Date().toISOString(),
        })
        recovered.push({ routineId: record.routineId ?? routineId, runId: record.runId })
      }
    }
    return recovered
  }
}
