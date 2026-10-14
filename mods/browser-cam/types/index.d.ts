/** What the pane's Image draws: the PNG bytes themselves, or a PNG file this plugin wrote. */
export type BrowserCamSource = { png: string } | { file: string; format: 'png'; generation: number }

export type BrowserCamFrame = {
  /** The tool call whose result held the screenshot. */
  toolUseId: string
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
    }
  }
}
