import type { Doc, Server } from '../types'

/** docview's own default port: a docview started on a port shuts down the one already there. */
export const DOCVIEW_DEFAULT_PORT = 4000
export const PORT_COUNT = 20

// What docview renders itself (README "Supported Formats"), less Office files it only lists.
const EXTENSIONS = new Set([
  'md', 'markdown', 'mdx',
  'html', 'htm',
  'mmd', 'mermaid',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'csv', 'tsv',
  'toml', 'ini', 'conf', 'cfg', 'properties',
  'cron', 'crontab',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
  'pdf',
])

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'crontab') return 'crontab'
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1)
}

export const isPreviewable = (path: string) => EXTENSIONS.has(extensionOf(path))

export function iconOf(path: string): string {
  const ext = extensionOf(path)
  if (['md', 'markdown', 'mdx'].includes(ext)) return '📝'
  if (['mmd', 'mermaid'].includes(ext)) return '🔀'
  if (['html', 'htm'].includes(ext)) return '🌐'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '🖼'
  if (ext === 'pdf') return '📕'
  return '📄'
}

/** The path under root, or null when outside it. */
export function relativeTo(root: string, path: string): string | null {
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) && path.length > base.length ? path.slice(base.length) : null
}

/** docview's deep link: `#file=<path>&line=N`, as its parseHash reads it. */
export function previewUrl(base: string, rel: string | null, line?: number): string {
  const root = base.endsWith('/') ? base : `${base}/`
  if (rel === null) return root
  return `${root}#file=${encodeURIComponent(rel)}${line === undefined ? '' : `&line=${line}`}`
}

/**
 * The root as the session's cwd spells it, when that differs from the resolved one:
 * git and docview resolve symlinks, while tool calls name paths under the cwd as typed.
 */
export function cwdSpelledRoot(cwd: string, realCwd: string, resolvedRoot: string): string | undefined {
  if (realCwd !== resolvedRoot && !realCwd.startsWith(`${resolvedRoot}/`)) return undefined
  const below = realCwd.slice(resolvedRoot.length)
  if (!cwd.endsWith(below)) return undefined
  const spelled = cwd.slice(0, cwd.length - below.length)
  return spelled === '' || spelled === resolvedRoot ? undefined : spelled
}

/** The 1-based line `needle` starts on in `text`, or undefined when it is not there. */
export function lineOf(text: string, needle: string): number | undefined {
  if (needle === '') return undefined
  const at = text.indexOf(needle)
  if (at < 0) return undefined
  let line = 1
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** The ports tried, in order, never docview's default. */
export function candidatePorts(base: number): number[] {
  const first = Number.isInteger(base) && base > 0 && base < 65_536 - PORT_COUNT ? base : 4100
  return Array.from({ length: PORT_COUNT }, (_, i) => first + i).filter(port => port !== DOCVIEW_DEFAULT_PORT)
}

/** What answers on a port, from docview's `/api/info`: our root, or anything else. */
export function judgeInfo(text: string, root: string): 'same' | 'other' {
  try {
    const info = JSON.parse(text) as { rootPath?: unknown }
    return info.rootPath === root ? 'same' : 'other'
  } catch {
    return 'other'
  }
}

export const commandArgv = (command: string) => {
  const argv = command.trim().split(/\s+/).filter(part => part !== '')
  return argv.length === 0 ? ['docview'] : argv
}

export const serveArgs = (root: string, port: number) => [root, '--no-open', '--no-remote', '--host', '127.0.0.1', '-p', String(port)]

/** Records a change, newest last; a path changed again moves to the end. */
export function withChange(docs: readonly Doc[], change: Omit<Doc, 'edits'>, keep = 50): Doc[] {
  const was = docs.find(doc => doc.path === change.path)
  const next: Doc = { ...change, edits: (was?.edits ?? 0) + 1 }
  return [...docs.filter(doc => doc.path !== change.path), next].slice(-keep)
}

export function statusOf(server: Server): string | undefined {
  switch (server.kind) {
    case 'off':
      return undefined
    case 'starting':
      return '📄 docview 起動中'
    case 'up':
      return `📄 docview :${server.port}`
    case 'failed':
      return '📄 docview ✗'
  }
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

export function tailOf(text: string, count: number): string[] {
  return text
    .replace(ANSI, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .slice(-count)
}

export const isNotFound = (err: unknown) => /\bENOENT\b|not found|no such file/i.test(String(err))
