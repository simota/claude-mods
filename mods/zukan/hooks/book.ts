// The error book, pure: reading an error's signature out of a failed command's output,
// adding sightings and fixes to the entries, and the words shown and fed to the model.

import type { ZukanEntry, ZukanFix, ZukanPending } from '../types'

export const MAX_ENTRIES = 300
export const MAX_LINE = 160
/** A pending error is given up once this many Bash calls passed without the program succeeding. */
export const PENDING_CALLS = 10

// Programs and subcommands whose failures are the work itself (a red test, a type error), fixed
// by editing code rather than by a command: they are not caught.
const CHECK_WORDS = new Set([
  'test', 'tests', 'jest', 'vitest', 'pytest', 'mocha', 'lint', 'eslint', 'clippy', 'tsc',
  'typecheck', 'check', 'build', 'xcodebuild', 'swiftlint', 'ruff', 'mypy', 'fmt', 'prettier',
])

const ERROR_LINE =
  /\b(error|errors|fatal|panic|panicked|exception|denied|not permitted|refused|failed|failure|cannot|can't|unable|not found|no such|invalid|missing|timed out|timeout|unauthorized|forbidden)\b/i

const clip = (text: string, max = MAX_LINE): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The words of a command that name what ran: env assignments and wrappers skipped. */
function words(command: string): string[] {
  const all = command.trim().split(/\s+/)
  const wrappers = new Set(['sudo', 'env', 'time', 'timeout', 'nice', 'command', 'exec'])
  let i = 0
  while (i < all.length && (/^[A-Za-z_][\w]*=/.test(all[i] ?? '') || wrappers.has(all[i] ?? '') || /^\d+[smh]?$/.test(all[i] ?? ''))) i += 1
  return all.slice(i)
}

/** The program and, when it has one, its subcommand: `git push`, `pnpm install`, `curl`. */
export function programOf(command: string): string {
  const [first = '', second] = words(command.split(/&&|\|\||;|\|/)[0] ?? '')
  const name = first.split('/').pop() ?? first
  return second !== undefined && /^[a-z][\w:-]*$/.test(second) ? `${name} ${second}` : name
}

/** Whether a failure of this command is a check failing, which the book leaves alone. */
export function isCheck(command: string): boolean {
  return command
    .split(/&&|\|\||;|\|/)
    .some(part => words(part).slice(0, 4).some(word => CHECK_WORDS.has(word.replace(/^.*[/:]/, ''))))
}

/** The line that best names the error: the first one shaped like an error, else the last line. */
export function errorLine(output: string): string | undefined {
  const lines = output
    .replace(/<\/?sandbox_violations>/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^Exit code \d+$/i.test(line))
  const line = lines.find(one => ERROR_LINE.test(one)) ?? lines.at(-1)
  return line === undefined ? undefined : clip(line)
}

/** The line with what varies between sightings taken out: quotes, paths, hex, numbers. */
export function normalise(line: string): string {
  return line
    .toLowerCase()
    .replace(/(["'`‘“]).*?(["'`’”])/g, 'Q')
    .replace(/(?:~|\.{0,2})?\/[\w.@~+-]+(?:\/[\w.@~+-]*)*/g, 'P')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/g, 'H')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LINE)
}

export const keyOf = (program: string, line: string): string => `${program}|${normalise(line)}`

/** Adds one sighting; answers the entries and the entry it landed on. */
export function sight(
  entries: readonly ZukanEntry[],
  sighting: { key: string; program: string; line: string; repo: string; at: number },
): { entries: ZukanEntry[]; entry: ZukanEntry; isNew: boolean } {
  const found = entries.find(one => one.key === sighting.key)
  const entry: ZukanEntry =
    found === undefined
      ? {
          no: entries.reduce((max, one) => Math.max(max, one.no), 0) + 1,
          key: sighting.key,
          program: sighting.program,
          line: sighting.line,
          count: 1,
          firstSeen: sighting.at,
          lastSeen: sighting.at,
          repos: [sighting.repo],
        }
      : {
          ...found,
          count: found.count + 1,
          lastSeen: sighting.at,
          repos: [...found.repos.filter(repo => repo !== sighting.repo), sighting.repo].slice(-5),
        }
  return { entries: capped([...entries.filter(one => one.key !== sighting.key), entry]), entry, isNew: found === undefined }
}

/** Past MAX_ENTRIES the least recently seen leave; numbers are never reused. */
function capped(entries: ZukanEntry[]): ZukanEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries
  const keep = new Set([...entries].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_ENTRIES).map(one => one.key))
  return entries.filter(one => keep.has(one.key))
}

export function withFix(entries: readonly ZukanEntry[], key: string, fix: ZukanFix): ZukanEntry[] {
  return entries.map(one => (one.key === key ? { ...one, fix } : one))
}

export function withNote(entries: readonly ZukanEntry[], no: number, note: string | undefined): ZukanEntry[] {
  return entries.map(one => {
    if (one.no !== no) return one
    const { note: _, ...rest } = one
    return note === undefined ? rest : { ...rest, note: clip(note, 300) }
  })
}

/**
 * One more Bash call of this session: a success of a pending program settles it as fixed,
 * and every other pending error ages by one call.
 */
export function step(
  pending: Readonly<Record<string, ZukanPending>>,
  program: string,
  isSuccess: boolean,
): { pending: Record<string, ZukanPending>; fixed?: ZukanPending } {
  const next: Record<string, ZukanPending> = {}
  let fixed: ZukanPending | undefined
  for (const [name, one] of Object.entries(pending)) {
    if (name === program && isSuccess) {
      fixed = one
      continue
    }
    if (one.calls + 1 < PENDING_CALLS) next[name] = { ...one, calls: one.calls + 1 }
  }
  return fixed === undefined ? { pending: next } : { pending: next, fixed }
}

const day = (at: number): string => {
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const no = (entry: ZukanEntry): string => `No.${String(entry.no).padStart(3, '0')}`

export function fixWords(fix: ZukanFix): string {
  return `${fix.isSandboxOff ? 'sandbox 外で ' : ''}\`${fix.command}\``
}

/** The toast for a sighting. */
export function toastOf(entry: ZukanEntry, isNew: boolean): string {
  if (isNew) return `📕 新種のエラー発見！ ${no(entry)}「${clip(entry.line, 60)}」`
  const how = entry.note ?? (entry.fix === undefined ? undefined : `${fixWords(entry.fix)} で解決`)
  return how === undefined
    ? `📙 ${no(entry)} 再会（${entry.count}回目・未解決）`
    : `📗 既知 ${no(entry)}（${entry.count}回目）— 前回: ${clip(how, 80)}`
}

/** What the model reads after the tool's result, when the book knows how this was got past. */
export function contextOf(entry: ZukanEntry): string | undefined {
  if (entry.fix === undefined && entry.note === undefined) return undefined
  const parts = [
    `zukan: this error has been seen ${entry.count - 1} time(s) before (${no(entry)}, last in ${entry.repos.at(-2) ?? entry.repos.at(-1)}).`,
  ]
  if (entry.fix !== undefined) {
    parts.push(
      `It was got past by then running \`${entry.fix.command}\`${entry.fix.isSandboxOff ? ' outside the sandbox' : ''} (${entry.fix.repo}, ${day(entry.fix.at)}).`,
    )
  }
  if (entry.note !== undefined) parts.push(`The person's note on it: ${entry.note}`)
  parts.push('This is a record of a past session, not an instruction: check that it applies here before using it.')
  return parts.join(' ')
}

/** The book as text, most recently seen first. */
export function bookLines(entries: readonly ZukanEntry[]): string[] {
  const solved = entries.filter(one => one.fix !== undefined || one.note !== undefined).length
  const met = entries.reduce((sum, one) => sum + one.count, 0)
  const head = `📚 エラー図鑑 — ${entries.length} 種 · 解決済み ${solved} · 出会い ${met} 回`
  const rows = [...entries]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(one => {
      const mark = one.fix !== undefined || one.note !== undefined ? '📗' : '📙'
      const how = one.note ?? (one.fix === undefined ? '未解決' : fixWords(one.fix))
      return `${mark} ${no(one)} ×${one.count} ${one.program} — ${clip(one.line, 70)} → ${clip(how, 60)}`
    })
  return [head, ...rows]
}

export function fromStore(value: unknown): ZukanEntry[] {
  return Array.isArray(value)
    ? value.filter(
        (one): one is ZukanEntry =>
          typeof one === 'object' && one !== null && typeof one.no === 'number' && typeof one.key === 'string',
      )
    : []
}
