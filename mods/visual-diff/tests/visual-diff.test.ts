import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { VdShot } from '../types'
import { base64ToBytes, changedCells, mapLines, mayLeave, parseBmp, pickBefore, pngSize, regionsOf, tabUrlOf, urlFrom } from '../hooks/diff'

/** A 24-bit BMP, `paint(x, y)` giving each pixel's RGB; bottom-up unless `topDown`. */
function bmp(width: number, height: number, paint: (x: number, y: number) => [number, number, number], topDown = false): string {
  const stride = Math.floor((24 * width + 31) / 32) * 4
  const bytes = new Uint8Array(54 + stride * height)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, topDown ? -height : height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  for (let y = 0; y < height; y += 1) {
    const row = 54 + (topDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y)
      bytes[row + x * 3] = b
      bytes[row + x * 3 + 1] = g
      bytes[row + x * 3 + 2] = r
    }
  }
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

const WHITE = () => [255, 255, 255] as [number, number, number]
// A red box at x 40–79, y 10–29 of a 64×... picture.
const BOX = (x: number, y: number): [number, number, number] => (x >= 40 && x < 56 && y >= 8 && y < 24 ? [255, 0, 0] : [255, 255, 255])

describe('diff', () => {
  test('decodes bottom-up and top-down BMPs alike', () => {
    for (const topDown of [false, true]) {
      const pixels = parseBmp(base64ToBytes(bmp(3, 2, (x, y) => [x * 10, y * 100, 7], topDown)))!
      expect([pixels.width, pixels.height]).toEqual([3, 2])
      expect([...pixels.rgb.slice(0, 3)]).toEqual([0, 0, 7])
      expect([...pixels.rgb.slice(15, 18)]).toEqual([20, 100, 7])
    }
  })

  test('reads a PNG size from its header', () => {
    expect(pngSize('iVBORw0KGgoAAAANSUhEUgAAAyAAAAJYCAIAAAD')).toEqual({ width: 800, height: 600 })
  })

  test('finds the cells and the region that changed', () => {
    const a = parseBmp(base64ToBytes(bmp(64, 32, WHITE)))!
    const b = parseBmp(base64ToBytes(bmp(64, 32, BOX)))!
    const cells = changedCells(a, b, 8)!
    expect(cells.map(row => row.map(on => (on ? '1' : '0')).join(''))).toEqual(['00000000', '00000110', '00000110', '00000000'])
    // Shown at 640×320: each 8 px cell of the small copy is 80 px of the page.
    expect(regionsOf(cells, 80, { width: 640, height: 320 })).toEqual([{ x: 400, y: 80, width: 160, height: 160 }])
    expect(mapLines(['00000110', '00000110'])).toEqual(['·····██·'])
    expect(changedCells(a, parseBmp(base64ToBytes(bmp(32, 32, WHITE)))!)).toBeUndefined()
  })

  test('compares with the last shot of the same page and size before an edit', () => {
    const shot = (id: string, at: number, url = 'http://localhost:5173/', width = 800): VdShot => ({ id, seq: Number(id), at, url, width, height: 600, png: '' })
    const shots = [shot('1', 10), shot('2', 20), shot('3', 30, 'http://localhost:5173/', 390), shot('4', 40)]
    const latest = shot('5', 50)
    expect(pickBefore(shots, [{ path: 'a.css', at: 25 }], latest)?.id).toBe('2')
    expect(pickBefore(shots, [{ path: 'a.css', at: 15 }], latest)?.id).toBe('1')
    expect(pickBefore(shots, [], latest)?.id).toBe('4')
    expect(pickBefore(shots, [{ path: 'a.css', at: 25 }], latest, '1')?.id).toBe('1')
    expect(pickBefore(shots, [], shot('6', 60, 'http://localhost:5173/x'))).toBeUndefined()
  })

  test('knows which actions may leave the page, and reads one tab out of a listing', () => {
    expect(mayLeave('computer', { action: 'left_click' })).toBe(true)
    expect(mayLeave('computer', { action: 'screenshot' })).toBe(false)
    expect(mayLeave('navigate', { url: 'back' })).toBe(true)
    expect(mayLeave('navigate', { url: 'http://x' })).toBe(false)
    expect(tabUrlOf('{"tabs":[{"tabId":3,"url":"http://a/"},{"tabId":7,"url":"http://b/about"}]}', 7)).toBe('http://b/about')
    expect(tabUrlOf('Tabs:\n- 3: http://a/ (Home)\n- 7: http://b/about (About)', 7)).toBe('http://b/about')
    expect(tabUrlOf('Tabs:\n- 3: http://a/', 7)).toBeUndefined()
  })

  test('never pairs a shot whose URL could not be told', () => {
    const shot = (id: string, at: number, url: string): VdShot => ({ id, seq: Number(id), at, url, width: 800, height: 600, png: '' })
    expect(pickBefore([shot('1', 10, '')], [], shot('2', 20, ''))).toBeUndefined()
  })

  test('takes the page URL from a navigation', () => {
    expect(urlFrom('navigate', { url: 'localhost' }, 'URL: http://localhost:5173/\nTitle: App')).toBe('http://localhost:5173/')
    expect(urlFrom('computer', {}, 'URL: http://x')).toBeUndefined()
  })
})

const PNG_800x600 = 'iVBORw0KGgoAAAANSUhEUgAAAyAAAAJYCAIAAAD'

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000 })
  const w = { toasts: [] as string[], files: {} as Record<string, string>, clock, tabs: undefined as string | undefined, sh: [] as string[][], touched: [] as string[][], dirs: [] as { name: string; mtimeMs: number }[] }
  mock.store(on, {})
  mock.env(on, { TMPDIR: '/t' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 's1' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const ok = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const [program, flag] = e.argv
    if (program === '/bin/sh') w.sh.push([...e.argv])
    if (program === 'touch') w.touched.push([...e.argv])
    if (program === 'sips' && flag === '-Z') {
      // The small copy: the first shot is plain, every later one has the red box.
      const out = e.argv.at(-1) as string
      w.files[out] = /\/1-\d+\.bmp$/.test(out) ? bmp(64, 32, WHITE) : bmp(64, 32, BOX)
    }
    return ok
  })
  // The folders of sessions under the mod's own folder, as a listing and their times.
  on('fs.list', () => ({ value: w.dirs.map(one => ({ name: one.name, kind: 'dir' })) }) as never)
  on('fs.stat', ($, e) => {
    const one = w.dirs.find(dir => String(e.path).endsWith(`/${dir.name}`))
    if (one === undefined) throw new Error('ENOENT')
    return { value: { kind: 'dir', size: 0, mtimeMs: one.mtimeMs, isLink: false } } as never
  })
  on('fs.read', ($, e) => {
    const data = w.files[String(e.path)]
    if (data === undefined) throw new Error('ENOENT')
    return { value: { base64: data } } as never
  })
  on('tool.call', ($, e) => {
    const tool = String(e.tool)
    if (tool.endsWith('__navigate')) return { result: { content: [{ type: 'text', text: 'URL: http://localhost:5173/' }] }, text: 'URL: http://localhost:5173/\nTitle: App' }
    if (tool.endsWith('__computer') && (e as unknown as { action?: string }).action === 'screenshot') return { result: { content: [{ type: 'image', data: PNG_800x600, mimeType: 'image/png' }] }, text: '' }
    if (tool.endsWith('__tabs_context_mcp')) return w.tabs === undefined ? { result: {}, text: 'no group', isError: true } : { result: {}, text: w.tabs }
    return { result: {}, text: 'ok' }
  })
  return w
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

describe('visual-diff in a session', () => {
  test('pairs the shots around an edit and shows what changed', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'http://localhost:5173/', tabId: 1 } as never)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot', tabId: 1 } as never)
    await w.clock.settle()
    await w.clock.advance(1_000)
    await $.tool.call({ tool: 'Edit', file_path: '/w/src/App.css', old_string: 'a', new_string: 'b' })
    await w.clock.advance(1_000)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot', tabId: 1 } as never)
    await w.clock.settle()
    expect(w.toasts).toEqual(['🖼 画面差分: 1領域・12.5% 変化 — /vdiff'])

    const text = (await $.command.run({ command: 'vdiff', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text
    expect(text).toContain('http://localhost:5173/ @800×600: 12.5% 変化、1領域')
    expect(text).toContain('- (500, 100) 200×200')
    expect(text).toContain('間の編集: /w/src/App.css')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'visual-diff',
        surface,
        component: 'Pane',
        requestId: 'visual-diff',
        props: { title: '画面の差分', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /変化 12\.5% · 1領域/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /間の編集: App\.css/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the folder is checked at both levels, names cannot collide, and folders of killed sessions are swept', async ($, on) => {
    const w = world(on)
    w.dirs = [{ name: 's1', mtimeMs: 1_000 }, { name: 'old', mtimeMs: 1_000 - 25 * 3_600_000 }, { name: 'fresh', mtimeMs: 1_000 - 3_600_000 }]
    await $.session.start(START)
    await w.clock.settle()
    const removed = w.sh.filter(argv => String(argv[2]).includes('rm -rf')).map(argv => argv.at(-1))
    expect(removed).toEqual(['/t/claude-visual-diff/old'])

    await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'http://localhost:5173/', tabId: 1 } as never)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot', tabId: 1 } as never)
    await w.clock.settle()
    const made = w.sh.find(argv => String(argv[2]).includes('mkdir'))
    // The mod's own folder and the session's both: made private, no link, ours.
    expect(made?.slice(-2)).toEqual(['/t/claude-visual-diff', '/t/claude-visual-diff/s1'])
    expect(String(made?.[2])).toContain('[ ! -L "$1" ]')
    expect(String(made?.[2])).toContain('[ ! -L "$2" ]')
    // A name with the time in it: a counter that starts again never meets a file already there.
    const written = w.sh.find(argv => String(argv[2]).includes('base64 -d'))
    expect(String(written?.at(-1))).toMatch(/\/s1\/1-\d+\.png$/)
  })

  test('a live session touches its folder every hour, so a long idle one is never swept as killed', async ($, on) => {
    const HOUR = 3_600_000
    const w = world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'http://localhost:5173/', tabId: 1 } as never)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot', tabId: 1 } as never)
    await w.clock.settle()
    expect(w.touched).toEqual([])

    await w.clock.advance(24 * HOUR)
    expect(w.touched).toHaveLength(24)
    expect(w.touched[0]).toEqual(['touch', '-c', '--', '/t/claude-visual-diff/s1'])

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await w.clock.advance(2 * HOUR)
    expect(w.touched).toHaveLength(24)
  })

  test('after a reload the session folder already there is touched again, unasked', async ($, on) => {
    const w = world(on)
    // A load of the module before this one made the folder; this load has made nothing yet.
    w.dirs = [{ name: 's1', mtimeMs: 1_000 }]
    await $.session.start(START)
    await w.clock.advance(3_600_000)
    expect(w.touched).toEqual([['touch', '-c', '--', '/t/claude-visual-diff/s1']])
  })

  test("session.end removes the ending session's own folder, found from its id, not from the shots kept", async ($, on) => {
    const w = world(on)
    w.dirs = [{ name: 's1', mtimeMs: 1_000 }]
    await $.session.start(START)
    // No shot in this session: the folder is still its own, and goes.
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    const removed = w.sh.filter(argv => String(argv[2]).includes('rm -rf')).map(argv => argv.at(-1))
    expect(removed).toEqual(['/t/claude-visual-diff/s1'])
    // Both levels are checked right before, as the sweep does.
    expect(String(w.sh.find(argv => String(argv[2]).includes('rm -rf'))?.[2])).toContain('[ ! -L "$1" ]')
  })

  test('a click that leaves the page is not compared with the page it left', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'http://localhost:5173/', tabId: 1 } as never)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot', tabId: 1 } as never)
    await w.clock.settle()
    await w.clock.advance(1_000)
    await $.tool.call({ tool: 'Edit', file_path: '/w/src/App.css', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'left_click', coordinate: [10, 10], tabId: 1 } as never)
    w.tabs = JSON.stringify({ tabs: [{ tabId: 1, url: 'http://localhost:5173/about' }] })
    await w.clock.advance(1_000)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot', tabId: 1 } as never)
    await w.clock.settle()
    expect(w.toasts).toEqual([])

    // The tab listing cannot tell: the shot is kept apart, and the pane says why.
    w.tabs = undefined
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'left_click', coordinate: [10, 10], tabId: 1 } as never)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot', tabId: 1 } as never)
    await w.clock.settle()
    expect(w.toasts).toEqual([])
    const ui = await $.ui.mount({
      plugin: 'visual-diff',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'visual-diff',
      props: { title: '画面の差分', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /#3 はクリックなどの後でページの URL を確かめられなかった/ })).toBeDefined()
    await ui.unmount()
  })
})
