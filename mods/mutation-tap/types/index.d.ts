/** One small change made to a changed line, and what the tests said of it. */
export type Mutant = {
  /** Repository-relative path and 1-based line. */
  path: string
  line: number
  /** The operator applied, as `===→!==`. */
  operator: string
  /** The line before and after the change, trimmed. */
  original: string
  mutated: string
  /** killed: the tests failed; survived: they passed; timeout: they ran past the limit; skipped: the line had changed. */
  outcome?: 'killed' | 'survived' | 'timeout' | 'skipped'
}

/** A /mutate run. */
export type MutationRun = {
  status: 'running' | 'done' | 'failed' | 'stopped'
  command: string
  root: string
  startedAt: number
  finishedAt?: number
  mutants: Mutant[]
  /** How many have run. */
  ran: number
  /** Why it failed or stopped, or a note on how it went. */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'mutation-tap': {
      run: MutationRun | null
      /** Set while a run is asked to stop after the mutant in hand. */
      isStopping: boolean
    }
  }
}
