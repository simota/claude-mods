import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { bashTouches, blank, capFiles, countsOf, editChange, errorPaths, importPattern, inRepo, milestoneOf, rowsOf, warningsOf, withEdit, withRead } from '../hooks/fog'

const ROOT = '/w/app'
const FILES = ['README.md', 'src/a.ts', 'src/b.ts', 'src/util/c.ts', 'docs/guide.md', 'lib/x.py']

type Seen = { toasts: string[]; status: (string | undefined)[] }

// The world beneath the plugin: a git repository at ROOT with FILES, where src/b.ts imports
// src/a.ts, and tools that succeed unless a Bash run is told to fail.
function world(on: On, failing: Record<string, string> = {}, files: readonly string[] = FILES): Seen {
  const seen: Seen = { toasts: [], status: [] }
  mock.store(on, {})
  mock.clock(on, { now: 1_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  // Only README.md exists outside FILES' content: a Write onto it writes over two lines.
  on('fs.read', ($, e) => {
    if (String(e.path).endsWith('/README.md')) return { value: '# app\nintro' } as never
    throw new Error('ENOENT')
  })
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
    if (argv === 'git ls-files -z') return ok(`${files.join('\0')}\0`)
    if (argv === 'git branch --show-current') return ok('main\n')
    if (argv.startsWith('git grep -l -E') && argv.includes('a(')) return ok('src/a.ts\nsrc/b.ts\n')
    if (argv.startsWith('git grep')) return { value: { exitCode: 1, stdout: '', stderr: '' } } as never
    return { value: { exitCode: 1, stdout: '', stderr: `unexpected: ${argv}` } } as never
  })
  on('tool.call', ($, e) => {
    const command = (e as unknown as { command?: string }).command
    const text = command === undefined ? undefined : failing[command]
    return text === undefined ? { result: {}, text: 'ok' } : { result: {}, text, isError: true }
  })
  return seen
}

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const RUN = { command: 'map', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

describe('fog', () => {
  test('the file list is held under the state limit, whatever the repository holds', () => {
    const files = Array.from({ length: 50_000 }, (_, i) => `src/main/java/com/example/${'x'.repeat(60)}/F${String(i).padStart(6, '0')}.java`)
    const held = capFiles(files)
    expect(JSON.stringify(held).length).toBeLessThanOrEqual(3_000_000)
    expect(held.length).toBeGreaterThan(0)
    expect(held).toEqual(files.slice(0, held.length))
    expect(capFiles(FILES)).toEqual(FILES)
  })

  test('places a path in the repository, or nowhere', () => {
    expect(inRepo('/w/app/src/a.ts', ROOT, ROOT)).toBe('src/a.ts')
    expect(inRepo('../src/../README.md', ROOT, '/w/app/src')).toBe('README.md')
    expect(inRepo('/etc/hosts', ROOT, ROOT)).toBeUndefined()
  })

  test('reads Bash readers and sed -i as reads and edits of known files, following cd', () => {
    const known = (word: string, cwd: string) => {
      const path = inRepo(word, ROOT, cwd)
      return path !== undefined && FILES.includes(path) ? path : undefined
    }
    expect(bashTouches("cat README.md && sed -n 1,9p 'src/a.ts' | head", ROOT, known)).toEqual({ reads: ['README.md', 'src/a.ts'], edits: [] })
    expect(bashTouches('sed -i "" s/a/b/ src/b.ts', ROOT, known)).toEqual({ reads: [], edits: ['src/b.ts'] })
    expect(bashTouches('npm test src/a.ts', ROOT, known)).toEqual({ reads: [], edits: [] })
    expect(bashTouches('cd src && cat a.ts util/c.ts', ROOT, known)).toEqual({ reads: ['src/a.ts', 'src/util/c.ts'], edits: [] })
    expect(bashTouches('cd $WORK && cat a.ts', ROOT, known)).toEqual({ reads: [], edits: [] })
  })

  test('counts lines as a diff stat does, not the whole text', () => {
    expect(editChange('a', 'a\nb')).toEqual({ added: 1, removed: 0 })
    expect(editChange('x\ny\nz', 'x\nY\nz')).toEqual({ added: 1, removed: 1 })
    expect(editChange('', 'x\ny')).toEqual({ added: 2, removed: 0 })
  })

  test('finds the paths a failure names with a line', () => {
    expect(errorPaths('src/a.ts(12,5): error TS2322\n  at lib/x.py:40 in f')).toEqual(['src/a.ts', 'lib/x.py'])
  })

  test('reads a long output without a path in linear time: it runs before every Bash result', () => {
    // Each of these took over a second when a regex scanned the rest of a long word from every start.
    for (const output of ['a.b'.repeat(10_000), 'Q'.repeat(60_000)]) {
      const started = performance.now()
      errorPaths(output)
      expect(performance.now() - started).toBeLessThan(100)
    }
    expect(errorPaths(`${'a.b'.repeat(10_000)} src/a.ts:3`)).toEqual(['src/a.ts'])
  })

  test('names the same paths the line-number regex did, word for word', () => {
    expect(errorPaths('a.ts:12.b.ts:3')).toEqual(['a.ts', '.b.ts'])
    expect(errorPaths('x a.ts-x:1 b.c.d(1,2) e.1f:2 .g:3 h.i')).toEqual(['b.c.d'])
    expect(errorPaths('@scope/pkg/index.js:7:9 ~/x.py:1')).toEqual(['@scope/pkg/index.js', '~/x.py'])
  })

  test('greps importers of JS/TS and Python only, in POSIX classes macOS git understands', () => {
    expect(importPattern('src/a.ts')).toContain('[/.]a(')
    expect(importPattern('lib/x.py')).toContain('?x(')
    expect(importPattern('README.md')).toBeUndefined()
    // The git macOS ships matches nothing for these escapes in `git grep -E`.
    for (const pattern of [importPattern('src/a.ts'), importPattern('lib/x.py')]) expect(pattern).not.toMatch(/\\[sSwWbBd]/)
  })

  test('counts the explored share and the milestone it crosses', () => {
    const touched = { 'src/a.ts': withRead(undefined, 1), 'src/b.ts': withEdit(undefined, { added: 3, removed: 1 }, 1) }
    const counts = countsOf(touched, FILES)
    expect(counts).toMatchObject({ read: 1, edited: 1, touched: 2, total: 6, percent: 33 })
    expect(milestoneOf(0, counts.percent)).toBe(25)
    expect(milestoneOf(25, 30)).toBeUndefined()
  })

  test('draws fog where nothing was touched, opens what was edited, closes what was only read', () => {
    const touched = {
      'src/a.ts': withEdit(withRead(undefined, 1), { added: 3, removed: 1 }, 2),
      'src/util/c.ts': withRead(undefined, 1),
    }
    const rows = rowsOf(FILES, touched, 'src/a.ts', 80).map(row => `${'  '.repeat(row.depth)}${row.text}`)
    expect(rows).toEqual(['▾ src/', '  ▸ util/  ○', '  ● a.ts  +3 −1  ★', '  ░ b.ts', '░ docs/  ░ lib/  ░ README.md'])
  })

  test('warns of an edit made unread, and of importers of an edit never opened', () => {
    const touched = { 'src/a.ts': withEdit(undefined, { added: 1, removed: 1 }, 1), 'docs/guide.md': { ...blank(1), edits: 1, isNew: true } }
    expect(warningsOf(touched, { 'src/a.ts': ['src/b.ts'] })).toEqual([
      '編集したのに一度も読んでいない: src/a.ts',
      '編集したファイルを import しているが未読: src/b.ts',
    ])
  })
})

describe('fog-map in a session', () => {
  test('clears the fog as Claude reads and edits, and says what is worth saying', async ($, on) => {
    const seen = world(on, { 'npx tsc -p .': 'src/a.ts(3,1): error TS2304' })
    await $.session.start(START)
    expect(seen.status.at(-1)).toBe('🗺 0% · ●0')

    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/a.ts` })
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/a.ts`, old_string: 'a', new_string: 'a\nb' })
    await $.tool.call({ tool: 'Bash', command: 'cat README.md docs/guide.md' })
    await $.tool.call({ tool: 'Bash', command: 'npx tsc -p .' })
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes/new.md`, content: 'x\ny\nz' })

    expect(seen.toasts).toContain('🗺 新しい区域を開拓: src/')
    expect(seen.toasts).toContain('🗺 新しい区域を開拓: notes/')
    expect(seen.toasts.some(text => text.includes('探索率 50% 到達'))).toBe(true)
    // src/b.ts imports the edited src/a.ts and was never opened.
    expect(seen.status.at(-1)).toBe('🗺 57% · ●2 · ✗1 · ⚠1')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the ${surface} pane draws the map`, async ($, on) => {
      world(on)
      await $.session.start(START)
      await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/a.ts` })
      await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/a.ts`, old_string: 'a', new_string: 'b' })
      await $.tool.call({ tool: 'Write', file_path: `${ROOT}/README.md`, content: '# app\nintro\nmore' })
      expect((await $.command.run(RUN)).text).toBe('🗺 探索率 33% · 2/6')

      const ui = await $.ui.mount({
        plugin: 'fog-map',
        surface,
        component: 'Pane',
        requestId: 'fog-map',
        props: { title: '探索マップ', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /探索率 33%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /● a\.ts {2}\+1 −1$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /● README\.md {2}\+1 −0 {2}★/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /░ docs\/ {2}░ lib\// })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /⚠ 編集したファイルを import しているが未読: src\/b\.ts/ })).toBeDefined()
      await ui.unmount()
    })
  }
  test('a large repository is still mapped, not taken for no repository', async ($, on) => {
    const big = Array.from({ length: 50_000 }, (_, i) => `src/main/java/com/example/${'x'.repeat(60)}/F${String(i).padStart(6, '0')}.java`)
    world(on, {}, big)
    await $.session.start(START)
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/${big[0]}` } as never)
    const text = (await $.command.run(RUN)).text
    expect(text).not.toContain('リポジトリの外')
  })
})
