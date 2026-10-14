export type LineStats = { added: number; deleted: number }

export type TurnStats = {
  inTokens: number
  outTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  edits: number
  errors: number
  /** Lines this turn's Edit/Write/NotebookEdit calls added and removed; Bash-made changes are not counted. */
  lines: LineStats
  /** Why the turn ended badly; absent on an answer. */
  failure?: 'error' | 'refusal'
}

export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
])

// The sentences Claude Code itself writes when the person rejects a call at the permission
// dialog, or a permission rule denies it: the person's choice, not a tool error. Matched at
// the start of the result only, so a tool's own output mentioning a denial is still an error.
const USER_REJECTION =
  /^(?:<tool_use_error>)?\s*(?:The user doesn't want to (?:proceed with this tool use|take this action right now)|Permission to use \S[^\n]*? has been denied|Permission for this )/

export function isUserRejection(text: string | undefined): boolean {
  return text !== undefined && USER_REJECTION.test(text.trimStart())
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
}

/**
 * Lines one successful edit call added and removed: a structuredPatch's `+`/`-` lines,
 * or for a Write that created a file with no hunks, the content's lines.
 */
export function editLines(tool: string, input: unknown, result: unknown): LineStats {
  const hunks = field(result, 'structuredPatch')
  let added = 0
  let deleted = 0
  if (Array.isArray(hunks)) {
    for (const hunk of hunks) {
      const lines = field(hunk, 'lines')
      if (!Array.isArray(lines)) continue
      for (const line of lines) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) added += 1
        else if (line.startsWith('-')) deleted += 1
      }
    }
  }
  if (tool === 'Write' && added + deleted === 0) {
    const content = field(input, 'content')
    if (typeof content === 'string') added = lineCount(content)
  }
  return { added, deleted }
}

export function titleFor(totalLines: number): string {
  if (totalLines >= 500) return '⚔ LEGENDARY SESSION ⚔'
  if (totalLines >= 200) return '★ EPIC SESSION ★'
  if (totalLines >= 50) return '◆ GOOD SESSION ◆'
  return 'SESSION COMPLETE'
}

export function titleOf(s: TurnStats): string {
  if (s.failure !== undefined) return `✗ TURN FAILED (${s.failure})`
  return titleFor(s.lines.added + s.lines.deleted)
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.trunc(n))
}

export function bodyLines(s: TurnStats): string[] {
  const lines = [
    `🧠 out ${fmt(s.outTokens)} · in ${fmt(s.inTokens)} · cache r ${fmt(s.cacheReadTokens)} / w ${fmt(s.cacheWriteTokens)}`,
    `✏ ${s.edits} edits · +${s.lines.added} / -${s.lines.deleted} lines (Edit/Write)`,
  ]
  if (s.errors > 0) lines.push(`⚠ ${s.errors} tool errors`)
  return lines
}
