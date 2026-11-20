/**
 * Text going between DSH and Matrix: Markdown rendered to the HTML Matrix
 * clients show, local images, splitting and previews. The answer a turn
 * leaves and the silent marker are @soffits/dsh-channel-core's.
 */
import MarkdownIt from 'markdown-it'
import { MAX_MESSAGE_TEXT } from './constants.js'

/** Raw HTML in answers is escaped: clients get only what Markdown makes. */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })

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
