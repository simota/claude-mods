import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { VdDiff, VdEdit, VdShot } from '../types'
import { base64ToBytes, BROWSER_TOOL, changedCells, keyOf, mapLines, mayLeave, parseBmp, pickBefore, pngSize, regionsOf, share, tabUrlOf, urlFrom } from './diff'

const PANE = 'visual-diff'
const TITLE = '画面の差分'
const DIR_NAME = 'claude-visual-diff'
const KEEP_SHOTS = 20
const KEEP_EDITS = 200
const SMALL_PX = 320
const GRID = 32

const shots = atom({ plugin: 'visual-diff', key: 'shots' } as const, [] as VdShot[])
const edits = atom({ plugin: 'visual-diff', key: 'edits' } as const, [] as VdEdit[])
const url = atom({ plugin: 'visual-diff', key: 'url' } as const, '')
const isStale = atom({ plugin: 'visual-diff', key: 'isStale' } as const, false)
const diff = atom({ plugin: 'visual-diff', key: 'diff' } as const, null as VdDiff | null)
const baselines = atom({ plugin: 'visual-diff', key: 'baselines' } as const, {} as Record<string, string>)
const note = atom({ plugin: 'visual-diff', key: 'note' } as const, null as string | null)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TABS_TOOL = 'mcp__claude-in-chrome__tabs_context_mcp'

// Screenshots are read one at a time, in the order their calls finished.
let queue: Promise<void> = Promise.resolve()
const enqueue = ($: EngineInterface, work: () => Promise<void>) => {
  queue = queue.then(work).catch(err => $.ui.log(`visual-diff: ${String(err)}`, { to: 'debug' }))
  return queue
}

/** The last image block of a tool's result: MCP's `{ type: 'image', data, mimeType }` or the API's `source`. */
function screenshotOf(result: unknown): { data: string; mime: string } | undefined {
  const content = Array.isArray(result) ? result : Array.isArray((result as { content?: unknown } | null)?.content) ? (result as { content: unknown[] }).content : []
  let found: { data: string; mime: string } | undefined
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type !== 'image') continue
    const source = (block.source ?? {}) as Record<string, unknown>
    const data = typeof block.data === 'string' ? block.data : source.data
    const mime = typeof block.mimeType === 'string' ? block.mimeType : source.media_type
    if (typeof data === 'string' && data !== '') found = { data, mime: typeof mime === 'string' ? mime : 'image/png' }
  }
  return found
}

const sh = ($: EngineInterface, script: string, args: string[], stdin?: string) =>
  $.process.run(['/bin/sh', '-c', script, 'sh', ...args], { timeoutMs: 20_000, ...(stdin === undefined ? {} : { stdin }) }).catch(() => undefined)

/** The mod's own folder under TMPDIR, else ~/.cache. */
async function ownFolder($: EngineInterface): Promise<string | undefined> {
  const base = ((await $.env.get('TMPDIR')) || `${(await $.env.get('HOME')) ?? ''}/.cache`).replace(/\/+$/, '')
  return base === '' || base === '/.cache' ? undefined : `${base}/${DIR_NAME}`
}

const nameOf = (sessionId: string) => sessionId.replace(/[^\w-]/g, '_')
const sessionFolderName = async ($: EngineInterface) => nameOf(await $.session.id())

/**
 * The session's folder, made 0700 and checked to be ours, and so is the mod's folder it sits in:
 * a link or another user's folder there would send its writes and removals elsewhere.
 */
async function folder($: EngineInterface): Promise<string | undefined> {
  const own = await ownFolder($)
  if (own === undefined) return undefined
  const dir = `${own}/${await sessionFolderName($)}`
  const made = await sh(
    $,
    'umask 077 && mkdir -p -m 700 -- "$1" && [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && chmod 700 -- "$1" && mkdir -p -m 700 -- "$2" && [ -d "$2" ] && [ ! -L "$2" ] && [ -O "$2" ]',
    [own, dir],
  )
  if (made?.exitCode !== 0) return undefined
  liveDirs.add(dir)
  keepAlive($)
  return dir
}

// A session killed before its end leaves its folder: removed by a later start once a day old.
const STALE_MS = 24 * 60 * 60 * 1000
// A live session touches its folder this often, so one left idle for a day is not taken for killed.
const HEARTBEAT_MS = 60 * 60 * 1000
// Session folders this load of the module writes into.
const liveDirs = new Set<string>()
let heartbeat: Timer | undefined

// Each hour while this process keeps a folder, its mtime is moved on: another session's sweep
// reads a folder untouched for a day as a killed session's, however idle this one is.
function keepAlive($: EngineInterface): void {
  heartbeat ??= $.clock.every(HEARTBEAT_MS, () => {
    if (liveDirs.size === 0) {
      heartbeat?.cancel()
      heartbeat = undefined
      return
    }
    for (const dir of liveDirs) void $.process.run(['touch', '-c', '--', dir]).catch(() => undefined)
  })
}

// Removes a session's folder, both levels checked again right before: ours, no link.
const REMOVE_CHECKED = '[ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ -d "$2" ] && [ ! -L "$2" ] && [ -O "$2" ] && rm -rf -- "$2"'

async function sweepStale($: EngineInterface): Promise<void> {
  const own = await ownFolder($)
  if (own === undefined) return
  const current = await sessionFolderName($)
  const cutoff = (await $.clock.now()) - STALE_MS
  for (const entry of await $.fs.list(own).catch(() => [])) {
    if (entry.kind !== 'dir' || entry.name === current || !/^[\w-]+$/.test(entry.name)) continue
    const stat = await $.fs.stat(`${own}/${entry.name}`).catch(() => undefined)
    if (stat === undefined || stat.mtimeMs >= cutoff) continue
    await sh($, REMOVE_CHECKED, [own, `${own}/${entry.name}`])
  }
}

/** Writes the picture as PNG and a small BMP beside it; answers the shot, or why not. */
async function keep($: EngineInterface, shot: { data: string; mime: string }, seq: number, at: number, page: string): Promise<VdShot | string> {
  const dir = await folder($)
  if (dir === undefined) return '画像の保存先を用意できませんでした'
  // The time in the name: a counter that starts again (a resumed session) never meets a file already there.
  const name = `${seq}-${at}`
  const png = `${dir}/${name}.png`
  const isPng = shot.mime === 'image/png'
  const target = isPng ? png : `${dir}/${name}.raw`
  const wrote = await sh($, 'set -C && base64 -d > "$1"', [target], shot.data)
  if (wrote?.exitCode !== 0) return '画像を書き出せませんでした'
  if (!isPng) {
    const converted = await $.process.run(['sips', '-s', 'format', 'png', target, '--out', png], { timeoutMs: 20_000 }).catch(() => undefined)
    await sh($, 'rm -f -- "$1"', [target])
    if (converted?.exitCode !== 0) return `${shot.mime} を PNG に変換できませんでした（sips が必要です）`
  }
  let size = isPng ? pngSize(shot.data) : undefined
  if (size === undefined) {
    const measured = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', png]).catch(() => undefined)
    const w = Number(measured?.stdout.match(/pixelWidth:\s*(\d+)/)?.[1])
    const h = Number(measured?.stdout.match(/pixelHeight:\s*(\d+)/)?.[1])
    if (w > 0 && h > 0) size = { width: w, height: h }
  }
  if (size === undefined) return '画像の大きさを読めませんでした'
  const bmp = `${dir}/${name}.bmp`
  const small =
    (await $.process.run(['sips', '-Z', String(SMALL_PX), '-s', 'format', 'bmp', png, '--out', bmp], { timeoutMs: 20_000 }).catch(() => undefined))?.exitCode === 0 ||
    (await $.process.run(['magick', png, '-resize', `${SMALL_PX}x${SMALL_PX}`, `BMP3:${bmp}`], { timeoutMs: 20_000 }).catch(() => undefined))?.exitCode === 0
  return { id: `${seq}`, seq, at, url: page, ...size, png, ...(small ? { bmp } : {}) }
}

async function pixels($: EngineInterface, path: string) {
  const read = await $.fs.read(path, { as: 'bytes' }).catch(() => undefined)
  return read === undefined || typeof read === 'string' ? undefined : parseBmp(base64ToBytes(read.base64))
}

/** Compares a new shot with its before, and keeps the result. */
async function compare($: EngineInterface, after: VdShot): Promise<void> {
  const before = pickBefore(await read($, shots), await read($, edits), after, (await read($, baselines))[keyOf(after)])
  if (before === undefined) return
  if (before.bmp === undefined || after.bmp === undefined) {
    await update($, note, () => '比較用の縮小画像を作れませんでした（sips か ImageMagick が必要です）')
    return
  }
  const [a, b] = await Promise.all([pixels($, before.bmp), pixels($, after.bmp)])
  const cells = a === undefined || b === undefined ? undefined : changedCells(a, b, GRID)
  if (a === undefined || cells === undefined) return
  const cellPx = Math.ceil(a.width / GRID) * (after.width / a.width)
  const regions = regionsOf(cells, cellPx, after)
  const between = [...new Set((await read($, edits)).filter(edit => edit.at > before.at && edit.at <= after.at).map(edit => edit.path))]
  const result: VdDiff = {
    before,
    after,
    cells: cells.map(row => row.map(on => (on ? '1' : '0')).join('')),
    regions,
    changedPct: share(cells),
    edits: between,
    at: await $.clock.now(),
  }
  await update($, diff, () => result)
  await update($, note, () => null)
  $.ui.toast(result.regions.length === 0 ? '🖼 画面差分: 変化なし — /vdiff' : `🖼 画面差分: ${result.regions.length}領域・${result.changedPct}% 変化 — /vdiff`)
}

/**
 * The page a shot shows: the last navigation's, unless an action since may have left it; then
 * the tab listing is asked for that tab. Empty when neither can tell.
 */
async function pageOf($: EngineInterface, tabId: number | undefined): Promise<string> {
  if (!(await read($, isStale))) return read($, url)
  if (tabId === undefined) return ''
  const listed = await $.tool.call({ tool: TABS_TOOL } as never).catch(() => undefined)
  const found = listed === undefined || listed.deny !== undefined || listed.isError === true ? undefined : tabUrlOf(listed.text ?? '', tabId)
  if (found === undefined) return ''
  await update($, url, () => found)
  await update($, isStale, () => false)
  return found
}

async function ingest($: EngineInterface, shot: { data: string; mime: string }, at: number, tabId: number | undefined): Promise<void> {
  const seq = ((await read($, shots)).at(-1)?.seq ?? 0) + 1
  const page = await pageOf($, tabId)
  const kept = await keep($, shot, seq, at, page)
  if (typeof kept === 'string') {
    await update($, note, () => kept)
    return
  }
  if (page === '') await update($, note, () => `#${seq} はクリックなどの後でページの URL を確かめられなかったため、比較に使いません`)
  const pinned = new Set(Object.values(await read($, baselines)))
  const list = await update($, shots, all => [...all, kept])
  // Older shots go, a pinned baseline stays; their files go with them.
  const dropped = list.filter(one => !pinned.has(one.id)).slice(0, Math.max(0, list.length - KEEP_SHOTS))
  if (dropped.length > 0) {
    const gone = new Set(dropped.map(one => one.id))
    await update($, shots, all => all.filter(one => !gone.has(one.id)))
    await sh($, 'rm -f -- "$@"', dropped.flatMap(one => [one.png, ...(one.bmp === undefined ? [] : [one.bmp])]))
  }
  await compare($, kept)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'vdiff', description: '同じ URL・画面サイズのスクリーンショットの変更前後を比較（/vdiff · base で基準に固定 · clear）', argumentHint: '[base | clear]' })
    const started = await next(e)
    $.clock.after(0, () => void sweepStale($).catch(() => undefined))
    // After a reload this load has made nothing, yet the session's folder may be there already.
    const own = await ownFolder($)
    const dir = own === undefined ? undefined : `${own}/${await sessionFolderName($)}`
    const stat = dir === undefined ? undefined : await $.fs.stat(dir).catch(() => undefined)
    if (dir !== undefined && stat?.kind === 'dir' && !stat.isLink) {
      liveDirs.add(dir)
      keepAlive($)
    }
    return started
  })

  on('session.end', async ($, e, next) => {
    // The ending session's folder, named from its id: the shots kept may be an earlier session's.
    // One session runs at a time, so nothing is left to touch; the next shot makes its folder anew.
    liveDirs.clear()
    const own = await ownFolder($)
    const name = nameOf(e.sessionId)
    // As the sweep reads names: an empty one would name the mod's whole folder, every session's.
    if (own !== undefined && /^[\w-]+$/.test(name)) await sh($, REMOVE_CHECKED, [own, `${own}/${name}`])
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isBrowser = BROWSER_TOOL.test(tool)
    if (!isBrowser && !EDIT_TOOLS.has(tool)) return next(e)
    const input = e as unknown as Record<string, unknown>
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const at = await $.clock.now()
    if (!isBrowser) {
      const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
      if (path !== undefined) await update($, edits, list => [...list, { path, at }].slice(-KEEP_EDITS))
      return ran
    }
    const name = tool.replace(BROWSER_TOOL, '')
    const tabId = typeof input.tabId === 'number' ? input.tabId : undefined
    const page = urlFrom(name, input, ran.text ?? '')
    if (page !== undefined) {
      await update($, url, () => page)
      await update($, isStale, () => false)
    } else if (mayLeave(name, input)) await update($, isStale, () => true)
    const shot = screenshotOf(ran.result)
    // Decoded from a timer, so the model never waits on the conversion.
    if (shot !== undefined) $.clock.after(0, () => void enqueue($, () => ingest($, shot, at, tabId)))
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('command.run', { command: 'vdiff' }, async ($, e) => {
    const args = e.args.trim()
    const latest = (await read($, shots)).at(-1)
    if (args === 'base') {
      if (latest === undefined) return { text: '🖼 まだスクリーンショットがありません。' }
      await update($, baselines, all => ({ ...all, [keyOf(latest)]: latest.id }))
      return { text: `🖼 ${keyOf(latest)} の基準を最新のスクリーンショットに固定しました。` }
    }
    if (args === 'clear') {
      await update($, baselines, () => ({}))
      return { text: '🖼 基準の固定を外しました（編集前の最新と比べます）。' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    const shown = await read($, diff)
    if (shown === null) return { text: '🖼 まだ比較できる組がありません（同じ URL・サイズで2枚以上撮ると比較します）。' }
    return {
      text: [
        `🖼 ${keyOf(shown.after)}: ${shown.changedPct}% 変化、${shown.regions.length}領域`,
        ...shown.regions.slice(0, 5).map(r => `- (${r.x}, ${r.y}) ${r.width}×${r.height}`),
        shown.edits.length > 0 ? `間の編集: ${shown.edits.join(', ')}` : '間の編集: なし',
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const shown = await read($, diff)
    const problem = await read($, note)
    if (shown === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>同じ URL・画面サイズのスクリーンショットが2枚そろうと、ここに変更前後を並べます。</Text>
          {problem !== null && <Text color="yellow">{problem}</Text>}
        </Box>
      )
    }
    const head = `🖼 ${shown.after.url || '(URL 不明)'} @${shown.after.width}×${shown.after.height} · 変化 ${shown.changedPct}% · ${shown.regions.length}領域`
    const details = (
      <Box flexDirection="column">
        {mapLines(shown.cells).map((line, index) => (
          <Text key={`m-${index}`} color="magenta">{line}</Text>
        ))}
        {shown.regions.slice(0, 5).map((r, index) => (
          <Text key={`r-${index}`}>{`□ (${r.x}, ${r.y}) ${r.width}×${r.height}`}</Text>
        ))}
        <Text dimColor wrap="truncate-end">{shown.edits.length > 0 ? `間の編集: ${shown.edits.map(p => p.slice(p.lastIndexOf('/') + 1)).join(', ')}` : '間の編集: なし'}</Text>
        {problem !== null && <Text color="yellow">{problem}</Text>}
      </Box>
    )
    if (e.surface === 'terminal') {
      const { Image } = $.ui.resolve(e)
      const columns = Math.max(8, Math.min(255, Math.floor((e.props.bodyColumns - 3) / 2)))
      const rows = Math.max(3, Math.min(40, Math.round((columns * shown.after.height) / shown.after.width / 2)))
      return (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">{head}</Text>
          <Box flexDirection="row">
            <Box flexDirection="column" marginRight={1}>
              <Text dimColor>{`前 #${shown.before.seq}`}</Text>
              <Image key="before" source={{ file: shown.before.png, format: 'png', generation: shown.before.seq }} columns={columns} rows={rows} alt={`変更前 #${shown.before.seq}`} />
            </Box>
            <Box flexDirection="column">
              <Text dimColor>{`後 #${shown.after.seq}`}</Text>
              <Image key="after" source={{ file: shown.after.png, format: 'png', generation: shown.after.seq }} columns={columns} rows={rows} alt={`変更後 #${shown.after.seq}`} />
            </Box>
          </Box>
          {details}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>{head}</Text>
        <Text dimColor>{`前 #${shown.before.seq} → 後 #${shown.after.seq}`}</Text>
        {details}
      </Box>
    )
  })
}
