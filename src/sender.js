/**
 * Who sent a message, as data on the message itself.
 *
 * DSH's field for the caller behind a user message is `source.principal`:
 * the session controller writes it for callers other than the owner, so an
 * absent principal means the owner. The bot admits every Matrix prompt as
 * the owner, so it fills the field itself, and also on the copies of sends it
 * records in bound sessions. Readers get the sender from it, not from text.
 *
 * Every principal has `kind`, `channel` and `id`, and `name` when one is
 * known; the other fields depend on the kind. None carries a credential, so
 * all are safe in a session log.
 *
 * The model learns the sender, when the message was sent, and the context of
 * the message (what it replies to, where a forward comes from), from a notice
 * message placed right before the prompt, not from lines inside the prompt: DSH titles a session
 * from the first words of its first human message, and those must be the
 * person's own.
 */

import { randomUUID } from 'node:crypto'

/** Remembered prompts waiting for their step; the oldest go first past this. */
export const MAX_PENDING_PRINCIPALS = 1024

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * The Matrix user who wrote a message, and where.
 * @param userId - their Matrix user id.
 * @param where - `{ name, roomId, room }`: their name from the allowlist, the room and its name.
 * @returns the principal, or undefined without a sender.
 */
export function matrixUserPrincipal(userId, { name, roomId, room } = {}) {
  if (nonEmpty(userId) === undefined) return undefined
  return {
    kind: 'matrix-user',
    channel: 'matrix',
    id: userId,
    ...(nonEmpty(name) === undefined ? {} : { name: nonEmpty(name) }),
    ...(nonEmpty(roomId) === undefined ? {} : { room: { id: roomId, ...(nonEmpty(room) === undefined ? {} : { name: nonEmpty(room) }) } }),
  }
}

/**
 * The sender of a send into a room, from the request's `from`: a scheduled
 * job, else a DSH session, else the free-form label of an outside caller.
 * @param from - `{ job?, jobId?, sessionId?, label? }`.
 * @returns the principal, or undefined when the request names no sender.
 */
export function sendPrincipal(from) {
  const job = nonEmpty(from?.job)
  const jobId = nonEmpty(from?.jobId)
  const sessionId = nonEmpty(from?.sessionId)
  const label = nonEmpty(from?.label)
  if (job !== undefined || jobId !== undefined) {
    return {
      kind: 'cron-job',
      channel: 'cron',
      id: jobId ?? job,
      ...(job === undefined ? {} : { name: job }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
  }
  if (sessionId !== undefined) {
    return { kind: 'dsh-session', channel: 'dsh', id: sessionId, ...(label === undefined ? {} : { name: label }) }
  }
  if (label !== undefined) return { kind: 'external', channel: 'external', id: label, name: label }
  return undefined
}

/**
 * A frozen copy of a message whose source records its sender.
 * @param message - the user message.
 * @param principal - its sender.
 * @returns the copy; the message itself when there is no principal.
 */
export function withPrincipal(message, principal) {
  if (principal === undefined) return message
  return Object.freeze({ ...message, source: Object.freeze({ ...message.source, principal: deepFreeze(principal) }) })
}

/** Source kind of the sender notice before each Matrix prompt. */
export const SENDER_NOTICE_KIND = 'matrix-sender'

/**
 * The line that tells the model who wrote a Matrix message and when. A
 * message can reach the agent long after it was sent (a queued message, a
 * backlog after a restart), so the time is the server's own.
 * @param principal - a `matrix-user` principal.
 * @param sentAt - when the message was sent, as text.
 * @returns a one-line label, or undefined with neither a Matrix sender nor a time.
 */
export function senderLabel(principal, sentAt) {
  const time = nonEmpty(sentAt) === undefined ? '' : `, sent ${sentAt.trim()}`
  if (principal?.kind !== 'matrix-user' || principal.id === undefined) {
    return time === '' ? undefined : `[Matrix message${time}]`
  }
  const name = nonEmpty(principal.name)
  return name !== undefined ? `[Matrix message from ${name} (${principal.id})${time}]` : `[Matrix message from ${principal.id}${time}]`
}

/**
 * The notice that comes before a prompt: who sent it, when, and the context
 * the bot adds around it. It is its own message with a producer source, so
 * DSH's title input and readers of human messages see only what the person
 * wrote.
 * @param message - a user message entering a step.
 * @param details - `{ context, sentAt }`: context blocks for this prompt (see
 *   `composePrompt`) and when it was sent, as text; both optional.
 * @returns the notice, or undefined with no sender, time or context.
 */
export function senderNotice(message, { context, sentAt } = {}) {
  if (message?.source?.kind !== 'user') return undefined
  const label = senderLabel(message.source.principal, sentAt)
  const extra = typeof context === 'string' && context.trim().length > 0 ? context : undefined
  if (label === undefined && extra === undefined) return undefined
  const text = [label, extra].filter((part) => part !== undefined).join('\n')
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SENDER_NOTICE_KIND, form: 'notice', summary: label ?? text.split('\n')[0] },
  })
}

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Principals for prompts the bot hands to DSH's session controller, which
 * builds the message itself. The bot remembers the sender by request id
 * before the hand-over; `preStep`, an `agent/pre-step` listener, records it
 * on the message as it enters a step, so it is in the session log with the
 * message (DSH lets that hook replace the messages of a step).
 * @param limit - most principals remembered at once.
 */
export function createPrincipalTagger(limit = MAX_PENDING_PRINCIPALS) {
  const pending = new Map()
  return {
    /**
     * Remember the sender, send time and context of the prompt with this
     * request id (or, for a message the bot builds itself, this message id).
     * @param requestId - the request or message id.
     * @param details - `{ principal, context, sentAt }`, each optional.
     */
    remember(requestId, { principal, context, sentAt } = {}) {
      if (typeof requestId !== 'string' || (principal === undefined && context === undefined && sentAt === undefined)) return
      pending.delete(requestId)
      pending.set(requestId, { principal, context, sentAt })
      if (pending.size > limit) pending.delete(pending.keys().next().value)
    },
    /** Pending prompts, for tests. */
    get size() {
      return pending.size
    },
    /**
     * `agent/pre-step` listener: record remembered senders on the step's
     * messages and put each prompt's notice (sender, time and context) before it.
     */
    async preStep(_payload, next) {
      const decision = await next()
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      let changed = false
      const messages = []
      for (const original of decision.messages) {
        let message = original
        const user = message?.source?.kind === 'user'
        const key = !user ? undefined : (typeof message.source.rpcId === 'string' && pending.has(message.source.rpcId) ? message.source.rpcId : message.id)
        const entry = typeof key === 'string' ? pending.get(key) : undefined
        if (entry !== undefined) pending.delete(key)
        if (entry?.principal !== undefined && message.source.principal === undefined) {
          message = withPrincipal(message, entry.principal)
          changed = true
        }
        const notice = senderNotice(message, entry)
        if (notice !== undefined) {
          messages.push(notice)
          changed = true
        }
        messages.push(message)
      }
      return changed ? { ...decision, messages } : decision
    },
  }
}
