/** One way an edit may have weakened a test, as the diff of that edit shows it. */
export type GuardFinding = {
  /** removed: an assertion went away; loosened: a strict matcher became a weaker one;
   *  rewritten: the same assertion now expects another value; skipped: a test was skipped or
   *  focused; swallowed: an error is now caught and dropped. */
  kind: 'removed' | 'loosened' | 'rewritten' | 'skipped' | 'swallowed'
  /** The file, as the tool named it. */
  path: string
  /** The line before the edit (absent for an addition) and after it (absent for a removal). */
  before?: string
  after?: string
}

/** One edit's findings, and whether the person has looked at them. */
export type GuardEntry = {
  id: string
  at: number
  path: string
  findings: GuardFinding[]
  isReviewed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'assertion-guard': {
      /** This session's flagged edits, oldest first. */
      entries: GuardEntry[]
    }
  }
}
