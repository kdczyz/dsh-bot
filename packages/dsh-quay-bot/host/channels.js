/**
 * External Event Triggers (Inbound Webhooks) & Proactive Outbound Notifications
 * (Generic Webhook, Feishu/Lark, WeCom, DingTalk, Slack).
 *
 * Enables 7x24 unattended Bot operation:
 *   - Inbound: external systems (GitHub, Prometheus/Alertmanager, CI, forms, IM)
 *     POST `/botmode/api/webhook/<id>` authenticated via Bearer token, `X-Botmode-Secret`,
 *     or HMAC-SHA256 `X-Hub-Signature-256` to wake a Bot or trigger a Group Room.
 *   - Outbound: approval prompts, human takeover requests (`screen_request_help`),
 *     Group Room completions/escalations, Token budget circuit breakers, and routine
 *     failures are pushed out asynchronously to configured IM/Webhook endpoints.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { newId } from './store.js'

const MAX_PAYLOAD_PREVIEW = 8_000
const MAX_NOTIFICATION_LOGS = 50
const OUTBOUND_TIMEOUT_MS = 8_000

const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a ?? ''), 'utf8')
  const bufB = Buffer.from(String(b ?? ''), 'utf8')
  if (bufA.length === 0 || bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export const generateWebhookSecret = () => `whsec_${randomBytes(24).toString('hex')}`

export const WEBHOOK_FORMATS = new Set(['generic', 'feishu', 'wecom', 'dingtalk', 'slack'])

export function normalizeNotificationsSettings(input, base = defaultNotificationsSettings()) {
  const src = input && typeof input === 'object' ? input : {}
  const cleanUrl = (val, fallback = '') => {
    if (typeof val !== 'string') return fallback
    const trimmed = val.trim()
    if (trimmed === '') return ''
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    return fallback
  }
  const rawFmt = typeof src.webhookFormat === 'string' ? src.webhookFormat : (typeof src.format === 'string' ? src.format : '')
  const fmt = WEBHOOK_FORMATS.has(rawFmt) ? rawFmt : base.webhookFormat
  const rawSecret = typeof src.webhookSecret === 'string' ? src.webhookSecret : (typeof src.secret === 'string' ? src.secret : undefined)
  return {
    enabled: src.enabled !== undefined ? src.enabled !== false : base.enabled,
    desktopNotifications: src.desktopNotifications !== undefined ? src.desktopNotifications !== false : base.desktopNotifications,
    webhookUrl: src.webhookUrl !== undefined ? cleanUrl(src.webhookUrl, base.webhookUrl) : base.webhookUrl,
    webhookFormat: fmt,
    webhookSecret: rawSecret !== undefined ? rawSecret.trim() : base.webhookSecret,
    onApproval: src.onApproval !== undefined ? src.onApproval !== false : base.onApproval,
    onScreenHelp: src.onScreenHelp !== undefined ? src.onScreenHelp !== false : base.onScreenHelp,
    onRoomComplete: src.onRoomComplete !== undefined ? src.onRoomComplete !== false : base.onRoomComplete,
    onBudgetExceeded: src.onBudgetExceeded !== undefined ? src.onBudgetExceeded !== false : base.onBudgetExceeded,
    onRoutineError: src.onRoutineError !== undefined ? src.onRoutineError !== false : base.onRoutineError,
  }
}

export const defaultNotificationsSettings = () => ({
  enabled: true,
  desktopNotifications: true,
  webhookUrl: '',
  webhookFormat: 'generic',
  webhookSecret: '',
  onApproval: true,
  onScreenHelp: true,
  onRoomComplete: true,
  onBudgetExceeded: true,
  onRoutineError: true,
})

/**
 * Render an inbound webhook prompt template with `{{event}}`, `{{webhook}}`, and `{{payload}}`.
 */
export function renderWebhookPrompt(template, { webhookName, event, payload }) {
  const serialized = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload ?? {}, null, 2)
  const clipped = serialized.length > MAX_PAYLOAD_PREVIEW
    ? `${serialized.slice(0, MAX_PAYLOAD_PREVIEW)}\n... [truncated]`
    : serialized
  const base = typeof template === 'string' && template.trim() !== ''
    ? template
    : '[Webhook Event: {{webhook}} / {{event}}]\n请分析以下外部事件载荷并按职责处理：\n```json\n{{payload}}\n```'
  return base
    .replaceAll('{{webhook}}', String(webhookName || 'webhook'))
    .replaceAll('{{name}}', String(webhookName || 'webhook'))
    .replaceAll('{{event}}', String(event || 'event'))
    .replaceAll('{{payload}}', clipped)
}

/**
 * Format an outbound notification payload for the configured channel format.
 */
export function formatOutboundPayload(format, event, secret = '') {
  const title = String(event.title || 'Bot Mode Notification')
  const body = String(event.body ?? event.summary ?? '')
  const level = String(event.level || 'info')
  const at = event.at || new Date().toISOString()

  if (format === 'feishu') {
    const text = `[${title}]\n${body}\n(${at})`
    const payload = { msg_type: 'text', content: { text } }
    if (secret) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
      payload.timestamp = timestamp
      payload.sign = sign
    }
    return { body: payload, urlQuery: '' }
  }
  if (format === 'wecom') {
    return {
      body: {
        msgtype: 'markdown',
        markdown: { content: `### ${title}\n${body}\n> ${at}` },
      },
      urlQuery: '',
    }
  }
  if (format === 'dingtalk') {
    let urlQuery = ''
    if (secret) {
      const timestamp = Date.now()
      const sign = encodeURIComponent(
        createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'),
      )
      urlQuery = `timestamp=${timestamp}&sign=${sign}`
    }
    return {
      body: {
        msgtype: 'markdown',
        markdown: { title, text: `### ${title}\n\n${body}\n\n> ${at}` },
      },
      urlQuery,
    }
  }
  if (format === 'slack') {
    return {
      body: { text: `*${title}*\n${body}\n_${at}_` },
      urlQuery: '',
    }
  }
  return {
    body: {
      source: 'dsh-botmode',
      kind: event.kind || 'notice',
      level,
      title,
      body,
      meta: event.meta || {},
      at,
    },
    urlQuery: '',
  }
}

export class NotificationHub {
  #logs = []

  constructor({ store, logger, fetchImpl } = {}) {
    this.store = store
    this.logger = logger
    this.fetchImpl = fetchImpl ?? globalThis.fetch
  }

  get settings() {
    return normalizeNotificationsSettings(this.store?.state?.settings?.notifications)
  }

  recentLogs(limit = 20) {
    return this.#logs.slice(-Math.max(1, Math.min(MAX_NOTIFICATION_LOGS, Number(limit) || 20)))
  }

  #shouldSend(kind, cfg) {
    if (!cfg.enabled || !cfg.webhookUrl) return false
    if (kind === 'test') return true
    if (kind === 'approval' || kind === 'question') return cfg.onApproval !== false
    if (kind === 'screen_help') return cfg.onScreenHelp !== false
    if (kind === 'room_complete' || kind === 'room_waiting') return cfg.onRoomComplete !== false
    if (kind === 'budget_exceeded') return cfg.onBudgetExceeded !== false
    if (kind === 'routine_error') return cfg.onRoutineError !== false
    return true
  }

  async notify(event = {}, override = null) {
    const cfg = override && typeof override === 'object'
      ? normalizeNotificationsSettings(override, this.settings)
      : this.settings
    const kind = String(event.kind || 'notice')
    if (!this.#shouldSend(kind, cfg)) {
      return { ok: true, skipped: true, reason: !cfg.webhookUrl ? 'no_webhook_url' : 'disabled' }
    }
    if (typeof this.fetchImpl !== 'function') {
      return { ok: false, error: 'fetch is unavailable' }
    }
    const { body, urlQuery } = formatOutboundPayload(cfg.webhookFormat, event, cfg.webhookSecret)
    const serializedBody = JSON.stringify(body)
    let targetUrl = cfg.webhookUrl
    if (urlQuery) {
      targetUrl += (targetUrl.includes('?') ? '&' : '?') + urlQuery
    }
    const headers = { 'content-type': 'application/json; charset=utf-8' }
    if (cfg.webhookFormat === 'generic' && cfg.webhookSecret) {
      headers.authorization = `Bearer ${cfg.webhookSecret}`
      headers['x-botmode-secret'] = cfg.webhookSecret
      headers['x-botmode-signature'] = `sha256=${createHmac('sha256', cfg.webhookSecret).update(serializedBody).digest('hex')}`
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), OUTBOUND_TIMEOUT_MS)
    timer.unref?.()
    const at = new Date().toISOString()
    try {
      const response = await this.fetchImpl(targetUrl, {
        method: 'POST',
        headers,
        body: serializedBody,
        signal: ac.signal,
      })
      const ok = Boolean(response && response.ok)
      const record = {
        id: newId('ntf'),
        kind,
        title: String(event.title || ''),
        format: cfg.webhookFormat,
        status: response?.status ?? 0,
        ok,
        at,
      }
      this.#logs.push(record)
      if (this.#logs.length > MAX_NOTIFICATION_LOGS) this.#logs.splice(0, this.#logs.length - MAX_NOTIFICATION_LOGS)
      return ok ? { ok: true, status: record.status } : { ok: false, status: record.status, error: `HTTP ${record.status}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#logs.push({ id: newId('ntf'), kind, title: String(event.title || ''), format: cfg.webhookFormat, ok: false, error: message, at })
      if (this.#logs.length > MAX_NOTIFICATION_LOGS) this.#logs.splice(0, this.#logs.length - MAX_NOTIFICATION_LOGS)
      this.logger?.warn?.(`botmode: outbound notification (${kind}) failed: ${message}`)
      return { ok: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  async test(override = null) {
    return this.notify({
      kind: 'test',
      level: 'info',
      title: 'Bot Mode 通知通道连通性测试',
      body: '这是一条来自 DeepSeek Harness Bot Mode 的测试通知，说明外部推送通道已配置成功。',
    }, override)
  }
}

export class WebhookManager {
  constructor({ store, dispatcher, rooms, logger }) {
    this.store = store
    this.dispatcher = dispatcher
    this.rooms = rooms
    this.logger = logger
  }

  list() {
    return (this.store.state?.webhooks ?? []).map(wh => ({
      ...wh,
      endpointPath: `/botmode/api/webhook/${encodeURIComponent(wh.id)}`,
    }))
  }

  get(webhookId) {
    return (this.store.state?.webhooks ?? []).find(wh => wh.id === webhookId)
  }

  async save(webhookId, draft = {}) {
    await this.store.load()
    const id = typeof webhookId === 'string' ? webhookId.trim() : ''
    const existing = id ? this.get(id) : undefined
    const name = typeof draft.name === 'string' && draft.name.trim() !== ''
      ? draft.name.trim()
      : (existing?.name || '')
    if (!name) throw new Error('Webhook name is required.')
    const targetKind = draft.targetKind === 'room' ? 'room' : (draft.targetKind === 'bot' ? 'bot' : (existing?.targetKind || 'bot'))
    const targetId = typeof draft.targetId === 'string' && draft.targetId.trim() !== ''
      ? draft.targetId.trim()
      : (existing?.targetId || '')
    if (!targetId) throw new Error('Target Bot or Group Room is required.')
    if (targetKind === 'bot' && !this.store.bot(targetId)) {
      throw new Error(`Unknown target Bot "${targetId}".`)
    }
    if (targetKind === 'room' && !this.store.room(targetId)) {
      throw new Error(`Unknown target Group Room "${targetId}".`)
    }
    let saved
    await this.store.mutate((state) => {
      state.webhooks = Array.isArray(state.webhooks) ? state.webhooks : []
      const now = new Date().toISOString()
      if (existing) {
        const stored = state.webhooks.find(item => item.id === existing.id)
        if (stored) {
          stored.name = name
          stored.enabled = draft.enabled !== undefined ? draft.enabled !== false : stored.enabled
          stored.targetKind = targetKind
          stored.targetId = targetId
          if (typeof draft.promptTemplate === 'string') stored.promptTemplate = draft.promptTemplate
          if (draft.rotateSecret === true) stored.secret = generateWebhookSecret()
          else if (typeof draft.secret === 'string' && draft.secret.trim().length >= 8) stored.secret = draft.secret.trim()
          stored.updatedAt = now
          saved = { ...stored }
          return
        }
      }
      const created = {
        id: newId('wh'),
        name,
        enabled: draft.enabled !== false,
        secret: typeof draft.secret === 'string' && draft.secret.trim().length >= 8
          ? draft.secret.trim()
          : generateWebhookSecret(),
        targetKind,
        targetId,
        promptTemplate: typeof draft.promptTemplate === 'string' ? draft.promptTemplate : '',
        triggerCount: 0,
        lastTriggeredAt: '',
        createdAt: now,
        updatedAt: now,
      }
      state.webhooks.push(created)
      saved = { ...created }
    })
    return {
      ...saved,
      endpointPath: `/botmode/api/webhook/${encodeURIComponent(saved.id)}`,
    }
  }

  async remove(webhookId) {
    await this.store.mutate((state) => {
      state.webhooks = (state.webhooks ?? []).filter(item => item.id !== webhookId)
    })
  }

  verifySecret(webhook, headers = {}, rawBody = '') {
    if (!webhook || !webhook.secret) return false
    const secret = String(webhook.secret)
    const auth = String(headers.authorization ?? headers.Authorization ?? '').trim()
    if (auth.toLowerCase().startsWith('bearer ') && safeEqual(auth.slice(7).trim(), secret)) {
      return true
    }
    const direct = String(headers['x-botmode-secret'] ?? headers['X-Botmode-Secret'] ?? '').trim()
    if (direct && safeEqual(direct, secret)) {
      return true
    }
    const sig256 = String(headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'] ?? '').trim()
    if (sig256.startsWith('sha256=')) {
      const expected = `sha256=${createHmac('sha256', secret).update(String(rawBody ?? '')).digest('hex')}`
      if (safeEqual(sig256, expected)) return true
    }
    return false
  }

  async trigger(webhookId, { event = '', payload = undefined, headers = {}, rawBody = '', bypassAuth = false } = {}) {
    await this.store.load()
    const webhook = this.get(webhookId)
    if (!webhook) return { ok: false, status: 404, error: 'Unknown webhook.' }
    if (webhook.enabled === false) return { ok: false, status: 403, error: 'Webhook is disabled.' }
    if (!bypassAuth && !this.verifySecret(webhook, headers, rawBody)) {
      return { ok: false, status: 401, error: 'Invalid webhook secret or signature.' }
    }

    let resolvedPayload = payload
    if (resolvedPayload === undefined) {
      const rawText = String(rawBody ?? '').trim()
      if (rawText === '') {
        resolvedPayload = {}
      } else {
        try { resolvedPayload = JSON.parse(rawText) } catch (_error) { resolvedPayload = rawText }
      }
    }
    const headerEvent = String(
      headers['x-github-event'] ?? headers['X-GitHub-Event']
      ?? headers['x-webhook-event'] ?? headers['X-Webhook-Event'] ?? '',
    ).trim()
    const bodyEvent = (resolvedPayload && typeof resolvedPayload === 'object' && typeof resolvedPayload.event === 'string')
      ? resolvedPayload.event.trim()
      : ''
    const resolvedEvent = String(event || headerEvent || bodyEvent || 'webhook').trim() || 'webhook'

    const prompt = renderWebhookPrompt(webhook.promptTemplate, {
      webhookName: webhook.name,
      event: resolvedEvent,
      payload: resolvedPayload,
    })

    let dispatchResult
    if (webhook.targetKind === 'room') {
      await this.rooms.send(webhook.targetId, prompt)
      dispatchResult = { kind: 'room', roomId: webhook.targetId, accepted: true }
    } else {
      const res = this.dispatcher.dispatch(webhook.targetId, prompt, { source: 'webhook' })
      if (!res.ok) return { ok: false, status: 409, error: res.error || 'Dispatch failed.' }
      dispatchResult = { kind: 'bot', botId: webhook.targetId, accepted: true, queued: res.queued }
    }

    const now = new Date().toISOString()
    await this.store.mutate((state) => {
      const stored = (state.webhooks ?? []).find(item => item.id === webhookId)
      if (stored) {
        stored.triggerCount = (Number(stored.triggerCount) || 0) + 1
        stored.lastTriggeredAt = now
      }
    }).catch(() => undefined)

    return { ok: true, status: 202, webhookId: webhook.id, dispatch: dispatchResult, at: now }
  }
}
