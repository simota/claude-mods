// The negative space, pure: what an edit added that refuses, validates or fails, and which
// of the tests it calls for no test this session touched has written yet.

import type { NegativeTrigger } from '../types'

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb|exs?)$|(?:^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(?:swift|kt|java|cs)$/
const SOURCE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|swift|kt|java|cs|php|ex|exs|scala)$/

export const isTestPath = (path: string): boolean => TEST_PATH.test(path)
export const isSourcePath = (path: string): boolean => SOURCE.test(path) && !isTestPath(path)

const PATTERNS: Record<NegativeTrigger['kind'], RegExp> = {
  auth: /\b(?:authori[sz]e\w*|authenticate\w*|isAuthenticated|requireAuth\w*|require_?login|login_required|permission\w*|permitted|can\?|cannot\?|forbid\w*|Forbidden\w*|Unauthori[sz]ed\w*|isAdmin|is_admin|admin_required|ownerId|owner_id|currentUser|current_user|session\.user|policy|@PreAuthorize|@Secured|@RolesAllowed)\b|\b(?:401|403)\b/,
  validation:
    /\b(?:validat\w*|isValid|is_valid|sanitize\w*|BadRequest\w*|ValueError|InvalidArgument\w*|ArgumentError|RangeError|ValidationError|@Valid|@NotNull|@Size|@Min|@Max|Joi\.|yup\.|z\.(?:object|string|number|array|enum|union)|field_validator|validator)\b|\b(?:400|422)\b|\.(?:min|max|length|regex|email|url|uuid|positive|nonnegative|int|nonempty)\(|\bif\s*\(?[^\n]*(?:<=?|>=?)\s*-?\d|\b(?:maxLength|minLength|maximum|minimum|max_length|min_length)\s*[:=]/,
  error:
    /\b(?:catch|except|rescue|recover|throw|raise|panic!|reject|onError|on_error|fallback|retry|retries|timeout|ErrorBoundary)\b|\bErr\(|\breturn\s+(?:nil,\s*)?(?:err|fmt\.Errorf|errors\.New)\b/,
}

/** What a test of that kind says when it tries the refusal, the bad input or the failure. */
const COVERS: Record<NegativeTrigger['kind'], RegExp> = {
  auth: /\b(?:401|403|forbidden|unauthori[sz]ed|denied|deny|not allowed|permission|anonymous|guest|other user|another user|non-?admin|without (?:a )?(?:token|login|session)|logged out)\b|拒否|権限/i,
  validation: /\b(?:invalid|rejects?|throws?|toThrow|raises|assertRaises|pytest\.raises|400|422|empty|blank|too (?:long|short|large|small)|negative|out of range|malformed|boundary)\b|不正|境界|空/i,
  error: /\b(?:throws?|toThrow|rejects?|raises|assertRaises|pytest\.raises|fails?|failure|failing|timeout|times out|retry|Err\b|should_panic|mockRejected\w*|unavailable|500|503)\b|失敗|エラー/i,
}

export const KIND_LABEL: Record<NegativeTrigger['kind'], string> = { auth: '認可', validation: '入力検証', error: 'エラー処理' }

const QUESTION: Record<NegativeTrigger['kind'], string> = {
  auth: '権限のない/未ログイン/他人のリソースで拒否されるか',
  validation: '不正・空・型違いの入力で拒否されるか',
  error: '失敗（例外・タイムアウト・依存先エラー）時にどう振る舞うか',
}

const clip = (text: string, max = 100) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Lines of `after` not matched by an equal line of `before`, trimmed, in order. */
export function addedLines(before: string, after: string): string[] {
  const left = new Map<string, number>()
  for (const line of before.split('\n')) left.set(line.trim(), (left.get(line.trim()) ?? 0) + 1)
  const added: string[] = []
  for (const raw of after.split('\n')) {
    const line = raw.trim()
    const n = left.get(line) ?? 0
    if (n > 0) left.set(line, n - 1)
    else if (line !== '') added.push(line)
  }
  return added
}

const isComment = (line: string) => /^(?:\/\/|\/\*|\*|#(?!\[)|--)/.test(line)
const isImport = (line: string) => /^(?:import\b|from\s+\S+\s+import\b|use\s|require\(|#include|using\s)/.test(line)

/** Numbers a line bounds by: `x > 100`, `.max(255)`, `maxLength: 20`; HTTP statuses left out. */
export function boundsOf(line: string): number[] {
  const found = new Set<number>()
  const pick = (text: string | undefined) => {
    if (text === undefined) return
    const n = Number(text)
    if (Number.isFinite(n) && !(n >= 400 && n < 600 && Number.isInteger(n))) found.add(n)
  }
  for (const m of line.matchAll(/(?:<=?|>=?|===?|!==?)\s*(-?\d+(?:\.\d+)?)\b/g)) pick(m[1])
  for (const m of line.matchAll(/\b(-?\d+(?:\.\d+)?)\s*(?:<=?|>=?)/g)) pick(m[1])
  for (const m of line.matchAll(/\.(?:min|max|length|gte?|lte?|size)\(\s*(-?\d+(?:\.\d+)?)/g)) pick(m[1])
  for (const m of line.matchAll(/\b(?:maxLength|minLength|maximum|minimum|max_length|min_length|max|min)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g)) pick(m[1])
  return [...found]
}

const DECLARATION =
  /(?:\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)|\b(?:def|fn)\s+([A-Za-z_]\w*)|\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:(?:public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{)/
const STOP = new Set(
  'if else for while switch case return throw await async const let var new this self super true false null nil none undefined typeof instanceof catch try except raise rescue finally function def class import from export default value values result results error errors err req res request response status data body item items length string number boolean object array console log ok some none'.split(
    ' ',
  ),
)

/** The function enclosing a line of a file: the nearest declaration above it. */
export function enclosingName(lines: readonly string[], index: number): string | undefined {
  for (let i = index; i >= 0 && i > index - 200; i -= 1) {
    const m = (lines[i] ?? '').match(DECLARATION)
    const name = m?.slice(1).find(Boolean)
    if (name !== undefined && !STOP.has(name.toLowerCase())) return name
  }
  return undefined
}

/** Names worth finding in a test of this line: identifiers of four letters or more, common words left out. */
export function namesOn(line: string): string[] {
  const found = (line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ').match(/[A-Za-z_$][\w$]{3,}/g) ?? []).filter(word => !STOP.has(word.toLowerCase()))
  return [...new Set(found)].slice(0, 5)
}

/** The triggers among the lines an edit added to a source file; `after` is the file (or the edit's text) after it. */
export function triggersOf(path: string, before: string, after: string, at: number): NegativeTrigger[] {
  if (!isSourcePath(path)) return []
  const out: NegativeTrigger[] = []
  const lines = after.split('\n')
  for (const line of addedLines(before, after)) {
    if (isComment(line) || isImport(line)) continue
    const enclosing = enclosingName(lines, lines.findIndex(one => one.trim() === line))
    const names = [...new Set([...(enclosing === undefined ? [] : [enclosing]), ...namesOn(line)])]
    for (const kind of ['auth', 'validation', 'error'] as const) {
      if (!PATTERNS[kind].test(line)) continue
      out.push({ kind, path, line: clip(line), bounds: kind === 'validation' ? boundsOf(line) : [], names, at })
    }
  }
  return out
}

export const keyOf = (one: Pick<NegativeTrigger, 'kind' | 'path' | 'line'>): string => `${one.kind}\u0000${one.path}\u0000${one.line}`

const stemOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.replace(/\.[^.]+$/, '').replace(/(?:[._-](?:test|spec))$|^test_|_test$|Tests?$/i, '').toLowerCase()
}

/** The tests that speak of a source file: the session's test edits whose name holds its stem. */
export function testsFor(path: string, tests: Readonly<Record<string, string>>): string {
  const stem = stemOf(path)
  return Object.entries(tests)
    .filter(([test]) => stem !== '' && stemOf(test).includes(stem))
    .map(([, text]) => text)
    .join('\n')
}

export const MAX_TEST_FILES = 30
export const TEST_TEXT_MAX = 200_000

/**
 * The tests seen, with what one says now: each held to its last TEST_TEXT_MAX characters, and
 * the files to the MAX_TEST_FILES seen latest (a file seen again counts as the newest), so a long
 * session's reading neither grows the state without end nor slows every candidate count.
 */
export function withTest(all: Readonly<Record<string, string>>, path: string, text: string): Record<string, string> {
  const { [path]: _, ...others } = all
  const kept = Object.entries(others).slice(-(MAX_TEST_FILES - 1))
  return { ...Object.fromEntries(kept), [path]: text.slice(-TEST_TEXT_MAX) }
}

/** One test to write: what to try, and why (the trigger line). */
export type Candidate = { key: string; kind: NegativeTrigger['kind']; path: string; line: string; ask: string }

/**
 * The candidates the session's tests leave open: per trigger, its kind's refusal or failure
 * case unless a test of that file says one, and each bound N unless N is in a test there.
 */
export function candidatesOf(triggers: readonly NegativeTrigger[], tests: Readonly<Record<string, string>>, dismissed: readonly string[]): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const skip = new Set(dismissed)
  for (const one of triggers) {
    const text = testsFor(one.path, tests)
    const base = keyOf(one)
    const add = (key: string, ask: string) => {
      if (seen.has(key) || skip.has(key)) return
      seen.add(key)
      out.push({ key, kind: one.kind, path: one.path, line: one.line, ask })
    }
    // One question per file and kind: three validation lines in a file want the same test. It is
    // covered by a test that tries the case and names what was changed (the function, a name on
    // a trigger line), not by a stray word somewhere in a test file.
    const kindKey = `${one.kind}\u0000${one.path}`
    if (!seen.has(kindKey)) {
      const names = triggers.filter(t => t.kind === one.kind && t.path === one.path).flatMap(t => t.names ?? [])
      const isNamed = names.length === 0 || names.some(name => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text))
      if (!COVERS[one.kind].test(text) || !isNamed) add(kindKey, QUESTION[one.kind])
    }
    for (const n of one.bounds) {
      const tried = [n - 1, n, n + 1].filter(v => new RegExp(`(?<![\\w.])${String(v).replace('.', '\\.')}(?![\\w.])`).test(text))
      if (tried.length < 2) add(`${base}\u0000${n}`, `境界値 ${n - 1} / ${n} / ${n + 1}`)
    }
  }
  return out
}

export function summaryOf(list: readonly Candidate[]): string {
  const files = [...new Set(list.map(one => one.path.slice(one.path.lastIndexOf('/') + 1)))]
  const kinds = [...new Set(list.map(one => KIND_LABEL[one.kind]))]
  return `${kinds.join('・')} (${files.slice(0, 3).join(', ')}${files.length > 3 ? ` ほか${files.length - 3}` : ''})`
}

/** The request the band puts in the prompt: the candidates as a list for Claude to check. */
export function requestOf(list: readonly Candidate[]): string {
  return [
    '次の拒否ケース・境界値のテストが不足している可能性があります。既存テストで足りているものは理由を、足りないものは追加してください:',
    ...list.map(one => `- ${one.path}: ${KIND_LABEL[one.kind]} — ${one.ask}（契機: \`${one.line.replace(/`/g, "'")}\`）`),
  ].join('\n')
}
