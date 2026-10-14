export type BattleReportTurn = {
  turnId: string
  edits: number
  errors: number
  tools: number
}

declare module 'claude-code' {
  interface PluginState {
    'battle-report': { turn: BattleReportTurn }
  }
}
