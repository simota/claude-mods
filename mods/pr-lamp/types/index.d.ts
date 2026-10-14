/** One check on the head commit, as the rollup has it. */
export type PrCheck = {
  name: string
  state: 'pass' | 'fail' | 'pending' | 'skip'
  /** Where it ran, when GitHub says. */
  url?: string
}

/** One unresolved review thread. */
export type PrThread = {
  /** The thread and its comment count: a new comment makes a new key. */
  key: string
  path: string
  line: number | null
  /** Who wrote its latest comment. */
  author: string
  /** Its latest comment, cut to a line. */
  body: string
}

/** The branch's pull request as last fetched. */
export type PrSnapshot = {
  branch: string
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or '' when none is required. */
  review: string
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: string
  /** `mergeStateStatus`: `BEHIND`, `CLEAN`, `DIRTY`, `BLOCKED`, ... */
  mergeState: string
  additions: number
  deletions: number
  changedFiles: number
  checks: PrCheck[]
  threads: PrThread[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'pr-lamp': {
      /** The pull request of the session's branch, null when there is none. */
      snapshot: PrSnapshot | null
      /** Why nothing is shown (no gh, no remote, no pull request), for the pane. */
      problem: string | null
      /** What changed for the worse since the last prompt, waiting to go to Claude. */
      feed: string[]
    }
  }
}
