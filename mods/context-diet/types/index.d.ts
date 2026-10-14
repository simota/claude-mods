/** `config` follows the `enabled` option; `on` and `off` are the session's own override. */
export type ContextDietMode = 'config' | 'on' | 'off'

/** A skill entry the listing left out: its name and the lines the model would have read. */
export type ContextDietEntry = { name: string; text: string }

/** What the last listing came to, filtered or not: written for every listing the session sends. */
export type ContextDietStats = {
  /** Whether context-diet was on for that listing. */
  isActive: boolean
  /** On, but the listing's shape was not certain enough to cut: it went as it came. */
  isUncertain: boolean
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
