import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BrowserCamAction, BrowserCamFrame } from '../types'
import {
  BROWSER_TOOL,
  cellBox,
  decodedBytes,
  pageOf,
  pngDimensions,
  screenshotOf,
  shortName,
  sipsDimensions,
  summarize,
} from './cam'

const PANE = 'browser-cam'
const TITLE = 'ブラウザ'
const KEEP = 30
const SHOWN = 8
// Image takes PNG bytes up to 2 MiB decoded; bigger ones and other formats go through a file.
const MAX_INLINE_BYTES = 2 * 1024 * 1024

const frame = atom({ plugin: 'browser-cam', key: 'frame' } as const, null)
const actions = atom({ plugin: 'browser-cam', key: 'actions' } as const, [])
const page = atom({ plugin: 'browser-cam', key: 'page' } as const, {})

// Learnt from drawings and commands: session.start carries no viewport.
let isFullscreen: boolean | undefined
let hasAutoOpened = false
let cacheDir: string | undefined
let written = 0

async function frameDir($: EngineInterface): Promise<string> {
  if (cacheDir === undefined) {
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    cacheDir = `${tmp}/claude-browser-cam`
    await $.process.run(['mkdir', '-p', cacheDir])
  }
  return cacheDir
}

// The bytes leave through the shell's base64, since $.fs writes text only.
async function writeBytes($: EngineInterface, path: string, base64: string): Promise<boolean> {
  const ran = await $.process.run(['/bin/sh', '-c', 'base64 -d > "$1"', 'sh', path], { stdin: base64 })
  return ran.exitCode === 0
}

async function drawable($: EngineInterface, shot: { data: string; mime: string }, toolUseId: string, at: number) {
  const base: BrowserCamFrame = { toolUseId, mime: shot.mime, at }
  const isPng = shot.mime === 'image/png'
  if (isPng && decodedBytes(shot.data) <= MAX_INLINE_BYTES) {
    return { ...base, ...pngDimensions(shot.data), source: { png: shot.data } }
  }

  // Two files taken in turn, so the terminal never reads one being written.
  const dir = await frameDir($)
  const slot = written++ % 2
  const png = `${dir}/frame-${slot}.png`
  if (isPng) {
    if (!(await writeBytes($, png, shot.data))) return { ...base, note: '画像を書き出せませんでした' }
    return { ...base, ...pngDimensions(shot.data), source: { file: png, format: 'png' as const, generation: at } }
  }
  const raw = `${dir}/raw-${slot}`
  if (!(await writeBytes($, raw, shot.data))) return { ...base, note: '画像を書き出せませんでした' }
  const converted = await $.process.run(['sips', '-s', 'format', 'png', raw, '--out', png], { timeoutMs: 15_000 }).catch(() => undefined)
  if (converted?.exitCode !== 0) return { ...base, note: `${shot.mime} を PNG に変換できませんでした` }
  const measured = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', png]).catch(() => undefined)
  return {
    ...base,
    ...(measured?.exitCode === 0 ? sipsDimensions(measured.stdout) : undefined),
    source: { file: png, format: 'png' as const, generation: at },
  }
}

async function ingest(
  $: EngineInterface,
  call: { toolUseId: string; tool: string; summary: string; url?: string },
  ran: { isOk: boolean; result: unknown; text?: string },
): Promise<void> {
  const at = await $.clock.now()
  const action: BrowserCamAction = { id: call.toolUseId, tool: call.tool, summary: call.summary, isOk: ran.isOk, at }
  await update($, actions, list => [...list.filter(one => one.id !== action.id), action].slice(-KEEP))

  const seen = pageOf(ran.text ?? '')
  const url = seen.url ?? call.url
  if (url !== undefined || seen.title !== undefined) {
    await update($, page, old => ({ ...old, ...(url !== undefined ? { url } : {}), ...(seen.title !== undefined ? { title: seen.title } : {}) }))
  }

  const shot = screenshotOf(ran.result)
  if (shot !== undefined) {
    const latest = await drawable($, shot, call.toolUseId, at)
    await update($, frame, () => latest)
  }
}

export const register: Register = (on, options) => {
  const isAutoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cam', description: 'ブラウザ操作の画面と履歴を表示するペインを開閉する' })
    return next(e)
  })

  on('command.run', { command: 'cam' }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'ブラウザペインを閉じました。' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'ブラウザペインを開きました。' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!BROWSER_TOOL.test(tool)) return next(e)

    if (isAutoOpen && isFullscreen === true && !hasAutoOpened) {
      hasAutoOpened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }

    const input = e as unknown as Record<string, unknown>
    const ran = await next(e)
    const result = ran.deny === undefined ? ran.result : undefined
    const isMcpError = typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true
    const call = {
      toolUseId: e.tool_use_id,
      tool: shortName(tool),
      summary: summarize(input),
      ...(typeof input.url === 'string' ? { url: input.url } : {}),
    }
    const outcome = { isOk: ran.deny === undefined && ran.isError !== true && !isMcpError, result, text: ran.text }
    // Read the screenshot from a timer, so decoding and conversion never hold the result back from the model.
    $.clock.after(0, () => {
      ingest($, call, outcome).catch(err => $.ui.log(`browser-cam: ${String(err)}`, { to: 'debug' }))
    })
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('command.run', ($, e, next) => {
    isFullscreen = e.presentation.isFullscreen
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
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
      const rows = Math.max(4, (e.viewport?.rows ?? 30) - SHOWN - 6)
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
