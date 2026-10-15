/** One side of a comparison: the measured runs of a command in one tree. */
export type PerfSample = {
  /** Where it ran: `HEAD~1` (a worktree), `基準` (a saved baseline) or `現在`. */
  label: string
  command: string
  at: number
  /** Wall time of each measured run, in milliseconds. */
  timesMs: number[]
  /** Peak resident memory of each run, in bytes, where /usr/bin/time reported it. */
  rssBytes: number[]
}

/** A /perf comparison, as the pane draws it. */
export type PerfReport = {
  status: 'running' | 'done' | 'failed'
  command: string
  before?: PerfSample
  after?: PerfSample
  /** What is running now, or why it failed. */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'perf-delta': {
      report: PerfReport | null
    }
  }
}
