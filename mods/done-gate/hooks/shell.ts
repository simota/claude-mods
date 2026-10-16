// Reading a Bash command the way a shell would, far enough to judge it. A best-effort
// reader, not a shell: words split on unquoted whitespace with quotes and escapes taken
// off; simple commands cut at && || ; | & newlines and ( ) { }; comments, redirections and
// heredoc bodies set aside; $(…), backticks, <(…) and `bash -c` / `eval` text read again as
// commands of their own. Text inside quotes is a word, never an operator.

export type Op = '' | '&&' | '||' | ';' | ';;' | '|' | '|&' | '&' | '\n'

/** A redirection; a heredoc keeps its body, which a shell reading its stdin runs. */
export type Redirect = { op: string; target?: string; body?: string }

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

/** The text of an ANSI-C quoted string `$'…'` starting at `from`, escapes decoded as bash does. */
function ansiC(text: string, from: number): { value: string; end: number } {
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
  let value = ''
  let j = from
  while (j < text.length && text[j] !== "'") {
    const ch = text[j] as string
    if (ch !== '\\' || j + 1 >= text.length) {
      value += ch
      j += 1
      continue
    }
    const next = text[j + 1] as string
    const code = (digits: string, radix: number) => {
      value += String.fromCodePoint(Number.parseInt(digits, radix))
      j += 2 + digits.length - (radix === 8 ? 1 : 0)
    }
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(j + 1))
    const uni = /^[uU]([0-9a-fA-F]{1,8})/.exec(text.slice(j + 1))
    const oct = /^([0-7]{1,3})/.exec(text.slice(j + 1))
    if (simple[next] !== undefined) {
      value += simple[next]
      j += 2
    } else if (hex !== null) code(hex[1] as string, 16)
    else if (uni !== null && Number.parseInt(uni[1] as string, 16) <= 0x10ffff) code(uni[1] as string, 16)
    else if (oct !== null) {
      value += String.fromCharCode(Number.parseInt(oct[1] as string, 8) & 0xff)
      j += 1 + (oct[1] as string).length
    } else {
      value += `\\${next}`
      j += 2
    }
  }
  return { value, end: j + 1 }
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
  let heredocs: { tag: string; isTabbed: boolean; entry: Redirect }[] = []
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
      const body: string[] = []
      while (i < command.length) {
        const lineEnd = command.indexOf('\n', i)
        const stop = lineEnd === -1 ? command.length : lineEnd
        const line = command.slice(i, stop)
        i = stop + 1
        if ((doc.isTabbed ? line.replace(/^\t+/, '') : line) === doc.tag) break
        body.push(line)
      }
      doc.entry.body = body.join('\n')
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
    if (ch === '$' && command[i + 1] === "'") {
      // ANSI-C quoting: `$'--no-\x76erify'` is --no-verify to the shell.
      const text = ansiC(command, i + 2)
      word = (word ?? '') + text.value
      i = text.end
      continue
    }
    if (ch === '$' && command[i + 1] === '"') {
      // Locale quoting `$"…"` reads as a double-quoted string.
      i += 1
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
        const entry: Redirect = { op: isTabbed ? '<<-' : '<<', target: match[2] as string }
        heredocs.push({ tag: match[2] as string, isTabbed, entry })
        redirects.push(entry)
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
    // `{` and `}` are a group's edges only as words of their own (`{ a; }`), so find's `{}` is a word.
    const isBrace =
      word === undefined && ((ch === '{' && /\s/.test(command[i + 1] ?? '\n')) || (ch === '}' && /^(?:$|[\s;&|)])/.test(command[i + 1] ?? '')))
    if (ch === '(' || ch === ')' || isBrace) {
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

/**
 * Every simple command a command line runs: substitutions, `bash -c` / `eval` / `env -S` text,
 * and the script a shell reads on its stdin (`bash <<< '…'`, a heredoc, `echo '…' | sh`) included.
 */
export function allCommands(command: string, depth = 0): Simple[] {
  if (depth > MAX_DEPTH) return []
  const { commands, nested } = parse(command)
  const out: Simple[] = []
  commands.forEach((one, k) => {
    out.push(one)
    const inner = innerText(one.words)
    if (inner !== undefined) out.push(...allCommands(inner, depth + 1))
    if (readsScriptFromStdin(one.words)) {
      for (const text of stdinOf(one, commands[k - 1])) out.push(...allCommands(text, depth + 1))
    }
  })
  for (const text of nested) out.push(...allCommands(text, depth + 1))
  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Words a shell reads as syntax before the command they lead.
const PREFIX_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', 'fi', 'done', 'esac'])
// Words that open a clause which is not a command (`for x in a b`, `case x in`).
const CLAUSE_KEYWORDS = new Set(['for', 'case', 'select', 'function'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'su', 'script'])
// Shell options whose value is the next word (`bash -o pipefail -c …`).
const SHELL_VALUES = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])

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
  ionice: new Set(['-c', '-n', '-p', '-t', '--class', '--classdata']),
  busybox: new Set([]),
  chronic: new Set([]),
  setsid: new Set([]),
}

/** Words joined back into a command line with each one quoted, so re-reading it keeps them whole. */
const quoteWords = (words: readonly string[]) => words.map(word => `'${word.replace(/'/g, `'\\''`)}'`).join(' ')
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

/** The command text a `bash -c "<text>"`, `eval <words>` or `env -S "<text>"` runs, if the words are one. */
export function innerText(words: readonly string[]): string | undefined {
  // env -S splits its value into the command it runs: `env -S "git commit -n"`.
  const at = words.findIndex(word => base(word) === 'env')
  if (at !== -1 && (at === 0 || words.slice(0, at).every(word => ASSIGNMENT.test(word) || PREFIX_KEYWORDS.has(word) || WRAPPERS[base(word)] !== undefined))) {
    for (let k = at + 1; k < words.length && (words[k] as string).startsWith('-'); k++) {
      const option = words[k] as string
      const glued = /^(?:--split-string=|-[A-RT-Za-z]*S)(.+)$/.exec(option)
      if (glued !== null) return [glued[1], ...words.slice(k + 1)].join(' ')
      if (option === '--split-string' || /^-[A-RT-Za-z]*S$/.test(option)) return words.slice(k + 1).join(' ')
      if (WRAPPERS.env?.has(option) === true) k += 1
    }
  }
  const run = program(words)
  if (run === undefined) return undefined
  if (run.name === 'eval') return run.args.join(' ')
  if (run.name === 'find') {
    // `find … -exec git commit -n \;`: the words up to `;` or `+` run as a command, for every -exec.
    const runs: string[] = []
    for (let k = 0; k < run.args.length; k++) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(run.args[k] as string)) continue
      const end = run.args.findIndex((arg, n) => n > k && (arg === ';' || arg === '+'))
      runs.push(quoteWords(run.args.slice(k + 1, end === -1 ? undefined : end)))
      k = end === -1 ? run.args.length : end
    }
    return runs.length === 0 ? undefined : runs.join(' ; ')
  }
  if (run.name === 'su' || run.name === 'script' || run.name === 'fish') {
    // Their command text comes with -c or --command anywhere, after a user or a log file.
    for (let k = 0; k < run.args.length; k++) {
      const arg = run.args[k] as string
      const glued = /^--command=(.*)$/.exec(arg)
      if (glued !== null) return glued[1]
      if (arg === '--command' || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return run.args[k + 1]
    }
    return undefined
  }
  if (SHELLS.has(run.name)) {
    for (let k = 0; k < run.args.length; k++) {
      const arg = run.args[k] as string
      // The text is the first word after -c that is not an option (`bash -c -- '…'`).
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return run.args.slice(k + 1).find((one, n, rest) => !one.startsWith('-') || rest[n - 1] === '--')
      if (SHELL_VALUES.has(arg)) k += 1
      else if (!arg.startsWith('-') && !arg.startsWith('+')) return undefined // a script file
    }
  }
  return undefined
}

/** Whether a shell runs the script on its stdin: no -c text and no script file, or -s. */
function readsScriptFromStdin(words: readonly string[]): boolean {
  const run = program(words)
  if (run === undefined || !SHELLS.has(run.name)) return false
  if (run.args.some(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) return false
  if (run.args.includes('-s')) return true
  for (let k = 0; k < run.args.length; k++) {
    const arg = run.args[k] as string
    if (SHELL_VALUES.has(arg)) k += 1
    else if (!arg.startsWith('-') && !arg.startsWith('+')) return false // a script file
  }
  return true
}

/** The text a shell reads on its stdin: a here-string, a heredoc's body, or what echo/printf piped into it. */
function stdinOf(one: Simple, before: Simple | undefined): string[] {
  const texts = one.redirects.flatMap(redirect => (redirect.op === '<<<' ? [redirect.target ?? ''] : redirect.body !== undefined ? [redirect.body] : []))
  const piped = before !== undefined && (before.after === '|' || before.after === '|&') ? program(before.words) : undefined
  if (piped !== undefined && (piped.name === 'echo' || piped.name === 'printf')) {
    // Only echo's leading options are options: `echo git commit -n` prints the -n.
    const lead = piped.name === 'echo' ? piped.args.findIndex(arg => !/^-[neE]+$/.test(arg)) : 0
    const text = piped.args.slice(lead === -1 ? piped.args.length : lead).join(' ')
    texts.push(piped.name === 'printf' ? text.replace(/\\n/g, '\n') : text)
  }
  // `cat <<EOF | bash`: the heredoc cat prints is the script.
  if (piped !== undefined && piped.name === 'cat' && before !== undefined) {
    for (const redirect of before.redirects) if (redirect.body !== undefined) texts.push(redirect.body)
  }
  return texts
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

/** Whether a command that runs another passes on its exit status: `find -exec … \;` and `script` without -e exit 0 though it fails. */
function passesStatus(words: readonly string[]): boolean {
  const run = program(words)
  if (run === undefined) return true
  if (run.name === 'find') return run.args.includes('+')
  if (run.name === 'script') return run.args.some(arg => arg === '--return' || /^-[A-Za-z]*e[A-Za-z]*$/.test(arg))
  return true
}

function isCheckCommand(simple: Simple, depth: number): boolean {
  if (isCheckProgram(simple.words)) return true
  if (!passesStatus(simple.words)) return false
  const inner = innerText(simple.words)
  return inner !== undefined && depth < MAX_DEPTH && verifies(inner, depth + 1)
}

// Between the check and the end, only these keep the check's failure the command's failure.
const CARRIES_FAILURE = new Set<Op>(['&&', '|', '|&'])

function verifies(command: string, depth: number): boolean {
  const { commands } = parse(command)
  const last = commands.length - 1
  // carries[i]: every command from i up to the one before the last passes a failure on. Built once from
  // the end, so a command of thousands of checks is not read again after each one.
  const carries: boolean[] = new Array(commands.length + 1).fill(true)
  for (let i = last - 1; i >= 0; i -= 1) carries[i] = CARRIES_FAILURE.has((commands[i] as Simple).after) && (carries[i + 1] as boolean)
  return commands.some((one, k) => {
    if (!isCheckCommand(one, depth)) return false
    if (k === last) return one.after === '' || one.after === ';' || one.after === '\n'
    // `npm test | tail`, `npm test || true`, `npm test; git status`: the exit status is not the check's.
    if (one.after !== '&&') return false
    return carries[k + 1] as boolean
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
// In these subcommands some of the options above are flags with no value (`git commit -s` signs
// off, `-S` signs, `-e` edits), so the word after them is read as an option of its own.
const SUB_FLAGS: Record<string, Set<string>> = {
  commit: new Set(['-s', '-S', '-e', '-o']),
  merge: new Set(['-S', '-e']),
  rebase: new Set(['-S']),
  'cherry-pick': new Set(['-s', '-S', '-e']),
  revert: new Set(['-s', '-S', '-e']),
  am: new Set(['-s', '-S']),
}

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

// Environment assignments that switch off the hook managers git runs (husky, lefthook, pre-commit),
// or move git's hooks through config given in the environment (GIT_CONFIG_KEY_n, GIT_CONFIG_PARAMETERS).
const HOOK_OFF_ENV = /^(?:HUSKY=(?:0|false)|HUSKY_SKIP_HOOKS=|LEFTHOOK=(?:0|false)|SKIP=)/
// Config keys are case-insensitive (core.hooksPath, CORE.HOOKSPATH); the variable names are not.
const HOOKS_PATH_ENV = /^(?:GIT_CONFIG_KEY_\d+=(?:core\.hookspath)$|GIT_CONFIG_PARAMETERS=.*\bcore\.hookspath=)/i

/** `-c core.hooksPath=…` or `--config-env core.hooksPath=…`: the hooks moved for one command. */
const movesHooks = (option: string, value: string | undefined) =>
  (option === '-c' || option === '--config-env') && value !== undefined && /^core\.hookspath=/i.test(value)

function bypassesHooks(simple: Simple): boolean {
  const run = program(simple.words)
  if (run === undefined || run.name !== 'git') return false
  const { args } = run
  // The words before git: `HUSKY=0 git commit`, `env SKIP=lint git commit`.
  const before = simple.words.slice(0, simple.words.length - args.length - 1)
  if (before.some(word => HOOK_OFF_ENV.test(word) || (HOOKS_PATH_ENV.test(word) && /^GIT_CONFIG_/.test(word)))) return true

  let k = 0
  while (k < args.length && (args[k] as string).startsWith('-')) {
    const option = args[k] as string
    if (movesHooks(option, args[k + 1])) return true
    if (/^--config-env=core\.hookspath=/i.test(option)) return true
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
    if (SUB_VALUE_OPTIONS.has(arg) && SUB_FLAGS[sub]?.has(arg) !== true) {
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
