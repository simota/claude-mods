// Mutation, pure: which lines changed, the small changes worth making to them, and the
// command that runs the project's tests.

import type { Mutant } from '../types'

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|specs|testdata|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb|exs?)$|(?:^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(?:swift|kt|java|cs)$/
const SOURCE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|swift|kt|java|cs|php|scala|c|cc|cpp|h|hpp)$/

export const isMutable = (path: string): boolean => SOURCE.test(path) && !TEST_PATH.test(path) && !/\.d\.ts$/.test(path)

/** The new-side line numbers each file's hunks touch, from `git diff -U0`. */
export function changedLines(diff: string): Map<string, number[]> {
  const out = new Map<string, number[]>()
  let file: string | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).trim()
      file = name === '/dev/null' ? undefined : name.replace(/^b\//, '')
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk === null || file === undefined) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    const list = out.get(file) ?? []
    for (let n = start; n < start + count; n += 1) list.push(n)
    out.set(file, list)
  }
  return out
}

/** Which characters of a line are code: not inside a string literal or a trailing comment. */
export function codeMask(line: string, hashComments: boolean): boolean[] {
  const mask: boolean[] = new Array(line.length).fill(true)
  let quote: string | undefined
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string
    if (quote !== undefined) {
      mask[i] = false
      if (ch === '\\') {
        if (i + 1 < line.length) mask[i + 1] = false
        i += 1
      } else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      mask[i] = false
      continue
    }
    if ((ch === '/' && line[i + 1] === '/') || (hashComments && ch === '#')) {
      for (let j = i; j < line.length; j += 1) mask[j] = false
      break
    }
  }
  return mask
}

type Operator = { name: string; find: RegExp; to: string | ((found: string) => string) }

// Comparisons and arithmetic only with spaces around them, so generics (`Array<T>`), arrows
// (`=>`, `->`), JSX and unary signs are left alone.
const OPERATORS: Operator[] = [
  { name: '===→!==', find: / === /g, to: ' !== ' },
  { name: '!==→===', find: / !== /g, to: ' === ' },
  { name: '==→!=', find: / == /g, to: ' != ' },
  { name: '!=→==', find: / != /g, to: ' == ' },
  { name: '<=→<', find: / <= /g, to: ' < ' },
  { name: '>=→>', find: / >= /g, to: ' > ' },
  { name: '<→<=', find: / < /g, to: ' <= ' },
  { name: '>→>=', find: / > /g, to: ' >= ' },
  { name: '&&→||', find: / && /g, to: ' || ' },
  { name: '||→&&', find: / \|\| /g, to: ' && ' },
  { name: 'and→or', find: / and /g, to: ' or ' },
  { name: 'or→and', find: / or /g, to: ' and ' },
  { name: '+→-', find: / \+ /g, to: ' - ' },
  { name: '-→+', find: / - /g, to: ' + ' },
  { name: '*→/', find: / \* /g, to: ' / ' },
  { name: 'true→false', find: /\btrue\b/g, to: 'false' },
  { name: 'false→true', find: /\bfalse\b/g, to: 'true' },
  { name: 'True→False', find: /\bTrue\b/g, to: 'False' },
  { name: 'False→True', find: /\bFalse\b/g, to: 'True' },
  { name: '!x→x', find: /!(?=[A-Za-z_($])/g, to: '' },
  { name: 'n→n+1', find: /(?<![\w.$])\d+(?![\w.])/g, to: found => String(Number(found) + 1) },
]

const SKIP_LINE = /^(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|use\s|#include|package\s|require\(|\/\/|\/\*|\*|#(?!\[)|--|@)/

/**
 * Every mutant of one line: each operator at each place it applies in the code part of the
 * line. Imports, comments and decorators make none.
 */
export function mutantsOf(path: string, line: number, text: string): Mutant[] {
  const trimmed = text.trim()
  if (trimmed === '' || SKIP_LINE.test(trimmed)) return []
  const mask = codeMask(text, /\.(?:py|rb)$/.test(path))
  const out: Mutant[] = []
  for (const op of OPERATORS) {
    for (const m of text.matchAll(op.find)) {
      const at = m.index ?? 0
      if (!mask.slice(at, at + m[0].length).every(Boolean)) continue
      const to = typeof op.to === 'string' ? op.to : op.to(m[0])
      const mutated = `${text.slice(0, at)}${to}${text.slice(at + m[0].length)}`
      if (mutated !== text) out.push({ path, line, operator: op.name, original: trimmed, mutated: mutated.trim() })
    }
  }
  return out
}

/** At most `max` mutants, taken round-robin across lines so every changed line gets one first. */
export function spread(byLine: readonly Mutant[][], max: number): Mutant[] {
  const picked: Mutant[] = []
  const queues = byLine.map(list => [...list])
  while (picked.length < max && queues.some(q => q.length > 0)) {
    for (const q of queues) {
      const one = q.shift()
      if (one !== undefined && picked.length < max) picked.push(one)
    }
  }
  return picked
}

/** Puts a mutant into a file's text, or undefined when the line no longer reads as it did. */
export function apply(fileText: string, mutant: Mutant): string | undefined {
  const lines = fileText.split('\n')
  const at = mutant.line - 1
  const current = lines[at]
  if (current === undefined || current.trim() !== mutant.original) return undefined
  const indent = current.slice(0, current.length - current.trimStart().length)
  lines[at] = `${indent}${mutant.mutated}`
  return lines.join('\n')
}

/** The project's test command, guessed from the files at its root. */
export function guessCommand(files: ReadonlySet<string>, packageJson: string | undefined, makefile: string | undefined): string | undefined {
  if (makefile !== undefined && /^test\s*:/m.test(makefile)) return 'make test'
  if (packageJson !== undefined) {
    try {
      const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, string> }).scripts ?? {}
      if (typeof scripts.test === 'string' && !/no test specified/.test(scripts.test)) {
        const runner = files.has('pnpm-lock.yaml') ? 'pnpm' : files.has('yarn.lock') ? 'yarn' : files.has('bun.lockb') || files.has('bun.lock') ? 'bun run' : 'npm'
        return `${runner} test`
      }
    } catch {
      // A package.json that does not parse says nothing of the tests.
    }
  }
  if (files.has('Cargo.toml')) return 'cargo test --quiet'
  if (files.has('go.mod')) return 'go test ./...'
  if (files.has('pyproject.toml') || files.has('pytest.ini') || files.has('setup.cfg') || files.has('tox.ini')) return 'python3 -m pytest -q -x'
  if (files.has('Package.swift')) return 'swift test'
  return undefined
}

export type Tally = { killed: number; survived: number; timeout: number; skipped: number; score: number | undefined }

export function tallyOf(mutants: readonly Mutant[]): Tally {
  const count = (outcome: Mutant['outcome']) => mutants.filter(one => one.outcome === outcome).length
  const killed = count('killed')
  const survived = count('survived')
  const timeout = count('timeout')
  const judged = killed + survived + timeout
  return { killed, survived, timeout, skipped: count('skipped'), score: judged === 0 ? undefined : Math.round(((killed + timeout) / judged) * 100) }
}

export const scoreLine = (t: Tally): string =>
  `検出 ${t.killed + t.timeout} · 生存 ${t.survived}${t.skipped > 0 ? ` · 対象外 ${t.skipped}` : ''}${t.score !== undefined ? ` · スコア ${t.score}%` : ''}`
