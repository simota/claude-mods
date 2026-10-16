// Pure helpers: reading a browser tool's call and result, sizing the picture in cells.

import { maskedOf } from './mask'

// Claude in Chrome, the desktop app's browser, and that browser reached from a cloud session.
export const BROWSER_TOOL = /^mcp__(?:remote-devices__)?(?:claude-in-chrome|Claude_Browser)__/

export function shortName(tool: string): string {
  return tool.replace(BROWSER_TOOL, '')
}

// Marks that belong to the character before them: combining marks, variation
// selectors, the keycap mark, skin tones and tag characters.
const isExtend = (cp: number) =>
  (cp >= 0x0300 && cp <= 0x036f) ||
  (cp >= 0x1ab0 && cp <= 0x1aff) ||
  (cp >= 0x20d0 && cp <= 0x20ff) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) ||
  (cp >= 0xfe20 && cp <= 0xfe2f) ||
  (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
  (cp >= 0xe0020 && cp <= 0xe007f) ||
  (cp >= 0xe0100 && cp <= 0xe01ef)
const isRegional = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff
const ZWJ = 0x200d

/**
 * User-perceived characters where the runtime has no Intl.Segmenter: a ZWJ sequence
 * (👩‍💻), a flag (two regional indicators), a keycap or a base with its marks stays whole.
 */
export function graphemesFallback(text: string): string[] {
  const out: string[] = []
  let isAfterJoiner = false
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const prev = out.at(-1)
    const prevCp = prev?.codePointAt(0) ?? 0
    const isFlagHalf = isRegional(cp) && prev !== undefined && Array.from(prev).length === 1 && isRegional(prevCp)
    if (prev !== undefined && (isAfterJoiner || cp === ZWJ || isExtend(cp) || isFlagHalf)) out[out.length - 1] = prev + ch
    else out.push(ch)
    isAfterJoiner = cp === ZWJ
  }
  return out
}

export function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment)
  }
  return graphemesFallback(text)
}

// Cut between whole characters, so an emoji (a ZWJ sequence or a flag too) is never split.
export function clip(text: string, max: number): string {
  const flat = graphemes(text.replace(/\s+/g, ' ').trim())
  return flat.length > max ? `${flat.slice(0, max - 1).join('')}…` : flat.join('')
}

/**
 * The call's key input in one short line: action, coordinate, url, typed text or query.
 * Text typed or filled in is shown as its length only: the pane cannot tell a password field,
 * and the screenshot beside it shows such a field as dots. A URL's secrets are masked.
 */
export function summarize(input: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof input.action === 'string') parts.push(input.action)
  const at = input.coordinate
  if (Array.isArray(at) && at.length === 2 && at.every(n => typeof n === 'number')) parts.push(`(${at[0]},${at[1]})`)
  if (typeof input.url === 'string') parts.push(clip(maskedOf(input.url), 60))
  for (const field of ['text', 'value']) {
    const value = input[field]
    if (typeof value !== 'string' || value === '') continue
    // A key action's text names keys (`ctrl+a`, `Enter`), not what was typed.
    parts.push(field === 'text' && input.action === 'key' ? `"${clip(value, 30)}"` : `‹${graphemes(value).length}文字›`)
  }
  if (typeof input.query === 'string' && input.query !== '') parts.push(`"${clip(maskedOf(input.query), 30)}"`)
  return parts.join(' ')
}

type Block = Record<string, unknown>

function blocksOf(result: unknown): Block[] {
  const content = Array.isArray(result)
    ? result
    : typeof result === 'object' && result !== null && Array.isArray((result as Block).content)
      ? ((result as Block).content as unknown[])
      : []
  return content.filter((block): block is Block => typeof block === 'object' && block !== null)
}

/**
 * The last image block of a tool's result: MCP's `{ type: 'image', data, mimeType }`,
 * or the Messages API's `{ type: 'image', source: { data, media_type } }`.
 */
export function screenshotOf(result: unknown): { data: string; mime: string } | undefined {
  let found: { data: string; mime: string } | undefined
  for (const block of blocksOf(result)) {
    if (block.type !== 'image') continue
    const source = typeof block.source === 'object' && block.source !== null ? (block.source as Block) : undefined
    const data = typeof block.data === 'string' ? block.data : source?.data
    const mime = typeof block.mimeType === 'string' ? block.mimeType : source?.media_type
    if (typeof data === 'string' && data !== '') found = { data, mime: typeof mime === 'string' ? mime : 'image/png' }
  }
  return found
}

// The tools whose own answer describes the tab they act on. Every other result
// (read_page, get_page_text, find, javascript) carries page content the page controls.
const SINGLE_TAB_TOOLS = /^(?:navigate|tabs_create(?:_mcp)?)$/
const TAB_LIST_TOOLS = /^tabs_context(?:_mcp)?$/
// A single-tab answer's header: its first lines, and only exact `URL:` / `Title:` lines.
const HEADER_LINES = 3
const URL_LINE = /^URL: (https?:\/\/\S+)$/
const TITLE_LINE = /^Title: (.+)$/
// How a text listing marks the tab being driven (a `*` bullet is a plain list item, not a mark).
const ACTIVE_MARK = /^\s*[→▶]\s|\((?:active|current|selected)\)|\b(?:active|current|selected)\s*[:=]\s*true\b/i
const ACTIVE_KEYS = ['active', 'current', 'selected', 'isActive'] as const
const ITEM_START = /^\s*(?:[-*→▶]|\d+[.)])\s/

type Page = { url?: string; title?: string }

const httpUrl = (value: unknown) => (typeof value === 'string' && /^https?:\/\/\S+$/i.test(value) ? value : undefined)

function headerOf(lines: string[]): Page {
  const page: Page = {}
  for (const line of lines) {
    const url = URL_LINE.exec(line)?.[1]
    const title = TITLE_LINE.exec(line)?.[1]?.trim()
    if (url !== undefined && page.url === undefined) page.url = url
    if (title !== undefined && title !== '' && page.title === undefined) page.title = title
  }
  return page
}

function activeInJson(text: string): Page | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const tabs: unknown = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null ? (parsed as { tabs?: unknown }).tabs : undefined
  if (!Array.isArray(tabs)) return {}
  for (const tab of tabs) {
    if (typeof tab !== 'object' || tab === null) continue
    const fields = tab as Record<string, unknown>
    if (!ACTIVE_KEYS.some(key => fields[key] === true)) continue
    const url = httpUrl(fields.url)
    const title = typeof fields.title === 'string' && fields.title.trim() !== '' ? fields.title.trim() : undefined
    return { ...(url !== undefined ? { url } : {}), ...(title !== undefined ? { title } : {}) }
  }
  return {}
}

// The tab a listing marks as active, or nothing: an unmarked listing names no tab in particular.
function activeTabOf(text: string): Page {
  const fromJson = activeInJson(text)
  if (fromJson !== undefined) return fromJson
  const lines = text.split('\n')
  const at = lines.findIndex(line => ACTIVE_MARK.test(line))
  if (at < 0) return {}
  // The marked line and the lines under it, up to a blank line or the next listed tab.
  const block = [lines[at] ?? '']
  for (const line of lines.slice(at + 1, at + 4)) {
    if (line.trim() === '' || ITEM_START.test(line)) break
    block.push(line)
  }
  const bare = block.map(line =>
    line
      .replace(/^\s*(?:[-*→▶]|\d+[.)])?\s*/, '')
      .replace(/\s*\((?:active|current|selected)\)\s*$/i, ''),
  )
  return headerOf(bare)
}

/**
 * The page a call leads to: the url the call itself was given, then an exact `URL:` /
 * `Title:` line in the first lines of a single-tab tool's own answer, or the tab a
 * listing marks as active. Never page text: a page's words could otherwise name any address.
 */
export function pageFrom(tool: string, input: Record<string, unknown>, text: string): Page {
  if (TAB_LIST_TOOLS.test(tool)) return activeTabOf(text)
  if (!SINGLE_TAB_TOOLS.test(tool)) return {}
  const header = headerOf(text.split('\n').slice(0, HEADER_LINES))
  const url = header.url ?? (tool === 'navigate' ? httpUrl(input.url) : undefined)
  return { ...(url !== undefined ? { url } : {}), ...(header.title !== undefined ? { title: header.title } : {}) }
}

/** The page as it stands after a call: a new address drops the old address's title. */
export function nextPage(old: { url?: string; title?: string }, shown: { url?: string; title?: string }): { url?: string; title?: string } {
  // The page line is kept and drawn masked: a callback's token or a URL's userinfo stays out.
  const seen = shown.url === undefined ? shown : { ...shown, url: maskedOf(shown.url) }
  if (seen.url !== undefined && seen.url !== old.url) return { url: seen.url, ...(seen.title !== undefined ? { title: seen.title } : {}) }
  return { ...old, ...(seen.title !== undefined ? { title: seen.title } : {}) }
}

/** Width and height from the first bytes of a PNG (signature + IHDR), base64. */
export function pngDimensions(base64: string): { width: number; height: number } | undefined {
  let bytes: string
  try {
    bytes = atob(base64.slice(0, 32))
  } catch {
    return undefined
  }
  if (bytes.length < 24 || bytes.slice(1, 4) !== 'PNG' || bytes.slice(12, 16) !== 'IHDR') return undefined
  const u32 = (at: number) =>
    ((bytes.charCodeAt(at) << 24) | (bytes.charCodeAt(at + 1) << 16) | (bytes.charCodeAt(at + 2) << 8) | bytes.charCodeAt(at + 3)) >>> 0
  const width = u32(16)
  const height = u32(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** `pixelWidth: 640` / `pixelHeight: 480` lines of `sips -g`. */
export function sipsDimensions(stdout: string): { width: number; height: number } | undefined {
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1])
  return width > 0 && height > 0 ? { width, height } : undefined
}

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, Math.round(n)))

/**
 * The cell box a picture keeps its shape in: a terminal cell is about twice as
 * tall as it is wide, and the Image element stretches to fill its box. Width first:
 * a screenshot is wider than tall, so it takes the pane's columns.
 */
export function cellBox(
  size: { width?: number; height?: number },
  maxColumns: number,
  maxRows: number,
): { columns: number; rows: number } {
  const columnsCap = clamp(maxColumns, 1, 255)
  const rowsCap = clamp(maxRows, 1, 255)
  if (size.width === undefined || size.height === undefined) {
    return { columns: columnsCap, rows: Math.min(rowsCap, clamp(columnsCap / 3, 1, 255)) }
  }
  const ratio = size.width / size.height
  const rows = columnsCap / (2 * ratio)
  if (rows <= rowsCap) return { columns: columnsCap, rows: clamp(rows, 1, 255) }
  return { columns: clamp(rowsCap * 2 * ratio, 1, 255), rows: rowsCap }
}
