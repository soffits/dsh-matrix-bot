/**
 * The DSH side of a room: creating, resuming and prompting sessions through
 * the same Host services the Web UI uses (`sessionController`), with the raw
 * agent registry as the headless fallback.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { REQUEST_PREFIX } from './constants.js'

/** @returns the Web session controller, when this deployment mounts it. */
export function controllerOf(ctx) {
  const controller = ctx.get('sessionController')
  return typeof controller?.create === 'function' && typeof controller?.resolveAgent === 'function' ? controller : undefined
}

/**
 * The live agent of a session, resuming it when needed.
 * @param ctx - Host context.
 * @param sessionId - session id.
 * @returns the agent; throws when the session cannot be resumed.
 */
export async function resolveAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  const live = agents?.get(sessionId)
  if (live !== undefined) return live
  const controller = controllerOf(ctx)
  if (controller !== undefined) {
    const found = await controller.resolveAgent(sessionId)
    if (found?.error !== undefined) throw found.error
    const agent = found?.agent ?? agents?.get(sessionId)
    if (agent === undefined) throw new Error(`session ${sessionId} has no live agent`)
    return agent
  }
  if (agents === undefined) throw new Error('dsh-agent is not mounted in this profile')
  const resumed = await agents.resume({ resumeSessionId: sessionId })
  if (resumed?.agent === undefined) throw new Error(`session ${sessionId} could not be resumed`)
  return resumed.agent
}

/**
 * Attach a session to the DSH workspace of its directory, creating the
 * workspace when needed, so it shows up in the Web UI sidebar.
 * @param ctx - Host context.
 * @param sessionId - session id.
 * @param cwd - session directory.
 * @param warn - logger.
 */
async function attachToWorkspace(ctx, sessionId, cwd, warn) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    let workspace = registry.list().find((entry) => entry.path === cwd)
    if (workspace === undefined) workspace = await registry.create(cwd)
    await workspace.attachSession(sessionId)
  } catch (error) {
    warn(`workspace attach failed for ${sessionId}: ${error?.message ?? error}`)
  }
}

/**
 * End a new session's blank state with an empty turn that never reaches a
 * model. DSH hands a blank session (one that never started a turn) to the
 * next New conversation in the Web UI; a room's session must not be taken
 * that way. The marker message is rejected at `agent/pre-step`, the same gate
 * DSH uses for archived sessions, so the turn ends as blocked and the marker
 * is never recorded.
 * @param agent - the new session's agent.
 * @param roomId - Matrix room id, for the marker text.
 */
async function claimSession(agent, roomId) {
  if (typeof agent?.followup !== 'function' || typeof agent?.ctx?.on !== 'function') return
  const id = randomUUID()
  const dispose = agent.ctx.on('agent/pre-step', (payload, next) => {
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    if (messages.length > 0 && messages.every((message) => message?.id === id)) return Promise.resolve({ kind: 'reject' })
    return next()
  })
  agent.followup({
    id,
    role: 'user',
    content: [{ type: 'text', text: `[This session belongs to Matrix room ${roomId}]` }],
    source: { kind: 'user', rpcId: `matrix-claim:${id}` },
  })
  const idle = typeof agent.whenIdle === 'function' ? agent.whenIdle() : Promise.resolve()
  void idle.catch(() => undefined).finally(() => { if (typeof dispose === 'function') dispose() })
  let timer
  await Promise.race([
    idle.catch(() => undefined),
    new Promise((resolveWait) => { timer = setTimeout(resolveWait, 10_000) }),
  ])
  clearTimeout(timer)
}

/**
 * Create a session for a room, composed the way the Web UI composes one.
 * @param ctx - Host context.
 * @param options - `{ cwd, preset, model, roomId, claim, warn }`; `claim` ends
 *   the blank state at once (for sessions that will not get a prompt now).
 * @returns the new session's agent.
 */
export async function createSession(ctx, { cwd, preset, model, roomId, claim, warn }) {
  const controller = controllerOf(ctx)
  let agent
  if (controller !== undefined) {
    try {
      const created = await controller.create({ cwd, ...(preset ? { agentPreset: preset } : {}) })
      agent = await resolveAgent(ctx, created.sessionId)
    } catch (error) {
      warn(`sessionController create failed, using the agent registry: ${error?.message ?? error}`)
    }
  }
  if (agent === undefined) {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('dsh-agent is not mounted in this profile')
    const meta = { cwd, ...(preset && ctx.get('agentPresets') !== undefined ? { agentPreset: preset } : {}) }
    const presets = ctx.get('agentPresets')
    const setup = preset && presets !== undefined
      ? async (agentCtx) => {
        try {
          await presets.mount(agentCtx, preset)
        } catch (error) {
          warn(`preset ${preset} not mounted: ${error?.message ?? error}`)
        }
      }
      : undefined
    agent = (await agents.create({ sessionId: `session-${randomUUID()}`, meta, ...(setup ? { setup } : {}) })).agent
  }
  const sessionId = agent.session?.id ?? agent.id
  if (model !== undefined) {
    try {
      agent.model.select(model)
    } catch (error) {
      warn(`could not start ${sessionId} on ${model.provider}/${model.model}: ${error?.message ?? error}`)
    }
  }
  if (claim) await claimSession(agent, roomId)
  await attachToWorkspace(ctx, sessionId, cwd, warn)
  return agent
}

/**
 * Bring an archived session back before a room message starts a turn in it:
 * DSH admits prompts into archived sessions but rejects every model step.
 * @param ctx - Host context.
 * @param sessionId - session id.
 * @returns true when the session was unarchived.
 */
export async function unarchive(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry?.archivedSessionIds?.includes(sessionId) !== true || typeof registry.unarchiveSession !== 'function') return false
  await registry.unarchiveSession(sessionId)
  return true
}

/** @returns whether a message the agent has not taken yet carries this request id. */
export function inInbox(agent, requestId) {
  const matches = (message) => message?.source?.kind === 'user' && message.source.rpcId === requestId
  const inbox = agent?.inbox
  return inbox?.nextTurn?.some?.(matches) === true || inbox?.nextStep?.some?.(matches) === true
}

/** @returns whether a pending or recorded message carries this request id. */
export function hasRequest(agent, requestId) {
  if (inInbox(agent, requestId)) return true
  const matches = (message) => message?.source?.kind === 'user' && message.source.rpcId === requestId
  const events = typeof agent?.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
  return events.some((event) => event?.type === 'user/message' && matches(event.data))
}

/**
 * Hand one prompt to a session. Text goes through the Session controller's
 * `prompt`, the Web UI's own path; prompts with stored attachments go to the
 * agent's `followup` (queue) or `steer` (into the running turn), the methods
 * that path calls. A request id already admitted is skipped, so a message
 * handled twice (a restart between admission and marking it seen) reaches the
 * agent once.
 * @param ctx - Host context.
 * @param agent - the session's agent.
 * @param prompt - `{ requestId, text, attachments, mode, principal }`; `mode` is
 *   `queue` or `steer`; `principal` is recorded on prompts built here (the
 *   controller's prompts get it at their step, see `createPrincipalTagger`).
 * @param signal - request lifetime.
 * @returns whether the prompt was handed over (false for a duplicate or an empty one).
 */
export async function admitPrompt(ctx, agent, { requestId, text, attachments = [], mode, principal }, signal) {
  if (hasRequest(agent, requestId)) return false
  const content = [...(text.trim().length === 0 ? [] : [{ type: 'text', text }]), ...attachments]
  if (content.length === 0) return false
  const controller = ctx.get('sessionController')
  const sessionId = agent.session?.id ?? agent.id
  if (attachments.length === 0 && typeof controller?.prompt === 'function') {
    await controller.prompt({ sessionId, requestId, mode, content }, signal)
    return true
  }
  const message = { id: randomUUID(), role: 'user', content, source: { kind: 'user', rpcId: requestId, ...(principal === undefined ? {} : { principal }) } }
  if (mode === 'steer' && typeof agent.steer === 'function') agent.steer(message)
  else if (typeof agent.followup === 'function') agent.followup(message)
  else agent.send(message, mode === 'steer' ? 'next-step' : 'next-turn', true)
  return true
}

/**
 * Remove prompts from one room that the agent has not taken yet.
 * @param agent - the session's agent.
 * @param roomId - Matrix room id.
 * @returns how many were removed.
 */
export function clearRoomInbox(agent, roomId) {
  const inbox = agent?.inbox
  if (typeof inbox?.remove !== 'function') return 0
  const prefix = `${REQUEST_PREFIX}${roomId}:`
  const ours = (message) => message?.source?.kind === 'user' && typeof message.source.rpcId === 'string' && message.source.rpcId.startsWith(prefix)
  const pending = [...(inbox.nextStep ?? []), ...(inbox.nextTurn ?? [])].filter(ours)
  for (const message of pending) inbox.remove(message.id)
  return pending.length
}

/** @returns whether the agent still holds input it has not taken. */
export function hasPendingInput(agent) {
  const inbox = agent?.inbox
  if (inbox === undefined) return false
  if (typeof inbox.hasPending === 'boolean') return inbox.hasPending
  return (inbox.nextStep?.length ?? 0) > 0 || (inbox.nextTurn?.length ?? 0) > 0
}

/**
 * Whether a session's first surface node is its system message, the only
 * state in which a message may be appended outside a step.
 * @param session - DSH session.
 */
function hasSystemHead(session) {
  try {
    const nodes = session.surface?.nodes
    if (nodes !== undefined) {
      if (nodes.length === 0) return false
      const event = typeof session.eventAt === 'function'
        ? session.eventAt(nodes[0])
        : session.snapshotEvents?.().find((item) => item.seq === nodes[0])
      return event?.type === 'system/message'
    }
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
    if (!Array.isArray(events)) return false
    const surfaceTypes = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
    return events.find((event) => surfaceTypes.has(event.type))?.type === 'system/message'
  } catch {
    return false
  }
}

/**
 * Put a message into a session without starting a turn: appended now to an
 * idle session, otherwise queued for its next step. The Web UI shows it and
 * the model reads it at its next step.
 * @param agent - the session's agent.
 * @param message - a user-role message (`{ id, role, content, source }`).
 */
export function recordMessage(agent, message) {
  if (agent.status === 'idle' && typeof agent.session?.append === 'function' && hasSystemHead(agent.session)) {
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  } else if (typeof agent.inject === 'function') {
    agent.inject(message)
  } else if (typeof agent.send === 'function') {
    agent.send(message, 'next-step', false)
  } else {
    throw new Error('The session cannot record messages.')
  }
}

/**
 * A session's title, or a short fallback.
 * @param ctx - Host context.
 * @param sessionId - session id.
 * @param header - session header when known.
 */
export async function sessionTitle(ctx, sessionId, header) {
  try {
    const snapshot = await ctx.get('sessionQuery')?.readTitleSnapshot(sessionId)
    const title = snapshot?.title?.title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  } catch {
    // No title yet.
  }
  const base = typeof header?.cwd === 'string' && header.cwd.length > 0 ? basename(header.cwd) : 'Session'
  return `${base} · ${String(sessionId).slice(-6)}`
}

/**
 * The latest assistant texts of a session, newest first.
 * @param ctx - Host context.
 * @param sessionId - session id.
 * @param limit - most texts.
 */
export async function recentAssistantTexts(ctx, sessionId, limit) {
  const texts = []
  try {
    const surface = await ctx.get('sessionQuery')?.readSurface(sessionId)
    const events = surface?.events ?? []
    for (let index = events.length - 1; index >= 0 && texts.length < limit; index -= 1) {
      const event = events[index]
      if (event?.type !== 'assistant/message') continue
      const message = event.data?.message ?? event.data
      const content = Array.isArray(message?.content) ? message.content : []
      const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
      if (text.length > 0) texts.push(text)
    }
  } catch {
    // An empty result is reported by the caller.
  }
  return texts
}

/** @returns the registered workspaces, or an empty list. */
export function listWorkspaces(ctx) {
  try {
    return ctx.get('workspaceRegistry')?.list() ?? []
  } catch {
    return []
  }
}

/**
 * Recent ordinary sessions of a workspace, newest first.
 * @param ctx - Host context.
 * @param workspace - workspace record.
 * @param limit - most sessions.
 * @param signal - request lifetime.
 */
export async function sessionsInWorkspace(ctx, workspace, limit, signal) {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
  const records = await query.listSessions(signal)
  return records
    .filter((record) => !archived.has(record.header.id))
    .filter((record) => record.header?.origin !== 'subagent')
    .filter((record) => (workspace.sessionIds ?? []).includes(record.header.id) || record.header.cwd === workspace.path)
    .sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0))
    .slice(0, limit)
}

/**
 * The access mode (permission preset) of a session.
 * @param ctx - Host context.
 * @param agent - live agent, or undefined.
 * @returns the preset value, or undefined when unknown.
 */
export function currentPermission(ctx, agent) {
  const service = ctx.get('permissionPresets')
  try {
    if (agent !== undefined && typeof service?.current === 'function') return service.current(agent.session)
  } catch {
    // Unknown.
  }
  return service?.defaultPreset
}

/**
 * Access modes offered by this deployment.
 * @param ctx - Host context.
 * @returns `{ value, name }` entries.
 */
export function permissionOptions(ctx) {
  try {
    const options = ctx.get('permissionPresets')?.catalog()?.options
    if (Array.isArray(options) && options.length > 0) return options.map((option) => ({ value: option.value, name: option.name ?? option.value }))
  } catch {
    // Fall through.
  }
  return [{ value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }]
}

/**
 * Set a session's access mode.
 * @param ctx - Host context.
 * @param agent - live agent.
 * @param value - preset value.
 */
export function setPermission(ctx, agent, value) {
  const service = ctx.get('permissionPresets')
  if (typeof service?.set === 'function') {
    service.set(agent.session, value)
    return
  }
  const specs = { 'workspace-write': ['workspace-write', 'ask'], 'danger-full-access': ['danger-full-access', 'never'], 'read-only': ['read-only', 'ask'] }
  const spec = specs[value]
  if (spec === undefined) throw new Error(`unknown access mode ${value}`)
  agent.session.append('permission/preset', { preset: value })
  agent.session.append('sandbox/mode', { mode: spec[0] })
  agent.session.append('approval/policy', { policy: spec[1] })
}
