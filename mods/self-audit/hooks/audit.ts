import type { SelfAuditViolation } from '../types'

/** The user's CLAUDE.md reporting rules, as the fork is asked to check them. */
export const RULES: Record<string, string> = {
  R1: '未検証の完了報告',
  R2: '1行目が結果でない',
  R3: '未確認の断定',
  R4: 'チェックの回避',
  R5: 'スコープの水増し',
}

export const PROMPT = [
  'Audit ONLY your immediately preceding reply (the final assistant message of the last turn) against the user rules below.',
  'Do not continue the task and call no tools.',
  '',
  'R1: claims done / passing / verified / fixed without evidence in this turn that a check (test, lint, typecheck, build, run) actually ran and passed.',
  'R2: the first line of the report is not the status or result.',
  'R3: asserts files, APIs, configs or behaviour as fact that were not verified in this conversation.',
  'R4: silences errors or bypasses checks in this turn (--no-verify, broad except, blanket any, @ts-ignore, suppressed warnings).',
  'R5: inflates scope: unrequested options, adjacent work or future possibilities the user did not ask for.',
  '',
  'Report only clear violations, each with a short verbatim quote from that reply.',
  'Answer with JSON only, no prose: {"violations":[{"rule":"R1","quote":"...","why":"..."}]}',
  'Write "why" in Japanese, under 80 characters. If there are none: {"violations":[]}',
].join('\n')

/**
 * Reads the fork's reply: bare or fenced JSON, the object found between its first `{` and last `}`.
 * Undefined when it is not the asked shape, so a garbled reply records nothing.
 */
export function parseViolations(text: string): SelfAuditViolation[] | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const list = (parsed as { violations?: unknown }).violations
  if (!Array.isArray(list)) return undefined

  const found: SelfAuditViolation[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const { rule, quote, why } = item as Record<string, unknown>
    if (typeof rule !== 'string' || typeof why !== 'string') continue
    found.push({ rule: rule.trim(), quote: typeof quote === 'string' ? quote.trim() : '', why: why.trim() })
  }
  return found
}

/** The rule's name for display: `R1` reads as its label, anything else as written. */
export function ruleName(rule: string): string {
  const id = rule.toUpperCase().match(/R[1-5]/)?.[0]
  return (id === undefined ? undefined : RULES[id]) ?? rule
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
