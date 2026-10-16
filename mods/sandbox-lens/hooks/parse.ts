import type { SandboxLensDenial, SandboxLensKind } from '../types'

export type Hit = { kind: SandboxLensKind; target: string }

export const LIMIT = 200
const EXAMPLE_CHARS = 80

const OPEN = '<sandbox_violations>'
const CLOSE = '</sandbox_violations>'
const VIOLATION = /^\s*deny\s+(network-outbound|file-write[\w*-]*|file-read[\w*-]*)\s+(.+?)\s*$/

// The tail a refusal line may carry after "permitted": Rust's `(os error 1)`.
const TAIL = String.raw`(?:\s*\(os error 1\))?\s*$`

// The shapes a program prints a refused path in, each `[program, path]`.
const EPERM_LINES: RegExp[] = [
  // ls: cannot open directory '/x/My Files': Operation not permitted
  new RegExp(String.raw`^([\w./+-]+): (?:cannot|can't|could not|unable to|failed to) [^'"‘“]*?(['"‘“].+['"’”]): Operation not permitted${TAIL}`, 'i'),
  // touch: /x/My Files/a.txt: Operation not permitted   ·   rg: /x: Operation not permitted (os error 1)
  new RegExp(String.raw`^([\w./+-]+): (.+?): Operation not permitted${TAIL}`),
  // zsh: operation not permitted: /x/a.txt
  /^(zsh|bash|sh|fish): operation not permitted: (.+?)\s*$/i,
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
 * Denials named in one command's output, each (kind, target) once; relative paths resolved against cwd.
 * `harness` is where the harness's block may be: the result's own `stderr` when the command
 * succeeded (the engine keeps the command's output apart, in `stdout`), else the whole output.
 */
export function parseDenials(output: string, command = '', cwd = '', harness = output): Hit[] {
  const seen = new Map<string, Hit>()
  const add = (hit: Hit) => seen.set(`${hit.kind} ${hit.target}`, hit)

  for (const line of (trailingBlock(harness) ?? '').split(/\r?\n/)) {
    const match = VIOLATION.exec(line)
    if (!match) continue
    const [, operation = '', rest = ''] = match
    const kind = kindOf(operation)
    // A network denial is `host:port (why)`; a path runs to the end of the line, spaces and all.
    const target = kind === 'network' ? (rest.split(/\s+/)[0] ?? rest) : unquote(rest.replace(/\s+\([^()]*\)$/, ''))
    if (target !== '') add({ kind, target })
  }
  // The block already names the refusal the command's own stderr reports again.
  if (seen.size > 0) return [...seen.values()]

  const program = firstWord(command)
  const isReader = READERS.has(program)
  for (const line of output.split(/\r?\n/)) {
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

// A value: quoted whole, or up to whitespace or a shell separator.
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s&;|'"]+)`

type Replacer = (substring: string, ...groups: string[]) => string
type Mask = [RegExp, string | Replacer]

// NAME=value. The name is bounded so a long run such as `a-a-a-…` is scanned in linear time, not once per hyphen.
const NAME_VALUE = new RegExp(String.raw`\b([A-Za-z][\w-]{0,127})=(${VALUE})`, 'g')
const maskName: Replacer = (whole, name = '') => (isSecretName(name) ? `${name}=***` : whole)
// One level into the value, not recursively: `a=a=a=…` must not grow the stack.
const maskNameValue: Replacer = (whole, name = '', value = '') =>
  isSecretName(name) ? `${name}=***` : value.includes('=') ? `${name}=${value.replace(NAME_VALUE, maskName)}` : whole

// Credentials a command line may carry, each kept to its name.
const SECRETS: Mask[] = [
  // URL userinfo: user:password@ keeps the user, a token alone@ goes whole; host and path stay.
  // The scheme is bounded, as the NAME=value name below is, to keep a long hyphenated run linear.
  [/(\b[a-z][\w+.-]{0,31}:\/\/)([^/\s:@'"]+):([^/\s@'"]+)@/gi, '$1$2:***@'],
  [/(\b[a-z][\w+.-]{0,31}:\/\/)([^/\s:@'"*]+)@/gi, '$1***@'],
  // Headers: Authorization keeps its scheme, Cookie loses every pair.
  [/(authorization:\s*)(?:(bearer|basic|token)\s+)?[^\s'"]+/gi, (_, head = '', scheme = '') => `${head}${scheme ? `${scheme} ` : ''}***`],
  [/(\bcookie:\s*)[^\s'";]+(?:;\s*[^\s'";]+)*;?/gi, '$1***'],
  [/\b(bearer)\s+(?!\*\*\*)[\w.~+/=-]+/gi, '$1 ***'],
  // Any other header a request sends whose name reads as a credential (-H "X-API-Key: x"); only
  // as -H/--header, so an error line such as `Unexpected token: '<'` is left as it is. A quoted
  // value goes whole up to its closing quote (`X-Auth: Token abc`); an unquoted header is one shell
  // word with no space after the colon, so `grep -H password: config.yml` keeps its file name.
  [
    /((?:^|\s)(?:-H|--header)(?:=|\s*))(?:(["'])([\w-]+)(:\s*)(?:(?!\2)[^\n])+|([\w-]+)(:)[^\s'"]+)/g,
    (whole, head = '', quote = '', quotedName = '', quotedColon = '', name = '', colon = '') => {
      if (quote !== '') return isSecretName(quotedName) ? `${head}${quote}${quotedName}${quotedColon}***` : whole
      return isSecretName(name) ? `${head}${name}${colon}***` : whole
    },
  ],
  // -u user:pass, -uuser:pass, --user=user:pass, -u "user:pass"
  [/(\s(?:-u|--user)(?:=|\s+)?)(["']?)([^\s:'"]+):([^\s'"]+)/g, '$1$2$3:***'],
  // --password x, --token=x, --client-secret "x"
  [
    new RegExp(String.raw`(--(?:client-secret|api-?key|secret|token|auth-token|access-token|password|passwd)(?:=|\s+))${VALUE}`, 'gi'),
    '$1***',
  ],
  // NAME=value where the name reads as a credential, quoted values too (env assignments, query strings).
  // A value that is itself NAME=value (kubectl --from-literal=password=x) is looked into.
  [NAME_VALUE, maskNameValue],
  // "name": "value" (JSON in an output line) where the name reads as a credential.
  // A bare "key" or "session" is an id there (a path, an S3 key), not a credential.
  [/("([\w-]+)"\s*:\s*)"[^"]*"/g, (whole, head = '', name = '') => (isSecretName(name) && !/^(?:key|session)$/i.test(name) ? `${head}"***"` : whole)],
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
  let masked = SECRETS.reduce((text, [pattern, mask]) => text.replace(pattern, mask as Replacer), command)
  if (ATTACHED_P.test(masked)) masked = masked.replace(/(\s-p)(?!\s)\S+/g, '$1***')
  if (SPACED_P.test(masked)) masked = masked.replace(/(\s-p\s+)\S+/g, '$1***')
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
