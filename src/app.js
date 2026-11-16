/** Host runtime: the Matrix connection, incoming events and the wiring of the parts. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { COMMANDS, SIGIL, helpText, parseCommand, runCommand } from './commands.js'
import { dataDir, name, POST_SOURCE_KIND, REQUEST_PREFIX, SERVICE_NAME } from './constants.js'
import { createHelpers } from './helpers.js'
import { composePrompt, describeReply, hasMedia, ownText, replyTargetOf } from './inbound.js'
import { connect as realConnect } from './matrix.js'
import { createModelCatalog } from './models.js'
import { allowedEntry, createOperations } from './operations.js'
import { createOutbound } from './outbound.js'
import { createPrompts } from './prompts.js'
import { createReactions } from './reactions.js'
import { createPrincipalTagger, matrixUserPrincipal, withPrincipal } from './sender.js'
import { admitPrompt, createSession, hasRequest, recordMessage, resolveAgent, unarchive } from './sessions.js'
import { createSpaces } from './spaces.js'
import { createSpool } from './spool.js'
import { openState } from './state.js'
import { clip, formatMoment } from './text.js'
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
  /** The previous connection's stop; a new one waits for it, as both would use one crypto store. */
  let stopped = Promise.resolve()
  let disposed = false
  let store
  const storeReady = openState().then((opened) => { store = opened })
  /** Live per-room state by room id. */
  const rooms = new Map()
  /** Event ids being handled, so an event seen twice is handled once. */
  const handling = new Set()
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

  /** @returns `{ userId, name }` of an allowed sender, or undefined. */
  function allowedSender(userId) {
    const entry = allowedEntry(setting('allowedUsers', []), userId)
    if (entry === undefined) return undefined
    return { userId, name: String(entry.name ?? '').trim() || userId.slice(1, userId.indexOf(':')) }
  }

  /** Remember a room's name and its person's name for the session title. */
  async function noteRoomIdentity(roomId, sender) {
    const record = store.room(roomId)
    let roomName = record?.roomName
    if (roomName === undefined) {
      roomName = (await matrix.getState(roomId, 'm.room.name').catch(() => undefined))?.name ?? ''
    }
    if (await store.describeRoom(roomId, { person: sender.name, roomName })) {
      const sessionId = store.room(roomId)?.sessionId
      if (typeof sessionId === 'string') await titles.apply(sessionId)
    }
  }

  // ----------------------------------------------------------------- inbound

  /**
   * One timeline event of any joined room, decrypted when it could be.
   * @param roomId - room id.
   * @param event - raw event.
   */
  async function onEvent(roomId, event) {
    await storeReady
    if (matrix === undefined || event?.sender === matrix.userId) return
    // The first sync of a new account carries old history, which is not new to the bot.
    if (typeof event.origin_server_ts === 'number' && event.origin_server_ts < (store.data.since ?? 0)) return
    try {
      if (event.type === 'm.room.message') await onMessage(roomId, event)
      else if (event.type === 'm.reaction') await onReaction(roomId, event)
      else if (event.type === 'm.space.child') await spaces.onChild(roomId, event)
      else if (event.type === 'm.room.power_levels') await retryWaitingSpace(roomId)
      else if (event.type === 'm.room.name' && store.room(roomId) !== undefined) {
        await store.describeRoom(roomId, { roomName: String(event.content?.name ?? '') })
        const sessionId = store.room(roomId)?.sessionId
        if (typeof sessionId === 'string') await titles.apply(sessionId)
      }
    } catch (error) {
      reportError(`event ${event.event_id} in ${roomId}`, error)
    }
  }

  /** A Space that waited for the bot's power level may be adoptable now. */
  async function retryWaitingSpace(roomId) {
    for (const [userId, record] of Object.entries(store.data.people)) {
      if (record?.waitingSpace !== roomId) continue
      if (await spaces.adoptSpace(userId, roomId)) await store.describePerson(userId, { waitingSpace: undefined })
    }
  }

  /** An invite: allowed people get the bot, others are turned down. */
  async function onInvite(roomId, event) {
    await storeReady
    const inviter = event?.sender
    const sender = allowedSender(inviter)
    if (sender === undefined) {
      const first = await store.notePending({ userId: String(inviter ?? 'unknown'), roomId, kind: 'invite' })
      if (first) info(`turned down an invite from ${inviter}; add them to allowedUsers to let them in`)
      await matrix?.leave(roomId).catch(() => {})
      return
    }
    try {
      await matrix.join(roomId)
      await spaces.onJoinedByInvite(roomId, inviter)
      info(`joined ${roomId} on ${inviter}'s invite`)
    } catch (error) {
      reportError(`invite to ${roomId}`, error)
    }
  }

  /** The bot left or was removed: the room's session stays in DSH. */
  async function onLeave(roomId) {
    await storeReady
    if (store.room(roomId) !== undefined) await store.forget(roomId)
  }

  /**
   * One message: check the sender, run a command or hand the message to the
   * room's session, then send a read receipt.
   */
  async function onMessage(roomId, event) {
    const content = event.content ?? {}
    if (content['m.relates_to']?.rel_type === 'm.replace' || handling.has(event.event_id)) return
    const sender = allowedSender(event.sender)
    if (sender === undefined) {
      const first = await store.notePending({ userId: String(event.sender), roomId, kind: 'message' })
      if (first) info(`ignored a message from ${event.sender}; add them to allowedUsers to let them in`)
      return
    }
    let record = store.room(roomId)
    // A room the bot is in without a record (state lost or made before) becomes the sender's.
    if (record?.owner === undefined && (await matrix.getState(roomId, 'm.room.create'))?.type !== 'm.space') {
      await spaces.onJoinedByInvite(roomId, sender.userId)
      record = store.room(roomId)
    }
    // A room is one person's: other people's messages there are not prompts.
    if (record?.owner !== sender.userId) return
    handling.add(event.event_id)
    try {
      await noteRoomIdentity(roomId, sender)
      await publishStatus({ lastMessageAt: Date.now(), lastRoomId: roomId })
      roomState(roomId).lastInbound = event.event_id
      const media = hasMedia(content)
      if (!media && prompts.consumeReply(roomId, ownText(content))) {
        await matrix.readReceipt(roomId, event.event_id).catch(() => {})
        return
      }
      const command = media ? undefined : parseCommand(content)
      if (command !== undefined) {
        try {
          await runCommand(bridge, { roomId, sender, eventId: event.event_id }, command)
        } catch (error) {
          await notice(roomId, `❌ ${messageOf(error)}`)
        }
        await matrix.readReceipt(roomId, event.event_id).catch(() => {})
        return
      }
      if (!media && ownText(content).length === 0) return
      try {
        await dispatchPrompt(roomId, event, sender)
      } catch (error) {
        await notice(roomId, `❌ Your message did not reach the session: ${messageOf(error)}`)
        throw error
      }
      await matrix.readReceipt(roomId, event.event_id).catch(() => {})
    } finally {
      handling.delete(event.event_id)
    }
  }

  /**
   * Hand a message to the room's session: into the running turn (`steer`) or
   * after it (`queue`), with its sender, reply context and media. The message
   * gets the working reaction first, so the sender sees at once that it was
   * taken.
   */
  async function dispatchPrompt(roomId, event, sender) {
    const room = roomState(roomId)
    // Messages reach the session in the order they arrived.
    while (room.admission !== undefined) await room.admission
    let release
    room.admission = new Promise((resolve) => { release = resolve })
    const requestId = `${REQUEST_PREFIX}${roomId}:${event.event_id}`
    const steer = setting('busyMessages', 'steer') !== 'queue'
    let react = false
    try {
      const boundId = store.room(roomId)?.sessionId
      const live = typeof boundId === 'string' ? ctx.get('agents')?.get(boundId) : undefined
      // A message handed over before (a restart before its receipt) gets no new sign.
      react = live === undefined || !hasRequest(live, requestId)
      if (react) await reactions.mark(roomId, event.event_id, reactions.emojiFor(live?.status !== undefined && live.status !== 'idle', steer))
      const replyTo = replyTargetOf(event.content)
      const target = replyTo === undefined ? undefined : await matrix.getEvent(roomId, replyTo).catch(() => undefined)
      const context = describeReply(target, { botId: matrix.userId, sentRecord: replyTo === undefined ? undefined : store.sentRecord(replyTo), names: { [sender.userId]: sender.name } })
      const prompt = await composePrompt(event, {
        download: (content) => matrix.download(content),
        mediaDir: join(dataDir(), 'media'),
        attachments: ctx.get('attachments'),
        voice: {
          mode: setting('transcriber', 'dsh'),
          language: setting('transcribeLanguage', ''),
          command: setting('transcribeCommand', []),
          ffmpeg: setting('ffmpegPath', 'ffmpeg'),
          speech: ctx.get('speech'),
        },
        signal: lifetime.signal,
        warn,
      })
      const agent = await ensureAgent(roomId)
      const sessionId = agent.session?.id ?? agent.id
      if (await unarchive(ctx, sessionId)) info(`unarchived session ${sessionId} for a message from room ${roomId}`)
      const running = agent.status !== undefined && agent.status !== 'idle'
      const mode = running && steer ? 'steer' : 'queue'
      const principal = matrixUserPrincipal(sender.userId, { name: sender.name, roomId, room: store.room(roomId)?.roomName })
      principals.remember(requestId, { principal, context, sentAt: formatMoment(event.origin_server_ts) })
      const admitted = await admitPrompt(ctx, agent, { requestId, text: prompt.text, attachments: prompt.attachments, mode, principal }, lifetime.signal)
      if (!react) return
      if (admitted) reactions.admitted(event.event_id)
      else await reactions.release([event.event_id])
    } catch (error) {
      if (react) await reactions.release([event.event_id]).catch(() => {})
      throw error
    } finally {
      room.admission = undefined
      release()
    }
  }

  /**
   * A reaction: the answer to a question or approval, otherwise noted in the
   * room's session.
   */
  async function onReaction(roomId, event) {
    const relation = event.content?.['m.relates_to']
    if (relation?.rel_type !== 'm.annotation' || typeof relation.event_id !== 'string') return
    const sender = allowedSender(event.sender)
    if (sender === undefined || store.room(roomId)?.owner !== sender.userId) return
    if (prompts.onReaction(roomId, relation.event_id, String(relation.key ?? ''))) return
    const sessionId = store.room(roomId)?.sessionId
    const agent = typeof sessionId === 'string' ? ctx.get('agents')?.get(sessionId) : undefined
    if (agent === undefined) return
    const target = await matrix.getEvent(roomId, relation.event_id).catch(() => undefined)
    if (target === undefined) return
    const owner = target.sender === matrix.userId ? 'your message' : 'the message'
    const text = `[Matrix: ${sender.name} reacted ${relation.key} to ${owner} ${relation.event_id}:]\n${clip(ownText(target.content), 500)}`
    const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: POST_SOURCE_KIND, form: 'notice', summary: clip(`${sender.name} reacted ${relation.key}`, 120) } }
    recordMessage(agent, withPrincipal(message, matrixUserPrincipal(sender.userId, { name: sender.name, roomId })))
  }

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
      connection = await connect({ dir: join(dataDir(), 'account'), ...loginSettings(), info, warn })
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
    if (matrix.userId !== String(setting('userId', '')).trim()) {
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
