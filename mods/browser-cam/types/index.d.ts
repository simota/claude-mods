/**
 * What the pane's Image draws: a PNG file this plugin wrote into its private,
 * per-session folder. The bytes themselves never sit in state.
 */
export type BrowserCamSource = { file: string; format: 'png'; generation: number }

export type BrowserCamFrame = {
  /** The tool call whose result held the screenshot. */
  toolUseId: string
  /** The order the call finished in: a frame never replaces a later one. */
  seq: number
  /** The session whose call took it: another session never shows it. */
  sessionId: string
  /** Absent when the screenshot could not be made drawable; `note` says why. */
  source?: BrowserCamSource
  width?: number
  height?: number
  /** The screenshot's media type as the tool reported it. */
  mime: string
  at: number
  note?: string
}

export type BrowserCamAction = {
  id: string
  /** The tool's own name, without the `mcp__<server>__` prefix. */
  tool: string
  /** Its key input, short: action, coordinate, url, text. */
  summary: string
  isOk: boolean
  at: number
}

export type BrowserCamPage = { url?: string; title?: string }

declare module 'claude-code' {
  interface PluginState {
    'browser-cam': {
      /** The latest screenshot only; older ones are dropped. */
      frame: BrowserCamFrame | null
      /** The last 30, oldest first. */
      actions: BrowserCamAction[]
      page: BrowserCamPage
      /** The pane has opened by itself once this session: never again, reload or not. */
      hasAutoOpened: boolean
      /** The last call order handed out: a reload keeps counting from here, so newest-wins holds. */
      seq: number
      /** Sessions that have ended (newest last): work queued for one of them writes nothing. */
      endedSessions: string[]
    }
  }
}
