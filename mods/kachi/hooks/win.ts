// What counts as an earned green, and how one is drawn. Pure functions: register.tsx feeds
// them a Bash result and the session's records, and writes back what they return.

import type { Band, CheckRecord, Edits, Locale, Tier } from '../types'

import type { Simple } from './shell'
import { innerText, isVerification, parse, program } from './shell'

/** The most of a command's output any parser here reads: its last 4 KiB. */
export const TAIL = 4096
export const MAX_CHECKS = 32
export const MAX_WINS = 64
const MAX_SCOPE_WORDS = 16
const MAX_SCOPE_WORD = 200
const MAX_DEPTH = 8

// ---- output -----------------------------------------------------------------------------

// CSI and OSC sequences, and the two-byte escapes; each alternative is linear.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g

/** The last 4 KiB of the parts, joined, with colour codes taken out: all the parsers ever see. */
export function outputTail(...parts: string[]): string {
  const joined = parts
    .map(part => part.slice(-TAIL))
    .filter(part => part.length > 0)
    .join('\n')
  return joined.slice(-TAIL).replace(ANSI, '')
}

const FAIL_COUNT = /(\d{1,7}) (?:failed|failing|fail|failures?|errors?|problems?)\b|failures=(\d{1,7})|\bdue to (\d{1,7}) previous errors?\b/g
const PASS_COUNT = /(\d{1,7}) (?:passed|passing|pass)\b|\bRan (\d{1,7}) tests?\b|\brunning (\d{1,7}) tests?\b/g
const NO_TESTS = /\bno tests? (?:ran|found|to run|were found)\b|No test files found|collected 0 items|--passWithNoTests/i

function largest(pattern: RegExp, text: string): number | undefined {
  // Each pattern's count is in whichever of its groups matched.
  let most: number | undefined
  for (const match of text.slice(-TAIL).matchAll(pattern)) {
    const value = Number(match[1] ?? match[2] ?? match[3])
    if (most === undefined || value > most) most = value
  }
  return most
}

/** The failure count a test, lint or type-check run printed (`3 failed`, `Found 2 errors`), read from its last 4 KiB. */
export const parseFailCount = (text: string): number | undefined => largest(FAIL_COUNT, text)

// `go test` prints no count: a package that passed is its `ok` line.
const GO_OK = /^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/gm

/** The pass count a test run printed (`44 passed`, `42 pass`, `Ran 3 tests`, go's `ok` lines), read from its last 4 KiB. */
export function parsePassCount(text: string): number | undefined {
  const counted = largest(PASS_COUNT, text)
  if (counted !== undefined) return counted
  const packages = text.slice(-TAIL).match(GO_OK)?.length ?? 0
  return packages === 0 ? undefined : packages
}

// A runner's or a compiler's own line for a failure: jest's and vitest's `FAIL x.test.ts`, pytest's
// `FAILED t.py::x`, go's `--- FAIL:` and `FAIL\tpkg`, TAP's `not ok`, rustc's and swiftc's `error:` /
// `error[E0308]:` / `x.swift:3:5: error:`, cargo's `could not compile`, make's `*** [x] Error 2`.
// Only at a line's start, so a test named "handles FAILED payment" or a log line saying FAIL is none.
const FAIL_MARK = /^\s*FAIL\s+\S|^FAILED\s+\S|^--- FAIL:|^FAIL\t|^not ok\b|^error(?:\[E\d+\])?:|^\S+:\d+:\d+: error:|^error: could not compile|^make(?:\[\d+\])?: \*\*\* .*Error \d+/m

// A check that prints nothing on success, or one closing line: what an empty or quiet pipe of it means.
const SILENT_PASS: Record<string, RegExp> = {
  tsc: /^$/,
  'vue-tsc': /^$/,
  eslint: /^$/,
  'cargo build': /^\s*Finished `/m,
  'cargo check': /^\s*Finished `/m,
  'cargo clippy': /^\s*Finished `/m,
  'swift build': /^Build complete!/m,
}

/** Whether a passing run ran nothing: a count of 0 passed and none above it, or a runner saying no tests ran. */
export function isZeroRun(tail: string, command: string): boolean {
  const passed = largest(PASS_COUNT, tail)
  if (passed !== undefined) return passed === 0
  return NO_TESTS.test(tail) || /--passWithNoTests\b/.test(command)
}

// What a package manager prints before running a script: `> app@1.0.0 typecheck /repo`, then `> tsc --noEmit`.
const SCRIPT_HEADER = /^> \S+@\S* \S+/
// Programs whose success prints nothing at all.
const QUIET_PROGRAMS = new Set(['tsc', 'vue-tsc', 'eslint'])

/** Whether an output is only a script's header, for a script that runs nothing but quiet programs. */
function isQuietScript(tail: string): boolean {
  const lines = tail
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  if (lines.length === 0 || lines.length > 8 || !lines.every(line => line.startsWith('> '))) return false
  const run = lines.filter(line => !SCRIPT_HEADER.test(line)).map(line => line.slice(2))
  return (
    run.length > 0 &&
    run.every(text =>
      parse(text).commands.every(one => {
        const name = program(one.words)?.name
        return name !== undefined && QUIET_PROGRAMS.has(name)
      }),
    )
  )
}

// The shell's or a runner's own words for a check that never ran: a missing program or script
// (`sh: vitest: command not found`, `bash: ./run: No such file or directory`), a missing script or
// target, a denial. Read only when the output holds no failure count and no FAIL line, so a test
// failing on ENOENT or asserting "permission denied" is still a failure.
const NOT_RUN = /^(?:[^\s:]+: )+(?:command not found|No such file or directory|[Pp]ermission denied|Operation not permitted)(?:: \S+)?\s*$|Missing script|ERR_PNPM_NO_SCRIPT|No rule to make target/m

/** The exit status a failed Bash call reports in its first line, when it reports one. */
export const exitCodeOf = (text: string): number | undefined => {
  const match = /^Exit code (\d{1,3})\b/.exec(text.slice(0, 32))
  return match === null ? undefined : Number(match[1])
}

// ---- which check ------------------------------------------------------------------------

/** A check by its program and check word (`pnpm test`, `cargo clippy`, `tsc`), and the words that narrow what it runs. */
export type Check = {
  /** What its record is kept under: the check and the directory it ran in, so web's and api's never meet. */
  key: string
  /** The check by its program and check word: `pnpm test`, `cargo clippy`. */
  name: string
  /** The directory it ran in, absolute. */
  dir: string
  /** That directory relative to the session's, or '' when it is the session's. */
  where: string
  scope: string[]
  isOverflow: boolean
}

/** A check as a line names it: `pnpm test`, or `pnpm test (web)` away from the session's directory. */
export const labelOf = (check: { name: string; where: string }) => (check.where === '' ? check.name : `${check.name} (${check.where})`)

const SUBCOMMANDED = new Set(['cargo', 'go', 'swift', 'deno', 'dotnet', 'prettier', 'biome'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PM_VALUES = new Set(['-C', '--dir', '--filter', '-F', '--prefix', '-w', '--workspace', '--cwd'])
const TARGETED = new Set(['make', 'just', 'task', 'gradle', 'gradlew', 'mvn', 'mvnw'])
const TARGET = /^(?::?[\w-]+:)*(?:test\w*|tests|check|lint\w*|build|verify|typecheck|type-check|assemble\w*)(?:[:-].*)?$/
// Words that change how a run looks, never which tests it runs.
const HARMLESS = /^(?:--|--run|--ci|--colou?rs?|--no-colou?r|--color=\w+|-v+|--verbose|-q|--quiet|--silent|-s|--release|--offline|--locked|--frozen|--noEmit|--pretty|--incremental|--coverage|--no-coverage|--bail|-x|--exitfirst|--fail-fast|--no-fail-fast)$/

const quote = (words: readonly string[]) => words.map(word => `'${word.replace(/'/g, `'\\''`)}'`).join(' ')

// shell.ts's checks that are programs of their own: also what `pnpm vitest`, `pnpm exec jest` or `yarn tsc` run.
const DIRECT_CHECKS = new Set([
  'tsc', 'vue-tsc', 'mypy', 'pyright', 'eslint', 'ruff', 'vitest', 'jest', 'pytest', 'xcodebuild', 'swiftlint', 'ktlint',
  'detekt', 'golangci-lint', 'rubocop', 'phpunit', 'phpstan', 'tox', 'nox', 'cargo-nextest', 'flake8', 'pylint', 'black',
  'shellcheck', 'stylelint', 'playwright', 'rspec', 'ctest',
])
// Every program shell.ts reads as a check; any other simple command is one only through the text it runs.
const CHECK_PROGRAMS = new Set([
  ...DIRECT_CHECKS, 'prettier', 'biome', 'cargo', 'go', 'swift', 'deno', 'dotnet', 'mvn', 'mvnw', 'node', 'python', 'python3',
  'npm', 'bun', 'pnpm', 'yarn', 'make', 'just', 'task', 'gradlew', 'gradle',
])
// The package-manager words that run the program named after them.
const RUNS_PROGRAM = new Set(['exec', 'dlx', 'x'])
// A check's words read at most: past them a pass is narrower by rule, so a 50,000-file argument list costs nothing.
const MAX_WORDS = MAX_SCOPE_WORDS + 8

/**
 * The words of the check a package manager runs as a program (`pnpm exec vitest`, `pnpm vitest run a.test.ts`),
 * and the manager's own words before it, which narrow it (`-C web`); other words as they are.
 */
function unwrapped(words: readonly string[]): { words: readonly string[]; scope: string[] } {
  const run = program(words)
  if (run === undefined || !PACKAGE_MANAGERS.has(run.name)) return { words, scope: [] }
  for (let k = 0; k < run.args.length; k++) {
    const arg = run.args[k] as string
    if (PM_VALUES.has(arg)) k += 1
    else if (RUNS_PROGRAM.has(arg)) return { words: run.args.slice(k + 1), scope: run.args.slice(0, k) }
    else if (DIRECT_CHECKS.has(arg)) return { words: run.args.slice(k), scope: run.args.slice(0, k) }
    else if (!arg.startsWith('-')) break
  }
  return { words, scope: [] }
}

const isPluginTest = (run: { name: string; args: string[] }) =>
  run.name === 'claude' && run.args[0] === 'plugin' && run.args[1] === 'test' && !run.args.some(arg => arg === '--help' || arg === '-h')

/** The words of a check, when these words are one: shell.ts's verdict, plus `claude plugin test` and package-manager runs. */
function asCheck(words: readonly string[]): { words: readonly string[]; scope: string[] } | undefined {
  const inner = unwrapped(words.length > MAX_WORDS ? words.slice(0, MAX_WORDS) : words)
  const run = program(inner.words)
  if (run === undefined) return undefined
  if (run.name === 'claude') return isPluginTest(run) ? inner : undefined
  if (!CHECK_PROGRAMS.has(run.name) && innerText(inner.words) === undefined) return undefined
  return isVerification(quote(inner.words)) ? inner : undefined
}

/** A check a command runs, whether the command's exit status is the check's, and which top-level command runs it. */
export type Reading = { check: Check; isStatus: boolean; index: number }

// Between the check and the end, only these keep the check's failure the command's failure.
const CARRIES_FAILURE = new Set<string>(['&&', '|', '|&'])
const ENDS = new Set<string>(['', ';', '\n'])
// Commands read in one command line at most: past them, the line is no reading.
const MAX_COMMANDS = 256

/** `dir` joined with `to` and normalized; `to` is a literal path (no `~`, `$`, `-`). */
export function resolvePath(dir: string, to: string): string {
  const parts: string[] = []
  for (const part of (to.startsWith('/') ? to : `${dir}/${to}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Where a `cd` or `pushd` leaves the shell; null when it cannot be told from the text. */
function cdTarget(words: readonly string[], dir: string): string | null | undefined {
  const run = program(words)
  if (run === undefined || (run.name !== 'cd' && run.name !== 'pushd')) return undefined
  const to = run.args.find(arg => !arg.startsWith('-') || arg === '-')
  if (to === undefined || to === '-' || to.startsWith('~') || to.includes('$') || to.includes('`')) return null
  return resolvePath(dir, to)
}

// shell.ts reads these, which run another command, for their exit status only with `+` or `-e`.
function passesStatus(words: readonly string[]): boolean {
  const run = program(words)
  if (run === undefined) return true
  if (run.name === 'find') return run.args.includes('+')
  if (run.name === 'script') return run.args.some(arg => arg === '--return' || /^-[A-Za-z]*e[A-Za-z]*$/.test(arg))
  return true
}

type Place = { dir: string; root: string }

/** One simple command as the reader met it: the top-level command it belongs to, and the directory it ran in. */
export type Met = { index: number; dir: string; simple: Simple }

/** What reading a command line found: the check, every simple command met, and whether the budget ran out. */
export type Scan = { reading: Reading | undefined; met: readonly Met[]; isOver: boolean }

// `;`, `&`, `|` and `>` separate commands and open redirections; spaces separate words. Newlines are
// left out, so a heredoc holding a long file is still read (shell.ts sets its body aside unparsed).
const MAX_OPERATORS = 8 * MAX_COMMANDS
const MAX_SPACES = 8192

/** Whether a command line holds more operators or words than a line kachi reads ever needs. */
function isTooLong(text: string): boolean {
  let operators = 0
  let spaces = 0
  for (let k = 0; k < text.length; k++) {
    const code = text.charCodeAt(k)
    if (code === 32) spaces += 1
    else if (code === 59 || code === 38 || code === 124 || code === 62) operators += 1
  }
  return operators > MAX_OPERATORS || spaces > MAX_SPACES
}

// One budget of commands for a whole line, nested text included: past it the line is no reading.
type Walker = { left: number; isOver: boolean; met: Met[]; root: string }

/** The reading of one simple command: through the text it runs, or as a check of its own. */
function checkIn(words: readonly string[], depth: number, dir: string, index: number, walker: Walker): Reading | undefined {
  const inner = innerText(words)
  if (inner !== undefined) {
    if (depth >= MAX_DEPTH) return undefined
    const found = walk(parse(inner).commands, depth + 1, dir, index, walker)
    return found !== undefined && !passesStatus(words) ? { ...found, isStatus: false } : found
  }
  const run = program(words)
  if (run === undefined || (!CHECK_PROGRAMS.has(run.name) && run.name !== 'claude')) return undefined
  const found = asCheck(words)
  const check = found === undefined ? undefined : named(found.words, found.scope, words.length > MAX_WORDS, { dir, root: walker.root })
  return check === undefined ? undefined : { check, isStatus: true, index }
}

/** Reads commands once each, in order, with the directory the `cd`s before each left; `index` is the top-level command's, or -1 at the top. */
function walk(commands: readonly Simple[], depth: number, start: string, index: number, walker: Walker): Reading | undefined {
  walker.left -= commands.length
  if (walker.left < 0) walker.isOver = true
  if (walker.isOver) return undefined
  const readings: (Reading | undefined)[] = []
  let dir: string | null = start
  for (const [k, one] of commands.entries()) {
    const moved: string | null | undefined = dir === null ? undefined : cdTarget(one.words, dir)
    if (moved !== undefined) dir = moved
    if (dir === null || moved !== undefined || one.words.length === 0) {
      readings.push(undefined)
      continue
    }
    const at = index === -1 ? k : index
    walker.met.push({ index: at, dir, simple: one })
    readings.push(checkIn(one.words, depth, dir, at, walker))
    if (walker.isOver) return undefined
  }
  const last = commands.length - 1
  for (let k = last; k >= 0; k--) {
    if (k < last - 1 && !CARRIES_FAILURE.has((commands[k + 1] as Simple).after)) break
    const after = (commands[k] as Simple).after
    const found = readings[k]
    if (found !== undefined && (k === last ? ENDS.has(after) : after === '&&')) return found
  }
  let only: Reading | undefined
  for (const found of readings) {
    if (found === undefined) continue
    if (only !== undefined) return undefined
    only = { ...found, isStatus: false }
  }
  return only
}

/**
 * Reads a command line once: the check it runs, its record keyed by the directory it runs in
 * (`cwd`, moved by the command's own `cd`s; one that cannot be told from the text is no reading).
 * Its exit status is the command's (shell.ts's isVerification) when it is the last command or only
 * `&&` chains follow it. Otherwise (`pnpm test 2>&1 | tail -20`, `pytest || true`, `make check;
 * echo done`) the one check in the command is read for its output; two checks printing into one
 * output are none. 256 commands are read at most, nested text included; a longer line is none.
 */
export function scanCommand(command: string, cwd: string): Scan {
  // Parsing is what costs: a line with more operators or words than it could read is over unparsed.
  if (isTooLong(command)) return { reading: undefined, met: [], isOver: true }
  const walker: Walker = { left: MAX_COMMANDS, isOver: false, met: [], root: cwd }
  const reading = walk(parse(command).commands, 0, cwd, -1, walker)
  return walker.isOver ? { reading: undefined, met: [], isOver: true } : { reading, met: walker.met, isOver: false }
}

export const readCheck = (command: string, cwd = '/'): Reading | undefined => scanCommand(command, cwd).reading

function named(words: readonly string[], before: readonly string[], isCut: boolean, place: Place): Check | undefined {
  const run = program(words)
  if (run === undefined) return undefined
  const { name, args } = run
  let key = name
  let rest = args
  if (name === 'claude') {
    key = 'claude plugin test'
    rest = args.slice(2)
  } else if (PACKAGE_MANAGERS.has(name)) {
    // `pnpm -C web run test:unit -- a.test.ts`: the script is the key, everything else scope.
    let at = -1
    for (let k = 0; k < args.length; k++) {
      const arg = args[k] as string
      if (PM_VALUES.has(arg) || (name === 'yarn' && arg === 'workspace')) k += 1
      else if (!arg.startsWith('-') && arg !== 'run' && arg !== 'run-script') {
        at = k
        break
      }
    }
    if (at === -1) return undefined
    key = `${name} ${args[at]}`
    rest = [...args.slice(0, at).filter(arg => arg !== 'run' && arg !== 'run-script'), ...args.slice(at + 1)]
  } else if (SUBCOMMANDED.has(name)) {
    const at = args.findIndex(arg => !arg.startsWith('-') && !arg.startsWith('+'))
    if (at !== -1) {
      key = `${name} ${args[at]}`
      rest = [...args.slice(0, at), ...args.slice(at + 1)]
    }
  } else if (TARGETED.has(name)) {
    const at = args.findIndex(arg => !arg.startsWith('-') && TARGET.test(arg))
    if (at !== -1) {
      key = `${name} ${args[at]}`
      rest = [...args.slice(0, at), ...args.slice(at + 1)]
    }
  } else if ((name === 'python' || name === 'python3') && args[0] === '-m' && args[1] !== undefined) {
    key = args[1]
    rest = args.slice(2)
  } else if (name === 'node') {
    key = 'node --test'
    rest = args.filter(arg => arg !== '--test')
  } else if (name === 'vitest' && args[0] === 'run') {
    rest = args.slice(1)
  }
  const scope = [...before, ...rest].filter(word => !HARMLESS.test(word))
  const where = place.dir === place.root ? '' : place.dir.startsWith(`${place.root}/`) ? place.dir.slice(place.root.length + 1) : place.dir
  return {
    key: `${key} @ ${place.dir}`,
    name: key,
    dir: place.dir,
    where,
    scope: scope.slice(0, MAX_SCOPE_WORDS).filter(word => word.length <= MAX_SCOPE_WORD),
    isOverflow: isCut || scope.length > MAX_SCOPE_WORDS || scope.some(word => word.length > MAX_SCOPE_WORD),
  }
}

/** Whether a pass runs at least what every failure since red began ran: no scope word it adds. */
export const covers = (pass: Check, failedScope: readonly string[]) =>
  !pass.isOverflow && pass.scope.every(word => failedScope.includes(word))

// ---- commits ----------------------------------------------------------------------------

const GIT_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** Whether a command makes a new commit: one of its simple commands is `git commit` with no --amend or --dry-run. */
export function commitsWith(command: string): boolean {
  return parse(command).commands.some(simple => {
    const run = program(simple.words)
    if (run === undefined || run.name !== 'git') return false
    let k = 0
    while (k < run.args.length && (run.args[k] as string).startsWith('-')) k += GIT_VALUES.has(run.args[k] as string) ? 2 : 1
    if (run.args[k] !== 'commit') return false
    return !run.args.slice(k + 1).some(arg => arg === '--amend' || arg === '--dry-run')
  })
}

/** The short sha `git commit` printed (`[main 4e1a9c2] msg`). */
export const shaOf = (stdout: string): string => /^\[[^\]\n]{0,200}?\s([0-9a-f]{7,40})\]/m.exec(stdout.slice(0, TAIL))?.[1]?.slice(0, 7) ?? ''

// ---- classifying one Bash result ---------------------------------------------------------

export type BashOutcome = {
  command: string
  /** The directory the call ran in: a check's record is kept per directory. */
  cwd: string
  isError: boolean
  /** What the model read: the error text, headed `Exit code N`, when the call failed. */
  text: string
  stdout: string
  stderr: string
  /** The whole output where the host kept more than `text` or `stdout` carry (a long failure, a persisted output). */
  full?: string | undefined
  isInterrupted: boolean
  isBackground: boolean
  commit?: { sha: string; kind: string } | undefined
}

export type Classified =
  | { kind: 'ignore' }
  | { kind: 'fail'; check: Check; failCount: number | undefined; index: number }
  | { kind: 'pass'; check: Check; isZeroRun: boolean; index: number }
  /** A piped check whose output says neither red nor green. */
  | { kind: 'unread'; check: Check; index: number }
  | { kind: 'commit'; sha: string }

const IGNORE: Classified = { kind: 'ignore' }

/** What one Bash result means to kachi: a check failing, passing or unreadable, a new commit, or nothing. */
export function classify(outcome: BashOutcome, scanned: Scan = scanCommand(outcome.command, outcome.cwd)): Classified {
  if (outcome.isInterrupted || outcome.isBackground) return IGNORE
  const { reading } = scanned
  if (reading === undefined) {
    if (outcome.isError) return IGNORE
    if (outcome.commit !== undefined) return outcome.commit.kind === 'committed' ? { kind: 'commit', sha: outcome.commit.sha.slice(0, 7) } : IGNORE
    if (outcome.command.includes('commit') && commitsWith(outcome.command)) return { kind: 'commit', sha: shaOf(outcome.stdout) }
    return IGNORE
  }
  const { check, index } = reading
  // No status line on a failed call means interrupted, denied or timed out: nothing ran to the end.
  const code = outcome.isError ? exitCodeOf(outcome.text) : 0
  if (code === undefined || code === 126 || code === 127) return IGNORE
  const tail = outcome.full !== undefined ? outputTail(outcome.full) : outcome.isError ? outputTail(outcome.text) : outputTail(outcome.stdout, outcome.stderr)
  const failCount = parseFailCount(tail)
  const isMarked = (failCount ?? 0) > 0 || FAIL_MARK.test(tail)
  if (reading.isStatus) {
    if (!outcome.isError) return { kind: 'pass', check, isZeroRun: isZeroRun(tail, outcome.command), index }
    return !isMarked && NOT_RUN.test(tail.slice(-1024)) ? IGNORE : { kind: 'fail', check, failCount, index }
  }
  // The status is another command's (`| tail`, `|| true`, `; echo`): the check's own output decides.
  // A count beats a FAIL line: a printed pass count with no failure count is green.
  if ((failCount ?? 0) > 0) return { kind: 'fail', check, failCount, index }
  const printed = largest(PASS_COUNT, tail)
  if (printed !== undefined) return { kind: 'pass', check, isZeroRun: printed === 0 || isZeroRun(tail, outcome.command), index }
  if (isMarked) return { kind: 'fail', check, failCount, index }
  if (NOT_RUN.test(tail.slice(-1024))) return IGNORE
  const quiet = SILENT_PASS[check.name]
  const isScript = PACKAGE_MANAGERS.has(check.name.split(' ')[0] as string) && isQuietScript(tail)
  if (parsePassCount(tail) !== undefined || (quiet !== undefined && quiet.test(tail.trim())) || isScript) return { kind: 'pass', check, isZeroRun: false, index }
  return { kind: 'unread', check, index }
}

// ---- edits made through Bash -----------------------------------------------------------

// A redirection that writes its target: `>`, `>>`, `>|`, `&>`, `2>` and the like (`>&2` duplicates).
const WRITES = /^(?:\d?>>?\|?|&>>?)$/
// Where a write is never a code edit: devices, temporary folders, variables, logs.
const NOT_CODE = /^(?:\/dev\/|\/tmp\/|\/private\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/)|\$|\.(?:log|out|tmp)$/
// Formatters and fixers, with the option that makes each write in place where it needs one.
const FIXERS: Record<string, string | null> = {
  prettier: '--write', eslint: '--fix', black: null, isort: null, rustfmt: null, swiftformat: null, gofmt: '-w', goimports: '-w', 'clang-format': '-i', 'swift-format': '-i',
}
const MAX_PATHS = 64
// A writer's words and redirects read at most: what lies past them is not counted as written.
const MAX_WRITER_WORDS = 32
// A word any writer above needs; a command with none of them writes nothing kachi can read.
const MAY_WRITE = />|\b(?:sed|gsed|perl|tee|cp|mv|install|git|prettier|eslint|black|isort|rustfmt|swiftformat|gofmt|goimports|clang-format|swift-format|ruff|go)\b/

const plain = (args: readonly string[]) => args.filter(arg => !arg.startsWith('-'))

/** The files one simple command writes, as far as its text says: in-place editors, tee, copies, restores, fixers; redirects when `withRedirects`. */
function written(words: readonly string[], redirects: readonly { op: string; target?: string | undefined }[], withRedirects: boolean): string[] {
  const out = withRedirects
    ? redirects
        .slice(0, MAX_WRITER_WORDS)
        .filter(one => WRITES.test(one.op) && one.target !== undefined && one.target !== '' && !one.target.startsWith('&'))
        .map(one => one.target as string)
    : []
  const run = program(words.length > MAX_WRITER_WORDS ? words.slice(0, MAX_WRITER_WORDS) : words)
  if (run === undefined) return out
  const { name, args } = run
  if (name === 'sed' || name === 'gsed' || name === 'perl') {
    const inPlace = args.findIndex(arg => /^(?:-[A-Za-z]*i|--in-place)/.test(arg))
    if (inPlace === -1) return out
    // The script is the first plain word unless -e or -f gave it; an empty word after -i is macOS's suffix.
    const files: string[] = []
    let hasScript = args.some(arg => arg === '-e' || arg === '-f' || arg === '--expression' || arg === '--file')
    for (let k = 0; k < args.length; k++) {
      const arg = args[k] as string
      if (arg === '-e' || arg === '-f' || arg === '--expression' || arg === '--file' || (k === inPlace + 1 && arg === '')) {
        if (arg !== '') k += 1
      } else if (!arg.startsWith('-')) {
        if (hasScript) files.push(arg)
        else hasScript = true
      }
    }
    return [...out, ...files]
  }
  if (name === 'tee') return [...out, ...plain(args)]
  if (name === 'cp' || name === 'mv' || name === 'install') {
    const paths = plain(args)
    return paths.length >= 2 ? [...out, paths.at(-1) as string] : out
  }
  if (name === 'git') {
    const at = args.findIndex(arg => arg === 'checkout' || arg === 'restore')
    if (at === -1 || args.slice(0, at).some(arg => !arg.startsWith('-'))) return out
    const rest = args.slice(at + 1)
    if (args[at] === 'checkout') {
      const dash = rest.indexOf('--')
      return dash === -1 ? out : [...out, ...rest.slice(dash + 1)]
    }
    if (rest.includes('--staged') && !rest.includes('--worktree')) return out
    return [...out, ...plain(rest.filter((arg, k) => rest[k - 1] !== '--source' && rest[k - 1] !== '-s'))]
  }
  if (name in FIXERS) {
    const flag = FIXERS[name]
    if (flag !== null && flag !== undefined && !args.includes(flag)) return out
    return [...out, ...plain(args)]
  }
  if (name === 'ruff' && (args[0] === 'format' || (args[0] === 'check' && args.includes('--fix')))) return [...out, ...plain(args.slice(1))]
  if (name === 'go' && args[0] === 'fmt') return [...out, ...plain(args.slice(1))]
  return out
}

/**
 * The files a Bash command writes, as far as its text says, resolved against the directory each
 * command ran in: `before` the check at top-level command `checkIndex` (the check's own fixer writes
 * included, its output redirects not), and `after` it. Reuses what the scan met; unknown writes (a
 * script, `patch`, `git stash`) are none, and 64 paths are kept at most.
 */
export function editsOf(command: string, scanned: Scan, checkIndex: number): { before: string[]; after: string[] } {
  const before: string[] = []
  const after: string[] = []
  // Most commands name no writer at all: those are not looked at again.
  if (!MAY_WRITE.test(command)) return { before, after }
  for (const { index, dir, simple } of scanned.met) {
    for (const path of written(simple.words, simple.redirects, index !== checkIndex)) {
      if (path === '' || NOT_CODE.test(path)) continue
      ;(checkIndex !== -1 && index <= checkIndex ? before : after).push(resolvePath(dir, path))
      if (before.length + after.length >= MAX_PATHS) return { before, after }
    }
  }
  return { before, after }
}

/**
 * `read()`, with a command shell.ts cannot read taken as `none`: shell.ts (done-gate's, copied byte
 * for byte) recurses once per nested `"$(`, and past the stack it throws RangeError.
 */
export function orNone<T>(read: () => T, none: T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof RangeError) return none
    throw error
  }
}

/** classify, a command shell.ts cannot read being nothing. */
export const classifyOrIgnore = (outcome: BashOutcome, scanned?: Scan): Classified => orNone(() => classify(outcome, scanned), IGNORE)

// ---- the records ------------------------------------------------------------------------

export type Win = { tier: Tier; kind: 'green' | 'first'; key: string; label: string; where: string; receipt?: string }

/** The language of kachi's few words: Japanese for a ja locale or language setting, English otherwise. */
export function localeOf(values: readonly (string | undefined)[]): Locale {
  const first = values.find(value => value !== undefined && value.trim() !== '' && value !== 'C' && value !== 'POSIX')
  return first !== undefined && /^(?:ja(?:$|[_.@-])|japanese|日本語)/i.test(first.trim()) ? 'ja' : 'en'
}

const WORDS = {
  ja: {
    green: '緑', first: '編集後はじめて', kept: '検証済みのまま', redGreen: '赤→緑', tries: (n: number) => `${n} 回目で`, red: (d: string) => `${d} 赤だった`,
    alive: (check: string) => `kachi: ${check} が赤。本当の修正で鳴ります`,
  },
  en: {
    green: 'green', first: 'first after edits', kept: 'still verified', redGreen: 'red→green', tries: (n: number) => `try ${n}`, red: (d: string) => `red for ${d}`,
    alive: (check: string) => `kachi: ${check} is red; a real fix rings`,
  },
} as const

/** The one dim line under a check's first red of the session: kachi is there, and what will make it speak. */
export const aliveText = (check: Check, locale: Locale) => `◌ ${WORDS[locale].alive(labelOf(check))}`

const MINUTE = 60_000

/** The tier a recovery earns: it grows with failed runs, minutes spent red and how many tests were failing. */
export function tierOf(record: Extract<CheckRecord, { isRed: true }>, now: number): Tier {
  const red = now - record.firstFailAt
  if (record.failRuns >= 8 || red >= 20 * MINUTE || (record.peakFailCount ?? 0) >= 10) return 4
  if (record.failRuns >= 3 || red >= 5 * MINUTE) return 3
  return 2
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** The line kept under the winning row: what the fight cost, which the row itself does not show. */
export function receiptText(record: Extract<CheckRecord, { isRed: true }>, now: number, locale: Locale): string {
  const words = WORDS[locale]
  const count = record.peakFailCount === undefined ? '' : ` · ${record.peakFailCount} → 0 failing`
  return `✔ ${words.redGreen}  ${words.tries(record.failRuns + 1)} · ${words.red(duration(now - record.firstFailAt))}${count}`
}

function capped<T extends { at: number }>(all: Record<string, T>): Record<string, T> {
  const keys = Object.keys(all)
  if (keys.length <= MAX_CHECKS) return all
  const oldest = keys.reduce((a, b) => ((all[a] as T).at <= (all[b] as T).at ? a : b))
  const { [oldest]: _, ...rest } = all
  return rest
}

const contains = (dir: string, path: string) => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`)

/**
 * The records after a code edit to `path` (absolute): each red check whose directory holds the
 * path is credited with it; a path outside every check's directory is credited to all of them.
 */
export function credit(checks: Readonly<Record<string, CheckRecord>>, path: string): Readonly<Record<string, CheckRecord>> {
  const records = Object.values(checks)
  const isOutside = records.every(record => !contains(record.dir, path))
  let next: Record<string, CheckRecord> | undefined
  for (const [key, record] of Object.entries(checks)) {
    if (!record.isRed || record.isCredited || !(isOutside || contains(record.dir, path))) continue
    next ??= { ...checks }
    next[key] = { ...record, isCredited: true }
  }
  return next ?? checks
}

/**
 * The next records after a check failed or passed, and the win it earned, if any.
 * A win is a pass of a check that was red, credited with a code edit since its last failure, a scope
 * at least as broad as every failure's, and tests that ran; or the first whole-check pass of a
 * check never seen before, once the session has edited code (a tick).
 */
export function step(
  checks: Readonly<Record<string, CheckRecord>>,
  classified: Extract<Classified, { kind: 'fail' | 'pass' | 'unread' }>,
  edits: Edits,
  now: number,
  locale: Locale,
): { checks: Record<string, CheckRecord>; win?: Win; isGreen: boolean; isFirstRed?: boolean } {
  const { check } = classified
  const prev = checks[check.key]
  if (classified.kind === 'fail') {
    const count = classified.failCount
    const next: CheckRecord =
      prev?.isRed === true
        ? {
            ...prev,
            at: now,
            failRuns: prev.failRuns + 1,
            scope: prev.scope.filter(word => check.scope.includes(word)),
            isCredited: false,
            ...(count === undefined ? {} : { peakFailCount: Math.max(prev.peakFailCount ?? 0, count) }),
          }
        : {
            isRed: true,
            at: now,
            dir: check.dir,
            firstFailAt: now,
            failRuns: 1,
            scope: check.scope,
            isCredited: false,
            ...(count === undefined ? {} : { firstFailCount: count, peakFailCount: count }),
          }
    return { checks: capped({ ...checks, [check.key]: next }), isGreen: false, isFirstRed: prev?.isRed !== true }
  }

  const green: CheckRecord = { isRed: false, at: now, dir: check.dir }
  // A piped run that says nothing ends what the record knew: a stale red would ring with a false duration later.
  if (classified.kind === 'unread') return { checks: prev?.isRed === true ? { ...checks, [check.key]: green } : { ...checks }, isGreen: false }
  if (prev === undefined) {
    if (classified.isZeroRun) return { checks: { ...checks }, isGreen: false }
    // Only the whole check counts: a first run narrowed to one file or one test name is no tick.
    const isFirst = edits.codeSeq > 0 && check.scope.length === 0 && !check.isOverflow
    return {
      checks: capped({ ...checks, [check.key]: green }),
      isGreen: true,
      ...(isFirst ? { win: { tier: 1 as const, kind: 'first' as const, key: check.key, label: check.name, where: check.where } } : {}),
    }
  }
  if (!prev.isRed) return { checks: { ...checks, [check.key]: green }, isGreen: true }
  // Still red until the failed scope, or a broader one, passes with tests that ran.
  if (classified.isZeroRun || !covers(check, prev.scope)) return { checks: { ...checks }, isGreen: false }
  const after = { ...checks, [check.key]: green }
  // A flaky re-run, or a pass that only test edits (or edits elsewhere) brought: green, and nothing to celebrate.
  if (!prev.isCredited) return { checks: after, isGreen: true }
  return { checks: after, isGreen: true, win: { tier: tierOf(prev, now), kind: 'green', key: check.key, label: check.name, where: check.where, receipt: receiptText(prev, now, locale) } }
}

/** The receipts with one added, the oldest leaving past 64. */
export function withReceipt(wins: Readonly<Record<string, string>>, id: string, line: string): Record<string, string> {
  const next = { ...wins, [id]: line }
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_WINS))) delete next[key]
  return next
}

// ---- test files -------------------------------------------------------------------------

// Test folders (`tests/`, `__tests__/`, Swift's and Xcode's `Tests/` and `AppTests/`), test files by
// suffix (`.test.ts`, `_test.go`, `_spec.rb`, `test_x.py`) and by class name (`PriceTests.swift`,
// `PriceSpec.kt`, `PriceTest.java`).
const TEST_PATH = /(?:^|\/)(?:[Tt]ests?|__tests__|[Ss]pecs?|__snapshots__|[\w.-]*(?:Tests|Specs))\/|\.(?:test|spec)\.[^/]*$|_(?:test|spec)\.(?:go|py|rs|rb|exs?|dart)$|(?:^|\/)test_[^/]*\.py$|[A-Za-z0-9](?:Tests?|Specs?)\.(?:swift|kt|kts|java|scala|cs|m|mm)$/

// A glob, read once: a literal character, `?`, `*` (within a segment), `**` (anything), `**/` (any directories).
type GlobToken = string | 'one' | 'star' | 'any' | 'dirs'
export type Globs = readonly (readonly GlobToken[])[]
const PATH_TAIL = 256

function tokenize(glob: string): GlobToken[] {
  // Every glob may start at any directory, as `(^|/)glob$` would.
  const out: GlobToken[] = ['dirs']
  for (let k = 0; k < glob.length; k++) {
    const ch = glob[k] as string
    const token: GlobToken =
      glob.startsWith('**/', k) ? 'dirs' : glob.startsWith('**', k) ? 'any' : ch === '*' ? 'star' : ch === '?' ? 'one' : `=${ch}`
    if (token === 'dirs') k += 2
    else if (token === 'any') k += 1
    const prev = out.at(-1)
    // Runs collapse: `**/**/`, `***`, `**` after `*` match what one of them matches.
    if (token === prev && token !== 'one' && !token.startsWith('=')) continue
    if (token === 'star' && prev === 'any') continue
    out.push(token)
  }
  return out
}

/** The comma-separated globs of `testPaths`, each at most 200 characters and 16 in all; undefined when none are given. */
export function compileGlobs(spec: string): Globs | undefined {
  const globs = spec
    .split(',')
    .map(one => one.trim().replace(/^\/+/, ''))
    .filter(one => one.length > 0 && one.length <= 200)
    .slice(0, 16)
  return globs.length === 0 ? undefined : globs.map(tokenize)
}

/** Whether `tokens` match all of `text`: one pass per token over the text, never backtracking. */
function globMatches(tokens: readonly GlobToken[], text: string): boolean {
  const n = text.length
  let prev = new Uint8Array(n + 1)
  let cur = new Uint8Array(n + 1)
  prev[0] = 1
  for (const token of tokens) {
    cur.fill(0)
    let seen = 0
    for (let j = 0; j <= n; j++) {
      const before = j > 0 ? (text[j - 1] as string) : ''
      if (token === 'any') cur[j] = prev[j] || (j > 0 ? (cur[j - 1] as number) : 0)
      else if (token === 'star') cur[j] = prev[j] || (j > 0 && before !== '/' ? (cur[j - 1] as number) : 0)
      else if (token === 'dirs') cur[j] = prev[j] || (before === '/' ? seen : 0)
      else if (j > 0) cur[j] = prev[j - 1] && (token === 'one' ? before !== '/' : before === token.slice(1)) ? 1 : 0
      seen = seen || (prev[j] as number)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n] === 1
}

/** Whether an edit's path is a test file, whose change alone never earns a win; only its last 256 characters are read. */
export const isTestPath = (path: string, extra: Globs | undefined) => {
  const tail = path.slice(-PATH_TAIL)
  return TEST_PATH.test(tail) || (extra?.some(tokens => globMatches(tokens, tail)) ?? false)
}

// ---- drawing ----------------------------------------------------------------------------

export const FRAME_MS = 30
const TRAIL = 10
const BLANK = 0x20
const RULE = 0x2501 // ━
const DEFAULT = 0x01000000
const DIM = 0x1f5a35
const BRIGHT = 0x8ff5aa
const HEAD = 0xeafff0

/** Frames of motion per tier: one sweep (480 ms), a sweep and a pulse, or two sweeps and a pulse (about 1.1 s). */
export const framesFor = (tier: Tier) => (tier === 4 ? 36 : tier === 3 ? 24 : 16)

function mix(from: number, to: number, t: number): number {
  const channel = (shift: number) => {
    const a = (from >> shift) & 255
    const b = (to >> shift) & 255
    return Math.round(a + (b - a) * t) << shift
  }
  return channel(16) | channel(8) | channel(0)
}

/** One frame of the sweep, `cols` Raster cells packed as RasterProps wants them. */
export function sweepFrame(cols: number, tier: Tier, frame: number): string {
  const pass = tier === 4 ? 14 : 16
  const view = new DataView(new ArrayBuffer(cols * 12))
  const span = Math.max(1, cols - 1)
  let head = -1
  let isBack = false
  let glow = 0
  if (frame < pass) {
    head = Math.round(((frame + 1) / pass) * span)
  } else if (tier === 4 && frame < 2 * pass) {
    isBack = true
    head = span - Math.round(((frame - pass + 1) / pass) * span)
  } else {
    // The pulse: the whole row brightens once and settles, over 8 frames.
    const p = frame - (tier === 4 ? 2 * pass : pass)
    glow = Math.max(0, 1 - Math.abs(p - 4) / 4)
  }
  for (let x = 0; x < cols; x++) {
    let glyph = RULE
    let color = DIM
    if (head >= 0) {
      const behind = isBack ? x - head : head - x
      if (behind < 0) {
        if (!isBack) glyph = BLANK
      } else if (behind === 0) color = HEAD
      else if (behind <= TRAIL) color = mix(BRIGHT, DIM, behind / TRAIL)
    } else color = mix(DIM, BRIGHT, glow)
    view.setUint32(x * 12, glyph, true)
    view.setUint32(x * 12 + 4, glyph === BLANK ? DEFAULT : color, true)
    view.setUint32(x * 12 + 8, DEFAULT, true)
  }
  const bytes = new Uint8Array(view.buffer)
  let binary = ''
  for (let k = 0; k < bytes.length; k += 4096) binary += String.fromCharCode(...bytes.subarray(k, k + 4096))
  return btoa(binary)
}

/** The band's one row once the motion has settled: what was won, never the cost the receipt keeps. */
export function stampText(band: Band, columns: number): string {
  const words = WORDS[band.locale]
  // The green comes before the directory, so a cut at the end never takes it.
  const where = band.where === '' ? '' : ` (${band.where})`
  if (columns < 40) return `✔ ${words.green} ${band.label}${where}`.slice(0, Math.max(4, columns))
  if (band.kind === 'commit') return `✔ commit${band.label === '' ? '' : ` ${band.label}`} · ${words.kept}`
  if (band.kind === 'first') return `✔ ${band.label}  ${words.green}${where} · ${words.first}`
  return `✔ ${band.label}  ${words.green}${where}`
}
