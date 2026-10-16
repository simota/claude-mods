// The negative space, pure: what an edit added that refuses, validates or fails, and which
// of the tests it calls for no test this session touched has written yet.

import type { NegativeTrigger, TestDigest } from '../types'

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb|exs?)$|(?:^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(?:swift|kt|java|cs)$/
const SOURCE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|swift|kt|java|cs|php|ex|exs|scala)$/

export const isTestPath = (path: string): boolean => TEST_PATH.test(path)
export const isSourcePath = (path: string): boolean => SOURCE.test(path) && !isTestPath(path)

const PATTERNS: Record<NegativeTrigger['kind'], RegExp> = {
  auth: /\b(?:authori[sz]e\w*|authenticate\w*|isAuthenticated|requireAuth\w*|require_?login|login_required|permission\w*|[a-z]\w*Permissions?|permitted|can\?|cannot\?|forbid\w*|Forbidden\w*|Unauthori[sz]ed\w*|isAdmin|is_admin|admin_required|ownerId|owner_id|currentUser|current_user|session\.user|policy|@PreAuthorize|@Secured|@RolesAllowed)\b|\b(?:401|403)\b/,
  validation:
    /\b(?:validat\w*|isValid|is_valid|sanitize\w*|BadRequest\w*|ValueError|InvalidArgument\w*|ArgumentError|RangeError|ValidationError|@Valid|@NotNull|@Size|@Min|@Max|Joi\.|yup\.|z\.(?:object|string|number|array|enum|union)|field_validator|validator)\b|\b(?:400|422)\b|\.(?:min|max|length|regex|email|url|uuid|positive|nonnegative|int|nonempty)\(|\bif\b[^\n]{0,200}?(?:<=?|(?<!=)>=?)\s*-?\d|\b(?:maxLength|minLength|maximum|minimum|max_length|min_length)\s*[:=]/,
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

const MAX_LINE = 2_000
const clip = (text: string, max = 100) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Lines of `after` not matched by an equal line of `before`, trimmed, in order, each with where it stands in `after`. */
export function addedAt(before: string, after: string): { line: string; index: number }[] {
  const left = new Map<string, number>()
  for (const line of before.split('\n')) left.set(line.trim(), (left.get(line.trim()) ?? 0) + 1)
  const added: { line: string; index: number }[] = []
  after.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    const n = left.get(line) ?? 0
    if (n > 0) left.set(line, n - 1)
    else if (line !== '') added.push({ line, index })
  })
  return added
}

/** Lines of `after` not matched by an equal line of `before`, trimmed, in order. */
export const addedLines = (before: string, after: string): string[] => addedAt(before, after).map(one => one.line)

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
  // `=>` is an arrow, not a comparison.
  for (const m of line.matchAll(/(?:<=?|(?<!=)>=?|===?|!==?)\s*(-?\d+(?:\.\d+)?)\b/g)) pick(m[1])
  for (const m of line.matchAll(/\b(-?\d+(?:\.\d+)?)\s*(?:<=?|>=?)(?!>)/g)) pick(m[1])
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
  for (const { line, index } of addedAt(before, after)) {
    // A minified bundle's line is no code to test, and its length would make every pattern slow.
    if (line.length > MAX_LINE || isComment(line) || isImport(line)) continue
    const kinds = (['auth', 'validation', 'error'] as const).filter(kind => PATTERNS[kind].test(line))
    if (kinds.length === 0) continue
    // The function this very line sits in, not the first other line that reads the same.
    const enclosing = enclosingName(lines, index)
    const names = [...new Set([...(enclosing === undefined ? [] : [enclosing]), ...namesOn(line)])]
    for (const kind of kinds) out.push({ kind, path, line: clip(line), bounds: kind === 'validation' ? boundsOf(line) : [], names, at })
  }
  return out
}

export const keyOf = (one: Pick<NegativeTrigger, 'kind' | 'path' | 'line'>): string => `${one.kind}\u0000${one.path}\u0000${one.line}`

const stemOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.replace(/\.[^.]+$/, '').replace(/(?:[._-](?:test|spec))$|^test_|_test$|Tests?$/i, '').toLowerCase()
}

const MAX_WORDS = 4_000
const MAX_NUMBERS = 1_000

/**
 * What a test's text says, for the candidates: the kinds whose case it tries, its identifiers,
 * its numbers. Read's line numbers (`  12\t…`) are taken off first: a line number is no bound tried.
 */
export function digestOf(text: string): TestDigest {
  const body = text.replace(/^[ \t]*\d+\t/gm, '')
  const covers = (['auth', 'validation', 'error'] as const).filter(kind => COVERS[kind].test(body))
  const words = new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? [])
  const numbers = new Set<string>()
  for (const m of body.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)) {
    numbers.add(m[0])
    if (m[0].startsWith('-')) numbers.add(m[0].slice(1))
  }
  return { covers, words: [...words].slice(0, MAX_WORDS), numbers: [...numbers].slice(0, MAX_NUMBERS) }
}

/** Two looks at one test file as one: a partial read adds to what a full one saw. */
export function mergeDigest(a: TestDigest, b: TestDigest): TestDigest {
  return {
    covers: [...new Set([...a.covers, ...b.covers])],
    words: [...new Set([...a.words, ...b.words])].slice(0, MAX_WORDS),
    numbers: [...new Set([...a.numbers, ...b.numbers])].slice(0, MAX_NUMBERS),
  }
}

// Held from an earlier version as text, a test is read as its digest.
const asDigest = (value: TestDigest | string): TestDigest => (typeof value === 'string' ? digestOf(value) : value)

/** What the tests that speak of a source file say together: the session's tests whose name holds its stem. */
export function testsFor(path: string, tests: Readonly<Record<string, TestDigest | string>>): TestDigest {
  const stem = stemOf(path)
  return Object.entries(tests)
    .filter(([test]) => stem !== '' && stemOf(test).includes(stem))
    .map(([, one]) => asDigest(one))
    .reduce(mergeDigest, { covers: [], words: [], numbers: [] })
}

// Well under the 4 MiB the engine holds a state value to: past it every write would be refused.
export const MAX_TESTS_CHARS = 1_500_000

/**
 * The tests with one file's digest put in (`isWhole`: the file as it stands, else added to what
 * was seen), newest last. Past MAX_TESTS_CHARS the oldest leave, those no trigger's file is
 * tested by first: a test that closed a candidate stays while reading others.
 */
export function withTest(
  all: Readonly<Record<string, TestDigest>>,
  path: string,
  digest: TestDigest,
  isWhole: boolean,
  triggers: readonly Pick<NegativeTrigger, 'path'>[] = [],
): Record<string, TestDigest> {
  const { [path]: had, ...others } = all
  const put = isWhole || had === undefined ? digest : mergeDigest(asDigest(had), digest)
  const entries: [string, TestDigest][] = [...Object.entries(others), [path, put]]
  const stems = [...new Set(triggers.map(one => stemOf(one.path)).filter(stem => stem !== ''))]
  const isRelevant = (test: string) => stems.some(stem => stemOf(test).includes(stem))
  let size = JSON.stringify(Object.fromEntries(entries)).length
  const order = [...entries.slice(0, -1).filter(([test]) => !isRelevant(test)), ...entries.slice(0, -1).filter(([test]) => isRelevant(test))]
  const gone = new Set<string>()
  for (const [test, one] of order) {
    if (size <= MAX_TESTS_CHARS) break
    gone.add(test)
    size -= JSON.stringify(one).length + test.length + 6
  }
  return Object.fromEntries(entries.filter(([test]) => !gone.has(test)))
}

/** One test to write: what to try, and why (the trigger line). */
export type Candidate = { key: string; kind: NegativeTrigger['kind']; path: string; line: string; ask: string }

/**
 * The candidates the session's tests leave open: per trigger, its kind's refusal or failure
 * case unless a test of that file says one, and each bound N unless N is in a test there.
 */
export function candidatesOf(
  triggers: readonly NegativeTrigger[],
  tests: Readonly<Record<string, TestDigest | string>>,
  dismissed: readonly string[],
): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const judged = new Set<string>()
  const skip = new Set(dismissed)
  const byPath = new Map<string, { digest: TestDigest; words: Set<string>; numbers: Set<string> }>()
  const testsOf = (path: string) => {
    let held = byPath.get(path)
    if (held === undefined) {
      const digest = testsFor(path, tests)
      held = { digest, words: new Set(digest.words), numbers: new Set(digest.numbers) }
      byPath.set(path, held)
    }
    return held
  }
  for (const one of triggers) {
    const { digest, words, numbers } = testsOf(one.path)
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
    if (!judged.has(kindKey)) {
      judged.add(kindKey)
      const names = triggers.filter(t => t.kind === one.kind && t.path === one.path).flatMap(t => t.names ?? [])
      const isNamed = names.length === 0 || names.some(name => words.has(name))
      if (!digest.covers.includes(one.kind) || !isNamed) add(kindKey, QUESTION[one.kind])
    }
    for (const n of one.bounds) {
      const tried = [n - 1, n, n + 1].filter(v => numbers.has(String(v)))
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

const quoted = (line: string) => line.replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/`/g, "'")

/** The request the band puts in the prompt: the candidates as a list for Claude to check. */
export function requestOf(list: readonly Candidate[]): string {
  return [
    '次の拒否ケース・境界値のテストが不足している可能性があります。既存テストで足りているものは理由を、足りないものは追加してください:',
    // The trigger line is source text quoted as data: controls and bidi marks out, backticks made plain.
    ...list.map(one => `- ${one.path}: ${KIND_LABEL[one.kind]} — ${one.ask}（契機: \`${quoted(one.line)}\`）`),
  ].join('\n')
}
