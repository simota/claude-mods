// Masking credentials in a command before it is kept, as sandbox-lens does (copied from its
// parse.ts: mods share no code).

const EXAMPLE_CHARS = 120

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

/** The text with the credentials it carries masked: a command, or a line of its output. */
export function maskedOf(text: string): string {
  let masked = SECRETS.reduce((all, [pattern, mask]) => all.replace(pattern, mask as Replacer), maskStructured(text))
  if (ATTACHED_P.test(masked)) masked = maskValues(masked, /\s-p(?!\s)/g)
  if (SPACED_P.test(masked)) masked = maskValues(masked, /\s-p\s+/g)
  return masked
}

/** The command as an example: credentials masked, cut to a line. */
export function exampleOf(command: string): string {
  const masked = maskedOf(command).replace(/ {2,}/g, ' ')
  return masked.length > EXAMPLE_CHARS ? `${masked.slice(0, EXAMPLE_CHARS)}…` : masked
}

