// Pure helpers: finding image paths in text, sizing a thumbnail in cells, captions.

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i

const PATH_IN_TEXT = /(?:^|[\s'"`(=:,\[])((?:~|\.{1,2})?\/?[^\s'"`()<>|;,\[\]]*\.(?:png|jpe?g|webp|gif))(?=$|[\s'"`),;:\]])/gim

/** Image-looking paths in a command or its output, in order, each once. */
export function findImagePaths(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(PATH_IN_TEXT)) {
    const path = match[1]
    if (path !== undefined && !/^[a-z]+:\/\//i.test(path)) seen.add(path)
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
