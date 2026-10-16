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

/** What a test file says, as far as the candidates ask: which cases it tries, its names and numbers. */
export type TestDigest = {
  /** The kinds whose refusal or failure case the file tries (`403`, `invalid`, `toThrow`…). */
  covers: NegativeTrigger['kind'][]
  /** The identifiers in it, each once. */
  words: string[]
  /** The numbers in it, each once (a negative one also without its sign). */
  numbers: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'negative-space': {
      /** Triggers from this session's edits, newest last, one per path, kind and line. */
      triggers: NegativeTrigger[]
      /** Test file path to what it says, as this session's edits and reads have shown it. */
      tests: Record<string, TestDigest>
      /** Keys of candidates the person dismissed. */
      dismissed: string[]
      /** Whether the band is up: set when a turn ends with open candidates. */
      isShown: boolean
    }
  }
}
