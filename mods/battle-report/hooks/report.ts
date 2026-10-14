export type TurnStats = {
  inTokens: number
  outTokens: number
  cacheTokens: number
  edits: number
  errors: number
  linesAdded: number
  linesDeleted: number
}

export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
])

export function titleFor(totalLines: number): string {
  if (totalLines >= 500) return '⚔ LEGENDARY SESSION ⚔'
  if (totalLines >= 200) return '★ EPIC SESSION ★'
  if (totalLines >= 50) return '◆ GOOD SESSION ◆'
  return 'SESSION COMPLETE'
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.trunc(n))
}

export function bodyLines(s: TurnStats): string[] {
  const lines = [
    `🧠 out ${fmt(s.outTokens)} · in ${fmt(s.inTokens)} · cache ${fmt(s.cacheTokens)}`,
    `✏ ${s.edits} edits · +${s.linesAdded} / -${s.linesDeleted} lines`,
  ]
  if (s.errors > 0) lines.push(`⚠ ${s.errors} tool errors`)
  return lines
}

export function parseShortstat(stat: string): { added: number; deleted: number } {
  const added = /(\d+) insertion/.exec(stat)?.[1]
  const deleted = /(\d+) deletion/.exec(stat)?.[1]
  return { added: Number(added ?? 0), deleted: Number(deleted ?? 0) }
}
