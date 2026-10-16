import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FogFile, FogRepo } from '../types'
import {
  areaOf,
  bar,
  bashTouches,
  capFiles,
  countsOf,
  editChange,
  errorPaths,
  importPattern,
  inRepo,
  milestoneOf,
  rowsOf,
  statusOf,
  treeOf,
  warningsOf,
  withEdit,
  withError,
  withRead,
} from './fog'

const PANE = 'fog-map'
const TITLE = '探索マップ'

const repo = atom({ plugin: 'fog-map', key: 'repo' } as const, null as FogRepo | null)
const touched = atom({ plugin: 'fog-map', key: 'touched' } as const, {} as Record<string, FogFile>)
const focus = atom({ plugin: 'fog-map', key: 'focus' } as const, null as string | null)
const importers = atom({ plugin: 'fog-map', key: 'importers' } as const, {} as Record<string, string[]>)
const areas = atom({ plugin: 'fog-map', key: 'areas' } as const, [] as string[])
const milestone = atom({ plugin: 'fog-map', key: 'milestone' } as const, 0)
// Built from the file list once each time it changes, not on every call or every draw.
const tracked = derive([repo], known => new Set(known?.files ?? []))
const tree = derive([repo], known => treeOf(known?.files ?? []))

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// Commands after which the repository's file list is read again.
const RESHAPES = /\bgit\s+(?:checkout|switch|pull|merge|rebase|mv|rm|stash)\b|\b(?:mv|rm|cp)\s/

async function git($: EngineInterface, cwd: string, argv: string[]): Promise<string | undefined> {
  const ran = await $.process.run(['git', ...argv], { cwd, timeoutMs: 15_000 }).catch(() => undefined)
  return ran?.exitCode === 0 ? ran.stdout : undefined
}

/** The repository the session works in and its files; null outside a git repository. */
async function loadRepo($: EngineInterface): Promise<void> {
  const root = (await $.session.repo())?.root
  if (root === undefined) {
    await update($, repo, () => null)
    return
  }
  const [listed, branch] = await Promise.all([git($, root, ['ls-files', '-z']), git($, root, ['branch', '--show-current'])])
  const files = capFiles((listed ?? '').split('\0').filter(Boolean).slice(0, 50_000))
  const name = root.split('/').filter(Boolean).pop() ?? root
  await update($, repo, () => ({ root, name, branch: branch?.trim() || 'detached', files }))
}

/** The repository's root, else the session's directory: paths outside it are not mapped. */
async function placeOf($: EngineInterface): Promise<{ root: string; cwd: string; files: Set<string> }> {
  const known = await read($, repo)
  const cwd = await $.session.cwd()
  return { root: known?.root ?? cwd, cwd, files: new Set(known?.files ?? []) }
}

/** Finds, once per edited file, the files importing it (JS/TS and Python, by git grep). */
async function findImporters($: EngineInterface, path: string): Promise<void> {
  if ((await read($, importers))[path] !== undefined) return
  const known = await read($, repo)
  const pattern = importPattern(path)
  if (known === null || pattern === undefined) return
  const out = await git($, known.root, ['grep', '-l', '-E', pattern])
  const list = (out ?? '').split('\n').filter(line => line !== '' && line !== path).slice(0, 50)
  await update($, importers, all => ({ ...all, [path]: list }))
}

/** Marks what a call did, then redraws the status line and announces what is worth a toast. */
async function mark($: EngineInterface, change: (all: Record<string, FogFile>) => Record<string, FogFile>, last: string | undefined): Promise<void> {
  const before = await read($, touched)
  const after = await update($, touched, change)
  if (last !== undefined) await update($, focus, () => last)

  const known = await read($, repo)
  const counts = countsOf(after, known?.files ?? [], await read($, tracked))
  const warnings = warningsOf(after, await read($, importers))
  $.ui.status(statusOf(counts, warnings.length, known !== null))

  const notes: string[] = []
  const reached = milestoneOf(await read($, milestone), counts.percent)
  if (known !== null && reached !== undefined) {
    await update($, milestone, () => reached)
    notes.push(`🗺 探索率 ${reached}% 到達`)
  }
  const newlyEdited = Object.keys(after).filter(path => (after[path]?.edits ?? 0) > 0 && (before[path]?.edits ?? 0) === 0)
  const seen = await read($, areas)
  const fresh = [...new Set(newlyEdited.map(areaOf))].filter(area => !seen.includes(area))
  if (fresh.length > 0) {
    await update($, areas, list => [...list, ...fresh])
    notes.push(`🗺 新しい区域を開拓: ${fresh.join(' ')}`)
  }
  if (notes.length > 0) $.ui.toast(notes.join(' · '))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'map', description: '探索マップを開く: Claude が読んだ・編集したファイルを、未踏の場所を霧にして表示' })
    const started = await next(e)
    await loadRepo($).catch(() => undefined)
    await mark($, all => all, undefined)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const isEdit = EDIT_TOOLS.has(tool)
    if (tool !== 'Read' && tool !== 'Bash' && !isEdit) return next(e)

    const place = await placeOf($)
    const target = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    const path = target === undefined ? undefined : inRepo(target, place.root, place.cwd)
    // Asked before a Write runs: whether it makes a new file, and what it writes over, so its
    // lines count as a diff stat would rather than as the whole file added.
    const before = tool === 'Write' && path !== undefined ? await $.fs.read(`${place.root}/${path}`).catch(() => undefined) : undefined
    const isNew = tool === 'Write' && path !== undefined && before === undefined
      ? (await $.fs.stat(`${place.root}/${path}`).catch(() => undefined)) === undefined
      : false

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const at = await $.clock.now()

    if (tool === 'Read' && path !== undefined && ran.isError !== true) {
      await mark($, all => ({ ...all, [path]: withRead(all[path], at) }), path)
    } else if (isEdit && path !== undefined && ran.isError !== true) {
      const change =
        tool === 'Edit'
          ? editChange(String(input.old_string ?? ''), String(input.new_string ?? ''))
          : tool === 'Write'
            ? editChange(typeof before === 'string' ? before : '', String(input.content ?? ''))
            : editChange('', String(input.new_source ?? ''))
      await mark($, all => ({ ...all, [path]: withEdit(all[path], { ...change, isNew }, at) }), path)
      if (isNew) await update($, repo, old => (old === null ? old : { ...old, files: [...old.files, path] }))
      void findImporters($, path).catch(() => undefined)
    } else if (tool === 'Bash') {
      const command = String(input.command ?? '')
      const known = (word: string, cwd: string) => {
        const one = inRepo(word, place.root, cwd)
        return one !== undefined && place.files.has(one) ? one : undefined
      }
      const { reads, edits } = bashTouches(command, place.cwd, known)
      const failed = ran.isError === true ? errorPaths(ran.text ?? '').flatMap(word => known(word, place.cwd) ?? []) : []
      if (reads.length + edits.length + failed.length > 0) {
        await mark(
          $,
          all => {
            const marked = { ...all }
            for (const one of reads) marked[one] = withRead(marked[one], at)
            for (const one of edits) marked[one] = withEdit(marked[one], { added: 0, removed: 0 }, at)
            for (const one of failed) marked[one] = withError(marked[one], at)
            return marked
          },
          [...edits, ...reads, ...failed].at(-1),
        )
      }
      if (ran.isError !== true && RESHAPES.test(command)) await loadRepo($).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('command.run', { command: 'map' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    const known = await read($, repo)
    const counts = countsOf(await read($, touched), known?.files ?? [], await read($, tracked))
    return { text: known === null ? `🗺 git リポジトリの外です（編集 ${counts.edited}）` : `🗺 探索率 ${counts.percent}% · ${counts.touched}/${counts.total}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const known = await read($, repo)
    const all = await read($, touched)
    const counts = countsOf(all, known?.files ?? [], await read($, tracked))
    const warnings = warningsOf(all, await read($, importers))
    const width = Math.max(30, e.props.bodyColumns - 2)
    const rows = rowsOf(known?.files ?? [], all, await read($, focus), width, await read($, tree))
    const room = Math.max(3, (e.viewport?.rows ?? e.props.scroll.bodyRows ?? 24) - 5 - Math.min(3, warnings.length))
    const color = { error: 'red', new: 'green', edit: 'yellow', 'focus-dir': 'cyan' } as Record<string, string>

    return (
      <Box flexDirection="column">
        <Text bold>
          {known === null
            ? `🗺 リポジトリの外 · 編 ${counts.edited}`
            : `🗺 探索率 ${counts.percent}%  ${bar(counts.percent, 20)}  読 ${counts.read} · 編 ${counts.edited} · ✗ ${counts.errors} / ${counts.total}`}
        </Text>
        {known !== null && <Text dimColor>{`${known.name} · ${known.branch}`}</Text>}
        {rows.length === 0 && <Text dimColor>まだどこにも踏み込んでいません。Claude がファイルを読むと霧が晴れていきます。</Text>}
        {rows.slice(0, room).map((row, index) => (
          <Text key={`row-${index}`} wrap="truncate-end" color={color[row.kind]} dimColor={row.kind === 'fog'} bold={row.kind === 'dir' || row.kind === 'focus-dir'}>
            {`${'  '.repeat(row.depth)}${row.text}`}
          </Text>
        ))}
        {rows.length > room && <Text dimColor>{`…ほか ${rows.length - room} 行`}</Text>}
        {warnings.slice(0, 3).map((note, index) => (
          <Text key={`warn-${index}`} color="yellow" wrap="truncate-end">{`⚠ ${note}`}</Text>
        ))}
        {warnings.length > 3 && <Text dimColor>{`⚠ ほか ${warnings.length - 3} 件`}</Text>}
        <Text dimColor>░ 未踏  ○ 読んだ  ● 編集  ✚ 新規  ✗ エラー  ★ 直前</Text>
      </Box>
    )
  })
}
