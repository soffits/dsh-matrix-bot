/**
 * Working signs: a message the bot works on carries a reaction from the bot
 * (⏳ for a new or queued turn, 👀 when it went into the running turn) until
 * the turn that took it has ended and its answer was sent; the reaction is
 * then redacted. A typing notice only shows while a turn runs, so a queued
 * message needs this sign. Reacted messages are kept in `state.json`, so a
 * sign left by a turn that a Host restart cut off is removed at the next start.
 */
import { REQUEST_PREFIX, STEER_REACTION, WORKING_REACTION } from './constants.js'
import { inInbox } from '@soffits/dsh-plugin-sdk/channel'

/**
 * Create the working-sign tracker.
 * @param deps - `{ ctx, getStore, outbound, isRunning, reportError }`.
 * @returns `{ emojiFor, mark, admitted, attach, finishTurn, sweep, resume, release }`.
 */
export function createReactions({ ctx, getStore, outbound, isRunning, reportError }) {
  /** Reacted messages by event id: `{ roomId, reactionId, admitted, turn }`. */
  const tracked = new Map()
  let loaded = false

  /** Take over the messages a previous run left reacted. */
  function load() {
    if (loaded) return
    const store = getStore()
    if (store === undefined) return
    loaded = true
    for (const [eventId, entry] of Object.entries(store.reactions())) {
      if (!tracked.has(eventId)) tracked.set(eventId, { roomId: entry.roomId, reactionId: entry.reactionId, admitted: true, turn: undefined })
    }
  }

  /** @returns the live agent of a room's session, or undefined. */
  function agentOf(roomId) {
    const sessionId = getStore()?.room(roomId)?.sessionId
    return typeof sessionId === 'string' ? ctx.get('agents')?.get(sessionId) : undefined
  }

  /**
   * The sign for a message about to go to a session.
   * @param running - whether the session runs a turn.
   * @param steer - whether a message during a turn goes into it.
   */
  function emojiFor(running, steer) {
    return running && steer ? STEER_REACTION : WORKING_REACTION
  }

  /** React to a message and remember it. */
  async function mark(roomId, eventId, emoji) {
    load()
    if (!isRunning()) return
    const entry = { roomId, reactionId: undefined, admitted: false, turn: undefined }
    tracked.set(eventId, entry)
    try {
      entry.reactionId = await outbound.react(roomId, eventId, emoji)
      await getStore()?.noteReaction(eventId, { roomId, reactionId: entry.reactionId })
    } catch (error) {
      reportError(`reaction on ${eventId}`, error)
    }
  }

  /** The message reached the session, so a sweep may judge it. */
  function admitted(eventId) {
    const entry = tracked.get(eventId)
    if (entry !== undefined) entry.admitted = true
  }

  /**
   * The message is part of a turn now.
   * @param eventId - Matrix event id.
   * @param turn - key of the turn (session id and turn number).
   */
  function attach(eventId, turn) {
    const entry = tracked.get(eventId)
    if (entry !== undefined) entry.turn = turn
  }

  /** Remove the bot's reaction from messages. */
  async function release(eventIds) {
    if (eventIds.length === 0 || !isRunning()) return
    const entries = eventIds.map((eventId) => tracked.get(eventId)).filter((entry) => entry?.reactionId !== undefined)
    for (const eventId of eventIds) tracked.delete(eventId)
    await getStore()?.dropReactions(eventIds)
    for (const entry of entries) {
      await outbound.redact(entry.roomId, entry.reactionId).catch((error) => reportError(`reaction ${entry.reactionId}`, error))
    }
  }

  /**
   * Messages of a room that will get no turn: admitted, not taken into a
   * turn, and no longer waiting in the agent's inbox (dropped by /stop or
   * /clear, or a duplicate).
   */
  function dropped(roomId, { ignoreTurn = false } = {}) {
    const agent = agentOf(roomId)
    return [...tracked].filter(([eventId, entry]) => entry.roomId === roomId && entry.admitted
      && (ignoreTurn || entry.turn === undefined) && !inInbox(agent, `${REQUEST_PREFIX}${roomId}:${eventId}`)).map(([eventId]) => eventId)
  }

  /**
   * A turn ended and its answer went out: clear its messages (whatever room
   * the session is bound to now) and the room's dropped ones.
   */
  async function finishTurn(roomId, turn) {
    load()
    const own = [...tracked].filter(([, entry]) => entry.turn === turn).map(([eventId]) => eventId)
    await release([...own, ...dropped(roomId)])
  }

  /** Clear the signs of a room's dropped messages. */
  async function sweep(roomId) {
    load()
    await release(dropped(roomId))
  }

  /** Clear signs whose session runs no turn, e.g. after a restart. */
  async function resume() {
    load()
    const idle = new Set([...tracked.values()].map((entry) => entry.roomId).filter((roomId) => {
      const agent = agentOf(roomId)
      return agent === undefined || agent.status === undefined || agent.status === 'idle'
    }))
    for (const roomId of idle) await release(dropped(roomId, { ignoreTurn: true }))
  }

  return { emojiFor, mark, admitted, attach, finishTurn, sweep, resume, release }
}
