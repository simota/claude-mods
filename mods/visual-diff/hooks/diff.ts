// The comparison, pure: decoding a BMP, the grid of cells that changed, the regions they
// make, and which earlier screenshot a new one is compared with.

import type { VdEdit, VdRegion, VdShot } from '../types'

export const BROWSER_TOOL = /^mcp__(?:remote-devices__)?(?:claude-in-chrome|Claude_Browser)__/

export function base64ToBytes(base64: string): Uint8Array {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i)
  return bytes
}

/** Width and height from a PNG's IHDR, base64. */
export function pngSize(base64: string): { width: number; height: number } | undefined {
  let head: Uint8Array
  try {
    head = base64ToBytes(base64.slice(0, 32))
  } catch {
    return undefined
  }
  if (head.length < 24 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) return undefined
  const u32 = (at: number) => (((head[at] ?? 0) << 24) | ((head[at + 1] ?? 0) << 16) | ((head[at + 2] ?? 0) << 8) | (head[at + 3] ?? 0)) >>> 0
  return { width: u32(16), height: u32(20) }
}

export type Pixels = { width: number; height: number; rgb: Uint8Array }

/** An uncompressed 24- or 32-bit BMP (what `sips -s format bmp` writes) as RGB rows, top first. */
export function parseBmp(bytes: Uint8Array): Pixels | undefined {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(10, true)
  const width = view.getInt32(18, true)
  const rawHeight = view.getInt32(22, true)
  const bpp = view.getUint16(28, true)
  const compression = view.getUint32(30, true)
  if (width <= 0 || rawHeight === 0 || (bpp !== 24 && bpp !== 32) || (compression !== 0 && compression !== 3)) return undefined
  const height = Math.abs(rawHeight)
  const isTopDown = rawHeight < 0
  const stride = Math.floor((bpp * width + 31) / 32) * 4
  if (offset + stride * height > bytes.length) return undefined
  const step = bpp / 8
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const row = offset + (isTopDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x += 1) {
      const at = row + x * step
      const out = (y * width + x) * 3
      rgb[out] = bytes[at + 2] ?? 0
      rgb[out + 1] = bytes[at + 1] ?? 0
      rgb[out + 2] = bytes[at] ?? 0
    }
  }
  return { width, height, rgb }
}

const PIXEL_DELTA = 24
const CELL_SHARE = 0.01

/**
 * Which cells of a `cols`-wide grid changed between two pictures of one size: a cell changed
 * when more than 1% of its pixels moved by more than 24 in a channel.
 */
export function changedCells(a: Pixels, b: Pixels, cols = 32): boolean[][] | undefined {
  if (a.width !== b.width || a.height !== b.height) return undefined
  const cell = Math.max(1, Math.ceil(a.width / cols))
  const rows = Math.ceil(a.height / cell)
  const across = Math.ceil(a.width / cell)
  const counts = Array.from({ length: rows }, () => new Array<number>(across).fill(0))
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const i = (y * a.width + x) * 3
      const d = Math.max(Math.abs((a.rgb[i] ?? 0) - (b.rgb[i] ?? 0)), Math.abs((a.rgb[i + 1] ?? 0) - (b.rgb[i + 1] ?? 0)), Math.abs((a.rgb[i + 2] ?? 0) - (b.rgb[i + 2] ?? 0)))
      if (d > PIXEL_DELTA) {
        const row = counts[Math.floor(y / cell)] as number[]
        const at = Math.floor(x / cell)
        row[at] = (row[at] ?? 0) + 1
      }
    }
  }
  return counts.map((row, r) =>
    row.map((n, c) => {
      const w = Math.min(cell, a.width - c * cell)
      const h = Math.min(cell, a.height - r * cell)
      return n / (w * h) > CELL_SHARE
    }),
  )
}

/** The changed cells grouped into rectangles (4-connected), in the original's pixels. */
export function regionsOf(cells: boolean[][], cellPx: number, limit: { width: number; height: number }): VdRegion[] {
  const seen = cells.map(row => row.map(() => false))
  const out: VdRegion[] = []
  for (let r = 0; r < cells.length; r += 1) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c += 1) {
      if (!cells[r]?.[c] || seen[r]?.[c]) continue
      let [top, left, bottom, right] = [r, c, r, c]
      const stack: [number, number][] = [[r, c]]
      ;(seen[r] as boolean[])[c] = true
      while (stack.length > 0) {
        const [y, x] = stack.pop() as [number, number]
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
        left = Math.min(left, x)
        right = Math.max(right, x)
        for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ny = y + dy
          const nx = x + dx
          if (cells[ny]?.[nx] && !seen[ny]?.[nx]) {
            ;(seen[ny] as boolean[])[nx] = true
            stack.push([ny, nx])
          }
        }
      }
      const x = Math.round(left * cellPx)
      const y = Math.round(top * cellPx)
      out.push({ x, y, width: Math.min(limit.width, Math.round((right + 1) * cellPx)) - x, height: Math.min(limit.height, Math.round((bottom + 1) * cellPx)) - y })
    }
  }
  return out.sort((a, b) => b.width * b.height - a.width * a.height)
}

export const share = (cells: boolean[][]): number => {
  const all = cells.flat()
  return all.length === 0 ? 0 : Math.round((all.filter(Boolean).length / all.length) * 1000) / 10
}

/** The grid as text, two rows of cells per line: █ both changed, ▀ top, ▄ bottom, · neither. */
export function mapLines(cells: readonly string[]): string[] {
  const lines: string[] = []
  for (let r = 0; r < cells.length; r += 2) {
    const top = cells[r] ?? ''
    const bottom = cells[r + 1] ?? ''
    let line = ''
    for (let c = 0; c < top.length; c += 1) {
      const t = top[c] === '1'
      const b = bottom[c] === '1'
      line += t && b ? '█' : t ? '▀' : b ? '▄' : '·'
    }
    lines.push(line)
  }
  return lines
}

export const keyOf = (shot: Pick<VdShot, 'url' | 'width' | 'height'>): string => `${shot.url} @${shot.width}×${shot.height}`

/**
 * The screenshot a new one is compared with: the person's baseline for that URL and size;
 * none for a shot whose URL could not be told;
 * else the latest of the same URL and size taken before an edit that came before the new
 * one; else simply the previous one of that URL and size.
 */
export function pickBefore(shots: readonly VdShot[], edits: readonly VdEdit[], latest: VdShot, baselineId?: string): VdShot | undefined {
  if (latest.url === '') return undefined
  const same = shots.filter(one => one.id !== latest.id && keyOf(one) === keyOf(latest) && one.at <= latest.at)
  const pinned = baselineId === undefined ? undefined : same.find(one => one.id === baselineId)
  if (pinned !== undefined) return pinned
  const beforeEdit = [...same].reverse().find(one => edits.some(edit => edit.at > one.at && edit.at <= latest.at))
  return beforeEdit ?? same.at(-1)
}

/** The page's URL as a navigation or a new tab said it, from the first lines of its answer. */
export function urlFrom(tool: string, input: Record<string, unknown>, text: string): string | undefined {
  if (!/^(?:navigate|tabs_create(?:_mcp)?)$/.test(tool)) return undefined
  for (const line of text.split('\n').slice(0, 3)) {
    const m = line.match(/^URL: (https?:\/\/\S+)$/)
    if (m?.[1] !== undefined) return m[1]
  }
  return typeof input.url === 'string' && /^https?:\/\//.test(input.url) ? input.url : undefined
}

// Actions after which the tab may show another page: a click can follow a link or submit a form,
// a key can press Enter, a drag can drop a link. A screenshot or a read changes nothing.
const MAY_LEAVE = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'key', 'left_click_drag'])

/** Whether a browser call may have moved the tab to another page without saying where. */
export function mayLeave(tool: string, input: Record<string, unknown>): boolean {
  if (tool === 'computer') return typeof input.action === 'string' && MAY_LEAVE.has(input.action)
  if (tool === 'navigate') return typeof input.url !== 'string' || !/^https?:\/\//.test(input.url)
  return tool === 'form_input' || tool === 'javascript_tool'
}

/**
 * The URL a tab listing gives for one tab: an object of the listing that holds that id and a
 * URL, else a line that names the id and a URL; undefined when the listing does not tie the
 * two together.
 */
export function tabUrlOf(text: string, tabId: number): string | undefined {
  const isUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//.test(value)
  const visit = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const one of value) {
        const found = visit(one)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (typeof value !== 'object' || value === null) return undefined
    const node = value as Record<string, unknown>
    if ((node.tabId === tabId || node.id === tabId) && isUrl(node.url)) return node.url
    return visit(Object.values(node))
  }
  const start = text.search(/[[{]/)
  if (start >= 0) {
    try {
      const found = visit(JSON.parse(text.slice(start)))
      if (found !== undefined) return found
    } catch {
      // Not JSON: read it line by line.
    }
  }
  const id = new RegExp(`(?<![\\d.])${tabId}(?![\\d.])`)
  for (const line of text.split('\n')) {
    const found = line.match(/https?:\/\/[^\s'"<>)\]]+/)?.[0]
    if (found !== undefined && id.test(line.replace(found, ''))) return found.replace(/[.,;]+$/, '')
  }
  return undefined
}
