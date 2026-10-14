import { describe, expect, mock, test } from 'claude-code/testing'
import type { FsStat, On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { BROWSER_TOOL, cellBox, nextPage, pageFrom, screenshotOf, shortName, summarize } from '../hooks/cam'

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

// What the engine answers beneath the plugin: the browser tools, the processes, the env, the folders, the panes.
function beneath(on: On, answers: Record<string, Answer[]>, world: { isPaneOpen?: boolean; env?: Record<string, string> } = {}) {
  const runs: { argv: string[]; stdin?: string }[] = []
  const opened: string[] = []
  const dirs = new Set<string>(['/tmpdir', '/home/me/.cache'])
  let isOpen = world.isPaneOpen ?? true
  const env = world.env ?? { TMPDIR: '/tmpdir/', HOME: '/home/me' }
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.stat', ($, e) => {
    if (!dirs.has(e.path)) throw new Error('ENOENT')
    const stat: FsStat = { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path }
    return { value: stat }
  })
  on('process.run', ($, e) => {
    runs.push({ argv: [...e.argv], ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('mkdir')) dirs.add(e.argv[4] ?? '')
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
    expect(summarize({ action: 'type', text: 'hello   world' })).toBe('type "hello world"')
    // 30 code points at most: 29 emoji and the ellipsis, no half of a surrogate pair.
    expect(summarize({ text: '😀'.repeat(40) })).toBe(`"${'😀'.repeat(29)}…"`)
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
    expect(pageFrom('tabs_context_mcp', {}, 'Tab Title: Docs\nTab URL: https://docs.example.com/x')).toEqual({ url: 'https://docs.example.com/x', title: 'Docs' })
    expect(pageFrom('navigate', { url: 'https://example.com/page' }, 'Navigated')).toEqual({ url: 'https://example.com/page' })
    // A page's own words name whatever they like: read_page and the rest are never read for it.
    expect(pageFrom('get_page_text', {}, 'URL: https://bank.example\nTitle: Your bank')).toEqual({})
    expect(pageFrom('computer', { action: 'screenshot' }, 'see https://bank.example/login')).toEqual({})
    // A header line deep in the answer is page content too.
    expect(pageFrom('navigate', { url: 'https://evil.example/' }, `${'line\n'.repeat(10)}URL: https://bank.example`)).toEqual({ url: 'https://evil.example/' })
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
  expect(runs.map(run => run.argv.at(-1))).toEqual([DIR, SESSION_DIR, expect.stringMatching(/^\/tmpdir\/claude-browser-cam\/sess-1\/\d+-0\.png$/), '5'])
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
  expect(raw).toMatch(/^\/tmpdir\/claude-browser-cam\/sess-1\/\d+-0\.raw$/)
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
