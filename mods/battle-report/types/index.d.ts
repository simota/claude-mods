export type BattleReportTurn = {
  turnId: string
  edits: number
  errors: number
  tools: number
  added: number
  deleted: number
}

declare module 'claude-code' {
  interface PluginState {
    'battle-report': { turn: BattleReportTurn }
  }
}
