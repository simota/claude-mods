import type { SandboxLensDenial, SandboxLensKind } from '../types'

export type Hit = { kind: SandboxLensKind; target: string }

export const LIMIT = 200
const EXAMPLE_CHARS = 80

const VIOLATION = /^\s*deny\s+(network-outbound|file-write[\w*-]*|file-read[\w*-]*)\s+(\S+)/gm
const EPERM = /['"]?((?:~|\/)[^\s:'"]*)['"]?:\s*Operation not permitted/g

function kindOf(operation: string): SandboxLensKind {
  if (operation === 'network-outbound') return 'network'
  return operation.startsWith('file-write') ? 'file-write' : 'file-read'
}

/** Denials named in one command's output, each (kind, target) once. */
export function parseDenials(output: string): Hit[] {
  const seen = new Map<string, Hit>()
  const add = (hit: Hit) => seen.set(`${hit.kind} ${hit.target}`, hit)

  for (const [, operation = '', target = ''] of output.matchAll(VIOLATION)) {
    add({ kind: kindOf(operation), target })
  }
  for (const [, path = ''] of output.matchAll(EPERM)) {
    add({ kind: 'eperm', target: path })
  }
  if (seen.size === 0 && output.includes('Operation not permitted')) {
    add({ kind: 'eperm', target: '(path unknown)' })
  }

  return [...seen.values()]
}

/** Adds one command's hits to a tally, keeping the top LIMIT entries. */
export function merge(
  list: readonly SandboxLensDenial[],
  hits: readonly Hit[],
  command: string,
  now: number,
): SandboxLensDenial[] {
  const example = command.length > EXAMPLE_CHARS ? `${command.slice(0, EXAMPLE_CHARS)}…` : command
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

  return ranked(next).slice(0, LIMIT)
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
