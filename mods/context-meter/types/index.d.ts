export type Sample = {
  percent: number
  tokens: number
  window: number
  input: number
  output: number
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
