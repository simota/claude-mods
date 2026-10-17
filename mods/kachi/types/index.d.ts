export type Tier = 1 | 2 | 3 | 4

/** The language of the stamp and the receipt. */
export type Locale = 'ja' | 'en'

/** A check (`pnpm test`, `tsc`, `make check`) in one directory, as the session last saw it. */
export type CheckRecord =
  | { isRed: false; at: number; dir: string }
  | {
      isRed: true
      at: number
      dir: string
      firstFailAt: number
      failRuns: number
      /** The scope words every failure since red began shares: a pass must run at least these. */
      scope: string[]
      /** Whether a code edit in its directory (or outside every check's) came since it last failed: a win needs one. */
      isCredited: boolean
      firstFailCount?: number
      peakFailCount?: number
    }

/** How many edits the session made, and the count at the last one outside test files. */
export type Edits = { seq: number; codeSeq: number }

export type Band = {
  id: number
  tier: Tier
  kind: 'green' | 'first' | 'commit'
  /** The check's record key ('' for a commit): what a later failure is matched by. */
  key: string
  /** The check's name, or a commit's sha. */
  label: string
  /** The check's directory relative to the session's, '' when it is the session's. */
  where: string
  phase: 'sweep' | 'stamp'
  locale: Locale
}

declare module 'claude-code' {
  interface PluginState {
    kachi: {
      checks: Record<string, CheckRecord>
      edits: Edits
      /** The edit count a passing check last covered; -1 once a check failed since. */
      verifiedSeq: number
      commitTick: { at: number; seq: number }
      lastClipAt: number
      band: Band | null
      /** The one line under a Bash row, by tool_use_id: a win's receipt, or a check's first red of the session. */
      wins: Record<string, string>
      /** The checks whose first red already drew its line. */
      announced: string[]
      nextId: number
    }
  }
}
