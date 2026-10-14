/** How an error was got past: the command that then succeeded, or a note the person wrote. */
export type ZukanFix = {
  /** The succeeding command, credentials masked and cut to a line. */
  command: string
  /** Whether it ran outside the sandbox. */
  isSandboxOff: boolean
  repo: string
  at: number
}

/** One kind of error, as caught across sessions and repos. */
export type ZukanEntry = {
  /** Its number in the book, given once and never reused. */
  no: number
  /** The normalised signature that tells kinds apart. */
  key: string
  /** The program and subcommand that raised it (`git push`). */
  program: string
  /** The error line as first seen, cut to a line. */
  line: string
  count: number
  firstSeen: number
  lastSeen: number
  /** Where it was seen, most recent last, at most 5. */
  repos: string[]
  fix?: ZukanFix
  note?: string
}

/** An error of this session waiting for the same program to succeed. */
export type ZukanPending = { key: string; failed: string; calls: number }

declare module 'claude-code' {
  interface PluginState {
    zukan: {
      /** The book, mirrored from the store for the pane. */
      entries: ZukanEntry[]
      /** By program: the latest error not yet got past in this session. */
      pending: Record<string, ZukanPending>
    }
  }
}
