/**
 * Turn one incoming Matrix message into a DSH prompt: its text, its media as
 * an attachment (pictures as images, voice messages transcribed), and what it
 * replies to as metadata for the message's `source.envelope`.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { transcribe, transcriptNote } from '@soffits/dsh-channel-core'
import { MAX_FILE_BYTES } from './constants.js'
import { clip } from './text.js'

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
 * What a message replies to, as `envelope.replyTo` (the shape dsh-message-context reads).
 * @param target - the replied-to event, or undefined when it could not be read.
 * @param options - `{ botId, senderId, sentRecord, names }`: the bot's user id,
 *   the replying user's id, the send record the target belongs to, and names by user id.
 * @returns `{ from, sentAt, text, details }` (fields only when known), or undefined.
 */
export function replyInfo(target, { botId, senderId, sentRecord, names = {} } = {}) {
  if (target === undefined) return undefined
  const content = target.content ?? {}
  const details = []
  let text = hasMedia(content) ? undefined : ownText(content)
  if (hasMedia(content)) details.push(`contains ${content.msgtype.slice(2)} "${content.body ?? ''}"`)
  let from
  if (target.sender === botId) {
    from = { role: 'assistant' }
    if (sentRecord !== undefined) {
      details.unshift('posted by the bot on behalf of another sender')
      if (sentRecord.job) from = { kind: 'cron-job', channel: 'cron', id: sentRecord.job, name: sentRecord.job }
      else if (sentRecord.fromSession) from = { kind: 'dsh-session', channel: 'dsh', id: sentRecord.fromSession }
      else if (sentRecord.label) from = { kind: 'external', channel: 'external', id: sentRecord.label, name: sentRecord.label }
      if (typeof sentRecord.text === 'string' && sentRecord.text.length > 0) text = sentRecord.text
    }
  } else if (target.sender === senderId) {
    from = { role: 'sender' }
  } else {
    from = { kind: 'matrix-user', channel: 'matrix', id: target.sender, ...(names[target.sender] ? { name: names[target.sender] } : {}) }
  }
  return {
    from,
    ...(typeof target.origin_server_ts === 'number' ? { sentAt: target.origin_server_ts } : {}),
    ...(text ? { text } : {}),
    ...(details.length > 0 ? { details } : {}),
  }
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
          lines.push(transcriptNote(media, { ...result, path }, 'Matrix'))
        } catch (error) {
          lines.push(transcriptNote(media, { path, error: error?.message ?? String(error) }, 'Matrix'))
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
