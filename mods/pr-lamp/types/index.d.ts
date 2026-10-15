/** One check on the head commit, as the rollup has it. */
export type PrCheck = {
  name: string
  state: 'pass' | 'fail' | 'pending' | 'skip'
  /** Where it ran, when GitHub says. */
  url?: string
}

/** One unresolved review thread. */
export type PrThread = {
  /** The thread and its latest comment that is not the session's reply: a new one makes a new key. */
  key: string
  path: string
  line: number | null
  /** Who wrote its latest comment that is not the session's reply. */
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
  /** False when gh could not read the threads at first sight: the first read is then a baseline. */
  areThreadsRead?: boolean
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'pr-lamp': {
      /** The pull request shown, null when there is none. */
      snapshot: PrSnapshot | null
      /** Why nothing is shown (no gh, no remote, no pull request), for the pane. */
      problem: string | null
      /** The pull request the session works on beside its branch's (a number, URL or branch), null when none. */
      pinned: string | null
      /** What changed for the worse since the last prompt, waiting to go to Claude. */
      feed: string[]
      /** The URL of the pull request the feed is about; it is not handed over under another's. */
      feedFor: string | null
      /** The words of comments the session posted and not yet found on a thread (cut as compared). */
      posted: string[]
      /** The ids of comments found to be the session's: never its news. */
      mine: string[]
    }
  }
}
