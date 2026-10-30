export type Severity = 'high' | 'medium' | 'low'

export type Reviewer = 'claude' | 'codex' | 'agy'

/** What one reviewer said about a defect. */
export type Opinion = { reviewer: Reviewer; line: number; severity: Severity; title: string; body: string }

/** One defect, with every reviewer's opinion of it; the most severe opinion leads. */
export type Finding = { id: string; file: string; line: number; severity: Severity; title: string; opinions: Opinion[] }

/** What a press reviews: the working tree against the base it forked from, or the uncommitted changes when there is no base. */
export type Scope = { kind: 'uncommitted' } | { kind: 'base'; base: string; mergeBase: string }

export type Diff = { key: string; scope: Scope; files: number; insertions: number; deletions: number }

/** One reviewer within a run: still going with what it is doing, finished with its count, or failed. */
export type Lane = { reviewer: Reviewer; state: 'running' | 'done' | 'failed'; phase: string }

export type Run = { key: string; startedAt: number; elapsedS: number; lanes: Lane[] }

/**
 * A run in which at least one reviewer answered. `failures` names the reviewers that did not:
 * the result is partial then, and its findings never stand for theirs; so is one a reviewer saw only part of.
 */
export type Result = {
  key: string
  scope: Scope
  findings: Finding[]
  /** `isCut`: the diff was too long to hand this reviewer whole, so what it found covers only part. */
  reviews: { reviewer: Reviewer; summary: string; count: number; isCut: boolean }[]
  failures: { reviewer: Reviewer; error: string }[]
  finishedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'review-mods': {
      diff: Diff | null
      run: Run | null
      result: Result | null
      /** Every reviewer failed: there is no result to show. */
      error: string | null
      measurementError: string | null
      dismissed: string[]
      /** The closed diff key, or error:<message> when only a failure's band was dismissed. */
      hiddenFor: string | null
    }
  }
}
