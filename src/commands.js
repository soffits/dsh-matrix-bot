/**
 * Room commands. They follow the Telegram bot's commands; where Telegram
 * shows buttons, a command lists numbered choices and the same command with
 * the number picks one (`!model` lists providers, `!model 2` its models,
 * `!model 2 5` selects). `!` works in every Matrix client; `/` works where the
 * client sends unknown slash commands as text.
 */
import { basename } from 'node:path'
import { COMMAND_PREFIXES, MSC4332_COMMAND, MSC4391_COMMAND } from './constants.js'
import { CONTROL_HANDLERS, liveAgent, pick, sessionOf } from './controls.js'
import { controllerOf, listWorkspaces, recentAssistantTexts, sessionsInWorkspace, subagentsText } from '@soffits/dsh-channel-core'
import { clearRoomInbox, sessionTitle } from './sessions.js'
import { clip } from './text.js'
import { roomTitle } from './titles.js'

/** Prefix help shows. */
export const SIGIL = COMMAND_PREFIXES[0]

/** Commands, their help lines and argument hints, in the order help shows them. */
export const COMMANDS = [
  ['help', 'List commands'],
  ['new', 'Open a new room with a new session', 'room name'],
  ['reset', 'Start a new session in this room'],
  ['stop', 'Stop the running turn'],
  ['clear', 'Drop messages still waiting for the session'],
  ['status', 'Bot and session status'],
  ['current', "Show this room's session"],
  ['last', 'Show the latest answers', '1 to 5'],
  ['agents', "List this session's subagents and their last reports"],
  ['sessions', 'Browse workspaces and sessions, continue one here', 'numbers'],
  ['workspace', 'Start a new session in another workspace', 'number'],
  ['fork', 'Fork this session into a new room', 'room name'],
  ['rename', "Rename this room's session", 'new name'],
  ['goal', 'Set or change the goal', 'objective, edit, pause, resume or clear'],
  ['menu', 'Model, effort, access mode and context'],
  ['model', 'Choose the model', 'numbers'],
  ['effort', 'Choose the reasoning effort', 'number'],
  ['mode', 'Choose the access mode', 'number'],
  ['context', 'Context use of the session'],
  ['allow', 'Allow the waiting tool request'],
  ['deny', 'Deny the waiting tool request'],
  ['id', 'Show room, session and device ids'],
  ['ping', 'Check that the bot answers'],
  ['restart', 'Reconnect to the homeserver'],
]

const NAMES = new Set([...COMMANDS.map(([command]) => command), 'start'])

/** Workspaces and sessions listed at most. */
const LIST_LIMIT = 15

/** @returns `{ name, args }` for a known command name, or undefined. */
function known(name, args) {
  const lower = String(name ?? '').toLowerCase()
  if (!NAMES.has(lower)) return undefined
  return { name: lower === 'start' ? 'help' : lower, args: String(args ?? '').trim() }
}

/**
 * Read a command from a message: the invocation block of a client that
 * offers the command list (MSC4391, MSC4332), else `!name args` or
 * `/name args` in the text.
 * @param content - message content.
 * @returns `{ name, args }`, or undefined when the message is not a known
 *   command (a path such as `/home/...` stays an ordinary message).
 */
export function parseCommand(content) {
  const invoked = content?.[MSC4391_COMMAND]
  if (typeof invoked?.command === 'string') return known(invoked.command, invoked.arguments?.args)
  const legacy = content?.[MSC4332_COMMAND]
  if (typeof legacy?.syntax === 'string') return known(legacy.syntax.split(/\s+/u)[0], legacy.arguments?.args)
  if (content?.msgtype !== 'm.text' || typeof content.body !== 'string') return undefined
  const match = content.body.trim().match(/^([!/])([A-Za-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/u)
  if (match === null) return undefined
  return known(match[2], match[3])
}

/** @returns the help text. */
export function helpText() {
  return [
    'Write here and the session answers. Commands start with !, which works in every Matrix app (/ works too where your app sends it):',
    '',
    ...COMMANDS.map(([command, line, usage]) => `${SIGIL}${command}${usage ? ` <${usage}>` : ''} — ${line}`),
    '',
    `Each room is its own session; ${SIGIL}new opens another one in your Space.`,
  ].join('\n')
}

/** @returns a relative age, such as "5 min ago". */
function age(timestamp) {
  if (typeof timestamp !== 'number') return ''
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 60) return `${Math.max(0, minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/**
 * Run one command.
 * @param bridge - runtime handles from app.js.
 * @param from - `{ roomId, sender, eventId }`; `sender` is `{ userId, name }`.
 * @param command - `{ name, args }`.
 */
export async function runCommand(bridge, from, command) {
  const handler = HANDLERS[command.name]
  await handler(bridge, from, command.args)
}

function isRunning(agent) {
  return agent !== undefined && agent.status !== undefined && agent.status !== 'idle'
}

/** Refuse a command while the room's session runs a turn. */
async function refuseWhileRunning(bridge, roomId, what) {
  if (!isRunning(liveAgent(bridge, roomId))) return false
  await bridge.notice(roomId, `Stop the running turn first (!stop), then ${what}.`)
  return true
}

/** Start the room's next session in a directory, keeping the old one in DSH. */
async function startFresh(bridge, roomId, cwd) {
  const store = bridge.store()
  const previous = await store.release(roomId)
  const record = store.data.rooms[roomId] ?? {}
  store.data.rooms[roomId] = { ...record, cwd }
  await store.save()
  const title = previous === undefined ? undefined : await sessionTitle(bridge.ctx, previous)
  return title
}

/** Text of a goal's state. */
function goalStatus(view) {
  if (view === undefined) return '🎯 No goal is set.\n\n!goal <objective> sets one.'
  const phase = view.activation === 'armed' || view.phase !== 'active' ? view.phase : `${view.phase}, not armed`
  return `🎯 Goal (${phase}, round ${view.roundsStarted}/${view.maxGoalRounds}):\n${view.objective}\n\n!goal edit <objective> · !goal pause · !goal resume · !goal clear`
}

const HANDLERS = {
  async help(bridge, { roomId }) {
    await bridge.notice(roomId, helpText())
  },

  async ping(bridge, { roomId }) {
    await bridge.notice(roomId, 'pong')
  },

  async id(bridge, { roomId, sender }) {
    const facts = bridge.describe()
    await bridge.notice(roomId, [
      `Room: ${roomId}`,
      `You: ${sender.userId}`,
      `Bot: ${facts.userId ?? '?'} (device ${facts.deviceId ?? '?'})`,
      `Session: ${sessionOf(bridge, roomId) ?? 'none yet'}`,
    ].join('\n'))
  },

  async status(bridge, { roomId }) {
    const facts = bridge.describe()
    const agent = liveAgent(bridge, roomId)
    const sessionId = sessionOf(bridge, roomId)
    const lines = [
      `Matrix bot: ${facts.running ? 'running' : facts.state}`,
      ...(facts.running ? [
        `Account: ${facts.userId} on ${facts.homeserver}`,
        `Encryption: ${facts.encryption.verified ? 'device verified' : 'device NOT verified'}, key backup ${facts.encryption.backup ? 'on' : 'off'}`,
        `Uptime: ${Math.round(facts.uptimeSeconds / 60)} min`,
        `Allowed people: ${facts.allowedUsers}${facts.pending.length > 0 ? `, ${facts.pending.length} ignored sender(s)` : ''}`,
      ] : []),
      `Session: ${sessionId ?? 'none yet'}`,
      ...(sessionId === undefined ? [] : [`Title: ${await sessionTitle(bridge.ctx, sessionId)}`]),
      `Agent: ${isRunning(agent) ? 'running' : 'idle'}`,
    ]
    const asked = bridge.prompts.pending(roomId)
    if (asked.question) lines.push('A question is waiting for your answer.')
    if (asked.approvals > 0) lines.push(`${asked.approvals} tool request(s) wait for !allow or !deny.`)
    await bridge.notice(roomId, lines.join('\n'))
  },

  async current(bridge, { roomId }) {
    const sessionId = sessionOf(bridge, roomId)
    if (sessionId === undefined) {
      await bridge.notice(roomId, 'This room has no session yet; your next message starts one.')
      return
    }
    const record = bridge.store().room(roomId)
    await bridge.notice(roomId, `${await sessionTitle(bridge.ctx, sessionId)}\nSession: ${sessionId}\nWorkspace: ${record?.cwd ?? '?'}`)
  },

  async new(bridge, { sender }, args) {
    const name = clip(args.replace(/^["']|["']$/gu, '').trim() || 'New room', 100)
    await bridge.spaces.createRoom(sender.userId, name)
  },

  async reset(bridge, { roomId }) {
    if (await refuseWhileRunning(bridge, roomId, 'start a new session')) return
    const record = bridge.store().room(roomId)
    const previous = await startFresh(bridge, roomId, record?.cwd ?? bridge.setting('cwd', process.cwd()))
    await bridge.notice(roomId, `🆕 New session: your next message starts it.${previous === undefined ? '' : `\nThe previous session stays in DSH: ${previous}`}`)
  },

  async stop(bridge, { roomId }) {
    const agent = liveAgent(bridge, roomId)
    bridge.prompts.cancelRoom(roomId)
    if (!isRunning(agent)) {
      await bridge.notice(roomId, 'Nothing is running.')
      return
    }
    const turn = bridge.currentTurn(agent.session?.id ?? agent.id)
    if (turn !== undefined) turn.stopped = true
    try {
      agent.inbox?.clear?.()
    } catch {
      // Inbox unavailable.
    }
    try {
      agent.cancel({ kind: 'user' })
    } catch {
      // Already idle.
    }
    await bridge.notice(roomId, '⏹ Stopped.')
  },

  async clear(bridge, { roomId }) {
    const removed = clearRoomInbox(liveAgent(bridge, roomId), roomId)
    await bridge.reactions.sweep(roomId)
    await bridge.notice(roomId, removed === 0 ? '🧹 Nothing is waiting.' : `🧹 Dropped ${removed} waiting message(s).`)
  },

  async last(bridge, { roomId }, args) {
    const sessionId = sessionOf(bridge, roomId)
    if (sessionId === undefined) {
      await bridge.notice(roomId, 'This room has no session yet.')
      return
    }
    const requested = Number.parseInt(args || '1', 10)
    const limit = Number.isFinite(requested) ? Math.min(5, Math.max(1, requested)) : 1
    const texts = await recentAssistantTexts(bridge.ctx, sessionId, limit)
    if (texts.length === 0) {
      await bridge.notice(roomId, 'This session has no answers yet.')
      return
    }
    for (const [index, text] of [...texts].reverse().entries()) {
      const label = texts.length === 1 ? 'Latest answer' : `Answer ${index + 1}/${texts.length}`
      await bridge.say(roomId, `${label}:\n\n${text}`)
    }
  },

  async agents(bridge, { roomId }) {
    const sessionId = sessionOf(bridge, roomId)
    if (sessionId === undefined) {
      await bridge.notice(roomId, 'This room has no session yet.')
      return
    }
    const text = await subagentsText(bridge.ctx, sessionId)
    await bridge.notice(roomId, text ?? 'Subagents are not available in this DSH.')
  },

  async sessions(bridge, { roomId }, args) {
    const workspaces = listWorkspaces(bridge.ctx).slice(0, LIST_LIMIT)
    const [first, second] = args.split(/\s+/u).filter(Boolean)
    if (first === undefined) {
      if (workspaces.length === 0) {
        await bridge.notice(roomId, 'No workspaces are registered.')
        return
      }
      const here = bridge.store().room(roomId)?.cwd
      await bridge.notice(roomId, [
        'Workspaces:',
        ...workspaces.map((workspace, index) => `${index + 1}. ${workspace.title || basename(workspace.path)} (${workspace.path})${workspace.path === here ? ' ✅' : ''}`),
        '',
        '!sessions <n> lists the sessions of workspace n.',
      ].join('\n'))
      return
    }
    const workspace = pick(workspaces, first)
    if (workspace === undefined) {
      await bridge.notice(roomId, `No workspace ${first}; !sessions lists them.`)
      return
    }
    const records = await sessionsInWorkspace(bridge.ctx, workspace, LIST_LIMIT, bridge.signal)
    if (second === undefined) {
      const store = bridge.store()
      const lines = [`Sessions in ${workspace.title || basename(workspace.path)}:`, '0. New session']
      for (const [index, record] of records.entries()) {
        const id = record.header.id
        const boundTo = store.roomOfSession(id)
        const mark = boundTo === roomId ? ' ✅' : boundTo !== undefined ? ' 🔗' : ''
        lines.push(`${index + 1}. ${clip(await sessionTitle(bridge.ctx, id, record.header), 60)} · ${age(record.header.createdAt)}${mark}`)
      }
      lines.push('', `!sessions ${first} <n> continues session n in this room (0 starts a new one). 🔗 means another room shows it now; it moves here.`)
      await bridge.notice(roomId, lines.join('\n'))
      return
    }
    if (await refuseWhileRunning(bridge, roomId, 'switch sessions')) return
    if (second === '0' || second === 'new') {
      await startFresh(bridge, roomId, workspace.path)
      await bridge.notice(roomId, `🆕 Your next message starts a new session in ${workspace.title || basename(workspace.path)}.`)
      return
    }
    const record = pick(records, second)
    if (record === undefined) {
      await bridge.notice(roomId, `No session ${second}; !sessions ${first} lists them.`)
      return
    }
    const sessionId = record.header.id
    await bridge.store().bind(roomId, { sessionId, cwd: record.header.cwd ?? workspace.path })
    await bridge.ensureAgent(roomId)
    await bridge.notice(roomId, `✅ This room now continues: ${await sessionTitle(bridge.ctx, sessionId, record.header)}`)
  },

  async workspace(bridge, from, args) {
    if (args.length === 0) {
      await HANDLERS.sessions(bridge, from, '')
      await bridge.notice(from.roomId, '!workspace <n> starts a new session in workspace n.')
      return
    }
    await HANDLERS.sessions(bridge, from, `${args.split(/\s+/u)[0]} new`)
  },

  async fork(bridge, { roomId, sender }, args) {
    const sessionId = sessionOf(bridge, roomId)
    if (sessionId === undefined) {
      await bridge.notice(roomId, 'This room has no session to fork yet.')
      return
    }
    if (await refuseWhileRunning(bridge, roomId, 'fork')) return
    const controller = controllerOf(bridge.ctx)
    if (typeof controller?.fork !== 'function') {
      await bridge.notice(roomId, 'Forking is not available in this DSH.')
      return
    }
    const result = await controller.fork({ sessionId })
    const forkId = typeof result === 'string' ? result : result?.sessionId
    if (typeof forkId !== 'string') throw new Error('The fork returned no session id.')
    const title = clip(args.replace(/^["']|["']$/gu, '').trim() || `Fork of ${await sessionTitle(bridge.ctx, sessionId)}`, 100)
    const record = bridge.store().room(roomId)
    const forkRoom = await bridge.spaces.createRoom(sender.userId, title)
    await bridge.store().bind(forkRoom, { sessionId: forkId, cwd: record?.cwd })
    await bridge.store().describeRoom(forkRoom, { person: record?.person, roomName: title })
    await bridge.ensureAgent(forkRoom)
    await bridge.applyTitle(forkId)
    await bridge.notice(forkRoom, `🔀 This room continues a fork of "${await sessionTitle(bridge.ctx, sessionId)}". The original stays where it was.`)
    await bridge.notice(roomId, `🔀 Forked into the new room "${title}".`)
  },

  async rename(bridge, { roomId }, args) {
    const sessionId = sessionOf(bridge, roomId)
    const name = args.trim()
    if (name.length === 0 || name.length > 120) {
      await bridge.notice(roomId, 'Usage: !rename <new name> (at most 120 characters)')
      return
    }
    // The room is renamed where the bot may, and the session's title follows.
    await bridge.matrix().sendState(roomId, 'm.room.name', '', { name }).catch(() => {})
    await bridge.store().describeRoom(roomId, { roomName: name })
    if (sessionId === undefined) {
      await bridge.notice(roomId, `✏️ Room renamed to "${name}".`)
      return
    }
    const record = bridge.store().room(roomId)
    const title = roomTitle(record?.person ?? name, name)
    const service = bridge.ctx.get('sessionTitle')
    const session = (await bridge.ensureAgent(roomId)).session
    if (service !== undefined) service.rename(session, title)
    else await controllerOf(bridge.ctx)?.rename?.({ sessionId, title })
    await bridge.store().describeRoom(roomId, { placeholderTitle: title })
    await bridge.notice(roomId, `✏️ Session renamed to "${title}".`)
  },

  async goal(bridge, { roomId }, args) {
    const goals = bridge.ctx.get('goals')
    if (goals === undefined) {
      await bridge.notice(roomId, 'Goals are not available in this DSH.')
      return
    }
    const agent = await bridge.ensureAgent(roomId, { claim: true })
    const [action = ''] = args.split(/\s+/u)
    const verb = action.toLowerCase()
    let view = goals.get(agent)
    if (args.length === 0) {
      await bridge.notice(roomId, goalStatus(view))
      return
    }
    if (verb === 'clear' || verb === 'delete') {
      if (view !== undefined) goals.clear(agent, { id: view.id, revision: view.revision })
      await bridge.notice(roomId, view === undefined ? '🎯 No goal to clear.' : '🎯 Goal cleared.')
      return
    }
    if (verb === 'pause') {
      if (view === undefined) {
        await bridge.notice(roomId, '🎯 No goal to pause.')
        return
      }
      view = goals.pause(agent, { id: view.id, revision: view.revision })
      await bridge.notice(roomId, goalStatus(view))
      return
    }
    if (verb === 'resume') {
      if (view === undefined || view.phase === 'complete') {
        await bridge.notice(roomId, view === undefined ? '🎯 No goal is set.' : '🎯 The goal is already complete.')
        return
      }
      if (!(view.phase === 'active' && view.activation === 'armed')) view = goals.resume(agent, { id: view.id, revision: view.revision })
      await bridge.notice(roomId, goalStatus(view))
      return
    }
    const objective = verb === 'edit' || verb === 'set' ? args.slice(action.length).trim() : args
    if (objective.length === 0) {
      await bridge.notice(roomId, 'Usage: !goal <objective>')
      return
    }
    if (view !== undefined && view.phase !== 'complete') {
      view = goals.edit(agent, { id: view.id, revision: view.revision }, { objective })
      if (view.phase !== 'active' || view.activation !== 'armed') {
        try {
          view = goals.resume(agent, { id: view.id, revision: view.revision })
        } catch (error) {
          bridge.warn(`goal resume after edit failed: ${error?.message ?? error}`)
        }
      }
    } else {
      if (view !== undefined) goals.clear(agent, { id: view.id, revision: view.revision })
      view = goals.create(agent, { objective })
    }
    bridge.roomState(roomId).goalPhase = view.phase
    await bridge.notice(roomId, goalStatus(view))
  },

  ...CONTROL_HANDLERS,

  async allow(bridge, { roomId }) {
    const tool = bridge.prompts.settleApproval(roomId, true)
    await bridge.notice(roomId, tool === undefined ? 'No tool request is waiting.' : `✅ Allowed ${tool}.`)
  },

  async deny(bridge, { roomId }) {
    const tool = bridge.prompts.settleApproval(roomId, false)
    await bridge.notice(roomId, tool === undefined ? 'No tool request is waiting.' : `❌ Denied ${tool}.`)
  },

  async restart(bridge, { roomId }) {
    await bridge.notice(roomId, '♻️ Reconnecting to the homeserver…')
    bridge.restart('command')
  },
}

