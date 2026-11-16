import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBridge } from '../src/app.js'
import { MSC4332_COMMANDS, MSC4391_DESCRIPTION } from '../src/constants.js'
import { BOT, makeHost, makeMatrix, OTHER, settle, STRANGER, TESTER, until } from './fake.js'

/** Start a bridge on fakes and wait until it runs; `keepState` keeps `state.json` from earlier tests. */
async function start({ keepState = false, ...options } = {}) {
  if (!keepState) await rm(join(process.env.DSH_HOME, 'matrix', 'state.json'), { force: true })
  const host = makeHost(options)
  const m = makeMatrix()
  createBridge(host.ctx, host.config, m.connect)
  await until(() => m.handlers() !== undefined, 'the connection')
  await settle(20)
  return { host, m }
}

/** Invite the bot to a direct chat as the tester and wait until the Space is made. @returns the room id. */
async function firstContact(m, roomId = '!dm:hs.example') {
  await m.invite(roomId, TESTER, { direct: true })
  await until(() => m.state.has(`${roomId}\u0000m.room.pinned_events\u0000`), 'the welcome')
  return roomId
}

/** Run one turn of a session through the bridge's event listener. */
function runTurn(host, sessionId, turn, { requestId, answer, reason = { kind: 'completed' }, source }) {
  host.sessionEvent(sessionId, 'turn/start', { turn })
  if (requestId !== undefined) host.sessionEvent(sessionId, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId: requestId } })
  if (source !== undefined) host.sessionEvent(sessionId, 'user/message', { id: 'w', role: 'user', content: [{ type: 'text', text: 'from the web' }], source })
  host.sessionEvent(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool-call' }] } })
  if (answer !== undefined) host.sessionEvent(sessionId, 'assistant/message', { turn, step: 2, message: { content: [{ type: 'text', text: answer }] } })
  host.sessionEvent(sessionId, 'turn/end', { turn, reason })
}

/** Messages (not reactions or state) the bot sent into a room. */
const messages = (m, roomId) => m.sent.filter((event) => event.type === 'm.room.message' && event.room_id === roomId)
const bodies = (m, roomId) => messages(m, roomId).map((event) => event.content.body)
const reactionsOn = (m, eventId) => m.sent.filter((event) => event.type === 'm.reaction' && event.content['m.relates_to'].event_id === eventId).map((event) => event.content['m.relates_to'].key)

test('a first direct chat makes the person a private Space, links the chat as its lobby and pins the help', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  assert.ok(m.joined.has(roomId))
  const space = m.created.find((entry) => entry.options.creation_content?.type === 'm.space')
  assert.ok(space, 'a Space was made')
  assert.deepEqual(space.options.invite, [TESTER])
  assert.equal((await m.matrix.getState(space.roomId, 'm.room.power_levels')).users[TESTER], 100)
  assert.equal(space.options.name, 'Bot')
  assert.deepEqual(await m.matrix.getState(space.roomId, 'm.space.child', roomId), { via: ['hs.example'], suggested: true })
  const [help] = messages(m, roomId)
  assert.match(help.content.body, /!new <room name>/u)
  assert.deepEqual((await m.matrix.getState(roomId, 'm.room.pinned_events')).pinned, [help.event_id])
  assert.equal((await m.matrix.getState(roomId, MSC4332_COMMANDS, BOT)).sigil, '!')
  assert.equal((await m.matrix.getState(roomId, MSC4391_DESCRIPTION, 'model')).command, 'model')
  host.dispose()
})

test('a message already in a direct chat when the invite arrives makes one Space and one prompt', async () => {
  const { host, m } = await start()
  const roomId = '!early:hs.example'
  await m.invite(roomId, TESTER, { direct: true })
  await m.message(roomId, 'hello')
  await until(() => m.state.has(`${roomId}\u0000m.room.pinned_events\u0000`), 'the welcome')
  await settle(30)
  assert.equal(m.created.filter((entry) => entry.options.creation_content?.type === 'm.space').length, 1)
  assert.equal(host.prompts.length, 1)
  assert.equal(host.prompts[0].content[0].text, 'hello')
  host.dispose()
})

test('a message becomes a prompt with its sender recorded, and the answer comes back as HTML', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  const eventId = await m.message(roomId, 'hello')
  assert.equal(host.prompts.length, 1)
  const [prompt] = host.prompts
  assert.equal(prompt.requestId, `matrix:${roomId}:${eventId}`)
  assert.equal(prompt.mode, 'queue')
  assert.equal(prompt.content[0].text, 'hello')
  assert.deepEqual(reactionsOn(m, eventId), ['⏳'])
  assert.ok(m.receipts.some((receipt) => receipt.eventId === eventId))
  // The sender and send time reach the session at the prompt's step, as metadata on its source.
  const message = { id: 'p1', role: 'user', content: prompt.content, source: { kind: 'user', rpcId: prompt.requestId } }
  const [decision] = await Promise.all(host.call('agent/pre-step', {}, async () => ({ kind: 'enter', messages: [message] })))
  assert.equal(decision.messages.length, 1, 'no message of its own: rendering is the renderer\'s job')
  assert.equal(decision.messages[0].source.principal.id, TESTER)
  assert.equal(decision.messages[0].source.principal.kind, 'matrix-user')
  assert.equal(decision.messages[0].source.principal.chat.id, roomId)
  assert.equal(typeof decision.messages[0].source.envelope.sentAt, 'number')
  assert.deepEqual(decision.messages[0].content, prompt.content)
  runTurn(host, prompt.sessionId, 1, { requestId: prompt.requestId, answer: 'Hi **there**.' })
  await until(() => bodies(m, roomId).includes('Hi **there**.'), 'the answer')
  const answer = messages(m, roomId).at(-1)
  assert.equal(answer.content.formatted_body, '<p>Hi <strong>there</strong>.</p>')
  await until(() => m.redactions.length === 1, 'the working reaction removed')
  assert.ok(m.typing.some((entry) => entry.on) && m.typing.at(-1).on === false)
  host.dispose()
})

test('a streamed answer is one message edited in place, finished by the final answer', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  await m.message(roomId, 'tell me')
  const { sessionId, requestId } = host.prompts[0]
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  const agent = { session: { id: sessionId } }
  const frame = (chunk) => host.call('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk } })
  frame({ type: 'block-start', blockType: 'text' })
  frame({ type: 'text-delta', text: 'Part one' })
  await until(() => bodies(m, roomId).includes('Part one'), 'the first draft', 400)
  frame({ type: 'text-delta', text: ', part two' })
  host.sessionEvent(sessionId, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Part one, part two.' }] } })
  host.sessionEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => messages(m, roomId).some((event) => event.content['m.new_content']?.body === 'Part one, part two.'), 'the final edit', 400)
  const draft = messages(m, roomId).find((event) => event.content.body === 'Part one')
  const edit = messages(m, roomId).at(-1)
  assert.deepEqual(edit.content['m.relates_to'], { rel_type: 'm.replace', event_id: draft.event_id })
  assert.equal(messages(m, roomId).filter((event) => event.content['m.relates_to']?.rel_type !== 'm.replace').length, 2, 'help and one answer message')
  host.dispose()
})

test('a silent turn shows nothing, and a failed one says so', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  await m.message(roomId, 'hi')
  const { sessionId, requestId } = host.prompts[0]
  const before = messages(m, roomId).length
  runTurn(host, sessionId, 1, { requestId, answer: '[SILENT]' })
  await settle(50)
  assert.equal(messages(m, roomId).length, before)
  runTurn(host, sessionId, 2, { requestId, reason: { kind: 'error', error: { message: 'model down' } } })
  await until(() => bodies(m, roomId).includes('❌ model down'), 'the failure')
  host.dispose()
})

test('strangers are ignored and their invites turned down; allowed people only count in their own rooms', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  await m.message(roomId, 'let me in', { sender: STRANGER })
  await m.message(roomId, 'me too', { sender: OTHER })
  assert.equal(host.prompts.length, 0)
  await m.invite('!spam:elsewhere.example', STRANGER)
  await until(() => m.left.includes('!spam:elsewhere.example'), 'the invite turned down')
  const state = JSON.parse(await readFile(join(process.env.DSH_HOME, 'matrix', 'state.json'), 'utf8'))
  assert.ok(state.pending[STRANGER])
  host.dispose()
})

test('history from before the bot first started is not taken as new', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  await m.deliver(roomId, { type: 'm.room.message', content: { msgtype: 'm.text', body: 'old news' }, origin_server_ts: Date.now() - 3_600_000 })
  assert.equal(host.prompts.length, 0)
  host.dispose()
})

test('a room the person adds to their Space is joined and gets its own session', async () => {
  const { host, m } = await start()
  const lobby = await firstContact(m)
  const spaceId = m.created.find((entry) => entry.options.creation_content?.type === 'm.space').roomId
  await m.deliver(spaceId, { type: 'm.space.child', state_key: '!fresh:hs.example', content: { via: ['hs.example'] } })
  assert.ok(m.joined.has('!fresh:hs.example'))
  await m.message(lobby, 'in the lobby')
  await m.message('!fresh:hs.example', 'in the new room')
  assert.equal(host.prompts.length, 2)
  assert.notEqual(host.prompts[0].sessionId, host.prompts[1].sessionId)
  // A room the bot cannot join gets a note in the lobby.
  m.failJoin.add('!closed:hs.example')
  await m.deliver(spaceId, { type: 'm.space.child', state_key: '!closed:hs.example', content: { via: ['hs.example'] } })
  await until(() => bodies(m, lobby).some((body) => /Invite me there/u.test(body)), 'the note')
  host.dispose()
})

test('!new makes a new encrypted room in the Space and invites the person; /reset starts a new session in place', async () => {
  const { host, m } = await start()
  const lobby = await firstContact(m)
  await m.message(lobby, '!new Trip planning')
  const room = m.created.find((entry) => entry.options.name === 'Trip planning')
  assert.ok(room, 'the room was made')
  assert.deepEqual(room.options.invite, [TESTER])
  assert.ok(room.options.initial_state.some((entry) => entry.type === 'm.room.encryption'))
  const spaceId = m.created.find((entry) => entry.options.creation_content?.type === 'm.space').roomId
  assert.ok(await m.matrix.getState(spaceId, 'm.space.child', room.roomId))
  await m.message(room.roomId, 'first')
  const first = host.prompts[0].sessionId
  await m.message(room.roomId, '/reset')
  await m.message(room.roomId, 'second')
  assert.notEqual(host.prompts[1].sessionId, first)
  assert.equal(host.prompts.length, 2, 'commands are not prompts')
  host.dispose()
})

test('a Space the person made is adopted when the bot may add rooms, otherwise the bot asks for the power level', async () => {
  const { host, m } = await start()
  await m.invite('!theirs:hs.example', TESTER, { space: true, powerLevels: { users: { [TESTER]: 100 }, state_default: 50 } })
  await until(() => m.sent.some((event) => event.room_id === '!theirs:hs.example' && /power level 50/u.test(event.content?.body ?? '')), 'the request for a power level')
  m.setState('!theirs:hs.example', 'm.room.power_levels', '', { users: { [TESTER]: 100, [BOT]: 50 }, state_default: 50 })
  await m.deliver('!theirs:hs.example', { type: 'm.room.power_levels', state_key: '', content: {} })
  await until(() => m.created.some((entry) => entry.options.name === 'Bot'), 'the lobby in the adopted Space')
  const lobby = m.created.find((entry) => entry.options.name === 'Bot').roomId
  assert.ok(await m.matrix.getState('!theirs:hs.example', 'm.space.child', lobby))
  assert.ok(!m.created.some((entry) => entry.options.creation_content?.type === 'm.space'), 'no Space of its own was made')
  host.dispose()
})

test('approvals and questions are answered by tapping the reactions the bot put on them', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  await m.message(roomId, 'hello')
  const { sessionId, requestId } = host.prompts[0]
  const agent = host.agents.get(sessionId)
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  const [approval] = agent.handlers.get('approval/request')
  const outcome = approval({ toolName: 'bash', reason: 'rm -rf build' }, () => 'unhandled')
  await until(() => bodies(m, roomId).some((body) => /Approval needed for bash/u.test(body)), 'the approval request')
  const request = messages(m, roomId).at(-1)
  await until(() => reactionsOn(m, request.event_id).length === 2, 'the answer reactions')
  assert.deepEqual(reactionsOn(m, request.event_id), ['👍', '👎'])
  await m.deliver(roomId, { type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: request.event_id, key: '👍' } } })
  assert.equal(await outcome, 'allowed-once')
  const [handler] = agent.handlers.get('user-questions/request')
  const answer = handler({ questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }, () => 'unhandled')
  await until(() => bodies(m, roomId).some((body) => /❓ Which\?/u.test(body)), 'the question')
  const question = messages(m, roomId).at(-1)
  assert.match(question.content.body, /1\. A\n2\. B/u)
  await until(() => reactionsOn(m, question.event_id).length === 2, 'the number reactions')
  await m.deliver(roomId, { type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: question.event_id, key: '2️⃣' } } })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['B'] }] })
  const second = approval({ toolName: 'bash', reason: 'again' }, () => 'unhandled')
  await settle()
  await m.message(roomId, '!deny')
  assert.equal(await second, 'rejected')
  assert.equal(host.prompts.length, 1)
  host.dispose()
})

test('a message during a running turn is steered into it with 👀', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  await m.message(roomId, 'first')
  host.agents.get(host.prompts[0].sessionId).status = 'running'
  const second = await m.message(roomId, 'also this')
  assert.equal(host.prompts[1].mode, 'steer')
  assert.deepEqual(reactionsOn(m, second), ['👀'])
  host.dispose()
})

test('the send service delivers into a room, records it in the session and refuses a session answering itself', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  await m.message(roomId, 'hello')
  const { sessionId, requestId } = host.prompts[0]
  const result = await host.service().send({ to: roomId, text: 'Reminder', from: { job: 'daily' } })
  assert.equal(result.recorded, true)
  assert.equal(messages(m, roomId).at(-1).content.body, 'Reminder')
  const recorded = host.agents.get(sessionId).session.snapshotEvents().find((event) => event.data?.source?.kind === 'matrix-post')
  assert.equal(recorded.data.source.principal.kind, 'cron-job')
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  await assert.rejects(host.service().send({ to: roomId, text: 'my answer', from: { sessionId } }), /delivered there/u)
  await assert.rejects(host.service().send({ to: '!unknown:hs.example', text: 'x' }), /Unknown room/u)
  host.dispose()
})

test('room sessions are titled Matrix-<person>-<task>', async () => {
  const { host, m } = await start()
  const roomId = await firstContact(m)
  await m.message(roomId, 'plan the weekend')
  const { sessionId } = host.prompts[0]
  const title = () => host.services.sessionTitle.get(host.agents.get(sessionId).session)?.title
  assert.equal(title(), 'Matrix-Tester-Matrix room')
  host.agents.get(sessionId).session.append('user/message', { source: { kind: 'user' } })
  host.sessionEvent(sessionId, 'request/header', {})
  await until(() => title() === 'Weekend plans', 'the generated title')
  host.sessionEvent(sessionId, 'session/title', { source: { kind: 'generated' } })
  await until(() => title() === 'Matrix-Tester-Weekend plans', 'the title in the room format')
  host.dispose()
})
