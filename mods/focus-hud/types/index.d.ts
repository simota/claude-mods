/** A tool call under way. */
export type HudCall = { id: string; tool: string; summary: string; startedAt: number; agentId?: string }

/** What the line is drawn from. */
export type HudState = {
  /** The person's latest request, first line. */
  goal: string
  /** The todo list's item in progress, if any. */
  step: string
  /** The file, page or program last acted on. */
  target: string
  /** Whether a turn of the main loop runs, and since when. */
  isRunning: boolean
  turnStartedAt: number
  /** Calls under way, oldest first. */
  calls: HudCall[]
  /** Calls waiting on the person's permission, by id. */
  asking: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'focus-hud': {
      hud: HudState
    }
  }
}
