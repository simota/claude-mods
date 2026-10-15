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
// `primaryKey`, `sessionId` and `"key": "src/a.ts"` are ids, not credentials.
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
  // value goes whole (`X-Auth: Token abc`), an unquoted one to the next space.
  [
    /((?:^|\s)(?:-H|--header)(?:=|\s*))(?:(["'])([\w-]+)(:\s*)[^'"\n]*|([\w-]+)(:\s*)\S+)/g,
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
  [/("([\w-]+)"\s*:\s*)"[^"]*"/g, (whole, head = '', name = '') => (isStrongName(name) ? `${head}"***"` : whole)],
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
  let masked = SECRETS.reduce((all, [pattern, mask]) => all.replace(pattern, mask as Replacer), text)
  if (ATTACHED_P.test(masked)) masked = masked.replace(/(\s-p)(?!\s)\S+/g, '$1***')
  if (SPACED_P.test(masked)) masked = masked.replace(/(\s-p\s+)\S+/g, '$1***')
  return masked
}

/** The command as an example: credentials masked, cut to a line. */
export function exampleOf(command: string): string {
  const masked = maskedOf(command).replace(/ {2,}/g, ' ')
  return masked.length > EXAMPLE_CHARS ? `${masked.slice(0, EXAMPLE_CHARS)}…` : masked
}

