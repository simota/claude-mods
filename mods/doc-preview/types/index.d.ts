/** A document a Write or Edit of the session changed, one docview can show. */
export type Doc = {
  /** Absolute, as the tool call named it. */
  path: string
  /** Relative to the root; null when outside it, where docview cannot serve it. */
  rel: string | null
  edits: number
  /** When it was last changed (ms). */
  at: number
  /** The line the last edit put text at, when it could be found. */
  line?: number
}

/** The docview server this mod uses. `isOwned`: this mod started it, so only this mod stops it. */
export type Server =
  | { kind: 'off' }
  | { kind: 'starting'; port: number }
  | { kind: 'up'; port: number; url: string; isOwned: boolean }
  | { kind: 'failed'; error: string; tail: string[] }

declare module 'claude-code' {
  interface PluginState {
    'doc-preview': {
      /** The served directory: git's top level, else the cwd, symlinks resolved as docview resolves them. */
      root: string | null
      /** Newest last. */
      docs: Doc[]
      server: Server
      /** Paths opened in the browser this session: their tab follows later edits by itself. */
      opened: string[]
      /** Paths changed and never opened, waiting in the band. */
      pending: string[]
    }
  }
}
