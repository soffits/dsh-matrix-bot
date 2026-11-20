/**
 * Subagent activity in rooms: the shared status card (`createAgentBoards`)
 * drawn as one plain message per room, edited in place as subagents start
 * and finish. Matrix event ids do not grow, so the card is never moved down.
 */
import { createAgentBoards, sessionModelOf, subagentLabel } from '@soffits/dsh-channel-core'

/**
 * The status card of the rooms' subagents.
 * @param deps - `{ ctx, getStore, isRunning, outbound, currentTurn, reportError }`.
 * @returns `{ onStart, onEnd, dispose }`.
 */
export function createSubagentStatus({ ctx, getStore, isRunning, outbound, currentTurn, reportError }) {
  const { queueOut, sendText, editText } = outbound
  return createAgentBoards({
    parentOf: (id) => ctx.get('agents')?.get(id)?.session?.header?.parentSession,
    topicOf: (sessionId) => {
      const roomId = isRunning() ? getStore()?.roomOfSession(sessionId) : undefined
      return roomId === undefined ? undefined : { key: roomId, roomId, sessionId }
    },
    // The card shows where the session's answers show.
    showsTurn: (room) => {
      const turn = currentTurn(room.sessionId)
      return turn !== undefined && (turn.ours || turn.goal || turn.mirrored)
    },
    labelOf: (parentId, childId) => subagentLabel(ctx, parentId, childId),
    modelOf: async (id) => (await sessionModelOf(ctx, id).catch(() => undefined))?.model,
    post: async (room, text) => {
      try {
        const [eventId] = await queueOut(room.roomId, () => sendText(room.roomId, text, { plain: true }))
        return eventId
      } catch (error) {
        reportError(`subagent status in room ${room.roomId}`, error)
        return undefined
      }
    },
    edit: async (room, eventId, text) => {
      try {
        await queueOut(room.roomId, () => editText(room.roomId, eventId, text, { plain: true }))
        return 'ok'
      } catch (error) {
        // Without edits the new state goes out as its own message.
        reportError(`editing subagent status ${eventId}`, error)
        return 'gone'
      }
    },
    remove: async (room, eventId) => queueOut(room.roomId, () => outbound.redact(room.roomId, eventId)),
    reportError,
  })
}
