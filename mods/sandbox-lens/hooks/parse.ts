import type { SandboxLensDenial, SandboxLensKind } from '../types'

export type Hit = { kind: SandboxLensKind; target: string }

export const LIMIT = 200
const EXAMPLE_CHARS = 80

const OPEN = '<sandbox_violations>'
const CLOSE = '</sandbox_violations>'
// Read on a line with its trailing space off: `(.+?)\s*$` tries every split of a run of spaces.
const VIOLATION = /^\s*deny\s+(network-outbound|file-write[\w*-]*|file-read[\w*-]*)\s+(\S.*)$/

// The tail a refusal line may carry after "permitted": Rust's `(os error 1)`.
const TAIL = String.raw`(?:\s*\(os error 1\))?\s*$`

// The shapes a program prints a refused path in, each `[program, path]`.
const EPERM_LINES: RegExp[] = [
  // ls: cannot open directory '/x/My Files': Operation not permitted
  new RegExp(String.raw`^([\w./+-]+): (?:cannot|can't|could not|unable to|failed to) [^'"‘“]*?(['"‘“].+['"’”]): Operation not permitted${TAIL}`, 'i'),
  // touch: /x/My Files/a.txt: Operation not permitted   ·   rg: /x: Operation not permitted (os error 1)
  new RegExp(String.raw`^([\w./+-]+): (.+?): Operation not permitted${TAIL}`),
  // zsh: operation not permitted: /x/a.txt
  /^(zsh|bash|sh|fish): operation not permitted: (.+)$/i,
  // PermissionError: [Errno 1] Operation not permitted: '/x/y'
  /^(?:\w+\.)*(PermissionError|OSError): \[Errno 1\] Operation not permitted: (['"].+['"])\s*$/,
]
const EPERM_SHAPED = new RegExp(String.raw`Operation not permitted(?:${TAIL}|: )`, 'im')

// Commands that print a file's content: a line there is the file's text unless it is the program's own message.
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'rg', 'ag', 'sed', 'awk', 'bat', 'jq', 'view', 'nl'])

function kindOf(operation: string): SandboxLensKind {
  if (operation === 'network-outbound') return 'network'
  return operation.startsWith('file-write') ? 'file-write' : 'file-read'
}

const unquote = (text: string) => text.trim().replace(/^['"‘“]|['"’”]$/g, '')

const baseName = (path: string) => path.split('/').pop() ?? ''

function firstWord(command: string): string {
  return baseName(command.trim().split(/\s+/)[0] ?? '')
}

/** A path made absolute against cwd, `.` and `..` folded. */
export function absolute(path: string, cwd: string): string {
  if (path.startsWith('/') || path.startsWith('~')) return path
  const out: string[] = []
  for (const part of `${cwd}/${path}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * The harness's own violations block: the one that ends the output, or the error text before
 * the agent proxy's note. A block anywhere earlier was printed by the command (a file shown,
 * a page fetched) and proves nothing.
 */
// What a proxied environment adds after the block of a failed command's error text.
const PROXY_NOTE = '\n\n[agent-proxy] '

function trailingBlock(output: string): string | undefined {
  const note = output.lastIndexOf(PROXY_NOTE)
  const text = (note < 0 ? output : output.slice(0, note)).trimEnd()
  // Found from the end: a scan from each opening tag took quadratic time on many left unclosed.
  if (!text.endsWith(CLOSE)) return undefined
  const end = text.length - CLOSE.length
  const start = text.lastIndexOf(OPEN, end)
  return start < 0 ? undefined : text.slice(start + OPEN.length, end)
}

/**
 * A path less the `(reason)` the harness may put after it. Found from its last `(`, not by
 * /\s+\([^()]*\)$/, which tries from every space of a run in the path.
 */
function withoutReason(rest: string): string {
  if (!rest.endsWith(')')) return rest
  const open = rest.lastIndexOf('(')
  if (open < 1 || rest.indexOf(')', open) < rest.length - 1 || !/\s/.test(rest[open - 1] as string)) return rest
  return rest.slice(0, open).trimEnd()
}

/**
 * Denials named in one command's output, each (kind, target) once; relative paths resolved against cwd.
 * `harness` is where the harness's block may be: the result's own `stderr` when the command
 * succeeded (the engine keeps the command's output apart, in `stdout`), else the whole output.
 */
export function parseDenials(output: string, command = '', cwd = '', harness = output): Hit[] {
  const seen = new Map<string, Hit>()
  const add = (hit: Hit) => seen.set(`${hit.kind} ${hit.target}`, hit)

  for (const line of (trailingBlock(harness) ?? '').split(/\r?\n/)) {
    const match = VIOLATION.exec(line.trimEnd())
    if (!match) continue
    const [, operation = '', rest = ''] = match
    const kind = kindOf(operation)
    // A network denial is `host:port (why)`; a path runs to the end of the line, spaces and all.
    const target = kind === 'network' ? (rest.split(/\s+/)[0] ?? rest) : unquote(withoutReason(rest))
    if (target !== '') add({ kind, target })
  }
  // The block already names the refusal the command's own stderr reports again.
  if (seen.size > 0) return [...seen.values()]

  const program = firstWord(command)
  const isReader = READERS.has(program)
  for (const raw of output.split(/\r?\n/)) {
    // Trailing space off first: every shape's ending would otherwise try each split of it.
    const line = raw.trimEnd()
    for (const shape of EPERM_LINES) {
      const match = shape.exec(line)
      if (!match) continue
      const [, who = '', path = ''] = match
      // What a reader prints is the file's text; only a line in its own name is its refusal.
      if (isReader && baseName(who) !== program) break
      const target = unquote(path)
      if (target !== '' && !target.startsWith('(')) {
        add({ kind: 'eperm', target: cwd === '' ? target : absolute(target, cwd) })
      }
      break
    }
  }
  if (seen.size === 0 && !isReader && EPERM_SHAPED.test(output)) {
    add({ kind: 'eperm', target: '(path unknown)' })
  }

  return [...seen.values()]
}

// Name segments that mark a value as a credential (`ANTHROPIC_API_KEY`, `x-access-token`, `db_pass`).
const SECRET_WORDS = new Set([
  'key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pass', 'pwd',
  'auth', 'cookie', 'session', 'credential', 'credentials',
])
// Words that mark a credential even inside a camelCase name (`accessToken`, `clientSecret`, `APIKey`),
// and endings that mark one run together (`PGPASSWORD`). `key` and `session` are left out here:
// `primaryKey` and `sessionId` are ids, not credentials.
const STRONG_WORDS = new Set(['apikey', 'token', 'secret', 'password', 'passwd', 'credential', 'credentials'])
const SECRET_ENDINGS = ['password', 'passwd', 'token', 'secret', 'apikey']
const isStrongName = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_-]/).some(part => STRONG_WORDS.has(part)) ||
  SECRET_ENDINGS.some(end => name.toLowerCase().replace(/[_-]/g, '').endsWith(end))
const isSecretName = (name: string) => name.toLowerCase().split(/[_-]/).some(part => SECRET_WORDS.has(part)) || isStrongName(name)

type Replacer = (substring: string, ...groups: string[]) => string
type Mask = [RegExp, string | Replacer]
type Quote = '' | '"' | "'"
type ValueMode = 'word' | 'cookie' | 'userinfo'
const JSON_VALUE = /("([\w-]+)"\s*:\s*)"(?:\\[\s\S]|[^"\\])*(?:\\$|"|$)/g

// Read a shell word without evaluating it. Quoted pieces can be adjacent, and a backslash
// outside single quotes protects the next character, including a space or a separator.
// `inQuote` belongs to the surrounding argument (-H "Key: …", -u "user:…", a quoted URL).
// Its final quote is kept when the secret reaches the end of that argument. URL query
// separators still bound a parameter; they are not part of its value.
function valueEnd(text: string, start: number, inQuote: Quote, inUrl: boolean, mode: ValueMode, inJson: boolean) {
  // A credential marker may be inside an otherwise public JSON string. Its closing
  // quote belongs to that field, even when the JSON is itself a single-quoted argument.
  if (inJson && mode !== 'userinfo') {
    let end = start
    while (end < text.length) {
      if (inUrl && /[&;|]/.test(text[end] as string)) return { end, hasValue: end > start, close: '' }
      if (text[end] === '"') return { end: end + 1, hasValue: end > start, close: '"' }
      end = Math.min(text.length, end + (text[end] === '\\' ? 2 : 1))
    }
    return { end, hasValue: end > start, close: '' }
  }
  let quote = inQuote
  let end = start
  let hasValue = false
  let afterSemicolon = false
  while (end < text.length) {
    const char = text[end] as string
    if (char === '\\' && quote !== "'") {
      end = Math.min(text.length, end + 2)
      hasValue = true
      afterSemicolon = false
      continue
    }
    if (mode === 'userinfo' && /[/@?#\s]/.test(char)) break
    if (mode !== 'userinfo' && inUrl && /[&;|]/.test(char)) break
    if (quote !== '') {
      if (char === quote) quote = ''
      else hasValue = true
    } else if (char === '"' || char === "'") {
      quote = char
      hasValue = true
    } else if (/\s/.test(char)) {
      // A raw Cookie line may have spaces between its semicolon-separated pairs.
      if (mode !== 'cookie' || !afterSemicolon || /[\r\n]/.test(char)) break
    } else {
      if (mode === 'word' && /[&;|]/.test(char)) break
      hasValue = true
      afterSemicolon = char === ';'
    }
    end++
  }
  return { end, hasValue, close: inQuote !== '' && quote === '' ? inQuote : '' }
}

// Match only credential prefixes, then consume their values in a linear scan. Quoting
// context is advanced once across the input; repeated nonsecret `a=a=…` is never recursive.
function maskValues(text: string, pattern: RegExp, accepts: (match: RegExpExecArray) => boolean = () => true, mode: ValueMode = 'word') {
  const parts: string[] = []
  let copied = 0
  let scanned = 0
  let quote: Quote = ''
  let urlStart = -1
  let jsonFields: { start: number; end: number }[] | undefined
  let fieldIndex = 0
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (!accepts(match)) continue
    const start = pattern.lastIndex
    for (; scanned < start; scanned++) {
      const char = text[scanned] as string
      if (char === '\\' && quote !== "'") {
        scanned++
        continue
      }
      if (quote !== '') {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") {
        quote = char
      }
      if (/\s/.test(char) || (quote === '' && /[&;|]/.test(char))) urlStart = -1
      if (text.startsWith('://', scanned)) urlStart = scanned
    }
    jsonFields ??= [...text.matchAll(JSON_VALUE)].map(field => ({
      start: field.index + (field[1]?.length ?? 0) + 1,
      end: field.index + field[0].length,
    }))
    while ((jsonFields[fieldIndex]?.end ?? Infinity) <= start) fieldIndex++
    const field = jsonFields[fieldIndex]
    const inJson = field !== undefined && field.start <= start && start < field.end
    // A URL in an earlier JSON field cannot give a later password URL boundaries.
    const inUrl = urlStart >= 0 && (!inJson || urlStart >= (field?.start ?? 0))
    const value = valueEnd(text, start, quote, inUrl, mode, inJson)
    if (!value.hasValue || (mode === 'userinfo' && text[value.end] !== '@')) continue
    parts.push(text.slice(copied, start), '***', value.close)
    copied = value.end
    pattern.lastIndex = value.end
  }
  parts.push(text.slice(copied))
  return parts.join('')
}

function maskStructured(text: string): string {
  // JSON string escapes do not terminate the value. An unfinished string is masked to
  // the end too; clipping a diagnostic must not turn a known secret into visible text.
  let masked = text.replace(
    JSON_VALUE,
    (whole, head = '', name = '') => isSecretName(name) && !/^(?:key|session)$/i.test(name) ? `${head}"***"` : whole,
  )
  // Userinfo ends at @, not at an apostrophe (which is legal in a URI) or a shell
  // quote joining adjacent pieces. Keep the username, authority, path and outer quote.
  masked = maskValues(masked, /\b[a-z][\w+.-]{0,31}:\/\/[^/\s:@?#]+:/gi, undefined, 'userinfo')
  masked = maskValues(masked, /\b[a-z][\w+.-]{0,31}:\/\/(?=[^/\s:@*?#]+@)/gi, undefined, 'userinfo')
  // Quoted credential headers consume the whole argument. Authorization is handled
  // separately to keep its scheme. An unquoted header must put its value next to the
  // colon: grep -H password: config.yml does not carry config.yml as a password.
  masked = maskValues(masked,
    /(?:^|\s)(?:-H|--header)(?:=|\s*)(?:(["'])([\w-]+)(:\s*)|([\w-]+):)/g,
    match => isSecretName(match[2] ?? match[4] ?? ''),
  )
  masked = maskValues(masked, /authorization:\s*(?:(?:bearer|basic|token)\s+)?/gi)
  masked = maskValues(masked, /\bcookie:\s*/gi, undefined, 'cookie')
  masked = maskValues(masked, /\bbearer\s+(?!\*\*\*)/gi)
  // Keep the user, but consume the password's quoted fragments and escaped delimiters.
  masked = maskValues(masked, /(?:^|\s)(?:-u|--user)(?:=|\s+)?["']?[^\s:'"\\]+:/g)
  masked = maskValues(masked, /--(?:client-secret|api-?key|secret|token|auth-token|access-token|password|passwd)(?:=|\s+)/gi)
  // Start once per name, including option dashes, not again after every hyphen.
  masked = maskValues(masked, /(?<![\w-])(-*[A-Za-z][\w-]*)=/g, match => isSecretName(match[1] ?? ''))
  return masked
}

// Credentials a command line may carry, each kept to its name.
const SECRETS: Mask[] = [
  // Bare tokens with a known shape.
  [/\b(sk-(?:ant-)?)[\w-]{16,}/g, '$1***'],
  [/\b(gh[pousr]_)[A-Za-z0-9]{10,}/g, '$1***'],
  [/\b(github_pat_)\w{10,}/g, '$1***'],
  [/\b(xox[abprs]-)[\w-]{8,}/g, '$1***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\b(glpat-)[\w-]{20,}/g, '$1***'],
  [/\b(npm_)[A-Za-z0-9]{36}\b/g, '$1***'],
  [/\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{10,}/g, '$1***'],
  [/\bAIza[\w-]{35}\b/g, 'AIza***'],
  // Started only where no word or hyphen comes before, so `eyJ-eyJ-…` is not rescanned from each one.
  [/(?<![\w-])eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*/g, 'eyJ***'],
]

// Programs whose -p takes a password: attached (mysql -pX) or as the next word (sshpass -p X, docker login -p X).
const ATTACHED_P = /\b(?:mysql|mariadb|mysqldump|mysqladmin)\b/
// The words before `login` are bounded, so a long run of `docker docker …` stays linear.
const SPACED_P = /\bsshpass\b|\b(?:docker|podman|nerdctl|helm)\b(?:\s+\S+){0,8}?\s+login\b/

/** The command as an example: credentials masked, cut to a line. */
export function exampleOf(command: string): string {
  let masked = SECRETS.reduce((text, [pattern, mask]) => text.replace(pattern, mask as Replacer), maskStructured(command))
  if (ATTACHED_P.test(masked)) masked = maskValues(masked, /\s-p(?!\s)/g)
  if (SPACED_P.test(masked)) masked = maskValues(masked, /\s-p\s+/g)
  masked = masked.replace(/ {2,}/g, ' ')
  return masked.length > EXAMPLE_CHARS ? `${masked.slice(0, EXAMPLE_CHARS)}…` : masked
}

const keyOf = (one: { kind: string; target: string }) => `${one.kind} ${one.target}`

/** Adds one command's hits to a tally; past LIMIT the least recently seen leave, so a new one always stays. */
export function merge(
  list: readonly SandboxLensDenial[],
  hits: readonly Hit[],
  command: string,
  now: number,
): SandboxLensDenial[] {
  const example = exampleOf(command)
  const next = list.map(one => ({ ...one }))
  // Found by key, not by a search of the list: `find ~` may be refused at thousands of paths.
  const byKey = new Map(next.map(one => [keyOf(one), one]))

  for (const hit of hits) {
    const found = byKey.get(keyOf(hit))
    if (found) {
      found.count += 1
      found.lastSeen = now
      found.example = example
    } else {
      const added = { ...hit, count: 1, lastSeen: now, example }
      next.push(added)
      byKey.set(keyOf(added), added)
    }
  }

  return capped(next)
}

function capped(list: SandboxLensDenial[]): SandboxLensDenial[] {
  return ranked([...list].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, LIMIT))
}

/**
 * Two tallies as one: each (kind, target) once, the larger count and the later sighting
 * (with that sighting's example). Used when another session wrote the store in between.
 */
export function union(a: readonly SandboxLensDenial[], b: readonly SandboxLensDenial[]): SandboxLensDenial[] {
  const byKey = new Map<string, SandboxLensDenial>()
  for (const one of [...a, ...b]) {
    const key = `${one.kind} ${one.target}`
    const had = byKey.get(key)
    if (had === undefined) {
      byKey.set(key, { ...one })
      continue
    }
    const later = one.lastSeen > had.lastSeen ? one : had
    byKey.set(key, { ...later, count: Math.max(had.count, one.count), lastSeen: Math.max(had.lastSeen, one.lastSeen) })
  }
  return capped([...byKey.values()])
}

/** True when `stored` lacks an entry of `wrote`, or holds it with a smaller count: another session wrote over it. */
export function isOverwritten(wrote: readonly SandboxLensDenial[], stored: readonly SandboxLensDenial[]): boolean {
  return wrote.some(one => {
    const found = stored.find(other => other.kind === one.kind && other.target === one.target)
    return found === undefined || found.count < one.count
  })
}

/** True when a hit names a (kind, target) the list does not hold yet. */
export function hasNew(list: readonly SandboxLensDenial[], hits: readonly Hit[]): boolean {
  const known = new Set(list.map(keyOf))
  return hits.some(hit => !known.has(keyOf(hit)))
}

export function ranked(list: readonly SandboxLensDenial[]): SandboxLensDenial[] {
  return [...list].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
}

/** Reads what $.store holds, dropping anything that is not a denial. */
export function fromStore(value: unknown): SandboxLensDenial[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (one): one is SandboxLensDenial =>
      typeof one === 'object' &&
      one !== null &&
      typeof one.kind === 'string' &&
      typeof one.target === 'string' &&
      typeof one.count === 'number',
  )
}
