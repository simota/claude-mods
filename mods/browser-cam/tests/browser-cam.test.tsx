import { describe, expect, mock, test } from 'claude-code/testing'
import type { FsStat, On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { BROWSER_TOOL, cellBox, graphemesFallback, nextPage, pageFrom, screenshotOf, shortName, summarize } from '../hooks/cam'

const SURFACES = ['terminal', 'desktop'] as const
const TOOL = 'mcp__claude-in-chrome__computer'
const NAVIGATE = 'mcp__claude-in-chrome__navigate'
const READ_PAGE = 'mcp__claude-in-chrome__get_page_text'
const DIR = '/tmpdir/claude-browser-cam'
const SESSION_DIR = `${DIR}/sess-1`

// A whole 16×9 grey PNG (the engine validates the bytes an Image draws).
const SHOT =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAYAAAA7KqwyAAAAFklEQVR4nGNoaGj4TwlmGDVg1AAgBgBen2eAB7rxJQAAAABJRU5ErkJggg=='

function ok(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

const PANE = {
  component: 'Pane',
  requestId: 'browser-cam',
  props: { title: 'ブラウザ', isFocused: false, bodyColumns: 81, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} } as const

const CAM = { command: 'cam', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

type Answer = { result: unknown; text: string; isError?: true }

type World = {
  isPaneOpen?: boolean
  env?: Record<string, string>
  /** Folders already there, with their mtime. */
  dirs?: Record<string, number>
  session?: { id: string }
}

// What the engine answers beneath the plugin: the browser tools, the processes, the env, the folders, the panes.
function beneath(on: On, answers: Record<string, Answer[]>, world: World = {}) {
  const runs: { argv: string[]; stdin?: string }[] = []
  const opened: string[] = []
  const dirs = new Map<string, number>(Object.entries(world.dirs ?? {}))
  dirs.set('/tmpdir', 0)
  dirs.set('/home/me/.cache', 0)
  let isOpen = world.isPaneOpen ?? true
  const env = world.env ?? { TMPDIR: '/tmpdir/', HOME: '/home/me' }
  const session = world.session ?? { id: 'sess-1' }
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: session.id }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('fs.stat', ($, e) => {
    const mtimeMs = dirs.get(e.path)
    if (mtimeMs === undefined) throw new Error('ENOENT')
    const stat: FsStat = { kind: 'dir', size: 0, mtimeMs, isLink: false, realPath: e.path }
    return { value: stat }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = [...dirs.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    return { value: names.map(path => ({ name: path.slice(prefix.length), kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => {
    runs.push({ argv: [...e.argv], ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('mkdir')) dirs.set(e.argv[4] ?? '', 0)
    if (e.argv[0] === 'rm') dirs.delete(e.argv.at(-1) ?? '')
    if (e.argv[0] === 'sips' && e.argv[1] === '-g') return { value: ok('  pixelWidth: 800\n  pixelHeight: 600\n') }
    return { value: ok('') }
  })
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'browser-cam', title: 'ブラウザ', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    isOpen = true
    return { value: { isPlaced: true } }
  })
  for (const tool of [TOOL, NAVIGATE, READ_PAGE] as const) {
    on('tool.call', { tool }, () => (answers[tool]?.shift() ?? { result: { content: [], isError: false }, text: '' }) as never)
  }
  return { runs, opened }
}

function mcpResult(blocks: object[], isError = false) {
  return { content: blocks, isError }
}

async function drawn($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ plugin: 'browser-cam', surface, ...PANE })
  const images = await ui.findAll({ type: 'Image' })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  await ui.unmount()
  return { images, texts }
}

describe('helpers', () => {
  test('summarizes the key input of a call, cutting between code points', () => {
    expect(summarize({ action: 'left_click', coordinate: [512, 300] })).toBe('left_click (512,300)')
    expect(summarize({ url: 'https://example.com/a' })).toBe('https://example.com/a')
    expect(summarize({ action: 'find', query: 'login   button' })).toBe('find "login button"')
    // 30 code points at most: 29 emoji and the ellipsis, no half of a surrogate pair.
    expect(summarize({ query: '😀'.repeat(40) })).toBe(`"${'😀'.repeat(29)}…"`)
  })

  test('typed or filled text is shown as its length only: the field may be a password', () => {
    expect(summarize({ action: 'type', text: 'hunter2' })).toBe('type ‹7文字›')
    expect(summarize({ action: 'form_input', ref: 'ref_3', value: 'p@ss w0rd' })).toBe('form_input ‹9文字›')
    // Characters as a reader counts them, emoji and flags included.
    expect(summarize({ action: 'type', text: '👩‍💻🇯🇵a' })).toBe('type ‹3文字›')
    // A key action's text names keys, not what was typed: it stays readable.
    expect(summarize({ action: 'key', text: 'ctrl+a' })).toBe('key "ctrl+a"')
  })

  test('a URL is shown with its secrets masked, in the action and on the page line', () => {
    const summary = summarize({ url: 'https://app.example/cb?access_token=abcdef123456&x=1' })
    expect(summary).not.toContain('abcdef123456')
    expect(summary).toContain('access_token=***')
    expect(nextPage({}, { url: 'https://me:hunter2@app.example/' }).url).not.toContain('hunter2')
  })

  test('knows the browser tools, the remote one included', () => {
    for (const tool of ['mcp__claude-in-chrome__computer', 'mcp__Claude_Browser__navigate', 'mcp__remote-devices__Claude_Browser__computer']) {
      expect(BROWSER_TOOL.test(tool)).toBe(true)
    }
    expect(BROWSER_TOOL.test('mcp__claude_ai_Figma__get_screenshot')).toBe(false)
    expect(shortName('mcp__remote-devices__Claude_Browser__computer')).toBe('computer')
  })

  test('finds the last image block in MCP and Messages API shapes', () => {
    const mcp = mcpResult([{ type: 'image', data: 'AAA', mimeType: 'image/png' }, { type: 'text', text: 'x' }, { type: 'image', data: 'BBB', mimeType: 'image/jpeg' }])
    expect(screenshotOf(mcp)).toEqual({ data: 'BBB', mime: 'image/jpeg' })
    expect(screenshotOf([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCC' } }])).toEqual({ data: 'CCC', mime: 'image/png' })
    expect(screenshotOf(mcpResult([{ type: 'text', text: 'no picture' }]))).toBeUndefined()
    expect(screenshotOf('plain text')).toBeUndefined()
  })

  test('reads the page from a tab tool own header, never from page text', () => {
    expect(pageFrom('navigate', { url: 'https://example.com/page' }, 'Navigated')).toEqual({ url: 'https://example.com/page' })
    expect(pageFrom('navigate', { url: 'https://a.example/' }, 'URL: https://a.example/next\nTitle: Next')).toEqual({ url: 'https://a.example/next', title: 'Next' })
    // A page's own words name whatever they like: read_page and the rest are never read for it.
    expect(pageFrom('get_page_text', {}, 'URL: https://bank.example\nTitle: Your bank')).toEqual({})
    expect(pageFrom('computer', { action: 'screenshot' }, 'see https://bank.example/login')).toEqual({})
    // A header line deep in the answer is page content too.
    expect(pageFrom('navigate', { url: 'https://evil.example/' }, `${'line\n'.repeat(10)}URL: https://bank.example`)).toEqual({ url: 'https://evil.example/' })
  })

  test('a single-tab header is its first three lines, exact prefixes only', () => {
    const given = { url: 'https://evil.example/' }
    // Lines 4, 5 and 6 are past the header: page text that came back with the navigation.
    for (const before of ['a\nb\nc\n', 'a\nb\nc\nd\n', 'a\nb\nc\nd\ne\n']) {
      expect(pageFrom('navigate', given, `${before}URL: https://bank.example\nTitle: Bank`)).toEqual({ url: 'https://evil.example/' })
    }
    // Line 3 still counts.
    expect(pageFrom('navigate', given, 'Navigated\nok\nURL: https://evil.example/home')).toEqual({ url: 'https://evil.example/home' })
    // Not the exact prefix (indented, another word before it, a full-width colon): not a header.
    expect(pageFrom('navigate', given, '  URL: https://bank.example')).toEqual({ url: 'https://evil.example/' })
    expect(pageFrom('navigate', given, 'Tab URL: https://bank.example')).toEqual({ url: 'https://evil.example/' })
    expect(pageFrom('navigate', given, 'URL：https://bank.example')).toEqual({ url: 'https://evil.example/' })
  })

  test('a tab listing gives the tab it marks active, and nothing when none is marked', () => {
    const text = ['- Tab 1', '  Title: Other', '  URL: https://other.example/', '- Tab 2 (active)', '  Title: Docs', '  URL: https://docs.example.com/x'].join('\n')
    expect(pageFrom('tabs_context_mcp', {}, text)).toEqual({ url: 'https://docs.example.com/x', title: 'Docs' })
    const json = JSON.stringify({ tabs: [{ title: 'Other', url: 'https://other.example/', active: false }, { title: 'Docs', url: 'https://docs.example.com/x', active: true }] })
    expect(pageFrom('tabs_context', {}, json)).toEqual({ url: 'https://docs.example.com/x', title: 'Docs' })
    // Several tabs and no mark: which one is driven is unknown, so no title or URL.
    expect(pageFrom('tabs_context_mcp', {}, '- Tab 1\n  URL: https://a.example/\n- Tab 2\n  URL: https://b.example/')).toEqual({})
    expect(pageFrom('tabs_context_mcp', {}, JSON.stringify([{ title: 'A', url: 'https://a.example/' }]))).toEqual({})
  })

  test('the summary is cut between whole characters, ZWJ emoji and flags included', () => {
    // 👩‍💻 is three code points and 🇯🇵 two: one character each, 29 of them before the ellipsis.
    expect(summarize({ query: '👩‍💻'.repeat(40) })).toBe(`"${'👩‍💻'.repeat(29)}…"`)
    expect(summarize({ query: '🇯🇵'.repeat(40) })).toBe(`"${'🇯🇵'.repeat(29)}…"`)
    expect(graphemesFallback('a👩‍💻🇯🇵🇺🇸1️⃣é')).toEqual(['a', '👩‍💻', '🇯🇵', '🇺🇸', '1️⃣', 'é'])
  })

  test('a new address drops the old title', () => {
    expect(nextPage({ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/' })).toEqual({ url: 'https://b.example/' })
    expect(nextPage({ url: 'https://a.example/', title: 'A' }, { url: 'https://a.example/', title: 'A2' })).toEqual({ url: 'https://a.example/', title: 'A2' })
  })

  test('sizes a wide screenshot to the columns', () => {
    // 16:9 over 80 columns: 80 / (2 × 1.78) ≈ 22.5, so 23 rows.
    expect(cellBox({ width: 1280, height: 720 }, 80, 40)).toEqual({ columns: 80, rows: 23 })
    // Too tall for 10 rows: the columns shrink to keep the shape, 10 × 2 × 1.78 ≈ 35.6.
    expect(cellBox({ width: 1280, height: 720 }, 80, 10)).toEqual({ columns: 36, rows: 10 })
  })
})

test('a screenshot is written into the session private folder and drawn with the url and the actions, the result untouched', async ($, on) => {
  const clock = mock.clock(on)
  const result = mcpResult([{ type: 'image', data: SHOT, mimeType: 'image/png' }])
  const { runs } = beneath(on, {
    [NAVIGATE]: [{ result: mcpResult([{ type: 'text', text: 'Navigated' }]), text: 'Navigated' }],
    [TOOL]: [{ result, text: '' }],
  })

  await $.tool.call({ tool: NAVIGATE, tool_use_id: 'c1', url: 'https://example.com/login' })
  const ran = await $.tool.call({ tool: TOOL, tool_use_id: 'c2', action: 'screenshot' })
  await clock.settle()

  // What the model reads is the tool's own answer.
  expect(ran.deny).toBeUndefined()
  expect(ran.result).toEqual(result)
  // The folder and the session's folder are made private, then the frame is written to a fresh name.
  // The name leads with the call's order number (2: the second browser call), which state keeps across a reload.
  expect(runs.map(run => run.argv.at(-1))).toEqual([DIR, SESSION_DIR, expect.stringMatching(/^\/tmpdir\/claude-browser-cam\/sess-1\/2-\d+\.png$/), '5'])
  expect(runs[2]?.argv.slice(0, 3)).toEqual(['/bin/sh', '-c', 'set -C && base64 -d > "$1"'])
  expect(runs[2]?.stdin).toBe(SHOT)

  const terminal = await drawn($, 'terminal')
  expect(terminal.images).toHaveLength(1)
  expect(terminal.images[0]?.props.source).toEqual({ file: runs[2]?.argv.at(-1), format: 'png', generation: 2 })
  // 80 columns; 30 body rows less 8 actions and 2 lines leave 20. 16:9 wants 22.5 rows, so the
  // rows hold at 20 and the columns shrink to 20 × 2 × 16/9 ≈ 71.1.
  expect([terminal.images[0]?.props.columns, terminal.images[0]?.props.rows]).toEqual([71, 20])
  expect(terminal.texts).toContain('🌐 https://example.com/login')
  expect(terminal.texts.slice(-2)).toEqual(['✓ computer: screenshot', '✓ navigate: https://example.com/login'])

  const desktop = await drawn($, 'desktop')
  expect(desktop.images).toHaveLength(0)
  expect(desktop.texts[0]).toBe('📷 最新のスクリーンショット: image/png · 16×9')
})

test('page text that names an address does not move the url line', async ($, on) => {
  const clock = mock.clock(on)
  beneath(on, {
    [NAVIGATE]: [{ result: mcpResult([]), text: 'Navigated' }],
    [READ_PAGE]: [{ result: mcpResult([{ type: 'text', text: 'URL: https://bank.example' }]), text: 'URL: https://bank.example\nTitle: Bank' }],
  })

  await $.tool.call({ tool: NAVIGATE, tool_use_id: 'n1', url: 'https://evil.example/' })
  await $.tool.call({ tool: READ_PAGE, tool_use_id: 'p1' })
  await clock.settle()

  const { texts } = await drawn($, 'terminal')
  expect(texts).toContain('🌐 https://evil.example/')
  expect(texts.some(text => text.includes('bank.example'))).toBe(false)
})

test('with no pane open nothing is decoded; opening the pane draws the newest screenshot', async ($, on) => {
  const clock = mock.clock(on)
  const { runs } = beneath(
    on,
    { [TOOL]: [{ result: mcpResult([{ type: 'image', data: SHOT, mimeType: 'image/png' }]), text: '' }] },
    { isPaneOpen: false },
  )

  await $.tool.call({ tool: TOOL, tool_use_id: 's1', action: 'screenshot' })
  await clock.settle()
  expect(runs).toEqual([])

  await $.command.run(CAM)
  await clock.settle()
  expect(runs.some(run => run.argv[2] === 'set -C && base64 -d > "$1"')).toBe(true)
  const { images } = await drawn($, 'terminal')
  expect(images[0]?.props.source).toMatchObject({ format: 'png', generation: 1 })
})

test('frames are read in the order their calls finished: a slow JPEG never covers a later PNG', async ($, on) => {
  const clock = mock.clock(on)
  const { runs } = beneath(on, {
    [TOOL]: [
      { result: mcpResult([{ type: 'image', data: '/9j/AAAA', mimeType: 'image/jpeg' }]), text: '' },
      { result: mcpResult([{ type: 'image', data: SHOT, mimeType: 'image/png' }]), text: '' },
    ],
  })

  await $.tool.call({ tool: TOOL, tool_use_id: 'j1', action: 'screenshot' })
  await $.tool.call({ tool: TOOL, tool_use_id: 'p2', action: 'screenshot' })
  await clock.settle()

  // The JPEG's conversion finished before the PNG was written.
  const converted = runs.findIndex(run => run.argv[0] === 'sips' && run.argv[1] === '-s')
  const pngWritten = runs.findIndex(run => run.argv[2] === 'set -C && base64 -d > "$1"' && run.stdin === SHOT)
  expect(converted).toBeGreaterThan(-1)
  expect(converted).toBeLessThan(pngWritten)
  const { images } = await drawn($, 'terminal')
  expect(images[0]?.props.source).toMatchObject({ generation: 2 })
})

test('a JPEG screenshot is written out and converted to a PNG file', async ($, on) => {
  const clock = mock.clock(on)
  const { runs } = beneath(on, { [TOOL]: [{ result: mcpResult([{ type: 'image', data: '/9j/AAAA', mimeType: 'image/jpeg' }]), text: '' }] })

  await $.tool.call({ tool: TOOL, tool_use_id: 'j1', action: 'screenshot' })
  await clock.settle()

  const raw = runs[2]?.argv.at(-1) ?? ''
  expect(raw).toMatch(/^\/tmpdir\/claude-browser-cam\/sess-1\/1-\d+\.raw$/)
  expect(runs[2]?.stdin).toBe('/9j/AAAA')
  const png = raw.replace(/\.raw$/, '.png')
  expect(runs[3]?.argv).toEqual(['sips', '-s', 'format', 'png', raw, '--out', png])

  const terminal = await drawn($, 'terminal')
  expect(terminal.images[0]?.props.source).toEqual({ file: png, format: 'png', generation: 1 })
})

test('without TMPDIR the frames go under ~/.cache, never a shared /tmp', async ($, on) => {
  const clock = mock.clock(on)
  const { runs } = beneath(on, { [TOOL]: [{ result: mcpResult([{ type: 'image', data: SHOT, mimeType: 'image/png' }]), text: '' }] }, { env: { HOME: '/home/me' } })

  await $.tool.call({ tool: TOOL, tool_use_id: 's1', action: 'screenshot' })
  await clock.settle()

  expect(runs[0]?.argv.at(-1)).toBe('/home/me/.cache/claude-browser-cam')
  expect(runs.some(run => run.argv.some(arg => arg.startsWith('/tmp/')))).toBe(false)
})

test('the pane opens unasked once, from a fullscreen terminal only', async ($, on) => {
  const clock = mock.clock(on)
  const { opened } = beneath(on, {}, { isPaneOpen: false })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // A desktop client in fullscreen says nothing of the terminal.
  const desk = await $.ui.mount({ plugin: 'browser-cam', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS, viewport: { columns: 200, rows: 50, isFullscreen: true } })
  await desk.unmount()
  await $.tool.call({ tool: TOOL, tool_use_id: 'a1', action: 'left_click', coordinate: [1, 1] })
  expect(opened).toEqual([])

  const term = await $.ui.mount({ plugin: 'browser-cam', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS, viewport: { columns: 200, rows: 50, isFullscreen: true } })
  await term.unmount()
  await $.tool.call({ tool: TOOL, tool_use_id: 'a2', action: 'left_click', coordinate: [1, 1] })
  await $.tool.call({ tool: TOOL, tool_use_id: 'a3', action: 'left_click', coordinate: [1, 1] })
  await clock.settle()
  expect(opened).toEqual(['browser-cam'])
})

test('a failed browser call is listed with ✗', async ($, on) => {
  const clock = mock.clock(on)
  beneath(on, { [TOOL]: [{ result: mcpResult([{ type: 'text', text: 'No tab' }], true), text: 'No tab' }] })

  await $.tool.call({ tool: TOOL, tool_use_id: 'f1', action: 'left_click', coordinate: [1, 2] })
  await clock.settle()

  for (const surface of SURFACES) {
    const { texts } = await drawn($, surface)
    expect(texts).toContain('✗ computer: left_click (1,2)')
  }
})

test('other tools are passed by and the empty pane says so', async ($, on) => {
  const clock = mock.clock(on)
  beneath(on, {})
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'x', stderr: '', interrupted: false }, text: 'x' }) as never)

  const ran = await $.tool.call({ tool: 'Bash', command: 'echo x' })
  await clock.settle()
  expect(ran.text).toBe('x')

  for (const surface of SURFACES) {
    const { texts } = await drawn($, surface)
    expect(texts).toEqual(['まだブラウザ操作はありません。'])
  }
})

const shotAnswer = (): Answer => ({ result: mcpResult([{ type: 'image', data: SHOT, mimeType: 'image/png' }]), text: '' })

// State a load of the module before a reload left behind: the plugin's reads and writes of
// these keys are answered here, with versions, as the host keeps them.
function seededState(on: On, seeds: Record<string, unknown>) {
  const held = new Map(Object.entries(seeds).map(([key, value]) => [key, { value, version: 1 }]))
  on('state.get', ($, e, next) => {
    const entry = e.plugin === 'browser-cam' ? held.get(e.key) : undefined
    return entry === undefined ? next(e) : { value: { value: entry.value, version: entry.version } }
  })
  on('state.set', ($, e, next) => {
    const entry = e.plugin === 'browser-cam' ? held.get(e.key) : undefined
    if (entry === undefined) return next(e)
    if (e.ifVersion !== undefined && e.ifVersion !== entry.version) return { value: { isSet: false, version: entry.version } }
    held.set(e.key, { value: e.value, version: entry.version + 1 })
    return { value: { isSet: true, version: entry.version + 1 } }
  })
}

test('after a reload the order keeps counting from state, so a new screenshot still replaces the old one', async ($, on) => {
  const clock = mock.clock(on)
  beneath(on, { [TOOL]: [shotAnswer()] })
  // What a load before the reload left in state: frame 57, counter at 57. A counter kept in the
  // module would start again at 1 and lose to 57 for the next 57 calls.
  const old = { toolUseId: 'old', seq: 57, sessionId: 'sess-1', mime: 'image/png', at: 1, source: { file: '/old.png', format: 'png', generation: 57 } }
  seededState(on, { frame: old, seq: 57 })

  await $.tool.call({ tool: TOOL, tool_use_id: 'n1', action: 'screenshot' })
  await clock.settle()

  const { images } = await drawn($, 'terminal')
  expect(images[0]?.props.source).toMatchObject({ generation: 58 })
})

test('session.end removes the session folder found from its id, and work queued for it writes nothing', async ($, on) => {
  const clock = mock.clock(on)
  // The folder exists, made by a load of the module before a reload: this load never made it.
  const { runs } = beneath(on, { [TOOL]: [shotAnswer()] }, { dirs: { [DIR]: 0, [SESSION_DIR]: 0 } })

  await $.tool.call({ tool: TOOL, tool_use_id: 'q1', action: 'screenshot' })
  // The session ends before the queued screenshot is read.
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  await clock.settle()

  expect(runs.filter(run => run.argv[0] === 'rm').map(run => run.argv)).toEqual([['rm', '-rf', '--', SESSION_DIR]])
  // Nothing made the folder again, and nothing was written for the ended session.
  expect(runs.some(run => run.argv[2]?.includes('mkdir') || run.argv[2]?.includes('base64 -d'))).toBe(false)
  for (const surface of SURFACES) {
    const { texts, images } = await drawn($, surface)
    expect(images).toHaveLength(0)
    expect(texts).toEqual(['まだブラウザ操作はありません。'])
  }
})

test('a /clear drops what the old conversation showed, and a screenshot kept for later is never drawn in the new one', async ($, on) => {
  const clock = mock.clock(on)
  const session = { id: 'sess-1' }
  const { runs } = beneath(on, { [TOOL]: [shotAnswer()] }, { isPaneOpen: false, session })

  // Taken with the pane closed: kept, not decoded.
  await $.tool.call({ tool: TOOL, tool_use_id: 'k1', action: 'screenshot' })
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  session.id = 'sess-2'

  await $.command.run(CAM)
  await clock.settle()
  expect(runs.some(run => run.argv[2]?.includes('base64 -d'))).toBe(false)
  const { texts, images } = await drawn($, 'terminal')
  expect(images).toHaveLength(0)
  expect(texts).toEqual(['まだブラウザ操作はありません。'])
})

test('session.start keeps its own frame (a reload) and drops another session one', async ($, on) => {
  const clock = mock.clock(on)
  const session = { id: 'sess-1' }
  beneath(on, {}, { session })
  const frameOf = (sessionId: string) => ({ toolUseId: 't', seq: 3, sessionId, mime: 'image/png', at: 1, source: { file: '/f.png', format: 'png', generation: 3 } })
  seededState(on, { frame: frameOf('sess-1') })

  // A hot reload: session.start again in the same session keeps the frame.
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect((await drawn($, 'terminal')).images).toHaveLength(1)

  // A session started in a process that still held the last session's frame drops it.
  session.id = 'sess-2'
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect((await drawn($, 'terminal')).images).toHaveLength(0)
})

test('session.start sweeps folders a killed session left over a day ago, never the current or a fresh one', async ($, on) => {
  const DAY = 24 * 60 * 60 * 1000
  const clock = mock.clock(on, { now: 10 * DAY })
  const { runs } = beneath(on, {}, {
    session: { id: 'sess-1' },
    dirs: { [DIR]: 0, [SESSION_DIR]: 0, [`${DIR}/old`]: 10 * DAY - DAY - 1, [`${DIR}/fresh`]: 10 * DAY - 1000 },
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(runs.filter(run => run.argv[0] === 'rm').map(run => run.argv.at(-1))).toEqual([`${DIR}/old`])
})

test('a live session touches its folder every hour, so a long idle one is never swept as killed', async ($, on) => {
  const HOUR = 60 * 60 * 1000
  const clock = mock.clock(on)
  const { runs } = beneath(on, { [TOOL]: [shotAnswer()] })
  const touches = () => runs.filter(run => run.argv[0] === 'touch').map(run => run.argv)

  await $.tool.call({ tool: TOOL, tool_use_id: 't1', action: 'screenshot' })
  await clock.settle()
  expect(touches()).toEqual([])

  await clock.advance(24 * HOUR)
  expect(touches()).toHaveLength(24)
  expect(touches()[0]).toEqual(['touch', '-c', '--', SESSION_DIR])

  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  await clock.advance(2 * HOUR)
  expect(touches()).toHaveLength(24)
})

test('after a reload the session folder already there is touched again, unasked', async ($, on) => {
  const clock = mock.clock(on)
  // A load of the module before this one made the folder; this load has made nothing yet.
  const { runs } = beneath(on, {}, { dirs: { [DIR]: 0, [SESSION_DIR]: 0 } })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(60 * 60 * 1000)
  expect(runs.filter(run => run.argv[0] === 'touch').map(run => run.argv)).toEqual([['touch', '-c', '--', SESSION_DIR]])
})

test('a long typed text or URL is measured and cut without reading it all', () => {
  const started = performance.now()
  expect(summarize({ action: 'type', text: 'a'.repeat(2_000_000) })).toBe('type ‹10000+文字›')
  expect(summarize({ action: 'type', text: 'a'.repeat(9_999) })).toBe('type ‹9999文字›')
  expect(summarize({ url: `https://example.com/${'p'.repeat(2_000_000)}` })).toHaveLength(60)
  expect(performance.now() - started).toBeLessThan(100)
})

test('the fallback reads one long cluster in linear time', () => {
  const started = performance.now()
  expect(graphemesFallback(`a${'\u200d\u{1F1EF}'.repeat(20_000)}`)).toHaveLength(1)
  expect(performance.now() - started).toBeLessThan(200)
  expect(graphemesFallback('🇯🇵🇺🇸')).toEqual(['🇯🇵', '🇺🇸'])
})
