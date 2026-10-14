export type SelfAuditViolation = {
  rule: string
  quote: string
  why: string
}

export type SelfAuditUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Where the audit of the latest main-loop reply stands: none yet, running, done (the findings
 * are its), or skipped with the reason, so the pane never shows an older reply's findings as
 * the latest's.
 */
export type SelfAuditLatest =
  | { status: 'none' }
  | { status: 'pending'; turnId: string }
  | { status: 'audited'; turnId: string }
  | { status: 'skipped'; turnId: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'self-audit': {
      /** The findings of the audit `latest` names; empty unless it is `audited`. */
      violations: SelfAuditViolation[]
      /** Whether the band above the prompt shows them. */
      isShown: boolean
      /** What the latest audit's fork cost; null unless it is `audited`. */
      usage: SelfAuditUsage | null
      /** Which reply the stored result belongs to, and whether it was audited. */
      latest: SelfAuditLatest
    }
  }
}
