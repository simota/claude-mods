import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { commandStderr, isSafeRef, isTimeout, parseArgs, parseTime, reportLines, statsOf, verdictOf } from '../hooks/delta'

const BSD = (real: number, rss: number) => `bench says hi\n        ${real.toFixed(2)} real         0.50 user         0.10 sys\n  ${rss}  maximum resident set size\n         0  average shared memory size\n`
const GNU = '\tCommand being timed: "sh -c x"\n\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:01.50\n\tMaximum resident set size (kbytes): 2048\n'

describe('delta', () => {
  test('reads wall time and peak memory from BSD and GNU time', () => {
    expect(parseTime(BSD(1.25, 1048576))).toEqual({ wallMs: 1250, rssBytes: 1048576 })
    expect(parseTime(GNU)).toEqual({ wallMs: 1500, rssBytes: 2097152 })
    expect(commandStderr(BSD(1, 1))).toBe('bench says hi')
  })

  test('computes median, spread and coefficient of variation', () => {
    expect(statsOf([3, 1, 2, 10])).toMatchObject({ n: 4, median: 2.5, min: 1, max: 10 })
    expect(statsOf([5, 5, 5])?.cv).toBe(0)
    expect(statsOf([])).toBeUndefined()
  })

  test('calls a difference only past twice the larger deviation', () => {
    const steady = statsOf([100, 101, 99, 100, 100])
    expect(verdictOf(steady, statsOf([80, 81, 79, 80, 80]))).toMatchObject({ verdict: 'faster', deltaPct: -20 })
    expect(verdictOf(steady, statsOf([130, 131, 129, 130, 130])).verdict).toBe('slower')
    expect(verdictOf(statsOf([100, 140, 60, 100]), statsOf([110, 150, 70, 110])).verdict).toBe('noise')
  })

  test('calls nothing from fewer than three runs a side: one run has no spread to weigh a difference by', () => {
    expect(verdictOf(statsOf([100]), statsOf([95]))).toMatchObject({ verdict: 'few', deltaPct: -5 })
    expect(verdictOf(statsOf([100, 101]), statsOf([90, 91])).verdict).toBe('few')
    expect(verdictOf(statsOf([100, 101, 99]), statsOf([80, 81, 79])).verdict).toBe('faster')
  })

  test('a rejected run is a timeout when it lasted about as long as the limit, else one that could not start', () => {
    expect(isTimeout(300_000, 300_000)).toBe(true)
    expect(isTimeout(299_400, 300_000)).toBe(true) // a timer that fires a little early
    expect(isTimeout(12, 300_000)).toBe(false)
  })

  test('reads the arguments and refuses a ref that is not one', () => {
    expect(parseArgs('base npm run bench')).toEqual({ mode: 'base', command: 'npm run bench' })
    expect(parseArgs('ref HEAD~1 cargo bench --bench parse')).toEqual({ mode: 'ref', ref: 'HEAD~1', command: 'cargo bench --bench parse' })
    expect(parseArgs('node bench.js')).toEqual({ mode: 'run', command: 'node bench.js' })
    expect(parseArgs('')).toEqual({ mode: 'show', command: '' })
    // A ref with no command asks for one, never runs a shell command named `ref`.
    expect(parseArgs('ref main')).toEqual({ mode: 'ref', ref: 'main', command: '' })
    expect(isSafeRef('origin/main')).toBe(true)
    expect(isSafeRef('--upload-pack=x')).toBe(false)
    expect(isSafeRef('a..b')).toBe(false)
  })

  test('warns of an unsteady side', () => {
    const at = 1
    const lines = reportLines(
      { label: '基準', command: 'x', at, timesMs: [100, 100, 100], rssBytes: [] },
      { label: '現在', command: 'x', at, timesMs: [50, 150, 100], rssBytes: [] },
    )
    expect(lines[0]).toBe('時間: 0.0% ばらつきの範囲内')
    expect(lines.some(line => line.includes('⚠ 現在 のばらつきが大きい'))).toBe(true)
  })
})

type World = { argvs: string[]; toasts: string[]; clock: ReturnType<typeof mock.clock>; reals: number[]; cwd: string; missing: string[]; unstartable: string[]; prefix: string; worktrees: string; isRemoveFailing: boolean }

function world(on: On): World {
  const clock = mock.clock(on, { now: 1_000 })
  const w: World = { argvs: [], toasts: [], clock, reals: [], cwd: '/w', missing: [], unstartable: [], prefix: '', worktrees: '', isRemoveFailing: false }
  mock.store(on, {})
  mock.env(on, { TMPDIR: '/tmp/me' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/w', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: !w.missing.includes(String(e.path)) }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    w.argvs.push(argv)
    const ok = (stdout: string, stderr = '') => ({ value: { exitCode: 0, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv === 'uname -s') return ok('Darwin\n')
    if (argv === 'git rev-parse --show-prefix') return ok(`${w.prefix}\n`)
    if (argv.startsWith('mktemp -d /tmp/me/perf-delta-')) return ok(`${argv.slice('mktemp -d '.length).replace('XXXXXX', 'ab12cd')}\n`)
    if (argv === 'git worktree list --porcelain') return ok(w.worktrees)
    if (argv.startsWith('git worktree remove') && w.isRemoveFailing) return { value: { exitCode: 255, stdout: '', stderr: 'Directory not empty', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv.startsWith('git ') || argv.startsWith('rm ')) return ok('')
    if (w.unstartable.includes(String(e.init?.cwd))) throw new Error('ENOENT: no such directory')
    const real = w.reals.shift() ?? 1
    return ok('', BSD(real, 50 * 1024 * 1024))
  })
  return w
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const perf = (args: string) => ({ command: 'perf', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

describe('perf-delta in a session', () => {
  test('saves the first run as the baseline and compares the next with it', async ($, on) => {
    const w = world(on)
    await $.session.start(START)

    w.reals = [9, 1.0, 1.01, 0.99, 1.0, 1.0]
    expect((await $.command.run(perf('node bench.js'))).text).toContain('基準として計測')
    await w.clock.settle()
    expect(w.toasts.at(-1)).toBe('⏱ 基準を保存しました')
    expect(w.argvs).toContain('/usr/bin/time -l /bin/sh -c node bench.js')

    w.reals = [9, 0.8, 0.81, 0.79, 0.8, 0.8]
    expect((await $.command.run(perf('node bench.js'))).text).toContain('保存済みの基準')
    await w.clock.settle()
    expect(w.toasts.at(-1)).toBe('⏱ -20.0% 速くなった — /perf')

    const shown = (await $.command.run(perf('show'))).text
    expect(shown).toContain('時間: -20.0% 改善')
    expect(shown).toContain('メモリ: 0.0% ばらつきの範囲内')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'perf-delta',
        surface,
        component: 'Pane',
        requestId: 'perf-delta',
        props: { title: '性能差', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /時間: -20\.0% 改善/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a baseline is the folder\'s it was measured in: the same command elsewhere is measured anew', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.command.run(perf('npm test'))
    await w.clock.settle()
    w.cwd = '/w/packages/api'
    w.prefix = 'packages/api/'
    expect((await $.command.run(perf('npm test'))).text).toContain('基準として計測')
  })

  const pane = async ($: Engine) =>
    $.ui.mount({
      plugin: 'perf-delta',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'perf-delta',
      props: { title: '性能差', isFocused: true, bodyColumns: 160, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })

  test('the folder is git\'s own prefix: in a worktree of Claude\'s the ref is run in the same package', async ($, on) => {
    const w = world(on)
    w.cwd = '/w/.claude/worktrees/feat/pkg'
    w.prefix = 'pkg/'
    await $.session.start(START)
    w.reals = Array(12).fill(1)
    await $.command.run(perf('ref HEAD~1 make bench'))
    await w.clock.settle()
    expect(w.argvs).toContain('/usr/bin/time -l /bin/sh -c make bench')
    const ui = await pane($)
    expect(await ui.find({ type: 'Text', text: /がありません/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a folder missing at the ref, or a folder a command cannot start in, says so', async ($, on) => {
    const w = world(on)
    w.cwd = '/w/packages/new'
    w.prefix = 'packages/new/'
    await $.session.start(START)
    w.missing = ['/tmp/me/perf-delta-1000-ab12cd/packages/new']
    await $.command.run(perf('ref HEAD~1 make bench'))
    await w.clock.settle()
    const ui = await pane($)
    expect(await ui.find({ type: 'Text', text: /HEAD~1 には packages\/new がありません/ })).toBeDefined()
    expect(w.argvs.some(a => a.startsWith('git worktree remove --force -- /tmp/me/perf-delta-'))).toBe(true)
    await ui.unmount()

    w.cwd = '/w/gone'
    w.prefix = 'gone/'
    w.missing = []
    w.unstartable = ['/w/gone']
    await $.command.run(perf('make bench'))
    await w.clock.settle()
    const again = await pane($)
    expect(await again.find({ type: 'Text', text: /起動できませんでした/ })).toBeDefined()
    await again.unmount()
  })

  test('a worktree git cannot remove is deleted and pruned; ones left by a run cut short are removed at the next start', async ($, on) => {
    const w = world(on)
    const now = 1_000 + 13 * 3_600_000
    const young = now - 60_000
    w.worktrees = ['worktree /w', 'HEAD abc', '', 'worktree /tmp/me/perf-delta-1000-zz99zz', 'HEAD def', 'detached', '', `worktree /tmp/me/perf-delta-${young}-yy88yy`, 'HEAD 123', 'detached', ''].join('\n')
    await w.clock.advance(13 * 3_600_000)
    await $.session.start(START)
    expect(w.argvs).toContain('git worktree remove --force -- /tmp/me/perf-delta-1000-zz99zz')
    expect(w.argvs.some(a => a.includes(`perf-delta-${young}-yy88yy`) && a.startsWith('git worktree remove'))).toBe(false)

    w.isRemoveFailing = true
    w.reals = Array(12).fill(1)
    await $.command.run(perf('ref HEAD~1 make bench'))
    await w.clock.settle()
    expect(w.argvs).toContain(`rm -rf -- /tmp/me/perf-delta-${now}-ab12cd`)
    expect(w.argvs).toContain('git worktree prune')
  })

  test('runs a git ref in a temporary worktree and removes it after', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    w.reals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    await $.command.run(perf('ref HEAD~1 make bench'))
    await w.clock.settle()
    expect(w.argvs).toContain('git worktree add --detach -- /tmp/me/perf-delta-1000-ab12cd HEAD~1')
    expect(w.argvs.some(a => a.startsWith('git worktree remove --force -- /tmp/me/perf-delta-'))).toBe(true)
    expect(w.toasts.at(-1)).toContain('ばらつきの範囲内')
  })
})
