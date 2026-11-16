/**
 * Durable bot state: each person's Space, which DSH session each room is
 * bound to, people who wrote without being allowed, what was sent on behalf
 * of jobs and sessions (so a reply to it can say where it came from), and
 * the bot's working reactions.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dataDir } from './constants.js'

/** Sent-message records kept for replies. */
const SENT_LIMIT = 500
/** Unknown senders remembered for the pending list. */
const PENDING_LIMIT = 50
/** Maps that make up the document. */
const MAPS = ['rooms', 'people', 'pending', 'picks', 'reactions']

/** @returns an empty state document. */
function emptyState() {
  return { version: 1, ...Object.fromEntries(MAPS.map((key) => [key, {}])), sent: [] }
}

/**
 * Read a JSON object, or undefined when the file is missing or broken.
 * @param path - file path.
 */
async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Open the state file.
 * @param path - defaults to `<data dir>/state.json`.
 * @returns the store.
 */
export async function openState(path = join(dataDir(), 'state.json')) {
  const loaded = await readJson(path)
  const state = { ...emptyState(), ...(loaded ?? {}) }
  for (const key of MAPS) {
    if (state[key] === null || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {}
  }
  if (!Array.isArray(state.sent)) state.sent = []
  let writing = Promise.resolve()

  const store = {
    path,
    /** The raw document; mutate through the methods below. */
    get data() {
      return state
    },
    /** Write the document atomically; writes are serialized. */
    save() {
      writing = writing.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
        await rename(temporary, path)
      })
      return writing
    },

    // ------------------------------------------------------------- people

    /** @returns a person's record (`{ spaces, lobbyId }`), or undefined. */
    person(userId) {
      return state.people[userId]
    },
    /** @returns the person whose Space holds this room, or undefined. */
    ownerOfSpace(spaceId) {
      for (const [userId, record] of Object.entries(state.people)) {
        if (record?.spaces?.includes(spaceId)) return userId
      }
      return undefined
    },
    /** Add a Space to a person; the newest is where new rooms go. */
    async addSpace(userId, spaceId, fields = {}) {
      const record = state.people[userId] ?? { spaces: [] }
      record.spaces = [...(record.spaces ?? []).filter((id) => id !== spaceId), spaceId]
      state.people[userId] = { ...record, ...fields }
      await store.save()
    },
    /** Merge fields into a person's record. */
    async describePerson(userId, fields) {
      state.people[userId] = { spaces: [], ...(state.people[userId] ?? {}), ...fields }
      await store.save()
    },

    // -------------------------------------------------------------- rooms

    /** @returns the record of a room, or undefined. */
    room(roomId) {
      return state.rooms[roomId]
    },
    /** @returns the room bound to a session, or undefined. */
    roomOfSession(sessionId) {
      if (typeof sessionId !== 'string') return undefined
      for (const [roomId, record] of Object.entries(state.rooms)) {
        if (record?.sessionId === sessionId) return roomId
      }
      return undefined
    },
    /**
     * Bind a room to a session; a session is shown in one room at a time, so
     * another room bound to it loses the binding.
     */
    async bind(roomId, record) {
      for (const [other, entry] of Object.entries(state.rooms)) {
        if (other !== roomId && entry?.sessionId === record.sessionId) delete entry.sessionId
      }
      state.rooms[roomId] = { ...(state.rooms[roomId] ?? {}), ...record, updatedAt: Date.now() }
      await store.save()
    },
    /**
     * Merge fields into a room's record, saving only when something changed.
     * @returns true when the record changed.
     */
    async describeRoom(roomId, fields) {
      const record = state.rooms[roomId] ?? {}
      if (Object.entries(fields).every(([key, value]) => record[key] === value)) return false
      state.rooms[roomId] = { ...record, ...fields }
      await store.save()
      return true
    },
    /** Forget a room's session (the room keeps its other settings). */
    async release(roomId) {
      const record = state.rooms[roomId]
      if (record === undefined) return undefined
      const previous = record.sessionId
      delete record.sessionId
      await store.save()
      return previous
    },
    /** Forget a room entirely (the bot left it). */
    async forget(roomId) {
      delete state.rooms[roomId]
      await store.save()
    },

    // ------------------------------------------------------------ pending

    /** Remember someone who wrote or invited without being allowed. @returns true the first time. */
    async notePending(entry) {
      const known = state.pending[entry.userId]
      state.pending[entry.userId] = { ...entry, firstSeen: known?.firstSeen ?? Date.now(), lastSeen: Date.now(), count: (known?.count ?? 0) + 1 }
      const keys = Object.keys(state.pending)
      if (keys.length > PENDING_LIMIT) {
        keys.sort((left, right) => state.pending[left].lastSeen - state.pending[right].lastSeen)
        for (const key of keys.slice(0, keys.length - PENDING_LIMIT)) delete state.pending[key]
      }
      await store.save()
      return known === undefined
    },
    /** Drop pending entries that are allowed now. */
    async clearPending(userIds) {
      let changed = false
      for (const userId of userIds) {
        if (state.pending[userId] === undefined) continue
        delete state.pending[userId]
        changed = true
      }
      if (changed) await store.save()
    },

    // --------------------------------------------------------------- sent

    /** Record messages sent on someone's behalf. */
    async noteSent(record) {
      state.sent.push({ ...record, at: Date.now() })
      if (state.sent.length > SENT_LIMIT) state.sent.splice(0, state.sent.length - SENT_LIMIT)
      await store.save()
    },
    /** @returns the send record holding an event id, or undefined. */
    sentRecord(eventId) {
      for (let index = state.sent.length - 1; index >= 0; index -= 1) {
        if (state.sent[index].eventIds?.includes(eventId)) return state.sent[index]
      }
      return undefined
    },

    // ---------------------------------------------------------- reactions

    /** @returns target event id → `{ roomId, reactionId }` of the bot's working reactions. */
    reactions() {
      return { ...state.reactions }
    },
    /** Remember the working reaction the bot put on a message. */
    async noteReaction(eventId, entry) {
      state.reactions[eventId] = entry
      await store.save()
    },
    /** Forget working reactions that were removed. */
    async dropReactions(eventIds) {
      for (const eventId of eventIds) delete state.reactions[eventId]
      await store.save()
    },
  }
  return store
}
