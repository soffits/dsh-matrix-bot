/** Shared constants and on-disk locations. */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Loader row id and settings namespace; the npm package is @soffits/dsh-matrix-bot. */
export const name = 'matrix-bot'

/** Name of the Host service other plugins send through. */
export const SERVICE_NAME = 'matrixRooms'

/**
 * Directory holding everything the bot keeps: the login, the crypto store,
 * the sync token, the room → session map, the spool and diagnostics. Read at
 * call time, so tests and throwaway homes can move it with DSH_HOME.
 * @returns absolute path.
 */
export function dataDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'matrix')
}

/** @returns the request spool used by the `dsh-matrix` command. */
export function spoolDir() {
  return join(dataDir(), 'spool')
}

/**
 * Longest text sent as one Matrix message. Events are limited to 64 KiB
 * after encryption, and the HTML copy of the text travels in the same event.
 */
export const MAX_MESSAGE_TEXT = 12_000

/** Reaction that tells the sender a message is being worked on. */
export const WORKING_REACTION = '⏳'

/** Reaction that tells the sender a message reached the running turn. */
export const STEER_REACTION = '👀'

/** Reactions that answer an approval request. */
export const ALLOW_REACTION = '👍'
export const DENY_REACTION = '👎'

/** Reactions that pick options 1 to 10 of a question. */
export const NUMBER_REACTIONS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

/** Prefix of the request ids of prompts that came from Matrix. */
export const REQUEST_PREFIX = 'matrix:'

/** Source kind of the copy a send leaves in the bound session. */
export const POST_SOURCE_KIND = 'matrix-post'

/** Largest file sent or attached, in bytes. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/** Shortest pause between two edits of a streamed answer. */
export const STREAM_EDIT_MS = 2_000

/** How long one typing notice lasts; it is renewed while the turn runs. */
export const TYPING_MS = 30_000

/** Command prefixes: `!` works in every client, `/` where the client sends it. */
export const COMMAND_PREFIXES = ['!', '/']

/** Unstable event types of the bot command proposals (MSC4332, MSC4391). */
export const MSC4332_COMMANDS = 'org.matrix.msc4332.commands'
export const MSC4332_COMMAND = 'org.matrix.msc4332.command'
export const MSC4391_DESCRIPTION = 'org.matrix.msc4391.command_description'
export const MSC4391_COMMAND = 'org.matrix.msc4391.command'
