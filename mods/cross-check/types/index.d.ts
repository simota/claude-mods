export type Severity = 'high' | 'medium' | 'low'

export type Finding = { id: string; file: string; line: number; severity: Severity; title: string; body: string }

/** What a press reviews: the uncommitted changes, or the branch against its base when nothing is uncommitted. */
export type Scope = { kind: 'uncommitted' } | { kind: 'base'; base: string }

export type Diff = { key: string; scope: Scope; files: number; insertions: number; deletions: number }

export type Run = { key: string; startedAt: number; elapsedS: number; phase: string }

export type Result = { key: string; scope: Scope; findings: Finding[]; summary: string; finishedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'cross-check': {
      diff: Diff | null
      run: Run | null
      result: Result | null
      error: string | null
      dismissed: string[]
      /** The diff key the band was closed for: it stays down until the diff changes. */
      hiddenFor: string | null
    }
  }
}
