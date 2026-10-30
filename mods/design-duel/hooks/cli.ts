import type { Duelist } from '../types'

// How each CLI is started and how its output is read: review-mods' way, as each CLI prints the same here.

export const DUELISTS: readonly Duelist[] = ['claude', 'codex', 'agy']

/** The duelists an option names, in their fixed order; none named, or none known, is all three. */
export const duelistsOf = (option: unknown): Duelist[] => {
  const named = typeof option === 'string' ? option.split(',').map(name => name.trim().toLowerCase()) : []
  const chosen = DUELISTS.filter(d => named.includes(d))
  return chosen.length === 0 ? [...DUELISTS] : chosen
}

export const names = (duelists: readonly Duelist[]) => duelists.join('・')

// Codex runs on a fixed model and effort; claude and agy on their own default model, at the same effort.
const CODEX_MODEL = 'gpt-6.1-sol'
const EFFORT = 'medium'

/** The agent agy runs as, in the workspace the mod ships (`agy/` in the plugin): only the tools that read. */
export const AGY_AGENT = 'design_duel'

/**
 * Every duelist reads the repository and writes nothing. codex runs a plain `exec` in its read-only sandbox,
 * outside a git repository too (where a duel may run, unlike a review);
 * claude in print mode with only the tools that read and none of the person's settings; agy as the read-only
 * agent of the mod's own workspace, the repository added beside it. `-p` comes last, so the prompt is never
 * read as an option's value.
 */
export const duelArgv = (duelist: Duelist, prompt: string, schema: { path: string; value: object }, root: string): string[] => {
  switch (duelist) {
    case 'codex':
      return ['codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '--ephemeral', '--output-schema', schema.path, '-m', CODEX_MODEL, '-c', `model_reasoning_effort="${EFFORT}"`, prompt]
    case 'claude':
      return [
        'claude',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--tools',
        'Read,Grep,Glob',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--permission-mode',
        'dontAsk',
        '--json-schema',
        JSON.stringify(schema.value),
        '--effort',
        EFFORT,
        '-p',
        prompt,
      ]
    case 'agy':
      return ['agy', '--output-format', 'stream-json', '--json-schema', schema.path, '--agent', AGY_AGENT, '--add-dir', root, '--sandbox', '--effort', EFFORT, '-p', prompt]
  }
}

const encoder = new TextEncoder()
export const bytes = (text: string) => encoder.encode(text).length

/** The longest start of text within max UTF-8 bytes, never ending inside a surrogate pair. */
export const cutToBytes = (text: string, max: number) => {
  if (bytes(text) <= max) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytes(text.slice(0, mid)) <= max) low = mid
    else high = mid - 1
  }
  const code = text.charCodeAt(low - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? low - 1 : low)
}

// FNV-1a: it only orders the labels, it guards nothing.
export const hash = (text: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Splits streamed text into whole lines: a piece may end mid-line. */
export const lineSplitter = () => {
  let rest = ''
  return (text: string) => {
    const lines = (rest + text).split('\n')
    rest = lines.pop() ?? ''
    return lines.filter(line => line.trim() !== '')
  }
}

export type Seen = { phase?: string; message?: string; failure?: string }

const shortCommand = (command: string) =>
  command.replace(/^\/bin\/\w+ -lc /, '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').slice(0, 60)

const parsed = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

type CodexEvent = { type?: string; item?: { type?: string; command?: string; text?: string }; error?: { message?: string }; message?: string }

/** What one JSONL event of `codex exec --json` says: progress, the last message, or why it failed. */
export const readCodexEvent = (line: string): Seen => {
  const event = parsed(line) as CodexEvent | undefined
  const item = event?.item
  if (event?.type === 'item.started' && item?.type === 'command_execution' && item.command !== undefined) {
    return { phase: `実行: ${shortCommand(item.command)}` }
  }
  if (event?.type === 'item.completed' && item?.type === 'reasoning' && item.text !== undefined) {
    return { phase: item.text.replace(/\*\*/g, '').trim().slice(0, 60) }
  }
  if (event?.type === 'item.completed' && item?.type === 'agent_message' && item.text !== undefined) {
    return { message: item.text }
  }
  if (event?.type === 'turn.failed') {
    return { failure: event.error?.message ?? 'turn failed' }
  }
  if (event?.type === 'error') {
    return { failure: event.message ?? 'error' }
  }
  return {}
}

type Block = { type?: string; name?: string; input?: Record<string, unknown> }
type PrintEvent = { type?: string; subtype?: string; is_error?: boolean; result?: unknown; structured_output?: unknown; message?: { content?: Block[] } }

/** What one event of claude's `--output-format stream-json` says: a tool use is progress, the result carries the answer. */
export const readPrintEvent = (line: string): Seen => {
  const event = parsed(line) as PrintEvent | undefined
  if (event?.type === 'assistant') {
    const use = (event.message?.content ?? []).filter(block => block.type === 'tool_use' && block.name !== 'StructuredOutput').pop()
    if (use?.name === undefined) return {}
    const input = use.input ?? {}
    const what = [input.command, input.file_path, input.pattern, input.path].find(value => typeof value === 'string') as string | undefined
    return { phase: what === undefined ? use.name : `${use.name}: ${shortCommand(what)}` }
  }
  if (event?.type === 'result') {
    if (event.is_error === true || (event.subtype !== undefined && event.subtype !== 'success')) {
      return { failure: typeof event.result === 'string' && event.result !== '' ? event.result : (event.subtype ?? 'error') }
    }
    if (event.structured_output !== undefined && event.structured_output !== null) return { message: JSON.stringify(event.structured_output) }
    if (typeof event.result === 'string') return { message: event.result }
  }
  return {}
}

type AgyEvent = {
  event?: string
  step_update?: { step_type?: string; state?: string; tool_name?: string; tool_info?: { parameters?: Record<string, unknown> } }
  result?: { status?: string; response?: string; structured_output?: unknown; denied_actions?: { display_name?: string }[] }
}

/** What one event of agy's `--output-format stream-json` says: a tool step is progress, the result carries the answer. */
export const readAgyEvent = (line: string): Seen => {
  const event = parsed(line) as AgyEvent | undefined
  const step = event?.step_update
  if (event?.event === 'step_update' && step?.step_type === 'tool' && step.state === 'ACTIVE' && step.tool_name !== undefined) {
    const input = step.tool_info?.parameters ?? {}
    const what = [input.CommandLine, input.Path, input.Query, input.SearchPath].find(value => typeof value === 'string') as string | undefined
    return { phase: what === undefined ? step.tool_name : `${step.tool_name}: ${shortCommand(what)}` }
  }
  const result = event?.event === 'result' ? event.result : undefined
  if (result === undefined) return {}
  if (result.status === 'SUCCESS' && result.structured_output !== undefined && result.structured_output !== null) {
    return { message: JSON.stringify(result.structured_output) }
  }
  const denied = (result.denied_actions ?? []).map(action => action.display_name).filter(name => name !== undefined)
  if (denied.length > 0) return { failure: `操作が拒否され、回答なしで終わりました（${denied.join('・')}）` }
  return { failure: result.status === 'SUCCESS' ? 'スキーマに沿った回答がありません' : (result.status ?? 'error') }
}

export const readEvent = (duelist: Duelist, line: string) =>
  duelist === 'codex' ? readCodexEvent(line) : duelist === 'claude' ? readPrintEvent(line) : readAgyEvent(line)

const LOGIN: Record<Duelist, string> = {
  claude: 'claude のログインが必要（claude /login）',
  codex: 'codex login が必要',
  agy: 'agy のログインが必要',
}

const MISSING = /ENOENT|not found|no such file/i

/** Why one duelist's run failed, in the words the band shows. */
export const failureText = (duelist: Duelist, stderr: string, failure: string | undefined, code: number | null) => {
  const said = `${failure ?? ''}\n${stderr}`
  if (/not logged in|\blogin\b|401|unauthorized|invalid api key/i.test(said)) {
    return LOGIN[duelist]
  }
  const tail = (failure ?? stderr.trim().split('\n').slice(-1)[0] ?? '').trim()
  return tail === '' ? `${duelist} が終了コード ${code ?? '?'} で終わりました` : tail.slice(0, 200)
}

/** Why a duelist could not be started at all. */
export const startFailureText = (duelist: Duelist, err: unknown) => (MISSING.test(String(err)) ? `${duelist} が見つかりません（PATH）` : String(err).slice(0, 200))

export const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
