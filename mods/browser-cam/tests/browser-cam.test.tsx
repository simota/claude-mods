import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { cellBox, pageOf, screenshotOf, summarize } from '../hooks/cam'

const SURFACES = ['terminal', 'desktop'] as const
const TOOL = 'mcp__claude-in-chrome__computer'

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

// What the engine answers beneath the plugin: the browser tool itself, the processes, the env.
function beneath(on: On, answers: { result: unknown; text: string; isError?: true }[]) {
  const runs: { argv: string[]; stdin?: string }[] = []
  on('env.get', ($, e) => ({ value: e.name === 'TMPDIR' ? '/tmpdir/' : undefined }))
  on('process.run', ($, e) => {
    runs.push({ argv: [...e.argv], ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    if (e.argv[0] === 'sips' && e.argv[1] === '-g') return { value: ok('  pixelWidth: 800\n  pixelHeight: 600\n') }
    return { value: ok('') }
  })
  on('tool.call', { tool: TOOL }, () => {
    const answer = answers.shift() ?? { result: { content: [], isError: false }, text: '' }
    return answer as never
  })
  return runs
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
  test('summarizes the key input of a call', () => {
    expect(summarize({ action: 'left_click', coordinate: [512, 300] })).toBe('left_click (512,300)')
    expect(summarize({ url: 'https://example.com/a' })).toBe('https://example.com/a')
    expect(summarize({ action: 'type', text: 'hello   world' })).toBe('type "hello world"')
  })

  test('finds the last image block in MCP and Messages API shapes', () => {
    const mcp = mcpResult([{ type: 'image', data: 'AAA', mimeType: 'image/png' }, { type: 'text', text: 'x' }, { type: 'image', data: 'BBB', mimeType: 'image/jpeg' }])
    expect(screenshotOf(mcp)).toEqual({ data: 'BBB', mime: 'image/jpeg' })
    expect(screenshotOf([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCC' } }])).toEqual({ data: 'CCC', mime: 'image/png' })
    expect(screenshotOf(mcpResult([{ type: 'text', text: 'no picture' }]))).toBeUndefined()
    expect(screenshotOf('plain text')).toBeUndefined()
  })

  test('reads the page from a result text', () => {
    expect(pageOf('Tab Title: Docs\nTab URL: https://docs.example.com/x')).toEqual({ url: 'https://docs.example.com/x', title: 'Docs' })
    expect(pageOf('Navigated to https://example.com/page.')).toEqual({ url: 'https://example.com/page.' })
    expect(pageOf('nothing here')).toEqual({})
  })

  test('sizes a wide screenshot to the columns', () => {
    // 16:9 over 80 columns: 80 / (2 × 1.78) ≈ 22 rows.
    expect(cellBox({ width: 1280, height: 720 }, 80, 40)).toEqual({ columns: 80, rows: 23 })
    // Too tall for 10 rows: the columns shrink to keep the shape.
    expect(cellBox({ width: 1280, height: 720 }, 80, 10)).toEqual({ columns: 36, rows: 10 })
  })
})

test('a screenshot result is drawn in the pane with the url and the actions, the result untouched', async ($, on) => {
  const clock = mock.clock(on)
  const result = mcpResult([{ type: 'text', text: 'Tab URL: https://example.com/login' }, { type: 'image', data: SHOT, mimeType: 'image/png' }])
  const runs = beneath(on, [
    { result: mcpResult([{ type: 'text', text: 'Navigated' }]), text: 'Navigated' },
    { result, text: 'Tab URL: https://example.com/login' },
  ])

  await $.tool.call({ tool: TOOL, tool_use_id: 'c1', action: 'left_click', coordinate: [10, 20] })
  const ran = await $.tool.call({ tool: TOOL, tool_use_id: 'c2', action: 'screenshot' })
  await clock.settle()

  // What the model reads is the tool's own answer.
  expect(ran.deny).toBeUndefined()
  expect(ran.result).toEqual(result)
  // A small PNG is drawn from its bytes: nothing is written to disk.
  expect(runs).toEqual([])

  const terminal = await drawn($, 'terminal')
  expect(terminal.images).toHaveLength(1)
  expect(terminal.images[0]?.props.source).toEqual({ png: SHOT })
  // Sized to the pane: 80 columns, at most 30 − 8 − 6 = 16 rows (no viewport measured), shape kept.
  const box = cellBox({ width: 16, height: 9 }, 80, 16)
  expect([terminal.images[0]?.props.columns, terminal.images[0]?.props.rows]).toEqual([box.columns, box.rows])
  expect(terminal.texts).toContain('🌐 https://example.com/login')
  expect(terminal.texts.slice(-2)).toEqual(['✓ computer: screenshot', '✓ computer: left_click (10,20)'])

  const desktop = await drawn($, 'desktop')
  expect(desktop.images).toHaveLength(0)
  expect(desktop.texts[0]).toBe('📷 最新のスクリーンショット: image/png · 16×9')
  expect(desktop.texts).toContain('✓ computer: screenshot')
})

test('a JPEG screenshot is written out and converted to a PNG file', async ($, on) => {
  const clock = mock.clock(on)
  const runs = beneath(on, [{ result: mcpResult([{ type: 'image', data: '/9j/AAAA', mimeType: 'image/jpeg' }]), text: '' }])

  await $.tool.call({ tool: TOOL, tool_use_id: 'j1', action: 'screenshot' })
  await clock.settle()

  expect(runs.map(run => run.argv[0])).toEqual(['mkdir', '/bin/sh', 'sips', 'sips'])
  expect(runs[1]?.stdin).toBe('/9j/AAAA')
  expect(runs[1]?.argv.at(-1)).toBe('/tmpdir/claude-browser-cam/raw-0')
  expect(runs[2]?.argv).toEqual(['sips', '-s', 'format', 'png', '/tmpdir/claude-browser-cam/raw-0', '--out', '/tmpdir/claude-browser-cam/frame-0.png'])

  const terminal = await drawn($, 'terminal')
  expect(terminal.images[0]?.props.source).toMatchObject({ file: '/tmpdir/claude-browser-cam/frame-0.png', format: 'png' })
})

test('a failed browser call is listed with ✗', async ($, on) => {
  const clock = mock.clock(on)
  beneath(on, [{ result: mcpResult([{ type: 'text', text: 'No tab' }], true), text: 'No tab' }])

  await $.tool.call({ tool: TOOL, tool_use_id: 'f1', action: 'left_click', coordinate: [1, 2] })
  await clock.settle()

  for (const surface of SURFACES) {
    const { texts } = await drawn($, surface)
    expect(texts).toContain('✗ computer: left_click (1,2)')
  }
})

test('other tools are passed by and the empty pane says so', async ($, on) => {
  const clock = mock.clock(on)
  beneath(on, [])
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'x', stderr: '', interrupted: false }, text: 'x' }) as never)

  const ran = await $.tool.call({ tool: 'Bash', command: 'echo x' })
  await clock.settle()
  expect(ran.text).toBe('x')

  for (const surface of SURFACES) {
    const { texts } = await drawn($, surface)
    expect(texts).toEqual(['まだブラウザ操作はありません。'])
  }
})
