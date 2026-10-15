export type ShelfKind = 'data' | 'document' | 'image' | 'video' | 'audio' | 'patch' | 'archive'

/** A file a session made, and how it came to be. */
export type ShelfItem = {
  path: string
  kind: ShelfKind
  size: number
  at: number
  /** The tool that made it, and what it ran (`Bash: pandoc -o out.pdf …`, `Write`). */
  tool: string
  event: string
  /** The request it answered: the person's latest prompt then, clipped. */
  purpose: string
  sessionId: string
  /** Set by /shelf when the file is no longer there. */
  isMissing?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'artifact-shelf': {
      /** The shelf of the repository the session is in, newest first, as the store keeps it. */
      items: ShelfItem[]
      /** The person's latest prompt: what a file made now is for. */
      purpose: string
      /** What the pane shows: a kind, or a word to match. */
      filter: { kind: ShelfKind | 'all'; query: string }
    }
  }
}
