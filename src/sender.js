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
 * When the message was sent and what it replies to go on `source.envelope`,
 * the metadata dsh-message-context renders for the model. The bot never adds
 * them to the text: DSH titles a session from the first words of its first
 * human message, and those must be the person's own.
 */

/** Remembered prompts waiting for their step; the oldest go first past this. */
export const MAX_PENDING_PRINCIPALS = 1024

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

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

/**
 * A frozen copy of a message whose source records its sender and envelope.
 * Fields the message already has are kept.
 * @param message - the user message.
 * @param metadata - `{ principal, envelope }`, each optional.
 * @returns the copy; the message itself when there is nothing to add.
 */
export function withMetadata(message, { principal, envelope } = {}) {
  const addPrincipal = principal !== undefined && message.source.principal === undefined
  const addEnvelope = envelope !== undefined && message.source.envelope === undefined
  if (!addPrincipal && !addEnvelope) return message
  return Object.freeze({
    ...message,
    source: Object.freeze({
      ...message.source,
      ...(addPrincipal ? { principal: deepFreeze(principal) } : {}),
      ...(addEnvelope ? { envelope: deepFreeze(envelope) } : {}),
    }),
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
 * and the envelope on the message as it enters a step, so they are in the
 * session log with the message (DSH lets that hook replace the messages of a
 * step). It is registered without `prepend`, so a prepended renderer sees them.
 * @param limit - most principals remembered at once.
 */
export function createPrincipalTagger(limit = MAX_PENDING_PRINCIPALS) {
  const pending = new Map()
  return {
    /**
     * Remember the sender and envelope of the prompt with this request id
     * (or, for a message the bot builds itself, this message id).
     * @param requestId - the request or message id.
     * @param metadata - `{ principal, envelope }`, each optional.
     */
    remember(requestId, { principal, envelope } = {}) {
      if (typeof requestId !== 'string' || (principal === undefined && envelope === undefined)) return
      pending.delete(requestId)
      pending.set(requestId, { principal, envelope })
      if (pending.size > limit) pending.delete(pending.keys().next().value)
    },
    /** Pending prompts, for tests. */
    get size() {
      return pending.size
    },
    /**
     * `agent/pre-step` listener: record remembered senders and envelopes on
     * the step's messages.
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
        if (entry !== undefined) {
          const tagged = withMetadata(message, entry)
          if (tagged !== message) changed = true
          message = tagged
        }
        messages.push(message)
      }
      return changed ? { ...decision, messages } : decision
    },
  }
}
