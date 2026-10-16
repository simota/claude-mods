import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { ShelfItem } from '../types'
import { absolute, commandOutputs, kindOf, search, shelve, textOutputs } from '../hooks/shelf'

describe('shelf', () => {
  test('knows made things by extension, not source or config', () => {
    expect(kindOf('out/report.PDF')).toBe('document')
    expect(kindOf('a.csv')).toBe('data')
    expect(kindOf('fix.patch')).toBe('patch')
    expect(kindOf('src/app.ts')).toBeUndefined()
    expect(kindOf('package.json')).toBeUndefined()
  })

  test('finds where a command wrote', () => {
    expect(commandOutputs('git diff > fix.patch')).toEqual(['fix.patch'])
    expect(commandOutputs('pandoc README.md -o out/readme.pdf && echo done')).toEqual(['out/readme.pdf'])
    expect(commandOutputs('curl -sL https://x/y.csv --output data/y.csv')).toEqual(['data/y.csv'])
    expect(commandOutputs("ffmpeg -i in.mov -vf scale=640:-1 'clip small.mp4'")).toEqual(['clip small.mp4'])
    expect(commandOutputs('python3 report.py | tee report.html')).toEqual(['report.html'])
    expect(commandOutputs('tar -czf dist.tgz dist/')).toEqual(['dist.tgz'])
    expect(commandOutputs('cat a.csv > $OUT')).toEqual([])
    expect(commandOutputs('npm test > /dev/null')).toEqual([])
  })

  test('finds made things a tool answer names', () => {
    expect(textOutputs('Saved chart to /tmp/plots/sales.png.\nSee ./out/report.html')).toEqual(['/tmp/plots/sales.png', './out/report.html'])
    expect(textOutputs('edited src/app.ts')).toEqual([])
  })

  test('resolves paths against the folder and home', () => {
    expect(absolute('out/../a.csv', '/w', '/Users/me')).toBe('/w/a.csv')
    expect(absolute('~/Downloads/x.pdf', '/w', '/Users/me')).toBe('/Users/me/Downloads/x.pdf')
  })

  const DAY = 24 * 60 * 60 * 1000
  const item = (path: string, at: number, purpose = '', event = 'Write'): ShelfItem => ({ path, kind: kindOf(path)!, size: 1, at, tool: 'Write', event, purpose, sessionId: 's' })
  const NOW = 10 * DAY + 5_000
  const ITEMS = [item('/w/sales.csv', NOW - 1000, '売上を集計'), item('/w/demo.mp4', NOW - 2 * DAY, 'デモ動画'), item('/w/fix.patch', NOW - DAY - 1000, '', 'Bash: git diff > fix.patch')]

  test('searches by kind, extension, time and words, all of them', () => {
    const paths = (query: string) => search(ITEMS, query, NOW).map(one => one.path)
    expect(paths('動画')).toEqual(['/w/demo.mp4'])
    expect(paths('csv')).toEqual(['/w/sales.csv'])
    expect(paths('今日')).toEqual(['/w/sales.csv'])
    expect(paths('昨日')).toEqual(['/w/fix.patch'])
    expect(paths('git diff')).toEqual(['/w/fix.patch'])
    expect(paths('3d 売上')).toEqual(['/w/sales.csv'])
  })

  test('counts today and yesterday from local midnight', () => {
    // 08:30 and 09:30 of one local day: 09:00 is midnight UTC in Japan, where the UTC day split them.
    const morning = new Date(2026, 9, 15, 8, 30).getTime()
    const lateLastNight = new Date(2026, 9, 14, 23, 30).getTime()
    const asked = new Date(2026, 9, 15, 9, 30).getTime()
    const at = (when: number) => [item('/w/a.csv', when)]
    expect(search(at(morning), '今日', asked)).toHaveLength(1)
    expect(search(at(lateLastNight), '今日', asked)).toHaveLength(0)
    expect(search(at(lateLastNight), '昨日', asked)).toHaveLength(1)
  })

  test('replaces an older entry for a path made again', () => {
    expect(shelve(ITEMS, [item('/w/demo.mp4', NOW)], 10).map(one => [one.path, one.at])).toEqual([
      ['/w/demo.mp4', NOW],
      ['/w/sales.csv', NOW - 1000],
      ['/w/fix.patch', NOW - DAY - 1000],
    ])
  })
})

type World = { files: Record<string, number>; toasts: string[]; store: Record<string, unknown>; race?: (mine: unknown) => unknown }

function world(on: On): World {
  const w: World = { files: {}, toasts: [], store: {} }
  on('store.get', ($, e) => ({ value: w.store[e.key] }) as never)
  on('store.set', ($, e) => {
    w.store[e.key] = e.value
    // Another session, having read before this write, writes its own list over it once.
    const race = w.race
    if (race !== undefined) {
      w.race = undefined
      w.store[e.key] = race(e.value)
    }
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete w.store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(w.store) }))
  mock.clock(on, { now: 100_000 })
  mock.env(on, { HOME: '/Users/me' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.repo', () => ({ value: { root: '/w', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const at = w.files[String(e.path)]
    if (at === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 2048, mtimeMs: at, isLink: false } }
  })
  on('tool.call', ($, e) => {
    const command = (e as unknown as { command?: string }).command
    if (command === 'pandoc a.md -o out.pdf') w.files['/w/out.pdf'] = 100_500
    if (command === 'git diff > old.patch') w.files['/w/old.patch'] = 1 // already there, not made now
    return { result: {}, text: 'ok' }
  })
  return w
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const shelfRun = (args: string) => ({ command: 'shelf', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

describe('artifact-shelf in a session', () => {
  test('shelves what a call made, with the request it answered, and finds it again', async ($, on) => {
    const w = world(on)
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(START)
    await $.prompt.submit({ text: 'README を PDF にして', origin: { kind: 'composer' }, wait: false })
    await $.tool.call({ tool: 'Bash', command: 'pandoc a.md -o out.pdf' })
    await $.tool.call({ tool: 'Bash', command: 'git diff > old.patch' })
    expect(w.toasts).toEqual(['🗄 棚に追加: out.pdf'])

    const text = (await $.command.run(shelfRun('pdf'))).text
    expect(text).toContain('/w/out.pdf — Bash: pandoc a.md -o out.pdf')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'artifact-shelf',
        surface,
        component: 'Pane',
        requestId: 'artifact-shelf',
        props: { title: '成果物の棚', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /「README を PDF にして」 · Bash: pandoc/ })).toBeDefined()
      await ui.press({ key: 'k-video' })
      expect(await ui.find({ type: 'Text', text: /該当する成果物はありません/ })).toBeDefined()
      await ui.press({ key: 'k-all' })
      await ui.unmount()
    }
  })

  test('a credential in the request is masked before it is kept, and one kept before is masked when shown', async ($, on) => {
    const w = world(on)
    on('prompt.submit', ($, e) => ({ text: e.text }))
    w.store['shelf:/w'] = [{ path: '/w/old.csv', kind: 'data', size: 1, at: 1, tool: 'Write', event: 'Write', purpose: 'export with API_KEY=hunter2secret', sessionId: 's0' }]
    w.files['/w/old.csv'] = 1
    await $.session.start(START)
    await $.prompt.submit({ text: 'export users with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', origin: { kind: 'composer' }, wait: false })
    await $.tool.call({ tool: 'Bash', command: 'pandoc a.md -o out.pdf' })
    const stored = JSON.stringify(w.store)
    expect(stored).toContain('GITHUB_TOKEN=***')
    expect(stored).not.toContain('ghp_abcdefghij')
    await $.command.run(shelfRun(''))
    const ui = await $.ui.mount({
      plugin: 'artifact-shelf',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'artifact-shelf',
      props: { title: '成果物の棚', isFocused: true, bodyColumns: 160, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /hunter2secret/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /API_KEY=\*\*\*/ })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(shelfRun('hunter2secret'))).text).not.toContain('hunter2secret —')
  })

  test('an item overwritten by another session at the same moment is shelved again', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const theirs: ShelfItem = { path: '/w/other.csv', kind: 'data', size: 1, at: 1, tool: 'Write', event: 'Write', purpose: '', sessionId: 's2' }
    w.race = () => [theirs]
    await $.tool.call({ tool: 'Bash', command: 'pandoc a.md -o out.pdf' })
    expect((w.store['shelf:/w'] as ShelfItem[]).map(one => one.path).sort()).toEqual(['/w/other.csv', '/w/out.pdf'])
  })
})
