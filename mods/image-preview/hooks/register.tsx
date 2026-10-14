import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, RenderInput, RenderSurface, Register } from 'claude-code'

import type { ImageItem } from '../types'
import {
  IMAGE_EXT,
  absolutize,
  baseName,
  caption,
  cellBox,
  findImagePaths,
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

const images = atom({ plugin: 'image-preview', key: 'images' } as const, [])
const cursor = atom({ plugin: 'image-preview', key: 'cursor' } as const, 0)
const byTool = atom({ plugin: 'image-preview', key: 'byTool' } as const, [])

let cacheDir: string | undefined

async function sips($: EngineInterface, argv: string[]) {
  return $.process.run(['sips', ...argv], { timeoutMs: 15_000 }).catch(() => undefined)
}

async function dimensions($: EngineInterface, path: string, size: number) {
  const ran = await sips($, ['-g', 'pixelWidth', '-g', 'pixelHeight', path])
  const fromSips = ran?.exitCode === 0 ? sipsDimensions(ran.stdout) : undefined
  if (fromSips !== undefined || !isPng(path) || size > 4 * 1024 * 1024) return fromSips
  const bytes = await $.fs.read(path, { as: 'bytes' }).catch(() => undefined)
  return bytes === undefined ? undefined : pngDimensions(bytes.base64)
}

async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Only PNG reaches the terminal's Image: anything else is converted with macOS sips.
async function convertToPng($: EngineInterface, path: string, mtimeMs: number): Promise<string | undefined> {
  if (cacheDir === undefined) {
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    cacheDir = `${tmp}/claude-image-preview`
    await $.process.run(['mkdir', '-p', cacheDir]).catch(() => undefined)
  }
  const out = `${cacheDir}/${await hashOf(`${path}:${mtimeMs}`)}.png`
  const ran = await sips($, ['-s', 'format', 'png', '-Z', String(CONVERT_MAX_PX), path, '--out', out])
  return ran?.exitCode === 0 ? out : undefined
}

async function describe(
  $: EngineInterface,
  path: string,
  toolUseId: string,
  since: number | undefined,
): Promise<ImageItem | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file') return undefined
  if (since !== undefined && stat.mtimeMs < since - SLACK_MS) return undefined

  const item: ImageItem = {
    id: `${path}:${stat.mtimeMs}`,
    path,
    name: baseName(path),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    toolUseId,
  }
  if (stat.size > MAX_BYTES) return { ...item, skipped: '大きすぎるため省略' }

  const dims = await dimensions($, path, stat.size)
  const png = isPng(path) ? path : await convertToPng($, path, stat.mtimeMs)
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
  paths: string[],
  toolUseId: string,
  since: number | undefined,
): Promise<void> {
  const cwd = await $.session.cwd()
  const home = await $.env.get('HOME')
  const absolute = [...new Set(paths.map(path => absolutize(path, cwd, home)))]
  const found: ImageItem[] = []
  for (const path of absolute) {
    if (path === undefined || !IMAGE_EXT.test(path)) continue
    const item = await describe($, path, toolUseId, since)
    if (item !== undefined) found.push(item)
    if (found.length >= PER_CALL) break
  }
  await remember($, found, toolUseId)
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
          source={{ file: item.png, format: 'png', generation: item.mtimeMs }}
          columns={box.columns}
          rows={box.rows}
          alt={label}
        />
        <Text dimColor>🖼 {label}</Text>
      </Box>
    )
  }
  const { Text } = $.ui.resolve(e)
  return (
    <Text key={item.id} dimColor wrap="truncate-end">
      🖼 {label}
      {item.skipped !== undefined ? `（${item.skipped}）` : ''}
    </Text>
  )
}

export const register: Register = (on, options) => {
  const isInline = options.inline !== false
  const inlineRows = Math.min(60, Math.max(1, Number(options.maxRows ?? 12) || 12))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'images', description: 'このセッションの画像をプレビューペインに表示する' })
    return next(e)
  })

  on('command.run', { command: 'images' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '画像プレビューを開きました。' }
  })

  on('tool.call', { tool: ['Write', 'Edit', 'Read'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && IMAGE_EXT.test(e.file_path)) {
      await collect($, [e.file_path], e.tool_use_id, undefined)
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const output = ran.text ?? (ran.isError === true ? '' : `${ran.result.stdout}\n${ran.result.stderr}`)
    const paths = findImagePaths(`${e.command}\n${output}`)
    if (paths.length > 0) await collect($, paths, e.tool_use_id, startedAt)
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
    const rows = Math.max(4, (e.viewport?.rows ?? 30) - 8)
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
