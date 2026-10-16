// The comparison, pure: what /usr/bin/time said of a run, the statistics of a side, and
// whether two sides differ by more than their noise.

import type { PerfSample } from '../types'

/** Wall time (ms) and peak memory (bytes) from `/usr/bin/time -l` (macOS) or `-v` (GNU). */
export function parseTime(stderr: string): { wallMs?: number; rssBytes?: number } {
  const out: { wallMs?: number; rssBytes?: number } = {}
  const bsdReal = stderr.match(/^\s*([\d.]+)\s+real\b/m)
  if (bsdReal?.[1] !== undefined) out.wallMs = Number(bsdReal[1]) * 1000
  const bsdRss = stderr.match(/^\s*(\d+)\s+maximum resident set size/m)
  if (bsdRss?.[1] !== undefined) out.rssBytes = Number(bsdRss[1])
  const gnuWall = stderr.match(/Elapsed \(wall clock\) time \([^)]*\):\s*(?:(\d+):)?(\d+):([\d.]+)/)
  if (gnuWall !== null) out.wallMs = (Number(gnuWall[1] ?? 0) * 3600 + Number(gnuWall[2]) * 60 + Number(gnuWall[3])) * 1000
  const gnuRss = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)
  if (gnuRss?.[1] !== undefined) out.rssBytes = Number(gnuRss[1]) * 1024
  return out
}

/** The lines /usr/bin/time added, taken off what the command itself wrote to stderr. */
export function commandStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter(line => !/^\s*[\d.]+\s+(?:real|user|sys)\b|^\s*\d+\s+[a-z][a-z ()-]+$|^\s*(?:Command being timed|User time|System time|Percent of CPU|Elapsed|Average|Maximum resident|Major|Minor|Voluntary|Involuntary|Swaps|File system|Socket|Signals|Page size|Exit status)\b/.test(line))
    .join('\n')
    .trim()
}

export type Stats = { n: number; median: number; mean: number; stdev: number; cv: number; min: number; max: number }

export function statsOf(values: readonly number[]): Stats | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mid = Math.floor(n / 2)
  const median = n % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n
  const stdev = n < 2 ? 0 : Math.sqrt(sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1))
  return { n, median, mean, stdev, cv: mean === 0 ? 0 : (stdev / mean) * 100, min: sorted[0] as number, max: sorted[n - 1] as number }
}

export type Verdict = 'faster' | 'slower' | 'noise' | 'few' | 'unknown'

/** Runs a side needs before a difference is called: with fewer there is no spread to weigh it by. */
export const MIN_RUNS = 3

/**
 * Whether the medians differ by more than the noise: more than twice the larger standard
 * deviation and more than 1% of the baseline, each side measured at least MIN_RUNS times. A
 * lower value is better (time, memory).
 */
export function verdictOf(before: Stats | undefined, after: Stats | undefined): { verdict: Verdict; deltaPct?: number } {
  if (before === undefined || after === undefined || before.median === 0) return { verdict: 'unknown' }
  const delta = after.median - before.median
  const deltaPct = (delta / before.median) * 100
  if (before.n < MIN_RUNS || after.n < MIN_RUNS) return { verdict: 'few', deltaPct }
  const noise = 2 * Math.max(before.stdev, after.stdev)
  if (Math.abs(delta) <= noise || Math.abs(deltaPct) < 1) return { verdict: 'noise', deltaPct }
  return { verdict: delta < 0 ? 'faster' : 'slower', deltaPct }
}

export const ms = (v: number): string => (v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(v < 10 ? 1 : 0)}ms`)
export const mb = (v: number): string => `${(v / 1024 / 1024).toFixed(v >= 100 * 1024 * 1024 ? 0 : 1)}MB`
export const pct = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`

const WORD: Record<Verdict, string> = { faster: '改善', slower: '悪化', noise: 'ばらつきの範囲内', few: `回数が少なく判定できません（各 ${MIN_RUNS} 回以上）`, unknown: '比較できません' }

/** The comparison as lines: one for time, one for memory, and a warning per unsteady side. */
export function reportLines(before: PerfSample | undefined, after: PerfSample | undefined): string[] {
  const lines: string[] = []
  const side = (label: string, s: Stats | undefined, fmt: (v: number) => string) =>
    s === undefined ? `${label} —` : `${label} 中央値 ${fmt(s.median)} (±${fmt(s.stdev)}, CV ${s.cv.toFixed(1)}%, ${fmt(s.min)}〜${fmt(s.max)}, n=${s.n})`
  for (const [name, pick, fmt] of [
    ['時間', (x: PerfSample) => x.timesMs, ms],
    ['メモリ', (x: PerfSample) => x.rssBytes, mb],
  ] as const) {
    const b = before === undefined ? undefined : statsOf(pick(before))
    const a = after === undefined ? undefined : statsOf(pick(after))
    if (b === undefined && a === undefined) continue
    const { verdict, deltaPct } = verdictOf(b, a)
    lines.push(`${name}: ${deltaPct === undefined ? '' : `${pct(deltaPct)} `}${WORD[verdict]}`)
    if (before !== undefined) lines.push(`  ${side(before.label, b, fmt)}`)
    if (after !== undefined) lines.push(`  ${side(after.label, a, fmt)}`)
    for (const [label, s] of [[before?.label, b], [after?.label, a]] as const) {
      if (s !== undefined && s.cv > 10) lines.push(`  ⚠ ${label} のばらつきが大きい（CV ${s.cv.toFixed(0)}%）: 回数を増やすか、他の負荷を止めて測り直してください`)
    }
  }
  return lines
}

/** `/perf` arguments: `base <cmd>`, `ref <git-ref> <cmd>`, `clear`, `show`, or a command. */
export function parseArgs(args: string): { mode: 'run' | 'base' | 'ref' | 'show' | 'clear'; ref?: string; command: string } {
  const text = args.trim()
  const [first = '', ...rest] = text.split(/\s+/)
  if (first === 'show' || first === '') return { mode: 'show', command: '' }
  if (first === 'clear') return { mode: 'clear', command: rest.join(' ') }
  if (first === 'base') return { mode: 'base', command: text.slice(4).trim() }
  if (first === 'ref' && rest.length >= 2) return { mode: 'ref', ref: rest[0], command: text.slice(4).trim().slice((rest[0] as string).length).trim() }
  return { mode: 'run', command: text }
}

/** A baseline is the command's in the folder it ran in: at the root as it always was, below it with the folder named. */
export const baselineKey = (root: string, command: string, cwd = root): string => {
  const below = cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : ''
  return `${root}\u0000${below === '' ? '' : `${below}\u0000`}${command.trim().replace(/\s+/g, ' ')}`
}

/** A git ref safe to hand to git: no option, no whitespace, no shell or revision-range tricks. */
export const isSafeRef = (ref: string): boolean => /^[\w][\w./~^@{}-]*$/.test(ref) && !ref.includes('..')
