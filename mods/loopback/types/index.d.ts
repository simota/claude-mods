export type LoopbackFinding = {
  source: 'self-audit' | 'done-gate' | 'sandbox-lens'
  /** Names the finding for this session, so the same one is fed once. */
  key: string
  text: string
}

/** The self-audit rules fed after reply `turnId`, waiting for a later reply's audit. */
export type LoopbackPending = { turnId: string; rules: string[] }

/** Across sessions: rules fed, rules flagged again on the next audited reply, and checks made. */
export type LoopbackOutcomes = { fed: number; repeated: number; checks: number }

export type LoopbackLast = { at: number; findings: LoopbackFinding[] }

declare module 'claude-code' {
  interface PluginState {
    loopback: {
      /** Keys of the findings fed this session. */
      fed: string[]
      /** The latest feed, for /loopback. */
      last: LoopbackLast | null
      pending: LoopbackPending | null
    }
  }
}
