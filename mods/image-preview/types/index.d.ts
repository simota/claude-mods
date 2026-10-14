export type ImageItem = {
  /** `path:mtimeMs`: one per version of a file. */
  id: string
  /** Absolute path of the image as the session named it. */
  path: string
  name: string
  size: number
  mtimeMs: number
  width?: number
  height?: number
  /** Absolute path of a PNG the terminal can draw: the file itself, or a converted copy. */
  png?: string
  /** Why no thumbnail is drawn, when none is. */
  skipped?: string
  /** The tool call that wrote, read or produced it. */
  toolUseId: string
}

declare module 'claude-code' {
  interface PluginState {
    'image-preview': {
      /** Newest first. */
      images: ImageItem[]
      /** Index into `images` the pane shows. */
      cursor: number
      /** The images each ToolUse row draws, keyed by tool_use_id. */
      byTool: StateFamily<ImageItem[]>
    }
  }
}
