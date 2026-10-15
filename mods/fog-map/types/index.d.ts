/** What the session did to one file of the repository. */
export type FogFile = {
  /** Times it was read (Read, or a reader such as cat or sed in Bash). */
  reads: number
  /** Times it was edited (Edit, Write, NotebookEdit, sed -i). */
  edits: number
  /** Lines added and removed by those edits, as the edits' own text counts them. */
  added: number
  removed: number
  /** Errors a failed Bash command named it in since it was last edited. */
  errors: number
  /** Made by this session: it did not exist before the first write. */
  isNew: boolean
  /** When it was last touched. */
  at: number
}

/** The repository the map is of. */
export type FogRepo = {
  root: string
  name: string
  branch: string
  /** Its files, repository-relative, as `git ls-files` lists them. */
  files: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'fog-map': {
      repo: FogRepo | null
      /** Repository-relative path to what the session did to it. */
      touched: Record<string, FogFile>
      /** The file touched last: the map's ★. */
      focus: string | null
      /** Edited file to the files that import it, as git grep found them. */
      importers: Record<string, string[]>
      /** Areas already announced, and the highest milestone reached (percent). */
      areas: string[]
      milestone: number
    }
  }
}
