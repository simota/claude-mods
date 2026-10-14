// Masking credentials in a command before it is kept, as sandbox-lens does (copied from its
// parse.ts: mods share no code).

const EXAMPLE_CHARS = 120

// Name segments that mark a value as a credential (`ANTHROPIC_API_KEY`, `x-access-token`, `db_pass`).
const SECRET_WORDS = new Set([
  'key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pass', 'pwd',
  'auth', 'cookie', 'session', 'credential', 'credentials',
])
const isSecretName = (name: string) => name.toLowerCase().split(/[_-]/).some(part => SECRET_WORDS.has(part))

// A value: quoted whole, or up to whitespace or a shell separator.
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s&;|'"]+)`

type Replacer = (substring: string, ...groups: string[]) => string
type Mask = [RegExp, string | Replacer]

// Credentials a command line may carry, each kept to its name.
const SECRETS: Mask[] = [
  // URL userinfo: user:password@ keeps the user, a token alone@ goes whole; host and path stay.
  [/(\b[a-z][\w+.-]*:\/\/)([^/\s:@'"]+):([^/\s@'"]+)@/gi, '$1$2:***@'],
  [/(\b[a-z][\w+.-]*:\/\/)([^/\s:@'"*]+)@/gi, '$1***@'],
  // Headers: Authorization keeps its scheme, Cookie loses every pair.
  [/(authorization:\s*)(?:(bearer|basic|token)\s+)?[^\s'"]+/gi, (_, head = '', scheme = '') => `${head}${scheme ? `${scheme} ` : ''}***`],
  [/(\bcookie:\s*)[^\s'";]+(?:;\s*[^\s'";]+)*;?/gi, '$1***'],
  [/\b(bearer)\s+(?!\*\*\*)[\w.~+/=-]+/gi, '$1 ***'],
  // -u user:pass, -uuser:pass, --user=user:pass, -u "user:pass"
  [/(\s(?:-u|--user)(?:=|\s+)?)(["']?)([^\s:'"]+):([^\s'"]+)/g, '$1$2$3:***'],
  // --password x, --token=x, --client-secret "x"
  [
    new RegExp(String.raw`(--(?:client-secret|api-?key|secret|token|auth-token|access-token|password|passwd)(?:=|\s+))${VALUE}`, 'gi'),
    '$1***',
  ],
  // NAME=value where the name reads as a credential, quoted values too (env assignments, query strings).
  [
    new RegExp(String.raw`\b([A-Za-z][\w-]*)=(${VALUE})`, 'g'),
    (whole, name = '') => (isSecretName(name) ? `${name}=***` : whole),
  ],
  // Bare tokens with a known shape.
  [/\b(sk-(?:ant-)?)[\w-]{16,}/g, '$1***'],
  [/\b(gh[pousr]_)[A-Za-z0-9]{10,}/g, '$1***'],
  [/\b(github_pat_)\w{10,}/g, '$1***'],
  [/\b(xox[abprs]-)[\w-]{8,}/g, '$1***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
]

// Programs whose -p takes a password: attached (mysql -pX) or as the next word (sshpass -p X, docker login -p X).
const ATTACHED_P = /\b(?:mysql|mariadb|mysqldump|mysqladmin)\b/
const SPACED_P = /\bsshpass\b|\b(?:docker|podman|nerdctl|helm)\b(?:\s+\S+)*?\s+login\b/

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

