export type Action = {
  key: string
  label: string
  prompt: string
  mode: 'submit' | 'fill'
  when: 'edits' | 'always'
}

export const DEFAULT_ACTIONS: readonly Action[] = [
  {
    key: '1',
    label: 'テスト実行',
    prompt: '変更に関係するテスト・lint・型チェックを実行して結果を報告して',
    mode: 'submit',
    when: 'edits',
  },
  { key: '2', label: '差分レビュー', prompt: '/code-review', mode: 'submit', when: 'edits' },
  { key: '3', label: 'コミット', prompt: '変更をコミットして', mode: 'fill', when: 'edits' },
  { key: 'c', label: '続けて', prompt: '続けて', mode: 'submit', when: 'always' },
]

// `x` is the dismiss Button's.
const KEY = /^[0-9a-wyz]$/

const isAction = (value: unknown): value is Action => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const a = value as Record<string, unknown>
  return (
    typeof a.key === 'string' &&
    KEY.test(a.key) &&
    typeof a.label === 'string' &&
    a.label.trim() !== '' &&
    typeof a.prompt === 'string' &&
    a.prompt.trim() !== '' &&
    (a.mode === 'submit' || a.mode === 'fill') &&
    (a.when === 'edits' || a.when === 'always')
  )
}

/** The configured actions, or the defaults with the reason the setting was not used. */
export const parseActions = (raw: unknown): { actions: readonly Action[]; error?: string } => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { actions: DEFAULT_ACTIONS }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { actions: DEFAULT_ACTIONS, error: 'actions が JSON として読めません' }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isAction)) {
    return { actions: DEFAULT_ACTIONS, error: 'actions の形式が不正です' }
  }
  if (new Set(parsed.map(a => a.key)).size !== parsed.length) {
    return { actions: DEFAULT_ACTIONS, error: 'actions の key が重複しています' }
  }
  return { actions: parsed }
}

export const actionsFor = (actions: readonly Action[], hasEdits: boolean) =>
  actions.filter(a => a.when === 'always' || hasEdits)

/** `/name args` as a slash command run, or undefined for a plain prompt. */
export const slashCommand = (prompt: string) => {
  const match = /^\/([^\s/]+)\s*([\s\S]*)$/.exec(prompt.trim())
  return match === null ? undefined : { command: match[1] ?? '', args: match[2] ?? '' }
}
