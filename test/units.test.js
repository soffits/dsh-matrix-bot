import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { COMMANDS, helpText, parseCommand } from '../src/commands.js'
import { composePrompt, describeReply, ownText } from '../src/inbound.js'
import { bootstrapEncryption, loadLogin, trackCalls, whileRateLimited } from '../src/matrix.js'
import { editContent, mediaKind, textContent } from '../src/outbound.js'
import { parseAnswer, questionReactions, questionText } from '../src/prompts.js'
import { childLevels, commandStates, serverOf } from '../src/spaces.js'
import { openState } from '../src/state.js'
import { clip, localImagePaths, mayBeSilent, messageAnswer, splitText, stripSilent, toHtml } from '../src/text.js'
import { eventOfRequest } from '../src/turns.js'

test('Markdown answers become Matrix HTML, with raw HTML escaped', () => {
  assert.equal(toHtml('**bold** and `code`'), '<p><strong>bold</strong> and <code>code</code></p>')
  assert.equal(toHtml('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>')
  assert.match(toHtml('```js\nlet a = 1\n```'), /<pre><code class="language-js">let a = 1\n<\/code><\/pre>/u)
  assert.match(toHtml('see https://example.org'), /<a href="https:\/\/example\.org">/u)
})

test('a text message carries its Markdown as the body and HTML as the formatted body; an edit replaces it', () => {
  assert.deepEqual(textContent('hi', { plain: true, notice: true }), { msgtype: 'm.notice', body: 'hi' })
  const reply = textContent('**x**', { replyTo: '$a' })
  assert.equal(reply.formatted_body, '<p><strong>x</strong></p>')
  assert.deepEqual(reply['m.relates_to'], { 'm.in_reply_to': { event_id: '$a' } })
  const edit = editContent('$a', 'new text')
  assert.equal(edit.body, '* new text')
  assert.equal(edit['m.new_content'].body, 'new text')
  assert.equal(edit['m.new_content']['m.relates_to'], undefined)
  assert.deepEqual(edit['m.relates_to'], { rel_type: 'm.replace', event_id: '$a' })
  assert.deepEqual(mediaKind('/tmp/a.PNG'), { mimetype: 'image/png', msgtype: 'm.image' })
  assert.deepEqual(mediaKind('/tmp/a.bin'), { mimetype: 'application/octet-stream', msgtype: 'm.file' })
})

test('answers keep only text from messages without tool calls, and the silent marker is cut', () => {
  assert.equal(messageAnswer({ content: [{ type: 'text', text: 'Looking.' }, { type: 'tool-call' }] }), '')
  assert.equal(messageAnswer({ content: [{ type: 'text', text: 'First.' }, { type: 'text', text: 'Answer.' }] }), 'Answer.')
  assert.deepEqual(stripSilent('Fine.\n[SILENT]'), { text: 'Fine.', silent: true })
  assert.deepEqual(stripSilent('[SILENT]'), { text: '', silent: true })
  assert.ok(mayBeSilent('[SIL'))
  assert.ok(!mayBeSilent('[SILENT] but more'))
  assert.ok(!mayBeSilent('Hello'))
})

test('long text is split on paragraph boundaries, and text without spaces (CJK) still splits', () => {
  assert.deepEqual(splitText(`${'a'.repeat(60)}\n\n${'b'.repeat(60)}`, 100), ['a'.repeat(60), 'b'.repeat(60)])
  assert.deepEqual(splitText('猫'.repeat(250), 100).map((part) => part.length), [100, 100, 50])
  assert.equal(clip('hello world again', 12), 'hello world…')
})

test('local images in an answer are found outside code', () => {
  assert.deepEqual(localImagePaths('![a](/tmp/a.png) `![b](/tmp/b.png)` ![c](file:///tmp/c%20d.png) ![d](https://x/d.png)\n```\n![e](/tmp/e.png)\n```'), ['/tmp/a.png', '/tmp/c d.png'])
})

test('commands take ! or /, or a client\'s invocation block; a path stays a message', () => {
  const text = (body) => ({ msgtype: 'm.text', body })
  assert.deepEqual(parseCommand(text('!model 2 3')), { name: 'model', args: '2 3' })
  assert.deepEqual(parseCommand(text('/model 2 3')), { name: 'model', args: '2 3' })
  assert.deepEqual(parseCommand(text('!start')), { name: 'help', args: '' })
  assert.deepEqual(parseCommand(text('!Goal  ship it\nnow')), { name: 'goal', args: 'ship it\nnow' })
  assert.equal(parseCommand(text('/home/me/notes.txt')), undefined)
  assert.equal(parseCommand(text('!unknown')), undefined)
  assert.equal(parseCommand(text('hello !help')), undefined)
  assert.equal(parseCommand({ msgtype: 'm.notice', body: '!help' }), undefined)
  assert.deepEqual(parseCommand({ msgtype: 'm.text', body: '!new Trip', 'org.matrix.msc4391.command': { command: 'new', arguments: { args: 'Trip' } } }), { name: 'new', args: 'Trip' })
  assert.deepEqual(parseCommand({ msgtype: 'm.text', body: '!new Trip', 'org.matrix.msc4332.command': { syntax: 'new {args}', arguments: { args: 'Trip' } } }), { name: 'new', args: 'Trip' })
  for (const [command] of COMMANDS) assert.ok(helpText().includes(`!${command}`))
})

test('the command list is published in both proposal formats', () => {
  const { msc4332, msc4391 } = commandStates([['new', 'Open a room', 'room name'], ['help', 'List commands']], '!')
  assert.equal(msc4332.sigil, '!')
  assert.deepEqual(msc4332.commands[0], {
    syntax: 'new {args}',
    arguments: [{ type: 'string', description: { 'm.text': [{ body: 'room name' }] }, variadic: true }],
    description: { 'm.text': [{ body: 'Open a room' }] },
  })
  assert.deepEqual(msc4332.commands[1], { syntax: 'help', description: { 'm.text': [{ body: 'List commands' }] } })
  assert.equal(msc4391.new.parameters[0].schema.type, 'string')
  assert.deepEqual(msc4391.help.parameters, [])
})

test('the power level a Space needs for new rooms is read from its power levels', () => {
  assert.deepEqual(childLevels({ users: { '@b:x': 50 }, state_default: 50 }, '@b:x'), { needed: 50, own: 50 })
  assert.deepEqual(childLevels({ events: { 'm.space.child': 100 }, users_default: 0 }, '@b:x'), { needed: 100, own: 0 })
  assert.deepEqual(childLevels(undefined, '@b:x'), { needed: 50, own: 0 })
  assert.equal(serverOf('@bot:matrix.example.org'), 'matrix.example.org')
})

test('question replies pick options by number or reaction, or become a free answer', () => {
  const question = { options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Maybe' }], multiSelect: false }
  assert.deepEqual(parseAnswer('2', question), { selected: ['No'], custom: undefined })
  assert.deepEqual(parseAnswer('1 3', { ...question, multiSelect: true }), { selected: ['Yes', 'Maybe'], custom: undefined })
  assert.deepEqual(parseAnswer('4', question), { selected: [], custom: '4' })
  assert.deepEqual(questionReactions(question), ['1️⃣', '2️⃣', '3️⃣'])
  assert.deepEqual(questionReactions({ ...question, multiSelect: true }), [])
  assert.deepEqual(questionReactions({ options: Array.from({ length: 11 }, (_, index) => ({ label: String(index) })) }), [])
  assert.match(questionText({ question: 'Pick?', options: question.options }, 0, 2), /1\. Yes\n2\. No\n3\. Maybe\n\nTap a number/u)
})

test('request ids name the Matrix event, even with colons in the room id', () => {
  assert.equal(eventOfRequest('matrix:!abc:hs.example:$xyz'), '$xyz')
  assert.equal(eventOfRequest('telegram:1:2'), undefined)
})

test('replies say whose message they answer, with the full text of a recorded send', () => {
  assert.equal(ownText({ body: '> <@a:x> earlier\n> more\n\nmy answer', 'm.relates_to': { 'm.in_reply_to': { event_id: '$e' } } }), 'my answer')
  assert.equal(ownText({ body: '> quoting by hand' }), '> quoting by hand')
  const mine = { sender: '@bot:x', content: { msgtype: 'm.text', body: 'short' } }
  assert.equal(describeReply(mine, { botId: '@bot:x' }), '[Replying to your earlier message:]\nshort')
  assert.equal(describeReply(mine, { botId: '@bot:x', sentRecord: { job: 'daily', text: 'the whole reminder' } }), '[Replying to a message job "daily" sent here:]\nthe whole reminder')
  assert.equal(describeReply({ sender: '@a:x', content: { msgtype: 'm.image', body: 'cat.jpg' } }, { botId: '@bot:x', names: { '@a:x': 'Alex' } }), '[Replying to Alex:]\n[image "cat.jpg"]')
})

test('a picture becomes a prompt with the file kept on disk and an image attachment', async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), 'media-'))
  const prompt = await composePrompt(
    { event_id: '$pic', content: { msgtype: 'm.image', body: 'cat.png', info: { mimetype: 'image/png', size: 11 }, file: { url: 'mxc://x/y' } } },
    { download: async () => Buffer.from('media bytes'), mediaDir, attachments: { saveImage: async ({ name }) => ({ id: `img-${name}` }), saveFile: async () => ({ id: 'file' }) }, voice: { mode: 'off' } },
  )
  const path = join(mediaDir, 'pic', 'cat.png')
  assert.equal(prompt.text, `[Picture "cat.png", saved at ${path}]`)
  assert.equal(await readFile(path, 'utf8'), 'media bytes')
  assert.deepEqual(prompt.attachments, [{ type: 'image', attachment: { id: 'img-cat.png' } }])
})

test('a voice message is transcribed and the recording attached', async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), 'media-'))
  const prompt = await composePrompt(
    { event_id: '$voice', content: { msgtype: 'm.audio', body: 'Voice message.ogg', info: { mimetype: 'audio/ogg', duration: 65_000 }, 'org.matrix.msc3245.voice': {}, url: 'mxc://x/v' } },
    { download: async () => Buffer.from('OggS'), mediaDir, attachments: { saveImage: async () => ({ id: 'img' }), saveFile: async ({ name }) => ({ id: name }) }, voice: { mode: 'command', command: ['echo', 'hello from voice'] } },
  )
  assert.match(prompt.text, /^\[Matrix voice message "Voice message\.ogg", 1:05, transcribed by the configured transcription command; .*\]\nhello from voice/u)
  assert.deepEqual(prompt.attachments, [{ type: 'file', attachment: { id: 'Voice message.ogg' } }])
})

test('state binds one room per session, finds Space owners and keeps send records', async () => {
  const store = await openState(join(await mkdtemp(join(tmpdir(), 'state-')), 'state.json'))
  await store.bind('!a:x', { sessionId: 's1', cwd: '/w' })
  await store.bind('!b:x', { sessionId: 's1', cwd: '/w' })
  assert.equal(store.roomOfSession('s1'), '!b:x')
  assert.equal(store.room('!a:x').sessionId, undefined)
  assert.equal(await store.release('!b:x'), 's1')
  await store.addSpace('@p:x', '!s1:x')
  await store.addSpace('@p:x', '!s2:x')
  assert.equal(store.ownerOfSpace('!s1:x'), '@p:x')
  assert.deepEqual(store.person('@p:x').spaces, ['!s1:x', '!s2:x'])
  await store.noteSent({ roomId: '!a:x', eventIds: ['$5', '$6'], text: 'hi', job: 'j' })
  assert.equal(store.sentRecord('$6').job, 'j')
  assert.equal(await store.notePending({ userId: '@s:y' }), true)
  assert.equal(await store.notePending({ userId: '@s:y' }), false)
  const reopened = await openState(store.path)
  assert.equal(reopened.data.pending['@s:y'].count, 2)
  assert.equal(reopened.ownerOfSpace('!s2:x'), '@p:x')
})

test('room session titles keep the Matrix-<person>-<task> form', async () => {
  const { roomTitle, syncTitle, taskOf } = await import('../src/titles.js')
  assert.equal(roomTitle('Alex', 'Plan the trip'), 'Matrix-Alex-Plan the trip')
  assert.equal(taskOf('Matrix-Alex-Plan the trip', ['Alex']), 'Plan the trip')
  const events = []
  const service = {
    get: () => events.filter((event) => event.type === 'session/title').at(-1)?.data,
    rename: (_session, title) => events.push({ type: 'session/title', data: { title, source: { kind: 'user' }, messageSeqs: [] } }),
  }
  const session = { id: 's', snapshotEvents: () => events, append: (type, data) => events.push({ type, data }) }
  const placeholder = syncTitle({ service, session, person: 'Alex', placeholder: 'Lobby', previous: undefined })
  assert.equal(placeholder, 'Matrix-Alex-Lobby')
  events.push({ type: 'session/title', data: { title: 'Printer repair', source: { kind: 'provider' }, messageSeqs: [3] } })
  syncTitle({ service, session, person: 'Alex', placeholder: 'Lobby', previous: placeholder })
  assert.equal(service.get().title, 'Matrix-Alex-Printer repair')
})

test('the crypto store closes only after the calls running in it end, and takes no new ones', async () => {
  let finish
  class Machine {
    work() { return new Promise((resolve) => { finish = resolve }) }
    count() { return 1 }
    close() {}
  }
  const machine = new Machine()
  const calls = trackCalls(machine)
  assert.equal(machine.count(), 1)
  const running = machine.work()
  let drained = false
  const drain = calls.drain().then(() => { drained = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(drained, false)
  assert.throws(() => machine.work(), /closing/u)
  finish('done')
  assert.equal(await running, 'done')
  await drain
  assert.equal(drained, true)
})

test('a stored login is reused for the account as configured, so a restart makes no new device', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'login-'))
  const passwordFile = join(dir, 'password')
  await writeFile(passwordFile, 'made-up password\n', { mode: 0o600 })
  const requests = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ user_id: '@bot:hs.example', device_id: 'DEVICE1', access_token: 'made-up-token' }), { status: 200 })
  }
  try {
    // A localpart is a valid login name; the server answers with the full user id.
    const options = { dir, homeserver: 'https://hs.example', userId: 'bot', passwordFile, deviceName: 'DSH', renew: false, info: () => {} }
    const first = await loadLogin(options)
    const second = await loadLogin(options)
    assert.equal(requests.length, 1)
    assert.equal(second.deviceId, first.deviceId)
    assert.equal(requests[0].init.redirect, 'error')
    assert.equal((await stat(join(dir, 'session.json'))).mode & 0o777, 0o600)
    // A renewed login asks for the same device.
    await loadLogin({ ...options, renew: true })
    assert.equal(requests[1].body.device_id, 'DEVICE1')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a state write that failed does not stop later ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'state-'))
  const blocker = join(dir, 'blocked')
  await writeFile(blocker, '')
  const store = await openState(join(blocker, 'state.json'))
  await assert.rejects(store.notePending({ userId: '@someone:hs.example', roomId: '!r:hs.example', kind: 'message' }))
  await rm(blocker)
  await store.notePending({ userId: '@someone:hs.example', roomId: '!r:hs.example', kind: 'message' })
  assert.equal(JSON.parse(await readFile(join(blocker, 'state.json'), 'utf8')).pending['@someone:hs.example'].count, 2)
})

test('a send the server rate limits waits the time it asks and goes out; other errors fail at once', async () => {
  const waits = []
  const sleep = async (ms) => { waits.push(ms) }
  const limited = Object.assign(new Error('Too Many Requests'), { statusCode: 429, errcode: 'M_LIMIT_EXCEEDED', retryAfterMs: 4000 })
  let calls = 0
  const result = await whileRateLimited(async () => {
    calls += 1
    if (calls < 3) throw limited
    return '$sent'
  }, { sleep })
  assert.equal(result, '$sent')
  assert.deepEqual(waits, [4000, 4000])
  await assert.rejects(whileRateLimited(async () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }) }, { sleep }), /forbidden/u)
  assert.equal(waits.length, 2)
  // A stopping connection gives up instead of waiting.
  await assert.rejects(whileRateLimited(async () => { throw limited }, { sleep, stopped: () => true }), /Too Many/u)
  assert.equal(waits.length, 2)
})

test('a new identity never overwrites a recovery key file it cannot use, and reuses one that opens the account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-'))
  const recoveryKeyFile = join(dir, 'recovery-key')
  /** A bot account with no cross-signing keys, its account data in memory. */
  const account = () => {
    const data = new Map()
    const identities = []
    return {
      data,
      identities,
      client: {
        crypto: { engine: { machine: { crossSigningStatus: async () => ({ hasMaster: false, hasSelfSigning: false, hasUserSigning: false }) } }, createIdentity: async (key) => { identities.push(key) } },
        getUserId: async () => '@bot:hs.example',
        doRequest: async () => ({ master_keys: {} }),
        setAccountData: async (type, content) => { data.set(type, content) },
        getSafeAccountData: async (type, fallback) => data.get(type) ?? fallback,
        getKeyBackupVersion: async () => ({ version: '1', algorithm: 'another.algorithm' }),
      },
    }
  }
  const warnings = []
  const options = { recoveryKeyFile, info: () => {}, warn: (line) => warnings.push(line) }

  const first = account()
  assert.equal((await bootstrapEncryption(first.client, options)).verified, true)
  const key = (await readFile(recoveryKeyFile, 'utf8')).trim()
  assert.deepEqual(first.identities, [key])

  // Setup that stopped before the identity was made: the key on disk opens the account and is used.
  first.identities.length = 0
  assert.equal((await bootstrapEncryption(first.client, options)).verified, true)
  assert.deepEqual(first.identities, [key])

  // Another account: the key on disk is not its own and stays as it is.
  const second = account()
  const result = await bootstrapEncryption(second.client, options)
  assert.equal(result.verified, false)
  assert.equal(second.data.size, 0)
  assert.deepEqual(second.identities, [])
  assert.equal((await readFile(recoveryKeyFile, 'utf8')).trim(), key)
  assert.match(warnings.at(-1), /does not open this account/u)
})
