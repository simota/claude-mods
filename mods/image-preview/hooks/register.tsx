import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, RenderInput, RenderSurface, Register, Timer } from 'claude-code'

import type { ConvertedFile, ImageItem } from '../types'
import {
  IMAGE_EXT,
  absolutize,
  baseName,
  caption,
  cellBox,
  findImageCandidates,
  isPng,
  pngDimensions,
  sipsDimensions,
} from './images'

const PANE = 'image-preview'
const TITLE = '画像プレビュー'
const KEEP = 20
const PER_CALL = 4
// What the terminal is asked to decode; bigger files get a caption instead.
const MAX_BYTES = 32 * 1024 * 1024
// A Bash run "produces" an image modified since it started (with clock slack).
const SLACK_MS = 2000
const CONVERT_MAX_PX = 1024
// Converted copies kept in the session's cache; older ones are removed, never one the pane shows.
const CACHE_KEEP = 50
const CACHE_NAME = 'claude-image-preview'
// A session's cache left behind (the process was killed before session.end) goes after a day.
const STALE_MS = 24 * 60 * 60 * 1000
// A live session touches its cache this often, so one left idle for a day is not taken for killed.
const HEARTBEAT_MS = 60 * 60 * 1000
// The pane's own rows that are not the picture: the step buttons, the caption, the path.
const PANE_CHROME_ROWS = 3
const PRUNED = 'キャッシュから削除済み'

const images = atom({ plugin: 'image-preview', key: 'images' } as const, [])
const cursor = atom({ plugin: 'image-preview', key: 'cursor' } as const, 0)
const byTool = atom({ plugin: 'image-preview', key: 'byTool' } as const, [])
const converted = atom({ plugin: 'image-preview', key: 'converted' } as const, [] as ConvertedFile[])

// Where a call's paths are read from: taken in the hook itself, since a timer that outlives
// the hook reads the session's directory, not that of the call (a subagent's worktree).
type CallPlace = { cwd: string; home: string | undefined; sessionId: string }

// Session caches made and checked by this load of the module, by session id.
const cacheDirs = new Map<string, string>()
let heartbeat: Timer | undefined

// Each hour while this process keeps a cache, its mtime is moved on: another session's sweep
// reads a folder untouched for a day as a killed session's, however idle this one is.
function keepAlive($: EngineInterface): void {
  heartbeat ??= $.clock.every(HEARTBEAT_MS, () => {
    if (cacheDirs.size === 0) {
      heartbeat?.cancel()
      heartbeat = undefined
      return
    }
    for (const dir of cacheDirs.values()) void $.process.run(['touch', '-c', '--', dir]).catch(() => undefined)
  })
}
// Work after a tool call runs one at a time, in the order the calls finished.
let queue: Promise<void> = Promise.resolve()

async function sips($: EngineInterface, argv: string[]) {
  return $.process.run(['sips', ...argv], { timeoutMs: 15_000 }).catch(() => undefined)
}

// A session id as a folder name: the same id always gives the same name, so a reload finds it again.
const folderName = (sessionId: string) => sessionId.replace(/[^\w-]/g, '_')

// TMPDIR when set, else ~/.cache: never a shared /tmp.
async function rootDir($: EngineInterface): Promise<string | undefined> {
  const tmp = (await $.env.get('TMPDIR'))?.replace(/\/+$/, '')
  const home = (await $.env.get('HOME'))?.replace(/\/+$/, '')
  return tmp !== undefined && tmp !== '' ? tmp : home !== undefined && home !== '' ? `${home}/.cache` : undefined
}

// `<parent>/<name>` when it is already a real directory (not a link) right where the parent resolves.
async function checkedChild($: EngineInterface, parent: string, name: string): Promise<string | undefined> {
  const [where, above] = await Promise.all([
    $.fs.stat(`${parent}/${name}`, { resolve: true }).catch(() => undefined),
    $.fs.stat(parent, { resolve: true }).catch(() => undefined),
  ])
  if (where?.kind !== 'dir' || where.isLink || above?.realPath === undefined) return undefined
  return where.realPath === `${above.realPath}/${name}` ? where.realPath : undefined
}

/**
 * `<parent>/<name>` as a folder only this user can reach: made 0700, then checked to be
 * a real directory of ours (not a link, owned by us) right where the parent resolves,
 * so nothing planted beforehand can take a write.
 */
async function privateChild($: EngineInterface, parent: string, name: string): Promise<string | undefined> {
  const made = await $.process
    .run(['/bin/sh', '-c', 'umask 077 && mkdir -p -m 700 -- "$1" && [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && chmod 700 -- "$1"', 'sh', `${parent}/${name}`])
    .catch(() => undefined)
  if (made?.exitCode !== 0) return undefined
  return checkedChild($, parent, name)
}

// One cache per session: a session's prune never touches what another session's rows draw.
async function cacheFolder($: EngineInterface, sessionId: string): Promise<string | undefined> {
  const known = cacheDirs.get(sessionId)
  if (known !== undefined) return known
  // Work queued for a session a /clear has since ended: its folder is gone and stays gone.
  if (sessionId !== (await $.session.id())) return undefined
  const parent = await rootDir($)
  if (parent === undefined) return undefined
  const base = await privateChild($, parent, CACHE_NAME)
  if (base === undefined) return undefined
  const dir = await privateChild($, base, folderName(sessionId))
  if (dir !== undefined) {
    cacheDirs.set(sessionId, dir)
    keepAlive($)
  }
  return dir
}

// The plugin's base folder as it already stands; nothing is made.
async function existingBase($: EngineInterface): Promise<string | undefined> {
  const parent = await rootDir($)
  return parent === undefined ? undefined : checkedChild($, parent, CACHE_NAME)
}

async function removeSessionCache($: EngineInterface, sessionId: string): Promise<void> {
  cacheDirs.delete(sessionId)
  const base = await existingBase($)
  if (base === undefined) return
  const dir = await checkedChild($, base, folderName(sessionId))
  if (dir !== undefined) await $.process.run(['rm', '-rf', '--', dir]).catch(() => undefined)
}

// Caches of sessions that never reached session.end (a killed process), once a day old.
async function sweepStale($: EngineInterface, currentId: string): Promise<void> {
  const base = await existingBase($)
  if (base === undefined) return
  const entries = await $.fs.list(base).catch(() => [])
  const cutoff = (await $.clock.now()) - STALE_MS
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name === folderName(currentId)) continue
    const stat = await $.fs.stat(`${base}/${entry.name}`, { resolve: true }).catch(() => undefined)
    if (stat === undefined || stat.mtimeMs >= cutoff) continue
    const dir = await checkedChild($, base, entry.name)
    if (dir !== undefined) await $.process.run(['rm', '-rf', '--', dir]).catch(() => undefined)
  }
}

/**
 * Notes a converted copy and, past CACHE_KEEP, removes the oldest copies the pane does not
 * show. Each row that drew a removed copy is told, so it shows a caption, not an empty box.
 */
async function trackConverted($: EngineInterface, png: string, toolUseId: string): Promise<void> {
  const list = await update($, converted, all => {
    const known = all.find(one => one.png === png)
    const ids = [...new Set([...(known?.toolUseIds ?? []), toolUseId])]
    return [...all.filter(one => one.png !== png), { png, toolUseIds: ids }]
  })
  if (list.length <= CACHE_KEEP) return
  const shown = new Set((await read($, images)).flatMap(item => (item.png === undefined ? [] : [item.png])))
  const dropped = list.filter(one => one.png !== png && !shown.has(one.png)).slice(0, list.length - CACHE_KEEP)
  if (dropped.length === 0) return
  const gone = new Set(dropped.map(one => one.png))
  await update($, converted, all => all.filter(one => !gone.has(one.png)))
  for (const one of dropped) {
    await $.process.run(['rm', '-f', '--', one.png]).catch(() => undefined)
    for (const id of one.toolUseIds) {
      await update($, memberOf(byTool, { requestId: id }), items =>
        items.map(item => {
          if (item.png !== one.png) return item
          const { png: _removed, ...rest } = item
          return { ...rest, skipped: PRUNED }
        }),
      )
    }
  }
}

// A PNG's size is in its first 24 bytes: read those alone, never the whole file.
async function pngHeader($: EngineInterface, path: string): Promise<string | undefined> {
  const ran = await $.process.run(['/bin/sh', '-c', 'head -c 32 -- "$1" | base64', 'sh', path]).catch(() => undefined)
  return ran?.exitCode === 0 ? ran.stdout.replace(/\s+/g, '') : undefined
}

async function dimensions($: EngineInterface, path: string) {
  if (isPng(path)) {
    const head = await pngHeader($, path)
    return head === undefined ? undefined : pngDimensions(head)
  }
  const ran = await sips($, ['-g', 'pixelWidth', '-g', 'pixelHeight', path])
  return ran?.exitCode === 0 ? sipsDimensions(ran.stdout) : undefined
}

async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Only PNG reaches the terminal's Image: anything else is converted with macOS sips.
async function convertToPng($: EngineInterface, path: string, mtimeMs: number, place: CallPlace, toolUseId: string): Promise<string | undefined> {
  const dir = await cacheFolder($, place.sessionId)
  if (dir === undefined) return undefined
  const out = `${dir}/${await hashOf(`${path}:${mtimeMs}`)}.png`
  const ran = await sips($, ['-s', 'format', 'png', '-Z', String(CONVERT_MAX_PX), path, '--out', out])
  if (ran?.exitCode !== 0) return undefined
  await trackConverted($, out, toolUseId)
  return out
}

async function describe(
  $: EngineInterface,
  path: string,
  toolUseId: string,
  since: number | undefined,
  place: CallPlace,
): Promise<ImageItem | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file') return undefined
  // The Image's generation is a whole number; a file system's mtime need not be.
  const mtimeMs = Math.trunc(stat.mtimeMs)
  if (since !== undefined && mtimeMs < since - SLACK_MS) return undefined

  const item: ImageItem = {
    id: `${path}:${mtimeMs}`,
    path,
    name: baseName(path),
    size: stat.size,
    mtimeMs,
    toolUseId,
  }
  if (stat.size > MAX_BYTES) return { ...item, skipped: '大きすぎるため省略' }

  const dims = await dimensions($, path)
  const png = isPng(path) ? path : await convertToPng($, path, mtimeMs, place, toolUseId)
  return {
    ...item,
    ...dims,
    ...(png === undefined ? { skipped: 'PNG に変換できないため省略' } : { png }),
  }
}

async function remember($: EngineInterface, found: ImageItem[], toolUseId: string): Promise<void> {
  if (found.length === 0) return
  const ids = new Set(found.map(item => item.id))
  await update($, images, list => [...found, ...list.filter(item => !ids.has(item.id))].slice(0, KEEP))
  await update($, cursor, () => 0)
  await update($, memberOf(byTool, { requestId: toolUseId }), () => found)
  const first = found[0]
  if (first !== undefined) {
    $.ui.toast(`画像プレビュー: ${first.name}${found.length > 1 ? ` 他${found.length - 1}件` : ''}`)
  }
}

async function collect(
  $: EngineInterface,
  groups: string[][],
  toolUseId: string,
  since: number | undefined,
  place: CallPlace,
): Promise<void> {
  // A Bash run that only names an image it did not make (`file a.png` after a Write)
  // does not show that version again.
  const shown = since === undefined ? new Set<string>() : new Set((await read($, images)).map(item => item.id))
  const found: ImageItem[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    // The longest reading that exists is the path: `/tmp/a /tmp/b.png` is no file, `/tmp/b.png` is.
    for (const candidate of group) {
      const path = absolutize(candidate, place.cwd, place.home)
      if (path === undefined || !IMAGE_EXT.test(path) || seen.has(path)) continue
      const item = await describe($, path, toolUseId, since, place)
      if (item === undefined) continue
      seen.add(path)
      if (!shown.has(item.id)) found.push(item)
      break
    }
    if (found.length >= PER_CALL) break
  }
  await remember($, found, toolUseId)
}

// Run after the result has gone back to the model: stat and sips never hold a tool call up.
function later($: EngineInterface, work: () => Promise<void>): void {
  $.clock.after(0, () => {
    queue = queue.then(work).catch(err => $.ui.log(`image-preview: ${String(err)}`, { to: 'debug' }))
    return queue
  })
}

async function placeOf($: EngineInterface): Promise<CallPlace> {
  const [cwd, home, sessionId] = await Promise.all([$.session.cwd(), $.env.get('HOME'), $.session.id()])
  return { cwd, home, sessionId }
}

function thumbnail(e: RenderInput, $: EngineInterface, item: ImageItem, maxColumns: number, maxRows: number) {
  const surface: RenderSurface = e.surface
  const label = caption(item)
  if (surface === 'terminal' && item.png !== undefined) {
    const { Box, Text, Image } = $.ui.resolve({ ...e, surface })
    const box = cellBox(item, maxColumns, maxRows)
    return (
      <Box key={item.id} flexDirection="column">
        <Image
          key={item.id}
          source={{ file: item.png, format: 'png', generation: Math.trunc(item.mtimeMs) }}
          columns={box.columns}
          rows={box.rows}
          alt={label}
        />
        <Text dimColor>🖼️ {label}</Text>
      </Box>
    )
  }
  const { Text } = $.ui.resolve(e)
  return (
    <Text key={item.id} dimColor wrap="truncate-end">
      🖼️ {label}
      {item.skipped !== undefined ? `（${item.skipped}）` : ''}
    </Text>
  )
}

export const register: Register = (on, options) => {
  const isInline = options.inline !== false
  const inlineRows = Math.min(60, Math.max(1, Number(options.maxRows ?? 12) || 12))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'images', description: 'このセッションの画像をプレビューペインに表示する' })
    const sessionId = await $.session.id()
    await sweepStale($, sessionId)
    // After a reload this load has made nothing, yet the session's cache may be there already.
    const base = await existingBase($)
    const dir = base === undefined ? undefined : await checkedChild($, base, folderName(sessionId))
    if (dir !== undefined) {
      cacheDirs.set(sessionId, dir)
      keepAlive($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // The session's converted copies go with it; the folder is found from the id and checked first.
    await removeSessionCache($, e.sessionId)
    return next(e)
  })

  on('command.run', { command: 'images' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '画像プレビューを開きました。' }
  })

  on('tool.call', { tool: ['Write', 'Edit', 'Read'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && IMAGE_EXT.test(e.file_path)) {
      const { file_path: path, tool_use_id: id } = e
      const place = await placeOf($)
      later($, () => collect($, [[path]], id, undefined, place))
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const output = ran.text ?? (ran.isError === true ? '' : `${ran.result.stdout}\n${ran.result.stderr}`)
    const groups = findImageCandidates(`${e.command}\n${output}`)
    if (groups.length > 0) {
      const id = e.tool_use_id
      const place = await placeOf($)
      later($, () => collect($, groups, id, startedAt, place))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isInline) return next(e)
    const found = await read($, memberOf(byTool, e))
    if (found.length === 0) return next(e)
    const row = await next(e)
    const { Box } = $.ui.resolve(e)
    const columns = Math.max(8, (e.viewport?.columns ?? 80) - 4)
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="column" paddingLeft={2}>
          {found.map(item => thumbnail(e, $, item, columns, inlineRows))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, images)
    if (list.length === 0) return <Text dimColor>まだ画像はありません。</Text>
    const at = Math.min(await read($, cursor), list.length - 1)
    const item = list[at]
    if (item === undefined) return <Text dimColor>まだ画像はありません。</Text>
    const columns = Math.max(8, e.props.bodyColumns - 2)
    // The pane's own room, not the whole screen: a docked pane shares it with tabs and marks.
    const rows = Math.max(4, e.props.scroll.bodyRows - PANE_CHROME_ROWS)
    const step = (by: number) => () => update($, cursor, n => Math.min(list.length - 1, Math.max(0, n + by)))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Button key="prev" hotkey="h" label="◀ 新しい" onPress={step(-1)} />
          <Text dimColor>
            {at + 1} / {list.length}
          </Text>
          <Button key="next" hotkey="l" label="古い ▶" onPress={step(1)} />
        </Box>
        {thumbnail(e, $, item, columns, rows)}
        <Text dimColor wrap="truncate-start">
          {item.path}
        </Text>
      </Box>
    )
  })
}
