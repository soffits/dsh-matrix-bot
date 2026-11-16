/**
 * Approval requests and agent questions for turns started from Matrix.
 * Matrix has no buttons, so a question lists its options as numbers and the
 * next message answers it; an approval waits for allow or deny. The bot puts
 * the answers on the question as reactions (👍/👎, keycap digits), so in
 * clients that show reactions an answer is one tap.
 */
import { randomUUID } from 'node:crypto'
import { ALLOW_REACTION, COMMAND_PREFIXES, DENY_REACTION, NUMBER_REACTIONS } from './constants.js'

/** @returns the reactions that answer a question, or none when it takes several picks or has too many options. */
export function questionReactions(question) {
  const options = Array.isArray(question?.options) ? question.options : []
  if (question?.multiSelect === true || options.length === 0 || options.length > NUMBER_REACTIONS.length) return []
  return NUMBER_REACTIONS.slice(0, options.length)
}

/**
 * Parse a reply to a question with options.
 * @param text - the reply.
 * @param question - `{ options, multiSelect }`.
 * @returns `{ selected, custom }`: option labels picked by number, or the
 *   whole reply as a free answer.
 */
export function parseAnswer(text, question) {
  const options = Array.isArray(question?.options) ? question.options : []
  const trimmed = String(text ?? '').trim()
  if (options.length > 0 && /^\d+(?:[\s,]+\d+)*$/u.test(trimmed)) {
    const numbers = trimmed.split(/[\s,]+/u).map(Number)
    if (numbers.every((number) => number >= 1 && number <= options.length)) {
      const picked = [...new Set(numbers)].map((number) => options[number - 1].label)
      return { selected: question.multiSelect === true ? picked : picked.slice(0, 1), custom: undefined }
    }
  }
  return { selected: [], custom: trimmed }
}

/**
 * Text of one question.
 * @param question - user question.
 * @param index - its position.
 * @param total - questions in the batch.
 */
export function questionText(question, index, total) {
  const lines = []
  if (question.header) lines.push(question.header)
  lines.push(`❓ ${question.question}`)
  if (question.detail) lines.push('', String(question.detail).slice(0, 3000))
  const options = Array.isArray(question.options) ? question.options : []
  if (options.length > 0) {
    lines.push('')
    for (const [number, option] of options.entries()) {
      lines.push(`${number + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    }
    lines.push('', question.multiSelect === true
      ? 'Reply with one or more numbers (like "1 3"), or write your own answer.'
      : questionReactions(question).length > 0
        ? 'Tap a number below or reply with one, or write your own answer.'
        : 'Reply with a number, or write your own answer.')
  } else {
    lines.push('', 'Reply with your answer.')
  }
  if (total > 1) lines.push(`(Question ${index + 1} of ${total}; !stop cancels.)`)
  return lines.join('\n')
}

/**
 * Create the prompt broker.
 * @param options - `{ roomOfAgent, send, react, warn }`: `roomOfAgent(agent)`
 *   gives the room that should answer for a turn, or undefined to leave it to
 *   DSH; `send(roomId, text)` resolves to the sent event ids; `react(roomId,
 *   eventId, key)` puts a reaction on one.
 * @returns `{ attach, consumeReply, onReaction, settleApproval, cancelRoom, cancelAll, pending }`.
 */
export function createPrompts({ roomOfAgent, send, react, warn }) {
  const attached = new WeakSet()
  /** Pending question batches by room id. */
  const questions = new Map()
  /** Pending approvals by room id (a list, oldest first). */
  const approvals = new Map()

  function finishQuestion(roomId, batch, error) {
    if (questions.get(roomId) !== batch) return
    questions.delete(roomId)
    batch.signal?.removeEventListener('abort', batch.onAbort)
    if (error === undefined) batch.resolve({ answers: batch.answers })
    else batch.reject(error)
  }

  async function askQuestions(roomId, req, next) {
    const list = Array.isArray(req.questions) ? req.questions : []
    if (list.length === 0 || questions.has(roomId)) return next()
    const signal = req.signal
    if (signal?.aborted) return next()
    return new Promise((resolve, reject) => {
      const batch = { id: randomUUID(), questions: list, index: 0, answers: [], resolve, reject, signal, onAbort: undefined }
      batch.onAbort = () => {
        finishQuestion(roomId, batch, signal.reason ?? new Error('question cancelled'))
        void send(roomId, '⏹ Question cancelled.')
      }
      signal?.addEventListener('abort', batch.onAbort, { once: true })
      questions.set(roomId, batch)
      askNext(roomId, batch).catch((error) => {
        warn(`question not sent: ${error?.message ?? error}`)
        finishQuestion(roomId, batch, error)
      })
    })
  }

  /** Send the batch's current question and put its answer reactions on it. */
  async function askNext(roomId, batch) {
    const question = batch.questions[batch.index]
    const [eventId] = await send(roomId, questionText(question, batch.index, batch.questions.length))
    batch.eventId = eventId
    try {
      for (const key of questionReactions(question)) await react(roomId, eventId, key)
    } catch (error) {
      warn(`answer reactions not sent: ${error?.message ?? error}`)
    }
  }

  async function askApproval(roomId, req) {
    if (req.signal?.aborted) return 'cancelled'
    const reason = req.displayReason?.en ?? req.reason ?? 'The tool asked for approval.'
    return new Promise((resolve) => {
      const entry = { resolve, toolName: req.toolName, signal: req.signal, onAbort: undefined, eventId: undefined }
      entry.onAbort = () => settle(roomId, entry, 'cancelled')
      req.signal?.addEventListener('abort', entry.onAbort, { once: true })
      const list = approvals.get(roomId) ?? []
      list.push(entry)
      approvals.set(roomId, list)
      const text = `🔐 Approval needed for ${req.toolName}:\n${reason}\n\nTap ${ALLOW_REACTION} to allow or ${DENY_REACTION} to deny, or send !allow or !deny.`
      Promise.resolve(send(roomId, text)).then(async ([eventId]) => {
        entry.eventId = eventId
        try {
          await react(roomId, eventId, ALLOW_REACTION)
          await react(roomId, eventId, DENY_REACTION)
        } catch (error) {
          warn(`approval reactions not sent: ${error?.message ?? error}`)
        }
      }, () => settle(roomId, entry, 'unavailable'))
    })
  }

  /** Record an answer and ask the next question, or finish the batch. */
  function answer(roomId, batch, { selected, custom }) {
    const question = batch.questions[batch.index]
    batch.answers.push({ id: question.id, selected, ...(custom ? { custom } : {}) })
    batch.index += 1
    batch.eventId = undefined
    if (batch.index < batch.questions.length) {
      askNext(roomId, batch).catch((error) => {
        warn(`question not sent: ${error?.message ?? error}`)
        finishQuestion(roomId, batch, error)
      })
    } else {
      finishQuestion(roomId, batch)
    }
  }

  function settle(roomId, entry, outcome) {
    const list = approvals.get(roomId) ?? []
    const index = list.indexOf(entry)
    if (index === -1) return false
    list.splice(index, 1)
    if (list.length === 0) approvals.delete(roomId)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    entry.resolve(outcome)
    return true
  }

  return {
    /** Answer approval and question requests of an agent while its turn belongs to a room. */
    attach(agent) {
      if (attached.has(agent) || typeof agent?.ctx?.on !== 'function') return
      attached.add(agent)
      agent.ctx.on('approval/request', (req, next) => {
        const roomId = roomOfAgent(agent)
        if (roomId === undefined) return next()
        return askApproval(roomId, req)
      }, { prepend: true })
      agent.ctx.on('user-questions/request', (req, next) => {
        const roomId = roomOfAgent(agent)
        if (roomId === undefined) return next()
        return askQuestions(roomId, req, next)
      }, { prepend: true })
    },
    /**
     * Take a message as the answer to the room's open question.
     * @returns true when the message answered a question.
     */
    consumeReply(roomId, text) {
      const batch = questions.get(roomId)
      if (batch === undefined || text.length === 0 || COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix))) return false
      answer(roomId, batch, parseAnswer(text, batch.questions[batch.index]))
      return true
    },
    /**
     * Take a reaction to a question or approval as its answer.
     * @param roomId - room id.
     * @param eventId - the event reacted to.
     * @param key - the reaction.
     * @returns true when the reaction answered something.
     */
    onReaction(roomId, eventId, key) {
      const entry = approvals.get(roomId)?.find((item) => item.eventId === eventId)
      if (entry !== undefined && (key === ALLOW_REACTION || key === DENY_REACTION)) {
        settle(roomId, entry, key === ALLOW_REACTION ? 'allowed-once' : 'rejected')
        void send(roomId, key === ALLOW_REACTION ? `✅ Allowed ${entry.toolName}.` : `❌ Denied ${entry.toolName}.`)
        return true
      }
      const batch = questions.get(roomId)
      if (batch === undefined || batch.eventId !== eventId) return false
      const question = batch.questions[batch.index]
      const index = questionReactions(question).indexOf(key)
      if (index === -1) return false
      answer(roomId, batch, { selected: [question.options[index].label], custom: undefined })
      return true
    },
    /**
     * Resolve the oldest approval of a room.
     * @returns the tool name, or undefined when none was waiting.
     */
    settleApproval(roomId, allowed) {
      const entry = approvals.get(roomId)?.[0]
      if (entry === undefined) return undefined
      settle(roomId, entry, allowed ? 'allowed-once' : 'rejected')
      return entry.toolName
    },
    /** Cancel what a room was asked (on stop). */
    cancelRoom(roomId) {
      const batch = questions.get(roomId)
      if (batch !== undefined) finishQuestion(roomId, batch, new Error('Question cancelled by stop'))
      for (const entry of [...(approvals.get(roomId) ?? [])]) settle(roomId, entry, 'cancelled')
    },
    cancelAll() {
      for (const roomId of [...questions.keys(), ...approvals.keys()]) this.cancelRoom(roomId)
    },
    /** @returns what a room is being asked: `{ question, approvals }`. */
    pending(roomId) {
      return { question: questions.has(roomId), approvals: approvals.get(roomId)?.length ?? 0 }
    },
  }
}
