export type LedgerKind = 'push' | 'publish' | 'deploy' | 'infra' | 'github' | 'api' | 'remote' | 'message'

/** One operation that changed something outside the working tree. */
export type LedgerEntry = {
  id: string
  at: number
  kind: LedgerKind
  /** What it did, short (`git push origin main`, `gh pr create → #42`). */
  label: string
  /** The command or tool call as made, clipped. */
  source: string
  /** Whether it succeeded, and a line of what it answered. */
  isOk: boolean
  outcome: string
  /** How it would be undone, as specific as its output allowed; and how hard that is. */
  undo: string
  reversibility: 'easy' | 'manual' | 'hard'
  /** unchecked: nobody has looked at the undo; confirmed: the person checked it; waived: not needed. */
  undoState: 'unchecked' | 'confirmed' | 'waived'
  sessionId: string
}

declare module 'claude-code' {
  interface PluginState {
    'side-effect-ledger': {
      /** The repository's ledger, newest first, as the store keeps it. */
      entries: LedgerEntry[]
    }
  }
}
