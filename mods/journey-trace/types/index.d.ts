/** What a step points at: an element as the page described it, or a place on the screen. */
export type JourneyTarget = { ref?: string; role?: string; name?: string; x?: number; y?: number }

/** One step of a journey. */
export type JourneyStep =
  | { kind: 'goto'; url: string; at: number }
  | { kind: 'click'; target: JourneyTarget; button: 'left' | 'right' | 'double'; url: string; at: number }
  | { kind: 'type'; text: string; target?: JourneyTarget; url: string; at: number }
  | { kind: 'key'; key: string; url: string; at: number }
  | { kind: 'fill'; target: JourneyTarget; value: string; url: string; at: number }
  | { kind: 'scroll'; direction: string; url: string; at: number }
  | { kind: 'expect'; text: string; url: string; at: number; by: 'person' | 'claude' }

export type Journey = {
  name: string
  startedAt: number
  isRecording: boolean
  steps: JourneyStep[]
  /** The size of the page's window, when a screenshot or a resize said it. */
  viewport?: { width: number; height: number }
}

declare module 'claude-code' {
  interface PluginState {
    'journey-trace': {
      journey: Journey
      /** Elements the page described (`ref_12` → button "Save"), from find and read_page. */
      refs: Record<string, { role?: string; name?: string }>
      url: string
    }
  }
}
