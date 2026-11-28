/**
 * The live model catalog a Bot binds to.
 *
 * DSH already owns provider discovery, reasoning levels and image capability.
 * Bot mode only projects that registry into a compact shape the Bot page can
 * render, and resolves the one selection a Bot uses for its next turn:
 *
 * - a Bot with its own provider/model keeps that binding;
 * - a Bot with an empty binding follows the DSH default model, read fresh from
 *   `agentDefaultModel` so a changed default reaches the Bot on its next turn.
 *
 * Every provider lookup is isolated: one broken provider becomes a failure row
 * and the remaining groups stay usable. Catalog data is cached briefly because
 * `resolveModelInfo` can interrogate the provider endpoint.
 */
const CATALOG_TTL_MS = 60_000

/** @typedef {{ provider: string, model: string, reasoningEffort?: string }} ModelSelection */

const catalogCache = new WeakMap()
const capabilityCache = new WeakMap()

const cleanString = (value) => (typeof value === 'string' ? value : '')

/** Read the deployment default without assuming the service is mounted. */
export function defaultModelSelection(ctx) {
  try {
    const service = ctx?.get?.('agentDefaultModel')
    const selection = service && typeof service.currentSelection === 'function'
      ? service.currentSelection()
      : undefined
    if (!selection || typeof selection !== 'object') return undefined
    const provider = cleanString(selection.provider)
    const model = cleanString(selection.model)
    if (provider === '' || model === '') return undefined
    const reasoningEffort = cleanString(selection.reasoningEffort)
    return {
      provider,
      model,
      ...reasoningEffort === '' ? {} : { reasoningEffort },
    }
  } catch (_error) {
    return undefined
  }
}

/** The Bot's explicit binding, or undefined when it follows the default. */
export function botModelSelection(bot) {
  const model = bot && typeof bot.model === 'object' ? bot.model : undefined
  const provider = cleanString(model?.provider)
  const id = cleanString(model?.model)
  if (provider === '' || id === '') return undefined
  const reasoningEffort = cleanString(model?.reasoningEffort)
  return {
    provider,
    model: id,
    ...reasoningEffort === '' ? {} : { reasoningEffort },
  }
}

/** The selection this Bot actually uses: its own binding or the DSH default. */
export function resolveBotSelection(ctx, bot) {
  return botModelSelection(bot) ?? defaultModelSelection(ctx)
}

const projectReasoning = (reasoning) => {
  if (!reasoning || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return undefined
  return {
    efforts: reasoning.efforts.map(effort => ({
      id: cleanString(effort?.id),
      name: cleanString(effort?.name) || cleanString(effort?.id),
      ...typeof effort?.description === 'string' && effort.description !== ''
        ? { description: effort.description }
        : {},
    })).filter(effort => effort.id !== ''),
    ...typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort !== ''
      ? { defaultEffort: reasoning.defaultEffort }
      : {},
  }
}

const projectModel = (provider, model, resolved) => {
  const modalities = resolved?.inputModalities ?? model?.inputModalities
  const inputModalities = Array.isArray(modalities)
    ? [...new Set(modalities.filter(value => typeof value === 'string'))]
    : undefined
  const reasoning = projectReasoning(resolved?.reasoning)
  return {
    id: cleanString(model?.id) || cleanString(resolved?.id),
    name: cleanString(model?.name) || cleanString(resolved?.name) || cleanString(model?.id),
    ...typeof model?.description === 'string' && model.description !== ''
      ? { description: model.description }
      : {},
    ...model?.badge && typeof model.badge === 'object'
      ? { badge: model.badge }
      : {},
    ...inputModalities === undefined ? {} : { inputModalities },
    ...inputModalities === undefined ? {} : { vision: inputModalities.includes('image') },
    ...reasoning === undefined ? {} : { reasoning },
  }
}

/**
 * Project the live LLM registry into provider groups for the Bot form.
 * @param ctx - Host context that may carry `llm` and `agentDefaultModel`.
 * @param options - `force` bypasses the short catalog cache.
 */
export async function botModelCatalog(ctx, options = {}) {
  const cached = catalogCache.get(ctx)
  const fresh = cached && Date.now() - cached.at < CATALOG_TTL_MS
  if (!options.force && fresh) {
    return {
      ...cached.catalog,
      default: defaultModelSelection(ctx) ?? cached.catalog.default,
    }
  }

  const fallback = {
    default: defaultModelSelection(ctx),
    groups: [],
    failures: [],
    source: 'unavailable',
  }
  const llm = ctx?.get?.('llm')
  if (!llm || typeof llm.listProviders !== 'function') {
    const catalog = { ...fallback, failures: [{ id: 'llm', name: 'llm', message: 'The LLM registry is unavailable in this Host.' }] }
    catalogCache.set(ctx, { at: Date.now(), catalog })
    return catalog
  }

  let providers = []
  try {
    providers = llm.listProviders()
  } catch (error) {
    const catalog = { ...fallback, failures: [{ id: 'llm', name: 'llm', message: error instanceof Error ? error.message : String(error) }] }
    catalogCache.set(ctx, { at: Date.now(), catalog })
    return catalog
  }

  const groups = []
  const failures = []
  await Promise.all(providers.map(async (provider) => {
    const providerId = cleanString(provider?.id)
    if (providerId === '') return
    try {
      const models = await llm.listModels(providerId)
      if (!Array.isArray(models) || models.length === 0) return
      const entries = await Promise.all(models.map(async (model) => {
        let resolved
        try {
          resolved = await llm.resolveModelInfo(providerId, model.id)
        } catch (_error) {
          resolved = undefined
        }
        return projectModel(providerId, model, resolved)
      }))
      groups.push({
        id: providerId,
        name: cleanString(provider?.name) || providerId,
        models: entries.filter(entry => entry.id !== ''),
      })
    } catch (error) {
      failures.push({
        id: providerId,
        name: cleanString(provider?.name) || providerId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }))

  // Preserve registry order for providers, but keep only usable groups.
  const order = new Map(providers.map((provider, index) => [cleanString(provider?.id), index]))
  groups.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
  failures.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))

  const catalog = {
    default: defaultModelSelection(ctx),
    groups: groups.filter(group => group.models.length > 0),
    failures,
    source: 'llm',
  }
  catalogCache.set(ctx, { at: Date.now(), catalog })
  return catalog
}

/**
 * Whether one exact model route accepts image input.
 * @returns true/false when the adapter declares modalities, undefined when unknown.
 */
export async function modelAcceptsImages(ctx, selection) {
  if (!selection || selection.provider === '' || selection.model === '') return undefined
  const llm = ctx?.get?.('llm')
  if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined
  const key = `${selection.provider}/${selection.model}`
  const cache = capabilityCache.get(ctx) ?? new Map()
  capabilityCache.set(ctx, cache)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
  let value
  try {
    const info = await llm.resolveModelInfo(selection.provider, selection.model)
    value = Array.isArray(info?.inputModalities)
      ? info.inputModalities.includes('image')
      : undefined
  } catch (_error) {
    value = undefined
  }
  cache.set(key, { at: Date.now(), value })
  return value
}