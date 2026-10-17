import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { TAIL, classify, classifyOrIgnore, compileGlobs, editsOf, scanCommand, isTestPath, outputTail, parseFailCount, sweepFrame } from '../hooks/win'
import type { BashOutcome } from '../hooks/win'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const MIN = 60_000
const CWD = '/repo'
const PASS = '44 passed'
const FAIL = '3 failed, 41 passed'

type Answer =
  | { kind: 'pass'; stdout: string; extra?: Record<string, unknown> }
  | { kind: 'fail'; exit: number; out: string }
  | { kind: 'raw'; answer: Record<string, unknown> }

type World = {
  clock: MockClock
  next: Answer
  ids: string[]
  plays: { asset: string | undefined; gain: number | undefined }[]
  order: string[]
  blits: number
  /** Files `$.fs.read` answers, by path. */
  files: Record<string, string>
}

// Stands for the engine beneath the plugin: the clock, the tools, audio, blits and the engine's own rows.
function world(on: On, env: Record<string, string> = { LANG: 'ja_JP.UTF-8' }, settings: Record<string, unknown> = {}): World {
  const w: Omit<World, 'clock'> = { next: { kind: 'pass', stdout: PASS }, ids: [], plays: [], order: [], blits: 0, files: {} }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  on('settings.read', () => ({ value: settings }))
  on('session.cwd', () => ({ value: CWD }))
  on('fs.read', ($, e) => {
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('tool.call', ($, e) => {
    w.ids.push(e.tool_use_id)
    if (e.tool !== 'Bash') return { result: 'ok', text: 'ok' }
    const next = w.next
    if (next.kind === 'raw') return next.answer as never
    if (next.kind === 'fail') {
      const text = `Exit code ${next.exit}\n${next.out}`
      return { isError: true as const, result: text, text }
    }
    return { result: { stdout: next.stdout, stderr: '', interrupted: false, ...next.extra }, text: next.stdout }
  })
  on('audio.play', ($, e) => {
    w.order.push('play')
    w.plays.push({ asset: e.clip.asset, gain: e.gain })
    return { value: undefined }
  })
  on('ui.blit', () => {
    w.blits += 1
    return { value: {} }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine') as RenderElement
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine-result' }, 'engine result') as RenderElement
  })
  return Object.assign(w, { clock })
}

// Counts the timers other plugins ask for, above the mocked clock: one `clock.after` per wait,
// one `clock.every` dispatch per period.
const timers = { after: 0, every: 0 }
const TIMER_COUNT = {
  name: 'timer-count',
  register: (on: On) => {
    on('clock.after', ($, e, next) => {
      timers.after += 1
      return next(e)
    })
    on('clock.every', ($, e, next) => {
      timers.every += 1
      return next(e)
    })
  },
}

const pass = (w: World, stdout = PASS, extra?: Record<string, unknown>) => {
  w.next = extra === undefined ? { kind: 'pass', stdout } : { kind: 'pass', stdout, extra }
}
const fail = (w: World, out = FAIL, exit = 1) => {
  w.next = { kind: 'fail', exit, out }
}
const bash = async ($: Engine, w: World, command: string) => {
  const ran = await $.tool.call({ tool: 'Bash', command })
  return { ran, id: w.ids.at(-1) as string }
}
const edit = ($: Engine, path = '/repo/src/price.ts') => $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })
const prompt = ($: Engine, text = 'next') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
let turn = 0
const endTurn = ($: Engine, answer = 'done') => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: `t${++turn}`, reason: 'answer' })

/** A red → edit → green on `command`, the clock moved `redMs` while it was red. */
async function recover($: Engine, w: World, command = 'pnpm test', redMs = 30_000, out = FAIL) {
  fail(w, out)
  await bash($, w, command)
  await w.clock.advance(redMs)
  await edit($)
  pass(w)
  const won = await bash($, w, command)
  await w.clock.settle()
  return won
}

const bandProps = (bodyColumns: number, hasSurvey = false) => ({
  hasSurvey,
  isWorking: false,
  maxRows: 10,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})

/** What the band draws: its texts in order (the engine's last) and whether the sweep's Raster is there. */
async function band($: Engine, surface: Surface, bodyColumns = 80, hasSurvey = false) {
  const ui = await $.ui.mount({ plugin: 'kachi', surface, component: 'AbovePrompt', requestId: 'band', props: bandProps(bodyColumns, hasSurvey) })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const hasRaster = (await ui.find({ type: 'Raster' })) !== undefined
  await ui.unmount()
  return { texts, hasRaster }
}

/** What the result block under a Bash row draws. */
async function result($: Engine, id: string) {
  const ui = await $.ui.mount({
    plugin: 'kachi',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: 'Bash', output: {}, isErrored: false },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  await ui.unmount()
  return texts
}

const stampOf = async ($: Engine) => (await band($, 'terminal')).texts.filter(text => text !== 'engine')

describe('earned wins', () => {
  test('a failing check, an edit, then the same check passing plays the click and sweeps the band once', async ($, on) => {
    const w = world(on)
    const { id } = await recover($, w)
    expect(w.plays).toEqual([{ asset: 'fx/kachi-1.wav', gain: 0.35 }])
    const mid = await band($, 'terminal')
    expect(mid.hasRaster).toBe(true)
    await w.clock.advance(16 * 30)
    expect(await stampOf($)).toEqual(['✔ pnpm test  緑'])
    expect(await result($, id)).toEqual(['engine result', '✔ 赤→緑  2 回目で · 30s 赤だった · 3 → 0 failing'])
  })

  test('a first pass with no failure before it and no edit draws nothing and plays nothing', async ($, on) => {
    const w = world(on)
    const { id } = await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await stampOf($)).toEqual([])
    expect(await result($, id)).toEqual(['engine result'])
  })

  test('the first green of a check after code edits ticks once: a stamp and the soft clip, no sweep and no receipt', { options: { minTier: 'tick' } }, async ($, on) => {
    const w = world(on)
    await edit($)
    const { id } = await bash($, w, 'tsc --noEmit')
    await w.clock.settle()
    expect(w.plays).toEqual([{ asset: 'fx/kachi-0.wav', gain: 0.2 }])
    expect((await band($, 'terminal')).hasRaster).toBe(false)
    expect(await stampOf($)).toEqual(['✔ tsc  緑 · 編集後はじめて'])
    expect(await result($, id)).toEqual(['engine result'])
    // The same check passing again is no first green.
    await prompt($)
    await w.clock.advance(MIN)
    await edit($)
    await bash($, w, 'tsc --noEmit')
    await w.clock.settle()
    expect(w.plays).toHaveLength(1)
    expect(await stampOf($)).toEqual([])
  })

  test('a first green after editing only test files, or with no tests run, is no tick', { options: { minTier: 'tick' } }, async ($, on) => {
    const w = world(on)
    await edit($, '/repo/src/price.test.ts')
    await bash($, w, 'pnpm test')
    pass(w, 'No tests found, exiting with code 0')
    await edit($, '/repo/src/price.ts')
    await bash($, w, 'pnpm test:unit')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await stampOf($)).toEqual([])
  })

  test('a re-run that passes with no edit since the failure is not a win', async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'pnpm test')
    await edit($)
    await bash($, w, 'pnpm test')
    pass(w)
    const { id } = await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await result($, id)).toEqual(['engine result'])
  })

  test('a pass after editing only test files is not a win', async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'pnpm test')
    await edit($, '/repo/src/price.test.ts')
    await edit($, '/repo/tests/helpers.ts')
    await edit($, '/repo/src/__snapshots__/price.ts.snap')
    pass(w)
    const { id } = await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await result($, id)).toEqual(['engine result'])
  })

  test('Swift and Xcode test files are test files: an edit only there is no win, one in Sources is', async ($, on) => {
    const w = world(on)
    for (const command of ['swift test', 'xcodebuild test -scheme App']) {
      fail(w, 'Test Suite \'All tests\' failed.\n Executed 12 tests, with 2 failures')
      await bash($, w, command)
      for (const path of ['/repo/Tests/AppTests/PriceTests.swift', '/repo/AppTests/CartTests.swift', '/repo/AppUITests/FlowTests.swift', '/repo/App/PriceSpec.swift']) await edit($, path)
      pass(w, 'Executed 12 tests, with 0 failures')
      const unearned = await bash($, w, command)
      expect(await result($, unearned.id), command).toEqual(['engine result'])
      fail(w, 'Executed 12 tests, with 1 failure')
      await bash($, w, command)
      await edit($, '/repo/Sources/App/Price.swift')
      pass(w, 'Executed 12 tests, with 0 failures')
      const won = await bash($, w, command)
      expect((await result($, won.id))[1], command).toMatch(/^✔ 赤→緑  2 回目で/)
      await prompt($)
    }
    for (const path of ['/r/src/test/java/a/PriceTest.java', '/r/app/src/PriceTest.kt', '/r/spec/price_spec.rb', '/r/Tests/x.swift', '/r/Specs/A.swift', '/r/AppTests/Helpers/Fixture.swift', '/r/KachiUITests/Support/Launch.swift'])
      expect(isTestPath(path, undefined), path).toBe(true)
    for (const path of ['/r/Sources/App/Price.swift', '/r/src/Contest.ts', '/r/src/Attestation.swift', '/r/latest/x.ts'])
      expect(isTestPath(path, undefined), path).toBe(false)
  })

  test('testPaths adds globs that count as test files', { options: { testPaths: 'e2e/**, *.fixture.ts' } }, async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'pnpm test')
    await edit($, '/repo/e2e/flows/cart.ts')
    await edit($, '/repo/src/price.fixture.ts')
    pass(w)
    await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays).toEqual([])
  })

  test('a narrower command passing after a broad failure waits for the broad one', async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'pnpm test')
    await edit($)
    pass(w)
    const narrow = await bash($, w, 'pnpm test src/price.test.ts')
    const filtered = await bash($, w, 'pnpm test -- -t "rounds half up"')
    const lastFailed = await bash($, w, 'pytest --lf')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await result($, narrow.id)).toEqual(['engine result'])
    expect(await result($, filtered.id)).toEqual(['engine result'])
    expect(await result($, lastFailed.id)).toEqual(['engine result'])
    const broad = await bash($, w, 'pnpm test --run')
    await w.clock.settle()
    expect(w.plays).toHaveLength(1)
    expect((await result($, broad.id))[1]).toMatch(/^✔ 赤→緑  2 回目で/)
  })

  test('a narrow failure is won back by the same scope or a broader one', async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'cargo test parser')
    await edit($, '/repo/src/parser.rs')
    pass(w, 'test result: ok. 12 passed; 0 failed\n\nrunning 0 tests\ntest result: ok. 0 passed; 0 failed')
    await bash($, w, 'cargo test')
    await w.clock.settle()
    expect(w.plays).toEqual([{ asset: 'fx/kachi-1.wav', gain: 0.35 }])
  })

  test('a zero-test pass is never a win', async ($, on) => {
    const w = world(on)
    for (const [command, stdout] of [
      ['pnpm test', 'Tests: 0 passed, 0 total'],
      ['pytest', 'collected 0 items\n\nno tests ran in 0.01s'],
      ['npx jest --passWithNoTests', 'No tests found, exiting with code 0'],
    ] as const) {
      fail(w)
      await bash($, w, command)
      await edit($)
      pass(w, stdout)
      await bash($, w, command)
    }
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await stampOf($)).toEqual([])
  })

  test('command not found, a missing script, sandbox denial and exit 126/127 are never counted as red', async ($, on) => {
    const w = world(on)
    await bash($, w, 'pnpm test')
    for (const [out, exit] of [
      ['sh: vitest: command not found', 127],
      ['permission denied: ./run-tests', 126],
      ['sh: jest: command not found', 1],
      ['sh: ./node_modules/.bin/vitest: Operation not permitted', 1],
      ['ERR_PNPM_NO_SCRIPT  Missing script: test', 1],
    ] as const) {
      fail(w, out, exit)
      await bash($, w, 'pnpm test')
    }
    await edit($)
    pass(w)
    const { id } = await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await result($, id)).toEqual(['engine result'])
  })

  test('interrupted, backgrounded, timed-out and denied runs neither fail nor win', async ($, on) => {
    const w = world(on)
    await bash($, w, 'pnpm test')
    for (const answer of [
      { isError: true, result: undefined, text: '[Request interrupted by user for tool use]' },
      { result: { stdout: '', stderr: '', interrupted: true }, text: '' },
      { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: '' },
      { result: { stdout: '', stderr: '', interrupted: false, timedOutAfterMs: 120_000 }, text: '' },
      { deny: 'not allowed' },
    ]) {
      w.next = { kind: 'raw', answer }
      await bash($, w, 'pnpm test')
    }
    await $.tool.call({ tool: 'Bash', command: 'pnpm test', run_in_background: true })
    await edit($)
    pass(w)
    const { id } = await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await result($, id)).toEqual(['engine result'])
  })

  test('the tier grows with failed runs and minutes spent red', async ($, on) => {
    const w = world(on)
    // Three failed runs: a chime.
    fail(w)
    for (let k = 0; k < 3; k++) await bash($, w, 'pnpm lint')
    await edit($)
    pass(w, '')
    await bash($, w, 'pnpm lint')
    await w.clock.settle()
    await prompt($)
    await w.clock.advance(MIN)
    // Six minutes red on one failure: a chime.
    await recover($, w, 'tsc', 6 * MIN, 'Found 2 errors in 1 file.')
    await prompt($)
    await w.clock.advance(MIN)
    // Eight failed runs: the bell.
    fail(w)
    for (let k = 0; k < 8; k++) await bash($, w, 'cargo clippy')
    await edit($, '/repo/src/lib.rs')
    pass(w, '')
    await bash($, w, 'cargo clippy')
    await w.clock.settle()
    await prompt($)
    await w.clock.advance(MIN)
    // Twenty minutes red: the bell.
    const { id } = await recover($, w, 'go test ./...', 21 * MIN, 'FAIL')
    expect(w.plays.map(one => one.asset)).toEqual(['fx/kachi-2.wav', 'fx/kachi-2.wav', 'fx/kachi-3.wav', 'fx/kachi-3.wav'])
    expect(w.plays.at(-1)?.gain).toBe(0.45)
    expect((await result($, id))[1]).toBe('✔ 赤→緑  2 回目で · 21m00s 赤だった')
  })

  test('a parsed failure count of 10 or more down to 0 rings the bell', async ($, on) => {
    const w = world(on)
    const { id } = await recover($, w, 'pnpm test', 10_000, 'Tests: 12 failed, 30 passed, 42 total')
    expect(w.plays.map(one => one.asset)).toEqual(['fx/kachi-3.wav'])
    expect((await result($, id))[1]).toBe('✔ 赤→緑  2 回目で · 10s 赤だった · 12 → 0 failing')
  })

  test('two wins in one turn play once and keep the higher tier\'s stamp', async ($, on) => {
    const w = world(on)
    await recover($, w, 'pnpm test')
    // A chime 10 s later: the stamp moves up, the clip waits out its 20 s.
    fail(w)
    for (let k = 0; k < 3; k++) await bash($, w, 'pnpm lint')
    await edit($)
    pass(w, '')
    await bash($, w, 'pnpm lint')
    await w.clock.advance(2_000)
    expect(w.plays).toHaveLength(1)
    expect(await stampOf($)).toEqual(['✔ pnpm lint  緑'])
    // A click after 30 s more: lower than the stamp, so nothing changes and nothing plays.
    await w.clock.advance(30_000)
    await recover($, w, 'tsc', 1_000)
    expect(w.plays).toHaveLength(1)
    expect(await stampOf($)).toEqual(['✔ pnpm lint  緑'])
  })

  test('a second win within 20 s of a clip plays no clip, even in a new turn', async ($, on) => {
    const w = world(on)
    await recover($, w, 'pnpm test', 1_000)
    await prompt($)
    await w.clock.advance(5_000)
    await recover($, w, 'tsc', 1_000)
    await w.clock.advance(1_000)
    expect(w.plays).toHaveLength(1)
    expect(await stampOf($)).toEqual(['✔ tsc  緑'])
    await prompt($)
    await w.clock.advance(25_000)
    await recover($, w, 'pnpm lint', 1_000)
    expect(w.plays).toHaveLength(2)
  })

  test('a failure after a win resets the check to red for the next win', async ($, on) => {
    const w = world(on)
    await recover($, w)
    await prompt($)
    await w.clock.advance(MIN)
    const { id } = await recover($, w, 'pnpm test', 90_000, '1 failed, 43 passed')
    expect(w.plays).toHaveLength(2)
    expect((await result($, id))[1]).toBe('✔ 赤→緑  2 回目で · 1m30s 赤だった · 1 → 0 failing')
  })

  test('a check is kept per directory: web red is won back only in web, through cd or bash -c alike', async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'cd web && pnpm test')
    await edit($, '/repo/web/src/price.ts')
    pass(w)
    const api = await bash($, w, 'cd api && pnpm test')
    const root = await bash($, w, 'pnpm test')
    const unknown = await bash($, w, 'cd "$APP_DIR" && pnpm test')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    for (const one of [api, root, unknown]) expect(await result($, one.id)).toEqual(['engine result'])
    const web = await bash($, w, `cd /repo/web && bash -c 'pnpm test'`)
    await w.clock.advance(1_000)
    expect(w.plays).toHaveLength(1)
    expect((await result($, web.id))[1]).toMatch(/^✔ 赤→緑  2 回目で/)
    // The green comes before the directory, so a cut at the end keeps it.
    expect(await stampOf($)).toEqual(['✔ pnpm test  緑 (web)'])
    expect((await band($, 'terminal', 30)).texts[0]).toBe('✔ 緑 pnpm test (web)')
    // The band is matched by the check's key: the root's pnpm test failing leaves web's stamp up.
    fail(w)
    await bash($, w, 'pnpm test')
    expect(await stampOf($)).toEqual(['✔ pnpm test  緑 (web)'])
    await bash($, w, 'cd web && pnpm test')
    expect(await stampOf($)).toEqual([])
  })

  test('an edit is credited only to the checks whose directory holds it, or to all when it is outside every one', async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'cd api && pnpm test')
    await bash($, w, 'cd web && pnpm test')
    await edit($, '/repo/web/src/a.ts')
    pass(w)
    const api = await bash($, w, 'cd api && pnpm test')
    const web = await bash($, w, 'cd web && pnpm test')
    expect(await result($, api.id)).toEqual(['engine result'])
    expect((await result($, web.id))[1]).toMatch(/^✔ 赤→緑/)
    await prompt($)
    // Outside both directories (a shared library): it may fix either.
    fail(w)
    await bash($, w, 'cd api && pnpm test')
    await edit($, '/repo/lib/round.ts')
    pass(w)
    const shared = await bash($, w, 'cd api && pnpm test')
    expect((await result($, shared.id))[1]).toMatch(/^✔ 赤→緑/)
  })
})

describe('piped checks and other spellings', () => {
  // Shaped like real work: most checks are piped, so `| tail` exits 0 whatever the tests did.
  test('a piped check is read from its output: piped fail, a src edit, piped pass plays the click', async ($, on) => {
    const w = world(on)
    pass(w, ' FAIL  src/price.test.ts > rounds half up\n Test Files  1 failed | 6 passed (7)\n      Tests  3 failed | 41 passed (44)\n')
    const failed = await bash($, w, 'pnpm test 2>&1 | tail -20')
    await w.clock.advance(40_000)
    await edit($)
    pass(w, ' Test Files  7 passed (7)\n      Tests  44 passed (44)\n')
    const won = await bash($, w, 'pnpm test 2>&1 | tail -20')
    await w.clock.settle()
    expect(w.plays).toEqual([{ asset: 'fx/kachi-1.wav', gain: 0.35 }])
    expect(await result($, failed.id)).toEqual(['engine result', '◌ kachi: pnpm test が赤。本当の修正で鳴ります'])
    expect(await result($, won.id)).toEqual(['engine result', '✔ 赤→緑  2 回目で · 40s 赤だった · 3 → 0 failing'])
  })

  test('piped, grepped, `|| true` and `; echo` checks, `claude plugin test`, `pnpm exec` and `pnpm vitest run` all earn their green', async ($, on) => {
    const w = world(on)
    const cases: [string, string, string][] = [
      ['pytest -q 2>&1 | grep -E "passed|failed"', '2 failed, 30 passed in 1.2s', '32 passed in 1.1s'],
      ['cargo test || true', 'test result: FAILED. 11 passed; 1 failed', 'test result: ok. 12 passed; 0 failed'],
      ['go test ./... ; echo exit=$?', '--- FAIL: TestRound (0.00s)\nFAIL\texample/price\t0.1s\nexit=1', 'ok  \texample/price\t0.2s\nok  \texample/tax\t(cached)\nexit=0'],
      ['claude plugin test mods/kachi 2>&1 | tail -5', ' 41 pass\n 1 fail\nRan 42 tests across 1 file.', ' 42 pass\n 0 fail\nRan 42 tests across 1 file.'],
      ['cd web && pnpm vitest run src/price.test.ts 2>&1 | tail', 'Tests  1 failed | 3 passed (4)', 'Tests  4 passed (4)'],
    ]
    for (const [command, red, green] of cases) {
      pass(w, red)
      await bash($, w, command)
      await edit($, command.startsWith('cd web') ? '/repo/web/src/price.ts' : '/repo/src/price.ts')
      pass(w, green)
      const { id } = await bash($, w, command)
      expect((await result($, id))[1], command).toMatch(/^✔ 赤→緑  2 回目で/)
      await prompt($)
    }
    // Unpiped through the package manager: its exit status is the check's.
    fail(w, 'Found 2 errors in 1 file.', 2)
    await bash($, w, 'pnpm exec tsc --noEmit')
    await edit($)
    pass(w, '')
    const { id } = await bash($, w, 'pnpm exec tsc --noEmit')
    expect((await result($, id))[1]).toBe('✔ 赤→緑  2 回目で · 0s 赤だった · 2 → 0 failing')
  })

  test('piped compiler failures are red: cargo, swift and make, with the error count where it is printed', async ($, on) => {
    const w = world(on)
    const cases: [string, string, string, RegExp][] = [
      ['cargo build 2>&1 | tail -5', 'error[E0308]: mismatched types\n --> src/lib.rs:3:5\nerror: could not compile `price` (lib) due to 2 previous errors', '    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.2s', / · 2 → 0 failing$/],
      ['cargo test 2>&1 | tail -5', 'error[E0425]: cannot find value `x` in this scope\nerror: could not compile `price` (lib test) due to 1 previous error', 'test result: ok. 12 passed; 0 failed; 0 ignored', / · 1 → 0 failing$/],
      ['swift build 2>&1 | tail -5', "/repo/Sources/App/Price.swift:3:5: error: cannot find 'round' in scope", 'Build complete! (2.31s)', /赤だった$/],
      ['make build 2>&1 | tail -3', 'cc -c price.c\nprice.c:3:5: error: use of undeclared identifier\nmake: *** [build] Error 1', '', /赤だった$/],
    ]
    for (const [command, red, green, ends] of cases) {
      pass(w, red)
      const failed = await bash($, w, command)
      expect((await result($, failed.id))[1], command).toMatch(/^◌ kachi: /)
      await edit($)
      pass(w, green)
      const won = await bash($, w, command.startsWith('make') ? 'make build' : command)
      const line = (await result($, won.id))[1]
      expect(line, command).toMatch(/^✔ 赤→緑  2 回目で/)
      expect(line, command).toMatch(ends)
      await prompt($)
    }
  })

  test('a piped script that prints only its header is green when the header names quiet programs, else no reading', async ($, on) => {
    const w = world(on)
    fail(w, 'src/price.ts(3,7): error TS2322\nFound 2 errors in 1 file.')
    await bash($, w, 'pnpm typecheck')
    await edit($)
    pass(w, '\n> app@1.0.0 typecheck /repo\n> tsc --noEmit && eslint src\n\n')
    const quiet = await bash($, w, 'pnpm typecheck 2>&1 | tail -5')
    expect((await result($, quiet.id))[1]).toMatch(/^✔ 赤→緑  2 回目で/)
    await prompt($)
    fail(w)
    await bash($, w, 'pnpm test')
    await edit($)
    pass(w, '\n> app@1.0.0 test /repo\n> vitest run\n\n')
    const header = await bash($, w, 'pnpm test 2>&1 | tail -5')
    expect(await result($, header.id)).toEqual(['engine result'])
  })

  test('a piped run whose output says nothing, or two checks in one output, is no reading', { options: { minTier: 'tick' } }, async ($, on) => {
    const w = world(on)
    pass(w, 'Tests  44 passed (44)')
    const two = await bash($, w, 'pnpm lint; pnpm test | tail -5')
    pass(w, '> app@1.0.0 test\n> vitest run\n')
    const header = await bash($, w, 'pnpm test 2>&1 | head -2')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    for (const one of [two, header]) expect(await result($, one.id)).toEqual(['engine result'])
    // A piped narrower pass waits for the broad check, as an unpiped one does.
    fail(w)
    await bash($, w, 'pnpm test')
    await edit($)
    pass(w, 'Tests  3 passed (3)')
    await bash($, w, 'pnpm test src/price.test.ts | tail')
    pass(w, 'Tests  0 passed (0)')
    await bash($, w, 'pnpm test | tail')
    await w.clock.settle()
    expect(w.plays).toEqual([])
  })

  test('a piped run that says nothing clears a stale red without a win, so a much later pass rings no false bell', async ($, on) => {
    const w = world(on)
    fail(w, 'Tests  12 failed | 30 passed')
    await bash($, w, 'pnpm test')
    await w.clock.advance(21 * MIN)
    pass(w, '> app@1.0.0 test\n> vitest run\n')
    const unread = await bash($, w, 'pnpm test 2>&1 | head -2')
    await edit($)
    pass(w)
    const later = await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await result($, unread.id)).toEqual(['engine result'])
    expect(await result($, later.id)).toEqual(['engine result'])
  })

  test('piped checks that print nothing or one closing line on success read green: tsc, eslint, cargo build, swift build', async ($, on) => {
    const w = world(on)
    const cases: [string, string, string, string][] = [
      ['tsc --noEmit 2>&1 | head -30', 'src/price.ts(3,7): error TS2322: Type string is not assignable.\nFound 1 error in src/price.ts:3', '', 'tsc'],
      ['npx eslint src 2>&1 | tail -20', '/repo/src/price.ts\n  3:7  error  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)', '', 'eslint'],
      ['cargo build 2>&1 | tail -3', 'error[E0308]: mismatched types\nerror: could not compile `price` (lib) due to 1 previous error', '   Compiling price v0.1.0\n    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.2s', 'cargo build'],
      ['swift build 2>&1 | tail -3', "error: cannot find 'round' in scope\nerror: fatalError", 'Building for debugging...\nBuild complete! (2.31s)', 'swift build'],
    ]
    for (const [command, red, green, key] of cases) {
      fail(w, red)
      await bash($, w, command.replace(/ 2>&1.*$/, ''))
      await edit($)
      pass(w, green)
      const { id } = await bash($, w, command)
      expect((await result($, id))[1], key).toMatch(/^✔ 赤→緑  2 回目で/)
      await prompt($)
    }
  })

  test('a piped pass whose output names FAIL or FAILED in a test name or a log line is green, not red', async ($, on) => {
    const w = world(on)
    const named = ' ✓ handles FAILED payments (3 ms)\n ✓ FAIL-safe rounding\nlog: upstream FAILED, retrying\n Tests  44 passed (44)'
    pass(w, named)
    await bash($, w, 'pnpm test 2>&1 | tail -20')
    await edit($)
    const second = await bash($, w, 'pnpm test 2>&1 | tail -20')
    // A FAIL inside a line, with no count, is no reading: no red to win back later.
    pass(w, 'worker: job FAIL, requeued\nall done')
    await bash($, w, 'pytest 2>&1 | tail -3')
    await edit($)
    pass(w, '32 passed in 1.1s')
    const after = await bash($, w, 'pytest 2>&1 | tail -3')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await result($, second.id)).toEqual(['engine result'])
    expect(await result($, after.id)).toEqual(['engine result'])
    // A runner's FAIL line, at a line's start and with no count, is still red.
    pass(w, ' FAIL  src/price.test.ts > rounds half up\n  AssertionError: expected 1 to be 2')
    await bash($, w, 'pnpm vitest run 2>&1 | tail -5')
    await edit($)
    pass(w, ' Tests  4 passed (4)')
    const won = await bash($, w, 'pnpm vitest run 2>&1 | tail -5')
    expect((await result($, won.id))[1]).toMatch(/^✔ 赤→緑  2 回目で/)
  })

  test('a real failure that mentions ENOENT or permission denied is red: the fix clicks', async ($, on) => {
    const w = world(on)
    for (const [command, out] of [
      ['pnpm test', " FAIL  src/load.test.ts\n  Error: ENOENT: no such file or directory, open 'fixtures/a.json'\n Tests  1 failed | 9 passed (10)"],
      ['pytest', "E   AssertionError: assert 'permission denied' == 'ok'\nFAILED tests/test_auth.py::test_login - AssertionError"],
      ['go test ./...', '--- FAIL: TestOpen (0.00s)\n    open_test.go:9: open x: no such file or directory\nFAIL\texample/open\t0.1s'],
      // The shell's own not-run words, printed by a test that spawns a tool: the counts say it ran.
      ['pnpm test:cli', ' FAIL  src/gen.test.ts\nsh: ./bin/gen: No such file or directory\n Tests  1 failed | 9 passed (10)'],
    ] as const) {
      fail(w, out)
      await bash($, w, command)
      await edit($)
      pass(w, command === 'go test ./...' ? 'ok  \texample/open\t0.1s' : PASS)
      const { id } = await bash($, w, command)
      expect((await result($, id))[1], command).toMatch(/^✔ 赤→緑  2 回目で/)
      await prompt($)
    }
  })

  test('a long failure cut short for the model is counted from the stored output or the persisted file; with neither, the receipt names no count', async ($, on) => {
    const w = world(on)
    // 120 KB of failing output: the model reads its first 30 KB, the summary is at the end.
    const long = `${' FAIL  src/x.test.ts > case\n'.repeat(4_300)}\n Tests  12 failed | 30 passed (42)`
    const text = `Exit code 1\n${long.slice(0, 30_000)}`
    w.next = { kind: 'raw', answer: { isError: true, result: `Exit code 1\n${long}`, text } }
    await bash($, w, 'pnpm test')
    await edit($)
    pass(w)
    const stored = await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays.map(one => one.asset)).toEqual(['fx/kachi-3.wav'])
    expect((await result($, stored.id))[1]).toBe('✔ 赤→緑  2 回目で · 0s 赤だった · 12 → 0 failing')
    await prompt($)
    await w.clock.advance(MIN)
    // A piped run too large to inline: its preview has no summary, the persisted file has.
    w.files['/tool-results/b1.txt'] = `${long.slice(0, 60_000)}\n Tests  3 failed | 39 passed (42)`
    pass(w, long.slice(0, 2_000), { persistedOutputPath: '/tool-results/b1.txt', persistedOutputSize: 62_000 })
    await bash($, w, 'pnpm test:unit 2>&1 | tail -400')
    await edit($)
    pass(w, ' Tests  42 passed (42)')
    const persisted = await bash($, w, 'pnpm test:unit 2>&1 | tail -400')
    expect((await result($, persisted.id))[1]).toBe('✔ 赤→緑  2 回目で · 0s 赤だった · 3 → 0 failing')
    await prompt($)
    // Only the cut text: red by its FAIL lines, and a receipt with no count rather than a wrong one.
    w.next = { kind: 'raw', answer: { isError: true, result: undefined, text } }
    await bash($, w, 'pnpm test:e2e')
    await edit($)
    pass(w)
    const cut = await bash($, w, 'pnpm test:e2e')
    expect((await result($, cut.id))[1]).toBe('✔ 赤→緑  2 回目で · 0s 赤だった')
  })

  test('a command nested past what shell.ts can read is no check: the hook passes the result on and keeps working', async ($, on) => {
    const w = world(on)
    const deep = `echo ${'"$('.repeat(20_000)}`
    // shell.ts, copied byte for byte from done-gate, overflows the stack on this shape.
    const unreadable = outcome({ command: deep, isError: true, text: 'Exit code 1\n3 failed' })
    expect(() => classify(unreadable)).toThrow(RangeError)
    // What the hook classifies with: the overflow reads as nothing, and other errors still throw.
    expect(classifyOrIgnore(unreadable)).toEqual({ kind: 'ignore' })
    fail(w)
    const { ran } = await bash($, w, deep)
    expect(ran.text).toBe(`Exit code 1\n${FAIL}`)
    await recover($, w)
    expect(w.plays).toHaveLength(1)
  })
})

describe('edits made through Bash', () => {
  test('a fix written by sed -i, a heredoc, tee, git checkout -- or prettier --write counts as the edit between red and green', async ($, on) => {
    const w = world(on)
    const fixes = [
      `sed -i '' 's/Math.floor/Math.round/' src/price.ts`,
      `cat > src/price.ts <<'EOF'\nexport const round = (n: number) => Math.round(n)\nEOF`,
      `printf 'export {}\\n' | tee src/index.ts`,
      'git checkout -- src/price.ts',
      'npx prettier --write src/price.ts',
      `cd web && perl -pi -e 's/floor/round/' src/price.ts`,
    ]
    for (const [k, fix] of fixes.entries()) {
      const command = `pnpm test:${k}`
      fail(w)
      await bash($, w, command)
      pass(w, '')
      await bash($, w, fix)
      pass(w)
      const { id } = await bash($, w, command)
      expect((await result($, id))[1], fix).toMatch(/^✔ 赤→緑  2 回目で/)
      await prompt($)
    }
  })

  test('a fix and the check in one command: an edit before the check counts for it, one after it does not', async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'pnpm test')
    pass(w)
    const after = await bash($, w, `pnpm test && sed -i 's/a/b/' src/price.ts`)
    expect(await result($, after.id)).toEqual(['engine result'])
    fail(w)
    await bash($, w, 'pnpm test')
    pass(w)
    const before = await bash($, w, `sed -i 's/floor/round/' src/price.ts && pnpm test`)
    expect((await result($, before.id))[1]).toMatch(/^✔ 赤→緑  2 回目で/)
  })

  test('a Bash write to a test file, a log, a temporary file or by an unknown script is no code edit', async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'pnpm test')
    pass(w, '')
    for (const command of [
      `sed -i 's/2/1/' src/price.test.ts`,
      'echo done > run.log',
      `cat > /tmp/notes.md <<'EOF'\nnotes\nEOF`,
      'python scripts/fix.py',
      'git stash pop',
      'git checkout main',
      'prettier --check src',
    ]) await bash($, w, command)
    // A failing write never ran to the end.
    fail(w, 'sed: src/price.ts: No such file or directory')
    await bash($, w, `sed -i 's/a/b/' src/price.ts`)
    pass(w)
    const { id } = await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    expect(await result($, id)).toEqual(['engine result'])
  })
})

describe('commits', () => {
  const COMMITTED = { stdout: '[main 4e1a9c2] Fix rounding', extra: { gitOperation: { commit: { sha: '4e1a9c2d0b7f', kind: 'committed' } } } }

  test('a clean commit ticks only when a check passed after the last edit', { options: { minTier: 'tick' } }, async ($, on) => {
    const w = world(on)
    await bash($, w, 'pnpm test')
    await edit($)
    pass(w, COMMITTED.stdout, COMMITTED.extra)
    // An edit with no check after it: no tick.
    await bash($, w, 'git commit -am "wip"')
    await w.clock.settle()
    expect(await stampOf($)).toEqual([])
    pass(w)
    await bash($, w, 'pnpm test')
    pass(w, COMMITTED.stdout, COMMITTED.extra)
    await bash($, w, 'git commit -am "Fix rounding"')
    await w.clock.settle()
    expect(w.plays).toEqual([{ asset: 'fx/kachi-0.wav', gain: 0.2 }])
    expect((await band($, 'terminal')).hasRaster).toBe(false)
    expect(await stampOf($)).toEqual(['✔ commit 4e1a9c2 · 検証済みのまま'])
  })

  test('a commit after a failing check, an amend or a dry run is silent; the sha is read from the output without gitOperation', { options: { minTier: 'tick' } }, async ($, on) => {
    const w = world(on)
    await bash($, w, 'pnpm test')
    await edit($)
    fail(w)
    await bash($, w, 'pnpm test')
    pass(w, '[main 1111111] wip')
    await bash($, w, 'git commit -am wip')
    pass(w, '[main 2222222] wip', { gitOperation: { commit: { sha: '2222222', kind: 'amended' } } })
    await bash($, w, 'git commit --amend --no-edit')
    await w.clock.settle()
    expect(await stampOf($)).toEqual([])
    await edit($)
    pass(w)
    await bash($, w, 'pnpm test')
    pass(w, '')
    await bash($, w, 'git commit --dry-run')
    await w.clock.advance(1_000)
    expect(await stampOf($)).toEqual(['✔ pnpm test  緑'])
    await prompt($)
    pass(w, '[main 3333333] Fix')
    await bash($, w, 'git -C . commit -m Fix')
    await w.clock.settle()
    expect(await stampOf($)).toEqual(['✔ commit 3333333 · 検証済みのまま'])
  })

  test('a commit within ten minutes of the last tick is silent', { options: { minTier: 'tick' } }, async ($, on) => {
    const w = world(on)
    for (const at of [0, 4 * MIN, 11 * MIN]) {
      await w.clock.set(1_000_000 + at)
      await prompt($)
      await edit($)
      pass(w)
      await bash($, w, 'pnpm test')
      pass(w, '[main 4e1a9c2] step')
      await bash($, w, 'git commit -am step')
    }
    await w.clock.settle()
    // The first green ticks at 0; commits tick at 0 (upgrading nothing: same tier) and 11 min, not at 4.
    expect(w.plays.map(one => one.asset)).toEqual(['fx/kachi-0.wav', 'fx/kachi-0.wav'])
    expect(await stampOf($)).toEqual(['✔ commit 4e1a9c2 · 検証済みのまま'])
  })

  test('commits off: no commit earns a tick', { options: { commits: false, minTier: 'tick' } }, async ($, on) => {
    const w = world(on)
    await bash($, w, 'pnpm test')
    await edit($)
    fail(w)
    await bash($, w, 'pnpm test')
    pass(w)
    await bash($, w, 'pnpm test')
    await prompt($)
    pass(w, '[main 4e1a9c2] Fix')
    await bash($, w, 'git commit -am Fix')
    await w.clock.settle()
    expect(await stampOf($)).toEqual([])
  })
})

describe('the band and the receipt', () => {
  test('the stamp leaves on the next prompt, or 60 s after the turn ends', async ($, on) => {
    const w = world(on)
    await recover($, w)
    await w.clock.advance(1_000)
    expect(await stampOf($)).toEqual(['✔ pnpm test  緑'])
    await prompt($)
    expect(await stampOf($)).toEqual([])

    await w.clock.advance(MIN)
    await recover($, w, 'tsc')
    await endTurn($)
    await w.clock.advance(59_000)
    expect(await stampOf($)).toEqual(['✔ tsc  緑'])
    await w.clock.advance(2_000)
    expect(await stampOf($)).toEqual([])
  })

  test('the sweep timer stops after its last frame and no timer outlives an idle turn', { plugins: [TIMER_COUNT] }, async ($, on) => {
    const w = world(on)
    await recover($, w)
    expect((await band($, 'terminal')).hasRaster).toBe(true)
    await w.clock.advance(15 * 30)
    expect(w.blits).toBe(15)
    await w.clock.advance(30)
    expect((await band($, 'terminal')).hasRaster).toBe(false)
    await w.clock.advance(10_000)
    expect(w.blits).toBe(15)
    const periods = timers.every
    await w.clock.advance(10_000)
    expect(timers.every).toBe(periods)
    await prompt($)
    const afters = timers.after
    await endTurn($)
    await w.clock.advance(MIN)
    expect(timers.after).toBe(afters)
    expect(timers.every).toBe(periods)
  })

  test('the receipt line stays under the winning Bash row and no other row', async ($, on) => {
    const w = world(on)
    fail(w)
    const failed = await bash($, w, 'pnpm test')
    await edit($)
    pass(w)
    const won = await bash($, w, 'pnpm test')
    const again = await bash($, w, 'pnpm test')
    await prompt($)
    expect(await result($, failed.id)).toEqual(['engine result', '◌ kachi: pnpm test が赤。本当の修正で鳴ります'])
    expect((await result($, won.id))[1]).toMatch(/^✔ 赤→緑/)
    expect(await result($, again.id)).toEqual(['engine result'])
  })

  test('one win draws one record: the stamp never repeats what the receipt says', async ($, on) => {
    const w = world(on)
    const { id } = await recover($, w, 'pnpm test', 161_000)
    await w.clock.advance(1_000)
    const [stamp] = await stampOf($)
    const [, receipt] = await result($, id)
    expect(receipt).toContain('2m41s')
    expect(stamp).not.toMatch(/回目|赤だった|failing|2m41s/)
  })

  test('a check\'s first red of the session draws one dim line under its row, once per check', async ($, on) => {
    const w = world(on)
    fail(w)
    const first = await bash($, w, 'pnpm test')
    const second = await bash($, w, 'pnpm test')
    const tsc = await bash($, w, 'tsc')
    expect(await result($, first.id)).toEqual(['engine result', '◌ kachi: pnpm test が赤。本当の修正で鳴ります'])
    expect(await result($, second.id)).toEqual(['engine result'])
    expect(await result($, tsc.id)).toEqual(['engine result', '◌ kachi: tsc が赤。本当の修正で鳴ります'])
    // Won back, then red again: no second line for the same check.
    await edit($)
    pass(w)
    await bash($, w, 'pnpm test')
    fail(w)
    const again = await bash($, w, 'pnpm test')
    expect(await result($, again.id)).toEqual(['engine result'])
    // The line itself draws nothing on the band and plays nothing: the one clip is the win's.
    await w.clock.settle()
    await prompt($)
    expect(await stampOf($)).toEqual([])
    expect(w.plays).toHaveLength(1)
  })

  test('the first red\'s line follows the locale and names the directory', async ($, on) => {
    const w = world(on, { LANG: 'en_US.UTF-8' })
    fail(w)
    const { id } = await bash($, w, 'cd web && pnpm test')
    expect((await result($, id))[1]).toBe('◌ kachi: pnpm test (web) is red; a real fix rings')
  })

  test('a failure after a win takes the stamp down; another check failing leaves it', async ($, on) => {
    const w = world(on)
    await recover($, w)
    await w.clock.advance(1_000)
    fail(w)
    await bash($, w, 'tsc')
    expect(await stampOf($)).toEqual(['✔ pnpm test  緑'])
    pass(w, 'Tests  2 failed | 42 passed')
    await bash($, w, 'pnpm test | tail')
    expect(await stampOf($)).toEqual([])
    // Mid-sweep too: the motion stops with it.
    await w.clock.advance(MIN)
    await recover($, w, 'cargo test')
    fail(w)
    await bash($, w, 'cargo test')
    expect(await band($, 'terminal')).toEqual({ texts: ['engine'], hasRaster: false })
  })

  test('a commit stamp leaves when any check fails after it', { options: { minTier: 'tick' } }, async ($, on) => {
    const w = world(on)
    await bash($, w, 'pnpm test')
    await edit($)
    await bash($, w, 'pnpm test')
    await prompt($)
    pass(w, '[main 4e1a9c2] Fix')
    await bash($, w, 'git commit -am Fix')
    expect(await stampOf($)).toEqual(['✔ commit 4e1a9c2 · 検証済みのまま'])
    fail(w)
    await bash($, w, 'pnpm lint')
    expect(await stampOf($)).toEqual([])
  })

  test('under the defaults a session with nothing fixed draws nothing and plays nothing', async ($, on) => {
    const w = world(on)
    const ids: string[] = []
    await edit($)
    for (const command of ['tsc --noEmit', 'pnpm lint', 'pnpm test', 'pnpm build']) ids.push((await bash($, w, command)).id)
    pass(w, '[main 4e1a9c2] Add rounding')
    ids.push((await bash($, w, 'git commit -am "Add rounding"')).id)
    await endTurn($)
    await w.clock.advance(MIN)
    expect(w.plays).toEqual([])
    expect(w.blits).toBe(0)
    for (const surface of SURFACES) expect((await band($, surface)).texts).toEqual(['engine'])
    for (const id of ids) expect(await result($, id)).toEqual(['engine result'])
  })

  test('no prompt, reply, file or tool-output text reaches the session state: only capped command words', async ($, on) => {
    const written: { key: string; value: string }[] = []
    on('state.set', ($, e, next) => {
      if (e.plugin === 'kachi') written.push({ key: e.key, value: JSON.stringify(e.value) })
      return next(e)
    })
    const w = world(on)
    const CANARY = 'CANARY-7f3a91'
    await prompt($, `please fix ${CANARY}`)
    fail(w, `${CANARY}\n3 failed, 41 passed`)
    await bash($, w, 'pnpm test')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/price.ts', old_string: CANARY, new_string: `${CANARY}!` })
    pass(w, `${CANARY}\n44 passed`)
    await bash($, w, 'pnpm test')
    await endTurn($, `fixed ${CANARY}`)
    await w.clock.advance(MIN)
    expect(written.length).toBeGreaterThan(5)
    for (const one of written) expect(one.value, one.key).not.toContain(CANARY)
    // A command's words are kept only as a check's scope: 16 at most, none past 200 characters.
    fail(w)
    const words = Array.from({ length: 40 }, (_, k) => `src/f${k}.test.ts`)
    await bash($, w, `pnpm test ${'w'.repeat(5_000)} ${words.join(' ')}`)
    const last = written.filter(one => one.key === 'checks').at(-1)?.value ?? ''
    expect(last).not.toContain('w'.repeat(201))
    const record = (JSON.parse(last) as Record<string, { scope?: string[] }>)['pnpm test']
    expect(record?.scope?.length ?? 0).toBeLessThanOrEqual(16)
  })

  test('the band stacks above what lies below it and yields to a survey', async ($, on) => {
    const w = world(on)
    await recover($, w)
    for (const surface of SURFACES) {
      const { texts } = await band($, surface)
      expect(texts.at(-1)).toBe('engine')
      expect((await band($, surface, 80, true)).texts).toEqual(['engine'])
    }
  })

  test('under 40 columns the sweep is skipped and the stamp is cut short', async ($, on) => {
    const w = world(on)
    await recover($, w)
    const narrow = await band($, 'terminal', 30)
    expect(narrow.hasRaster).toBe(false)
    expect(narrow.texts).toEqual(['✔ 緑 pnpm test', 'engine'])
  })

  test('the band draws the same on terminal and desktop: a Raster sweep where there is one, the stamp in text elsewhere', async ($, on) => {
    const w = world(on)
    await recover($, w)
    const terminal = await band($, 'terminal')
    const desktop = await band($, 'desktop')
    expect(terminal.hasRaster).toBe(true)
    expect(desktop.hasRaster).toBe(false)
    expect(desktop.texts).toEqual(['✔ pnpm test  緑', 'engine'])
    await w.clock.advance(16 * 30)
    for (const surface of SURFACES) expect((await band($, surface)).texts).toEqual(['✔ pnpm test  緑', 'engine'])
  })

  test('nothing is appended to the session and nothing reaches the model', async ($, on) => {
    const session = mock.session(on)
    const w = world(on)
    fail(w)
    await bash($, w, 'pnpm test')
    await edit($)
    pass(w)
    const { ran } = await bash($, w, 'pnpm test')
    await w.clock.settle()
    expect(w.plays).toHaveLength(1)
    expect(session.appended()).toEqual([])
    expect(ran.context).toBeUndefined()
    expect(ran.text).toBe(PASS)
  })

  test('audio plays on its own dispatch: the Bash result returns before the clip is asked for', async ($, on) => {
    const w = world(on)
    fail(w)
    await bash($, w, 'pnpm test')
    await edit($)
    pass(w)
    await bash($, w, 'pnpm test')
    w.order.push('returned')
    await w.clock.settle()
    expect(w.order).toEqual(['returned', 'play'])
  })
})

describe('locale', () => {
  test('outside a ja locale the stamp and the receipt are in English', async ($, on) => {
    const w = world(on, { LANG: 'en_US.UTF-8' })
    const { id } = await recover($, w)
    await w.clock.advance(1_000)
    expect(await stampOf($)).toEqual(['✔ pnpm test  green'])
    expect(await result($, id)).toEqual(['engine result', '✔ red→green  try 2 · red for 30s · 3 → 0 failing'])
    expect((await band($, 'terminal', 30)).texts).toEqual(['✔ green pnpm test', 'engine'])
  })

  test('the language setting wins over the environment', async ($, on) => {
    const w = world(on, { LANG: 'en_US.UTF-8' }, { language: 'japanese' })
    const { id } = await recover($, w)
    expect((await result($, id))[1]).toMatch(/^✔ 赤→緑/)
  })

  test('LC_ALL wins over LANG', async ($, on) => {
    const w = world(on, { LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' })
    const { id } = await recover($, w)
    expect((await result($, id))[1]).toMatch(/^✔ 赤→緑/)
  })

  test('no locale at all reads as English', async ($, on) => {
    const w = world(on, {})
    const { id } = await recover($, w)
    expect((await result($, id))[1]).toMatch(/^✔ red→green/)
  })

  test('commit and first-green stamps follow the locale too', { options: { minTier: 'tick' } }, async ($, on) => {
    const w = world(on, { LANG: 'en_GB.UTF-8' })
    await edit($)
    await bash($, w, 'tsc')
    expect(await stampOf($)).toEqual(['✔ tsc  green · first after edits'])
    await prompt($)
    pass(w, '[main 4e1a9c2] Fix')
    await bash($, w, 'git commit -am Fix')
    expect(await stampOf($)).toEqual(['✔ commit 4e1a9c2 · still verified'])
  })
})

describe('options', () => {
  test('sound off plays nothing and still draws', { options: { sound: 'off' } }, async ($, on) => {
    const w = world(on)
    await recover($, w)
    expect(w.plays).toEqual([])
    expect((await band($, 'terminal')).hasRaster).toBe(true)
  })

  test('sound quiet halves the gain and drops the tick', { options: { sound: 'quiet', minTier: 'tick' } }, async ($, on) => {
    const w = world(on)
    await edit($)
    await bash($, w, 'tsc')
    await w.clock.settle()
    expect(w.plays).toEqual([])
    await prompt($)
    await w.clock.advance(MIN)
    await recover($, w)
    expect(w.plays).toEqual([{ asset: 'fx/kachi-1.wav', gain: 0.175 }])
  })

  test('motion none draws the static stamp only', { options: { motion: 'none' }, plugins: [TIMER_COUNT] }, async ($, on) => {
    const w = world(on)
    await recover($, w)
    const periods = timers.every
    await w.clock.advance(1_000)
    expect(timers.every).toBe(periods)
    const shown = await band($, 'terminal')
    expect(shown.hasRaster).toBe(false)
    expect(shown.texts).toEqual(['✔ pnpm test  緑', 'engine'])
    expect(w.plays).toHaveLength(1)
  })

  test('minTier chime ignores ticks and clicks entirely', { options: { minTier: 'chime' } }, async ($, on) => {
    const w = world(on)
    const { id } = await recover($, w)
    expect(w.plays).toEqual([])
    expect(await stampOf($)).toEqual([])
    expect(await result($, id)).toEqual(['engine result'])
    await w.clock.advance(MIN)
    await recover($, w, 'tsc', 6 * MIN)
    expect(w.plays.map(one => one.asset)).toEqual(['fx/kachi-2.wav'])
  })
})

// ---- cost (AC5): every hot-path hook body within 16 ms on its named worst case ---------------

const MiB = 1024 * 1024
const within = (bound: number, run: () => unknown) => {
  const started = performance.now()
  run()
  return performance.now() - started < bound
}
/**
 * How long a call through the engine takes, at best of three: a garbage-collection pause or a
 * scheduler hiccup in the test process lands on one try, while the hook's own work is in all three.
 */
async function bestOf(run: () => Promise<unknown>, tries = 3) {
  let best = Infinity
  for (let k = 0; k < tries; k++) {
    const started = performance.now()
    await run()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

const outcome = (over: Partial<BashOutcome>): BashOutcome => ({
  command: 'pnpm test',
  cwd: '/repo',
  isError: false,
  text: '',
  stdout: '',
  stderr: '',
  isInterrupted: false,
  isBackground: false,
  ...over,
})

/** `bash -c "bash -c \"…pnpm install; × 100…\""`, eight deep. */
function nestedShells(): string {
  let inner = 'pnpm install; '.repeat(100)
  for (let k = 0; k < 8; k++) inner = `bash -c "${inner.replace(/[\\"]/g, ch => `\\${ch}`)}"`
  return inner
}

function nestedCommand(): string {
  let inner = 'pnpm test'
  for (let k = 0; k < 8; k++) inner = `echo "$(${inner})"`
  const chain = 'true && '.repeat(10_000)
  const padding = `echo '${'a'.repeat(200_000 - chain.length - inner.length - 32)}' && `
  return `${padding}${chain}${inner} && pnpm test`
}

describe('cost', () => {
  const fixtures: [string, BashOutcome][] = [
    ['a 4 MiB one-line output', outcome({ stdout: `${'x'.repeat(4 * MiB)} 44 passed` })],
    ['an 8-deep 200 KB command with 10,000 &&', outcome({ command: nestedCommand(), stdout: PASS })],
    ['60,000 FAIL lines', outcome({ isError: true, text: `Exit code 1\n${'FAIL src/x.test.ts\n'.repeat(60_000)}` })],
    ['1 MiB of ANSI', outcome({ isError: true, text: `Exit code 1\n${'\x1b[31;1m\x1b[0m\x1b]8;;x\x07'.repeat(MiB / 20)}` })],
    ['a repeated count', outcome({ isError: true, text: `Exit code 1\n${'1 failed, '.repeat(50_000)}` })],
    ['a check with 50,000 file words (100 KB)', outcome({ command: `pnpm test ${'f '.repeat(50_000)}`, isError: true, text: `Exit code 1\n${FAIL}` })],
    ['a piped check over a 4 MiB output', outcome({ command: 'pnpm test 2>&1 | tail -20', stdout: `${'x'.repeat(4 * MiB)}\nTests  3 failed | 41 passed` })],
    ['100 × eval×8 true;', outcome({ command: 'eval eval eval eval eval eval eval eval true; '.repeat(100), stdout: PASS })],
    ['8-deep bash -c over 100 pnpm install;', outcome({ command: nestedShells(), stdout: PASS })],
    ['pnpm install; × 10,000', outcome({ command: 'pnpm install; '.repeat(10_000), stdout: PASS })],
    ['255 × bash -c over 55 installs', outcome({ command: Array.from({ length: 255 }, () => `bash -c "${'pnpm install; '.repeat(55)}"`).join('; '), stdout: PASS })],
    ['bash -c over 10,000 sed -i (200 KB)', outcome({ command: `bash -c "${'sed -i s/a/b/ a.ts; '.repeat(10_000)}"`, stdout: '' })],
    ['200 KB of >', outcome({ command: '> '.repeat(100_000), stdout: '' })],
    ['50 writers of 650 words each (200 KB)', outcome({ command: Array.from({ length: 50 }, (_, k) => `sed -i s/a/b/ ${`f${k}.ts `.repeat(650)}`).join('; '), stdout: '' })],
  ]

  test('the Bash hook classifies a 4 MiB one-line output, an 8-deep 200 KB command, 60,000 FAIL lines, 1 MiB of ANSI, a repeated count, 50,000 file words, a piped 4 MiB output, 100 × eval×8, 8-deep bash -c over 100 installs, 10,000 installs, 255 × bash -c over 55, bash -c over 10,000 sed -i, 200 KB of > and 50 long writers (200 KB) within 16 ms each: it runs after every Bash result', async ($, on) => {
    for (const [name, one] of fixtures) {
      // What the hook does synchronously: one scan, the verdict, and the writes from the same scan.
      const run = () => {
        const scanned = scanCommand(one.command, one.cwd)
        editsOf(one.command, scanned, -1)
        return classify(one, scanned)
      }
      run()
      expect(within(16, run), name).toBe(true)
    }
    // And through the hook itself, as a session calls it: the plugin's work after the tool answered.
    const w = world(on)
    for (const [name, one] of fixtures) {
      w.next = one.isError ? { kind: 'raw', answer: { isError: true, result: one.text, text: one.text } } : { kind: 'pass', stdout: one.stdout }
      const bare = await bestOf(() => $.tool.call({ tool: 'Bash', command: 'echo bare' }))
      const hooked = await bestOf(() => $.tool.call({ tool: 'Bash', command: one.command }))
      expect(hooked - bare, name).toBeLessThan(16)
    }
  })

  test('reading back a 4 MiB persisted output stays under 16 ms of the hook\'s own work', async ($, on) => {
    const w = world(on)
    const big = `${'x'.repeat(4 * MiB - 64)}\n Tests  3 failed | 41 passed (44)`
    const preview = outcome({ command: 'pnpm test 2>&1 | tail -400', stdout: big.slice(0, 2_000) })
    // The hook's synchronous work on the file once read: the verdict from its last 4 KiB.
    const scanned = scanCommand(preview.command, preview.cwd)
    classify({ ...preview, full: big }, scanned)
    expect(within(16, () => classify({ ...preview, full: big }, scanned))).toBe(true)
    // Through the hook, the read included (a `$` call: the host's copy is not the hook's budget), against the same call with nothing to read.
    w.files['/tool-results/big.txt'] = big
    pass(w, big.slice(0, 2_000))
    const bare = await bestOf(() => bash($, w, 'pnpm test 2>&1 | tail -400'))
    pass(w, big.slice(0, 2_000), { persistedOutputPath: '/tool-results/big.txt', persistedOutputSize: big.length })
    const read = await bestOf(() => bash($, w, 'pnpm test 2>&1 | tail -400'))
    expect(read - bare).toBeLessThan(16)
  })

  test('one command budget covers a whole line, nested text included: 40 × bash -c over 10 installs is over it', () => {
    const nested = `${Array.from({ length: 40 }, () => `bash -c "${'pnpm install; '.repeat(10)}"`).join('; ')}; pnpm test`
    expect(scanCommand(nested, CWD).isOver).toBe(true)
    expect(classify(outcome({ command: nested, isError: true, text: `Exit code 1\n${FAIL}` }))).toEqual({ kind: 'ignore' })
    // Under the budget the same shape is read.
    const small = `${Array.from({ length: 4 }, () => `bash -c "${'pnpm install; '.repeat(10)}"`).join('; ')}; pnpm test`
    expect(classify(outcome({ command: small, isError: true, text: `Exit code 1\n${FAIL}` })).kind).toBe('fail')
  })

  test('the fail-count parser sees at most 4096 characters of any output', () => {
    expect(outputTail('x'.repeat(4 * MiB)).length).toBeLessThanOrEqual(TAIL)
    expect(outputTail('x'.repeat(4 * MiB), 'y'.repeat(4 * MiB)).length).toBeLessThanOrEqual(TAIL)
    // A count past the last 4 KiB is never read; one inside it is.
    expect(parseFailCount(`99 failed\n${'x'.repeat(TAIL)}`)).toBeUndefined()
    expect(parseFailCount(`${'x'.repeat(4 * MiB)}\n3 failed`)).toBe(3)
    const failing = classify(outcome({ isError: true, text: `Exit code 1\n99 failed\n${'x'.repeat(TAIL)}` }))
    expect(failing.kind === 'fail' ? failing.failCount : 'not a failure').toBeUndefined()
  })

  test('the edit hook stays under 16 ms on a 100 KB path, and 10,000 edits leave the state the same size', { timeoutMs: 120_000 }, async ($, on) => {
    world(on)
    // Each value kachi writes for the edit count, as the kit's state store receives it.
    const written: number[] = []
    on('state.set', ($, e, next) => {
      if (e.plugin === 'kachi' && e.key === 'edits') written.push(JSON.stringify(e.value).length)
      return next(e)
    })
    const path = `/repo/${'tests/'.repeat(17_000)}a.ts`
    expect(within(16, () => isTestPath(path, undefined))).toBe(true)
    // Through the hook, against the same call on a short path: the plugin's work, not the input's trip.
    await edit($)
    const bare = await bestOf(() => edit($))
    expect((await bestOf(() => edit($, path))) - bare).toBeLessThan(16)
    for (let k = 0; k < 10_000; k++) await edit($)
    // Two counters: the value grows only by the digits of the count.
    expect(written.length).toBeGreaterThan(10_000)
    expect(Math.max(...written)).toBeLessThanOrEqual((written[1] as number) + 8)
  })

  test('testPaths globs match in one pass: \'**a**a**b,*_*_*_*.py,**/**/x\' on a 4 KiB path within 16 ms', { options: { testPaths: '**a**a**b,*_*_*_*.py,**/**/x' } }, async ($, on) => {
    world(on)
    const globs = compileGlobs('**a**a**b,*_*_*_*.py,**/**/x')
    for (const path of [`/${'a'.repeat(4096)}`, `/${'a/'.repeat(2048)}c`, `/${'_'.repeat(4096)}.p`, `/${'**/'.repeat(1365)}y`]) {
      isTestPath(path, globs)
      expect(within(16, () => isTestPath(path, globs)), path.slice(0, 12)).toBe(true)
    }
    await edit($)
    const bare = await bestOf(() => edit($))
    expect((await bestOf(() => edit($, `/${'a'.repeat(4096)}`))) - bare).toBeLessThan(16)
  })

  test('testPaths globs mean what they say', () => {
    const globs = compileGlobs('e2e/**, *.fixture.ts, src/?/x_*.py, **/**/snap')
    expect(isTestPath('/repo/e2e/flows/cart.ts', globs)).toBe(true)
    expect(isTestPath('/repo/src/price.fixture.ts', globs)).toBe(true)
    expect(isTestPath('/repo/src/a/x_round.py', globs)).toBe(true)
    expect(isTestPath('/repo/a/b/c/snap', globs)).toBe(true)
    expect(isTestPath('/repo/src/ab/x_round.py', globs)).toBe(false)
    expect(isTestPath('/repo/src/a/b/x_round.py', globs)).toBe(false)
    expect(isTestPath('/repo/src/price.ts', globs)).toBe(false)
    expect(isTestPath('/repo/notes2e2e/x.ts', globs)).toBe(false)
  })

  test('prompt.submit stays under 16 ms on a 1 MiB prompt, and turn.complete under 16 ms across 1,000 turns with no win, making no timer', { plugins: [TIMER_COUNT] }, async ($, on) => {
    const w = world(on)
    await recover($, w)
    const text = 'p'.repeat(MiB)
    expect(await bestOf(() => prompt($, text))).toBeLessThan(16)
    const afters = timers.after
    let slowest = 0
    for (let k = 0; k < 1_000; k++) slowest = Math.max(slowest, await bestOf(() => endTurn($)))
    expect(slowest).toBeLessThan(16)
    expect(timers.after).toBe(afters)
  })

  test('the band draws under 16 ms at 512 columns mid-sweep and under 1 ms on average across 200 idle redraws', async ($, on) => {
    const w = world(on)
    const render = (bodyColumns: number) =>
      $.ui.render({ surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: bandProps(bodyColumns) })
    await render(512)
    const started = performance.now()
    for (let k = 0; k < 200; k++) await render(512)
    expect((performance.now() - started) / 200).toBeLessThan(1)
    await recover($, w, 'pnpm test', 10_000, 'Tests: 12 failed')
    await w.clock.advance(10 * 30)
    expect(await bestOf(() => render(512))).toBeLessThan(16)
  })

  test('the ToolResult hook stays under 16 ms across 2,000 rows with 64 wins stored', { timeoutMs: 120_000 }, async ($, on) => {
    const w = world(on)
    const won: string[] = []
    for (let k = 0; k < 64; k++) {
      won.push((await recover($, w, 'pnpm test', 1_000)).id)
      await prompt($)
    }
    let slowest = 0
    for (let k = 0; k < 2_000; k++) {
      const id = k % 2 === 0 ? (won[k % 64] as string) : `toolu_other_${k}`
      const took = await bestOf(() =>
        $.ui.render({ surface: 'terminal', component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool: 'Bash', output: {}, isErrored: false } }),
      )
      slowest = Math.max(slowest, took)
    }
    expect(slowest).toBeLessThan(16)
    expect(await result($, won[63] as string)).toHaveLength(2)
  })

  test('a sweep frame at 512 columns is built within 4 ms', () => {
    for (const tier of [2, 3, 4] as const) {
      for (let frame = 0; frame < 36; frame++) expect(within(4, () => sweepFrame(512, tier, frame)), `tier ${tier} frame ${frame}`).toBe(true)
    }
    // Every cell is a width-1 glyph and a packed colour: 512 cells of 12 bytes.
    expect(atob(sweepFrame(512, 4, 20)).length).toBe(512 * 12)
  })
})
