// The shelf, pure: which files count as made things, where a call says it wrote one, and
// how a search over the shelf reads.

import type { ShelfItem, ShelfKind } from '../types'

const KINDS: Record<ShelfKind, string[]> = {
  data: ['csv', 'tsv', 'xlsx', 'xls', 'ods', 'parquet', 'sqlite', 'db', 'ndjson', 'jsonl', 'har'],
  document: ['pdf', 'html', 'htm', 'docx', 'pptx', 'odt', 'epub', 'rtf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'heic', 'tiff', 'bmp', 'ico'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'],
  patch: ['patch', 'diff'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'dmg', 'whl', 'jar'],
}

export const KIND_LABEL: Record<ShelfKind, string> = { data: 'データ', document: '文書', image: '画像', video: '動画', audio: '音声', patch: 'パッチ', archive: 'アーカイブ' }
export const KIND_ICON: Record<ShelfKind, string> = { data: '▦', document: '▤', image: '▣', video: '▶', audio: '♪', patch: '±', archive: '▧' }

const BY_EXT = new Map<string, ShelfKind>(Object.entries(KINDS).flatMap(([kind, exts]) => exts.map(ext => [ext, kind as ShelfKind] as const)))

export function kindOf(path: string): ShelfKind | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? undefined : BY_EXT.get(name.slice(dot + 1))
}

const unquote = (word: string) => word.replace(/^['"]|['"]$/g, '')
const words = (part: string) => (part.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(unquote)

/**
 * Paths a Bash command may have written: `-o x`, `--output x`, `> x`, `tee x`, the last word
 * of a converter (`ffmpeg … out.mp4`), an archive's name (`zip x.zip`, `tar -czf x.tgz`).
 * Candidates only: each is checked on disk before it goes on the shelf.
 */
export function commandOutputs(command: string): string[] {
  const out = new Set<string>()
  for (const part of command.split(/&&|\|\||\||;|\n/)) {
    for (const m of part.matchAll(/(?:^|\s)(?:>>?|&>)\s*('[^']*'|"[^"]*"|[^\s|;&<>]+)/g)) out.add(unquote(m[1] as string))
    const list = words(part.replace(/(?:>>?|&>)\s*\S+/g, ''))
    list.forEach((word, i) => {
      const next = list[i + 1]
      if (next !== undefined && /^(?:-o|--output|--out|-O|--outfile|--out-file|--output-file|--save|-f)$/.test(word)) out.add(next)
      const eq = word.match(/^--(?:output|out|outfile|out-file|output-file|save)=(.+)$/)
      if (eq?.[1] !== undefined) out.add(eq[1])
    })
    const program = (list[0] ?? '').replace(/^.*\//, '')
    // `tar -czf x.tgz`, `tar cf x.tar`: the archive follows the bundled flags that end in f.
    if (program === 'tar') {
      const at = list.findIndex((word, i) => i > 0 && /^-?[A-Za-z]*c[A-Za-z]*f$/.test(word))
      if (at > 0 && list[at + 1] !== undefined) out.add(list[at + 1] as string)
    }
    if (program === 'tee') list.slice(1).filter(word => !word.startsWith('-')).forEach(word => out.add(word))
    if (['ffmpeg', 'convert', 'magick', 'zip', 'pandoc', 'wkhtmltopdf', 'cp', 'sips', 'qpdf', 'gs'].includes(program)) {
      const last = list.at(-1)
      if (last !== undefined && !last.startsWith('-')) out.add(last)
      if (program === 'zip' && list[1] !== undefined) out.add(list.find((w, i) => i > 0 && !w.startsWith('-')) ?? '')
    }
  }
  return [...out].filter(path => path !== '' && !path.includes('$') && !path.startsWith('/dev/') && kindOf(path) !== undefined)
}

/** Paths a tool's answer names that look like made things (`Saved to /tmp/out.pdf`). */
export function textOutputs(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.slice(0, 20_000).matchAll(/(?:^|[\s'"(`:=])((?:\/|~\/|\.{1,2}\/)[^\s'"()`<>|]+\.[A-Za-z0-9]{2,7})(?=$|[\s'"()`.,;:!?<>])/gm)) {
    const path = m[1] as string
    if (kindOf(path) !== undefined) out.add(path)
  }
  return [...out]
}

/** A path as an absolute one, against the folder the command ran in. */
export function absolute(path: string, cwd: string, home: string | undefined): string {
  const full = path.startsWith('/') ? path : path.startsWith('~/') && home !== undefined ? `${home}${path.slice(1)}` : `${cwd.replace(/\/+$/, '')}/${path}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

const KIND_WORDS = new Map<string, ShelfKind>([
  ...Object.entries(KIND_LABEL).map(([kind, label]) => [label, kind as ShelfKind] as const),
  ...Object.keys(KIND_LABEL).map(kind => [kind, kind as ShelfKind] as const),
])

const DAY = 24 * 60 * 60 * 1000

/**
 * The items a search matches: each word must match. A kind word (`動画`, `video`), an
 * extension (`csv`), a time word (`今日`/`today`, `昨日`/`yesterday`, `7d`), or text found in
 * the path, the purpose or the event.
 */
export function search(items: readonly ShelfItem[], query: string, now: number): ShelfItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  // Days as the person's clock counts them: local midnight, not UTC's, and a DST day as long as it is.
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const startOfToday = midnight.getTime()
  midnight.setDate(midnight.getDate() - 1)
  const startOfYesterday = midnight.getTime()
  return items.filter(item =>
    terms.every(term => {
      if (term === 'today' || term === '今日') return item.at >= startOfToday
      if (term === 'yesterday' || term === '昨日') return item.at >= startOfYesterday && item.at < startOfToday
      const days = term.match(/^(\d+)d$/)
      if (days?.[1] !== undefined) return item.at >= now - Number(days[1]) * DAY
      const kind = KIND_WORDS.get(term)
      if (kind !== undefined) return item.kind === kind
      const text = `${item.path}\n${item.purpose}\n${item.event}`.toLowerCase()
      if (BY_EXT.has(term)) return item.path.toLowerCase().endsWith(`.${term}`) || text.includes(term)
      return text.includes(term)
    }),
  )
}

export const size = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(1)}GB` : bytes >= 1024 * 1024 ? `${(bytes / 1024 ** 2).toFixed(1)}MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'たった今'
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}時間前` : `${Math.floor(hours / 24)}日前`
}

/** Adds made things to a shelf: a path made again replaces its older entry. */
export function shelve(shelf: readonly ShelfItem[], fresh: readonly ShelfItem[], max: number): ShelfItem[] {
  const paths = new Set(fresh.map(one => one.path))
  return [...fresh, ...shelf.filter(one => !paths.has(one.path))].slice(0, max)
}
