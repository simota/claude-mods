export type Sample = {
  percent: number
  /** The context the last request of the turn carried. */
  tokens: number
  window: number
  /** The turn's totals over all its requests: absent when the turn reported no usage. */
  input?: number
  output?: number
  costUsd?: number
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      samples: Sample[]
    }
  }
}
