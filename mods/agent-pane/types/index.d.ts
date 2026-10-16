/**
 * `unknown`: the roster dropped a background run before it said how it ended,
 * or a reload lost the call that was waiting on it.
 * `detached`: a teammate or remote launch, which this pane does not follow.
 * `stopped`: a background run the roster reports killed (stopped by the user or Claude).
 */
export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown' | 'detached'

export type AgentRun = {
  /** The Agent call's tool_use_id. */
  id: string
  /** The spawned agent's id, once the call names it (background runs). */
  agentId?: string
  /** Ticks in a row the roster had no entry for `agentId`. */
  misses?: number
  type: string
  description: string
  startedAt: number
  endedAt?: number
  status: AgentRunStatus
}

declare module 'claude-code' {
  interface PluginState {
    'agent-pane': { runs: AgentRun[]; now: number; hasAutoOpened: boolean }
  }
}
