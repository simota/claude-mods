import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { candidatePorts, cwdSpelledRoot, isPreviewable, judgeInfo, lineOf, previewUrl, relativeTo, tailOf, withChange } from '../hooks/docview'

const ROOT = '/w/app'
const DOC = `${ROOT}/docs/design.md`
const DOC_TEXT = '# Design\nnew section\nrest\n'
/** DOC before the edit: line 3 becomes another `new section`, below an untouched one. */
const DOC_BEFORE = '# Design\nnew section\nold\n'

describe('docview helpers', () => {
  test('takes only what docview renders', () => {
    expect(isPreviewable('/w/a/README.md')).toBe(true)
    expect(isPreviewable('/w/a/flow.mmd')).toBe(true)
    expect(isPreviewable('/w/a/config.yaml')).toBe(true)
    expect(isPreviewable('/w/a/crontab')).toBe(true)
    expect(isPreviewable('/w/a/main.ts')).toBe(false)
    expect(isPreviewable('/w/a/.md')).toBe(false)
  })

  test('builds the deep link docview parses, path encoded', () => {
    expect(previewUrl('http://localhost:4100/', 'docs/100% done.md', 12)).toBe('http://localhost:4100/#file=docs%2F100%25%20done.md&line=12')
    expect(previewUrl('http://localhost:4100', 'a.md')).toBe('http://localhost:4100/#file=a.md')
    expect(previewUrl('http://localhost:4100/', null)).toBe('http://localhost:4100/')
  })

  test('relates paths to the root, and finds the edited line', () => {
    expect(relativeTo('/w/app', '/w/app/docs/a.md')).toBe('docs/a.md')
    expect(relativeTo('/w/app/', '/w/app/a.md')).toBe('a.md')
    expect(relativeTo('/w/app', '/w/apple/a.md')).toBeNull()
    expect(lineOf(DOC_TEXT, 'new section')).toBe(2)
    expect(lineOf(DOC_TEXT, 'missing')).toBeUndefined()
    expect(lineOf(DOC_TEXT, '')).toBeUndefined()
  })

  test('spells the root as the cwd does when a symlink leads to it', () => {
    expect(cwdSpelledRoot('/tmp/app/sub', '/private/tmp/app/sub', '/private/tmp/app')).toBe('/tmp/app')
    expect(cwdSpelledRoot('/tmp/app', '/private/tmp/app', '/private/tmp/app')).toBe('/tmp/app')
    expect(cwdSpelledRoot('/w/app/sub', '/w/app/sub', '/w/app')).toBeUndefined()
    expect(cwdSpelledRoot('/elsewhere', '/elsewhere', '/w/app')).toBeUndefined()
  })

  test('never tries docview\'s default port 4000', () => {
    const ports = candidatePorts(3990)
    expect(ports).not.toContain(4000)
    expect(ports[0]).toBe(3990)
    expect(candidatePorts(Number.NaN)[0]).toBe(4100)
  })

  test('tells our root from another docview', () => {
    expect(judgeInfo(JSON.stringify({ rootPath: ROOT }), ROOT)).toBe('same')
    expect(judgeInfo(JSON.stringify({ rootPath: '/elsewhere' }), ROOT)).toBe('other')
    expect(judgeInfo('<html>', ROOT)).toBe('other')
  })

  test('counts edits and keeps the newest last', () => {
    const one = withChange([], { path: '/a.md', rel: 'a.md', at: 1 })
    const two = withChange(withChange(one, { path: '/b.md', rel: 'b.md', at: 2 }), { path: '/a.md', rel: 'a.md', at: 3, line: 4 })
    expect(two.map(doc => [doc.path, doc.edits, doc.line])).toEqual([
      ['/b.md', 1, undefined],
      ['/a.md', 2, 4],
    ])
    expect(tailOf('\u001b[32mok\u001b[0m\n\nbad\n', 5)).toEqual(['ok', 'bad'])
  })
})

type World = {
  /** What answers `/api/info` on each port: a root, or text that is not docview's. */
  info: Record<number, string>
  spawned: string[][]
  opened: string[]
  toasts: string[]
  status: (string | undefined)[]
  isInstalled: boolean
  /** docview starts but never answers. */
  isSlow: boolean
  /** The browser opener exits non-zero. */
  openFails: boolean
  clock: MockClock
}

function world(on: On): World {
  const w: World = { info: {}, spawned: [], opened: [], toasts: [], status: [], isInstalled: true, isSlow: false, openFails: false, clock: mock.clock(on, { now: 1_000 }) }
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('fs.read', ($, e) => (e.path === DOC ? ({ value: DOC_BEFORE } as never) : { deny: `ENOENT: ${e.path}` }))
  on('fs.exists', ($, e) => ({ value: e.path === DOC }) as never)
  on('http.fetch', ($, e) => {
    const port = Number(/:(\d+)\//.exec(e.url)?.[1])
    const answer = w.info[port]
    if (answer === undefined) return { deny: 'connect ECONNREFUSED 127.0.0.1' }
    const text = answer.startsWith('/') ? JSON.stringify({ root: 'app', rootPath: answer }) : answer
    return { value: { status: 200, ok: true, headers: {}, text } } as never
  })
  on('process.run', ($, e) => {
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    const argv = e.argv.join(' ')
    if (argv === 'git rev-parse --show-toplevel') return ok(`${ROOT}\n`)
    if (argv === 'pwd -P') return ok(`${ROOT}\n`)
    if (argv === 'uname -s') return ok('Darwin\n')
    if (e.argv[0] === 'open') {
      if (w.openFails) return { value: { exitCode: 1, stdout: '', stderr: 'no browser', isStdoutTruncated: false, isStderrTruncated: false } } as never
      w.opened.push(e.argv[1] ?? '')
      return ok('')
    }
    return { value: { exitCode: 1, stdout: '', stderr: `unexpected: ${argv}`, isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('process.spawn', async function* ($, e, next) {
    w.spawned.push([...e.argv])
    // What the host answers for a command it cannot start.
    if (!w.isInstalled) return { deny: `spawn ${e.argv[0]} ENOENT` }
    const port = Number(e.argv[e.argv.indexOf('-p') + 1])
    yield { stream: 'stdout' as const, text: `  Server:    http://localhost:${port}/\n` }
    if (!w.isSlow) w.info[port] = ROOT
    // Serves until stopped.
    await new Promise((_, reject) => next.signal.addEventListener('abort', () => reject(new Error('killed'))))
    return { value: { code: 0, signal: null } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine') as RenderElement
  })
  return w
}

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const BAND = {
  plugin: 'doc-preview',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const edit = ($: Engine, path = DOC) => $.tool.call({ tool: 'Edit', file_path: path, old_string: 'old', new_string: 'new section' } as never)
const docview = ($: Engine, args: string) =>
  $.command.run({ command: 'docview', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never) as Promise<{ text?: string }>

/** Lets a start that polls for readiness run its clock. */
async function settle<T>(w: World, work: Promise<T>): Promise<T> {
  for (let i = 0; i < 8; i++) await w.clock.advance(250)
  return work
}

describe('doc-preview in a session', () => {
  test('offers an edited document, starts docview on a safe port and opens it at the edited line', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await edit($)

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /docs\/design\.md を更新/ })).toBeDefined()
    await settle(w, ui.press({ key: 'preview' }))
    await ui.unmount()

    expect(w.spawned).toEqual([['docview', ROOT, '--no-open', '--no-remote', '--host', '127.0.0.1', '-p', '4100']])
    expect(w.opened).toEqual(['http://127.0.0.1:4100/#file=docs%2Fdesign.md&line=3'])
    expect(w.status.at(-1)).toBe('📄 docview :4100')

    // The open tab follows later edits by itself: no band, no second tab, no second server.
    await edit($)
    const again = await $.ui.mount(BAND)
    expect(await again.find({ type: 'Text', text: /を更新/ })).toBeUndefined()
    await again.unmount()
    expect(w.opened).toHaveLength(1)

    expect((await docview($, 'stop')).text).toBe('docview を止めました。')
    expect(w.status.at(-1)).toBeUndefined()
  })

  test('uses a docview already serving the root, and never stops it', async ($, on) => {
    const w = world(on)
    w.info[4100] = ROOT
    await $.session.start(START)
    expect((await settle(w, docview($, 'docs/design.md'))).text).toContain('#file=docs%2Fdesign.md')
    expect(w.spawned).toEqual([])
    expect((await docview($, 'stop')).text).toContain('止めずに')
  })

  test('skips a port held by another docview or another server', async ($, on) => {
    const w = world(on)
    w.info[4100] = '/some/other/root'
    w.info[4101] = '<html>not docview</html>'
    await $.session.start(START)
    await settle(w, docview($, 'root'))
    expect(w.spawned[0]?.slice(-1)).toEqual(['4102'])
    expect(w.opened).toEqual(['http://127.0.0.1:4102/'])
  })

  test('ignores files docview cannot show and files outside the root', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await edit($, `${ROOT}/src/main.ts`)
    await edit($, '/elsewhere/notes.md')
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /を更新/ })).toBeUndefined()
    await ui.unmount()
    expect(w.spawned).toEqual([])
  })

  test('says how to install docview when it is missing, and does not reach for npx unasked', async ($, on) => {
    const w = world(on)
    w.isInstalled = false
    await $.session.start(START)
    const ran = await settle(w, docview($, 'root'))
    expect(ran.text).toContain('npm install -g github:simota/docview')
    expect(w.spawned.map(argv => argv[0])).toEqual(['docview'])
    expect(w.status.at(-1)).toBe('📄 docview ✗')
  })

  test('falls back to npx when allowed', { options: { allowNpx: true } }, async ($, on) => {
    const w = world(on)
    w.isInstalled = false
    await $.session.start(START)
    await settle(w, docview($, 'root'))
    expect(w.spawned.map(argv => argv[0])).toEqual(['docview', 'npx'])
  })

  test('opens the latest new document by itself when autoOpen is first', { options: { autoOpen: 'first' } }, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await edit($)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await settle(w, Promise.resolve())
    expect(w.opened).toEqual(['http://127.0.0.1:4100/#file=docs%2Fdesign.md&line=3'])
  })

  test('a browser that did not open leaves the document offered', async ($, on) => {
    const w = world(on)
    w.openFails = true
    await $.session.start(START)
    await edit($)
    expect((await settle(w, docview($, 'docs/design.md'))).text).toContain('ブラウザを開けませんでした')
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /docs\/design\.md を更新/ })).toBeDefined()
    await ui.unmount()
  })

  test('a stop while docview is still starting ends off, not failed', async ($, on) => {
    const w = world(on)
    w.isSlow = true
    await $.session.start(START)
    const starting = docview($, 'root')
    await w.clock.advance(250)
    expect((await docview($, 'stop')).text).toBe('docview を止めました。')
    expect((await settle(w, starting)).text).toBe('docview を止めました。')
    expect(w.status.at(-1)).toBeUndefined()
    expect(w.toasts).toEqual([])
  })

  test('autoOpen does not retry a failed start every turn', { options: { autoOpen: 'first' } }, async ($, on) => {
    const w = world(on)
    w.isInstalled = false
    await $.session.start(START)
    await edit($)
    for (const turnId of ['t1', 't2', 't3']) {
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
      await settle(w, Promise.resolve())
    }
    expect(w.spawned).toHaveLength(1)
    expect(w.toasts).toHaveLength(1)
  })

  test('the pane lists documents on each surface', async ($, on) => {
    world(on)
    await $.session.start(START)
    await edit($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'doc-preview',
        surface,
        component: 'Pane',
        requestId: 'doc-preview',
        props: { title: 'docview', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /docs\/design\.md/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /○ 停止中/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
