// The map, pure: where a tool call landed in the repository, what it did there, and the
// tree drawn from it — fog where nothing was touched, marks where something was.

import type { FogFile } from '../types'

export const MILESTONES = [25, 50, 75, 100]
/** Programs whose file arguments a Bash command reads. */
const READERS = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'grep', 'rg', 'awk', 'wc', 'diff', 'cmp', 'jq'])

export const blank = (at: number): FogFile => ({ reads: 0, edits: 0, added: 0, removed: 0, errors: 0, isNew: false, at })

/** A path as the repository names it, or undefined when it lies outside. */
// Trailing slashes off, by a loop: `/\/+$/` tries from every slash of a long run.
function trimSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1
  return path.slice(0, end)
}

// No path is longer: a `cd` past it is not followed, so a chain of them is not read on forever.
const PATH_MAX = 4096

export function inRepo(path: string, root: string, cwd: string): string | undefined {
  const full = path.startsWith('/') ? path : `${trimSlashes(cwd)}/${path}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const clean = `/${parts.join('/')}`
  const base = trimSlashes(root)
  return clean.startsWith(`${base}/`) ? clean.slice(base.length + 1) : undefined
}

export function withRead(file: FogFile | undefined, at: number): FogFile {
  const one = file ?? blank(at)
  return { ...one, reads: one.reads + 1, at }
}

/** An edit's mark: its lines added and removed, and the errors it answers cleared. */
export function withEdit(file: FogFile | undefined, change: { added: number; removed: number; isNew?: boolean }, at: number): FogFile {
  const one = file ?? blank(at)
  return {
    ...one,
    edits: one.edits + 1,
    added: one.added + change.added,
    removed: one.removed + change.removed,
    errors: 0,
    isNew: one.isNew || change.isNew === true,
    at,
  }
}

export function withError(file: FogFile | undefined, at: number): FogFile {
  const one = file ?? blank(at)
  return { ...one, errors: one.errors + 1, at }
}

/**
 * The lines a change adds and removes, as a diff stat counts them: lines of the new text
 * not matched by an equal line of the old, and the old ones left unmatched.
 */
export function editChange(oldText: string, newText: string): { added: number; removed: number } {
  const left = new Map<string, number>()
  for (const line of oldText === '' ? [] : oldText.split('\n')) left.set(line, (left.get(line) ?? 0) + 1)
  let added = 0
  for (const line of newText === '' ? [] : newText.split('\n')) {
    const count = left.get(line) ?? 0
    if (count > 0) left.set(line, count - 1)
    else added += 1
  }
  const removed = [...left.values()].reduce((sum, n) => sum + n, 0)
  return { added, removed }
}

/** The words of a Bash command, quotes taken off; a best-effort split, not a shell. */
const words = (part: string): string[] => part.trim().split(/\s+/).map(word => word.replace(/^['"]|['"]$/g, ''))

/**
 * What a Bash command reads and edits among the given paths: `cat a`, `sed -n 1,9p a`,
 * `sed -i … a`. A `cd` moves where the parts after it resolve (`cd mods && cat a.ts`);
 * one into a place it cannot follow (`cd -`, `cd $DIR`) stops it reading further parts.
 */
export function bashTouches(
  command: string,
  cwd: string,
  isKnown: (word: string, cwd: string) => string | undefined,
): { reads: string[]; edits: string[] } {
  const reads = new Set<string>()
  const edits = new Set<string>()
  // Fold only each new cd operand, not the whole growing path again. Materialize
  // the directory only when a reader needs it; no cd leaves the original cwd as is.
  let directory: string[] | undefined
  let directoryLength = 0
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const [program = '', ...rest] = words(part)
    if (program === 'cd') {
      const to = rest[0]
      // Once the directory is unknown, no later part was followed anyway.
      if (to === undefined || to === '-' || to.startsWith('~') || to.includes('$')) break
      const path = to.startsWith('/') || directory !== undefined ? to : `${trimSlashes(cwd)}/${to}`
      if (directory === undefined || to.startsWith('/')) {
        directory = []
        directoryLength = 0
      }
      for (const segment of path.split('/')) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') {
          const removed = directory.pop()
          if (removed !== undefined) directoryLength -= removed.length + 1
        } else {
          directory.push(segment)
          directoryLength += segment.length + 1
        }
      }
      if (Math.max(1, directoryLength) > PATH_MAX) break
      continue
    }
    const name = program.slice(program.lastIndexOf('/') + 1)
    if (!READERS.has(name)) continue
    const currentDirectory = directory === undefined ? cwd : `/${directory.join('/')}`
    const isInPlace = name === 'sed' && rest.some(word => /^-[a-zA-Z]*i/.test(word) || word === '--in-place')
    for (const word of rest) {
      if (word.startsWith('-')) continue
      const path = isKnown(word, currentDirectory)
      if (path !== undefined) (isInPlace ? edits : reads).add(path)
    }
  }
  return { reads: [...reads], edits: [...edits] }
}

const PATH_WORD = /[\w.@~+/-]+/g
const LINE_MARK = /:\d+|\(\d+,\d+\)/y
const EXTENSION = /^[A-Za-z]\w*$/

/**
 * Paths a failed command's output names with a line (`a.ts:12`, `a.ts(12,5)`), as candidates.
 * Linear: each word is read once and only its last dot is tried, the dot a path's extension
 * must follow; a regex trying every dot of a long word took seconds on a minified line.
 */
export function errorPaths(output: string): string[] {
  const found = new Set<string>()
  let taken = 0 // where the last mark ended: a path never starts inside one (`a.ts:12.b.ts:3`)
  for (const word of output.matchAll(PATH_WORD)) {
    const end = word.index + word[0].length
    LINE_MARK.lastIndex = end
    const mark = LINE_MARK.exec(output)
    if (mark === null) continue
    const path = output.slice(Math.max(word.index, taken), end)
    const dot = path.lastIndexOf('.')
    if (dot < 1 || !EXTENSION.test(path.slice(dot + 1))) continue
    found.add(path)
    taken = end + mark[0].length
  }
  return [...found]
}

/**
 * The `git grep -E` pattern for a file's importers, or undefined for a language it does not
 * read. POSIX classes only: the git macOS ships matches nothing for `\s`, `\w` or `\b` there.
 */
export function importPattern(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return String.raw`(from|import|require\()[[:space:]]*\(?['"][^'"]*[/.]${stem}(\.[a-z]+)?['"]`
  }
  if (ext === 'py') {
    // `from pkg.x import y`, `from .x import y`, `import pkg.x`, `import x as y`, `import a, x`.
    const tail = String.raw`([[:space:],]|$)`
    return String.raw`^[[:space:]]*(from[[:space:]]+([[:alnum:]_.]*\.)?${stem}${tail}|import[[:space:]]+([[:alnum:]_.,[:space:]]*[[:space:],.])?${stem}${tail})`
  }
  return undefined
}

export type Counts = { read: number; edited: number; errors: number; touched: number; total: number; percent: number }

/** `tracked` is `new Set(files)` from a cache, when there is one: the list is not read again. */
export function countsOf(touched: Readonly<Record<string, FogFile>>, files: readonly string[], tracked: ReadonlySet<string> = new Set(files)): Counts {
  const all = Object.entries(touched)
  const inside = all.filter(([path]) => tracked.has(path) || touched[path]?.isNew === true)
  const total = tracked.size + all.filter(([path, one]) => one.isNew && !tracked.has(path)).length
  return {
    read: all.filter(([, one]) => one.reads > 0 && one.edits === 0).length,
    edited: all.filter(([, one]) => one.edits > 0).length,
    errors: all.filter(([, one]) => one.errors > 0).length,
    touched: inside.length,
    total,
    percent: total === 0 ? 0 : Math.floor((inside.length / total) * 100),
  }
}

/** The milestone a new percentage crosses, if any. */
export function milestoneOf(previous: number, percent: number): number | undefined {
  return MILESTONES.filter(one => one > previous && percent >= one).at(-1)
}

/** The area a path belongs to, announced the first time it is edited: `mods/zukan/`. */
export function areaOf(path: string): string {
  const parts = path.split('/')
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : './'
}

/** Files that import an edited one and were never opened: what an edit may have broken unseen. */
export function warningsOf(touched: Readonly<Record<string, FogFile>>, importers: Readonly<Record<string, string[]>>): string[] {
  const notes: string[] = []
  for (const [path, one] of Object.entries(touched)) {
    if (one.edits > 0 && one.reads === 0 && !one.isNew) notes.push(`編集したのに一度も読んでいない: ${path}`)
  }
  const unseen = new Set<string>()
  for (const [edited, list] of Object.entries(importers)) {
    if ((touched[edited]?.edits ?? 0) === 0) continue
    for (const importer of list) {
      const one = touched[importer]
      if (one === undefined || (one.reads === 0 && one.edits === 0)) unseen.add(importer)
    }
  }
  for (const path of [...unseen].sort()) notes.push(`編集したファイルを import しているが未読: ${path}`)
  return notes
}

export const markOf = (one: FogFile): string => (one.errors > 0 ? '✗' : one.isNew ? '✚' : one.edits > 0 ? '●' : '○')

/** The status line entry, only while there is something to look at: an error or a warning. The map and its share stay in `/map`. */
export function statusOf(counts: Counts, warnings: number, hasRepo: boolean): string | undefined {
  if (counts.errors === 0 && warnings === 0) return undefined
  const parts = [hasRepo ? `🗺 ${counts.percent}%` : '🗺', `●${counts.edited}`]
  if (counts.errors > 0) parts.push(`✗${counts.errors}`)
  if (warnings > 0) parts.push(`⚠${warnings}`)
  return parts.join(' · ')
}

export function bar(percent: number, width = 24): string {
  const full = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return `${'█'.repeat(full)}${'░'.repeat(width - full)}`
}

/** One row of the drawn tree. */
export type Row = { depth: number; text: string; kind: 'fog' | 'read' | 'edit' | 'new' | 'error' | 'dir' | 'focus-dir' }

export type Node = { name: string; dirs: Map<string, Node>; files: string[] }

/** The paths as a tree of folders, each name once. */
export function treeOf(paths: Iterable<string>): Node {
  const root: Node = { name: '', dirs: new Map(), files: [] }
  for (const path of new Set(paths)) {
    const parts = path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part)
      if (next === undefined) {
        next = { name: part, dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(parts.at(-1) ?? path)
  }
  return root
}

function hasPath(tree: Node, path: string): boolean {
  const parts = path.split('/')
  let node: Node | undefined = tree
  for (const part of parts.slice(0, -1)) node = node?.dirs.get(part)
  return node !== undefined && node.files.includes(parts.at(-1) ?? path)
}

/**
 * `base` with `paths` it lacks added, as treeOf would have placed them after its own. The
 * folders on their way are copied, so `base`, kept in a cache, is never changed.
 */
function withPaths(base: Node, paths: readonly string[]): Node {
  const root: Node = { ...base, dirs: new Map(base.dirs), files: [...base.files] }
  const copied = new Set<Node>([root])
  for (const path of paths) {
    const parts = path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      const found = node.dirs.get(part)
      let next: Node
      if (found === undefined) next = { name: part, dirs: new Map(), files: [] }
      else if (copied.has(found)) next = found
      else next = { ...found, dirs: new Map(found.dirs), files: [...found.files] }
      copied.add(next)
      node.dirs.set(part, next)
      node = next
    }
    const name = parts.at(-1) ?? path
    if (!node.files.includes(name)) node.files.push(name)
  }
  return root
}

const signed = (one: FogFile): string => (one.edits > 0 ? `+${one.added} −${one.removed}` : '')

/**
 * The tree as rows: a directory holding an edit, a new file or an error is open; one only
 * read is closed with its marks beside it; untouched directories and files at a level are
 * one fog row. The ★ goes on the file touched last.
 */
export function rowsOf(
  files: readonly string[],
  touched: Readonly<Record<string, FogFile>>,
  focus: string | null,
  width: number,
  tree?: Node,
): Row[] {
  const rows: Row[] = []
  // `tree` is treeOf(files) from a cache: only the touched paths it lacks are added, on a copy.
  const root = tree === undefined ? treeOf([...files, ...Object.keys(touched)]) : withPaths(tree, Object.keys(touched).filter(path => !hasPath(tree, path)))

  // Each folder's marks are gathered once: an open folder's are not gathered again for each level
  // above it, and a folder holding no touched path is never read through.
  const holding = new Set<string>()
  for (const path of Object.keys(touched)) {
    for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1)) holding.add(path.slice(0, at + 1))
  }
  const gathered = new Map<Node, FogFile[]>()
  const marksUnder = (node: Node, prefix: string): FogFile[] => {
    if (prefix !== '' && !holding.has(prefix)) return []
    const known = gathered.get(node)
    if (known !== undefined) return known
    const marks = [
      ...node.files.flatMap(name => (touched[`${prefix}${name}`] ? [touched[`${prefix}${name}`] as FogFile] : [])),
      ...[...node.dirs.values()].flatMap(dir => marksUnder(dir, `${prefix}${dir.name}/`)),
    ]
    gathered.set(node, marks)
    return marks
  }

  const walk = (node: Node, prefix: string, depth: number) => {
    const fog: string[] = []
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}${dir.name}/`
      const marks = marksUnder(dir, path)
      if (marks.length === 0) {
        fog.push(`${dir.name}/`)
        continue
      }
      const isOpen = marks.some(one => one.edits > 0 || one.errors > 0 || one.isNew)
      const hasFocus = focus !== null && focus.startsWith(path)
      if (!isOpen) {
        rows.push({ depth, text: `▸ ${dir.name}/  ${marks.map(markOf).join('')}`, kind: hasFocus ? 'focus-dir' : 'dir' })
        continue
      }
      rows.push({ depth, text: `▾ ${dir.name}/`, kind: hasFocus ? 'focus-dir' : 'dir' })
      walk(dir, path, depth + 1)
    }
    for (const name of [...node.files].sort()) {
      const path = `${prefix}${name}`
      const one = touched[path]
      if (one === undefined) {
        fog.push(name)
        continue
      }
      const details = [
        signed(one),
        one.edits > 1 ? `編集 ${one.edits}回` : '',
        one.isNew ? '新規' : '',
        one.errors > 0 ? `エラー ${one.errors}` : '',
        path === focus ? '★' : '',
      ].filter(Boolean)
      const kind = one.errors > 0 ? 'error' : one.isNew ? 'new' : one.edits > 0 ? 'edit' : 'read'
      rows.push({ depth, text: `${markOf(one)} ${name}${details.length > 0 ? `  ${details.join('  ')}` : ''}`, kind })
    }
    if (fog.length > 0) {
      const room = Math.max(10, width - depth * 2)
      let line = ''
      let shown = 0
      for (const name of fog) {
        const next = `${line}${line === '' ? '' : '  '}░ ${name}`
        if (next.length > room - 6 && line !== '') break
        line = next
        shown += 1
      }
      rows.push({ depth, text: shown < fog.length ? `${line}  …${fog.length - shown}` : line, kind: 'fog' })
    }
  }

  walk(root, '', 0)
  return rows
}

// The repository's files are kept in one state value, which the engine holds to 4,194,304
// characters of JSON: past this the list is cut, so the write is never refused and the
// repository never taken for none.
export const MAX_FILES_CHARS = 3_000_000

/** The files a state value can hold, in the order git lists them. */
export function capFiles(files: readonly string[]): string[] {
  const kept: string[] = []
  let size = 2
  for (const file of files) {
    const next = JSON.stringify(file).length + 1
    if (size + next > MAX_FILES_CHARS) break
    size += next
    kept.push(file)
  }
  return kept
}
