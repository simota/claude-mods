import type { PromptCoachHeld } from '../types'

/** Shorter prompts are quick replies ("はい", "続けて"); longer ones are usually specified already. */
export const MIN_CHARS = 12
export const MAX_CHARS = 1500

/** Identical texts judged before are let through, so a prompt is held back at most once. */
export const JUDGED_KEPT = 50

export const SYSTEM = [
  'You check whether a request a developer typed to a coding agent is too ambiguous to act on well.',
  'Ambiguous means EITHER (a) it names no done-condition AND its target is unclear,',
  'OR (b) it is only an evaluative wish (いい感じに, きれいに, ちゃんと, 良くして, make it nice, clean it up) with no concrete object.',
  'A request with a concrete target (a file, function, error message, command, feature) is NOT ambiguous even without a done-condition.',
  'Questions, confirmations and short follow-ups are NOT ambiguous. When unsure, answer not ambiguous.',
  'Reply with JSON only, no prose:',
  '{"ambiguous": boolean, "missing": [at most 2 short Japanese phrases naming what is missing], "rewrite": "the request rewritten in Japanese with placeholders like <対象> or <完了条件> where the developer must fill in"}',
].join('\n')

export function promptFor(text: string): string {
  return `<request>\n${text}\n</request>`
}

/** The verdict in a reply, or undefined when the reply is not a clear yes or no. */
export function parseVerdict(reply: string): { isAmbiguous: boolean; missing: string[]; rewrite?: string } | undefined {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let value: unknown
  try {
    value = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { ambiguous, missing, rewrite } = value as Record<string, unknown>
  if (typeof ambiguous !== 'boolean') return undefined
  const points = Array.isArray(missing)
    ? missing.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map(one => one.trim()).slice(0, 2)
    : []
  const suggestion = typeof rewrite === 'string' && rewrite.trim() !== '' ? rewrite.trim() : undefined
  return suggestion === undefined
    ? { isAmbiguous: ambiguous, missing: points }
    : { isAmbiguous: ambiguous, missing: points, rewrite: suggestion }
}

/** Whether a typed text is one the coach judges at all, by its length alone. */
export function isJudgeable(text: string): boolean {
  const length = [...text.trim()].length
  return length >= MIN_CHARS && length <= MAX_CHARS && !text.trimStart().startsWith('/')
}

export function clampTimeout(value: unknown): number {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : 3000
  return Math.min(3000, Math.max(500, Math.round(ms)))
}

export function heldFrom(text: string, verdict: { missing: string[]; rewrite?: string }): PromptCoachHeld {
  const missing = verdict.missing.length > 0 ? verdict.missing : ['完了条件または対象']
  return verdict.rewrite === undefined ? { text, missing } : { text, missing, rewrite: verdict.rewrite }
}

export function remember(list: readonly string[], text: string): string[] {
  return [...list.filter(one => one !== text), text].slice(-JUDGED_KEPT)
}
