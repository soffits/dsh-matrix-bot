/** Sending into rooms: Markdown as HTML, split, edits, files, reactions and notices, in order per room. */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { MAX_FILE_BYTES } from './constants.js'
import { splitText, toHtml } from './text.js'

/** An error that a retry will not fix. */
export function finalError(message) {
  return Object.assign(new Error(message), { retryable: false })
}

/** MIME types by file extension, for what the bot sends. */
const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.zip': 'application/zip',
}

/** @returns `{ mimetype, msgtype }` of a file by its name. */
export function mediaKind(path) {
  const mimetype = MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const msgtype = mimetype.startsWith('image/') ? 'm.image' : mimetype.startsWith('audio/') ? 'm.audio' : mimetype.startsWith('video/') ? 'm.video' : 'm.file'
  return { mimetype, msgtype }
}

/**
 * The content of a text message.
 * @param text - Markdown, or plain text when `plain`.
 * @param options - `{ plain, notice, replyTo }`.
 */
export function textContent(text, { plain = false, notice = false, replyTo } = {}) {
  const content = { msgtype: notice ? 'm.notice' : 'm.text', body: text }
  if (!plain) {
    content.format = 'org.matrix.custom.html'
    content.formatted_body = toHtml(text)
  }
  if (typeof replyTo === 'string') content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo } }
  return content
}

/**
 * The content of an edit that replaces a message's text.
 * @param eventId - the message being replaced.
 * @param text - its new text.
 * @param options - as `textContent`.
 */
export function editContent(eventId, text, options = {}) {
  const fresh = textContent(text, { ...options, replyTo: undefined })
  return {
    ...fresh,
    body: `* ${fresh.body}`,
    ...(fresh.formatted_body === undefined ? {} : { formatted_body: `* ${fresh.formatted_body}` }),
    'm.new_content': fresh,
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
  }
}

/**
 * Create the sender.
 * @param deps - `{ requireMatrix, roomState, reportError, messageOf }`.
 * @returns `{ queueOut, sendText, editText, checkFiles, sendFiles, react, redact, notice }`.
 */
export function createOutbound({ requireMatrix, roomState, reportError, messageOf }) {
  /** Run output for a room in order. */
  function queueOut(roomId, task) {
    const room = roomState(roomId)
    const run = room.out.catch(() => {}).then(task)
    room.out = run.catch((error) => reportError('send', error))
    return run
  }

  /**
   * Send text into a room, split when long.
   * @param roomId - room id.
   * @param text - Markdown.
   * @param options - `{ replyTo, plain, notice }`: event to reply to with the
   *   first part; `plain` sends the text without HTML; `notice` marks it as a
   *   bot notice.
   * @returns the sent event ids.
   */
  async function sendText(roomId, text, { replyTo, plain = false, notice = false } = {}) {
    const matrix = requireMatrix()
    const ids = []
    for (const [index, part] of splitText(text).entries()) {
      ids.push(await matrix.sendEvent(roomId, 'm.room.message', textContent(part, { plain, notice, replyTo: index === 0 ? replyTo : undefined })))
    }
    return ids
  }

  /** Replace a message's text. @returns the edit's event id. */
  async function editText(roomId, eventId, text, options = {}) {
    return requireMatrix().sendEvent(roomId, 'm.room.message', editContent(eventId, text, options))
  }

  /**
   * Check files before anything is sent.
   * @param paths - absolute paths.
   * @returns `{ path, name, size }` entries; throws on the first bad one.
   */
  async function checkFiles(paths) {
    const files = []
    for (const path of paths) {
      if (!isAbsolute(path)) throw finalError(`File paths must be absolute: ${path}`)
      const info = await stat(path).catch((error) => { throw finalError(`${path}: ${messageOf(error)}`) })
      if (!info.isFile()) throw finalError(`${path} is not a file`)
      if (info.size > MAX_FILE_BYTES) throw finalError(`${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`)
      files.push({ path, name: basename(path), size: info.size })
    }
    return files
  }

  /** Upload and send checked files, encrypted in encrypted rooms. @returns the event ids. */
  async function sendFiles(roomId, files) {
    const matrix = requireMatrix()
    const ids = []
    for (const file of files) {
      const { mimetype, msgtype } = mediaKind(file.path)
      const media = await matrix.upload(roomId, await readFile(file.path), { name: file.name, mimetype })
      ids.push(await matrix.sendEvent(roomId, 'm.room.message', { msgtype, body: file.name, filename: file.name, info: { mimetype, size: file.size }, ...media }))
    }
    return ids
  }

  /** React to an event. @returns the reaction's event id. */
  async function react(roomId, eventId, key) {
    return requireMatrix().sendEvent(roomId, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } })
  }

  /** Remove one of the bot's events (a reaction, a streamed draft). */
  async function redact(roomId, eventId) {
    return requireMatrix().redact(roomId, eventId)
  }

  /** A short bot notice (plain text) into a room. @returns its event ids. */
  function notice(roomId, text) {
    return queueOut(roomId, () => sendText(roomId, text, { plain: true, notice: true }))
  }

  return { queueOut, sendText, editText, checkFiles, sendFiles, react, redact, notice }
}
