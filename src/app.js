/** Host runtime: the Matrix connection, incoming events and the wiring of the parts. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createModelCatalog, createPrincipalTagger } from '@soffits/dsh-channel-core'
import { COMMANDS, SIGIL, helpText } from './commands.js'
import { dataDir, name, SERVICE_NAME } from './constants.js'
import { createEvents } from './events.js'
import { createHelpers } from './helpers.js'
import { connect as realConnect } from './matrix.js'
import { createOperations } from './operations.js'
import { createOutbound } from './outbound.js'
import { createPrompts } from './prompts.js'
import { createReactions } from './reactions.js'
import { createSession, resolveAgent } from './sessions.js'
import { createSpaces } from './spaces.js'
import { createSpool } from './spool.js'
import { openState } from './state.js'
import { createTitles } from './titles.js'
import { createTurns } from './turns.js'

/**
 * Read a Config field that may be a plain value or a volatile reference.
 * @param value - Config field.
 * @param fallback - value used when the field is absent.
 */
export function readLive(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const current = value.get()
      return current === undefined ? fallback : current
    } catch {
      return fallback
    }
  }
  return value === undefined || value === null ? fallback : value
}

/** @returns a short message for any thrown value. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error?.message ?? error)
}

/** Shortest and longest pause before connecting again after a failure. */
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

/**
 * Mount the bot.
 * @param ctx - Host plugin context.
 * @param config - live plugin configuration.
 */
export function apply(ctx, config) {
  createBridge(ctx, config, realConnect)
}

/**
 * The bot with its Matrix side passed in, so tests can drive it with a fake.
 * @param ctx - Host plugin context.
 * @param config - live plugin configuration.
 * @param connect - `connect(options)` from `matrix.js`, or a fake with the same shape.
 */
export function createBridge(ctx, config, connect) {
  // The Host keeps no plugin logger output, so lines also go to the process's
  // own output, which is where an operator reads DSH's log.
  const logger = typeof ctx.logger === 'function' ? ctx.logger('matrix') : ctx.logger
  const info = (message) => {
    logger?.info?.(message)
    if (process.env.NODE_ENV !== 'test') console.log(`[dsh-matrix-bot] ${message}`)
  }
  const warn = (message) => {
    logger?.warn?.(message)
    if (process.env.NODE_ENV !== 'test') console.error(`[dsh-matrix-bot] ${message}`)
  }
  const setting = (field, fallback) => readLive(config[field], fallback)
  const lifetime = new AbortController()

  /** The connection while it runs (see `matrix.js`). */
  let matrix
  let starting
  let retryTimer
  let retryDelay = RETRY_MIN_MS
  /** The account as configured when the running connection logged in. */
  let account
  /** The previous connection's stop; a new one waits for it, as both would use one crypto store. */
  let stopped = Promise.resolve()
  let disposed = false
  let store
  const storeReady = openState().then((opened) => { store = opened })
  /** Live per-room state by room id. */
  const rooms = new Map()
  const modelCatalog = createModelCatalog(ctx)
  const principals = createPrincipalTagger()
  let status = { state: 'starting', updatedAt: new Date().toISOString() }

  async function publishStatus(patch) {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() }
    try {
      await mkdir(dataDir(), { recursive: true, mode: 0o700 })
      await writeFile(join(dataDir(), 'status.json'), JSON.stringify(status, null, 2) + '\n', { mode: 0o600 })
    } catch {
      // Diagnostics never take the runtime down.
    }
  }

  function reportError(scope, error) {
    warn(`${scope}: ${messageOf(error)}`)
    void publishStatus({ lastError: { scope, detail: messageOf(error), at: new Date().toISOString() } })
  }

  function fireAndForget(scope, task) {
    Promise.resolve().then(task).catch((error) => reportError(scope, error))
  }

  /** @returns the live state of one room. */
  function roomState(roomId) {
    let room = rooms.get(roomId)
    if (room === undefined) {
      room = { roomId, out: Promise.resolve(), lastInbound: undefined, admission: undefined, goalPhase: undefined }
      rooms.set(roomId, room)
    }
    return room
  }

  function requireMatrix() {
    if (matrix === undefined) throw new Error('The Matrix bot is not running.')
    return matrix
  }
  const isRunning = () => matrix !== undefined
  const getStore = () => store

  const outbound = createOutbound({ requireMatrix, roomState, reportError, messageOf })
  const { notice, queueOut, sendText } = outbound
  const reactions = createReactions({ ctx, getStore, outbound, isRunning, reportError })
  const turns = createTurns({
    ctx,
    getStore,
    isRunning,
    setting,
    outbound,
    reactions,
    roomState,
    publishStatus,
    fireAndForget,
    messageOf,
    setTyping: async (roomId, typing, ms) => matrix?.setTyping(roomId, typing, ms),
  })
  const { currentTurn } = turns
  const helpers = createHelpers({ ctx, getStore, isRunning, outbound, currentTurn, reportError })
  const operations = createOperations({
    ctx,
    getStore,
    storeReady,
    requireMatrix,
    getMatrix: () => matrix,
    getStatus: () => status,
    setting,
    outbound,
    currentTurn,
    reportError,
    messageOf,
  })
  const { sendToRoom, listRooms, allowUser, describe } = operations
  const spaces = createSpaces({ requireMatrix, getStore, setting, notice, commands: COMMANDS, sigil: SIGIL, helpText, info, warn })
  const titles = createTitles({ ctx, getStore, warn })

  const prompts = createPrompts({
    roomOfAgent: (agent) => {
      const sessionId = agent.session?.id ?? agent.id
      const roomId = store?.roomOfSession(sessionId)
      if (roomId === undefined) return undefined
      // Only turns started from Matrix ask there; others ask where they started.
      return currentTurn(sessionId)?.ours === true ? roomId : undefined
    },
    send: (roomId, text) => notice(roomId, text),
    react: (roomId, eventId, key) => outbound.react(roomId, eventId, key),
    warn,
  })

  // ---------------------------------------------------------------- sessions

  /**
   * The live agent of a room's session, creating the session when the room
   * has none.
   * @param roomId - room id.
   * @param options - `{ claim }`: end the blank state of a new session at once.
   */
  async function ensureAgent(roomId, { claim = false } = {}) {
    await storeReady
    const record = store.room(roomId)
    if (typeof record?.sessionId === 'string') {
      try {
        const agent = await resolveAgent(ctx, record.sessionId)
        prompts.attach(agent)
        return agent
      } catch (error) {
        warn(`session ${record.sessionId} of room ${roomId} could not be resumed, starting a new one: ${messageOf(error)}`)
        await store.release(roomId)
      }
    }
    const cwd = record?.cwd ?? setting('cwd', process.cwd())
    const preset = String(setting('agentPreset', '')).trim() || undefined
    const model = store.data.picks[roomId]
    const agent = await createSession(ctx, { cwd, preset, model, roomId, claim, warn })
    const sessionId = agent.session?.id ?? agent.id
    await store.bind(roomId, { sessionId, cwd })
    await titles.apply(sessionId)
    prompts.attach(agent)
    info(`room ${roomId} now uses session ${sessionId}`)
    return agent
  }

  const events = createEvents({
    ctx,
    getStore,
    storeReady,
    getMatrix: () => matrix,
    setting,
    spaces,
    prompts,
    reactions,
    principals,
    titles,
    notice,
    roomState,
    ensureAgent,
    publishStatus,
    getBridge: () => bridge,
    reportError,
    info,
    warn,
    signal: lifetime.signal,
  })
  const { onEvent, onInvite, onLeave } = events

  // ---------------------------------------------------------- send service

  const service = {
    send: (request = {}) => sendToRoom(request),
    rooms: () => listRooms(),
  }
  if (typeof ctx.provide === 'function') ctx.provide(SERVICE_NAME, service)

  // -------------------------------------------------------------- lifecycle

  /** The login settings, or an error naming what is missing. */
  function loginSettings() {
    const homeserver = String(setting('homeserver', '')).trim()
    const userId = String(setting('userId', '')).trim()
    const passwordFile = String(setting('passwordFile', '')).trim()
    const missing = [!homeserver && 'homeserver', !userId && 'userId', !passwordFile && 'passwordFile'].filter(Boolean)
    if (missing.length > 0) throw new Error(`set ${missing.join(', ')} in the plugin settings`)
    const recoveryKeyFile = String(setting('recoveryKeyFile', '')).trim() || join(dataDir(), 'recovery-key')
    return { homeserver, userId, passwordFile, recoveryKeyFile, deviceName: String(setting('deviceName', 'DSH')) }
  }

  async function startRuntime() {
    if (disposed || matrix !== undefined) return
    if (setting('enabled', true) === false) {
      await publishStatus({ state: 'disabled', detail: '' })
      return
    }
    await publishStatus({ state: 'starting', detail: '' })
    let connection
    try {
      await stopped
      if (store.data.since === undefined) {
        store.data.since = Date.now()
        await store.save()
      }
      const login = loginSettings()
      connection = await connect({ dir: join(dataDir(), 'account'), ...login, info, warn })
      account = login.userId
      if (disposed) {
        stopped = Promise.resolve(connection.stop()).catch(() => {})
        return
      }
      matrix = connection
      await connection.start({
        onEvent: (roomId, event) => onEvent(roomId, event),
        onInvite: (roomId, event) => fireAndForget('invite', () => onInvite(roomId, event)),
        onLeave: (roomId) => fireAndForget('leave', () => onLeave(roomId)),
      })
      await applyProfile()
      retryDelay = RETRY_MIN_MS
      const encryption = connection.encryption()
      info(`running as ${connection.userId} (device ${connection.deviceId}; ${encryption.verified ? 'verified' : 'NOT verified'}, key backup ${encryption.backup ? 'on' : 'off'})`)
      await publishStatus({ state: 'running', detail: '', userId: connection.userId, deviceId: connection.deviceId, encryption, startedAt: Date.now() })
      spool.start().catch((error) => reportError('spool', error))
      // Working reactions left by turns that ended while the bot was down.
      await reactions.resume().catch((error) => reportError('reactions', error))
    } catch (error) {
      reportError('start', error)
      await publishStatus({ state: 'error', detail: messageOf(error) })
      if (matrix === undefined && connection !== undefined) stopped = Promise.resolve(connection.stop()).catch(() => {})
      stopRuntime()
      scheduleRetry()
    }
  }

  /** Bring the account's name and picture to the settings. */
  async function applyProfile() {
    const displayName = String(setting('displayName', '')).trim()
    const avatar = String(setting('avatar', '')).trim()
    const newAvatar = avatar.length > 0 && store.data.avatar !== avatar ? avatar : undefined
    try {
      await matrix.setProfile({ displayName, avatar: newAvatar })
      if (newAvatar !== undefined) {
        store.data.avatar = newAvatar
        await store.save()
      }
    } catch (error) {
      reportError('profile', error)
    }
  }

  function stopRuntime() {
    const current = matrix
    matrix = undefined
    spool.stop()
    if (current === undefined) return
    stopped = Promise.resolve(current.stop()).catch((error) => reportError('stop', error))
    void publishStatus({ state: disposed ? 'stopped' : 'restarting' })
  }

  function scheduleRetry() {
    if (disposed || retryTimer !== undefined) return
    const delay = retryDelay
    retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2)
    info(`connecting again in ${Math.round(delay / 1000)} s`)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void start()
    }, delay)
    retryTimer.unref?.()
  }

  function start() {
    starting ??= startRuntime().finally(() => { starting = undefined })
    return starting
  }

  async function restart(reason) {
    info(`restart: ${reason}`)
    await starting
    stopRuntime()
    await start()
  }

  /** Apply a settings change: start or stop, reconnect when the login changed. */
  async function applySettings() {
    if (setting('enabled', true) === false) {
      stopRuntime()
      await publishStatus({ state: 'disabled' })
      return
    }
    if (matrix === undefined) {
      await start()
      return
    }
    if (account !== String(setting('userId', '')).trim()) {
      await restart('the account changed')
      return
    }
    await applyProfile()
    await store.clearPending(setting('allowedUsers', []).map((entry) => entry?.userId).filter(Boolean))
  }

  // Requests from the `dsh-matrix` command.
  const spool = createSpool({
    ready: () => matrix !== undefined,
    onError: (error) => reportError('spool', error),
    handle: async (request) => {
      if (request.op === 'send') return sendToRoom(request)
      if (request.op === 'status') return describe()
      if (request.op === 'rooms') return listRooms()
      if (request.op === 'allow') return allowUser(request.userId, request.name)
      throw new Error(`unknown request ${request.op}`)
    },
  })

  /** What commands may use. */
  const bridge = {
    ctx,
    setting,
    store: () => store,
    matrix: requireMatrix,
    roomState,
    currentTurn,
    ensureAgent,
    reactions,
    helpers,
    spaces,
    notice,
    say: (roomId, text) => queueOut(roomId, () => sendText(roomId, text)),
    modelCatalog,
    prompts,
    describe,
    restart: (reason) => fireAndForget('restart', () => restart(reason)),
    applyTitle: (sessionId) => titles.apply(sessionId),
    info,
    warn,
    signal: lifetime.signal,
  }

  ctx.on('session/event', (session, event) => {
    try {
      turns.onSessionEvent(session, event)
    } catch (error) {
      reportError('session-event', error)
    }
    // Titles change after the title service folded this event.
    if (store === undefined || store.roomOfSession(session?.id) === undefined) return
    if (event?.type === 'session/title' && event.data?.source?.kind !== 'user') fireAndForget('title', () => titles.apply(session.id))
    else if (event?.type === 'request/header') fireAndForget('title', () => titles.start(session.id))
  }, { global: true })

  ctx.on('agent/assistant-stream', (payload) => {
    try {
      turns.onStream(payload?.agent?.session?.id, payload?.frame)
    } catch (error) {
      reportError('stream', error)
    }
  }, { global: true })

  ctx.on('agent/pre-step', (payload, next) => principals.preStep(payload, next), { global: true })
  ctx.on('subagent/start', (event) => fireAndForget('helpers', () => helpers.onStart(event)), { global: true })
  ctx.on('subagent/end', (event) => fireAndForget('helpers', () => helpers.onEnd(event)), { global: true })

  ctx.on('settings/document-updated', (namespace) => {
    if (namespace === name) fireAndForget('settings', () => applySettings())
  })

  ctx.effect(() => {
    void storeReady.then(() => start()).catch((error) => reportError('start', error))
    return () => {
      disposed = true
      lifetime.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      prompts.cancelAll()
      helpers.dispose()
      turns.dispose()
      stopRuntime()
    }
  }, 'dsh-matrix-bot: runtime')
}
