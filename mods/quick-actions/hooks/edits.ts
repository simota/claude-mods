// Whether a Bash command changes files in the working tree, judged from the command's shape
// alone: no git is run (a repository's clean filters would run outside the sandbox).
//
// The reader below is a copy of done-gate's hooks/shell.ts parser, trimmed to what this
// needs; a mod imports nothing from another mod, so a fix there is a fix to make here too.

type Redirect = { op: string; target?: string }
type Simple = { words: string[]; redirects: Redirect[] }

const MAX_DEPTH = 8

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
const REDIRECT = /^(&>>?|[<>]&[0-9]+-?|[<>]&-|>>|>\||<>|>&|<&|[<>])/

function parse(command: string): { commands: Simple[]; nested: string[] } {
  const commands: Simple[] = []
  const nested: string[] = []
  let words: string[] = []
  let redirects: Redirect[] = []
  let word: string | undefined
  let pending: Redirect | undefined
  let heredocs: { tag: string; isTabbed: boolean }[] = []
  let i = 0

  const endWord = () => {
    if (word === undefined) return
    if (pending !== undefined) {
      pending.target = word
      pending = undefined
    } else words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    pending = undefined
    if (words.length > 0 || redirects.length > 0) commands.push({ words, redirects })
    words = []
    redirects = []
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
      const end = closing(command, i + 2)
      nested.push(command.slice(i + 2, end - 1))
      word = (word ?? '') + command.slice(i, end)
      i = end
      continue
    }
    if (ch === '#' && word === undefined) {
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
        i = j + match[0].length
        continue
      }
    }
    if (ch === '<' && command.startsWith('<<<', i)) {
      endWord()
      pending = { op: '<<<' }
      redirects.push(pending)
      i += 3
      continue
    }
    const redirect =
      ch === '<' || ch === '>' || (ch === '&' && command[i + 1] === '>') ? REDIRECT.exec(command.slice(i)) : null
    if (redirect !== null) {
      if (word !== undefined && /^[0-9]+$/.test(word)) word = undefined
      endWord()
      const op = redirect[0]
      const entry: Redirect = { op }
      redirects.push(entry)
      if (!/&([0-9]+-?|-)$/.test(op)) pending = entry
      i += op.length
      continue
    }
    const op = OPERATOR.exec(command.slice(i))
    if (op !== null) {
      endCommand()
      i += op[0].length
      if (op[0] === '\n' && heredocs.length > 0) {
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
    if (ch === '(' || ch === ')' || ((ch === '{' || ch === '}') && word === undefined)) {
      endCommand()
      i += 1
      continue
    }
    word = (word ?? '') + ch
    i += 1
  }
  endCommand()
  return { commands, nested }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIX_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', 'fi', 'done', 'esac'])
const CLAUSE_KEYWORDS = new Set(['for', 'case', 'select', 'function'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
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
}
const TIMEOUT_VALUES = new Set(['-s', '--signal', '-k', '--kill-after'])

const base = (word: string) => word.slice(word.lastIndexOf('/') + 1)

function program(words: readonly string[]): { name: string; args: string[] } | undefined {
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
      k += 1
    } else break
  }
  const name = words[k]
  if (name === undefined) return undefined
  return { name: base(name), args: words.slice(k + 1) }
}

function innerText(words: readonly string[]): string | undefined {
  const run = program(words)
  if (run === undefined) return undefined
  if (run.name === 'eval') return run.args.join(' ')
  if (SHELLS.has(run.name)) {
    for (let k = 0; k < run.args.length; k++) {
      const arg = run.args[k] as string
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return run.args[k + 1]
      if (!arg.startsWith('-')) return undefined
    }
  }
  return undefined
}

function allCommands(command: string, depth = 0): Simple[] {
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

// ---- what counts as an edit -----------------------------------------------------------

const WRITES = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])
// Places a redirection can write without touching the tree.
const SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])
const FILE_PROGRAMS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'touch', 'patch', 'ln', 'truncate'])
const GIT_CHANGES = new Set(['apply', 'am', 'merge', 'rebase', 'cherry-pick', 'revert', 'restore', 'pull'])
const PM_CHANGES = new Set(['add', 'remove', 'rm', 'uninstall', 'install', 'i', 'update', 'up', 'upgrade'])

const isSink = (target: string | undefined) => target === undefined || SINKS.has(target)

function changesFiles(simple: Simple): boolean {
  if (simple.redirects.some(r => WRITES.has(r.op) && !isSink(r.target))) return true
  const run = program(simple.words)
  if (run === undefined) return false
  const { name, args } = run
  const plain = args.filter(arg => !arg.startsWith('-'))
  // patch reads its diff from stdin and writes the files it names.
  if (name === 'patch') return true
  if (FILE_PROGRAMS.has(name)) return plain.length > 0
  switch (name) {
    case 'sed':
      return args.some(arg => arg === '--in-place' || arg.startsWith('--in-place=') || /^-[A-Za-z]*i/.test(arg))
    case 'perl':
      return args.some(arg => /^-[A-Za-z]*i/.test(arg))
    case 'tee':
      return plain.some(target => !SINKS.has(target))
    case 'git': {
      let k = 0
      while (k < args.length && (args[k] as string).startsWith('-')) k += args[k] === '-c' || args[k] === '-C' ? 2 : 1
      const sub = args[k]
      if (sub === undefined) return false
      if (GIT_CHANGES.has(sub)) return true
      if (sub === 'checkout') return args.includes('--')
      if (sub === 'stash') return plain[1] === 'pop' || plain[1] === 'apply'
      if (sub === 'reset') return args.includes('--hard')
      return false
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const sub = plain[0]
      // A bare `yarn` installs; any of these rewrites the lockfile or node_modules.
      return sub === undefined ? name === 'yarn' && args.length === 0 : PM_CHANGES.has(sub)
    }
    default:
      return false
  }
}

/** Whether a Bash command, by its shape, writes to files: what a turn of edits is made of. */
export function editsFiles(command: string): boolean {
  return allCommands(command).some(changesFiles)
}
