/** Wall-clock time of each finished Bash call, by tool_use_id; the newest few hundred. */
export type ToolRowDurations = Record<string, number>

declare module 'claude-code' {
  interface PluginState {
    'tool-row': { durations: ToolRowDurations }
  }
}
