// The error book, pure: reading an error's signature out of a failed command's output,
// adding sightings and fixes to the entries, and the words shown and fed to the model.

import type { ZukanEntry, ZukanFix, ZukanPending } from '../types'
import { allCommands, base, innerText, isVerification, parse, program } from './shell'

export const MAX_ENTRIES = 300
export const MAX_LINE = 160
/** A pending error is given up once this many Bash calls passed without the program succeeding. */
export const PENDING_CALLS = 10

const ERROR_LINE =
  /\b(error|errors|fatal|panic|panicked|exception|denied|not permitted|refused|failed|failure|cannot|can't|unable|not found|no such|invalid|missing|timed out|timeout|unauthorized|forbidden)\b/i

const clip = (text: string, max = MAX_LINE): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// Commands that set up for, mark or wait on the command after them (`cd app && …`,
// `echo "== build ==" && …`, `[ -f x ] && …`): they name what ran only when nothing else runs.
const LEADING = new Set([
  'cd', 'pushd', 'popd', 'export', 'source', '.', 'set', 'unset', 'shopt', 'umask', 'ulimit', 'alias', 'declare', 'typeset',
  'local', 'readonly', 'echo', 'printf', 'pwd', 'true', ':', 'sleep', 'exit', '[', '[[', 'test',
])
// git's own options that take the next word, before its subcommand (`git -C dir push`), as shell.ts reads them.
const GIT_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
// Past this the shell reader reads no further: its recursion is bounded by the stack, not by length.
const MAX_PARSED = 10_000

type Run = { name: string; args: string[] }

// A program named by an expansion (`$CMD`, `$(foo)`) is not known until it runs.
const named = (runs: Run[]): Run[] => runs.filter(one => !/^[$`]/.test(one.name))
// A program name is kept to this: it goes into the key, the toast and the pane.
const MAX_PROGRAM = 60

/** The programs a command line runs at its top level (a `bash -c` text read through), and those of its substitutions. */
function runsOf(command: string): { top: Run[]; nested: Run[] } {
  const { commands, nested } = parse(command)
  const top = commands.flatMap(one => {
    const outer = program(one.words)
    const inner = outer?.name === 'find' ? undefined : innerText(one.words)
    // A text that is itself fetched or expanded (`bash -c "$(curl …)"`, `eval "$X"`) names nothing: the shell does.
    if (inner === undefined || /^\s*[$`]/.test(inner)) return outer ?? []
    const runs = named(allCommands(inner).flatMap(each => program(each.words) ?? []))
    return runs.length > 0 ? runs : (outer ?? [])
  })
  return { top: named(top), nested: named(nested.flatMap(text => allCommands(text)).flatMap(one => program(one.words) ?? [])) }
}

/**
 * The program and, when it has one, its subcommand: `git push`, `pnpm install`, `curl`. Read as
 * done-gate reads a command (assignments, wrappers and runners skipped), from the first command
 * that is not setting up for the next: `cd app && npm install` is `npm install`, so that it is
 * settled by `npm install` succeeding, not by any `cd app && …`. A substitution's program
 * (`cd $(dirname x)`) names it only when the line runs nothing else.
 */
export function programOf(command: string): string {
  let run: Run | undefined
  try {
    // Only the head is read: a cut mid-quote reads as an unclosed quote, a deeper one throws.
    const { top, nested } = runsOf(command.slice(0, MAX_PARSED))
    run = top.find(one => !LEADING.has(one.name)) ?? top[0] ?? nested[0]
  } catch {
    // A line the reader cannot hold: named by its first word below.
  }
  if (run === undefined) return base(command.trim().split(/\s+/)[0] ?? '').slice(0, MAX_PROGRAM)
  // Free text after `echo` or a path after `cd` is no subcommand.
  if (LEADING.has(run.name)) return run.name
  let k = 0
  if (run.name === 'git') {
    while (run.args[k]?.startsWith('-') === true) k += GIT_VALUES.has(run.args[k] as string) ? 2 : 1
  }
  const second = run.args[k]
  const name = second !== undefined && /^[a-z][\w:-]*$/.test(second) ? `${run.name} ${second}` : run.name
  return name.slice(0, MAX_PROGRAM)
}

/**
 * Whether a failure of this command is a check failing (a red test, a type error), fixed by
 * editing code rather than by a command: the book leaves it alone. The judgement is
 * done-gate's, read from `./shell.ts`, a copy of done-gate's own: mods share no code, and
 * the two must agree on what a check is.
 */
export function isCheck(command: string): boolean {
  return isVerification(command)
}

/** The line that best names the error: the first one shaped like an error, else the last line. */
export function errorLine(output: string): string | undefined {
  const lines = output
    .replace(/<\/?sandbox_violations>/g, '')
    // Colour and cursor codes, then the other controls: drawn raw in the toast and the pane.
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The book once another session wrote over this one's write (`stored`): what this write
 * changed against what it read (`before` → `wrote`) laid on top of the other's book. An entry
 * this write removed stays removed, a field it changed (a fix, a note set or cleared) is
 * this write's, sightings add up, and a new kind whose number the other took gets the next.
 */
export function reconcile(before: readonly ZukanEntry[], wrote: readonly ZukanEntry[], stored: readonly ZukanEntry[]): ZukanEntry[] {
  const was = new Map(before.map(one => [one.key, one]))
  const now = new Map(wrote.map(one => [one.key, one]))
  const removed = new Set(before.filter(one => !now.has(one.key)).map(one => one.key))
  const result = stored.filter(one => !removed.has(one.key)).map(theirs => {
    const mine = now.get(theirs.key)
    const old = was.get(theirs.key)
    if (mine === undefined) return theirs
    if (old === undefined) {
      // Both sessions met it first: one entry, the sightings of both.
      return { ...theirs, count: theirs.count + mine.count, lastSeen: Math.max(theirs.lastSeen, mine.lastSeen), repos: [...new Set([...theirs.repos, ...mine.repos])].slice(-5) }
    }
    const merged: ZukanEntry = {
      ...theirs,
      count: theirs.count + (mine.count - old.count),
      lastSeen: Math.max(theirs.lastSeen, mine.lastSeen),
      repos: [...new Set([...theirs.repos, ...mine.repos])].slice(-5),
    }
    for (const field of ['fix', 'note'] as const) {
      if (same(mine[field], old[field])) continue
      if (mine[field] === undefined) delete merged[field]
      else Object.assign(merged, { [field]: mine[field] })
    }
    return merged
  })
  const known = new Set(result.map(one => one.key))
  let top = result.reduce((max, one) => Math.max(max, one.no), 0)
  for (const mine of wrote) {
    if (known.has(mine.key) || was.has(mine.key)) continue
    const isTaken = result.some(one => one.no === mine.no)
    result.push(isTaken ? { ...mine, no: (top += 1) } : mine)
    top = Math.max(top, mine.no)
  }
  return capped(result)
}

/** True when the book read back is not the one just written: another session wrote in between. */
export const isOverwritten = (wrote: readonly ZukanEntry[], stored: readonly ZukanEntry[]): boolean => !same(wrote, stored)

export function fromStore(value: unknown): ZukanEntry[] {
  return Array.isArray(value)
    ? value.filter(
        (one): one is ZukanEntry =>
          typeof one === 'object' && one !== null && typeof one.no === 'number' && typeof one.key === 'string',
      )
    : []
}
