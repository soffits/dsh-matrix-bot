/**
 * Each allowed person's private Space and the rooms in it: making a Space
 * and its lobby, adopting a Space the person made, joining rooms that appear
 * in it, making new rooms, and publishing the command list in each room.
 */
import { MSC4332_COMMANDS, MSC4391_DESCRIPTION } from './constants.js'

/** Encryption of every room the bot makes. */
const ENCRYPTION = { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }
/** Power level that may add rooms to a Space when its power levels don't say. */
const DEFAULT_STATE_LEVEL = 50

/** @returns the server part of a user or room id. */
export function serverOf(id) {
  return String(id).slice(String(id).indexOf(':') + 1)
}

/**
 * The power level a Space needs from the bot to add rooms to it, and the
 * bot's own level there.
 * @param powerLevels - the Space's `m.room.power_levels` content.
 * @param userId - the bot.
 * @returns `{ needed, own }`.
 */
export function childLevels(powerLevels, userId) {
  const levels = powerLevels ?? {}
  const needed = levels.events?.['m.space.child'] ?? levels.state_default ?? DEFAULT_STATE_LEVEL
  const own = levels.users?.[userId] ?? levels.users_default ?? 0
  return { needed, own }
}

/**
 * The command list in the two proposal formats.
 * @param commands - `[name, description, usage?]` entries.
 * @param sigil - prefix clients should put before the command.
 * @returns `{ msc4332, msc4391 }`: the MSC4332 content and the MSC4391 contents by command.
 */
export function commandStates(commands, sigil) {
  const text = (body) => ({ 'm.text': [{ body }] })
  const msc4332 = {
    sigil,
    commands: commands.map(([command, description, usage]) => ({
      syntax: usage ? `${command} {args}` : command,
      ...(usage ? { arguments: [{ type: 'string', description: text(usage), variadic: true }] } : {}),
      description: text(description),
    })),
  }
  const msc4391 = Object.fromEntries(commands.map(([command, description, usage]) => [command, {
    command,
    description: text(description),
    parameters: usage ? [{ key: 'args', schema: { schema_type: 'primitive', type: 'string' }, description: text(usage), optional: true }] : [],
  }]))
  return { msc4332, msc4391 }
}

/**
 * Create the Space manager.
 * @param deps - `{ requireMatrix, getStore, setting, notice, publishCommands, info, warn }`.
 */
export function createSpaces({ requireMatrix, getStore, setting, notice, commands, sigil, helpText, info, warn }) {
  /** @returns the name of new Spaces and lobbies. */
  async function names() {
    const matrix = requireMatrix()
    const display = String(setting('displayName', '')).trim() || await matrix.displayName()
    return { space: String(setting('spaceName', '')).trim() || display, lobby: display }
  }

  /** @returns power levels where the bot and the person are both admins. */
  function sharedPower(userId) {
    return { users: { [requireMatrix().userId]: 100, [userId]: 100 } }
  }

  /**
   * Publish the command list in a room for clients that offer autocomplete.
   * Rooms where the bot may not set state are left without it.
   */
  async function publishCommands(roomId) {
    const matrix = requireMatrix()
    const { msc4332, msc4391 } = commandStates(commands, sigil)
    try {
      await matrix.sendState(roomId, MSC4332_COMMANDS, matrix.userId, msc4332)
      for (const [command, content] of Object.entries(msc4391)) await matrix.sendState(roomId, MSC4391_DESCRIPTION, command, content)
    } catch (error) {
      warn(`command list not published in ${roomId}: ${error?.message ?? error}`)
    }
  }

  /** Link a room into a Space (both directions where the bot may). */
  async function linkRoom(spaceId, roomId) {
    const matrix = requireMatrix()
    const via = [serverOf(matrix.userId)]
    await matrix.sendState(spaceId, 'm.space.child', roomId, { via, suggested: true })
    await matrix.sendState(roomId, 'm.space.parent', spaceId, { via, canonical: true }).catch(() => {})
  }

  /**
   * Make a room for a person in their Space and invite them.
   * @param userId - the person.
   * @param name - room name.
   * @returns the room id.
   */
  async function createRoom(userId, name) {
    const matrix = requireMatrix()
    const spaceId = await ensureSpace(userId)
    const roomId = await matrix.createRoom({
      name,
      preset: 'private_chat',
      visibility: 'private',
      invite: [userId],
      initial_state: [ENCRYPTION, { type: 'm.space.parent', state_key: spaceId, content: { via: [serverOf(matrix.userId)], canonical: true } }],
      power_level_content_override: sharedPower(userId),
    })
    await matrix.sendState(spaceId, 'm.space.child', roomId, { via: [serverOf(matrix.userId)], suggested: true })
    await getStore().describeRoom(roomId, { owner: userId, spaceId })
    await publishCommands(roomId)
    info(`made room ${roomId} in ${userId}'s Space`)
    return roomId
  }

  /**
   * The person's Space, made with its lobby when they have none.
   * @param userId - the person.
   * @param options - `{ lobbyId }`: a room that becomes the lobby instead of a new one.
   * @returns the Space id.
   */
  async function ensureSpace(userId, { lobbyId } = {}) {
    const store = getStore()
    const known = store.person(userId)?.spaces?.at(-1)
    if (known !== undefined) return known
    const matrix = requireMatrix()
    const { space, lobby } = await names()
    const spaceId = await matrix.createRoom({
      name: space,
      preset: 'private_chat',
      visibility: 'private',
      invite: [userId],
      creation_content: { type: 'm.space' },
      power_level_content_override: { ...sharedPower(userId), events_default: 100 },
    })
    await store.addSpace(userId, spaceId)
    info(`made a Space for ${userId}`)
    if (lobbyId !== undefined) {
      await linkRoom(spaceId, lobbyId)
      await store.describeRoom(lobbyId, { owner: userId, spaceId })
      await store.describePerson(userId, { lobbyId })
      await greet(lobbyId)
    } else {
      const roomId = await createRoom(userId, lobby)
      await store.describePerson(userId, { lobbyId: roomId })
      await greet(roomId)
    }
    return spaceId
  }

  /** Welcome a person in their lobby and pin the help there. */
  async function greet(roomId) {
    const [eventId] = await notice(roomId, helpText())
    try {
      await requireMatrix().sendState(roomId, 'm.room.pinned_events', '', { pinned: [eventId] })
    } catch (error) {
      warn(`help not pinned in ${roomId}: ${error?.message ?? error}`)
    }
  }

  /**
   * Take a Space a person made and invited the bot to as theirs, when the bot
   * may add rooms to it.
   * @returns true when adopted.
   */
  async function adoptSpace(userId, spaceId) {
    const matrix = requireMatrix()
    const store = getStore()
    const { needed, own } = childLevels(await matrix.getState(spaceId, 'm.room.power_levels'), matrix.userId)
    if (own < needed) {
      const lobbyId = store.person(userId)?.lobbyId
      const text = `I joined your Space, but I can only add rooms to it with power level ${needed} (I have ${own}). Please give me power level ${needed} there.`
      if (lobbyId !== undefined) await notice(lobbyId, text)
      else await notice(spaceId, text)
      await store.describePerson(userId, { waitingSpace: spaceId })
      return false
    }
    await store.addSpace(userId, spaceId)
    info(`adopted ${userId}'s Space ${spaceId}`)
    for (const event of await matrix.roomState(spaceId)) {
      if (event?.type === 'm.space.child') await onChild(spaceId, event)
    }
    if (store.person(userId)?.lobbyId === undefined) {
      const roomId = await createRoom(userId, (await names()).lobby)
      await store.describePerson(userId, { lobbyId: roomId })
      await greet(roomId)
    }
    return true
  }

  /**
   * A room was added to or removed from a person's Space: join a new one and
   * make it theirs.
   * @param spaceId - the Space.
   * @param event - the `m.space.child` state event.
   */
  async function onChild(spaceId, event) {
    const store = getStore()
    const owner = store.ownerOfSpace(spaceId)
    const roomId = event.state_key
    if (owner === undefined || typeof roomId !== 'string' || roomId.length === 0) return
    const via = Array.isArray(event.content?.via) ? event.content.via : []
    if (via.length === 0 || store.room(roomId)?.owner !== undefined) return
    try {
      await requireMatrix().join(roomId, via)
    } catch (error) {
      const lobbyId = store.person(owner)?.lobbyId
      warn(`could not join ${roomId} from ${owner}'s Space: ${error?.message ?? error}`)
      if (lobbyId !== undefined && lobbyId !== roomId) await notice(lobbyId, 'A new room in your Space is invite-only, so I could not join it. Invite me there and it gets its own session.')
      return
    }
    await store.describeRoom(roomId, { owner, spaceId })
    await publishCommands(roomId)
  }

  /**
   * A room an allowed person invited the bot to: a Space is adopted, any
   * other room becomes theirs and goes into their Space.
   * @param roomId - the joined room.
   * @param userId - who invited the bot.
   */
  async function onJoinedByInvite(roomId, userId) {
    const matrix = requireMatrix()
    const store = getStore()
    const create = await matrix.getState(roomId, 'm.room.create')
    if (create?.type === 'm.space') {
      await adoptSpace(userId, roomId)
      return
    }
    if (store.room(roomId)?.owner !== undefined) return
    const firstContact = store.person(userId)?.spaces === undefined || store.person(userId).spaces.length === 0
    if (firstContact) {
      await ensureSpace(userId, { lobbyId: roomId })
    } else {
      const spaceId = await ensureSpace(userId)
      await linkRoom(spaceId, roomId).catch((error) => warn(`room ${roomId} not added to the Space: ${error?.message ?? error}`))
      await store.describeRoom(roomId, { owner: userId, spaceId })
    }
    await publishCommands(roomId)
  }

  return { ensureSpace, createRoom, adoptSpace, onChild, onJoinedByInvite, publishCommands }
}
