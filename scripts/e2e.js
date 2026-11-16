#!/usr/bin/env node
/**
 * End-to-end run against a throwaway local homeserver (Tuwunel): the real
 * bot, a fake DSH Host, and a second encrypted client playing the person.
 * Everything lives in a temporary directory that is removed at the end.
 *
 * TUWUNEL names the server binary; without it the pinned release is
 * downloaded into `.e2e/` first.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createZstdDecompress } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = await mkdtemp(join(tmpdir(), 'dsh-matrix-e2e-'))
process.env.DSH_HOME = join(work, 'dsh-home')
process.env.NODE_ENV = 'test'

const TUWUNEL_RELEASE = 'v2.0.0-assets'
const TUWUNEL_ASSET = 'v2.0.0-assets-release-default-x86_64-v1-linux-gnu-tuwunel.zst'
const SERVER = 'localhost'
const TOKEN = 'e2e-registration-token'

const { MatrixClient, RustSdkCryptoStorageProvider, SimpleFsStorageProvider, LogService, LogLevel } = await import('@vector-im/matrix-bot-sdk')
const { createRequire } = await import('node:module')
const { StoreType } = createRequire(import.meta.url)('@matrix-org/matrix-sdk-crypto-nodejs')
const { createBridge } = await import('../src/app.js')
const { connect, trackCalls } = await import('../src/matrix.js')
const { makeHost, settle, until } = await import('../test/fake.js')
LogService.setLevel(LogLevel.ERROR)

const log = (line) => process.stdout.write(`e2e: ${line}\n`)
let server
const bridges = []

/** @returns a free local port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** @returns the server binary, downloaded when TUWUNEL is not set. */
async function tuwunel() {
  if (process.env.TUWUNEL) return process.env.TUWUNEL
  const path = join(root, '.e2e', 'tuwunel')
  try {
    await access(path)
    return path
  } catch {
    // Download it.
  }
  await mkdir(dirname(path), { recursive: true })
  const url = `https://github.com/matrix-construct/tuwunel/releases/download/${TUWUNEL_RELEASE}/${TUWUNEL_ASSET}`
  log(`downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: ${response.status}`)
  const packed = `${path}.zst`
  await writeFile(packed, Buffer.from(await response.arrayBuffer()))
  await pipeline(createReadStream(packed), createZstdDecompress(), createWriteStream(path))
  await rm(packed)
  await chmod(path, 0o755)
  return path
}

/** Start the homeserver. @returns its base URL. */
async function startServer() {
  const port = await freePort()
  const config = join(work, 'tuwunel.toml')
  await writeFile(config, [
    '[global]',
    `server_name = "${SERVER}"`,
    `database_path = "${join(work, 'db')}"`,
    '[global.http.listen]',
    'address = ["127.0.0.1"]',
    `port = ${port}`,
    '[global.registration]',
    'enable = true',
    `token = "${TOKEN}"`,
    'displayname_suffix = ""',
    '[global.federation]',
    'enable = false',
    '[global.rocksdb]',
    'parallelism_threads = 2',
  ].join('\n'))
  server = spawn(await tuwunel(), ['-c', config], { stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  server.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-4000) })
  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/_matrix/client/versions`)).ok) return base
    } catch {
      // Not up yet.
    }
    if (server.exitCode !== null) throw new Error(`the homeserver quit: ${errors}`)
    await settle(200)
  }
  throw new Error(`the homeserver did not start: ${errors}`)
}

/** Register an account with the registration token. @returns `{ userId, accessToken, deviceId }`. */
async function register(base, username, password) {
  const call = (body) => fetch(`${base}/_matrix/client/v3/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const first = await (await call({ username, password, inhibit_login: true })).json()
  const done = await call({ username, password, inhibit_login: true, auth: { type: 'm.login.registration_token', token: TOKEN, session: first.session } })
  if (!done.ok) throw new Error(`register ${username}: ${done.status} ${await done.text()}`)
}

/** An encrypted client for the person, logged in with a password. */
async function personClient(base, username, password) {
  const response = await fetch(`${base}/_matrix/client/v3/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: username }, password }) })
  const login = await response.json()
  const dir = join(work, `client-${username}`)
  const client = new MatrixClient(base, login.access_token, new SimpleFsStorageProvider(join(dir, 'sync.json')), new RustSdkCryptoStorageProvider(join(dir, 'crypto'), StoreType.Sqlite))
  // Short long-polls, so the client is idle soon after it stops.
  client.syncingTimeout = 1000
  const timeline = []
  client.on('room.event', (roomId, event) => timeline.push({ roomId, event }))
  client.on('room.encrypted_event', (roomId, event) => timeline.push({ roomId, raw: event }))
  await client.start()
  return { client, timeline, userId: login.user_id, calls: trackCalls(client.crypto.engine.machine) }
}

/** Start the real bot on a fake DSH Host. */
function startBot(base, botId, passwordFile, person) {
  const host = makeHost({ config: { homeserver: base, userId: botId, passwordFile, allowedUsers: [{ userId: person, name: 'Tester' }], displayName: 'E2E Bot', cwd: work } })
  createBridge(host.ctx, host.config, connect)
  bridges.push(host)
  return host
}

/** Run one turn of the session that took the newest prompt, answering `answer`. */
function answerLatest(host, turn, answer) {
  const { sessionId, requestId } = host.prompts.at(-1)
  host.sessionEvent(sessionId, 'turn/start', { turn })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  host.sessionEvent(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: answer }] } })
  host.sessionEvent(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } })
}

/** @returns the decrypted message events the bot sent into a room, as the person saw them. */
function botMessages(person, roomId, botId) {
  return person.timeline.filter((entry) => entry.roomId === roomId && entry.event?.sender === botId && entry.event.type === 'm.room.message').map((entry) => entry.event)
}

try {
  const base = await startServer()
  log(`homeserver at ${base}`)
  await register(base, 'bot', 'bot-password')
  await register(base, 'tester', 'tester-password')
  const botId = `@bot:${SERVER}`
  const passwordFile = join(work, 'secrets', 'password')
  await mkdir(dirname(passwordFile), { recursive: true, mode: 0o700 })
  await writeFile(passwordFile, 'bot-password\n', { mode: 0o600 })

  const person = await personClient(base, 'tester', 'tester-password')
  let host = startBot(base, botId, passwordFile, person.userId)
  await until(() => host.logs.some(([, line]) => /^running as/u.test(line)), 'the bot to run', 3000)
  log(host.logs.find(([, line]) => /^running as/u.test(line))[1])

  // Encryption was set up once: cross-signing, a recovery key on disk, a key backup.
  const recoveryKeyFile = join(process.env.DSH_HOME, 'matrix', 'recovery-key')
  assert.equal((await stat(recoveryKeyFile)).mode & 0o777, 0o600)
  assert.equal((await stat(join(process.env.DSH_HOME, 'matrix', 'account', 'session.json'))).mode & 0o777, 0o600)
  const keys = await person.client.doRequest('POST', '/_matrix/client/v3/keys/query', null, { device_keys: { [botId]: [] } })
  assert.ok(keys.master_keys?.[botId], 'the bot has a master key')
  const botDevice = Object.values(keys.device_keys[botId])[0]
  const selfSigning = Object.keys(keys.self_signing_keys[botId].keys)[0]
  assert.ok(botDevice.signatures[botId][selfSigning], 'the bot device is cross-signed')
  log('cross-signing, recovery key and device signature in place')

  // The person opens an encrypted direct chat with the bot.
  const dm = await person.client.createRoom({ invite: [botId], is_direct: true, preset: 'trusted_private_chat', initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] })
  await until(() => person.timeline.some((entry) => entry.roomId === dm && entry.event?.type === 'm.room.pinned_events'), 'the welcome in the direct chat', 3000)
  const invites = await person.client.doRequest('GET', '/_matrix/client/v3/sync', { timeout: 0, filter: JSON.stringify({ room: { timeline: { limit: 0 } } }) })
  const spaceId = Object.keys(invites.rooms?.invite ?? {})[0]
  assert.ok(spaceId, 'the person was invited to a Space')
  await person.client.joinRoom(spaceId)
  const child = await person.client.getRoomStateEvent(spaceId, 'm.space.child', dm)
  assert.deepEqual(child.via, [SERVER])
  log(`Space ${spaceId} made, direct chat linked as its lobby`)

  // A message reaches the session, and the answer comes back encrypted.
  await person.client.sendMessage(dm, { msgtype: 'm.text', body: 'hello from the e2e test' })
  await until(() => host.prompts.length === 1, 'the prompt', 3000)
  assert.equal(host.prompts[0].content[0].text, 'hello from the e2e test')
  answerLatest(host, 1, 'Hi, **this** came back encrypted.')
  await until(() => botMessages(person, dm, botId).some((event) => event.content.body === 'Hi, **this** came back encrypted.'), 'the answer', 3000)
  const answer = botMessages(person, dm, botId).find((event) => event.content.body === 'Hi, **this** came back encrypted.')
  assert.equal(answer.content.formatted_body, '<p>Hi, <strong>this</strong> came back encrypted.</p>')
  assert.ok(person.timeline.some((entry) => entry.raw?.event_id === answer.event_id && entry.raw.type === 'm.room.encrypted'), 'the answer was encrypted on the wire')
  log('message in, encrypted answer out')

  // A new room the person makes in their Space starts a new session.
  const room = await person.client.createRoom({
    name: 'Second topic',
    room_version: '10',
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'restricted', allow: [{ type: 'm.room_membership', room_id: spaceId }] } },
    ],
  })
  await person.client.sendStateEvent(spaceId, 'm.space.child', room, { via: [SERVER] })
  let members = []
  for (let attempt = 0; attempt < 100 && !members.includes(botId); attempt += 1) {
    await settle(200)
    members = await person.client.getJoinedRoomMembers(room)
  }
  assert.ok(members.includes(botId), 'the bot joined the room added to the Space')
  await person.client.sendMessage(room, { msgtype: 'm.text', body: 'a new topic' })
  await until(() => host.prompts.length === 2, 'the second prompt', 3000)
  assert.notEqual(host.prompts[1].sessionId, host.prompts[0].sessionId)
  log('a room added to the Space got its own session')

  // An approval asked in the room is answered with a reaction.
  const { sessionId, requestId } = host.prompts[0]
  host.sessionEvent(sessionId, 'turn/start', { turn: 2 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  const [approval] = host.agents.get(sessionId).handlers.get('approval/request')
  const outcome = approval({ toolName: 'bash', reason: 'rm -rf build' }, () => 'unhandled')
  await until(() => botMessages(person, dm, botId).some((event) => /Approval needed for bash/u.test(event.content.body)), 'the approval request', 3000)
  const request = botMessages(person, dm, botId).find((event) => /Approval needed for bash/u.test(event.content.body))
  await person.client.sendEvent(dm, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: request.event_id, key: '👍' } })
  assert.equal(await outcome, 'allowed-once')
  host.sessionEvent(sessionId, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  log('approval answered with a reaction')

  // After a restart the bot keeps its device and still reads encrypted messages.
  const deviceId = JSON.parse(await readFile(join(process.env.DSH_HOME, 'matrix', 'account', 'session.json'), 'utf8')).deviceId
  host.dispose()
  await settle(500)
  host = startBot(base, botId, passwordFile, person.userId)
  await until(() => host.logs.some(([, line]) => /^running as/u.test(line)), 'the bot to run again', 3000)
  assert.match(host.logs.find(([, line]) => /^running as/u.test(line))[1], new RegExp(`device ${deviceId};`, 'u'))
  await person.client.sendMessage(dm, { msgtype: 'm.text', body: 'after the restart' })
  await until(() => host.prompts.some((prompt) => prompt.content[0].text === 'after the restart'), 'the prompt after the restart', 3000)
  log('restart kept the device and decryption')

  // With its data lost, the bot logs in on a new device and verifies it with the recovery key.
  host.dispose()
  await settle(500)
  await rm(join(process.env.DSH_HOME, 'matrix', 'account'), { recursive: true })
  host = startBot(base, botId, passwordFile, person.userId)
  await until(() => host.logs.some(([, line]) => /^running as/u.test(line)), 'the bot on a new device', 3000)
  const running = host.logs.find(([, line]) => /^running as/u.test(line))[1]
  assert.doesNotMatch(running, new RegExp(`device ${deviceId};`, 'u'))
  assert.match(running, /; verified, key backup on\)$/u)
  assert.ok(host.logs.some(([, line]) => line === 'verified this device with the recovery key'))
  await person.client.sendMessage(dm, { msgtype: 'm.text', body: 'to the new device' })
  await until(() => host.prompts.some((prompt) => prompt.content[0].text === 'to the new device'), 'the prompt on the new device', 3000)
  log('a new device verified itself with the recovery key and reads the room')
  person.client.stop()
  await settle(1500)
  await person.calls.drain()
  person.client.crypto.engine.machine.close()
  log('all checks passed')
} catch (error) {
  process.stderr.write(`e2e failed: ${error?.stack ?? error}\n`)
  for (const host of bridges) for (const [level, line] of host.logs) process.stderr.write(`  bot ${level}: ${line}\n`)
  process.exitCode = 1
} finally {
  for (const host of bridges) host.dispose()
  server?.kill('SIGTERM')
  await settle(300)
  await rm(work, { recursive: true, force: true })
  // The SDKs keep timers alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref()
}
