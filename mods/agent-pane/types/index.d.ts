export type AgentRunStatus = 'running' | 'completed' | 'failed'

export type AgentRun = {
  /** The Agent call's tool_use_id. */
  id: string
  /** The spawned agent's id, once the call names it (background runs). */
  agentId?: string
  type: string
  description: string
  startedAt: number
  endedAt?: number
  status: AgentRunStatus
}

declare module 'claude-code' {
  interface PluginState {
    'agent-pane': { runs: AgentRun[]; now: number }
  }
}
