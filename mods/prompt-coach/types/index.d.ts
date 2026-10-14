export type PromptCoachHeld = {
  text: string
  missing: string[]
  rewrite?: string
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-coach': {
      held: PromptCoachHeld | null
      judged: string[]
      followUps: string[]
    }
  }
}
