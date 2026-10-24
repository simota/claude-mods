/** One failed step (or a job that failed outside any step), with the last lines it printed. */
export type Failure = { id: string; workflow: string; jobId: string; step: string; tail: string[] }

export type JobResult = { job: string; result: string }

/**
 * The tree a run would see, the event it runs (the configured one, or the first listed one that
 * triggers jobs here when that triggers none), and how many jobs; `key` tells one tree from another.
 */
export type Tree = { key: string; event: string; jobs: number }

export type Run = { key: string; startedAt: number; elapsedS: number; job: string; done: number; total: number; only?: string }

export type Result = { key: string; event: string; ok: boolean; jobs: JobResult[]; failures: Failure[]; secs: number; only?: string }

/** Why the last press gave no result: Docker not running, or anything else in words. */
export type Problem = ({ kind: 'no-docker' } | { kind: 'other' | 'measurement'; text: string }) & { isDismissed?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'ci-rehearsal': {
      tree: Tree | null
      run: Run | null
      result: Result | null
      /** Latest partial results, kept separately so they never stand for a full CI run. */
      partial: Result | null
      /** A failed measurement does not erase the last run's incomplete outcome. */
      measurementProblem: Problem | null
      problem: Problem | null
      /** The tree key the band was closed for: it stays down until the tree changes. */
      hiddenFor: string | null
    }
  }
}
