// What one finished tool call's compact line says, from the row's own props.
// Pure: no `$`, so tests call it directly.

export const GRUVBOX = {
  red: '#fb4934',
  green: '#b8bb26',
  yellow: '#fabd2f',
  blue: '#83a598',
  purple: '#d3869b',
  aqua: '#8ec07c',
  orange: '#fe8019',
  gray: '#a89984',
} as const

export const ICONS = {
  edit: '',
  write: '',
  notebook: '',
  read: '',
  bash: '',
  search: '',
  agent: '\u{f06a9}',
  web: '',
  mcp: '\u{f0493}',
} as const

export type Stat = { text: string; color: string }

export type Summary = {
  icon: string
  color: string
  label: string
  stats: Stat[]
}

export type RowFacts = {
  tool: string
  input: unknown
  output: unknown
  isErrored: boolean
}

const COMMAND_CHARS = 60

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function text(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === 'string' && found.length > 0 ? found : undefined
}

function lineCount(value: string): number {
  return value === '' ? 0 : value.replace(/\n$/, '').split('\n').length
}

// Lines added and removed, from a structuredPatch's hunks when the result has one.
function patchCounts(output: unknown): { added: number; removed: number } | undefined {
  const hunks = field(output, 'structuredPatch')
  if (!Array.isArray(hunks)) return undefined
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    const lines = field(hunk, 'lines')
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

function diffStats(counts: { added: number; removed: number }): Stat[] {
  return [
    { text: `+${counts.added}`, color: GRUVBOX.green },
    { text: `−${counts.removed}`, color: GRUVBOX.red },
  ]
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
function firstLine(command: string): string {
  const [head = '', ...rest] = command.trim().split('\n')
  const line = graphemes(rest.length > 0 ? `${head} …` : head)
  return line.length > COMMAND_CHARS ? `${line.slice(0, COMMAND_CHARS - 1).join('')}…` : line.join('')
}

function host(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

// The compact line for a call, or undefined where the engine's own row should stand.
export function summarize(facts: RowFacts): Summary | undefined {
  const { tool, input, output, isErrored } = facts
  const tint = (color: string) => (isErrored ? GRUVBOX.red : color)

  if (tool === 'Edit') {
    const path = text(input, 'file_path')
    if (path === undefined) return undefined
    const counts = isErrored ? undefined : patchCounts(output) ?? {
      added: lineCount(text(input, 'new_string') ?? ''),
      removed: lineCount(text(input, 'old_string') ?? ''),
    }
    return { icon: ICONS.edit, color: tint(GRUVBOX.yellow), label: path, stats: counts ? diffStats(counts) : [] }
  }

  if (tool === 'Write') {
    const path = text(input, 'file_path')
    if (path === undefined) return undefined
    // A new file's result may carry no hunks: its lines are the content's.
    const counts = patchCounts(output)
    const stats = isErrored
      ? []
      : counts && counts.added + counts.removed > 0
        ? diffStats(counts)
        : [{ text: `+${lineCount(text(input, 'content') ?? '')}`, color: GRUVBOX.green }]
    return { icon: ICONS.write, color: tint(GRUVBOX.yellow), label: path, stats }
  }

  if (tool === 'NotebookEdit') {
    const path = text(input, 'notebook_path')
    if (path === undefined) return undefined
    return { icon: ICONS.notebook, color: tint(GRUVBOX.yellow), label: path, stats: [] }
  }

  if (tool === 'Read') {
    const path = text(input, 'file_path')
    if (path === undefined) return undefined
    const lines = field(field(output, 'file'), 'numLines')
    const stats = !isErrored && typeof lines === 'number' ? [{ text: `(${lines}行)`, color: GRUVBOX.gray }] : []
    return { icon: ICONS.read, color: tint(GRUVBOX.blue), label: path, stats }
  }

  if (tool === 'Bash') {
    const command = text(input, 'command')
    if (command === undefined) return undefined
    // No duration: tool.call's span includes the permission prompt, and no event
    // marks when the command itself started.
    const stats: Stat[] = isErrored ? [{ text: '· error', color: GRUVBOX.red }] : []
    return { icon: ICONS.bash, color: tint(GRUVBOX.aqua), label: firstLine(command), stats }
  }

  if (tool === 'Grep' || tool === 'Glob') {
    const pattern = text(input, 'pattern')
    if (pattern === undefined) return undefined
    return { icon: ICONS.search, color: tint(GRUVBOX.purple), label: pattern, stats: [] }
  }

  if (tool === 'Agent') {
    const description = text(input, 'description')
    if (description === undefined) return undefined
    const type = text(input, 'subagent_type') ?? 'general-purpose'
    return { icon: ICONS.agent, color: tint(GRUVBOX.orange), label: `${type}: ${description}`, stats: [] }
  }

  if (tool === 'WebFetch') {
    const url = text(input, 'url')
    if (url === undefined) return undefined
    return { icon: ICONS.web, color: tint(GRUVBOX.blue), label: host(url), stats: [] }
  }

  if (tool === 'WebSearch') {
    const query = text(input, 'query')
    if (query === undefined) return undefined
    return { icon: ICONS.web, color: tint(GRUVBOX.blue), label: query, stats: [] }
  }

  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) {
    return { icon: ICONS.mcp, color: tint(GRUVBOX.gray), label: `${mcp[1]}:${mcp[2]}`, stats: [] }
  }

  return undefined
}
