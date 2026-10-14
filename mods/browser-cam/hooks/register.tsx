import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BrowserCamAction, BrowserCamFrame } from '../types'
import { BROWSER_TOOL, cellBox, nextPage, pageFrom, pngDimensions, screenshotOf, shortName, sipsDimensions, summarize } from './cam'

const PANE = 'browser-cam'
const TITLE = 'ブラウザ'
const KEEP = 30
const SHOWN = 8
const DIR_NAME = 'claude-browser-cam'
// Frame files kept in the session's folder; the terminal reads only the newest.
const FRAMES_KEPT = 4
const ENDED_KEPT = 10
// A session's folder left behind (the process was killed before session.end) goes after a day.
const STALE_MS = 24 * 60 * 60 * 1000

const frame = atom({ plugin: 'browser-cam', key: 'frame' } as const, null)
const actions = atom({ plugin: 'browser-cam', key: 'actions' } as const, [])
const page = atom({ plugin: 'browser-cam', key: 'page' } as const, {})
const hasAutoOpened = atom({ plugin: 'browser-cam', key: 'hasAutoOpened' } as const, false)
const lastSeq = atom({ plugin: 'browser-cam', key: 'seq' } as const, 0)
const endedSessions = atom({ plugin: 'browser-cam', key: 'endedSessions' } as const, [] as string[])

type Shot = { data: string; mime: string }
type Pending = { shot: Shot; toolUseId: string; at: number; seq: number; sessionId: string }

// The terminal's own word on fullscreen: another surface's viewport says nothing of it.
let isFullscreen: boolean | undefined
// Session folders made and checked by this load of the module, by session id.
const sessionDirs = new Map<string, string>()
// Results are read one at a time, in the order their calls finished.
let queue: Promise<void> = Promise.resolve()
// The newest screenshot seen while no pane was showing: kept, not decoded.
let pending: Pending | undefined

function enqueue($: EngineInterface, work: () => Promise<void>): Promise<void> {
  queue = queue.then(work).catch(err => $.ui.log(`browser-cam: ${String(err)}`, { to: 'debug' }))
  return queue
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
 * a real directory of ours (not a link, owned by us) right where the parent resolves.
 */
async function privateChild($: EngineInterface, parent: string, name: string): Promise<string | undefined> {
  const made = await $.process
    .run(['/bin/sh', '-c', 'umask 077 && mkdir -p -m 700 -- "$1" && [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && chmod 700 -- "$1"', 'sh', `${parent}/${name}`])
    .catch(() => undefined)
  if (made?.exitCode !== 0) return undefined
  return checkedChild($, parent, name)
}

const hasEnded = async ($: EngineInterface, sessionId: string) => (await read($, endedSessions)).includes(sessionId)

// One folder per session, derived from its id. An ended session's folder is never made again.
async function framesDir($: EngineInterface, sessionId: string): Promise<string | undefined> {
  if (await hasEnded($, sessionId)) return undefined
  const known = sessionDirs.get(sessionId)
  if (known !== undefined) return known
  const parent = await rootDir($)
  if (parent === undefined) return undefined
  const base = await privateChild($, parent, DIR_NAME)
  if (base === undefined) return undefined
  const dir = await privateChild($, base, folderName(sessionId))
  if (dir !== undefined) sessionDirs.set(sessionId, dir)
  return dir
}

// The plugin's base folder as it already stands; nothing is made.
async function existingBase($: EngineInterface): Promise<string | undefined> {
  const parent = await rootDir($)
  return parent === undefined ? undefined : checkedChild($, parent, DIR_NAME)
}

// The folder is found again from the id alone, so a reload since it was made still removes it.
async function removeSessionDir($: EngineInterface, sessionId: string): Promise<void> {
  sessionDirs.delete(sessionId)
  const base = await existingBase($)
  if (base === undefined) return
  const dir = await checkedChild($, base, folderName(sessionId))
  if (dir !== undefined) await $.process.run(['rm', '-rf', '--', dir]).catch(() => undefined)
}

// Folders of sessions that never reached session.end (a killed process), once a day old.
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

// Never onto a file already there (`set -C`): every frame takes a fresh name.
async function writeNew($: EngineInterface, path: string, base64: string): Promise<boolean> {
  const ran = await $.process.run(['/bin/sh', '-c', 'set -C && base64 -d > "$1"', 'sh', path], { stdin: base64 }).catch(() => undefined)
  return ran?.exitCode === 0
}

async function pruneFrames($: EngineInterface, dir: string): Promise<void> {
  await $.process
    .run(['/bin/sh', '-c', 'cd -- "$1" && ls -t | tail -n +"$2" | while IFS= read -r f; do rm -f -- "$f"; done', 'sh', dir, String(FRAMES_KEPT + 1)])
    .catch(() => undefined)
}

async function drawable($: EngineInterface, item: Pending): Promise<BrowserCamFrame | undefined> {
  const base: BrowserCamFrame = { toolUseId: item.toolUseId, seq: item.seq, sessionId: item.sessionId, mime: item.shot.mime, at: item.at }
  if (await hasEnded($, item.sessionId)) return undefined
  const dir = await framesDir($, item.sessionId)
  if (dir === undefined) return { ...base, note: '画像の保存先を用意できませんでした' }
  // The call's order number is kept in state, so a name is never reused, reload or not.
  const stem = `${dir}/${item.seq}-${item.at}`
  const png = `${stem}.png`
  const source = { file: png, format: 'png' as const, generation: item.seq }

  if (item.shot.mime === 'image/png') {
    if (!(await writeNew($, png, item.shot.data))) return { ...base, note: '画像を書き出せませんでした' }
    await pruneFrames($, dir)
    return { ...base, ...pngDimensions(item.shot.data), source }
  }
  const raw = `${stem}.raw`
  if (!(await writeNew($, raw, item.shot.data))) return { ...base, note: '画像を書き出せませんでした' }
  const converted = await $.process.run(['sips', '-s', 'format', 'png', raw, '--out', png], { timeoutMs: 15_000 }).catch(() => undefined)
  if (converted?.exitCode !== 0) return { ...base, note: `${item.shot.mime} を PNG に変換できませんでした` }
  const measured = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', png]).catch(() => undefined)
  await pruneFrames($, dir)
  return { ...base, ...(measured?.exitCode === 0 ? sipsDimensions(measured.stdout) : undefined), source }
}

async function draw($: EngineInterface, item: Pending): Promise<void> {
  const latest = await drawable($, item)
  if (latest === undefined) return
  // A slower frame never covers a later one; the order survives a reload, being in state.
  await update($, frame, old => (old !== null && old.seq > latest.seq ? old : latest))
}

const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

async function ingest(
  $: EngineInterface,
  call: { toolUseId: string; tool: string; summary: string; seq: number; isOpening: boolean; sessionId: string },
  ran: { isOk: boolean; result: unknown; seen: { url?: string; title?: string } },
): Promise<void> {
  // Work queued before its session ended writes nothing into the next one.
  if (await hasEnded($, call.sessionId)) return
  const at = await $.clock.now()
  const action: BrowserCamAction = { id: call.toolUseId, tool: call.tool, summary: call.summary, isOk: ran.isOk, at }
  await update($, actions, list => [...list.filter(one => one.id !== action.id), action].slice(-KEEP))
  if (ran.seen.url !== undefined || ran.seen.title !== undefined) await update($, page, old => nextPage(old, ran.seen))

  const shot = screenshotOf(ran.result)
  if (shot === undefined) return
  const item: Pending = { shot, toolUseId: call.toolUseId, at, seq: call.seq, sessionId: call.sessionId }
  // No pane to draw into: keep the newest screenshot as it came, decode nothing.
  if (!call.isOpening && !(await isPaneOpen($))) {
    if (pending === undefined || pending.seq < item.seq) pending = item
    return
  }
  pending = undefined
  await draw($, item)
}

// Opened unasked: a refusal goes to the debug log, never into the tool call.
async function openUnasked($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE }).catch(err => $.ui.log(`browser-cam: ${String(err)}`, { to: 'debug' }))
}

export const register: Register = (on, options) => {
  const isAutoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cam', description: 'ブラウザ操作の画面と履歴を表示するペインを開閉する' })
    // A new session shows nothing of an earlier one; a hot reload (session.start again,
    // same session) keeps its own frame.
    const sessionId = await $.session.id()
    pending = undefined
    await update($, frame, old => (old !== null && old.sessionId !== sessionId ? null : old))
    await sweepStale($, sessionId)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation with no session.start after it: what it showed goes now.
    await update($, endedSessions, list => [...list.filter(id => id !== e.sessionId), e.sessionId].slice(-ENDED_KEPT))
    pending = undefined
    await update($, frame, () => null)
    await update($, actions, () => [])
    await update($, page, () => ({}))
    // The session's frames go with it; the folder is found from the id and checked before removal.
    await removeSessionDir($, e.sessionId)
    return next(e)
  })

  on('command.run', { command: 'cam' }, async $ => {
    if (await isPaneOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'ブラウザペインを閉じました。' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    const waiting = pending
    pending = undefined
    if (waiting !== undefined) void enqueue($, () => draw($, waiting))
    return { text: 'ブラウザペインを開きました。' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!BROWSER_TOOL.test(tool)) return next(e)

    let isOpening = false
    if (isAutoOpen && isFullscreen === true && !(await read($, hasAutoOpened))) {
      await update($, hasAutoOpened, () => true)
      isOpening = true
      void openUnasked($)
    }

    const sessionId = await $.session.id()
    const input = e as unknown as Record<string, unknown>
    const ran = await next(e)
    const result = ran.deny === undefined ? ran.result : undefined
    const isMcpError = typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true
    const name = shortName(tool)
    const seq = await update($, lastSeq, n => n + 1)
    const call = { toolUseId: e.tool_use_id, tool: name, summary: summarize(input), seq, isOpening, sessionId }
    const outcome = {
      isOk: ran.deny === undefined && ran.isError !== true && !isMcpError,
      result,
      seen: pageFrom(name, input, ran.text ?? ''),
    }
    // Read the screenshot from a timer, so decoding and conversion never hold the result back from the model.
    $.clock.after(0, () => enqueue($, () => ingest($, call, outcome)))
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  // Learned from the band's viewport, not from every command.run: a hook there would
  // put this plugin's name on the output of every slash command.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.surface === 'terminal' && e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const shown = await read($, frame)
    const list = await read($, actions)
    const where = await read($, page)

    if (shown === null && list.length === 0) {
      return <Text dimColor>まだブラウザ操作はありません。</Text>
    }

    const recent = list.slice(-SHOWN).reverse()
    const location = [where.title, where.url].filter(Boolean).join(' — ')
    const history = (
      <Box flexDirection="column">
        {location !== '' && (
          <Text dimColor wrap="truncate-end">
            🌐 {location}
          </Text>
        )}
        {recent.map(one => (
          <Text key={one.id} wrap="truncate-end" color={one.isOk ? undefined : 'red'}>
            {one.isOk ? '✓' : '✗'} {one.tool}
            {one.summary !== '' ? `: ${one.summary}` : ''}
          </Text>
        ))}
      </Box>
    )

    const noteOf = (one: BrowserCamFrame) => one.note ?? `${one.mime}${one.width !== undefined ? ` · ${one.width}×${one.height}` : ''}`

    if (e.surface === 'terminal' && shown?.source !== undefined) {
      const { Image } = $.ui.resolve(e)
      // The pane's own room, less the history under the picture and the location line.
      const rows = Math.max(4, e.props.scroll.bodyRows - SHOWN - 2)
      const box = cellBox(shown, Math.max(8, e.props.bodyColumns - 1), rows)
      return (
        <Box flexDirection="column">
          <Image key="view" source={shown.source} columns={box.columns} rows={box.rows} alt={`スクリーンショット (${noteOf(shown)})`} />
          {history}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {shown !== null && <Text dimColor>📷 最新のスクリーンショット: {noteOf(shown)}</Text>}
        {history}
      </Box>
    )
  })
}
