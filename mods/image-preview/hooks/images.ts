// Pure helpers: finding image paths in text, sizing a thumbnail in cells, captions.

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i

// A quoted path may hold spaces: "…", '…' or `…`.
const QUOTED = /(["'`])([^"'`\n]*?\.(?:png|jpe?g|webp|gif))\1/gi
// A bare path holds none, and may end a sentence: `out/cat.png.`, `out/cat.png。`, `(out/cat.png)`.
// It lies inside one word: a run of characters a bare path may hold.
const WORD = /[^\s'"`()<>|;,\[\]「」『』。、：]+/g
const EXTENSION_AT = /\.(?:png|jpe?g|webp|gif)/gi
// What may follow a bare path's extension, and what may stand before the word it starts.
const AFTER = /[\s'"`),;:：\].。、」』!?！？]/
const BEFORE = /[\s(,\[「『]/
// A path that starts inside a word starts after one of these: `--out=a.png`, `x:/b.png`.
const INNER_START = /[=:]/g
// The token before a bare match, when it may be the head of a path split at a
// space (`/tmp/a` before `b/x.jpg`): a path start, no file extension of its own.
const PATH_START = /^(?:~|\.{1,2})?\//
const NOT_TOKEN = /[\s'"`]/
const HAS_EXTENSION = /\.\w{1,5}$/
// Punctuation that ends a list item or a clause: `a.png, b.png` is two paths, never one.
const SEPARATOR_END = /[,;:)\]]$/
// How far back a split path is followed: a long argument list (`ls /a /b … /x.png`) is
// not offered as one path per argument, nor one longer than a path can be.
const MAX_PIECES = 8
const MAX_PATH = 4096
// Paths read from one text: a call shows its first few images, so a listing of thousands
// (an echoed glob, `find -name '*.png'`) is read no further than its first ones.
const MAX_GROUPS = 64

const isUrl = (path: string) => /^[a-z]+:\/\//i.test(path)

/**
 * The bare image path in one word, at most one: from the word's first place a path may start
 * to its last image extension that ends a path. As the regex it replaces read it, and linear.
 */
function pathInWord(text: string, from: number, word: string): { at: number; path: string } | undefined {
  let end = -1
  let extensionAt = -1
  for (const match of word.matchAll(EXTENSION_AT)) {
    const after = from + match.index + match[0].length
    if (after === text.length || AFTER.test(text.charAt(after))) {
      end = after
      extensionAt = from + match.index
    }
  }
  if (end < 0) return undefined
  let at = from === 0 || BEFORE.test(text.charAt(from - 1)) ? from : -1
  if (at < 0) {
    INNER_START.lastIndex = 0
    const inner = INNER_START.exec(word)
    if (inner !== null) at = from + inner.index + 1
  }
  if (at < 0 || at > extensionAt) return undefined
  return { at, path: text.slice(at, end) }
}

/** The token that ends one space before `end`, when one may head a split path. */
function headBefore(text: string, end: number): string | undefined {
  if (text.charAt(end - 1) !== ' ') return undefined
  let from = end - 1
  while (from > 0 && !NOT_TOKEN.test(text.charAt(from - 1)) && end - from <= MAX_PATH) from -= 1
  if (from > 0 && !/\s/.test(text.charAt(from - 1))) return undefined
  const piece = text.slice(from, end - 1)
  return PATH_START.test(piece) ? piece : undefined
}

/**
 * Image-looking paths in a command or its output, in order, each as its candidates,
 * longest first. Text alone cannot tell `/tmp/a b/x.jpg` (one path with a space) from
 * `convert /tmp/a /tmp/b.png` (two arguments): each joined reading is offered with the
 * plain tail last, and the one that exists on disk is the path. Linear in the text: it
 * runs on every Bash result before the result goes back. The first MAX_GROUPS paths only.
 */
export function findImageCandidates(text: string): string[][] {
  const found: { at: number; candidates: string[] }[] = []
  // Distinct paths read so far, URLs aside: what the cap counts, so repeats never use it up.
  const quoted = new Set<string>()
  const tails = new Set<string>()
  for (const match of text.matchAll(QUOTED)) {
    if (match[2] === undefined) continue
    found.push({ at: match.index, candidates: [match[2]] })
    if (!isUrl(match[2])) quoted.add(match[2])
    if (quoted.size >= MAX_GROUPS) break
  }
  // Quoted spans are blanked out, so a space inside one is never read as a split.
  const bare = text.replace(QUOTED, span => ' '.repeat(span.length))
  for (const word of bare.matchAll(WORD)) {
    if (tails.size >= MAX_GROUPS) break
    const one = pathInWord(bare, word.index, word[0])
    if (one === undefined) continue
    let start = one.at
    const candidates = [one.path]
    let path = one.path
    for (let head = headBefore(bare, start); head !== undefined && candidates.length <= MAX_PIECES; head = headBefore(bare, start)) {
      if (SEPARATOR_END.test(head) || HAS_EXTENSION.test(head) || path.length + head.length + 1 > MAX_PATH) break
      path = `${head} ${path}`
      start -= head.length + 1
      candidates.unshift(path)
    }
    found.push({ at: start, candidates })
    if (!isUrl(one.path)) tails.add(one.path)
  }
  const seen = new Set<string>()
  const groups: string[][] = []
  for (const one of found.sort((a, b) => a.at - b.at)) {
    const fresh = one.candidates.filter(path => !isUrl(path) && !seen.has(path))
    if (fresh.length === 0) continue
    for (const path of fresh) seen.add(path)
    groups.push(fresh)
    if (groups.length >= MAX_GROUPS) break
  }
  return groups
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
