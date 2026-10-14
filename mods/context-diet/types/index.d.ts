/** `config` follows the `enabled` option; `on` and `off` are the session's own override. */
export type ContextDietMode = 'config' | 'on' | 'off'

/** A skill entry the listing left out: its name and the lines the model would have read. */
export type ContextDietEntry = { name: string; text: string }

/** What the last filtered listing came to. */
export type ContextDietStats = {
  kinds: string[]
  kept: string[]
  dropped: ContextDietEntry[]
  beforeChars: number
  afterChars: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-diet': {
      mode: ContextDietMode
      last: ContextDietStats | null
    }
  }
}
