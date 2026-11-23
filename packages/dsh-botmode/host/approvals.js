/**
 * Approval bridge for Bot Sessions.
 *
 * A Bot runs in a Session the Harness UI never shows, so the composed approval
 * answerers cannot reach a human. This broker answers for Bot Sessions only:
 * it either applies the Bot's standing policy, or parks the request until the
 * Bot page sends a decision (once / session / always / deny). Non-Bot Sessions
 * fall through to the normal answerers untouched.
 */
import { randomUUID } from 'node:crypto'

const DECISION_TIMEOUT_MS = 2 * 60 * 1000

const sessionIdOf = (agent) => {
  try {
    return agent?.session?.id
  } catch (_error) {
    return undefined
  }
}

export class Approvals {
  #pending = new Map()
  #sessionGrants = new Set()

  constructor(store, logger) {
    this.store = store
    this.logger = logger
  }

  list() {
    return [...this.#pending.values()].map(item => ({
      id: item.id,
      botId: item.botId,
      botName: item.botName,
      toolName: item.toolName,
      callId: item.callId,
      reason: item.reason,
      createdAt: item.createdAt,
    }))
  }

  /** Answer one request that already belongs to a Bot Session. */
  ask(bot, request) {
    if (this.#sessionGrants.has(bot.id) || bot.approvalPolicy === 'always') return 'allowed-once'
    if (bot.approvalPolicy === 'never') return 'rejected'
    const id = `ap_${randomUUID().replace(/-/g, '').slice(0, 10)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        this.logger?.warn?.(`botmode: approval ${id} for ${bot.name} timed out`)
        resolve('rejected')
      }, DECISION_TIMEOUT_MS)
      timer.unref?.()
      this.#pending.set(id, {
        id,
        botId: bot.id,
        botName: bot.name,
        toolName: String(request.toolName ?? 'tool'),
        callId: request.callId,
        reason: typeof request.reason === 'string' ? request.reason : '',
        createdAt: new Date().toISOString(),
        settle: (value) => {
          clearTimeout(timer)
          this.#pending.delete(id)
          resolve(value)
        },
      })
      request.signal?.addEventListener?.('abort', () => {
        const entry = this.#pending.get(id)
        if (entry) entry.settle('cancelled')
      }, { once: true })
    })
  }

  /**
   * Apply a human decision.
   * @param id - pending request id.
   * @param decision - once | session | always | deny.
   */
  async decide(id, decision) {
    const entry = this.#pending.get(id)
    if (!entry) throw new Error('This approval is no longer pending.')
    const bot = this.store.bot(entry.botId)
    if (decision === 'deny') {
      entry.settle('rejected')
      return { id, decision }
    }
    if (decision === 'session') {
      this.#sessionGrants.add(entry.botId)
      entry.settle('allowed-once')
      return { id, decision }
    }
    if (decision === 'always') {
      if (bot) {
        bot.approvalPolicy = 'always'
        await this.store.mutate((state) => {
          const stored = state.bots.find(item => item.id === entry.botId)
          if (stored) stored.approvalPolicy = 'always'
        })
      }
      entry.settle('allowed-once')
      return { id, decision }
    }
    if (decision === 'once') {
      entry.settle('allowed-once')
      return { id, decision }
    }
    throw new Error(`Unknown approval decision "${decision}".`)
  }

  clear() {
    for (const entry of [...this.#pending.values()]) entry.settle('cancelled')
    this.#sessionGrants.clear()
  }
}