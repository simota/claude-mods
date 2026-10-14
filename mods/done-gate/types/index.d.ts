export type Failure = { tail: string; count: number }

declare module 'claude-code' {
  interface PluginState {
    'done-gate': {
      isPending: boolean
      hasEditedThisTurn: boolean
      isFlagged: boolean
      failures: Record<string, Failure>
      nudged: string[]
    }
  }
}
