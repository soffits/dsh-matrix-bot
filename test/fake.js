/**
 * A fake DSH Host and a fake Delta Chat core for the bridge tests. This file
 * has no tests of its own.
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createFingerprints } from '../src/core.js'
import { vcardFingerprint } from '../src/identity.js'

export const TESTER_VCARD = readFileSync(new URL('./fixture.vcf', import.meta.url), 'utf8')
export const TESTER_FINGERPRINT = vcardFingerprint(TESTER_VCARD)

/** Wait until queued promise work has run. */
export function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until a condition holds, failing after a while.
 * @param check - returns true when done.
 * @param what - description for the failure.
 * @param attempts - checks, 10 ms apart, before giving up.
 */
export async function until(check, what = 'condition', attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return
    await settle(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A tiny event emitter shaped like the jsonrpc client's. */
function emitter() {
  const handlers = new Map()
  return {
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    off(name, handler) {
      handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler))
    },
    emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
  }
}

/**
 * Fake Delta Chat profile: chats, contacts and messages in memory; every RPC
 * call is recorded in `calls`.
 * @returns `{ dc, core, calls, sent, addIncoming }`.
 */
export function makeDeltaChat() {
  const calls = []
  const sent = []
  const messages = new Map()
  const chats = new Map([[10, { id: 10, name: 'Test Person', chatType: 'Single', isContactRequest: false, isDeviceChat: false, contacts: [11] }]])
  const vcards = new Map([[11, TESTER_VCARD], [12, 'BEGIN:VCARD\nEND:VCARD\n']])
  let nextId = 100
  const events = emitter()
  const handlers = {
    startIo: async () => null,
    stopIo: async () => null,
    getMessage: async (_account, id) => {
      const msg = messages.get(id)
      if (msg === undefined) throw new Error(`no message ${id}`)
      return msg
    },
    getBasicChatInfo: async (_account, id) => {
      const chat = chats.get(id)
      if (chat === undefined) throw new Error(`no chat ${id}`)
      return chat
    },
    makeVcard: async (_account, [contactId]) => vcards.get(contactId) ?? '',
    sendMsg: async (_account, chatId, data) => {
      const id = nextId++
      sent.push({ id, chatId, ...data })
      messages.set(id, { id, chatId, fromId: 1, text: data.text ?? '', viewType: 'Text', isInfo: false, downloadState: 'Done' })
      return id
    },
    sendReaction: async () => 1,
    getFreshMsgs: async () => [],
    getConfig: async () => 'bot@relay.example',
    getChatSecurejoinQrCode: async () => 'https://i.delta.chat/#INVITE',
    createQrSvg: async () => '<svg/>',
    listTransports: async () => [{ addr: 'bot@relay.example' }, { addr: 'bot@other.example' }],
    getConnectivity: async () => 4000,
    createGroupChat: async (_account, name) => {
      const id = nextId++
      chats.set(id, { id, name, chatType: 'Group', isContactRequest: false, isDeviceChat: false, contacts: [] })
      return id
    },
    getChatContacts: async (_account, chatId) => [1, ...(chats.get(chatId)?.contacts ?? [])],
    addContactToChat: async (_account, chatId, contactId) => {
      chats.get(chatId).contacts.push(contactId)
      return null
    },
    getContact: async (_account, id) => ({ id, displayName: 'Test Person', address: 'tester@example.org' }),
  }
  const rpc = new Proxy({}, {
    get(_target, name) {
      return async (...args) => {
        calls.push({ name, args })
        const handler = handlers[name]
        return handler === undefined ? null : handler(...args)
      }
    },
  })
  const dc = { rpc, ...events }
  const core = {
    startServer: async () => ({ dc, close: () => calls.push({ name: 'close', args: [] }), exited: new Promise(() => {}) }),
    ensureAccount: async () => 1,
    createFingerprints,
    startWatchdog: () => () => {},
    writeInvite: async () => ({ link: 'https://i.delta.chat/#INVITE', svgPath: '/tmp/invite.svg' }),
  }
  /** Put an incoming message in the profile and announce it. */
  function addIncoming(message) {
    const id = message.id ?? nextId++
    const msg = { id, chatId: 10, fromId: 11, text: '', viewType: 'Text', isInfo: false, isForwarded: false, downloadState: 'Done', quote: null, file: null, sender: { displayName: 'Test Person', address: 'tester@example.org' }, ...message }
    messages.set(id, msg)
    events.emit('IncomingMsg', 1, { kind: 'IncomingMsg', chatId: msg.chatId, msgId: id })
    return id
  }
  /** Wait until the bridge marked a message seen (or, for a stranger, its chat noticed). */
  async function handled(id) {
    await until(() => calls.some((call) => (call.name === 'markseenMsgs' && call.args[1].includes(id)) || (call.name === 'marknoticedChat' && call.args[1] === messages.get(id)?.chatId)), `message ${id}`)
    await settle(5)
    return id
  }
  return { dc, core, calls, sent, chats, messages, handlers, addIncoming, handled, emit: events.emit }
}

/**
 * Fake agent with an inbox, a session log and the methods the bridge calls.
 * @param sessionId - session id.
 * @param cwd - working directory.
 */
export function makeAgent(sessionId, cwd) {
  const events = []
  const handlers = new Map()
  const agent = {
    id: sessionId,
    status: 'idle',
    received: [],
    steered: [],
    cancelled: 0,
    session: {
      id: sessionId,
      header: { cwd },
      snapshotEvents: () => events,
      append: (type, data) => events.push({ type, data }),
    },
    inbox: {
      nextStep: [],
      nextTurn: [],
      remove(id) {
        this.nextStep = this.nextStep.filter((message) => message.id !== id)
        this.nextTurn = this.nextTurn.filter((message) => message.id !== id)
      },
      clear() {
        this.nextStep = []
        this.nextTurn = []
      },
    },
    followup(message) {
      agent.received.push(message)
    },
    steer(message) {
      agent.steered.push(message)
    },
    inject(message) {
      events.push({ type: 'user/message', data: message })
    },
    cancel() {
      agent.cancelled += 1
    },
    whenIdle: async () => {},
    ctx: {
      on(name, handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])
        return () => {}
      },
    },
    handlers,
    model: {
      selection: undefined,
      current: () => agent.model.selection ?? { provider: 'p1', model: 'm1' },
      select: (selection) => { agent.model.selection = selection },
    },
  }
  return agent
}

/**
 * Fake Host context with the services the bridge uses.
 * @param options - `{ config }`: plain config values.
 * @returns `{ ctx, config, agents, prompts, logs, sessionEvent, service, dispose }`.
 */
export function makeHost({ config = {} } = {}) {
  const agents = new Map()
  const prompts = []
  const logs = []
  const listeners = new Map()
  const disposers = []
  const provided = new Map()
  const selected = []
  const controller = {
    async create({ cwd }) {
      const sessionId = `session-${randomUUID().slice(0, 8)}`
      agents.set(sessionId, makeAgent(sessionId, cwd))
      return { sessionId }
    },
    async resolveAgent(sessionId) {
      const agent = agents.get(sessionId)
      return agent === undefined ? { error: new Error('not found') } : { agent }
    },
    async prompt(request) {
      prompts.push(request)
      // A prompt to a running session waits in its inbox until the agent takes it.
      const agent = agents.get(request.sessionId)
      if (agent !== undefined && agent.status !== 'idle') {
        agent.inbox[request.mode === 'steer' ? 'nextStep' : 'nextTurn'].push({ id: randomUUID(), role: 'user', content: request.content, source: { kind: 'user', rpcId: request.requestId } })
      }
      return { accepted: true }
    },
    async fork({ sessionId }) {
      const forkId = `${sessionId}-fork`
      agents.set(forkId, makeAgent(forkId, agents.get(sessionId).session.header.cwd))
      return { sessionId: forkId }
    },
    async selectModel(request) {
      selected.push(request)
      agents.get(request.sessionId).model.select(request)
      return request
    },
    async modelCatalog() {
      return {
        groups: [
          { id: 'p1', name: 'Provider One', models: [{ id: 'm1', name: 'Model One', reasoning: { defaultEffort: 'medium', efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] } }] },
          { id: 'p2', name: 'Provider Two', models: [{ id: 'm2', name: 'Model Two' }, { id: 'm3', name: 'Model Three' }] },
        ],
        failures: [],
      }
    },
    async rename() {},
  }
  /** Helper catalogs by parent session id. */
  const children = new Map()
  const titleOf = (session) => session.snapshotEvents().filter((event) => event.type === 'session/title').at(-1)?.data
  const services = {
    agents: { get: (id) => agents.get(id) },
    sessionTitle: {
      get: titleOf,
      rename: (session, title) => session.append('session/title', { title, source: { kind: 'user' }, messageSeqs: [] }),
      refresh: async (session) => session.append('session/title', { title: '[Delta Chat message from Tester', source: { kind: 'fallback' }, messageSeqs: [1] }),
    },
    sessionController: controller,
    subagents: { listChildren: async (parentId) => children.get(parentId) ?? [] },
    sessionQuery: { readSurface: async (sessionId) => ({ events: agents.get(sessionId)?.session.snapshotEvents() ?? [] }) },
    attachments: {
      saveImage: async ({ name }) => ({ id: `img-${name}` }),
      saveFile: async ({ name }) => ({ id: `file-${name}` }),
    },
    workspaceRegistry: {
      list: () => [{ id: 'w1', path: '/work/one', title: 'one', sessionIds: [], attachSession: async () => {} }, { id: 'w2', path: '/work/two', title: 'two', sessionIds: [], attachSession: async () => {} }],
      archivedSessionIds: [],
      create: async (path) => ({ path, attachSession: async () => {} }),
    },
  }
  const ctx = {
    get: (name) => provided.get(name) ?? services[name],
    on(name, handler) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler])
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    provide: (name, value) => provided.set(name, value),
    logger: () => ({ info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) }),
  }
  const liveConfig = Object.fromEntries(Object.entries({
    enabled: true,
    displayName: 'Bot',
    avatar: '',
    relays: ['relay.example'],
    allowedUsers: [{ fingerprint: TESTER_FINGERPRINT, name: 'Tester' }],
    cwd: '/work/one',
    agentPreset: '',
    mirrorTurns: true,
    busyMessages: 'steer',
    transcriber: 'off',
    ...config,
  }).map(([key, value]) => [key, { value, get() { return this.value } }]))
  return {
    ctx,
    config: liveConfig,
    agents,
    prompts,
    selected,
    logs,
    services,
    service: () => provided.get('deltachatChats'),
    /** Deliver a Host event, such as `subagent/start`, to the bridge's listeners. */
    emit(name, data) {
      for (const handler of listeners.get(name) ?? []) handler(data)
    },
    /** Make a helper session under a parent, listed in the parent's catalog. */
    addChild(parentId, childId, label) {
      const child = makeAgent(childId, '/work/one')
      child.session.header.parentSession = parentId
      agents.set(childId, child)
      children.set(parentId, [...(children.get(parentId) ?? []), { id: childId, mode: 'continuable', label, createdAt: Date.now() }])
      return child
    },
    /** Deliver a session event to the bridge's global listener. */
    sessionEvent(sessionId, type, data) {
      for (const handler of listeners.get('session/event') ?? []) handler({ id: sessionId }, { type, data })
    },
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}
