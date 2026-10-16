import { describe, expect, mock, test } from 'claude-code/testing'
import type { FsStat, On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { absolutize, cellBox, findImageCandidates, pngDimensions } from '../hooks/images'

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

type World = {
  hasSips: boolean
  env?: Record<string, string>
  /** The session's working directory, read when asked: a test may move it. */
  place?: { cwd: string }
  /** Folders that exist; a `link` one is a symbolic link elsewhere. */
  dirs?: Record<string, 'dir' | 'link'>
}

const DEFAULT_DIRS = { '/tmpdir': 'dir', '/tmpdir/claude-image-preview': 'dir' } as const
const CACHE = '/tmpdir/claude-image-preview/sess-1'

// What the engine answers beneath the plugin: the files, the shell and sips, the cwd, the env, the toasts.
function beneath(on: On, files: Record<string, File>, world: World) {
  const toasts: string[] = []
  const runs: string[][] = []
  const reads: string[] = []
  const env = world.env ?? { HOME: '/home/me', TMPDIR: '/tmpdir/' }
  const dirs: Record<string, 'dir' | 'link'> = world.dirs ?? { ...DEFAULT_DIRS }
  const place = world.place ?? { cwd: CWD }
  on('session.cwd', () => ({ value: place.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('fs.stat', ($, e) => {
    const dir = dirs[e.path]
    if (dir !== undefined) {
      const stat: FsStat = { kind: 'dir', size: 0, mtimeMs: 0, isLink: dir === 'link', realPath: dir === 'link' ? '/elsewhere' : e.path }
      return { value: stat }
    }
    const file = files[e.path]
    if (file === undefined) throw new Error('ENOENT')
    const stat: FsStat = { kind: 'file', size: file.size, mtimeMs: file.mtimeMs, isLink: false }
    return { value: stat }
  })
  on('fs.read', ($, e) => {
    reads.push(e.path)
    return { value: { base64: '' } }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('head -c')) return { value: ok(`${files[e.argv[4] ?? '']?.head ?? ''}\n`) }
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('mkdir')) {
      const dir = e.argv[4] ?? ''
      if (dirs[dir] === 'link') return { value: { ...ok(''), exitCode: 1 } }
      dirs[dir] ??= 'dir'
      return { value: ok('') }
    }
    if (e.argv[0] === 'rm') delete dirs[e.argv.at(-1) ?? '']
    if (!world.hasSips && e.argv[0] === 'sips') return { value: { ...ok(''), exitCode: 127 } }
    if (e.argv[0] === 'sips' && e.argv[1] === '-g') return { value: ok('  pixelWidth: 300\n  pixelHeight: 100\n') }
    return { value: ok('') }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = Object.keys(dirs).filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    return { value: names.map(path => ({ name: path.slice(prefix.length), kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  // The engine's own row, drawn when the plugin passes.
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row {e.props.tool}</Text>
  })
  return { toasts, runs, reads, dirs }
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

describe('findImageCandidates', () => {
  test('finds image paths in commands and output, not URLs', () => {
    const text = 'python gen.py --out out/cat.png\nsee https://e.com/i.png and ./img/dog.webp'
    expect(findImageCandidates(text)).toEqual([['out/cat.png'], ['./img/dog.webp']])
  })

  test('a path split at a space offers the joined reading first and the tail after it', () => {
    expect(findImageCandidates('Saved: /tmp/a b/x.jpg')).toEqual([['/tmp/a b/x.jpg', 'b/x.jpg']])
    // Two arguments read the same way; which one exists on disk decides (see the Bash test below).
    expect(findImageCandidates('convert /tmp/a /tmp/b.png')).toEqual([['/tmp/a /tmp/b.png', '/tmp/b.png']])
  })

  test('a list of paths is never joined across its commas', () => {
    expect(findImageCandidates('wrote ./a.png, ./b.png')).toEqual([['./a.png'], ['./b.png']])
  })

  test('a quoted path keeps its spaces', () => {
    expect(findImageCandidates(`open "/Users/me/My Pics/a.png" and 'out/b c.webp'`)).toEqual([['/Users/me/My Pics/a.png'], ['out/b c.webp']])
  })

  test('a path that ends a sentence keeps its name', () => {
    expect(findImageCandidates('Saved to out/cat.png.')).toEqual([['out/cat.png']])
    expect(findImageCandidates('保存しました: out/犬.png。')).toEqual([['out/犬.png']])
    expect(findImageCandidates('(see out/cat.png), done')).toEqual([['out/cat.png']])
  })

  test('two paths side by side stay two', () => {
    expect(findImageCandidates('cp /a/b.png out/c.png')).toEqual([['/a/b.png'], ['out/c.png']])
  })

  test('reads a long output in linear time: it runs before every Bash result', () => {
    // An echoed glob of many paths, a long run of `=` or of `:`: each took 0.4 s or more.
    for (const text of ['/a '.repeat(7_000) + '/x.png', '='.repeat(60_000), ':'.repeat(60_000)]) {
      const started = performance.now()
      findImageCandidates(text)
      expect(performance.now() - started).toBeLessThan(100)
    }
  })

  test('joins a bounded number of split pieces, so a long argument list is not offered whole', () => {
    const [group] = findImageCandidates(`ls ${'/a '.repeat(7_000)}/x.png`)
    expect(group?.length).toBeLessThanOrEqual(9)
    expect(group?.at(-1)).toBe('/x.png')
    expect(group?.[0]).toBe(`${'/a '.repeat(8)}/x.png`)
  })

  test('a long list of image paths stops at the first 64: at most 4 are shown from one call', () => {
    // Each `/n.png!` is a path and also the head of the next one: 9 readings for every word.
    const text = Array.from({ length: 20_000 }, (_, n) => `/${n}.png!`).join(' ')
    const started = performance.now()
    const groups = findImageCandidates(text)
    expect(performance.now() - started).toBeLessThan(100)
    expect(groups).toHaveLength(64)
    expect(groups[0]).toEqual(['/0.png'])
    expect(groups.at(-1)?.at(-1)).toBe('/63.png')
    // Repeats and URLs do not count toward the 64: a path after them is still found.
    const after = `${'a.png '.repeat(100)}${'https://e.com/i.png '.repeat(100)}"q.png" ${`'q.png' `.repeat(100)}b.png`
    expect(findImageCandidates(after)).toEqual([['a.png'], ['q.png'], ['b.png']])
  })

  test('a word after a space is read whole, one glued to a quote from its `=`; a word holds one path at most', () => {
    expect(findImageCandidates('--out=img/a.png PATH=x:/b.png')).toEqual([['--out=img/a.png'], ['PATH=x:/b.png']])
    expect(findImageCandidates('"q"z=/c.png x=/a.png:/b.png')).toEqual([['/c.png'], ['x=/a.png:/b.png']])
  })
})

describe('helpers', () => {
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

test('a written PNG is drawn under its Write row once the result has gone back, sized from its header alone', async ($, on) => {
  const clock = mock.clock(on)
  const files = { '/work/app/out/cat.png': { size: 2048, mtimeMs: 10.75, head: pngHead(64, 32) } }
  const { toasts, runs, reads } = beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create', filePath: '/work/app/out/cat.png', content: '', structuredPatch: [] } }) as never)

  await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/work/app/out/cat.png', content: '' })
  // The result is back before any stat or read ran.
  expect(toasts).toEqual([])
  expect(runs).toEqual([])
  await clock.settle()

  expect(toasts).toEqual(['画像プレビュー: cat.png'])
  // Only the header's bytes were read, through head; the file itself was never loaded.
  expect(runs).toEqual([['/bin/sh', '-c', 'head -c 32 -- "$1" | base64', 'sh', '/work/app/out/cat.png']])
  expect(reads).toEqual([])
  const terminal = await drawn($, 'terminal', toolRow('w1', 'Write'))
  expect(terminal.texts[0]).toBe('engine row Write')
  expect(terminal.images).toHaveLength(1)
  // A fractional mtime becomes a whole-number generation.
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

test('a Bash run shows only images it produced, converting a JPEG into the private cache', async ($, on) => {
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
  await clock.settle()

  expect(toasts).toEqual(['画像プレビュー: new.jpg'])
  // The cache folder is made private before anything is written into it.
  const MKDIR = 'umask 077 && mkdir -p -m 700 -- "$1" && [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && chmod 700 -- "$1"'
  const made = runs.findIndex(argv => argv[0] === '/bin/sh' && argv[2]?.includes('mkdir'))
  // The plugin's folder, then the session's own inside it, both made private.
  expect(runs[made]).toEqual(['/bin/sh', '-c', MKDIR, 'sh', '/tmpdir/claude-image-preview'])
  expect(runs[made + 1]).toEqual(['/bin/sh', '-c', MKDIR, 'sh', CACHE])
  const converted = runs.findIndex(argv => argv[0] === 'sips' && argv[1] === '-s')
  expect(made).toBeLessThan(converted)
  const convert = runs[converted]
  expect(convert?.slice(0, 6)).toEqual(['sips', '-s', 'format', 'png', '-Z', '1024'])
  expect(convert?.[6]).toBe('/work/app/gen/new.jpg')
  expect(convert?.[8]).toMatch(/^\/tmpdir\/claude-image-preview\/sess-1\/[0-9a-f]{16}\.png$/)
  // Under 50 converted copies nothing is removed.
  expect(runs.some(argv => argv[0] === 'rm')).toBe(false)

  const { images, texts } = await drawn($, 'terminal', toolRow('b1', 'Bash'))
  expect(images).toHaveLength(1)
  expect(images[0]?.props.source).toMatchObject({ format: 'png', file: convert?.[8] })
  // 300×100 from sips: 3:1, so 12 rows want 72 columns.
  expect(images[0]?.props.columns).toBe(72)
  expect(texts.some(text => text.includes('old.png'))).toBe(false)
})

test('a Bash run that only names an image already shown does not show it again', async ($, on) => {
  const clock = mock.clock(on, { now: 50_000 })
  const files = { '/work/app/a.png': { size: 10, mtimeMs: 49_500, head: pngHead(10, 10) } }
  const { toasts } = beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' } }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'a.png: PNG image data', stderr: '', interrupted: false } }) as never)

  await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: 'a.png', content: '' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'file a.png', description: 'inspect' })
  await clock.settle()

  expect(toasts).toEqual(['画像プレビュー: a.png'])
  const { images } = await drawn($, 'terminal', toolRow('b2', 'Bash'))
  expect(images).toHaveLength(0)
})

test('without TMPDIR the cache lives under ~/.cache, never in a shared /tmp', async ($, on) => {
  const clock = mock.clock(on)
  const files = { '/work/app/p.jpg': { size: 10, mtimeMs: 5 } }
  const { runs } = beneath(on, files, { hasSips: true, env: { HOME: '/home/me' }, dirs: { '/home/me/.cache': 'dir' } })
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'p.jpg' })
  await clock.settle()

  const convert = runs.find(argv => argv[0] === 'sips' && argv[1] === '-s')
  expect(convert?.[8]).toMatch(/^\/home\/me\/\.cache\/claude-image-preview\/sess-1\/[0-9a-f]{16}\.png$/)
  expect(runs.some(argv => argv.some(arg => arg.startsWith('/tmp/')))).toBe(false)
})

test('a cache folder that is a symbolic link is never written into', async ($, on) => {
  const clock = mock.clock(on)
  const files = { '/work/app/p.jpg': { size: 10, mtimeMs: 5 } }
  const { runs } = beneath(on, files, { hasSips: true, dirs: { '/tmpdir': 'dir', '/tmpdir/claude-image-preview': 'link' } })
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'p.jpg' })
  await clock.settle()

  expect(runs.some(argv => argv[0] === 'sips' && argv[1] === '-s')).toBe(false)
  const { texts } = await drawn($, 'terminal', toolRow('r1', 'Read'))
  expect(texts.some(text => text.includes('PNG に変換できないため省略'))).toBe(true)
})

test('without sips a JPEG gets a caption only', async ($, on) => {
  const clock = mock.clock(on)
  const files = { '/work/app/p.jpg': { size: 10, mtimeMs: 5 } }
  beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: '', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }) as never)

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'p.jpg' })
  await clock.settle()

  const { images, texts } = await drawn($, 'terminal', toolRow('r1', 'Read'))
  expect(images).toHaveLength(0)
  expect(texts.some(text => text.includes('p.jpg') && text.includes('PNG に変換できないため省略'))).toBe(true)
})

test('the pane sizes the picture to its own rows and steps from newest to older images', async ($, on) => {
  const clock = mock.clock(on)
  const files = {
    '/work/app/a.png': { size: 1, mtimeMs: 1, head: pngHead(10, 10) },
    '/work/app/b.png': { size: 1, mtimeMs: 2, head: pngHead(10, 10) },
  }
  beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'a.png' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: 'b.png' })
  await clock.settle()

  const sized = await drawn($, 'terminal', PANE)
  // bodyRows 20 less 3 rows of buttons, caption and path: 17 rows; a square takes 34 columns.
  expect([sized.images[0]?.props.columns, sized.images[0]?.props.rows]).toEqual([34, 17])
  await sized.ui.unmount()

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
  const clock = mock.clock(on)
  const files = { '/work/app/c.png': { size: 1, mtimeMs: 1, head: pngHead(10, 10) } }
  beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r3', file_path: 'c.png' })
  await clock.settle()

  const { texts, images } = await drawn($, 'terminal', toolRow('r3', 'Read'))
  expect(texts).toEqual(['engine row Read'])
  expect(images).toHaveLength(0)
})

test('of two arguments read as one spaced path, the one that exists is shown', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  // `/tmp/a` is a folder, `/tmp/b.png` the file the command made; `/tmp/a /tmp/b.png` is nothing.
  const files = { '/tmp/b.png': { size: 10, mtimeMs: 100_500, head: pngHead(10, 10) } }
  const { toasts } = beneath(on, files, { hasSips: false })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)

  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'convert /tmp/a /tmp/b.png', description: 'convert' })
  await clock.settle()

  expect(toasts).toEqual(['画像プレビュー: b.png'])
  const { images } = await drawn($, 'terminal', toolRow('c1', 'Bash'))
  expect(images[0]?.props.source).toMatchObject({ file: '/tmp/b.png' })
})

test('a relative path is read against the directory of the call, not the one when the timer runs', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const files = { '/work/sub/out/x.png': { size: 10, mtimeMs: 100_500, head: pngHead(10, 10) } }
  const place = { cwd: '/work/sub' }
  const { toasts } = beneath(on, files, { hasSips: false, place })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'wrote out/x.png', stderr: '', interrupted: false } }) as never)

  await $.tool.call({ tool: 'Bash', tool_use_id: 'd1', command: 'gen', description: 'gen' })
  // By the time the timer runs, the session is back in another directory.
  place.cwd = '/work/app'
  await clock.settle()

  expect(toasts).toEqual(['画像プレビュー: x.png'])
})

test('past 50 converted copies the oldest is removed and its row shows a caption, not an empty box', async ($, on) => {
  const clock = mock.clock(on)
  const files: Record<string, File> = {}
  for (let i = 0; i < 51; i++) files[`/work/app/p${i}.jpg`] = { size: 10, mtimeMs: 5 }
  const { runs } = beneath(on, files, { hasSips: true })
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)

  for (let i = 0; i < 51; i++) await $.tool.call({ tool: 'Read', tool_use_id: `r${i}`, file_path: `p${i}.jpg` })
  await clock.settle()

  const firstOut = runs.find(argv => argv[0] === 'sips' && argv[1] === '-s' && argv[6] === '/work/app/p0.jpg')?.[8]
  expect(runs.filter(argv => argv[0] === 'rm').map(argv => argv.at(-1))).toEqual([firstOut])
  const first = await drawn($, 'terminal', toolRow('r0', 'Read'))
  expect(first.images).toHaveLength(0)
  expect(first.texts.some(text => text.includes('p0.jpg') && text.includes('キャッシュから削除済み'))).toBe(true)
  // The newest still draws.
  const last = await drawn($, 'terminal', toolRow('r50', 'Read'))
  expect(last.images).toHaveLength(1)
})

test('a copy used again counts as new: the oldest unused one goes, and both rows that drew the reused copy keep it', async ($, on) => {
  const clock = mock.clock(on)
  const files: Record<string, File> = {}
  for (let i = 0; i < 51; i++) files[`/work/app/q${i}.jpg`] = { size: 10, mtimeMs: 5 }
  const { runs } = beneath(on, files, { hasSips: true })
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)

  // q0, then q1–q49, then q0 again (the same version: the same copy), then q50: 51 distinct copies in all.
  await $.tool.call({ tool: 'Read', tool_use_id: 'first', file_path: 'q0.jpg' })
  for (let i = 1; i < 50; i++) await $.tool.call({ tool: 'Read', tool_use_id: `r${i}`, file_path: `q${i}.jpg` })
  await $.tool.call({ tool: 'Read', tool_use_id: 'again', file_path: 'q0.jpg' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r50', file_path: 'q50.jpg' })
  await clock.settle()

  const outOf = (name: string) => runs.find(argv => argv[0] === 'sips' && argv[1] === '-s' && argv[6] === `/work/app/${name}`)?.[8]
  // q0's copy was used again after q1's, so q1's is the oldest and goes.
  expect(runs.filter(argv => argv[0] === 'rm').map(argv => argv.at(-1))).toEqual([outOf('q1.jpg')])
  for (const id of ['first', 'again']) {
    const { images } = await drawn($, 'terminal', toolRow(id, 'Read'))
    expect(images[0]?.props.source).toMatchObject({ file: outOf('q0.jpg') })
  }
  const { texts } = await drawn($, 'terminal', toolRow('r1', 'Read'))
  expect(texts.some(text => text.includes('キャッシュから削除済み'))).toBe(true)
})

test('session.end removes the session cache; session.start sweeps a day-old one a killed session left', async ($, on) => {
  const DAY = 24 * 60 * 60 * 1000
  const clock = mock.clock(on, { now: 2 * DAY })
  const { runs } = beneath(on, {}, {
    hasSips: false,
    dirs: { '/tmpdir': 'dir', '/tmpdir/claude-image-preview': 'dir', [CACHE]: 'dir', '/tmpdir/claude-image-preview/old': 'dir' },
  })

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await clock.settle()
  // Every folder here has mtime 0, two days back: the other session's goes, the current one stays.
  expect(runs.filter(argv => argv[0] === 'rm').map(argv => argv.at(-1))).toEqual(['/tmpdir/claude-image-preview/old'])

  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  expect(runs.filter(argv => argv[0] === 'rm').map(argv => argv.at(-1))).toEqual(['/tmpdir/claude-image-preview/old', CACHE])
})

test('a live session touches its cache every hour, so a long idle one is never swept as killed', async ($, on) => {
  const HOUR = 60 * 60 * 1000
  const clock = mock.clock(on, { now: 100_000 })
  const files = { '/work/app/gen/new.jpg': { size: 5000, mtimeMs: 100_500 } }
  const { runs } = beneath(on, files, { hasSips: true })
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.advance(1_000)
    return { result: { stdout: 'wrote gen/new.jpg', stderr: '', interrupted: false } } as never
  })
  const touches = () => runs.filter(argv => argv[0] === 'touch')

  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'python gen.py', description: 'gen' })
  await clock.settle()
  expect(touches()).toEqual([])

  // A day idle: 24 touches, each moving the folder's mtime past another session's cutoff.
  await clock.advance(24 * HOUR)
  expect(touches()).toHaveLength(24)
  expect(touches()[0]).toEqual(['touch', '-c', '--', CACHE])

  // Ended: its folder is gone and is touched no more.
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  await clock.advance(2 * HOUR)
  expect(touches()).toHaveLength(24)
})
