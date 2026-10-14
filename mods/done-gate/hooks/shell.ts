// Reading a Bash command the way a shell would, far enough to judge it: words split on
// unquoted whitespace, quotes and escapes taken off, segments cut at && || ; | & and
// newlines, heredoc bodies skipped. Text inside quotes is a word, never an operator.

export type Segment = string[]

const OPERATOR = /^(&&|\|\||;;|[;|&\n])/

export function segments(command: string): Segment[] {
  const out: Segment[] = []
  let words: string[] = []
  let word: string | undefined
  let heredocs: { tag: string; isTabbed: boolean }[] = []
  let i = 0

  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) out.push(words)
    words = []
  }

  while (i < command.length) {
    const ch = command[i] as string
    if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') word = (word ?? '') + command[i + 1]
      i += 2
      continue
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word = (word ?? '') + command.slice(i + 1, stop)
      i = stop + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let text = ''
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) {
          text += command[j + 1]
          j += 2
        } else {
          text += command[j]
          j += 1
        }
      }
      word = (word ?? '') + text
      i = j + 1
      continue
    }
    if (ch === '<' && command.startsWith('<<', i) && !command.startsWith('<<<', i)) {
      endWord()
      let j = i + 2
      const isTabbed = command[j] === '-'
      if (isTabbed) j += 1
      while (command[j] === ' ' || command[j] === '\t') j += 1
      const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(j))
      if (match !== null) {
        heredocs.push({ tag: match[2] as string, isTabbed })
        i = j + match[0].length
        continue
      }
    }
    const op = OPERATOR.exec(command.slice(i))
    if (op !== null) {
      endSegment()
      i += op[0].length
      if (op[0] === '\n' && heredocs.length > 0) {
        // Skip each pending heredoc's body, up to its closing tag line.
        for (const doc of heredocs) {
          while (i < command.length) {
            const lineEnd = command.indexOf('\n', i)
            const stop = lineEnd === -1 ? command.length : lineEnd
            const line = command.slice(i, stop)
            i = stop + 1
            if ((doc.isTabbed ? line.replace(/^\t+/, '') : line) === doc.tag) break
          }
        }
        heredocs = []
      }
      continue
    }
    if (ch === ' ' || ch === '\t') {
      endWord()
      i += 1
      continue
    }
    if ((ch === '(' || ch === ')' || ch === '{' || ch === '}') && word === undefined) {
      // A subshell or group opener: what follows is a command of its own.
      endSegment()
      i += 1
      continue
    }
    word = (word ?? '') + ch
    i += 1
  }
  endSegment()
  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPERS = new Set(['sudo', 'time', 'env', 'nice', 'command', 'exec', 'nohup', 'xcrun'])
// Runners whose next word is the program they run.
const RUNNERS: Record<string, number> = { npx: 1, bunx: 1, uvx: 1, pipx: 2, uv: 2, poetry: 2, pdm: 2, rye: 2 }

const base = (word: string) => word.slice(word.lastIndexOf('/') + 1)

/** The program a segment runs and its arguments, past env assignments and wrappers. */
export function program(segment: Segment): { name: string; args: string[] } | undefined {
  let k = 0
  for (;;) {
    const word = segment[k]
    if (word === undefined) return undefined
    if (ASSIGNMENT.test(word)) k += 1
    else if (WRAPPERS.has(base(word))) {
      k += 1
      while (segment[k]?.startsWith('-')) k += 1
    } else if (RUNNERS[base(word)] !== undefined) {
      const skip = RUNNERS[base(word)] as number
      // `uv run x`, `poetry run x`: the second word must be run/exec.
      if (skip === 2 && segment[k + 1] !== 'run' && segment[k + 1] !== 'exec') break
      k += skip
      while (segment[k]?.startsWith('-')) k += 1
    } else break
  }
  const name = segment[k]
  if (name === undefined) return undefined
  return { name: base(name), args: segment.slice(k + 1) }
}

const SCRIPT = /^(test|tests|lint|typecheck|type-check|tsc|check|build|verify|ci)([:-].*)?$/
const MAKE_TARGET = /^(test|tests|check|lint|build|verify|ci|typecheck)([:-].*)?$/
const GRADLE_TASK = /^(:?[\w-]+:)*(test\w*|check|build|lint\w*|assemble\w*|connected\w*)$/
const DIRECT = new Set([
  'tsc', 'vue-tsc', 'mypy', 'pyright', 'eslint', 'ruff', 'vitest', 'jest', 'pytest', 'xcodebuild',
  'swiftlint', 'ktlint', 'detekt', 'golangci-lint', 'rubocop', 'phpunit', 'phpstan', 'tox', 'nox',
  'cargo-nextest', 'flake8', 'pylint', 'black', 'shellcheck', 'stylelint', 'playwright',
])

const firstPlain = (args: string[]) => args.find(arg => !arg.startsWith('-'))

function isVerifyingSegment(segment: Segment): boolean {
  const run = program(segment)
  if (run === undefined) return false
  const { name, args } = run
  const sub = firstPlain(args)

  if (DIRECT.has(name)) return true
  switch (name) {
    case 'prettier':
    case 'biome':
      return args.includes('--check') || args.includes('-c') || sub === 'check' || sub === 'lint' || sub === 'ci'
    case 'cargo':
      return sub !== undefined && ['test', 'check', 'clippy', 'build', 'nextest'].includes(sub)
    case 'go':
      return sub !== undefined && ['test', 'vet', 'build'].includes(sub)
    case 'swift':
      return sub !== undefined && ['build', 'test'].includes(sub)
    case 'deno':
      return sub !== undefined && ['test', 'check', 'lint'].includes(sub)
    case 'python':
    case 'python3': {
      const m = args.indexOf('-m')
      const mod = m === -1 ? undefined : args[m + 1]
      return mod !== undefined && ['pytest', 'unittest', 'mypy', 'ruff', 'pyright'].includes(mod)
    }
    case 'npm':
    case 'bun':
    case 'pnpm':
    case 'yarn': {
      if (sub === undefined) return false
      if (sub === 'run' || sub === 'run-script') {
        const script = firstPlain(args.slice(args.indexOf(sub) + 1))
        return script !== undefined && SCRIPT.test(script)
      }
      if (sub === 't') return name === 'npm'
      return SCRIPT.test(sub)
    }
    case 'make':
    case 'just':
    case 'task':
      return args.some(arg => !arg.startsWith('-') && MAKE_TARGET.test(arg))
    case 'gradlew':
    case 'gradle':
      return args.some(arg => !arg.startsWith('-') && GRADLE_TASK.test(arg))
    default:
      return false
  }
}

/** Whether a command runs a test, lint, typecheck or build step. */
export function isVerification(command: string): boolean {
  return segments(command).some(isVerifyingSegment)
}

const NO_VERIFY = '--no-verify'
// Options of git itself that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
// `git commit` short options whose value is the rest of the cluster or the next word.
const COMMIT_VALUE_SHORTS = new Set(['m', 'F', 'C', 'c', 't'])

/** Whether one word spells --no-verify: the whole option, or a prefix git accepts (--no-v…). */
const spellsNoVerify = (arg: string) => arg.length >= 6 && NO_VERIFY.startsWith(arg)

/** In `git commit`, whether a short-option cluster sets -n (git commit's --no-verify). */
function clusterHasN(cluster: string): { hasN: boolean; takesNext: boolean } {
  for (let k = 1; k < cluster.length; k++) {
    const flag = cluster[k] as string
    if (flag === 'n') return { hasN: true, takesNext: false }
    if (COMMIT_VALUE_SHORTS.has(flag)) return { hasN: false, takesNext: k === cluster.length - 1 }
  }
  return { hasN: false, takesNext: false }
}

function bypassesHooks(segment: Segment): boolean {
  const run = program(segment)
  if (run === undefined || run.name !== 'git') return false
  const { args } = run

  let k = 0
  while (k < args.length && (args[k] as string).startsWith('-')) {
    const option = args[k] as string
    k += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
  }
  const sub = args[k]
  if (sub === undefined) return false

  const rest = args.slice(k + 1)
  for (let j = 0; j < rest.length; j++) {
    const arg = rest[j] as string
    if (arg === '--') break
    if (spellsNoVerify(arg)) return true
    if (sub === 'commit' && /^-[A-Za-z]+$/.test(arg)) {
      const { hasN, takesNext } = clusterHasN(arg)
      if (hasN) return true
      if (takesNext) j += 1
    }
  }
  return false
}

/** Whether a command runs git with its hooks switched off (--no-verify, or `git commit -n`). */
export function skipsHooks(command: string): boolean {
  return segments(command).some(bypassesHooks)
}
