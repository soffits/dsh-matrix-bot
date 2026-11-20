/**
 * Incoming events: invites, messages, reactions and Space changes, checked
 * against the allowlist and handed to commands, prompts or the room's session.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { withMetadata } from '@soffits/dsh-channel-core'
import { parseCommand, runCommand } from './commands.js'
import { dataDir, POST_SOURCE_KIND, REQUEST_PREFIX } from './constants.js'
import { composePrompt, hasMedia, ownText, replyInfo, replyTargetOf } from './inbound.js'
import { allowedEntry } from './operations.js'
import { matrixUserPrincipal } from './sender.js'
import { admitPrompt, hasRequest, recordMessage, unarchive } from './sessions.js'
import { clip } from './text.js'

/** @returns a short message for any thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error?.message ?? error)
}

/**
 * Create the event handlers.
 * @param deps - `{ ctx, getStore, storeReady, getMatrix, setting, spaces, prompts, reactions, principals, titles, notice, roomState, ensureAgent, publishStatus, getBridge, reportError, info, warn, signal }`.
 * @returns `{ onEvent, onInvite, onLeave }`.
 */
export function createEvents({ ctx, getStore, storeReady, getMatrix, setting, spaces, prompts, reactions, principals, titles, notice, roomState, ensureAgent, publishStatus, getBridge, reportError, info, warn, signal }) {
  /** Event ids being handled, so an event seen twice is handled once. */
  const handling = new Set()

  /** @returns `{ userId, name }` of an allowed sender, or undefined. */
  function allowedSender(userId) {
    const entry = allowedEntry(setting('allowedUsers', []), userId)
    if (entry === undefined) return undefined
    return { userId, name: String(entry.name ?? '').trim() || userId.slice(1, userId.indexOf(':')) }
  }

  /** Remember a room's name and its person's name for the session title. */
  async function noteRoomIdentity(roomId, sender) {
    const record = getStore().room(roomId)
    let roomName = record?.roomName
    if (roomName === undefined) {
      roomName = (await getMatrix().getState(roomId, 'm.room.name').catch(() => undefined))?.name ?? ''
    }
    if (await getStore().describeRoom(roomId, { person: sender.name, roomName })) {
      const sessionId = getStore().room(roomId)?.sessionId
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
    const matrix = getMatrix()
    if (matrix === undefined || event?.sender === matrix.userId) return
    // The first sync of a new account carries old history, which is not new to the bot.
    if (typeof event.origin_server_ts === 'number' && event.origin_server_ts < (getStore().data.since ?? 0)) return
    try {
      if (event.type === 'm.room.message') await onMessage(roomId, event)
      else if (event.type === 'm.reaction') await onReaction(roomId, event)
      else if (event.type === 'm.space.child') await spaces.onChild(roomId, event)
      else if (event.type === 'm.room.power_levels') await retryWaitingSpace(roomId)
      else if (event.type === 'm.room.name' && getStore().room(roomId) !== undefined) {
        await getStore().describeRoom(roomId, { roomName: String(event.content?.name ?? '') })
        const sessionId = getStore().room(roomId)?.sessionId
        if (typeof sessionId === 'string') await titles.apply(sessionId)
      }
    } catch (error) {
      reportError(`event ${event.event_id} in ${roomId}`, error)
    }
  }

  /** A Space that waited for the bot's power level may be adoptable now. */
  async function retryWaitingSpace(roomId) {
    for (const [userId, record] of Object.entries(getStore().data.people)) {
      if (record?.waitingSpace !== roomId) continue
      if (await spaces.adoptSpace(userId, roomId)) await getStore().describePerson(userId, { waitingSpace: undefined })
    }
  }

  /** An invite: allowed people get the bot, others are turned down. */
  async function onInvite(roomId, event) {
    await storeReady
    const inviter = event?.sender
    const sender = allowedSender(inviter)
    if (sender === undefined) {
      const first = await getStore().notePending({ userId: String(inviter ?? 'unknown'), roomId, kind: 'invite' })
      if (first) info(`turned down an invite from ${inviter}; add them to allowedUsers to let them in`)
      await getMatrix()?.leave(roomId).catch(() => {})
      return
    }
    try {
      await getMatrix().join(roomId)
      await spaces.onJoinedByInvite(roomId, inviter)
      info(`joined ${roomId} on ${inviter}'s invite`)
    } catch (error) {
      reportError(`invite to ${roomId}`, error)
    }
  }

  /** The bot left or was removed: the room's session stays in DSH. */
  async function onLeave(roomId) {
    await storeReady
    if (getStore().room(roomId) !== undefined) await getStore().forget(roomId)
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
      const first = await getStore().notePending({ userId: String(event.sender), roomId, kind: 'message' })
      if (first) info(`ignored a message from ${event.sender}; add them to allowedUsers to let them in`)
      return
    }
    let record = getStore().room(roomId)
    // A room the bot is in without a record (state lost or made before) becomes the sender's.
    if (record?.owner === undefined && (await getMatrix().getState(roomId, 'm.room.create'))?.type !== 'm.space') {
      await spaces.onJoinedByInvite(roomId, sender.userId)
      record = getStore().room(roomId)
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
        await getMatrix().readReceipt(roomId, event.event_id).catch(() => {})
        return
      }
      const command = media ? undefined : parseCommand(content)
      if (command !== undefined) {
        try {
          await runCommand(getBridge(), { roomId, sender, eventId: event.event_id }, command)
        } catch (error) {
          await notice(roomId, `❌ ${messageOf(error)}`)
        }
        await getMatrix().readReceipt(roomId, event.event_id).catch(() => {})
        return
      }
      if (!media && ownText(content).length === 0) return
      try {
        await dispatchPrompt(roomId, event, sender)
      } catch (error) {
        await notice(roomId, `❌ Your message did not reach the session: ${messageOf(error)}`)
        throw error
      }
      await getMatrix().readReceipt(roomId, event.event_id).catch(() => {})
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
      const boundId = getStore().room(roomId)?.sessionId
      const live = typeof boundId === 'string' ? ctx.get('agents')?.get(boundId) : undefined
      // A message handed over before (a restart before its receipt) gets no new sign.
      react = live === undefined || !hasRequest(live, requestId)
      if (react) await reactions.mark(roomId, event.event_id, reactions.emojiFor(live?.status !== undefined && live.status !== 'idle', steer))
      const replyTo = replyTargetOf(event.content)
      const target = replyTo === undefined ? undefined : await getMatrix().getEvent(roomId, replyTo).catch(() => undefined)
      const reply = replyInfo(target, { botId: getMatrix().userId, senderId: sender.userId, sentRecord: replyTo === undefined ? undefined : getStore().sentRecord(replyTo), names: { [sender.userId]: sender.name } })
      const prompt = await composePrompt(event, {
        download: (content) => getMatrix().download(content),
        mediaDir: join(dataDir(), 'media'),
        attachments: ctx.get('attachments'),
        voice: {
          mode: setting('transcriber', 'dsh'),
          language: setting('transcribeLanguage', ''),
          command: setting('transcribeCommand', []),
          ffmpeg: setting('ffmpegPath', 'ffmpeg'),
          speech: ctx.get('speech'),
        },
        signal: signal,
        warn,
      })
      const agent = await ensureAgent(roomId)
      const sessionId = agent.session?.id ?? agent.id
      if (await unarchive(ctx, sessionId)) info(`unarchived session ${sessionId} for a message from room ${roomId}`)
      const running = agent.status !== undefined && agent.status !== 'idle'
      const mode = running && steer ? 'steer' : 'queue'
      const principal = matrixUserPrincipal(sender.userId, { name: sender.name, roomId, room: getStore().room(roomId)?.roomName })
      const envelope = {
        ...(typeof event.origin_server_ts === 'number' ? { sentAt: event.origin_server_ts } : {}),
        ...(reply === undefined ? {} : { replyTo: reply }),
      }
      const metadata = { principal, ...(Object.keys(envelope).length === 0 ? {} : { envelope }) }
      principals.remember(requestId, metadata)
      const admitted = await admitPrompt(ctx, agent, { requestId, text: prompt.text, attachments: prompt.attachments, mode, ...metadata }, signal)
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
    if (sender === undefined || getStore().room(roomId)?.owner !== sender.userId) return
    if (prompts.onReaction(roomId, relation.event_id, String(relation.key ?? ''))) return
    const sessionId = getStore().room(roomId)?.sessionId
    const agent = typeof sessionId === 'string' ? ctx.get('agents')?.get(sessionId) : undefined
    if (agent === undefined) return
    const target = await getMatrix().getEvent(roomId, relation.event_id).catch(() => undefined)
    if (target === undefined) return
    const owner = target.sender === getMatrix().userId ? 'your message' : 'the message'
    const text = `[Matrix: ${sender.name} reacted ${relation.key} to ${owner} ${relation.event_id}:]\n${clip(ownText(target.content), 500)}`
    const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: POST_SOURCE_KIND, form: 'notice', summary: clip(`${sender.name} reacted ${relation.key}`, 120) } }
    recordMessage(agent, withMetadata(message, { principal: matrixUserPrincipal(sender.userId, { name: sender.name, roomId }) }))
  }


  return { onEvent, onInvite, onLeave }
}
