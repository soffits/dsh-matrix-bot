/**
 * Model-facing tool for the Matrix bot. A separate plugin entry from the
 * bot (index.js): the bot is looked up as the `matrixRooms` service at call
 * time, so reloading or restarting the bot never unregisters the tool.
 */
import z from '@deepseek-ai/schemastery'
import { SERVICE_NAME } from './src/constants.js'

export const name = 'matrix-bot-tools'
export const inject = ['tools']
export const Config = z.object({})

/** JSON Schema of the send tool's arguments. */
export const SEND_SCHEMA = {
  type: 'object',
  properties: {
    room: { type: 'string', description: 'Matrix room id (starts with !); each message from a room names it in its sender notice, and !id in the room shows it.' },
    text: { type: 'string', description: 'Message text in Markdown.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to send.' },
    reply_to: { type: 'string', description: 'Event id to reply to (or to react to, with reaction).' },
    reaction: { type: 'string', description: 'An emoji to react to reply_to with instead of sending a message.' },
  },
  required: ['room'],
  additionalProperties: false,
}

/**
 * The send tool.
 * @param getService - returns the running bot's service, or undefined.
 * @returns a tool definition.
 */
export function createSendTool(getService) {
  return {
    name: 'matrix_send',
    description: 'Send a message, files or a reaction into a Matrix room of the DSH Matrix bot, addressed by its room id. Not for answering in the room this session is bound to: the final answer of the turn is delivered there by itself, so text-only sends into that room are refused. Use it to reach another room, to send files, or to react to a message. The message is also recorded in the session bound to that room; no turn is started.',
    parameters: SEND_SCHEMA,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const service = getService()
      if (service === undefined) return { code: 'unavailable', message: 'The Matrix bot is not running.' }
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
      try {
        return await service.send({
          to: args?.room,
          text: typeof args?.text === 'string' ? args.text : '',
          files: Array.isArray(args?.files) ? args.files : [],
          ...(args?.reply_to === undefined ? {} : { replyTo: args.reply_to }),
          ...(typeof args?.reaction === 'string' ? { reaction: args.reaction } : {}),
          from: typeof sessionId === 'string' ? { sessionId, label: `session ${sessionId}` } : undefined,
        })
      } catch (error) {
        return { code: 'failed', message: error?.message ?? String(error) }
      }
    },
  }
}

export function apply(ctx) {
  ctx.tools.register(createSendTool(() => ctx.get(SERVICE_NAME)))
}
