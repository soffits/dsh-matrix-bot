/**
 * Turn one incoming Matrix message into a DSH prompt: its text, its media as
 * an attachment (pictures as images, voice messages transcribed), and the
 * context the sender notice carries (what it replies to).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { MAX_FILE_BYTES } from './constants.js'
import { clip } from './text.js'
import { transcribe, transcriptNote } from './voice.js'

/** Longest replied-to text passed to the agent. */
const QUOTE_LIMIT = 2000
/** Longest text of a message sent on someone's behalf passed to the agent. */
const SENT_TEXT_LIMIT = 8000
/** Image types the DSH attachment store takes as pictures. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
/** Message types that carry media. */
const MEDIA_TYPES = new Set(['m.image', 'm.file', 'm.audio', 'm.video'])

/** @returns the event a message replies to, or undefined. */
export function replyTargetOf(content) {
  const id = content?.['m.relates_to']?.['m.in_reply_to']?.event_id
  return typeof id === 'string' ? id : undefined
}

/**
 * A message's own text: the body without the quoted fallback older clients
 * put before a reply.
 * @param content - message content.
 */
export function ownText(content) {
  let body = String(content?.body ?? '')
  if (replyTargetOf(content) !== undefined && body.startsWith('> ')) {
    const lines = body.split('\n')
    let index = 0
    while (index < lines.length && lines[index].startsWith('>')) index += 1
    body = lines.slice(index).join('\n')
  }
  return body.trim()
}

/** @returns whether a message carries media. */
export function hasMedia(content) {
  return MEDIA_TYPES.has(content?.msgtype)
}

/**
 * Describe what a message replies to.
 * @param target - the replied-to event, or undefined when it could not be read.
 * @param options - `{ botId, sentRecord, names }`: the bot's user id, the send
 *   record the target belongs to, and names by user id.
 * @returns a context block, or undefined.
 */
export function describeReply(target, { botId, sentRecord, names = {} } = {}) {
  if (target === undefined) return undefined
  const content = target.content ?? {}
  const text = clip(hasMedia(content) ? `[${content.msgtype.slice(2)} "${content.body ?? ''}"]` : ownText(content), QUOTE_LIMIT)
  if (target.sender === botId) {
    if (sentRecord !== undefined) {
      const by = sentRecord.job ? `job "${sentRecord.job}"` : sentRecord.fromSession ? `session ${sentRecord.fromSession}` : sentRecord.label || 'another sender'
      const full = typeof sentRecord.text === 'string' && sentRecord.text.length > 0 ? clip(sentRecord.text, SENT_TEXT_LIMIT) : text
      return `[Replying to a message ${by} sent here:]\n${full}`
    }
    return `[Replying to your earlier message:]\n${text}`
  }
  return `[Replying to ${names[target.sender] || target.sender}:]\n${text}`
}

/** @returns a safe file name for a download. */
function fileNameOf(content, eventId) {
  const given = String(content.filename ?? content.body ?? '').split('/').pop().replace(/[^\p{L}\p{N}._ -]/gu, '_').trim()
  if (given.length > 0 && given.length <= 120) return given
  const extension = extname(given) || ''
  return `${eventId.replace(/[^A-Za-z0-9]/gu, '').slice(0, 24)}${extension}`
}

/**
 * Build the prompt for one message.
 * @param event - the decrypted Matrix event.
 * @param options - `{ download, mediaDir, attachments, voice, signal, warn }`:
 *   `download(content)` gives the media bytes; `mediaDir` where they are kept;
 *   `attachments` the DSH attachment store; `voice` `{ mode, language, command, ffmpeg, speech }`.
 * @returns `{ text, attachments }`.
 */
export async function composePrompt(event, options) {
  const { download, mediaDir, attachments: store, voice, signal, warn } = options
  const content = event.content ?? {}
  const lines = []
  const blocks = []
  if (hasMedia(content)) {
    const name = fileNameOf(content, event.event_id)
    const size = Number(content.info?.size ?? 0)
    if (size > MAX_FILE_BYTES) {
      lines.push(`[File "${name}" (${size} bytes) is too large to fetch]`)
    } else {
      const data = await download(content)
      const dir = join(mediaDir, event.event_id.replace(/[^A-Za-z0-9]/gu, '').slice(0, 40))
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, name)
      await writeFile(path, data, { mode: 0o600 })
      const voiceMessage = content['org.matrix.msc3245.voice'] !== undefined
      if (content.msgtype === 'm.audio' && voice.mode !== 'off') {
        const media = { kind: voiceMessage ? 'voice message' : 'audio file', name, seconds: content.info?.duration > 0 ? Math.round(content.info.duration / 1000) : undefined }
        try {
          const result = await transcribe({ ...voice, path, signal })
          lines.push(transcriptNote(media, { ...result, path }))
        } catch (error) {
          lines.push(transcriptNote(media, { path, error: error?.message ?? String(error) }))
        }
      } else {
        lines.push(`[${content.msgtype === 'm.image' ? 'Picture' : 'File'} "${name}", saved at ${path}]`)
      }
      if (store !== undefined) {
        try {
          const mediaType = String(content.info?.mimetype ?? '').toLowerCase()
          let block
          if (IMAGE_TYPES.has(mediaType)) {
            try {
              block = { type: 'image', attachment: await store.saveImage({ data, mediaType, name }) }
            } catch (error) {
              warn?.(`${name} kept as a file, not an image: ${error?.message ?? error}`)
            }
          }
          block ??= { type: 'file', attachment: await store.saveFile({ data, name }) }
          blocks.push(block)
        } catch (error) {
          warn?.(`${name} not attached: ${error?.message ?? error}`)
        }
      }
    }
    // A caption is sent as the body only when it differs from the file name.
    const caption = typeof content.filename === 'string' && content.body !== content.filename ? String(content.body ?? '').trim() : ''
    if (caption.length > 0) lines.push(caption)
  } else {
    const body = ownText(content)
    if (body.length > 0) lines.push(content.msgtype === 'm.emote' ? `* ${body}` : body)
  }
  return { text: lines.join('\n'), attachments: blocks }
}
