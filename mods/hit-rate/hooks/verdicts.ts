// Deciding, from what the session did after a finding, whether the finding held. Pure: the
// hooks module reads the detectors' state and the files, and hands them here.

import type { PluginState } from 'claude-code'

import type { HitAssertion, HitAudit, HitMark, HitMarks, HitRecall, HitTable, HitVerdict } from '../types'

type Verdict = Omit<HitVerdict, 'at'>

/** self-audit's rule id (`R1`…`R5`) when the fork named one, else the rule as written: the same id loopback keys by. */
export function ruleId(rule: string): string {
  const id = rule.toUpperCase().match(/R[1-5]/)?.[0]
  if (id !== undefined) return id
  const flat = rule.replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat
}

// ---- self-audit -------------------------------------------------------------------------

type AuditLatest = PluginState['self-audit']['latest'] | undefined
type AuditViolations = readonly PluginState['self-audit']['violations'][number][] | undefined

/**
 * Once self-audit has audited a later reply, each rule it flagged on the reply before is
 * judged: gone on the next audited reply, the finding was acted on (tp); flagged again, it
 * changed nothing (fp).
 */
export function auditStep(held: HitAudit | null, latest: AuditLatest, violations: AuditViolations): { verdicts: Verdict[]; audit: HitAudit | null } {
  if (latest?.status !== 'audited' || latest.turnId === held?.turnId) return { verdicts: [], audit: held }
  const now = [...new Set((violations ?? []).map(v => ruleId(v.rule)))]
  const verdicts: Verdict[] = (held?.rules ?? []).map(rule =>
    now.includes(rule)
      ? { rule: `self-audit:${rule}`, verdict: 'fp', why: '次に監査された返信でも同じ違反' }
      : { rule: `self-audit:${rule}`, verdict: 'tp', why: '次に監査された返信で違反が消えた' },
  )
  return { verdicts, audit: { turnId: latest.turnId, rules: now } }
}

// ---- zukan --------------------------------------------------------------------------------

type ZukanPending = Readonly<Record<string, PluginState['zukan']['pending'][string]>> | undefined
type ZukanEntries = readonly PluginState['zukan']['entries'][number][] | undefined

/**
 * A pending error whose entry has a recorded fix is a recall: zukan told Claude that fix. Once
 * the error is got past, the recall held if the command that got past it is the one recalled.
 * The same error failing again, from the same command or another, is the same recall waiting.
 */
export function recallStep(
  recalls: Readonly<Record<string, HitRecall>>,
  pending: ZukanPending,
  entries: ZukanEntries,
  now: number,
): { verdicts: Verdict[]; recalls: Record<string, HitRecall> } {
  const verdicts: Verdict[] = []
  const next: Record<string, HitRecall> = {}
  const byKey = new Map((entries ?? []).map(one => [one.key, one]))
  for (const [program, held] of Object.entries(recalls)) {
    const still = pending?.[program]
    if (still !== undefined && still.key === held.key) {
      next[program] = held
      continue
    }
    const fix = byKey.get(held.key)?.fix
    if (fix !== undefined && fix.at >= held.openedAt) {
      verdicts.push(
        fix.command === held.suggested
          ? { rule: 'zukan:recall', verdict: 'tp', why: `前回の解決方法 \`${held.suggested}\` で解決` }
          : { rule: 'zukan:recall', verdict: 'fp', why: `別のコマンド \`${fix.command}\` で解決` },
      )
    } else {
      verdicts.push({ rule: 'zukan:recall', verdict: 'unknown', why: '解決されないまま終わった' })
    }
  }
  for (const [program, one] of Object.entries(pending ?? {})) {
    if (next[program] !== undefined) continue
    const fix = byKey.get(one.key)?.fix
    if (fix === undefined) continue
    next[program] = { key: one.key, failed: one.failed, suggested: fix.command, openedAt: now }
  }
  return { verdicts, recalls: next }
}

// ---- assertion-guard ------------------------------------------------------------------------

export const occurrences = (text: string, line: string): number =>
  line === '' ? 0 : text.split('\n').filter(one => one.trim() === line).length

type GuardFinding = PluginState['assertion-guard']['entries'][number]['findings'][number]

const guardRule = (finding: GuardFinding): string => `assertion-guard:${finding.kind}`

/** Each finding's rule and its before and after lines, counted in the file as it stands when the finding is opened. */
export function marksOf(findings: readonly GuardFinding[], text: string): HitMarks[] {
  const mark = (side: HitMark['side'], raw: string | undefined): HitMark | undefined => {
    const line = raw?.trim() ?? ''
    return line === '' ? undefined : { side, line, count: occurrences(text, line) }
  }
  return findings.map(f => {
    const before = mark('before', f.before)
    const after = mark('after', f.after)
    return { rule: guardRule(f), ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }
  })
}

/**
 * Whether the file now undoes one finding's weakening: the old line came back and the new one
 * went (or only the one it has did). Counts, not presence, so a duplicate assertion elsewhere
 * in the file does not look like a revert.
 */
function isUndone({ before, after }: HitMarks, text: string): boolean {
  if (before === undefined && after === undefined) return false
  const isBack = before === undefined || occurrences(text, before.line) > before.count
  const isGone = after === undefined || occurrences(text, after.line) < after.count
  return isBack && isGone
}

/** Whether the file now undoes the weakening of some finding. */
export const isReverted = (marks: readonly HitMarks[], text: string): boolean => marks.some(one => isUndone(one, text))

/**
 * The rules of one entry the file now undoes: a rule (a kind of weakening) is undone when one of
 * its findings is, so undoing a loosened matcher scores `loosened` and leaves a swallowed error
 * in the same edit open. An entry gets one verdict per rule: two loosened matchers with one
 * undone score `loosened` once, as tp.
 */
export const revertedRules = (one: HitAssertion, text: string): string[] => [...new Set(one.marks.filter(mark => isUndone(mark, text)).map(mark => mark.rule))]

/** The entry with `rules` settled: those rules and their findings gone, or null when nothing is left open. */
export function withoutRules(one: HitAssertion, rules: readonly string[]): HitAssertion | null {
  const left = one.rules.filter(rule => !rules.includes(rule))
  if (left.length === 0) return null
  return { ...one, rules: left, marks: one.marks.filter(mark => !rules.includes(mark.rule)) }
}

export const guardRules = (findings: readonly GuardFinding[]): string[] => [...new Set(findings.map(guardRule))]

// ---- the table ------------------------------------------------------------------------------

export function addVerdicts(table: HitTable, verdicts: readonly Pick<HitVerdict, 'rule' | 'verdict'>[]): HitTable {
  const next: HitTable = { ...table }
  for (const v of verdicts) {
    const row = next[v.rule] ?? { tp: 0, fp: 0, unknown: 0 }
    next[v.rule] = { ...row, [v.verdict]: row[v.verdict] + 1 }
  }
  return next
}

export function fromStore(value: unknown): HitTable {
  const table: HitTable = {}
  if (typeof value !== 'object' || value === null) return table
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
  for (const [rule, row] of Object.entries(value as Record<string, Record<string, unknown>>)) {
    if (typeof row !== 'object' || row === null) continue
    table[rule] = { tp: n(row.tp), fp: n(row.fp), unknown: n(row.unknown) }
  }
  return table
}

export const isSame = (a: HitTable, b: HitTable): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

export const DEFAULT_THRESHOLD = 0.5

/**
 * The precision threshold as configured, when it is one (0 to 1). Any other value, such as a
 * percentage typed as 50, would mute rules that are always right, so the default is used and
 * the value given is reported.
 */
export function thresholdOf(value: unknown): { value: number; ignored?: string } {
  if (value === undefined || value === null || value === '') return { value: DEFAULT_THRESHOLD }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return { value }
  return { value: DEFAULT_THRESHOLD, ignored: String(value) }
}

/** Rules judged often enough whose precision is below the threshold. */
export function mutedOf(table: HitTable, minN: number, threshold: number): string[] {
  return Object.entries(table)
    .filter(([, row]) => row.tp + row.fp >= minN && row.tp / (row.tp + row.fp) < threshold)
    .map(([rule]) => rule)
    .sort()
}

/** The /hit-rate report: one line per rule, the unknown share the decision record is refuted by, and the latest verdicts. */
export function reportLines(table: HitTable, muted: readonly string[], last: readonly HitVerdict[], minN: number): string[] {
  const rows = Object.entries(table).sort(([a], [b]) => a.localeCompare(b))
  if (rows.length === 0) return ['まだ判定はありません。']
  const total = rows.reduce((sum, [, r]) => ({ tp: sum.tp + r.tp, fp: sum.fp + r.fp, unknown: sum.unknown + r.unknown }), { tp: 0, fp: 0, unknown: 0 })
  const all = total.tp + total.fp + total.unknown
  const lines = rows.map(([rule, r]) => {
    const n = r.tp + r.fp
    const precision = n === 0 ? '—' : `${Math.round((r.tp / n) * 100)}%`
    const flag = muted.includes(rule) ? '  🔇 loopback 停止中' : n < minN ? `  (n<${minN})` : ''
    return `${rule}  TP ${r.tp} / FP ${r.fp} / unknown ${r.unknown}  precision ${precision}  n=${n}${flag}`
  })
  const unknownRate = all === 0 ? '—' : `${Math.round((total.unknown / all) * 100)}%`
  return [
    ...lines,
    `unknown 率: ${total.unknown}/${all}（${unknownRate}、全セッション累計）`,
    ...(last.length === 0 ? [] : ['このセッションの最近の判定:', ...last.slice(-8).map(v => `- ${v.verdict.toUpperCase()} ${v.rule}: ${v.why}`)]),
  ]
}
