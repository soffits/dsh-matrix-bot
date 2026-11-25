#!/usr/bin/env node
/**
 * Talk to the running DSH Matrix bot from a shell: send messages, list
 * rooms, allow a person, show its status.
 *
 * Requests go through the plugin's file spool under $DSH_HOME/matrix, so
 * no network access to DSH is needed, and a send waits there while DSH is
 * not running.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { enqueue, waitForResult, withdraw } from '@soffits/dsh-plugin-sdk/channel'
import { dataDir, spoolDir } from '../src/constants.js'

const usage = `Usage: dsh-matrix <command> [options]

Commands:
  send --room <id> [--file <path>]... [--reply-to <event>] [--job <name>] [text...]
        Send text (from the arguments, or stdin when none are given) and files
        into a room. The message is also recorded in the room's session.
  react --room <id> --reply-to <event> <emoji>
        React to a message.
  allow <user-id> [--name <label>]
        Add a Matrix user id to allowedUsers (writes the profile's configuration).
  rooms
        List the rooms of allowed people and their sessions.
  status
        Show the bot's state, encryption, Spaces and the senders it ignored.

Options:
  --timeout <seconds>   how long to wait for the bot (default 30)
  --no-wait             queue a send and return at once

Exit codes: 0 done, 1 failed, 2 bad arguments, 3 the bot did not answer in time.`

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

let parsed
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      room: { type: 'string', short: 'r' },
      file: { type: 'string', short: 'f', multiple: true },
      'reply-to': { type: 'string' },
      job: { type: 'string', short: 'j' },
      'from-session': { type: 'string' },
      name: { type: 'string' },
      timeout: { type: 'string' },
      'no-wait': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
} catch (error) {
  fail(`${error.message}\n\n${usage}`)
}
const { values, positionals } = parsed
const [command, ...rest] = positionals
if (values.help || command === undefined) {
  process.stdout.write(`${usage}\n`)
  process.exit(values.help ? 0 : 2)
}
const timeoutMs = Math.max(1, Number(values.timeout ?? 30)) * 1000

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

let request
if (command === 'send' || command === 'react') {
  if (values.room === undefined || !values.room.trim().startsWith('!')) fail('--room takes the room id, which starts with ! (!id in the room shows it).')
  const sessionId = values['from-session'] ?? process.env.DSH_SESSION_ID
  const from = {
    ...(values.job ? { job: values.job } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(!values.job && !sessionId ? { label: 'dsh-matrix' } : {}),
  }
  if (command === 'react') {
    if (values['reply-to'] === undefined || rest.length === 0) fail('react needs --reply-to <event id> and an emoji.')
    request = { op: 'send', to: values.room.trim(), replyTo: values['reply-to'], reaction: rest.join(' '), from }
  } else {
    const text = rest.length > 0 ? rest.join(' ') : (values.file?.length ? '' : readStdin())
    request = {
      op: 'send',
      to: values.room.trim(),
      text,
      files: (values.file ?? []).map((path) => resolve(path)),
      ...(values['reply-to'] === undefined ? {} : { replyTo: values['reply-to'] }),
      from,
    }
  }
} else if (command === 'rooms' || command === 'status') {
  request = { op: command }
} else if (command === 'allow') {
  if (rest.length !== 1) fail('allow takes one Matrix user id.')
  request = { op: 'allow', userId: rest[0], name: values.name ?? '' }
} else {
  fail(`Unknown command ${command}.\n\n${usage}`)
}

const id = await enqueue(request, spoolDir())
if (values['no-wait'] && request.op === 'send') {
  process.stdout.write(`queued ${id}\n`)
  process.exit(0)
}
const result = await waitForResult(id, timeoutMs, spoolDir())
if (result === undefined) {
  // Only sends keep waiting for the bot; other requests are withdrawn.
  if (request.op !== 'send') await withdraw(id, spoolDir())
  let state = ''
  try {
    const status = JSON.parse(readFileSync(join(dataDir(), 'status.json'), 'utf8'))
    state = ` (last state: ${status.state}${status.detail ? `, ${status.detail}` : ''})`
  } catch {
    // No status yet.
  }
  process.stderr.write(`The Matrix bot did not answer in time${state}.${request.op === 'send' ? ' The message stays queued and goes out when the bot runs.' : ''}\n`)
  process.exit(3)
}
if (!result.ok) {
  process.stderr.write(`${result.error}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`)
