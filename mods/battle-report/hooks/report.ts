export type LineStats = { added: number; deleted: number }

export type TurnStats = {
  inTokens: number
  outTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  edits: number
  errors: number
  /** This turn's line changes; absent when git could not tell (no repo, git failed, no snapshot). */
  lines?: LineStats
  /** Why the turn ended badly; absent on an answer. */
  failure?: 'error' | 'refusal'
}

export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
])

// What a call reads as when the person rejects it at the permission dialog: their choice, not a tool error.
const USER_REJECTION = /doesn't want to (proceed|take this action)|user (rejected|denied|declined)|rejected by the user/i

export function isUserRejection(text: string | undefined): boolean {
  return text !== undefined && USER_REJECTION.test(text)
}

export function titleFor(totalLines: number): string {
  if (totalLines >= 500) return '⚔ LEGENDARY SESSION ⚔'
  if (totalLines >= 200) return '★ EPIC SESSION ★'
  if (totalLines >= 50) return '◆ GOOD SESSION ◆'
  return 'SESSION COMPLETE'
}

export function titleOf(s: TurnStats): string {
  if (s.failure !== undefined) return `✗ TURN FAILED (${s.failure})`
  return titleFor(s.lines === undefined ? 0 : s.lines.added + s.lines.deleted)
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.trunc(n))
}

export function bodyLines(s: TurnStats): string[] {
  const lines = [
    `🧠 out ${fmt(s.outTokens)} · in ${fmt(s.inTokens)} · cache r ${fmt(s.cacheReadTokens)} / w ${fmt(s.cacheWriteTokens)}`,
    s.lines === undefined
      ? `✏ ${s.edits} edits`
      : `✏ ${s.edits} edits · +${s.lines.added} / -${s.lines.deleted} lines`,
  ]
  if (s.errors > 0) lines.push(`⚠ ${s.errors} tool errors`)
  return lines
}

/** Per path, the lines added and deleted against one base. */
export type Snapshot = Record<string, LineStats>

/** Reads `git diff --numstat -z --no-renames` output; a binary file (`-\t-`) counts 0 / 0. */
export function parseNumstat(out: string): Snapshot {
  const snap: Snapshot = {}
  for (const record of out.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record.replace(/^\n/, ''))
    if (!match) continue
    const [, added = '-', deleted = '-', path = ''] = match
    snap[path] = { added: added === '-' ? 0 : Number(added), deleted: deleted === '-' ? 0 : Number(deleted) }
  }
  return snap
}

/** Reads `wc -l -- <files>` output into line counts of the files, in the order given. */
export function parseWc(out: string, files: readonly string[]): Snapshot {
  const counts = out
    .split('\n')
    .map(line => /^\s*(\d+)\s/.exec(line)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
  const snap: Snapshot = {}
  files.forEach((file, i) => {
    const n = counts[i]
    if (n !== undefined) snap[file] = { added: n, deleted: 0 }
  })
  return snap
}

/**
 * What changed between two snapshots taken against the same base: a path's added
 * lines growing were added this turn; shrinking, this turn took them away again.
 */
export function turnDelta(before: Snapshot, after: Snapshot): LineStats {
  let added = 0
  let deleted = 0
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[path] ?? { added: 0, deleted: 0 }
    const b = after[path] ?? { added: 0, deleted: 0 }
    const dAdded = b.added - a.added
    const dDeleted = b.deleted - a.deleted
    added += Math.max(0, dAdded) + Math.max(0, -dDeleted)
    deleted += Math.max(0, dDeleted) + Math.max(0, -dAdded)
  }
  return { added, deleted }
}
