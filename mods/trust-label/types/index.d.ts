export type TrustKind = 'web' | 'search' | 'issue' | 'log' | 'browser' | 'service' | 'download'

/** A candidate instruction found in external text: what kind, and the words around it. */
export type TrustSignal = { rule: string; excerpt: string }

/** One result that came from outside, and what was found in it. */
export type TrustSource = {
  id: string
  at: number
  kind: TrustKind
  /** Where it came from: a URL, a host, a command, a service and tool. */
  origin: string
  tool: string
  signals: TrustSignal[]
}

declare module 'claude-code' {
  interface PluginState {
    'trust-label': {
      /** This session's external results, newest last. */
      sources: TrustSource[]
    }
  }
}
