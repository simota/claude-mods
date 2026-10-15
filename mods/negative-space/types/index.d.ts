/** Code an edit added that calls for a test of what it refuses or where it breaks. */
export type NegativeTrigger = {
  /** auth: who may do it; validation: what input is taken; error: what happens when it fails. */
  kind: 'auth' | 'validation' | 'error'
  /** The source file, as the tool named it. */
  path: string
  /** The added line that triggered it, clipped. */
  line: string
  /** Numbers the line compares against or bounds by: each wants N-1, N and N+1 tried. */
  bounds: number[]
  /** What a test of it would name: the function the line sits in, and the names on the line. */
  names: string[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'negative-space': {
      /** Triggers from this session's edits, newest last, one per path, kind and line. */
      triggers: NegativeTrigger[]
      /** Test file path to the text this session's edits added to it. */
      tests: Record<string, string>
      /** Keys of candidates the person dismissed. */
      dismissed: string[]
      /** Whether the band is up: set when a turn ends with open candidates. */
      isShown: boolean
    }
  }
}
