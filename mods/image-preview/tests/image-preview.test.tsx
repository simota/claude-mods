import { describe, expect, mock, test } from 'claude-code/testing'
import type { FsStat, On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { absolutize, cellBox, findImagePaths, pngDimensions } from '../hooks/images'

const SURFACES = ['terminal', 'desktop'] as const
const CWD = '/work/app'

// The first 24 bytes of a PNG: signature, then the IHDR chunk's length, type, width and height.
function pngHead(width: number, height: number): string {
  const u32 = (n: number) => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  return btoa(`\x89PNG\r\n\x1a\n${u32(13)}IHDR${u32(width)}${u32(height)}\x08\x06\x00\x00\x00`)
}

type File = { size: number; mtimeMs: number; head?: string }

function ok(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

// What the engine answers beneath the plugin: the files, sips, the cwd, the env, the toasts.
function beneath(on: On, files: Record<string, File>, options: { hasSips: boolean }) {
  const toasts: string[] = []
  const runs: string[][] = []
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : e.name === 'TMPDIR' ? '/tmpdir/' : undefined }))
  on('fs.stat', ($, e) => {
    const file = files[e.path]
    if (file === undefined) throw new Error('ENOENT')
    const stat: FsStat = { kind: 'file', size: file.size, mtimeMs: file.mtimeMs, isLink: false }
    return { value: stat }
  })
  on('fs.read', ($, e) => ({ value: { base64: files[e.path]?.head ?? '' } }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (!options.hasSips && e.argv[0] === 'sips') return { value: { ...ok(''), exitCode: 127 } }
    if (e.argv[0] === 'sips' && e.argv[1] === '-g') return { value: ok('  pixelWidth: 300\n  pixelHeight: 100\n') }
    return { value: ok('') }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  // The engine's own row, drawn when the plugin passes.
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row {e.props.tool}</Text>
  })
  return { toasts, runs }
}

function toolRow(id: string, tool: string) {
  return {
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false },
  } as const
}

const PANE = {
  component: 'Pane',
  requestId: 'image-preview',
  props: { title: '画像プレビュー', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

async function drawn($: Engine, surface: (typeof SURFACES)[number], at: ReturnType<typeof toolRow> | typeof PANE) {
  const ui = await $.ui.mount({ plugin: 'image-preview', surface, ...at })
  const images = await ui.findAll({ type: 'Image' })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  return { ui, images, texts }
}

describe('helpers', () => {
  test('finds image paths in commands and output, not URLs', () => {
    const text = 'python gen.py --out out/cat.png\nSaved: /tmp/a b/x.jpg\nsee https://e.com/i.png and ./img/dog.webp'
    expect(findImagePaths(text)).toEqual(['out/cat.png', 'b/x.jpg', './img/dog.webp'])
  })

  test('absolutizes against the cwd and home', () => {
    expect(absolutize('out/cat.png', CWD, '/home/me')).toBe('/work/app/out/cat.png')
    expect(absolutize('../x.png', CWD, '/home/me')).toBe('/work/x.png')
    expect(absolutize('~/p.png', CWD, '/home/me')).toBe('/home/me/p.png')
    expect(absolutize('~/p.png', CWD, undefined)).toBeUndefined()
  })

  test('reads a PNG header and keeps the aspect in cells', () => {
    expect(pngDimensions(pngHead(64, 32))).toEqual({ width: 64, height: 32 })
    expect(pngDimensions(btoa('not a png at all, no header'))).toBeUndefined()
    // 2:1 picture, 12 rows → 48 columns (a cell is about twice as tall as wide).
    expect(cellBox({ width: 64, height: 32 }, 100, 12)).toEqual({ columns: 48, rows: 12 })
    // Too wide for 20 columns: the rows shrink to keep the shape.
    expect(cellBox({ width: 64, height: 32 }, 20, 12)).toEqual({ columns: 20, rows: 5 })
  })
})

test('a written PNG is drawn under its Write row, sized from its header, with a toast', async ($, on) => {
  const files = { '/work/app/out/cat.png': { size: 2048, mtimeMs: 10, head: pngHead(64, 32) } }
  const { toasts } = beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create', filePath: '/work/app/out/cat.png', content: '', structuredPatch: [] } }) as never)

  await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/work/app/out/cat.png', content: '' })

  expect(toasts).toEqual(['画像プレビュー: cat.png'])
  const terminal = await drawn($, 'terminal', toolRow('w1', 'Write'))
  expect(terminal.texts[0]).toBe('engine row Write')
  expect(terminal.images).toHaveLength(1)
  expect(terminal.images[0]?.props.source).toEqual({ file: '/work/app/out/cat.png', format: 'png', generation: 10 })
  expect(terminal.images[0]?.props.rows).toBe(12)
  expect(terminal.images[0]?.props.columns).toBe(48)
  expect(terminal.texts.some(text => text.includes('cat.png · 2.0 KB · 64×32'))).toBe(true)

  // The desktop has no Image: the row keeps a caption.
  const desktop = await drawn($, 'desktop', toolRow('w1', 'Write'))
  expect(desktop.images).toHaveLength(0)
  expect(desktop.texts.some(text => text.includes('cat.png'))).toBe(true)
})

test('rows of other calls draw the engine row alone', async ($, on) => {
  beneath(on, {}, { hasSips: false })
  for (const surface of SURFACES) {
    const { texts, images } = await drawn($, surface, toolRow('other', 'Bash'))
    expect(texts).toEqual(['engine row Bash'])
    expect(images).toHaveLength(0)
  }
})

test('a Bash run shows only images it produced, converting a JPEG with sips', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const files = {
    '/work/app/gen/new.jpg': { size: 5000, mtimeMs: 100_500 },
    '/work/app/old.png': { size: 100, mtimeMs: 1_000 },
  }
  const { runs, toasts } = beneath(on, files, { hasSips: true })
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.advance(1_000)
    return { result: { stdout: 'wrote gen/new.jpg\nolder: old.png', stderr: '', interrupted: false } } as never
  })

  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'python gen.py', description: 'gen' })

  expect(toasts).toEqual(['画像プレビュー: new.jpg'])
  const convert = runs.find(argv => argv[0] === 'sips' && argv[1] === '-s')
  expect(convert?.slice(0, 6)).toEqual(['sips', '-s', 'format', 'png', '-Z', '1024'])
  expect(convert?.[6]).toBe('/work/app/gen/new.jpg')
  expect(convert?.[8]).toMatch(/^\/tmpdir\/claude-image-preview\/[0-9a-f]{16}\.png$/)

  const { images, texts } = await drawn($, 'terminal', toolRow('b1', 'Bash'))
  expect(images).toHaveLength(1)
  expect(images[0]?.props.source).toMatchObject({ format: 'png', file: convert?.[8] })
  // 300×100 from sips: 3:1, so 12 rows want 72 columns.
  expect(images[0]?.props.columns).toBe(72)
  expect(texts.some(text => text.includes('old.png'))).toBe(false)
})

test('without sips a JPEG gets a caption only', async ($, on) => {
  const files = { '/work/app/p.jpg': { size: 10, mtimeMs: 5 } }
  beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: '', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }) as never)

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'p.jpg' })

  const { images, texts } = await drawn($, 'terminal', toolRow('r1', 'Read'))
  expect(images).toHaveLength(0)
  expect(texts.some(text => text.includes('p.jpg') && text.includes('PNG に変換できないため省略'))).toBe(true)
})

test('the pane steps from newest to older images', async ($, on) => {
  const files = {
    '/work/app/a.png': { size: 1, mtimeMs: 1, head: pngHead(10, 10) },
    '/work/app/b.png': { size: 1, mtimeMs: 2, head: pngHead(10, 10) },
  }
  beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'a.png' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: 'b.png' })

  for (const surface of SURFACES) {
    const first = await drawn($, surface, PANE)
    expect(first.texts.some(text => text.includes('b.png'))).toBe(true)
    expect(first.texts.some(text => text.includes('1 / 2'))).toBe(true)
    await first.ui.press({ key: 'next' })
    await first.ui.unmount()
    const after = await drawn($, surface, PANE)
    expect(after.texts.some(text => text.includes('a.png') && !text.includes('b.png'))).toBe(true)
    expect(after.texts.some(text => text.includes('2 / 2'))).toBe(true)
    await after.ui.press({ key: 'prev' })
    await after.ui.unmount()
  }
})

test('the pane says when there is nothing yet', async $ => {
  for (const surface of SURFACES) {
    const { texts } = await drawn($, surface, PANE)
    expect(texts).toEqual(['まだ画像はありません。'])
  }
})

test('inline off keeps tool rows as the engine draws them', { options: { inline: false } }, async ($, on) => {
  const files = { '/work/app/c.png': { size: 1, mtimeMs: 1, head: pngHead(10, 10) } }
  beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r3', file_path: 'c.png' })

  const { texts, images } = await drawn($, 'terminal', toolRow('r3', 'Read'))
  expect(texts).toEqual(['engine row Read'])
  expect(images).toHaveLength(0)
})
