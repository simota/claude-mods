/** A server a Bash command of the session started. */
export type LanternServer = {
  /** The background task's id, or the call's id for a foreground one. */
  id: string
  command: string
  startedAt: number
  /** Where the background task writes its output, as the Bash result named it. */
  outputPath?: string
  /** Local URLs its output or command named, first seen first. */
  urls: string[]
  /** Ports from those URLs, the command (`--port 3000`, `PORT=3000`) or its output. */
  ports: number[]
  /** listening: a port is open; down: none of its ports is; unknown: no port seen yet. */
  state: 'listening' | 'down' | 'unknown'
  /** The process listening, as lsof names it. */
  pid?: number
  process?: string
  /** The latest lines of its output, colours taken out. */
  tail: string[]
  /** When the state last changed. */
  changedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'port-lantern': {
      servers: LanternServer[]
    }
  }
}
