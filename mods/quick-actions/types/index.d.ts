export type QuickActionsFlag = boolean

declare module 'claude-code' {
  interface PluginState {
    'quick-actions': {
      isShown: QuickActionsFlag
      hasEdits: QuickActionsFlag
    }
  }
}
