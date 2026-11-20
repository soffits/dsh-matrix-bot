/**
 * A fake DSH Host and a fake Matrix connection for the bridge tests. This
 * file has no tests of its own.
 */
import { randomUUID } from 'node:crypto'
import { followupThroughGate, makeAgentModel, makeTitleService } from '@soffits/dsh-channel-core/testing'

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

/** The bot's and the tester's made-up Matrix ids. */
export const BOT = '@bot:hs.example'
export const TESTER = '@tester:hs.example'
export const OTHER = '@other:hs.example'
export const STRANGER = '@stranger:elsewhere.example'

/**
 * Fake Matrix connection: rooms, state and events in memory; what the bot
 * sends is recorded.
 * @returns `{ matrix, connect, sent, state, created, joined, left, receipts, typing, redactions, deliver, message, invite }`.
 */
export function makeMatrix() {
  const sent = []
  const state = new Map()
  const events = new Map()
  const created = []
  const joined = new Set()
  const left = []
  const invited = []
  const receipts = []
  const typing = []
  const redactions = []
  const failJoin = new Set()
  let handlers
  let next = 1
  const key = (roomId, type, stateKey) => `${roomId}\u0000${type}\u0000${stateKey}`
  function setState(roomId, type, stateKey, content) {
    state.set(key(roomId, type, stateKey), { roomId, type, stateKey, content })
  }
  const matrix = {
    userId: BOT,
    deviceId: 'BOTDEVICE',
    encryption: () => ({ verified: true, backup: true }),
    async start(given) {
      handlers = given
    },
    stop() {},
    async sendEvent(roomId, type, content) {
      const eventId = `$bot${next++}`
      const event = { event_id: eventId, room_id: roomId, sender: BOT, type, content, origin_server_ts: Date.now() }
      events.set(eventId, event)
      sent.push(event)
      return eventId
    },
    async sendState(roomId, type, stateKey, content) {
      setState(roomId, type, stateKey, content)
      sent.push({ room_id: roomId, type, state_key: stateKey, content })
      return `$state${next++}`
    },
    async getState(roomId, type, stateKey = '') {
      return state.get(key(roomId, type, stateKey))?.content
    },
    async roomState(roomId) {
      return [...state.values()].filter((entry) => entry.roomId === roomId).map((entry) => ({ type: entry.type, state_key: entry.stateKey, content: entry.content }))
    },
    async getEvent(_roomId, eventId) {
      const event = events.get(eventId)
      if (event === undefined) throw new Error(`no event ${eventId}`)
      return event
    },
    async redact(roomId, eventId) {
      redactions.push({ roomId, eventId })
      return `$redaction${next++}`
    },
    async setTyping(roomId, on) {
      typing.push({ roomId, on })
    },
    async readReceipt(roomId, eventId) {
      receipts.push({ roomId, eventId })
    },
    async createRoom(options) {
      const roomId = `!room${next++}:hs.example`
      created.push({ roomId, options })
      setState(roomId, 'm.room.create', '', options.creation_content ?? {})
      setState(roomId, 'm.room.power_levels', '', options.power_level_content_override ?? {})
      if (options.name) setState(roomId, 'm.room.name', '', { name: options.name })
      for (const entry of options.initial_state ?? []) setState(roomId, entry.type, entry.state_key ?? '', entry.content)
      joined.add(roomId)
      return roomId
    },
    async join(roomId) {
      if (failJoin.has(roomId)) throw new Error('M_FORBIDDEN')
      joined.add(roomId)
      return roomId
    },
    async leave(roomId) {
      left.push(roomId)
      joined.delete(roomId)
    },
    async invite(roomId, userId) {
      invited.push({ roomId, userId })
    },
    async members() {
      return []
    },
    async joinedRooms() {
      return [...joined]
    },
    async upload(_roomId, _buffer, { name }) {
      return { file: { url: `mxc://hs.example/${name}`, key: {}, iv: '', hashes: {}, v: 'v2' } }
    },
    async download() {
      return Buffer.from('media bytes')
    },
    async setProfile() {},
    async displayName() {
      return 'Bot'
    },
  }

  /** Hand an event to the bot as if it came in a sync. @returns the event id. */
  async function deliver(roomId, event) {
    const full = { event_id: `$in${next++}`, room_id: roomId, sender: TESTER, origin_server_ts: Date.now(), ...event }
    events.set(full.event_id, full)
    await handlers.onEvent(roomId, full)
    return full.event_id
  }

  /** A text message from someone (the tester by default). */
  function message(roomId, body, { sender = TESTER, extra = {} } = {}) {
    return deliver(roomId, { type: 'm.room.message', sender, content: { msgtype: 'm.text', body, ...extra } })
  }

  /** An invite to a room (a Space when `space`), as the bot sees it. */
  async function invite(roomId, sender = TESTER, { space = false, direct = false, powerLevels } = {}) {
    setState(roomId, 'm.room.create', '', space ? { type: 'm.space' } : {})
    if (powerLevels !== undefined) setState(roomId, 'm.room.power_levels', '', powerLevels)
    handlers.onInvite(roomId, { type: 'm.room.member', sender, state_key: BOT, content: { membership: 'invite', ...(direct ? { is_direct: true } : {}) } })
  }

  return {
    matrix,
    connect: async () => matrix,
    sent,
    state,
    events,
    created,
    joined,
    left,
    invited,
    receipts,
    typing,
    redactions,
    failJoin,
    setState,
    deliver,
    message,
    invite,
    handlers: () => handlers,
  }
}

/**
 * Fake agent with an inbox, a session log and the methods the bridge calls.
 * Queued messages pass the `agent/pre-step` gate as in DSH.
 * @param sessionId - session id.
 * @param cwd - working directory.
 * @param hostPreSteps - the host-wide `agent/pre-step` handlers registered now.
 */
export function makeAgent(sessionId, cwd, hostPreSteps = () => []) {
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
      nextGeneratedTitle: 'Weekend plans',
      snapshotEvents: () => events,
      append: (type, data) => events.push({ type, data, seq: events.length + 1 }),
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
      followupThroughGate(agent, message, [...(handlers.get('agent/pre-step') ?? []), ...hostPreSteps()])
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
        return () => handlers.set(name, handlers.get(name).filter((item) => item !== handler))
      },
    },
    handlers,
  }
  agent.model = makeAgentModel(agent.session, { provider: 'p1', model: 'm1' })
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
  const hostPreSteps = () => listeners.get('agent/pre-step') ?? []
  const disposers = []
  const provided = new Map()
  const selected = []
  const controller = {
    async create({ cwd }) {
      const sessionId = `session-${randomUUID().slice(0, 8)}`
      agents.set(sessionId, makeAgent(sessionId, cwd, hostPreSteps))
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
      agents.set(forkId, makeAgent(forkId, agents.get(sessionId).session.header.cwd, hostPreSteps))
      return { sessionId: forkId }
    },
    /** The Web UI's model switch, which also saves the pick as the default for new sessions. */
    async selectModel(request) {
      const { sessionId, ...selection } = request
      await services.llm.resolveCallConfig(selection)
      agents.get(sessionId).model.select(selection)
      await services.agentDefaultModel.saveSelection(selection)
      return { selected: selection }
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
  const services = {
    agents: { get: (id) => agents.get(id) },
    sessionTitle: makeTitleService(),
    sessionController: controller,
    agentDefaultModel: {
      saved: [],
      currentSelection: () => ({ provider: 'p1', model: 'm1' }),
      async saveSelection(selection) { this.saved.push(selection) },
    },
    llm: {
      /** The host's routing check, which every model switch runs first. */
      async resolveCallConfig(selection) {
        selected.push(selection)
        return {}
      },
    },
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
    homeserver: 'https://hs.example',
    userId: '@bot:hs.example',
    passwordFile: '/nonexistent/password',
    displayName: 'Bot',
    avatar: '',
    allowedUsers: [{ userId: '@tester:hs.example', name: 'Tester' }, { userId: '@other:hs.example', name: 'Other' }],
    cwd: '/work/one',
    agentPreset: '',
    mirrorTurns: true,
    busyMessages: 'steer',
    transcriber: 'off',
    streaming: true,
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
    service: () => provided.get('matrixRooms'),
    /** Deliver a Host event, such as `subagent/start`, to the bridge's listeners. */
    emit(name, data) {
      return (listeners.get(name) ?? []).map((handler) => handler(data))
    },
    /** Call the bridge's listeners of a Host event with several arguments, such as `agent/pre-step`. */
    call(name, ...args) {
      return (listeners.get(name) ?? []).map((handler) => handler(...args))
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
