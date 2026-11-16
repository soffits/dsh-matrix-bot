/**
 * Text going between DSH and Matrix: the answer a turn leaves, Markdown
 * rendered to the HTML Matrix clients show, splitting, and the silent marker.
 */
import MarkdownIt from 'markdown-it'
import { MAX_MESSAGE_TEXT, SILENT_REPLY } from './constants.js'

/** Raw HTML in answers is escaped: clients get only what Markdown makes. */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })

/**
 * The answer one assistant message holds: the last text block of a message
 * that called no tool. Text written between tool calls is working narration,
 * not part of the answer; a message that called a tool is mid-chain.
 * @param message - an assistant message (`{ content: [...] }`).
 * @returns the answer, or '' when the message holds none.
 */
export function messageAnswer(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  if (content.some((block) => block?.type === 'tool-call')) return ''
  const texts = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
  return texts.at(-1) ?? ''
}

/**
 * Remove the silent marker from the end of an answer.
 * @param text - final answer.
 * @returns `{ text, silent }`: the rest of the text and whether the marker was there.
 */
export function stripSilent(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.endsWith(SILENT_REPLY)) return { text: trimmed, silent: false }
  return { text: trimmed.slice(0, -SILENT_REPLY.length).trim(), silent: true }
}

/**
 * Local image paths a Markdown answer shows inline (`![alt](/abs/path)` or a
 * `file://` URL), outside code. Matrix clients cannot show them inline, so they
 * are sent as files after the text.
 * @param markdown - answer text.
 * @returns absolute paths, without duplicates.
 */
export function localImagePaths(markdown) {
  const found = []
  const pattern = /!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/gu
  let fenced = false
  for (const line of String(markdown ?? '').split('\n')) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const match of line.split(/`[^`]*`/gu).join(' ').matchAll(pattern)) {
      let target = (match[1] ?? match[2]).trim()
      if (/^file:\/\//iu.test(target)) {
        try {
          target = decodeURIComponent(new URL(target).pathname)
        } catch {
          continue
        }
      }
      if (target.startsWith('/') && !found.includes(target)) found.push(target)
    }
  }
  return found
}

/**
 * Render Markdown to the HTML of a Matrix message's `formatted_body`.
 * @param text - Markdown.
 * @returns HTML.
 */
export function toHtml(text) {
  return markdown.render(String(text ?? '')).trim()
}

/**
 * Whether streamed text so far could still turn out to be only the silent
 * marker, so it is not shown yet.
 * @param text - streamed text.
 */
export function mayBeSilent(text) {
  const trimmed = String(text ?? '').trim()
  return trimmed.length === 0 || SILENT_REPLY.startsWith(trimmed)
}

/**
 * When a message was sent, for the agent: the date and time in this
 * process's time zone, with the zone's name.
 * @param timestamp - milliseconds since the epoch.
 * @returns the time as text, or undefined without a timestamp.
 */
export function formatMoment(timestamp) {
  if (!Number.isFinite(timestamp)) return undefined
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(timestamp))
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('weekday')} ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} (${zone})`
}

/**
 * Split text into messages no longer than the limit, preferring paragraph,
 * then line, then word boundaries.
 * @param text - Markdown or plain text.
 * @param limit - longest message.
 * @returns non-empty parts.
 */
export function splitText(text, limit = MAX_MESSAGE_TEXT) {
  const parts = []
  let rest = String(text ?? '').trim()
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit / 2) cut = window.lastIndexOf('\n')
    if (cut < limit / 2) cut = window.lastIndexOf(' ')
    if (cut < limit / 2) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

/**
 * Cut a preview to a length, on a word boundary when one is near.
 * @param text - any text.
 * @param max - longest result.
 * @returns the preview, with an ellipsis when cut.
 */
export function clip(text, max) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  const cut = value.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`
}
