/** A screenshot kept for comparing: the page it shows, its size, and its files. */
export type VdShot = {
  id: string
  seq: number
  at: number
  /** The page's URL when it was taken; empty when it could not be told, and such a shot is never paired. */
  url: string
  width: number
  height: number
  /** The picture as PNG, and a copy scaled down to BMP for comparing, in the session's folder. */
  png: string
  bmp?: string
}

/** A file the session edited, and when. */
export type VdEdit = { path: string; at: number }

/** A changed area, in the screenshot's own pixels. */
export type VdRegion = { x: number; y: number; width: number; height: number }

/** The latest comparison. */
export type VdDiff = {
  before: VdShot
  after: VdShot
  /** The grid of cells, one string per row, `1` where the cell changed. */
  cells: string[]
  regions: VdRegion[]
  /** The share of cells that changed, in percent. */
  changedPct: number
  /** Files edited between the two shots. */
  edits: string[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'visual-diff': {
      shots: VdShot[]
      edits: VdEdit[]
      /** The page the browser shows now, as the last navigation or tab listing said. */
      url: string
      /** Set after an action that may have left that page (a click, a key): the URL is checked again before a shot is filed. */
      isStale: boolean
      diff: VdDiff | null
      /** A screenshot the person chose to compare later ones against, per URL and size. */
      baselines: Record<string, string>
      note: string | null
    }
  }
}
