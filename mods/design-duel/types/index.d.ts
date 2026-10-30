export type Duelist = 'claude' | 'codex' | 'agy'

/** A design one duelist proposes for the topic. */
export type Proposal = { title: string; summary: string; approach: string; tradeoffs: string; risks: string }

/** Each 1 to 5; risk 5 is the least risky. */
export type Scores = { correctness: number; simplicity: number; risk: number; fit: number }

/** What one judge said of another's proposal, which it saw under its label alone. */
export type Critique = { judge: Duelist; scores: Scores; objection: string }

export type Round = 'propose' | 'critique' | 'revise' | 'rescore'

/** One duelist within a round: still going with what it is doing, finished, or failed. */
export type Lane = { duelist: Duelist; state: 'running' | 'done' | 'failed'; phase: string }

export type Run = { topic: string; round: Round; startedAt: number; elapsedS: number; lanes: Lane[] }

/**
 * One proposal and how it fared: `total` is the mean, over its judges, of the four scores summed (4 to 20),
 * null when no judge scored it. `rebuttal` is its author's answer to the objections when it was revised.
 */
export type Standing = { duelist: Duelist; label: string; proposal: Proposal; rebuttal?: string; critiques: Critique[]; total: number | null }

/**
 * A duel in which at least two proposals stood. `winner` is null on a tie at the top or with no scores;
 * `failures` names who failed in which round, so the result is partial then.
 */
export type Result = {
  topic: string
  standings: Standing[]
  winner: Duelist | null
  isRevised: boolean
  failures: { duelist: Duelist; round: Round; error: string }[]
  finishedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'design-duel': {
      run: Run | null
      result: Result | null
      /** The last duel ended with no result: why, and its topic for 再試行. */
      error: { topic: string; text: string } | null
      /** The band was closed; a new duel shows it again. */
      isHidden: boolean
    }
  }
}
