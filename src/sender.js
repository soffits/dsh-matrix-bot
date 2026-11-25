/**
 * The `matrix-user` principal: who wrote a message in a room. The shared
 * fields and the tagger that records it on prompts are in
 * @soffits/dsh-plugin-sdk/channel.
 */
import { nonEmpty } from '@soffits/dsh-plugin-sdk/channel'

/**
 * The Matrix user who wrote a message, and where.
 * @param userId - their Matrix user id.
 * @param where - `{ name, roomId, room }`: their name from the allowlist, the room and its name,
 *   recorded as `chat` (where the message was sent), the field renderers read.
 * @returns the principal, or undefined without a sender.
 */
export function matrixUserPrincipal(userId, { name, roomId, room } = {}) {
  if (nonEmpty(userId) === undefined) return undefined
  return {
    kind: 'matrix-user',
    channel: 'matrix',
    id: userId,
    ...(nonEmpty(name) === undefined ? {} : { name: nonEmpty(name) }),
    ...(nonEmpty(roomId) === undefined ? {} : { chat: { id: roomId, ...(nonEmpty(room) === undefined ? {} : { name: nonEmpty(room) }) } }),
  }
}
