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

const frame = atom({ plugin: 'browser-cam', key: 'frame' } as const, null)
const actions = atom({ plugin: 'browser-cam', key: 'actions' } as const, [])
const page = atom({ plugin: 'browser-cam', key: 'page' } as const, {})
const hasAutoOpened = atom({ plugin: 'browser-cam', key: 'hasAutoOpened' } as const, false)

type Shot = { data: string; mime: string }
type Pending = { shot: Shot; toolUseId: string; at: number; seq: number }

// The terminal's own word on fullscreen: another surface's viewport says nothing of it.
let isFullscreen: boolean | undefined
let sessionDir: string | undefined
let written = 0
let finished = 0
// Results are read one at a time, in the order their calls finished.
let queue: Promise<void> = Promise.resolve()
// The newest screenshot seen while no pane was showing: kept, not decoded.
let pending: Pending | undefined

function enqueue($: EngineInterface, work: () => Promise<void>): Promise<void> {
  queue = queue.then(work).catch(err => $.ui.log(`browser-cam: ${String(err)}`, { to: 'debug' }))
  return queue
}

/**
 * `<parent>/<name>` as a folder only this user can reach: made 0700, then checked to be
 * a real directory of ours (not a link, owned by us) right where the parent resolves.
 */
async function privateChild($: EngineInterface, parent: string, name: string): Promise<string | undefined> {
  const dir = `${parent}/${name}`
  const made = await $.process
    .run(['/bin/sh', '-c', 'umask 077 && mkdir -p -m 700 -- "$1" && [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && chmod 700 -- "$1"', 'sh', dir])
    .catch(() => undefined)
  if (made?.exitCode !== 0) return undefined
  const [where, above] = await Promise.all([
    $.fs.stat(dir, { resolve: true }).catch(() => undefined),
    $.fs.stat(parent, { resolve: true }).catch(() => undefined),
  ])
  if (where?.kind !== 'dir' || where.isLink || above?.realPath === undefined) return undefined
  return where.realPath === `${above.realPath}/${name}` ? where.realPath : undefined
}

// TMPDIR when set, else ~/.cache: never a shared /tmp. One folder per session inside it.
async function framesDir($: EngineInterface): Promise<string | undefined> {
  if (sessionDir !== undefined) return sessionDir
  const tmp = (await $.env.get('TMPDIR'))?.replace(/\/+$/, '')
  const home = (await $.env.get('HOME'))?.replace(/\/+$/, '')
  const parent = tmp !== undefined && tmp !== '' ? tmp : home !== undefined && home !== '' ? `${home}/.cache` : undefined
  if (parent === undefined) return undefined
  const base = await privateChild($, parent, DIR_NAME)
  if (base === undefined) return undefined
  sessionDir = await privateChild($, base, (await $.session.id()).replace(/[^\w-]/g, '_'))
  return sessionDir
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

async function drawable($: EngineInterface, item: Pending): Promise<BrowserCamFrame> {
  const base: BrowserCamFrame = { toolUseId: item.toolUseId, seq: item.seq, mime: item.shot.mime, at: item.at }
  const dir = await framesDir($)
  if (dir === undefined) return { ...base, note: '画像の保存先を用意できませんでした' }
  const stem = `${dir}/${item.at}-${written++}`
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
  // A slower frame never covers a later one.
  await update($, frame, old => (old !== null && old.seq > latest.seq ? old : latest))
}

const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

async function ingest(
  $: EngineInterface,
  call: { toolUseId: string; tool: string; summary: string; seq: number; isOpening: boolean },
  ran: { isOk: boolean; result: unknown; seen: { url?: string; title?: string } },
): Promise<void> {
  const at = await $.clock.now()
  const action: BrowserCamAction = { id: call.toolUseId, tool: call.tool, summary: call.summary, isOk: ran.isOk, at }
  await update($, actions, list => [...list.filter(one => one.id !== action.id), action].slice(-KEEP))
  if (ran.seen.url !== undefined || ran.seen.title !== undefined) await update($, page, old => nextPage(old, ran.seen))

  const shot = screenshotOf(ran.result)
  if (shot === undefined) return
  const item: Pending = { shot, toolUseId: call.toolUseId, at, seq: call.seq }
  // No pane to draw into: keep the newest screenshot as it came, decode nothing.
  if (!call.isOpening && !(await isPaneOpen($))) {
    pending = item
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
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // The session's frames go with it; the folder is this plugin's own, checked when made.
    if (sessionDir !== undefined) await $.process.run(['rm', '-rf', '--', sessionDir]).catch(() => undefined)
    sessionDir = undefined
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

    const input = e as unknown as Record<string, unknown>
    const ran = await next(e)
    const result = ran.deny === undefined ? ran.result : undefined
    const isMcpError = typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true
    const name = shortName(tool)
    const call = { toolUseId: e.tool_use_id, tool: name, summary: summarize(input), seq: ++finished, isOpening }
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
