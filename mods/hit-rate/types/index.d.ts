/** What happened after a finding: it held (tp), it did not (fp), or nothing observable decided it. */
export type HitVerdictKind = 'tp' | 'fp' | 'unknown'

export type HitVerdict = {
  /** The detector's rule: `done-gate:unverified`, `assertion-guard:<kind>`, `self-audit:R1`, `zukan:recall`. */
  rule: string
  verdict: HitVerdictKind
  /** The outcome that decided it, in a few words. */
  why: string
  at: number
}

/** Across sessions: each rule's verdict counts. */
export type HitTable = Record<string, { tp: number; fp: number; unknown: number }>

/** done-gate's unverified flag: not raised, raised and waiting for a check, or decided while the flag still stands. */
export type HitDoneGate = 'idle' | 'open' | 'settled'

/** A line of the edited file and how many times it occurred when the finding was opened. */
export type HitMark = { side: 'before' | 'after'; line: string; count: number }

/** One finding's rule (`assertion-guard:<kind>`) and its before and after lines. */
export type HitMarks = { rule: string; before?: HitMark; after?: HitMark }

/** One assertion-guard entry waiting for a revert or a review left standing. */
export type HitAssertion = {
  path: string
  /** The rules still open: a rule leaves once its weakening is undone. */
  rules: string[]
  /** Per finding: its rule, and its before line and after line as counted in the file. */
  marks: HitMarks[]
  /** The turn number when the person was first seen to have reviewed it. */
  reviewedTurn?: number
}

/** The rules self-audit flagged on its latest audited reply, waiting for the next audited reply. */
export type HitAudit = { turnId: string; rules: string[] }

/** A recalled zukan fix waiting for the error to be got past. */
export type HitRecall = { key: string; failed: string; suggested: string; openedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'hit-rate': {
      /** Mirror of the stored table, for /hit-rate and for loopback. */
      table: HitTable
      /** Rules with enough verdicts and a precision below the threshold: loopback does not feed them. */
      muted: string[]
      doneGate: HitDoneGate
      assertions: Record<string, HitAssertion>
      /** assertion-guard entry ids already opened, so a settled one is not opened again. */
      seen: string[]
      audit: HitAudit | null
      recalls: Record<string, HitRecall>
      /** Main-loop turns started this session. */
      turn: number
      /** The latest verdicts of this session, newest last. */
      last: HitVerdict[]
    }
  }
}
