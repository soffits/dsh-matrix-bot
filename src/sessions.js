/**
 * The room side of DSH sessions, on top of the shared session helpers: a
 * room's new session, its pending prompts, titles and access modes.
 */
import { basename } from 'node:path'
import { appendAccessMode, attachToWorkspace, claimSession, createSession, removePending, storedTitle } from '@soffits/dsh-plugin-sdk/channel'
import { REQUEST_PREFIX } from './constants.js'

/**
 * Create a session for a room, composed the way the Web UI composes one.
 * @param ctx - Host context.
 * @param options - `{ cwd, preset, model, roomId, claim, warn }`; `claim` ends
 *   the blank state at once (for sessions that will not get a prompt now).
 * @returns the new session's agent.
 */
export async function createRoomSession(ctx, { cwd, preset, model, roomId, claim, warn }) {
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
  const agent = await createSession(ctx, { cwd, preset, setup, warn })
  const sessionId = agent.session?.id ?? agent.id
  if (model !== undefined) {
    try {
      agent.model.select(model)
    } catch (error) {
      warn(`could not start ${sessionId} on ${model.provider}/${model.model}: ${error?.message ?? error}`)
    }
  }
  if (claim) await claimSession(agent, { text: `[This session belongs to Matrix room ${roomId}]`, rpcPrefix: 'matrix-claim' })
  await attachToWorkspace(ctx, sessionId, cwd, warn)
  return agent
}

/**
 * Remove prompts from one room that the agent has not taken yet.
 * @param agent - the session's agent.
 * @param roomId - Matrix room id.
 * @returns how many were removed.
 */
export function clearRoomInbox(agent, roomId) {
  const prefix = `${REQUEST_PREFIX}${roomId}:`
  return removePending(agent, (requestId) => requestId.startsWith(prefix))
}

/**
 * A session's title, or a short fallback.
 * @param ctx - Host context.
 * @param sessionId - session id.
 * @param header - session header when known.
 */
export async function sessionTitle(ctx, sessionId, header) {
  const title = await storedTitle(ctx, sessionId)
  if (title !== undefined) return title
  const base = typeof header?.cwd === 'string' && header.cwd.length > 0 ? basename(header.cwd) : 'Session'
  return `${base} · ${String(sessionId).slice(-6)}`
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
  if (!appendAccessMode(agent.session, value)) throw new Error(`unknown access mode ${value}`)
}
