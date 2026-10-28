export type Severity = 'high' | 'medium' | 'low'

export type Finding = { id: string; file: string; line: number; severity: Severity; title: string; body: string }

/** What a press reviews: the working tree against the base it forked from, or the uncommitted changes when there is no base. */
export type Scope = { kind: 'uncommitted' } | { kind: 'base'; base: string; mergeBase: string }

export type Diff = { key: string; scope: Scope; files: number; insertions: number; deletions: number }

export type Run = { key: string; startedAt: number; elapsedS: number; phase: string }

export type Result = { key: string; scope: Scope; findings: Finding[]; summary: string; finishedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'cross-check': {
      diff: Diff | null
      run: Run | null
      result: Result | null
      error: string | null
      measurementError: string | null
      dismissed: string[]
      /** The closed diff key, or error:<message> when only a failure's band was dismissed. */
      hiddenFor: string | null
    }
  }
}
