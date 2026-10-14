import type { SandboxLensDenial, SandboxLensKind } from '../types'

export type Hit = { kind: SandboxLensKind; target: string }

export const LIMIT = 200
const EXAMPLE_CHARS = 80

const BLOCK = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/g
const VIOLATION = /^\s*deny\s+(network-outbound|file-write[\w*-]*|file-read[\w*-]*)\s+(.+?)\s*$/

// stderr lines in the shapes commands print a refused path in.
const EPERM_LINES = [
  // ls: cannot open directory '/x/My Files': Operation not permitted
  /^[\w./+-]+: (?:cannot|can't|could not|unable to|failed to) [^'"‘“]*?(['"‘“].+['"’”]): Operation not permitted\s*$/i,
  // touch: /x/My Files/a.txt: Operation not permitted
  /^[\w./+-]+: (.+?): Operation not permitted\s*$/,
  // zsh: operation not permitted: /x/a.txt
  /^(?:zsh|bash|sh|fish): operation not permitted: (.+?)\s*$/i,
]
const EPERM_SHAPED = /Operation not permitted\s*$/im

// Commands that print a file's content: an "Operation not permitted" there is the file's text, not a refusal.
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'rg', 'ag', 'sed', 'awk', 'bat', 'jq', 'view', 'nl'])

function kindOf(operation: string): SandboxLensKind {
  if (operation === 'network-outbound') return 'network'
  return operation.startsWith('file-write') ? 'file-write' : 'file-read'
}

const unquote = (text: string) => text.trim().replace(/^['"‘“]|['"’”]$/g, '')

function firstWord(command: string): string {
  return (command.trim().split(/\s+/)[0] ?? '').split('/').pop() ?? ''
}

/** Denials named in one command's output, each (kind, target) once. */
export function parseDenials(output: string, command = ''): Hit[] {
  const seen = new Map<string, Hit>()
  const add = (hit: Hit) => seen.set(`${hit.kind} ${hit.target}`, hit)

  // The harness's own block is the record: a file's text cannot forge it from outside one.
  for (const [, block = ''] of output.matchAll(BLOCK)) {
    for (const line of block.split(/\r?\n/)) {
      const match = VIOLATION.exec(line)
      if (!match) continue
      const [, operation = '', rest = ''] = match
      const kind = kindOf(operation)
      // A network denial is `host:port (why)`; a path runs to the end of the line, spaces and all.
      const target = kind === 'network' ? (rest.split(/\s+/)[0] ?? rest) : unquote(rest.replace(/\s+\([^()]*\)$/, ''))
      if (target !== '') add({ kind, target })
    }
  }
  // The block already names the refusal the command's own stderr reports again.
  if (seen.size > 0 || READERS.has(firstWord(command))) return [...seen.values()]

  for (const line of output.split(/\r?\n/)) {
    for (const shape of EPERM_LINES) {
      const path = shape.exec(line)?.[1]
      if (path === undefined) continue
      const target = unquote(path)
      if (/^[/~.]/.test(target)) {
        add({ kind: 'eperm', target })
        break
      }
    }
  }
  if (seen.size === 0 && EPERM_SHAPED.test(output)) {
    add({ kind: 'eperm', target: '(path unknown)' })
  }

  return [...seen.values()]
}

// Credentials a command line may carry, each kept to its name.
const SECRETS: [RegExp, string][] = [
  [/(authorization:\s*)(?:(bearer|basic|token)\s+)?[^\s'"]+/gi, '$1$2 ***'],
  [/\b(bearer)\s+[\w.~+/=-]+/gi, '$1 ***'],
  [/(\b[a-z][\w+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:***@'],
  [/(\s(?:-u|--user)\s+)([^\s:'"]+):([^\s'"]+)/g, '$1$2:***'],
  [/(--(?:password|passwd|token|api-key|secret)[= ])(\S+)/gi, '$1***'],
  [/\b([\w-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key)[\w-]*)(=|:\s*)([^\s&'"]+)/gi, '$1$2***'],
]

/** The command as an example: credentials masked, cut to a line. */
export function exampleOf(command: string): string {
  const masked = SECRETS.reduce((text, [pattern, mask]) => text.replace(pattern, mask), command).replace(/ {2,}/g, ' ')
  return masked.length > EXAMPLE_CHARS ? `${masked.slice(0, EXAMPLE_CHARS)}…` : masked
}

/** Adds one command's hits to a tally; past LIMIT the least recently seen leave, so a new one always stays. */
export function merge(
  list: readonly SandboxLensDenial[],
  hits: readonly Hit[],
  command: string,
  now: number,
): SandboxLensDenial[] {
  const example = exampleOf(command)
  const next = list.map(one => ({ ...one }))

  for (const hit of hits) {
    const found = next.find(one => one.kind === hit.kind && one.target === hit.target)
    if (found) {
      found.count += 1
      found.lastSeen = now
      found.example = example
    } else {
      next.push({ ...hit, count: 1, lastSeen: now, example })
    }
  }

  const kept = [...next].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, LIMIT)
  return ranked(kept)
}

/** True when a hit names a (kind, target) the list does not hold yet. */
export function hasNew(list: readonly SandboxLensDenial[], hits: readonly Hit[]): boolean {
  return hits.some(hit => !list.some(one => one.kind === hit.kind && one.target === hit.target))
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
