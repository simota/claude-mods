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

type Listing = { head: string[]; entries: { name: string; lines: string[] }[]; tail: string[] }

const ENTRY = /^- (\S+?):(?:\s|$)/

/**
 * Splits a listing into its lead-in, one entry per `- name: description` line
 * (with the lines that continue it), and whatever follows a blank line after
 * the entries. Nothing is reworded: joining the parts gives the text back.
 */
export function parseListing(text: string): Listing {
  const listing: Listing = { head: [], entries: [], tail: [] }
  let part: 'head' | 'entries' | 'tail' = 'head'

  for (const line of text.split('\n')) {
    const entry = part === 'tail' ? null : ENTRY.exec(line)
    if (entry !== null) {
      part = 'entries'
      listing.entries.push({ name: entry[1] ?? '', lines: [line] })
    } else if (part === 'entries' && line.trim() !== '') {
      listing.entries.at(-1)?.lines.push(line)
    } else if (part === 'entries') {
      part = 'tail'
      listing.tail.push(line)
    } else {
      listing[part].push(line)
    }
  }
  return listing
}

export type Filtered = { text: string; kept: string[]; dropped: ContextDietEntry[] }

/** The listing with the dropped entries left out; a listing with no entries comes back as given. */
export function filterListing(text: string, rules: Rules): Filtered {
  const listing = parseListing(text)
  if (listing.entries.length === 0) return { text, kept: [], dropped: [] }

  const kept = listing.entries.filter(entry => isKept(entry.name, rules))
  const dropped = listing.entries.filter(entry => !isKept(entry.name, rules))
  const lines = [...listing.head, ...kept.flatMap(entry => entry.lines), ...listing.tail]

  return {
    text: lines.join('\n'),
    kept: kept.map(entry => entry.name),
    dropped: dropped.map(entry => ({ name: entry.name, text: entry.lines.join('\n') })),
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The dropped skills a prompt names, as `/name` or as a word of its own. */
export function mentioned(prompt: string, dropped: readonly ContextDietEntry[]): ContextDietEntry[] {
  return dropped.filter(entry => new RegExp(`(^|[^\\w-])/?${escape(entry.name)}(?![\\w-])`).test(prompt))
}

/** The tokens a cut of `chars` characters saves, by the usual four characters a token. */
export const estimateTokens = (chars: number) => Math.max(0, Math.round(chars / 4))
