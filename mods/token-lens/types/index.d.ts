export type LensTokenKind = 'color' | 'length' | 'font' | 'other'

/** A registered design token, its value resolved. */
export type LensToken = { name: string; value: string; kind: LensTokenKind; source: string }

/** One property of an element against the tokens. */
export type LensCheck = {
  property: string
  value: string
  /** token: equal to a token; off: a value no token has; skip: nothing to check (0, transparent, normal). */
  status: 'token' | 'off' | 'skip'
  /** The tokens it equals. */
  tokens: string[]
  /** For an off-token value, the closest token and how far off (colour distance, or px). */
  nearest?: { name: string; value: string; distance: number }
}

export type LensElement = { label: string; checks: LensCheck[] }

export type LensReport = { at: number; query: string; url?: string; elements: LensElement[]; note?: string }

declare module 'claude-code' {
  interface PluginState {
    'token-lens': {
      tokens: LensToken[]
      report: LensReport | null
      /** The browser tab Claude drove last, as its calls named it. */
      tabId: number | null
    }
  }
}
