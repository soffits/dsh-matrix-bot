/**
 * Session controls from a room: model, reasoning effort, access mode and
 * context use, picked from numbered lists.
 */
import { defaultModelOf, effortChoices, effortName, findModel, modelName, pickedSelection, selectSessionModel, sessionModelOf } from '@soffits/dsh-channel-core'
import { currentPermission, permissionOptions, setPermission } from './sessions.js'

/** @returns `n` as a 1-based list index into `items`, or undefined. */
export function pick(items, value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 && number <= items.length ? items[number - 1] : undefined
}

/** The room's session id, or undefined. */
export function sessionOf(bridge, roomId) {
  const id = bridge.store().room(roomId)?.sessionId
  return typeof id === 'string' ? id : undefined
}

/** The room session's live agent when it is loaded, or undefined. */
export function liveAgent(bridge, roomId) {
  const sessionId = sessionOf(bridge, roomId)
  return sessionId === undefined ? undefined : bridge.ctx.get('agents')?.get(sessionId)
}

/** @returns a compact token count, such as 1M or 12.3k. */
function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '?'
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`
  return String(value)
}

/** @returns context use, such as "16.8k of 1M" or "16.8k used". */
function contextLabel({ used, windowSize }) {
  if (used === undefined) return windowSize === undefined ? 'unknown' : `${formatTokens(windowSize)} window`
  return windowSize === undefined ? `${formatTokens(used)} used` : `${formatTokens(used)} of ${formatTokens(windowSize)}`
}

/** Model, effort and access mode of a room's session. */
async function controls(bridge, roomId) {
  const catalog = await bridge.modelCatalog.load()
  const sessionId = sessionOf(bridge, roomId)
  const current = await sessionModelOf(bridge.ctx, sessionId) ?? defaultModelOf(bridge.ctx)
  const agent = liveAgent(bridge, roomId)
  const mode = currentPermission(bridge.ctx, agent)
  const modeName = permissionOptions(bridge.ctx).find((option) => option.value === mode)?.name ?? mode ?? '?'
  return { catalog, current, mode, modeName }
}

/** Context window and last request size of a room's session. */
async function contextUse(bridge, roomId, current) {
  let windowSize
  try {
    const llm = bridge.ctx.get('llm')
    const resolve = llm?.resolveModelInfo ?? llm?.resolveModel
    const info = current === undefined || resolve === undefined ? undefined : await resolve.call(llm, current.provider, current.model)
    windowSize = info?.context?.contextWindow
  } catch {
    // Unknown.
  }
  if (windowSize === undefined) {
    const catalog = await bridge.modelCatalog.load()
    windowSize = findModel(catalog, current)?.model?.contextWindow
  }
  let used
  const sessionId = sessionOf(bridge, roomId)
  if (sessionId !== undefined) {
    try {
      const events = (await bridge.ctx.get('sessionQuery')?.readSurface(sessionId))?.events ?? []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const usage = events[index]?.type === 'assistant/message' ? (events[index].data?.usage ?? events[index].data?.message?.usage) : undefined
        if (usage === undefined) continue
        used = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        break
      }
    } catch {
      // Unknown.
    }
  }
  return { windowSize, used }
}

/** Switch the room's session to a model, and remember it for /new; the default for new sessions stays. */
async function selectModel(bridge, roomId, selection) {
  const store = bridge.store()
  store.data.picks[roomId] = selection
  await store.save()
  await selectSessionModel(bridge.ctx, await bridge.ensureAgent(roomId, { claim: true }), selection)
}

/** Handlers of the control commands, merged into the command table. */
export const CONTROL_HANDLERS = {
  async menu(bridge, { roomId }) {
    const { catalog, current, modeName } = await controls(bridge, roomId)
    const context = await contextUse(bridge, roomId, current)
    await bridge.notice(roomId, [
      'Session controls:',
      `🤖 Model: ${modelName(catalog, current)} — !model`,
      `🧠 Effort: ${effortName(catalog, current, 'Default')} — !effort`,
      `🛡 Access: ${modeName} — !mode`,
      `📚 Context: ${contextLabel(context)} — !context`,
    ].join('\n'))
  },

  async model(bridge, { roomId }, args) {
    const { catalog, current } = await controls(bridge, roomId)
    if (catalog === undefined || catalog.groups.length === 0) {
      await bridge.notice(roomId, 'No models are available right now.')
      return
    }
    const [first, second] = args.split(/\s+/u).filter(Boolean)
    if (first === undefined) {
      await bridge.notice(roomId, [
        `Model now: ${modelName(catalog, current)}`,
        '',
        ...catalog.groups.map((group, index) => `${index + 1}. ${group.name ?? group.id} (${group.models.length})${group.id === current?.provider ? ' ✅' : ''}`),
        ...(catalog.failures.length > 0 ? ['', `Unavailable: ${catalog.failures.map((failure) => failure.name ?? failure.id).join(', ')}`] : []),
        '',
        '!model <n> lists the models of provider n.',
      ].join('\n'))
      return
    }
    const group = pick(catalog.groups, first)
    if (group === undefined) {
      await bridge.notice(roomId, `No provider ${first}; !model lists them.`)
      return
    }
    if (second === undefined) {
      await bridge.notice(roomId, [
        `${group.name ?? group.id}:`,
        ...group.models.map((model, index) => `${index + 1}. ${model.name ?? model.id}${group.id === current?.provider && model.id === current?.model ? ' ✅' : ''}`),
        '',
        `!model ${first} <n> switches this room's session to model n.`,
      ].join('\n'))
      return
    }
    const model = pick(group.models, second)
    if (model === undefined) {
      await bridge.notice(roomId, `No model ${second}; !model ${first} lists them.`)
      return
    }
    await selectModel(bridge, roomId, pickedSelection(current, group.id, model))
    await bridge.notice(roomId, `🤖 Model: ${model.name ?? model.id}`)
  },

  async effort(bridge, { roomId }, args) {
    const { catalog, current } = await controls(bridge, roomId)
    const model = findModel(catalog, current)?.model
    const choices = effortChoices(model, 'Default')
    if (choices.length === 0) {
      await bridge.notice(roomId, 'This model has no effort setting.')
      return
    }
    const effective = current?.reasoningEffort ?? model?.reasoning?.defaultEffort
    if (args.length === 0) {
      await bridge.notice(roomId, [
        'Reasoning effort:',
        ...choices.map((choice, index) => `${index + 1}. ${choice.name}${choice.id === effective ? ' ✅' : ''}`),
        '',
        '!effort <n> picks one.',
      ].join('\n'))
      return
    }
    const choice = pick(choices, args.split(/\s+/u)[0])
    if (choice === undefined || current === undefined) {
      await bridge.notice(roomId, `No effort ${args}; !effort lists them.`)
      return
    }
    await selectModel(bridge, roomId, { provider: current.provider, model: current.model, ...(choice.id === undefined ? {} : { reasoningEffort: choice.id }) })
    await bridge.notice(roomId, `🧠 Effort: ${choice.name}`)
  },

  async mode(bridge, { roomId }, args) {
    const options = permissionOptions(bridge.ctx)
    const { mode } = await controls(bridge, roomId)
    if (args.length === 0) {
      await bridge.notice(roomId, [
        'Access mode of this session:',
        ...options.map((option, index) => `${index + 1}. ${option.name}${option.value === mode ? ' ✅' : ''}`),
        '',
        '!mode <n> picks one.',
      ].join('\n'))
      return
    }
    const option = pick(options, args.split(/\s+/u)[0])
    if (option === undefined) {
      await bridge.notice(roomId, `No mode ${args}; !mode lists them.`)
      return
    }
    setPermission(bridge.ctx, await bridge.ensureAgent(roomId, { claim: true }), option.value)
    await bridge.notice(roomId, `🛡 Access: ${option.name}`)
  },

  async context(bridge, { roomId }) {
    const { catalog, current, modeName } = await controls(bridge, roomId)
    const context = await contextUse(bridge, roomId, current)
    await bridge.notice(roomId, [
      'Context:',
      `Model: ${modelName(catalog, current)}${current === undefined ? '' : ` (${current.provider}/${current.model})`}`,
      `Window: ${formatTokens(context.windowSize)}`,
      `Last request: ${context.used === undefined ? 'unknown' : formatTokens(context.used)}`,
      `Effort: ${effortName(catalog, current, 'Default')}`,
      `Access: ${modeName}`,
    ].join('\n'))
  },

}
