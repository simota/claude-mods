export type SandboxLensKind = 'network' | 'file-write' | 'file-read' | 'eperm'

export type SandboxLensDenial = {
  kind: SandboxLensKind
  target: string
  count: number
  lastSeen: number
  example: string
}

declare module 'claude-code' {
  interface PluginState {
    'sandbox-lens': { denials: SandboxLensDenial[] }
  }
}
