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

declare module 'claude-code' {
  interface PluginState {
    'self-audit': {
      /** The last audit's findings; the pane lists them. */
      violations: SelfAuditViolation[]
      /** Whether the band above the prompt shows them. */
      isShown: boolean
      /** What the last fork cost. */
      usage: SelfAuditUsage | null
    }
  }
}
