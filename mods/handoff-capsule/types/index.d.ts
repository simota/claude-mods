/** A command the session ran, and whether it passed. */
export type CapsuleCommand = { command: string; isOk: boolean }

/** The parts a capsule holds, each one the person may bring back or leave. */
export type CapsuleSection = 'goal' | 'decisions' | 'open' | 'commands' | 'files'

/** What a session leaves for the one that resumes it. */
export type Capsule = {
  id: string
  at: number
  sessionId: string
  /** The repository root (or the folder) it belongs to, and the branch then. */
  root: string
  branch?: string
  /** Why it was made. */
  reason: 'compact' | 'end' | 'manual'
  /** The first request of the session and the latest, as the person typed them. */
  goal: string[]
  /** Lines of Claude's replies that settled something. */
  decisions: string[]
  /** What is left: the todo list's open items, #TODO(agent) lines, lines that say something remains. */
  open: string[]
  /** Commands worth running again: checks, builds, runs; the last outcome of each. */
  commands: CapsuleCommand[]
  /** Files edited or made, most edited first. */
  files: string[]
}

/** What the session has seen so far, from which a capsule is made. */
export type CapsuleLog = {
  prompts: string[]
  decisions: string[]
  open: string[]
  todos: { content: string; status: string }[]
  commands: CapsuleCommand[]
  files: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'handoff-capsule': {
      log: CapsuleLog
      /** A capsule offered for bringing back, and the parts chosen so far. */
      offer: { capsule: Capsule; sections: CapsuleSection[] } | null
      /** Text chosen to go to Claude beside the next prompt typed. */
      pending: string | null
    }
  }
}
