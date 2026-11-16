/**
 * Session titles of room sessions: `Matrix-<person>-<task>`. `person` is
 * who the room is with (their name), `task` the conversation
 * title DSH generates, or the room's name until there is one. DSH has no title
 * hook, so a generated title is appended again with the prefix and the same
 * source, which keeps automatic titling going.
 */

/** Title source marker shared with the other chat bridges' formats. */
export const TITLE_SOURCE = 'Matrix'

/** Words taken from the first message when DSH's fallback title is the sender line. */
const FALLBACK_WORDS = 8

/** @returns one line of text, without the separator dashes doubling up. */
function clean(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * The full title.
 * @param person - who the room is with.
 * @param task - conversation title.
 */
export function roomTitle(person, task) {
  return `${TITLE_SOURCE}-${clean(person) || 'unknown'}-${clean(task)}`
}

/**
 * The conversation part of a title, without a `Matrix-<person>-` prefix.
 * @param title - current title.
 * @param persons - names the prefix may carry (the current one and earlier ones).
 */
export function taskOf(title, persons) {
  const value = clean(title)
  for (const person of persons) {
    if (person === undefined || person === null) continue
    const prefix = `${TITLE_SOURCE}-${clean(person) || 'unknown'}-`
    if (value.startsWith(prefix)) return value.slice(prefix.length)
  }
  return value
}

/**
 * A conversation title from the first message of a session, used when DSH's
 * fallback title is the bot's sender line.
 * @param events - session events.
 * @returns a few words of the first message's own text, or ''.
 */
export function firstMessageTask(events) {
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    const text = (event.data.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    const body = text.split('\n').filter((line) => !/^\[[^\]]*\]$/u.test(line.trim())).join(' ')
    const words = clean(body).split(' ').filter(Boolean)
    if (words.length > 0) return words.slice(0, FALLBACK_WORDS).join(' ')
  }
  return ''
}

/**
 * Keep a bound session's title in the room format.
 * @param options - `{ service, session, person, earlier, placeholder, previous, warn }`:
 *   the title service, the live session, who the room is with, names an older
 *   title may carry instead, the task shown before a conversation title
 *   exists, and the placeholder title the bot set earlier (so a renamed room
 *   moves it).
 * @returns the placeholder title now set by the bot, or `previous`.
 */
export function syncTitle({ service, session, person, earlier = [], placeholder, previous, warn }) {
  if (service === undefined || session === undefined) return previous
  let current
  try {
    current = service.get(session)
  } catch (error) {
    warn?.(`title not read for ${session.id}: ${error?.message ?? error}`)
    return previous
  }
  const placeholderTitle = roomTitle(person, placeholder)
  // A title someone typed stays; only the bot's own placeholder follows the room.
  if (current === undefined || (current.source?.kind === 'user' && current.title === previous && previous !== placeholderTitle)) {
    service.rename(session, placeholderTitle)
    return placeholderTitle
  }
  if (current.source?.kind === 'user') return previous
  let task = taskOf(current.title, [person, ...earlier])
  if (current.source?.kind === 'fallback' && /^\[Matrix message from/u.test(task)) {
    task = firstMessageTask(typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []) || placeholder
  }
  const wanted = roomTitle(person, task)
  if (wanted !== current.title) {
    session.append('session/title', {
      title: wanted,
      messageSeqs: Array.isArray(current.messageSeqs) ? [...current.messageSeqs] : [],
      source: current.source,
    })
  }
  return previous
}

/**
 * Whether a session still shows the bot's placeholder, so its first
 * conversation title should be generated.
 * @param service - title service.
 * @param session - live session.
 * @param previous - the placeholder title the bot set.
 */
export function showsPlaceholder(service, session, previous) {
  try {
    const current = service.get(session)
    return current?.source?.kind === 'user' && current.title === previous
  } catch {
    return false
  }
}

/**
 * Titles of the sessions bound to rooms.
 * @param deps - `{ ctx, getStore, warn }`.
 * @returns `{ apply, start }`.
 */
export function createTitles({ ctx, getStore, warn }) {
  /** Sessions whose first conversation title is being generated. */
  const requests = new Set()

  /** Bring a bound session's title to `Matrix-<person>-<task>`. */
  async function apply(sessionId) {
    const store = getStore()
    const roomId = store?.roomOfSession(sessionId)
    const record = roomId === undefined ? undefined : store.room(roomId)
    const session = ctx.get('agents')?.get(sessionId)?.session
    if (record === undefined || session === undefined) return
    try {
      const person = record.person ?? record.roomName ?? roomId
      const placeholder = record.roomName || 'Matrix room'
      const placeholderTitle = syncTitle({
        service: ctx.get('sessionTitle'),
        session,
        person,
        earlier: record.titlePersons ?? [],
        placeholder,
        previous: record.placeholderTitle,
        warn,
      })
      const titlePersons = [person, ...(record.titlePersons ?? []).filter((name) => name !== person)].slice(0, 5)
      await store.describeRoom(roomId, { placeholderTitle, titlePersons })
    } catch (error) {
      warn(`title of ${sessionId} not set: ${error?.message ?? error}`)
    }
  }

  /**
   * Ask DSH for a session's first conversation title once it has a prompt
   * and a model route, while it still shows the bot's placeholder: the
   * placeholder is a user title, which stops automatic titling.
   */
  function start(sessionId) {
    const store = getStore()
    const roomId = store?.roomOfSession(sessionId)
    const service = ctx.get('sessionTitle')
    const session = ctx.get('agents')?.get(sessionId)?.session
    if (roomId === undefined || session === undefined || typeof service?.refresh !== 'function' || requests.has(sessionId)) return
    if (!showsPlaceholder(service, session, store.room(roomId)?.placeholderTitle)) return
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    if (!events.some((event) => event?.type === 'user/message' && event.data?.source?.kind === 'user')) return
    requests.add(sessionId)
    Promise.resolve()
      .then(() => service.refresh(session))
      .catch((error) => warn(`title of ${sessionId} not generated: ${error?.message ?? error}`))
      .finally(() => requests.delete(sessionId))
  }

  return { apply, start }
}
