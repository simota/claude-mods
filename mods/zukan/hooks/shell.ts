// Reading a Bash command the way a shell would, far enough to judge it. A best-effort
// reader, not a shell: words split on unquoted whitespace with quotes and escapes taken
// off; simple commands cut at && || ; | & newlines and ( ) { }; comments, redirections and
// heredoc bodies set aside; $(…), backticks, <(…) and `bash -c` / `eval` text read again as
// commands of their own. Text inside quotes is a word, never an operator.

export type Op = '' | '&&' | '||' | ';' | ';;' | '|' | '|&' | '&' | '\n'

export type Redirect = { op: string; target?: string }

/** One simple command: its words, its redirections, and the operator that follows it. */
export type Simple = { words: string[]; redirects: Redirect[]; after: Op }

export type Parsed = { commands: Simple[]; nested: string[] }

const MAX_DEPTH = 8

/** The index just past the `)` closing a `(` opened just before `open`, quotes and nesting kept. */
function closing(text: string, open: number): number {
  let depth = 1
  let i = open
  while (i < text.length) {
    const ch = text[i] as string
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === '"') {
      i = quoted(text, i + 1).end
      continue
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === '(') depth += 1
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return text.length
}

/** The text of a double-quoted string starting at `from`, and the substitutions inside it. */
function quoted(text: string, from: number): { value: string; end: number; nested: string[] } {
  let value = ''
  const nested: string[] = []
  let j = from
  while (j < text.length && text[j] !== '"') {
    const ch = text[j] as string
    if (ch === '\\' && j + 1 < text.length) {
      value += text[j + 1]
      j += 2
    } else if (ch === '$' && text[j + 1] === '(' && text[j + 2] !== '(') {
      const end = closing(text, j + 2)
      nested.push(text.slice(j + 2, end - 1))
      value += text.slice(j, end)
      j = end
    } else if (ch === '`') {
      const end = text.indexOf('`', j + 1)
      const stop = end === -1 ? text.length : end
      nested.push(text.slice(j + 1, stop))
      value += text.slice(j, stop + 1)
      j = stop + 1
    } else {
      value += ch
      j += 1
    }
  }
  return { value, end: j + 1, nested }
}

const OPERATOR = /^(&&|\|\||;;|\|&|[;|&\n])/
// > >> >| >& <& <> < &> &>>, with an fd duplication (2>&1, >&-) taken whole.
const REDIRECT = /^(&>>?|[<>]&[0-9]+-?|[<>]&-|>>|>\||<>|>&|<&|[<>])/

export function parse(command: string): Parsed {
  const commands: Simple[] = []
  const nested: string[] = []
  let words: string[] = []
  let redirects: Redirect[] = []
  let word: string | undefined
  let pendingRedirect: Redirect | undefined
  let heredocs: { tag: string; isTabbed: boolean }[] = []
  let i = 0

  const endWord = () => {
    if (word === undefined) return
    if (pendingRedirect !== undefined) {
      pendingRedirect.target = word
      pendingRedirect = undefined
    } else words.push(word)
    word = undefined
  }
  const endCommand = (after: Op) => {
    endWord()
    pendingRedirect = undefined
    if (words.length > 0 || redirects.length > 0) {
      commands.push({ words, redirects, after })
    } else if (after !== '') {
      // An operator after a group's `)`: it belongs to the command the group ended with.
      const last = commands[commands.length - 1]
      if (last !== undefined && last.after === '') last.after = after
    }
    words = []
    redirects = []
  }
  const skipHeredocBodies = () => {
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
      const text = quoted(command, i + 1)
      word = (word ?? '') + text.value
      nested.push(...text.nested)
      i = text.end
      continue
    }
    if (ch === '`') {
      const end = command.indexOf('`', i + 1)
      const stop = end === -1 ? command.length : end
      nested.push(command.slice(i + 1, stop))
      word = (word ?? '') + command.slice(i, stop + 1)
      i = stop + 1
      continue
    }
    if (ch === '$' && command.startsWith('$((', i)) {
      // Arithmetic: one word, whatever `<<` or `)` it holds.
      const end = closing(command, i + 2)
      const stop = command.startsWith(')', end) ? end + 1 : end
      word = (word ?? '') + command.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '$' && command[i + 1] === '(') {
      const end = closing(command, i + 2)
      nested.push(command.slice(i + 2, end - 1))
      word = (word ?? '') + command.slice(i, end)
      i = end
      continue
    }
    if (ch === '$' && command[i + 1] === '{') {
      const end = command.indexOf('}', i + 2)
      const stop = end === -1 ? command.length : end + 1
      word = (word ?? '') + command.slice(i, stop)
      i = stop
      continue
    }
    if ((ch === '<' || ch === '>') && command[i + 1] === '(') {
      // Process substitution: a command whose output stands in for a file.
      const end = closing(command, i + 2)
      nested.push(command.slice(i + 2, end - 1))
      word = (word ?? '') + command.slice(i, end)
      i = end
      continue
    }
    if (ch === '#' && word === undefined) {
      // A comment runs to the end of the line; the newline itself still ends the command.
      const lineEnd = command.indexOf('\n', i)
      i = lineEnd === -1 ? command.length : lineEnd
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
        redirects.push({ op: isTabbed ? '<<-' : '<<', target: match[2] as string })
        i = j + match[0].length
        continue
      }
    }
    if (ch === '<' && command.startsWith('<<<', i)) {
      endWord()
      pendingRedirect = { op: '<<<' }
      redirects.push(pendingRedirect)
      i += 3
      continue
    }
    const redirect =
      ch === '<' || ch === '>' || (ch === '&' && command[i + 1] === '>') ? REDIRECT.exec(command.slice(i)) : null
    if (redirect !== null) {
      // A bare fd number glued in front (2>, 1>>) is part of the redirection.
      if (word !== undefined && /^[0-9]+$/.test(word)) word = undefined
      endWord()
      const op = redirect[0]
      const entry: Redirect = { op }
      redirects.push(entry)
      if (!/&([0-9]+-?|-)$/.test(op)) pendingRedirect = entry
      i += op.length
      continue
    }
    const op = OPERATOR.exec(command.slice(i))
    if (op !== null) {
      endCommand(op[0] as Op)
      i += op[0].length
      if (op[0] === '\n' && heredocs.length > 0) skipHeredocBodies()
      continue
    }
    if (ch === ' ' || ch === '\t') {
      endWord()
      i += 1
      continue
    }
    if (ch === '(' || ch === ')' || ((ch === '{' || ch === '}') && word === undefined)) {
      // A subshell or group edge, glued to a word or not: what is inside runs as commands.
      endCommand('')
      i += 1
      continue
    }
    word = (word ?? '') + ch
    i += 1
  }
  endCommand('')
  return { commands, nested }
}

/** Every simple command a command line runs, substitutions and `bash -c` / `eval` text included. */
export function allCommands(command: string, depth = 0): Simple[] {
  if (depth > MAX_DEPTH) return []
  const { commands, nested } = parse(command)
  const out: Simple[] = []
  for (const one of commands) {
    out.push(one)
    const inner = innerText(one.words)
    if (inner !== undefined) out.push(...allCommands(inner, depth + 1))
  }
  for (const text of nested) out.push(...allCommands(text, depth + 1))
  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Words a shell reads as syntax before the command they lead.
const PREFIX_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', 'fi', 'done', 'esac'])
// Words that open a clause which is not a command (`for x in a b`, `case x in`).
const CLAUSE_KEYWORDS = new Set(['for', 'case', 'select', 'function'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

// Wrappers that run the command after them, with the options of each that take a value.
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir', '--prompt']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  command: new Set([]),
  exec: new Set(['-a']),
  nohup: new Set([]),
  time: new Set(['-f', '--format', '-o', '--output']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines']),
  xcrun: new Set(['--sdk', '--toolchain']),
  caffeinate: new Set(['-t', '-w']),
}
// timeout takes options, then a duration, then the command.
const TIMEOUT_VALUES = new Set(['-s', '--signal', '-k', '--kill-after'])
// Runners whose next word is the program they run; 2 = the second word must be run/exec.
const RUNNERS: Record<string, number> = { npx: 1, bunx: 1, pnpx: 1, uvx: 1, pipx: 2, uv: 2, poetry: 2, pdm: 2, rye: 2, bundle: 2 }

export const base = (word: string) => word.slice(word.lastIndexOf('/') + 1)

/** The program a simple command runs and its arguments, past assignments, keywords and wrappers. */
export function program(words: readonly string[]): { name: string; args: string[] } | undefined {
  let k = 0
  for (;;) {
    const word = words[k]
    if (word === undefined) return undefined
    const name = base(word)
    if (CLAUSE_KEYWORDS.has(word)) return undefined
    if (ASSIGNMENT.test(word) || PREFIX_KEYWORDS.has(word)) {
      k += 1
    } else if (WRAPPERS[name] !== undefined && word === name) {
      const values = WRAPPERS[name] as Set<string>
      k += 1
      while (words[k] !== undefined && (words[k] as string).startsWith('-')) {
        const option = words[k] as string
        k += 1
        if (option === '--') break
        if (values.has(option)) k += 1
      }
      if (name === 'env') while (words[k] !== undefined && ASSIGNMENT.test(words[k] as string)) k += 1
    } else if (name === 'timeout' && word === name) {
      k += 1
      while (words[k] !== undefined && (words[k] as string).startsWith('-')) {
        const option = words[k] as string
        k += 1
        if (TIMEOUT_VALUES.has(option)) k += 1
      }
      k += 1 // the duration
    } else if (RUNNERS[name] !== undefined) {
      const skip = RUNNERS[name] as number
      if (skip === 2 && words[k + 1] !== 'run' && words[k + 1] !== 'exec') break
      k += skip
      while (words[k]?.startsWith('-')) k += 1
    } else break
  }
  const name = words[k]
  if (name === undefined) return undefined
  return { name: base(name), args: words.slice(k + 1) }
}

/** The command text a `bash -c "<text>"` or `eval <words>` runs, if the words are one. */
export function innerText(words: readonly string[]): string | undefined {
  const run = program(words)
  if (run === undefined) return undefined
  if (run.name === 'eval') return run.args.join(' ')
  if (SHELLS.has(run.name)) {
    for (let k = 0; k < run.args.length; k++) {
      const arg = run.args[k] as string
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return run.args[k + 1]
      if (!arg.startsWith('-')) return undefined // a script file
    }
  }
  return undefined
}

// ---- verification ---------------------------------------------------------------------

const SCRIPT = /^(test|tests|lint|typecheck|type-check|tsc|check|build|verify)([:-].*)?$/
const MAKE_TARGET = /^(test|tests|check|lint|build|verify|typecheck)([:-].*)?$/
const GRADLE_TASK = /^(:?[\w-]+:)*(test\w*|check|build|lint\w*|assemble\w*|connected\w*)$/
const DIRECT = new Set([
  'tsc', 'vue-tsc', 'mypy', 'pyright', 'eslint', 'ruff', 'vitest', 'jest', 'pytest', 'xcodebuild',
  'swiftlint', 'ktlint', 'detekt', 'golangci-lint', 'rubocop', 'phpunit', 'phpstan', 'tox', 'nox',
  'cargo-nextest', 'flake8', 'pylint', 'black', 'shellcheck', 'stylelint', 'playwright', 'rspec', 'ctest',
])
// Package-manager options that take the next word as their value.
const PM_VALUES = new Set(['-C', '--dir', '--filter', '-F', '--prefix', '-w', '--workspace', '--cwd'])
// Asking a tool its version or usage runs no check.
const INFO_ONLY = new Set(['--version', '-version', '--help', '-help'])

const firstPlain = (args: string[]) => args.find(arg => !arg.startsWith('-'))

/** The positional words of a package-manager call, its value-taking options stepped over. */
function pmWords(args: string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] as string
    if (PM_VALUES.has(arg)) k += 1
    else if (!arg.startsWith('-')) out.push(arg)
  }
  return out
}

function isCheckProgram(words: readonly string[]): boolean {
  const run = program(words)
  if (run === undefined) return false
  const { name, args } = run
  if (args.some(arg => INFO_ONLY.has(arg)) || (args.length === 1 && (args[0] === '-v' || args[0] === '-V'))) return false
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
    case 'dotnet':
      return sub !== undefined && ['test', 'build'].includes(sub)
    case 'mvn':
    case 'mvnw':
      return args.some(arg => arg === 'test' || arg === 'verify')
    case 'node':
      return args.includes('--test')
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
      let plain = pmWords(args)
      if (name === 'yarn' && plain[0] === 'workspace') plain = plain.slice(2)
      const [first, second] = plain
      if (first === undefined) return false
      if (first === 'run' || first === 'run-script') return second !== undefined && SCRIPT.test(second)
      if (first === 't') return name === 'npm'
      return SCRIPT.test(first)
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

function isCheckCommand(simple: Simple, depth: number): boolean {
  if (isCheckProgram(simple.words)) return true
  const inner = innerText(simple.words)
  return inner !== undefined && depth < MAX_DEPTH && verifies(inner, depth + 1)
}

// Between the check and the end, only these keep the check's failure the command's failure.
const CARRIES_FAILURE = new Set<Op>(['&&', '|', '|&'])

function verifies(command: string, depth: number): boolean {
  const { commands } = parse(command)
  return commands.some((one, k) => {
    if (!isCheckCommand(one, depth)) return false
    const later = commands.slice(k + 1)
    if (later.length === 0) return one.after === '' || one.after === ';' || one.after === '\n'
    // `npm test | tail`, `npm test || true`, `npm test; git status`: the exit status is not the check's.
    if (one.after !== '&&') return false
    return later.slice(0, -1).every(next => CARRIES_FAILURE.has(next.after))
  })
}

/**
 * Whether a command's exit status is that of a test, lint, typecheck or build step: the
 * check is the last command, or only `&&` chains follow it, so a failing check fails the command.
 */
export function isVerification(command: string): boolean {
  return verifies(command, 0)
}

// ---- hooks off ------------------------------------------------------------------------

const NO_VERIFY = '--no-verify'
// Options of git itself that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
// Subcommand options whose next word is a value, never an option of its own.
const SUB_VALUE_OPTIONS = new Set([
  '-m', '--message', '-F', '--file', '-e', '--regexp', '--grep', '-S', '-G', '--author', '--committer',
  '-C', '-c', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--template', '-t', '--date',
  '--cleanup', '--pathspec-from-file', '-X', '--strategy-option', '-s', '--strategy', '-o', '--push-option',
  '--exec', '--onto', '--format', '--pretty', '--trailer', '--since', '--until',
])
// `git commit` short options whose value is the rest of the cluster, or the next word when last.
const COMMIT_VALUE_SHORTS = new Set(['m', 'F', 'C', 'c', 't'])
// `git commit` short options whose optional value can only be glued (-uno, -Skey).
const COMMIT_GLUED_SHORTS = new Set(['u', 'S'])

/** Whether one word spells --no-verify: the whole option, or a prefix git accepts (--no-ver…). */
const spellsNoVerify = (arg: string) => arg.length >= 8 && NO_VERIFY.startsWith(arg)

/** In `git commit`, whether a short-option cluster sets -n (git commit's --no-verify). */
function clusterHasN(cluster: string): { hasN: boolean; takesNext: boolean } {
  for (let k = 1; k < cluster.length; k++) {
    const flag = cluster[k] as string
    if (flag === 'n') return { hasN: true, takesNext: false }
    if (COMMIT_VALUE_SHORTS.has(flag)) return { hasN: false, takesNext: k === cluster.length - 1 }
    if (COMMIT_GLUED_SHORTS.has(flag)) return { hasN: false, takesNext: false }
  }
  return { hasN: false, takesNext: false }
}

// Environment assignments that switch off the hook managers git runs (husky, lefthook, pre-commit).
const HOOK_OFF_ENV = /^(?:HUSKY=(?:0|false)|HUSKY_SKIP_HOOKS=|LEFTHOOK=(?:0|false)|SKIP=)/

/** `-c core.hooksPath=…` or `--config-env core.hooksPath=…`: the hooks moved for one command. */
const movesHooks = (option: string, value: string | undefined) =>
  (option === '-c' || option === '--config-env') && value !== undefined && /^core\.hookspath=/i.test(value)

function bypassesHooks(simple: Simple): boolean {
  const run = program(simple.words)
  if (run === undefined || run.name !== 'git') return false
  const { args } = run
  // The words before git: `HUSKY=0 git commit`, `env SKIP=lint git commit`.
  const before = simple.words.slice(0, simple.words.length - args.length - 1)
  if (before.some(word => HOOK_OFF_ENV.test(word))) return true

  let k = 0
  while (k < args.length && (args[k] as string).startsWith('-')) {
    const option = args[k] as string
    if (movesHooks(option, args[k + 1])) return true
    k += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
  }
  const sub = args[k]
  if (sub === undefined) return false

  const rest = args.slice(k + 1)
  for (let j = 0; j < rest.length; j++) {
    const arg = rest[j] as string
    if (arg === '--') break
    if (sub === 'commit' && /^-[A-Za-z]+$/.test(arg) && arg.length > 2) {
      const { hasN, takesNext } = clusterHasN(arg)
      if (hasN) return true
      if (takesNext) j += 1
      continue
    }
    if (SUB_VALUE_OPTIONS.has(arg)) {
      j += 1
      continue
    }
    if (spellsNoVerify(arg)) return true
    if (sub === 'commit' && arg === '-n') return true
  }
  return false
}

/**
 * Whether a command runs git with its hooks switched off (--no-verify, a prefix of it,
 * `git commit -n`, `-c core.hooksPath=…`, or a hook manager's off switch in its environment),
 * anywhere it runs: chained, grouped, substituted, or inside `bash -c`.
 * Best effort: a git alias (`git ci -n`), a hook path written into config beforehand, or an
 * environment exported by an earlier command is not seen.
 */
export function skipsHooks(command: string): boolean {
  return allCommands(command).some(bypassesHooks)
}
