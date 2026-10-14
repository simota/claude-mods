/** One guess at what an ambiguous prompt meant: a short label and the request rewritten. */
export type PromptCoachOption = {
  label: string
  prompt: string
}

export type PromptCoachHeld = {
  text: string
  missing: string[]
  options: PromptCoachOption[]
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
