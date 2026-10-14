// Pure helpers: reading a browser tool's call and result, sizing the picture in cells.

export const BROWSER_TOOL = /^mcp__(claude-in-chrome|Claude_Browser)__/

export function shortName(tool: string): string {
  return tool.replace(BROWSER_TOOL, '')
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The call's key input in one short line: action, coordinate, url, text or query. */
export function summarize(input: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof input.action === 'string') parts.push(input.action)
  const at = input.coordinate
  if (Array.isArray(at) && at.length === 2 && at.every(n => typeof n === 'number')) parts.push(`(${at[0]},${at[1]})`)
  if (typeof input.url === 'string') parts.push(clip(input.url, 60))
  for (const field of ['text', 'query', 'value']) {
    const value = input[field]
    if (typeof value === 'string' && value !== '') parts.push(`"${clip(value, 30)}"`)
  }
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

/** The page a result names: a `URL:` / `Title:` line, else the first http(s) address in it. */
export function pageOf(text: string): { url?: string; title?: string } {
  const url = /^\s*(?:Tab\s+)?URL\s*[:：]\s*(\S+)/im.exec(text)?.[1] ?? /\bhttps?:\/\/[^\s"'<>)\]]+/.exec(text)?.[0]
  const title = /^\s*(?:Tab\s+)?Title\s*[:：]\s*(.+)$/im.exec(text)?.[1]?.trim()
  return { ...(url !== undefined ? { url } : {}), ...(title ? { title } : {}) }
}

/** Decoded size of base64 text, in bytes. */
export function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
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
