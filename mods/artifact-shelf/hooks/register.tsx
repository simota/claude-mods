import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ShelfItem, ShelfKind } from '../types'
import { absolute, ago, commandOutputs, KIND_ICON, KIND_LABEL, kindOf, search, shelve, size, textOutputs } from './shelf'
import { maskedOf } from './mask'

const PANE = 'artifact-shelf'
const TITLE = '成果物の棚'
const KEEP = 300
const SHOWN = 40
// A file counts as made by a call when it changed from shortly before the call on.
const SLACK_MS = 2_000

const items = atom({ plugin: 'artifact-shelf', key: 'items' } as const, [] as ShelfItem[])
const purpose = atom({ plugin: 'artifact-shelf', key: 'purpose' } as const, '')
const filter = atom({ plugin: 'artifact-shelf', key: 'filter' } as const, { kind: 'all', query: '' } as { kind: ShelfKind | 'all'; query: string })

const SKIP_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch'])
const KIND_FILTERS: (ShelfKind | 'all')[] = ['all', 'data', 'document', 'image', 'video', 'audio', 'patch', 'archive']

let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

// The request an item answered is kept across sessions and shown: credentials in it are masked,
// also in items kept before this was done, as they are read.
const masked = (list: readonly ShelfItem[]): ShelfItem[] =>
  list.map(one => ({ ...one, purpose: maskedOf(String(one.purpose ?? '')), event: maskedOf(String(one.event ?? '')) }))

// The store holds 4 MiB of JSON in all, every repository's shelf together: past this many shelves
// (300 items each run to about 180 KB) the one least recently added to leaves.
const MAX_SHELVES = 16

/** Drops the shelves least recently added to, past MAX_SHELVES; never the one in hand. */
async function keepShelves($: EngineInterface, current: string): Promise<void> {
  const keys = ((await $.store.keys()) as string[]).filter(key => key.startsWith('shelf:') && key !== current)
  if (keys.length < MAX_SHELVES) return
  const newest = await Promise.all(
    keys.map(async key => ({ key, at: Math.max(0, ...((((await $.store.get(key)) as ShelfItem[] | undefined) ?? []).map(one => one.at))) })),
  )
  for (const { key } of newest.sort((a, b) => a.at - b.at).slice(0, keys.length - (MAX_SHELVES - 1))) await $.store.delete(key)
}

const storeKey = async ($: EngineInterface) => `shelf:${(await $.session.repo())?.root ?? (await $.session.cwd())}`

/** Strings in a tool's input that name a file it may have written (`path`, `output_path`, …). */
function inputPaths(input: Record<string, unknown>): string[] {
  return Object.entries(input).flatMap(([key, value]) =>
    typeof value === 'string' && /(?:path|file|filename|output|out|dest|target)$/i.test(key) && value.length < 1024 && kindOf(value) !== undefined ? [value] : [],
  )
}

async function shelveNew($: EngineInterface, candidates: string[], meta: { tool: string; event: string; since: number }): Promise<ShelfItem[]> {
  const cwd = await $.session.cwd()
  const home = await $.env.get('HOME')
  const sessionId = await $.session.id()
  const why = await read($, purpose)
  const found: ShelfItem[] = []
  for (const path of [...new Set(candidates.map(one => absolute(one, cwd, home)))].slice(0, 20)) {
    const kind = kindOf(path)
    if (kind === undefined) continue
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat?.kind !== 'file' || stat.mtimeMs < meta.since - SLACK_MS) continue
    found.push({ path, kind, size: stat.size, at: stat.mtimeMs, tool: meta.tool, event: meta.event, purpose: why, sessionId })
  }
  if (found.length === 0) return found
  const key = await storeKey($)
  const get = async () => masked(((await $.store.get(key)) as ShelfItem[] | undefined) ?? [])
  await serial(async () => {
    await keepShelves($, key)
    let merged = shelve(await get(), found, KEEP)
    await $.store.set(key, merged)
    // Another session may have written in between: read back, and shelve again on top of theirs.
    const stored = await get()
    const again = shelve(stored, found, KEEP)
    if (JSON.stringify(again) !== JSON.stringify(stored)) {
      merged = again
      await $.store.set(key, merged)
    }
    await update($, items, () => merged)
  })
  return found
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'shelf',
      description: '成果物の棚: セッションが作った CSV・PDF・HTML・動画・パッチなどを種類・語・時刻で探す（/shelf [csv|動画|今日|語…]）',
      argumentHint: '[種類 | 拡張子 | 今日 | 7d | 語…]',
    })
    const started = await next(e)
    const key = await storeKey($)
    const raw = ((await $.store.get(key)) as ShelfItem[] | undefined) ?? []
    const stored = masked(raw)
    // A shelf kept before masking is written back masked now, not at its next new item.
    if (JSON.stringify(stored) !== JSON.stringify(raw)) await serial(() => $.store.set(key, stored)).catch(() => undefined)
    await update($, items, () => stored)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && e.command === undefined && !e.isMeta) {
      const text = maskedOf(e.text.slice(0, 65_536)).replace(/\s+/g, ' ').trim()
      // Masked again once cut: a cut can leave what masks further (`Bearer ab…`), and kept as read back it stays the same.
      await update($, purpose, () => maskedOf(text.length > 80 ? `${[...text].slice(0, 79).join('')}…` : text))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (SKIP_TOOLS.has(tool)) return next(e)
    const since = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const input = e as unknown as Record<string, unknown>
    const text = ran.text ?? ''
    let candidates: string[]
    let event: string
    if (tool === 'Write') {
      candidates = typeof input.file_path === 'string' ? [input.file_path] : []
      event = 'Write'
    } else if (tool === 'Bash') {
      const command = String(input.command ?? '')
      candidates = [...commandOutputs(command), ...textOutputs(text)]
      // Only the head is shown: a heredoc of a megabyte is not masked whole on every call.
      event = `Bash: ${maskedOf(command.slice(0, 4_096)).replace(/\s+/g, ' ').slice(0, 120)}`
    } else {
      candidates = [...inputPaths(input), ...textOutputs(text)]
      event = tool
    }
    if (candidates.length === 0) return ran
    const found = await shelveNew($, candidates, { tool, event, since })
    if (found.length > 0) $.ui.toast(`🗄 棚に追加: ${found.map(one => one.path.slice(one.path.lastIndexOf('/') + 1)).join(', ')}`)
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('command.run', { command: 'shelf' }, async ($, e) => {
    const query = e.args.trim()
    await update($, filter, () => ({ kind: 'all', query }))
    // Files gone since they were made are marked, not dropped: the record of the call stays.
    const all = await read($, items)
    const checked = await Promise.all(all.map(async one => ({ ...one, isMissing: (await $.fs.stat(one.path).catch(() => undefined)) === undefined })))
    await update($, items, () => checked)
    await $.ui.open({ id: PANE, title: TITLE })
    const hits = search(checked, query, await $.clock.now())
    if (hits.length === 0) return { text: query === '' ? '🗄 棚はまだ空です。' : `🗄 「${query}」に合う成果物はありません。` }
    return { text: [`🗄 ${hits.length}件${query === '' ? '' : `（${query}）`}`, ...hits.slice(0, 15).map(one => `- ${one.path}${one.isMissing ? '（削除済み）' : ''} — ${one.event}`)].join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, filter)
    const now = await $.clock.now()
    const matched = search(await read($, items), shown.query, now).filter(one => shown.kind === 'all' || one.kind === shown.kind)
    const room = Math.max(2, Math.floor(((e.props.scroll.bodyRows ?? 24) - 3) / 2))
    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap">
          {KIND_FILTERS.map(kind => (
            <Button
              key={`k-${kind}`}
              plain
              label={`${shown.kind === kind ? '●' : '○'}${kind === 'all' ? 'すべて' : KIND_LABEL[kind]} `}
              onPress={() => update($, filter, old => ({ ...old, kind }))}
            />
          ))}
        </Box>
        <Text dimColor>{`${matched.length}件${shown.query === '' ? '' : ` · 「${shown.query}」`}`}</Text>
        {matched.length === 0 && <Text dimColor>該当する成果物はありません。</Text>}
        {matched.slice(0, Math.min(room, SHOWN)).map(one => (
          <Box key={one.path} flexDirection="column">
            <Box>
              <Button key={`copy:${one.path}`} plain onPress={press => $.ui.copy({ text: one.path, surface: press.surface })}>
                {`${KIND_ICON[one.kind]} ${one.path.slice(one.path.lastIndexOf('/') + 1)}`}
                <Text dimColor>{`  ${size(one.size)} · ${ago(now - one.at)}${one.isMissing ? ' · 削除済み' : ''}`}</Text>
              </Button>
            </Box>
            <Text dimColor wrap="truncate-end">{`   ${one.purpose === '' ? '' : `「${one.purpose}」 · `}${one.event} · ${one.path.slice(0, one.path.lastIndexOf('/'))}`}</Text>
          </Box>
        ))}
        {matched.length > room && <Text dimColor>{`…ほか ${matched.length - room} 件（/shelf <語> で絞り込み）`}</Text>}
        <Text dimColor>名前を押すとパスをコピー</Text>
      </Box>
    )
  })
}
