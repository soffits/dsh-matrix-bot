/**
 * Turn delivery: follow every session bound to a room, show the answer while
 * it is written (one message edited in place), send the final answer when
 * the turn ends, keep a typing notice up while it runs, then clear the
 * working reactions of its messages.
 */
import { basename } from 'node:path'
import { cutSilent, messageAnswer } from '@soffits/dsh-channel-core'
import { REQUEST_PREFIX, STREAM_EDIT_MS, TYPING_MS } from './constants.js'
import { clip, localImagePaths, splitText } from './text.js'

/**
 * The event id a request id of a Matrix prompt names.
 * @param rpcId - `matrix:<room id>:<event id>`.
 * @returns the event id, or undefined for other request ids.
 */
export function eventOfRequest(rpcId) {
  if (typeof rpcId !== 'string' || !rpcId.startsWith(REQUEST_PREFIX)) return undefined
  const start = rpcId.indexOf(':$')
  return start === -1 ? undefined : rpcId.slice(start + 1)
}

/**
 * Create the turn tracker.
 * @param deps - `{ ctx, getStore, isRunning, setting, outbound, reactions, roomState, publishStatus, fireAndForget, messageOf, setTyping }`.
 * @returns `{ onSessionEvent, onStream, currentTurn, dispose }`.
 */
export function createTurns({ ctx, getStore, isRunning, setting, outbound, reactions, roomState, publishStatus, fireAndForget, messageOf, setTyping }) {
  const { queueOut, notice, sendText, editText, sendFiles, checkFiles, redact } = outbound
  /**
   * Turns of bound sessions by session id: `{ current, turns: Map<turn, record>,
   * pendingOurs, pendingIds, lastOurs }`; `pendingIds` are Matrix messages
   * taken before their turn started, `lastOurs` whether the last turn that
   * ended was started from Matrix.
   */
  const sessionTurns = new Map()

  /** @returns the turn bookkeeping of a session. */
  function turnsOf(sessionId) {
    let entry = sessionTurns.get(sessionId)
    if (entry === undefined) {
      entry = { current: undefined, turns: new Map(), pendingOurs: undefined, pendingIds: [], lastOurs: false }
      sessionTurns.set(sessionId, entry)
    }
    return entry
  }

  /** @returns the key that ties a turn's messages to it. */
  function turnKey(sessionId, turn) {
    return `${sessionId}\u0000${turn}`
  }

  /** @returns the record of a session's running turn, or undefined. */
  function currentTurn(sessionId) {
    const entry = sessionTurns.get(sessionId)
    return entry?.current === undefined ? undefined : entry.turns.get(entry.current)
  }

  /** @returns whether a turn's output goes to its room. */
  function delivered(turn) {
    return turn !== undefined && (turn.ours || turn.goal || turn.mirrored)
  }

  // ------------------------------------------------------------- typing

  function startTyping(roomId, turn) {
    if (turn.typing !== undefined) return
    const renew = () => { void setTyping(roomId, true, TYPING_MS).catch(() => {}) }
    renew()
    turn.typing = setInterval(renew, TYPING_MS - 5_000)
    turn.typing.unref?.()
  }

  function stopTyping(roomId, turn) {
    if (turn.typing === undefined) return
    clearInterval(turn.typing)
    turn.typing = undefined
    void setTyping(roomId, false, 0).catch(() => {})
  }

  // ---------------------------------------------------------- streaming

  /**
   * Take one frame of an assistant stream: the text of the block being
   * written is shown in the turn's live message.
   * @param sessionId - the streaming session.
   * @param frame - stream frame.
   */
  function onStream(sessionId, frame) {
    const store = getStore()
    const roomId = store?.roomOfSession(sessionId)
    const turn = currentTurn(sessionId)
    if (roomId === undefined || turn === undefined || !delivered(turn) || setting('streaming', true) !== true) return
    const chunk = frame?.type === 'chunk' ? frame.chunk : undefined
    if (chunk?.type === 'block-start' && chunk.blockType === 'text') {
      turn.stream.text = ''
      return
    }
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
    turn.stream.text += chunk.text
    scheduleFlush(roomId, turn)
  }

  function scheduleFlush(roomId, turn) {
    const stream = turn.stream
    if (stream.timer !== undefined || stream.closed) return
    const wait = Math.max(0, stream.lastFlush + STREAM_EDIT_MS - Date.now())
    stream.timer = setTimeout(() => {
      stream.timer = undefined
      void queueOut(roomId, () => flush(roomId, turn))
    }, wait)
    stream.timer.unref?.()
  }

  /** Show the streamed text: the first time as a message, then as edits of it. */
  async function flush(roomId, turn) {
    const stream = turn.stream
    if (stream.closed) return
    const { text } = cutSilent(stream.text, { streaming: true })
    if (text.length === 0 || text === stream.shown) return
    const [visible] = splitText(text)
    stream.lastFlush = Date.now()
    if (stream.eventId === undefined) {
      const [eventId] = await sendText(roomId, visible, { replyTo: replyTarget(roomId, turn) })
      stream.eventId = eventId
    } else {
      await editText(roomId, stream.eventId, visible)
    }
    stream.shown = text
  }

  // ------------------------------------------------------------- events

  /**
   * Follow every session bound to a room: collect each turn's answer and send
   * it when the turn ends. Turns started from Matrix are always delivered;
   * turns started elsewhere (Web UI, schedules) when `mirrorTurns` is on.
   */
  function onSessionEvent(session, event) {
    const store = getStore()
    if (store === undefined || !isRunning()) return
    const sessionId = session?.id
    const roomId = store.roomOfSession(sessionId)
    if (roomId === undefined) return
    const entry = turnsOf(sessionId)
    const mirror = setting('mirrorTurns', true) === true
    if (event.type === 'turn/start') {
      const record = {
        texts: [],
        sentTexts: [],
        ours: entry.pendingOurs !== undefined,
        lastPrompt: entry.pendingOurs,
        goal: false,
        mirrored: mirror,
        sent: false,
        stopped: false,
        typing: undefined,
        stream: { text: '', shown: '', eventId: undefined, timer: undefined, lastFlush: 0, closed: false },
      }
      entry.pendingOurs = undefined
      entry.current = event.data?.turn
      entry.turns.set(event.data?.turn, record)
      for (const eventId of entry.pendingIds) reactions.attach(eventId, turnKey(sessionId, event.data?.turn))
      entry.pendingIds = []
      if (delivered(record)) startTyping(roomId, record)
      return
    }
    const record = entry.current === undefined ? undefined : entry.turns.get(entry.current)
    if (event.type === 'user/message') {
      const source = event.data?.source
      const rpcId = typeof source?.rpcId === 'string' ? source.rpcId : ''
      const eventId = source?.kind === 'user' ? eventOfRequest(rpcId) : undefined
      if (eventId !== undefined) {
        if (record === undefined) {
          entry.pendingOurs = eventId
          entry.pendingIds.push(eventId)
        } else {
          record.ours = true
          record.lastPrompt = eventId
          reactions.attach(eventId, turnKey(sessionId, entry.current))
          startTyping(roomId, record)
        }
        return
      }
      if (rpcId.startsWith('matrix-claim:')) return
      // A helper's report wakes its parent: that turn answers the room the delegating turn came from.
      if ((source?.kind === 'subagent-settled' || source?.kind === 'agent-message') && record !== undefined) {
        if (entry.lastOurs) {
          record.ours = true
          startTyping(roomId, record)
        }
        return
      }
      if (source?.kind === 'goal' && record !== undefined) record.goal = true
      if (!mirror) return
      const label = source?.kind === 'schedule' ? '⏰ Scheduled task' : source?.kind !== 'user' ? undefined : rpcId.startsWith('telegram') ? '✈️ From Telegram' : '🖥 From Web'
      if (label === undefined) return
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
      const files = content.filter((block) => block?.type === 'image' || block?.type === 'file').length
      if (text.length === 0 && files === 0) return
      notice(roomId, `${label}:\n${clip(text, 3000)}${files === 0 ? '' : `\n📎 ${files}`}`)
      return
    }
    if (event.type === 'assistant/message') {
      const turn = entry.turns.get(event.data?.turn) ?? record
      const answer = messageAnswer(event.data?.message ?? event.data)
      if (turn !== undefined && answer.length > 0) turn.texts.push(answer)
      return
    }
    if (event.type === 'deliverables/presented') {
      const turn = entry.turns.get(event.data?.turn) ?? record
      if (turn !== undefined && !delivered(turn)) return
      const paths = (Array.isArray(event.data?.files) ? event.data.files : []).map((file) => file?.path).filter((path) => typeof path === 'string')
      if (paths.length === 0) return
      if (turn !== undefined) turn.sent = true
      void queueOut(roomId, () => forwardFiles(roomId, paths))
      return
    }
    if (event.type === 'goal/change') {
      fireAndForget('goal-change', () => announceGoal(roomId, sessionId))
      return
    }
    if (event.type === 'turn/end') {
      const turn = event.data?.turn
      const finished = entry.turns.get(turn)
      if (finished !== undefined) {
        entry.lastOurs = finished.ours
        stopTyping(roomId, finished)
        if (finished.stream.timer !== undefined) clearTimeout(finished.stream.timer)
        finished.stream.timer = undefined
        finished.stream.closed = true
      }
      entry.turns.delete(turn)
      if (entry.current === turn) entry.current = undefined
      // The reactions go once the answer is out, also when the turn failed or was stopped.
      void queueOut(roomId, async () => {
        try {
          if (finished !== undefined) await deliverTurn(roomId, finished, event.data?.reason)
        } finally {
          await reactions.finishTurn(roomId, turnKey(sessionId, turn))
        }
      })
    }
  }

  /** Send files a session showed its user, with a note for those that cannot go. */
  async function forwardFiles(roomId, paths, quiet = false) {
    const failed = []
    for (const path of paths) {
      try {
        await sendFiles(roomId, await checkFiles([path]))
      } catch (error) {
        if (!quiet) failed.push(`${basename(path)}: ${messageOf(error)}`)
      }
    }
    if (failed.length > 0) await sendText(roomId, `⚠️ Could not send:\n${failed.join('\n')}`, { plain: true, notice: true })
  }

  /** @returns the prompt to reply to, when the room moved on since it was sent. */
  function replyTarget(roomId, turn) {
    const room = roomState(roomId)
    return turn.ours && typeof turn.lastPrompt === 'string' && room.lastInbound !== turn.lastPrompt ? turn.lastPrompt : undefined
  }

  /** Send a finished turn's answer into its room, finishing its live message. */
  async function deliverTurn(roomId, turn, reason) {
    const live = turn.stream.eventId
    const dropLive = () => (live === undefined ? undefined : redact(roomId, live).catch(() => {}))
    if (!delivered(turn)) return
    if (turn.stopped || reason?.kind === 'aborted' || reason?.kind === 'blocked') {
      await dropLive()
      return
    }
    // Text the session already sent here with its files is not repeated.
    const sent = new Set(turn.sentTexts.map(sameText))
    const { text, silent } = cutSilent(turn.texts.filter((part) => !sent.has(sameText(part))).join('\n\n'))
    if (reason?.kind === 'error' && text.length === 0) {
      await dropLive()
      await sendText(roomId, `❌ ${reason.error?.message ?? 'The turn failed.'}`, { plain: true, notice: true })
      return
    }
    if (text.length > 0) {
      const [first, ...rest] = splitText(text)
      if (live === undefined) await sendText(roomId, text, { replyTo: replyTarget(roomId, turn) })
      else {
        if (first !== turn.stream.shown) await editText(roomId, live, first)
        for (const part of rest) await sendText(roomId, part)
      }
      const images = localImagePaths(text)
      if (images.length > 0) await forwardFiles(roomId, images, true)
      await publishStatus({ lastReplyAt: Date.now() })
      return
    }
    await dropLive()
    if (turn.ours && !silent && !turn.sent && reason?.kind !== 'error') await sendText(roomId, '✅ Done.', { plain: true, notice: true })
  }

  /** @returns text reduced to its words, for comparing an answer with a send. */
  function sameText(text) {
    return String(text).replace(/\s+/gu, ' ').trim()
  }

  /** Tell the room when its session's goal changes phase. */
  async function announceGoal(roomId, sessionId) {
    const goals = ctx.get('goals')
    const agent = ctx.get('agents')?.get(sessionId)
    if (goals === undefined || agent === undefined) return
    const view = goals.get(agent)
    const room = roomState(roomId)
    const phase = view === undefined ? 'none' : view.phase
    if (room.goalPhase === phase) return
    const previous = room.goalPhase
    room.goalPhase = phase
    if (previous === undefined) return
    if (phase === 'complete') await notice(roomId, `🎯 Goal complete: ${clip(view.objective, 300)}`)
    else if (phase === 'blocked') await notice(roomId, `🎯 Goal blocked: ${clip(view.objective, 300)}`)
    else if (phase === 'paused') await notice(roomId, '🎯 Goal paused. !goal resume continues it.')
  }

  /** Stop timers. */
  function dispose() {
    for (const entry of sessionTurns.values()) {
      for (const turn of entry.turns.values()) {
        if (turn.typing !== undefined) clearInterval(turn.typing)
        if (turn.stream.timer !== undefined) clearTimeout(turn.stream.timer)
      }
    }
  }

  return { onSessionEvent, onStream, currentTurn, dispose }
}
