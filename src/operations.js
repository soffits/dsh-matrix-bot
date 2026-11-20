/**
 * What the bot offers outside rooms: the send service, the room list,
 * allowing a person, and its status.
 */
import { randomUUID } from 'node:crypto'
import { sendPrincipal, withMetadata } from '@soffits/dsh-channel-core'
import { POST_SOURCE_KIND } from './constants.js'
import { finalError } from './outbound.js'
import { recordMessage, resolveAgent } from '@soffits/dsh-channel-core'
import { clip } from './text.js'

/** @returns the allowlist entry of a user id, or undefined. */
export function allowedEntry(allowed, userId) {
  if (typeof userId !== 'string' || userId.length === 0) return undefined
  return (Array.isArray(allowed) ? allowed : []).find((entry) => typeof entry?.userId === 'string' && entry.userId.trim() === userId)
}

/**
 * Create the operations.
 * @param deps - `{ ctx, getStore, storeReady, requireMatrix, getMatrix, getStatus, setting, outbound, currentTurn, reportError, messageOf }`.
 */
export function createOperations({ ctx, getStore, storeReady, requireMatrix, getMatrix, getStatus, setting, outbound, currentTurn, reportError, messageOf }) {
  const { queueOut, sendText, sendFiles, checkFiles, react, redact } = outbound

  /**
   * Send text, files or a reaction into a room on behalf of a job, a session
   * or a command, and record it in the session bound to that room.
   * @param request - `{ to, text, files, from, replyTo, reaction }`: `to` is
   *   the room id; `from` `{ job, jobId, sessionId, label }` names the sender;
   *   `replyTo` replies to an event; `reaction` reacts to `replyTo` instead of
   *   sending text.
   * @returns where it went and whether the session recorded it.
   */
  async function sendToRoom(request) {
    await storeReady
    const store = getStore()
    requireMatrix()
    const roomId = typeof request?.to === 'string' ? request.to.trim() : ''
    const record = store.room(roomId)
    if (record === undefined) throw finalError(`Unknown room ${request?.to}; !id in a room shows its id.`)
    const replyTo = typeof request?.replyTo === 'string' && request.replyTo.length > 0 ? request.replyTo : undefined
    if (typeof request?.reaction === 'string') {
      if (replyTo === undefined) throw finalError('A reaction needs replyTo: the event id to react to.')
      if (request.reaction.length === 0) throw finalError('Give the reaction to send; removing one is not supported.')
      const reactionId = await react(roomId, replyTo, request.reaction)
      return { roomId, reacted: replyTo, eventId: reactionId }
    }
    const text = typeof request?.text === 'string' ? request.text.trim() : ''
    const paths = Array.isArray(request?.files) ? request.files.map(String) : []
    if (text.length === 0 && paths.length === 0) throw finalError('Nothing to send: give text or files.')
    const from = request?.from ?? {}
    const sessionId = record.sessionId
    const ownTurn = typeof from.sessionId === 'string' && from.sessionId === sessionId ? currentTurn(sessionId) : undefined
    // The answer of a turn this room receives is delivered by itself, so text
    // a session sends into its own room would arrive twice.
    const delivered = ownTurn !== undefined && (ownTurn.ours || ownTurn.goal || ownTurn.mirrored)
    if (delivered && paths.length === 0) {
      throw finalError('This session is bound to that room and its answer is delivered there when the turn ends: write the text in your answer instead of sending it.')
    }
    const files = await checkFiles(paths)
    const eventIds = await queueOut(roomId, async () => {
      const ids = text.length > 0 ? await sendText(roomId, text, { replyTo }) : []
      ids.push(...await sendFiles(roomId, files))
      return ids
    })
    if (ownTurn !== undefined) {
      ownTurn.sent = true
      if (text.length > 0) ownTurn.sentTexts.push(text)
    }
    await store.noteSent({
      roomId,
      eventIds,
      text,
      files: files.map((file) => file.name),
      job: typeof from.job === 'string' && from.job.trim() ? from.job.trim() : null,
      fromSession: typeof from.sessionId === 'string' ? from.sessionId : null,
      label: typeof from.label === 'string' ? from.label : null,
    })
    let recorded = false
    let recordError
    if (typeof sessionId === 'string') {
      try {
        const agent = await resolveAgent(ctx, sessionId)
        const self = sessionId === from.sessionId
        const by = self ? ' by this session' : from.job ? ` by job "${from.job}"` : from.sessionId ? ` by session ${from.sessionId}` : from.label ? ` by ${from.label}` : ''
        const header = `Sent to Matrix room "${record.roomName ?? roomId}"${by}`
        const content = [{ type: 'text', text: `[${header}]${text ? `\n${text}` : ''}${files.length > 0 ? `\n[Files: ${files.map((file) => file.name).join(', ')}]` : ''}` }]
        const message = { id: randomUUID(), role: 'user', content, source: { kind: POST_SOURCE_KIND, form: 'notice', summary: clip(header, 120), roomId, self } }
        recordMessage(agent, withMetadata(message, { principal: sendPrincipal(from) }))
        recorded = true
      } catch (error) {
        recordError = messageOf(error)
        reportError('send-record', error)
      }
    }
    return { roomId, room: record.roomName ?? null, eventIds, sessionId: sessionId ?? null, recorded, ...(recordError ? { recordError } : {}) }
  }

  /** Known rooms: every room of an allowed person, with its name and session. */
  async function listRooms() {
    await storeReady
    return Object.entries(getStore().data.rooms)
      .filter(([, record]) => typeof record?.owner === 'string')
      .map(([roomId, record]) => ({ roomId, name: record.roomName ?? null, owner: record.owner, sessionId: record.sessionId ?? null }))
  }

  /**
   * Add someone to `allowedUsers` through the Host's config editor, which
   * writes the profile's patch the same way the settings page does.
   * @param userId - their Matrix user id.
   * @param name - how their messages are labelled.
   */
  async function allowUser(userId, name = '') {
    const id = String(userId ?? '').trim()
    if (!/^@[^:\s]+:\S+$/u.test(id)) throw finalError(`Not a Matrix user id: ${userId}`)
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (entry === undefined || editor === undefined) throw new Error('This profile cannot save the bot\'s configuration; add the user id to allowedUsers by hand.')
    const label = String(name ?? '').trim()
    await editor.edit(entry, (current) => {
      const list = Array.isArray(current?.allowedUsers) ? current.allowedUsers.filter((item) => item?.userId !== id) : []
      return { ...current, allowedUsers: [...list, { userId: id, name: label }] }
    })
    await storeReady
    await getStore().clearPending([id])
    return { userId: id, name: label }
  }

  /** The bot's status for commands and the command line. */
  function describe() {
    const matrix = getMatrix()
    const status = getStatus()
    const store = getStore()
    return {
      state: status.state,
      running: matrix !== undefined,
      homeserver: setting('homeserver', ''),
      userId: matrix?.userId,
      deviceId: matrix?.deviceId,
      encryption: matrix?.encryption() ?? { verified: false, backup: false },
      uptimeSeconds: status.startedAt === undefined ? 0 : Math.round((Date.now() - status.startedAt) / 1000),
      allowedUsers: setting('allowedUsers', []).filter((entry) => entry?.userId).length,
      pending: Object.values(store?.data.pending ?? {}),
      people: Object.entries(store?.data.people ?? {}).map(([userId, record]) => ({ userId, spaces: record.spaces ?? [], lobbyId: record.lobbyId ?? null })),
      lastError: status.lastError,
    }
  }

  return { sendToRoom, listRooms, allowUser, describe, redact }
}
