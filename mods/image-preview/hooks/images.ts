// Pure helpers: finding image paths in text, sizing a thumbnail in cells, captions.

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i

// A quoted path may hold spaces: "…", '…' or `…`.
const QUOTED = /(["'`])([^"'`\n]*?\.(?:png|jpe?g|webp|gif))\1/gi
// A bare path holds none, and may end a sentence: `out/cat.png.`, `out/cat.png。`, `(out/cat.png)`.
const BARE =
  /(?:^|[\s(=:,\[「『])((?:~|\.{1,2})?\/?[^\s'"`()<>|;,\[\]「」『』。、：]*\.(?:png|jpe?g|webp|gif))(?=$|[\s'"`),;:：\].。、」』!?！？])/gim
// The token before a bare match, when it reads as the head of a path split at a
// space (`/tmp/a` before `b/x.jpg`): a path start, no file extension of its own.
const SPLIT_HEAD = /(?:^|\s)((?:~|\.{1,2})?\/[^\s'"`]*) $/
const HAS_EXTENSION = /\.\w{1,5}$/

/** Image-looking paths in a command or its output, in order, each once. */
export function findImagePaths(text: string): string[] {
  const found: { at: number; path: string }[] = []
  for (const match of text.matchAll(QUOTED)) {
    if (match[2] !== undefined) found.push({ at: match.index, path: match[2] })
  }
  // Quoted spans are blanked out, so a space inside one is never read as a split.
  const bare = text.replace(QUOTED, span => ' '.repeat(span.length))
  for (const match of bare.matchAll(BARE)) {
    let path = match[1]
    if (path === undefined) continue
    let start = match.index + match[0].length - path.length
    // An unquoted path with a space in it comes out in pieces: join them back.
    for (let head = SPLIT_HEAD.exec(bare.slice(0, start)); head?.[1] !== undefined && !HAS_EXTENSION.test(head[1]); head = SPLIT_HEAD.exec(bare.slice(0, start))) {
      path = `${head[1]} ${path}`
      start -= head[1].length + 1
    }
    found.push({ at: start, path })
  }
  const seen = new Set<string>()
  for (const one of found.sort((a, b) => a.at - b.at)) {
    if (!/^[a-z]+:\/\//i.test(one.path)) seen.add(one.path)
  }
  return [...seen]
}

/** An absolute path for `path`, `~` expanded, relative ones against `cwd`; `..` and `.` folded. */
export function absolutize(path: string, cwd: string, home: string | undefined): string | undefined {
  let full = path
  if (full === '~' || full.startsWith('~/')) {
    if (home === undefined) return undefined
    full = home + full.slice(1)
  } else if (!full.startsWith('/')) {
    full = `${cwd.replace(/\/$/, '')}/${full}`
  }
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function isPng(path: string): boolean {
  return /\.png$/i.test(path)
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Width and height from the first bytes of a PNG (signature + IHDR), base64. */
export function pngDimensions(headBase64: string): { width: number; height: number } | undefined {
  let bytes: string
  try {
    bytes = atob(headBase64.slice(0, 32))
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
 * tall as it is wide, and the Image element stretches to fill its box.
 */
export function cellBox(
  size: { width?: number; height?: number },
  maxColumns: number,
  maxRows: number,
): { columns: number; rows: number } {
  const columnsCap = clamp(maxColumns, 1, 255)
  const rowsCap = clamp(maxRows, 1, 255)
  if (size.width === undefined || size.height === undefined) {
    return { columns: Math.min(columnsCap, rowsCap * 2), rows: rowsCap }
  }
  const ratio = size.width / size.height
  const columns = rowsCap * 2 * ratio
  if (columns <= columnsCap) return { columns: clamp(columns, 1, 255), rows: rowsCap }
  return { columns: columnsCap, rows: clamp(columnsCap / (2 * ratio), 1, 255) }
}

export function caption(item: { name: string; size: number; width?: number; height?: number }): string {
  const dims = item.width !== undefined && item.height !== undefined ? ` · ${item.width}×${item.height}` : ''
  return `${item.name} · ${formatSize(item.size)}${dims}`
}
