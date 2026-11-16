import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBridge } from '../src/app.js'
import { makeDeltaChat, makeHost, settle, until } from './fake.js'

/** Start a bridge on fakes and wait until it runs; `keepState` keeps `state.json` from earlier tests. */
async function start({ keepState = false, ...options } = {}) {
  if (!keepState) await rm(join(process.env.DSH_HOME, 'deltachat', 'state.json'), { force: true })
  const host = makeHost(options)
  const chat = makeDeltaChat()
  createBridge(host.ctx, host.config, chat.core)
  for (let attempt = 0; attempt < 50 && !chat.calls.some((call) => call.name === 'getFreshMsgs'); attempt += 1) await settle(10)
  return { host, chat }
}

/** @returns the reactions the bot set on one message, oldest first. */
const reactionsOn = (chat, msgId) => chat.calls.filter((call) => call.name === 'sendReaction' && call.args[1] === msgId).map((call) => call.args[2])

/** Run one turn of a session through the bridge's event listener. */
function runTurn(host, sessionId, turn, { requestId, answer, reason = { kind: 'completed' }, source }) {
  host.sessionEvent(sessionId, 'turn/start', { turn })
  if (requestId !== undefined) host.sessionEvent(sessionId, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId: requestId } })
  if (source !== undefined) host.sessionEvent(sessionId, 'user/message', { id: 'w', role: 'user', content: [{ type: 'text', text: 'from the web' }], source })
  host.sessionEvent(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool-call' }] } })
  if (answer !== undefined) host.sessionEvent(sessionId, 'assistant/message', { turn, step: 2, message: { content: [{ type: 'text', text: answer }] } })
  host.sessionEvent(sessionId, 'turn/end', { turn, reason })
}

const texts = (chat) => chat.sent.map((message) => message.text)

test('an allowed message becomes a prompt in a new session, and the answer comes back as plain text', async () => {
  const { host, chat } = await start()
  const msgId = await chat.handled(chat.addIncoming({ text: 'hello' }))
  assert.equal(host.prompts.length, 1)
  const [prompt] = host.prompts
  assert.equal(prompt.requestId, `deltachat:10:${msgId}`)
  assert.equal(prompt.mode, 'queue')
  assert.match(prompt.content[0].text, /^\[Delta Chat message from Tester \(Delta Chat name "Test Person", key 425AAD93\w+, chat 10, message \d+\)\]\nhello$/u)
  assert.ok(chat.calls.some((call) => call.name === 'markseenMsgs' && call.args[1][0] === msgId))
  runTurn(host, prompt.sessionId, 1, { requestId: prompt.requestId, answer: 'Hi **there**.' })
  await until(() => chat.sent.length > 0, 'the answer')
  assert.deepEqual(texts(chat), ['Hi there.'])
  assert.equal(chat.sent[0].quotedMessageId, null)
  host.dispose()
})

test('a stranger is ignored and remembered, with no read receipt', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'let me in', fromId: 12 }))
  assert.equal(host.prompts.length, 0)
  assert.deepEqual(chat.sent, [])
  assert.ok(chat.calls.some((call) => call.name === 'marknoticedChat'))
  assert.ok(!chat.calls.some((call) => call.name === 'markseenMsgs'))
  const status = await (await import('node:fs/promises')).readFile(`${process.env.DSH_HOME}/deltachat/state.json`, 'utf8')
  assert.match(status, /contact-12/u)
  host.dispose()
})

test('a message during a running turn is steered into it and marked with a reaction', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'first' }))
  const sessionId = host.prompts[0].sessionId
  host.agents.get(sessionId).status = 'running'
  const second = await chat.handled(chat.addIncoming({ text: 'also this' }))
  assert.equal(host.prompts[1].mode, 'steer')
  assert.ok(chat.calls.some((call) => call.name === 'sendReaction' && call.args[1] === second && call.args[2][0] === '👀'))
  host.dispose()
})

test('the answer quotes its prompt when newer messages arrived meanwhile', async () => {
  const { host, chat } = await start()
  const first = await chat.handled(chat.addIncoming({ text: 'first' }))
  const { sessionId, requestId } = host.prompts[0]
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  await chat.handled(chat.addIncoming({ text: '/ping' }))
  host.sessionEvent(sessionId, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Answer.' }] } })
  host.sessionEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => texts(chat).includes('Answer.'), 'the answer')
  const answer = chat.sent.find((message) => message.text === 'Answer.')
  assert.equal(answer.quotedMessageId, first)
  host.dispose()
})

test('turns started elsewhere are mirrored, failures reported, and [SILENT] posts nothing', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const { sessionId, requestId } = host.prompts[0]
  runTurn(host, sessionId, 1, { source: { kind: 'user', rpcId: 'web-1' }, answer: 'Web answer' })
  runTurn(host, sessionId, 2, { requestId, reason: { kind: 'error', error: { message: 'rate limited' } } })
  runTurn(host, sessionId, 3, { requestId, answer: '[SILENT]' })
  runTurn(host, sessionId, 4, { requestId, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await until(() => chat.sent.length >= 3, 'three messages')
  await settle()
  assert.deepEqual(texts(chat), ['🖥 From Web:\nfrom the web', 'Web answer', '❌ rate limited'])
  host.dispose()
})

test('with mirroring off only Delta Chat turns are delivered', async () => {
  const { host, chat } = await start({ config: { mirrorTurns: false } })
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const { sessionId, requestId } = host.prompts[0]
  runTurn(host, sessionId, 1, { source: { kind: 'user', rpcId: 'web-1' }, answer: 'Web answer' })
  runTurn(host, sessionId, 2, { requestId, answer: 'Mine' })
  await until(() => texts(chat).includes('Mine'), 'the answer')
  await settle()
  assert.deepEqual(texts(chat), ['Mine'])
  host.dispose()
})

test('commands pick models by number, start new sessions and stop turns', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const sessionId = host.prompts[0].sessionId
  await chat.handled(chat.addIncoming({ text: '/model' }))
  assert.match(texts(chat).at(-1), /1\. Provider One \(1\) ✅\n2\. Provider Two \(2\)/u)
  await chat.handled(chat.addIncoming({ text: '/model 2' }))
  assert.match(texts(chat).at(-1), /2\. Model Three/u)
  await chat.handled(chat.addIncoming({ text: '/model 2 2' }))
  assert.equal(texts(chat).at(-1), '🤖 Model: Model Three')
  assert.deepEqual(host.selected.at(-1), { sessionId, provider: 'p2', model: 'm3' })
  host.agents.get(sessionId).status = 'running'
  await chat.handled(chat.addIncoming({ text: '/new' }))
  assert.match(texts(chat).at(-1), /Stop the running turn first/u)
  await chat.handled(chat.addIncoming({ text: '/stop' }))
  assert.equal(host.agents.get(sessionId).cancelled, 1)
  assert.equal(texts(chat).at(-1), '⏹ Stopped.')
  host.agents.get(sessionId).status = 'idle'
  await chat.handled(chat.addIncoming({ text: '/new' }))
  assert.match(texts(chat).at(-1), /^🆕 New session/u)
  await chat.handled(chat.addIncoming({ text: 'next' }))
  const next = host.prompts.at(-1)
  assert.notEqual(next.sessionId, sessionId)
  assert.deepEqual(host.agents.get(next.sessionId).model.selection, { provider: 'p2', model: 'm3' })
  await chat.handled(chat.addIncoming({ text: '/help' }))
  assert.match(texts(chat).at(-1), /^Commands:\n\/help/u)
  host.dispose()
})

test('/fork opens a group with the allowed members, bound to the forked session', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const sessionId = host.prompts[0].sessionId
  await chat.handled(chat.addIncoming({ text: '/fork Side quest' }))
  const group = [...chat.chats.values()].find((entry) => entry.name === 'Side quest')
  assert.deepEqual(group.contacts, [11])
  assert.match(texts(chat).at(-1), /Forked into the new group "Side quest"/u)
  await chat.handled(chat.addIncoming({ text: 'in the fork', chatId: group.id }))
  assert.equal(host.prompts.at(-1).sessionId, `${sessionId}-fork`)
  host.dispose()
})

test('the send service delivers, records the send, and a quote of it names the job', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const sessionId = host.prompts[0].sessionId
  const result = await host.service().send({ to: 10, text: 'Plan for **today**', from: { job: 'Daily plan' } })
  assert.equal(result.recorded, true)
  assert.equal(texts(chat).at(-1), 'Plan for today')
  const events = host.agents.get(sessionId).session.snapshotEvents()
  assert.match(events.at(-1).data.content[0].text, /^\[Sent to Delta Chat chat "Test Person" by job "Daily plan"\]\nPlan for \*\*today\*\*/u)
  await chat.handled(chat.addIncoming({ text: 'ok', quote: { kind: 'WithMessage', messageId: result.messageIds[0], text: 'Plan for today' } }))
  assert.match(host.prompts.at(-1).content[0].text, /\[Replying to a message job "Daily plan" sent here:\]\nPlan for \*\*today\*\*/u)
  await assert.rejects(host.service().send({ to: 99, text: 'x' }), /Unknown chat 99/u)
  await assert.rejects(host.service().send({ to: 10, files: ['relative.txt'] }), /must be absolute/u)
  host.dispose()
})

test('a question from a Delta Chat turn is asked in the chat and answered by number', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const { sessionId, requestId } = host.prompts[0]
  const agent = host.agents.get(sessionId)
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  const [handler] = agent.handlers.get('user-questions/request')
  const answer = handler({ questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }, () => 'unhandled')
  await settle()
  assert.match(texts(chat).at(-1), /❓ Which\?\n\n1\. A\n2\. B/u)
  chat.addIncoming({ text: '2' })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['B'] }] })
  assert.equal(host.prompts.length, 1)
  const [approval] = agent.handlers.get('approval/request')
  const outcome = approval({ toolName: 'bash', reason: 'rm -rf build' }, () => 'unhandled')
  await settle()
  assert.match(texts(chat).at(-1), /Approval needed for bash/u)
  chat.addIncoming({ text: '/allow' })
  assert.equal(await outcome, 'allowed-once')
  host.dispose()
})

test('the command line can allow a key and join only allowed invites', async () => {
  const { host, chat } = await start()
  const edits = []
  host.ctx.fiber = { entry: 'entry-1' }
  host.services.configEditor = {
    async edit(entry, change) {
      const next = change({ allowedUsers: host.config.allowedUsers.get() })
      edits.push({ entry, next })
      host.config.allowedUsers.value = next.allowedUsers
    },
  }
  const { enqueue, waitForResult } = await import('../src/spool.js')
  const allowed = await waitForResult(await enqueue({ op: 'allow', fingerprint: '3c1f 9e0a 5b7d 2468 ace0 1357 9bdf 0246 8ace 1357', name: 'Friend' }), 5000)
  assert.deepEqual(allowed, { ok: true, result: { fingerprint: '3C1F9E0A5B7D2468ACE013579BDF02468ACE1357', name: 'Friend' } })
  assert.equal(edits[0].entry, 'entry-1')
  assert.equal(host.config.allowedUsers.get().length, 2)
  chat.handlers.checkQr = async (_account, link) => ({ kind: 'askVerifyContact', fingerprint: link.endsWith('friend') ? '3C1F 9E0A 5B7D 2468 ACE0 1357 9BDF 0246 8ACE 1357' : 'AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111 2222 3333' })
  chat.handlers.secureJoin = async () => 42
  const refused = await waitForResult(await enqueue({ op: 'join', link: 'https://i.delta.chat/#stranger' }), 5000)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /not in allowedUsers/u)
  const joined = await waitForResult(await enqueue({ op: 'join', link: 'https://i.delta.chat/#friend' }), 5000)
  assert.deepEqual(joined.result, { chatId: 42, name: 'Friend', fingerprint: '3C1F9E0A5B7D2468ACE013579BDF02468ACE1357' })
  host.dispose()
})

test('chat sessions are titled DeltaChat-<person>-<task>, from the people file when set', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const file = join(await mkdtemp(join(tmpdir(), 'people-')), 'people.json')
  const { TESTER_FINGERPRINT } = await import('./fake.js')
  await writeFile(file, JSON.stringify({ deltachat_keys: { [TESTER_FINGERPRINT]: 'Sam' } }))
  const { host, chat } = await start({ config: { peopleFile: file } })
  await chat.handled(chat.addIncoming({ text: 'book the train please' }))
  const sessionId = host.prompts[0].sessionId
  const session = host.agents.get(sessionId).session
  const title = () => host.services.sessionTitle.get(session)?.title
  assert.equal(title(), 'DeltaChat-Sam-Test Person')
  session.append('user/message', { source: { kind: 'user', rpcId: host.prompts[0].requestId }, content: [{ type: 'text', text: host.prompts[0].content[0].text }] })
  host.sessionEvent(sessionId, 'request/header', {})
  await until(() => title() !== 'DeltaChat-Sam-Test Person', 'the generated title')
  host.sessionEvent(sessionId, 'session/title', { source: { kind: 'fallback' } })
  await until(() => title() === 'DeltaChat-Sam-book the train please', 'the prefixed title')
  await chat.handled(chat.addIncoming({ text: '/rename Train trip' }))
  assert.equal(title(), 'DeltaChat-Sam-Train trip')
  host.dispose()
})

test('a message shows ⏳ while its turn runs, removed once the answer is out; commands get none', async () => {
  const { host, chat } = await start()
  const msgId = await chat.handled(chat.addIncoming({ text: 'hello' }))
  assert.deepEqual(reactionsOn(chat, msgId), [['⏳']])
  const { sessionId, requestId } = host.prompts[0]
  runTurn(host, sessionId, 1, { requestId, answer: 'Hi.' })
  await until(() => reactionsOn(chat, msgId).length === 2, 'the removal')
  assert.deepEqual(reactionsOn(chat, msgId), [['⏳'], []])
  const answerAt = chat.calls.findIndex((call) => call.name === 'sendMsg' && call.args[2].text === 'Hi.')
  const removedAt = chat.calls.findIndex((call) => call.name === 'sendReaction' && call.args[1] === msgId && call.args[2].length === 0)
  assert.ok(answerAt >= 0 && answerAt < removedAt)
  const help = await chat.handled(chat.addIncoming({ text: '/help' }))
  assert.deepEqual(reactionsOn(chat, help), [])
  const { openState } = await import('../src/state.js')
  assert.deepEqual((await openState()).reactions(), {})
  host.dispose()
})

test('a steered message shows 👀 until the running turn ends', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'first' }))
  const { sessionId, requestId } = host.prompts[0]
  const agent = host.agents.get(sessionId)
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  agent.status = 'running'
  const second = await chat.handled(chat.addIncoming({ text: 'also this' }))
  assert.deepEqual(reactionsOn(chat, second), [['👀']])
  agent.inbox.nextStep = []
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: host.prompts[1].requestId } })
  host.sessionEvent(sessionId, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Both done.' }] } })
  agent.status = 'idle'
  host.sessionEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => reactionsOn(chat, second).length === 2, 'the removal')
  assert.deepEqual(reactionsOn(chat, second), [['👀'], []])
  host.dispose()
})

test('a queued message keeps ⏳ through the running turn and loses it after its own', async () => {
  const { host, chat } = await start({ config: { busyMessages: 'queue' } })
  const first = await chat.handled(chat.addIncoming({ text: 'first' }))
  const { sessionId, requestId } = host.prompts[0]
  const agent = host.agents.get(sessionId)
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  agent.status = 'running'
  const second = await chat.handled(chat.addIncoming({ text: 'later' }))
  assert.equal(host.prompts[1].mode, 'queue')
  assert.deepEqual(reactionsOn(chat, second), [['⏳']])
  host.sessionEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => reactionsOn(chat, first).length === 2, 'the first removal')
  await settle()
  assert.deepEqual(reactionsOn(chat, second), [['⏳']])
  agent.inbox.nextTurn = []
  runTurn(host, sessionId, 2, { requestId: host.prompts[1].requestId, answer: 'Later done.' })
  await until(() => reactionsOn(chat, second).length === 2, 'the second removal')
  host.dispose()
})

test('reactions go when a turn fails, is stopped, or its messages are cleared', async () => {
  const { host, chat } = await start({ config: { busyMessages: 'queue' } })
  const failed = await chat.handled(chat.addIncoming({ text: 'try this' }))
  const { sessionId, requestId } = host.prompts[0]
  const agent = host.agents.get(sessionId)
  runTurn(host, sessionId, 1, { requestId, reason: { kind: 'error', error: { message: 'rate limited' } } })
  await until(() => reactionsOn(chat, failed).length === 2, 'the removal after a failure')
  assert.ok(texts(chat).includes('❌ rate limited'))

  const running = await chat.handled(chat.addIncoming({ text: 'long job' }))
  host.sessionEvent(sessionId, 'turn/start', { turn: 2 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: host.prompts[1].requestId } })
  agent.status = 'running'
  const cleared = await chat.handled(chat.addIncoming({ text: 'never mind' }))
  await chat.handled(chat.addIncoming({ text: '/clear' }))
  await until(() => reactionsOn(chat, cleared).length === 2, 'the removal after /clear')
  assert.deepEqual(reactionsOn(chat, running), [['⏳']])

  const waiting = await chat.handled(chat.addIncoming({ text: 'and this' }))
  await chat.handled(chat.addIncoming({ text: '/stop' }))
  agent.status = 'idle'
  host.sessionEvent(sessionId, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await until(() => reactionsOn(chat, running).length === 2 && reactionsOn(chat, waiting).length === 2, 'the removal after /stop')
  host.dispose()
})

test('reactions left by an earlier run are removed at start when their session is idle', async () => {
  const { openState } = await import('../src/state.js')
  const before = await openState()
  await before.noteReaction(9001, 10)
  const { host, chat } = await start({ keepState: true })
  await until(() => reactionsOn(chat, 9001).length === 1, 'the removal')
  assert.deepEqual(reactionsOn(chat, 9001), [[]])
  assert.deepEqual((await openState()).reactions(), {})
  host.dispose()
})

test('a session cannot send its answer text into its own chat, and text sent with files is not repeated', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const { sessionId, requestId } = host.prompts[0]
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  const from = { sessionId, label: `session ${sessionId}` }
  await assert.rejects(host.service().send({ to: 10, text: 'Hi there.', from }), (error) => error.retryable === false && /write the text in your answer/u.test(error.message))
  const file = join(process.env.DSH_HOME, 'note.txt')
  await (await import('node:fs/promises')).writeFile(file, 'notes')
  await host.service().send({ to: 10, text: 'Here are the notes.', files: [file], from })
  const before = chat.sent.length
  host.sessionEvent(sessionId, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Here are the notes.' }] } })
  host.sessionEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(50)
  assert.equal(chat.sent.length, before)
  assert.ok(!texts(chat).includes('✅ Done.'))
  host.dispose()
})

test('another session or a job may still send text into the chat during its turn', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const { sessionId, requestId } = host.prompts[0]
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  const result = await host.service().send({ to: 10, text: 'From elsewhere.', from: { sessionId: 'other-session' } })
  assert.equal(result.recorded, true)
  assert.equal(texts(chat).at(-1), 'From elsewhere.')
  host.dispose()
})

test('helpers of a chat turn share one status message, edited as they start and finish', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'look into it' }))
  const { sessionId, requestId } = host.prompts[0]
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  host.addChild(sessionId, 'child-a', 'Research prices')
  host.addChild(sessionId, 'child-b', 'Check stock')
  host.emit('subagent/start', { runId: 'r1', id: 'child-a', provider: 'spawn', local: true })
  host.emit('subagent/start', { runId: 'r2', id: 'child-b', provider: 'spawn', local: true })
  await until(() => texts(chat).some((text) => text.startsWith('🤖')), 'the status message', 600)
  const status = chat.sent.find((message) => message.text.startsWith('🤖'))
  assert.equal(status.text, '🤖 2 helpers working:\n⏳ Research prices (m1, <1 min)\n⏳ Check stock (m1, <1 min)')
  const edits = () => chat.calls.filter((call) => call.name === 'sendEditRequest').map((call) => [call.args[1], call.args[2]])
  host.emit('subagent/end', { runId: 'r1', id: 'child-a', stopReason: 'completed' })
  await until(() => edits().length === 1, 'the first edit', 600)
  assert.deepEqual(edits()[0], [status.id, '🤖 1 helper working:\n✓ Research prices (m1, <1 min)\n⏳ Check stock (m1, <1 min)'])
  host.emit('subagent/end', { runId: 'r2', id: 'child-b', stopReason: 'error' })
  await until(() => edits().length === 2, 'the final edit', 600)
  assert.deepEqual(edits()[1], [status.id, '🤖 2 helpers done:\n✓ Research prices (m1, <1 min)\n✗ Check stock (m1, <1 min, error)'])
  // A later helper opens a new status message; the finished one stays as it is.
  host.addChild(sessionId, 'child-c', 'Summarize')
  host.emit('subagent/start', { runId: 'r3', id: 'child-c', provider: 'spawn', local: true })
  await until(() => chat.sent.filter((message) => message.text.startsWith('🤖')).length === 2, 'a new status message', 600)
  assert.equal(edits().length, 2)
  host.dispose()
})

test('helpers of sessions not bound to a chat, or of undelivered turns, are not shown; /agents lists reports', async () => {
  const { host, chat } = await start({ config: { mirrorTurns: false } })
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const { sessionId } = host.prompts[0]
  host.addChild('session-elsewhere', 'child-x', 'Other work')
  host.emit('subagent/start', { runId: 'rx', id: 'child-x', provider: 'spawn', local: true })
  // A turn started from the Web UI, with mirroring off.
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  const child = host.addChild(sessionId, 'child-y', 'Draft reply')
  host.emit('subagent/start', { runId: 'ry', id: 'child-y', provider: 'spawn', local: true })
  await settle(1800)
  assert.ok(!texts(chat).some((text) => text.startsWith('🤖')))
  child.session.append('assistant/message', { message: { content: [{ type: 'text', text: 'Draft is **ready**.' }] } })
  await chat.handled(chat.addIncoming({ text: '/agents' }))
  await until(() => texts(chat).some((text) => text.startsWith('Helpers of this session')), 'the /agents list')
  assert.match(texts(chat).at(-1), /^Helpers of this session:\n\n1\. ✓ Draft reply · 0 min ago\nDraft is ready\.$/u)
  host.dispose()
})

test('without message edits the helper status goes out as a new message', async () => {
  const { host, chat } = await start()
  chat.handlers.sendEditRequest = async () => { throw new Error('editing is not supported') }
  await chat.handled(chat.addIncoming({ text: 'look into it' }))
  const { sessionId, requestId } = host.prompts[0]
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  host.addChild(sessionId, 'child-a', 'Research prices')
  host.emit('subagent/start', { runId: 'r1', id: 'child-a', provider: 'spawn', local: true })
  await until(() => texts(chat).some((text) => text.startsWith('🤖')), 'the status message', 600)
  host.emit('subagent/end', { runId: 'r1', id: 'child-a', stopReason: 'completed' })
  await until(() => texts(chat).includes('🤖 1 helper done:\n✓ Research prices (m1, <1 min)'), 'the status as a new message', 600)
  host.dispose()
})

test('a helper announced before its parent lists it gets its label at a later update', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'look into it' }))
  const { sessionId, requestId } = host.prompts[0]
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  const child = host.addChild(sessionId, 'child-late-1', 'Late label')
  const catalog = await host.services.subagents.listChildren(sessionId)
  host.services.subagents.listChildren = async () => []
  host.emit('subagent/start', { runId: 'r1', id: 'child-late-1', provider: 'spawn', local: true })
  await until(() => texts(chat).some((text) => text.startsWith('🤖')), 'the status message', 600)
  assert.match(texts(chat).find((text) => text.startsWith('🤖')), /⏳ helper child-la/u)
  host.services.subagents.listChildren = async () => catalog
  host.emit('subagent/end', { runId: 'r1', id: child.id, stopReason: 'completed' })
  await until(() => chat.calls.some((call) => call.name === 'sendEditRequest' && /✓ Late label/u.test(call.args[2])), 'the labelled edit', 600)
  host.dispose()
})

test('with mirroring off, a turn woken by a helper report still answers the chat that delegated', async () => {
  const { host, chat } = await start({ config: { mirrorTurns: false } })
  await chat.handled(chat.addIncoming({ text: 'delegate this' }))
  const { sessionId, requestId } = host.prompts[0]
  runTurn(host, sessionId, 1, { requestId, answer: 'Started a helper.' })
  await until(() => texts(chat).includes('Started a helper.'), 'the first answer')
  host.sessionEvent(sessionId, 'turn/start', { turn: 2 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'subagent-settled' } })
  host.sessionEvent(sessionId, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'The helper found it.' }] } })
  host.sessionEvent(sessionId, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await until(() => texts(chat).includes('The helper found it.'), 'the follow-up answer')
  host.dispose()
})
