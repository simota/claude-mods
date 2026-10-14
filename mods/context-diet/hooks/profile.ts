import type { ContextDietEntry } from '../types'

export type Kind = 'swift' | 'android' | 'rust' | 'web' | 'python' | 'go'

/** The files that mark a project kind, by exact name or by suffix. */
const MARKERS: readonly { kind: Kind; names?: readonly string[]; suffixes?: readonly string[] }[] = [
  { kind: 'swift', names: ['Package.swift'], suffixes: ['.xcodeproj', '.xcworkspace'] },
  { kind: 'android', names: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
  { kind: 'rust', names: ['Cargo.toml'] },
  { kind: 'web', names: ['package.json'] },
  { kind: 'python', names: ['pyproject.toml'] },
  { kind: 'go', names: ['go.mod'] },
]

const UI_KINDS: ReadonlySet<Kind> = new Set(['web', 'swift', 'android'])

/** Kept whatever the project: the everyday families and the commands that run them. */
const CORE = ['coding-*', 'quality-*', 'planning-*', 'research-*', 'clarify', 'plugin-authoring', 'code-review', 'simplify']

/** Dropped whatever the project, unless the `keep` option names them. */
const ALWAYS_DROP = ['redteam-*', 'dynamic-*', 'persona-*', 'operation-*']

/** Kept only where the project draws a UI (or its kind is unknown). */
const VISUAL = ['image-*', 'design-*', 'ux-scan', 'brand-scan']

/** The kinds a set of file names marks, in MARKERS order. */
export function kindsOf(names: readonly string[]): Kind[] {
  return MARKERS.filter(
    marker =>
      names.some(name => marker.names?.includes(name) || marker.suffixes?.some(suffix => name.endsWith(suffix))),
  ).map(marker => marker.kind)
}

/** A comma-separated option as patterns; blanks dropped. */
export function patternsOf(option: unknown): string[] {
  if (typeof option !== 'string') return []
  return option
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

function matches(name: string, pattern: string): boolean {
  const bare = name.slice(name.lastIndexOf(':') + 1)
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1)
    return name.startsWith(prefix) || bare.startsWith(prefix)
  }
  return name === pattern || bare === pattern
}

const any = (name: string, patterns: readonly string[]) => patterns.some(pattern => matches(name, pattern))

export type Rules = { kinds: readonly Kind[]; keep: readonly string[]; drop: readonly string[] }

/** Whether a skill stays in the listing: the options first, then the profile. */
export function isKept(name: string, rules: Rules): boolean {
  if (any(name, rules.keep)) return true
  if (any(name, rules.drop)) return false
  if (any(name, CORE)) return true
  if (any(name, ALWAYS_DROP)) return false
  const isUiProject = rules.kinds.length === 0 || rules.kinds.some(kind => UI_KINDS.has(kind))
  if (!isUiProject && any(name, VISUAL)) return false
  return true
}

type Listing = {
  head: string[]
  entries: { name: string; lines: string[] }[]
  tail: string[]
  /** False when a line looks like an entry but is not one: cutting could orphan its neighbours. */
  isCertain: boolean
}

// A top-level entry line: `- name: description`, at column 0.
const ENTRY = /^- (\S+?):(?:\s|$)/
// What a skill's name looks like: lowercase words joined by - _ . and scoped by : or /.
const SKILL_NAME = /^[a-z0-9][a-z0-9_.-]*(?:[:/][a-z0-9][a-z0-9_.-]*)*$/

/**
 * Splits a listing into its lead-in, one entry per `- name: description` line (with every
 * line up to the next entry: wrapped description lines, blank lines between entries), and
 * whatever follows a blank line after the last entry. An entry's name must look like a skill's
 * and, when `known` is given, be one of the session's commands; a line shaped like an entry that
 * fails that (`- Note: …` inside a description) makes the parse uncertain. Nothing is reworded:
 * joining the parts gives the text back.
 */
export function parseListing(text: string, known?: ReadonlySet<string>): Listing {
  const lines = text.split('\n')
  const nameOf = (line: string) => ENTRY.exec(line)?.[1]
  const isEntry = (name: string) => SKILL_NAME.test(name) && (known === undefined || known.size === 0 || known.has(name))

  const starts = lines.flatMap((line, i) => {
    const name = nameOf(line)
    return name !== undefined && isEntry(name) ? [i] : []
  })
  const first = starts[0]
  if (first === undefined) return { head: lines, entries: [], tail: [], isCertain: true }

  const entries = starts.map((start, n) => {
    const end = starts[n + 1] ?? lines.length
    return { name: nameOf(lines[start] ?? '') ?? '', lines: lines.slice(start, end) }
  })

  // The last entry runs to the first blank line after it; from there on is what follows the list.
  const lastEntry = entries.at(-1)!
  const blank = lastEntry.lines.findIndex((line, i) => i > 0 && line.trim() === '')
  const tail = blank === -1 ? [] : lastEntry.lines.splice(blank)

  const head = lines.slice(0, first)
  const strays = [...head, ...entries.flatMap(entry => entry.lines.slice(1))]
  const isCertain = !strays.some(line => nameOf(line) !== undefined)

  return { head, entries, tail, isCertain }
}

export type Filtered = { text: string; kept: string[]; dropped: ContextDietEntry[]; isUncertain: boolean }

/**
 * The listing with the dropped entries left out. A listing with no entries, or one whose
 * shape is uncertain, comes back as given: the full listing is the safe answer.
 */
export function filterListing(text: string, rules: Rules, known?: ReadonlySet<string>): Filtered {
  const listing = parseListing(text, known)
  if (listing.entries.length === 0) return { text, kept: [], dropped: [], isUncertain: false }
  if (!listing.isCertain) return { text, kept: listing.entries.map(entry => entry.name), dropped: [], isUncertain: true }

  const kept = listing.entries.filter(entry => isKept(entry.name, rules))
  const dropped = listing.entries.filter(entry => !isKept(entry.name, rules))
  const lines = [...listing.head, ...kept.flatMap(entry => entry.lines), ...listing.tail]

  return {
    text: lines.join('\n'),
    kept: kept.map(entry => entry.name),
    dropped: dropped.map(entry => ({ name: entry.name, text: entry.lines.join('\n') })),
    isUncertain: false,
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The dropped skills a prompt names, as `/name` or as a word of its own. */
export function mentioned(prompt: string, dropped: readonly ContextDietEntry[]): ContextDietEntry[] {
  return dropped.filter(entry => new RegExp(`(^|[^\\w-])/?${escape(entry.name)}(?![\\w-])`).test(prompt))
}

/** The tokens a cut of `chars` characters saves, by the usual four characters a token. */
export const estimateTokens = (chars: number) => Math.max(0, Math.round(chars / 4))
