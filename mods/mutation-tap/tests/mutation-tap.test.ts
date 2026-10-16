import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { apply, changedLines, codeMask, guessCommand, isMutable, mutantsOf, spread, tallyOf } from '../hooks/mutate'

describe('mutate', () => {
  test('reads the changed lines of each file from git diff -U0', () => {
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -3 +3,2 @@', '-x', '+y', '+z', '@@ -9,2 +10,0 @@', '+++ /dev/null'].join('\n')
    expect([...changedLines(diff)]).toEqual([['src/a.ts', [3, 4]]])
  })

  test('mutates source, not tests or declarations', () => {
    expect(isMutable('src/a.ts')).toBe(true)
    expect(isMutable('src/a.test.ts')).toBe(false)
    expect(isMutable('src/a.d.ts')).toBe(false)
    expect(isMutable('README.md')).toBe(false)
  })

  test('leaves strings and comments alone', () => {
    const mask = codeMask('a("x > y") // b > c', false)
    expect(mask[4]).toBe(false)
    expect(mask[15]).toBe(false)
    expect(mask[0]).toBe(true)
  })

  test('makes the mutants of a line: comparisons, logic, booleans, negation, constants', () => {
    const ops = (text: string, path = 'src/a.ts') => mutantsOf(path, 1, text).map(one => one.operator)
    expect(ops('if (a >= 10 && !done) return true')).toEqual(['>=→>', '&&→||', 'true→false', '!x→x', 'n→n+1'])
    expect(ops("const s = 'a < b'")).toEqual([])
    expect(ops('const xs: Array<number> = []')).toEqual([])
    expect(ops("import { a } from './a'")).toEqual([])
    expect(ops('if x == 1 and y:  # a > b', 'a.py')).toEqual(['==→!=', 'and→or', 'n→n+1'])
  })

  test('spreads mutants across lines before taking a second from any', () => {
    const line = (n: number) => mutantsOf('a.ts', n, 'a > 1 && b')
    expect(spread([line(1), line(2)], 3).map(one => one.line)).toEqual([1, 2, 1])
  })

  test('applies a mutant keeping the indent, and refuses a line that changed', () => {
    const [mutant] = mutantsOf('a.ts', 2, '  return a > b')
    expect(apply('x\n  return a > b\ny', mutant!)).toBe('x\n  return a >= b\ny')
    expect(apply('x\n  return a < b\ny', mutant!)).toBeUndefined()
  })

  test('guesses the test command from the project files', () => {
    const files = (...names: string[]) => new Set(names)
    expect(guessCommand(files('package.json', 'pnpm-lock.yaml'), '{"scripts":{"test":"vitest run"}}', undefined)).toBe('pnpm test')
    expect(guessCommand(files('package.json'), '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}', undefined)).toBeUndefined()
    expect(guessCommand(files('Makefile', 'Cargo.toml'), undefined, 'build:\n\tcargo build\ntest:\n\tcargo test')).toBe('make test')
    expect(guessCommand(files('go.mod'), undefined, undefined)).toBe('go test ./...')
  })

  test('scores what was caught', () => {
    const base = mutantsOf('a.ts', 1, 'a > 1 && b')
    const judged = base.map((one, i) => ({ ...one, outcome: (['killed', 'survived', 'timeout'] as const)[i % 3] }))
    expect(tallyOf(judged)).toEqual({ killed: 1, survived: 1, timeout: 1, skipped: 0, score: 67 })
  })
})

const ROOT = '/w'
const SOURCE = ['export function max(a: number, b: number) {', '  return a > b ? a : b - 0', '}'].join('\n')
const DIFF = ['+++ b/src/max.ts', '@@ -2 +2 @@'].join('\n')

// `editDuring` stands for someone editing the working tree while the first mutant's tests run.
type World = {
  files: Record<string, string>
  runs: { cwd: string; source: string; tree: string }[]
  toasts: string[]
  onRun?: (n: number) => void
  clock: ReturnType<typeof mock.clock>
  editDuring?: (text: string) => string
}

const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// A repository whose diff touches line 2 of src/max.ts, and tests that pass while max() is
// still right: `>`→`>=` and `-`→`+` (of 0) survive them, 0→1 does not. `cp` copies the
// in-memory tree to the folder it is given; `rm -rf` removes it.
function world(on: On, store: Record<string, unknown> = {}): World {
  const clock = mock.clock(on, { now: 1_000 })
  const w: World = { files: { [`${ROOT}/src/max.ts`]: SOURCE, [`${ROOT}/package.json`]: '{"scripts":{"test":"vitest run"}}' }, runs: [], toasts: [], clock }
  mock.store(on, store)
  mock.env(on, { TMPDIR: '/t' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [{ name: 'package.json', kind: 'file' }, { name: 'src', kind: 'dir' }] }) as never)
  on('fs.read', ($, e) => {
    const text = w.files[String(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.write', ($, e) => {
    w.files[String(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const argv = e.argv
    if (argv[0] === 'git') return ok(DIFF)
    if (argv[0] === '/bin/sh' && String(argv[2]).includes('cp -cR')) {
      const [dir, from] = [argv[4] as string, argv[5] as string]
      for (const [path, text] of Object.entries(w.files)) if (path.startsWith(`${from}/`)) w.files[`${dir}${path.slice(from.length)}`] = text
      return ok()
    }
    if (argv[0] === 'rm') {
      const dir = argv.at(-1) as string
      for (const path of Object.keys(w.files)) if (path.startsWith(`${dir}/`)) delete w.files[path]
      return ok()
    }
    const cwd = e.init?.cwd ?? ''
    const source = w.files[`${cwd}/src/max.ts`] ?? ''
    w.runs.push({ cwd, source, tree: w.files[`${ROOT}/src/max.ts`] ?? '' })
    w.onRun?.(w.runs.length)
    if (w.editDuring !== undefined && w.runs.length === 2) w.files[`${ROOT}/src/max.ts`] = w.editDuring(w.files[`${ROOT}/src/max.ts`] ?? '')
    return ok('', /return a >=? b \? a : b [-+] 0$/.test(source.split('\n')[1] ?? '') ? 0 : 1)
  })
  return w
}

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const run = (args: string) => ({ command: 'mutate', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
const copies = (w: World) => Object.keys(w.files).filter(path => path.startsWith('/t/claude-mutation-tap/'))

describe('mutation-tap in a session', () => {
  test('runs each mutant in a copy, never in the working tree, and shows what survived', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect((await $.command.run(run(''))).text).toContain('作業ツリーは書き換えません')
    await w.clock.settle()

    expect(w.runs).toHaveLength(4) // the baseline and three mutants
    expect(w.runs.every(one => one.cwd.startsWith('/t/claude-mutation-tap/') && one.tree === SOURCE)).toBe(true)
    expect(w.runs[0]?.source).toBe(SOURCE)
    expect(w.runs[1]?.source).toContain('return a >= b')
    expect(copies(w)).toEqual([])
    expect(w.toasts.at(-1)).toContain('見逃した改変 2件')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'mutation-tap',
        surface,
        component: 'Pane',
        requestId: 'mutation-tap',
        props: { title: 'ミューテーション', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /完了 3件 · 検出 1 · 生存 2 · スコア 33%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\+ return a >= b \? a : b/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('an edit to the working tree during a run is neither seen nor undone', async ($, on) => {
    const w = world(on)
    w.editDuring = text => `// edited meanwhile\n${text}`
    await $.session.start(START)
    await $.command.run(run(''))
    await w.clock.settle()
    expect(w.files[`${ROOT}/src/max.ts`]).toBe(`// edited meanwhile\n${SOURCE}`)
    expect(w.runs.slice(1).every(one => !one.source.startsWith('// edited'))).toBe(true)
  })

  test('a copy another session is running in is left alone; one gone quiet is removed', async ($, on) => {
    // The store is one file for every session of the user: another session's run is live in 500.
    const w = world(on, { copies: { '/t/claude-mutation-tap/500': { at: 1_000 }, '/t/claude-mutation-tap/400': { at: 1_000 - 31 * 60_000 } } })
    w.files['/t/claude-mutation-tap/500/src/max.ts'] = SOURCE
    w.files['/t/claude-mutation-tap/400/src/max.ts'] = SOURCE
    await $.session.start(START)
    expect(copies(w)).toEqual(['/t/claude-mutation-tap/500/src/max.ts'])
  })

  test('a run whose copy is taken away fails, rather than counting its mutants as caught', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    w.onRun = n => {
      if (n === 2) for (const path of copies(w)) delete w.files[path]
    }
    await $.command.run(run(''))
    await w.clock.settle()
    const ui = await $.ui.mount({
      plugin: 'mutation-tap',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'mutation-tap',
      props: { title: 'ミューテーション', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /実行できませんでした/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /複製が消えました/ })).toBeDefined()
    await ui.unmount()
    expect(w.toasts.join('\n')).not.toContain('すべての改変をテストが検出')
  })

  test('removes a copy a run cut short left behind', async ($, on) => {
    const w = world(on, { copy: '/t/claude-mutation-tap/123' })
    w.files['/t/claude-mutation-tap/123/src/max.ts'] = SOURCE
    await $.session.start(START)
    expect(copies(w)).toEqual([])
  })
})
