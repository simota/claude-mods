import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mutant, MutationRun } from '../types'
import { apply, changedLines, guessCommand, isMutable, mutantsOf, scoreLine, spread, tallyOf } from './mutate'

const PANE = 'mutation-tap'
const TITLE = 'ミューテーション'
const COPY_KEY = 'copy'
const DIR_NAME = 'claude-mutation-tap'
// Copying a large tree (dependencies included) may take a while.
const COPY_TIMEOUT_MS = 600_000

const run = atom({ plugin: 'mutation-tap', key: 'run' } as const, null as MutationRun | null)
const isStopping = atom({ plugin: 'mutation-tap', key: 'isStopping' } as const, false)

type Options = { max: number; timeoutMs: number; command: string }

/** Changes the run in hand, if there is one. */
const patch = ($: EngineInterface, fn: (old: MutationRun) => MutationRun) => update($, run, old => (old === null ? null : fn(old)))

async function sh($: EngineInterface, root: string, argv: string[], timeoutMs = 30_000) {
  return $.process.run(argv, { cwd: root, timeoutMs }).catch(() => undefined)
}

/**
 * A copy of the repository to mutate, so the working tree is never touched: a copy-on-write clone
 * where the file system has one (APFS `cp -c`, `cp --reflink`), a plain copy otherwise.
 * Dependencies and build output come along, so the tests run as they do in the tree.
 */
async function makeCopy($: EngineInterface, root: string): Promise<string | undefined> {
  const base = ((await $.env.get('TMPDIR')) || `${(await $.env.get('HOME')) ?? ''}/.cache`).replace(/\/+$/, '')
  if (base === '' || base === '/.cache') return undefined
  const dir = `${base}/${DIR_NAME}/${await $.clock.now()}`
  // Kept first, so a reload or a crash mid-copy still removes it at the next start.
  await $.store.set(COPY_KEY, dir)
  const made = await $.process
    .run(
      [
        '/bin/sh',
        '-c',
        'umask 077 && mkdir -p -- "$1" && [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && { cp -cR -- "$2"/. "$1"/ 2>/dev/null || cp -a --reflink=auto -- "$2"/. "$1"/; }',
        'sh',
        dir,
        root,
      ],
      { timeoutMs: COPY_TIMEOUT_MS },
    )
    .catch(() => undefined)
  if (made?.exitCode === 0) return dir
  await removeCopy($, dir)
  return undefined
}

/** Removes a copy this module made: only a folder under its own name, found again from the store. */
async function removeCopy($: EngineInterface, dir: string): Promise<void> {
  if (dir.includes(`/${DIR_NAME}/`) && !dir.includes('..')) await $.process.run(['rm', '-rf', '--', dir], { timeoutMs: 120_000 }).catch(() => undefined)
  await $.store.delete(COPY_KEY)
}

async function testCommand($: EngineInterface, root: string, given: string): Promise<string | undefined> {
  if (given.trim() !== '') return given.trim()
  const names = new Set((await $.fs.list(root).catch(() => [])).map(entry => entry.name))
  const text = (name: string) => (names.has(name) ? $.fs.read(`${root}/${name}`).then(String).catch(() => undefined) : Promise.resolve(undefined))
  return guessCommand(names, await text('package.json'), await text('Makefile'))
}

/** One run of the tests: killed when they fail, timeout when they run past the limit. */
async function runTests($: EngineInterface, root: string, command: string, timeoutMs: number): Promise<'pass' | 'fail' | 'timeout'> {
  const ran = await $.process.run(['/bin/sh', '-c', command], { cwd: root, timeoutMs }).catch(() => undefined)
  if (ran === undefined) return 'timeout'
  return ran.exitCode === 0 ? 'pass' : 'fail'
}

async function mutateAll($: EngineInterface, options: Options, given: string): Promise<void> {
  const at = await $.clock.now()
  const root = (await $.session.repo())?.root ?? (await $.session.cwd())
  const fail = (note: string, command = '') =>
    update($, run, () => ({ status: 'failed', command, root, startedAt: at, finishedAt: at, mutants: [], ran: 0, note }) as MutationRun)

  // Against HEAD; in a repository with no commit yet, the working tree against the index.
  const head = await sh($, root, ['git', 'diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD'])
  const diff = head?.exitCode === 0 ? head : await sh($, root, ['git', 'diff', '-U0', '--no-color', '--no-ext-diff'])
  if (diff === undefined || diff.exitCode !== 0) return void (await fail('git diff を取れませんでした（git リポジトリの外？）'))
  const changed = [...changedLines(diff.stdout)].filter(([path]) => isMutable(path))
  if (changed.length === 0) return void (await fail('HEAD からの変更行に、改変できるソースの行がありません（テストファイル・コメント・import は対象外）'))

  const command = await testCommand($, root, given || options.command)
  if (command === undefined) return void (await fail('テストコマンドが分かりません。/mutate <コマンド> で指定するか、testCommand を設定してください'))

  await update($, isStopping, () => false)
  await update($, run, (): MutationRun => ({ status: 'running', command, root, startedAt: at, mutants: [], ran: 0, note: 'リポジトリの複製を作成中' }))
  $.ui.status('🧬 複製を作成中')
  const copy = await makeCopy($, root)
  if (copy === undefined) {
    $.ui.status(undefined)
    return void (await fail('リポジトリの複製を作れませんでした（TMPDIR の空き容量を確認してください）', command))
  }

  try {
    // The mutants come from the copy, so they match the files they are written into.
    const byLine: Mutant[][] = []
    for (const [path, lines] of changed) {
      const text = await $.fs.read(`${copy}/${path}`).then(String).catch(() => undefined)
      if (text === undefined) continue
      const all = text.split('\n')
      for (const n of lines) byLine.push(mutantsOf(path, n, all[n - 1] ?? ''))
    }
    const mutants = spread(byLine.filter(list => list.length > 0), options.max)
    if (mutants.length === 0) return void (await fail('HEAD からの変更行に、改変できるソースの行がありません（テストファイル・コメント・import は対象外）', command))

    await patch($, old => ({ ...old, mutants, note: '変更前のテストを実行中' }))
    $.ui.status('🧬 ベースライン実行中')
    const baseline = await runTests($, copy, command, options.timeoutMs)
    if (baseline !== 'pass') {
      return void (await fail(baseline === 'timeout' ? 'テストが時間内に終わりませんでした（timeoutSec を延ばしてください）' : '改変前のテストが既に失敗しています。通る状態にしてから実行してください', command))
    }

    for (const [index, mutant] of mutants.entries()) {
      if (await read($, isStopping)) {
        const now = await $.clock.now()
        await patch($, old => ({ ...old, status: 'stopped', finishedAt: now, note: '停止しました' }))
        return
      }
      const file = `${copy}/${mutant.path}`
      const original = await $.fs.read(file).then(String).catch(() => undefined)
      const mutated = original === undefined ? undefined : apply(original, mutant)
      let outcome: Mutant['outcome'] = 'skipped'
      if (original !== undefined && mutated !== undefined) {
        await $.fs.write(file, mutated)
        try {
          const result = await runTests($, copy, command, options.timeoutMs)
          outcome = result === 'pass' ? 'survived' : result === 'fail' ? 'killed' : 'timeout'
        } finally {
          await $.fs.write(file, original)
        }
      }
      const done = await patch($, old => ({ ...old, ran: index + 1, mutants: old.mutants.map((one, i) => (i === index ? { ...one, outcome } : one)), note: undefined }))
      const t = tallyOf(done?.mutants ?? [])
      $.ui.status(`🧬 ${index + 1}/${mutants.length} · 生存 ${t.survived}`)
    }

    const end = await $.clock.now()
    const finished = await patch($, old => ({ ...old, status: 'done', finishedAt: end }))
    const t = tallyOf(finished?.mutants ?? [])
    $.ui.toast(t.survived > 0 ? `🧬 テストが見逃した改変 ${t.survived}件 — /mutate show` : `🧬 すべての改変をテストが検出（${scoreLine(t)}）`)
  } finally {
    $.ui.status(undefined)
    await removeCopy($, copy)
  }
}

export const register: Register = (on, options) => {
  const settings: Options = {
    max: Math.max(1, Math.min(200, Number(options.maxMutants ?? 20) || 20)),
    timeoutMs: Math.max(5, Math.min(600, Number(options.timeoutSec ?? 300) || 300)) * 1000,
    command: typeof options.testCommand === 'string' ? options.testCommand : '',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mutate',
      description: 'HEAD からの変更行に限ったミューテーションテスト（/mutate [テストコマンド] · show · stop）',
      argumentHint: '[テストコマンド | show | stop]',
    })
    const started = await next(e)
    // A copy left behind by a run cut short (a reload, a crash) is removed.
    const left = await $.store.get(COPY_KEY)
    if (typeof left === 'string') await removeCopy($, left)
    const last = await read($, run)
    if (last?.status === 'running') await patch($, old => ({ ...old, status: 'stopped', note: '再読み込みで中断されました' }))
    return started
  })

  on('command.run', { command: 'mutate' }, async ($, e) => {
    const args = e.args.trim()
    const current = await read($, run)
    if (args === 'stop') {
      if (current?.status !== 'running') return { text: '🧬 実行中のミューテーションはありません。' }
      await update($, isStopping, () => true)
      return { text: '🧬 今の改変が終わったら停止します。' }
    }
    if (args === 'show') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: current === null ? '🧬 まだ実行していません。' : `🧬 ${scoreLine(tallyOf(current.mutants))}` }
    }
    if (current?.status === 'running') return { text: '🧬 実行中です。/mutate stop で止められます。' }

    await update($, run, () => null)
    $.clock.after(0, () => {
      void mutateAll($, settings, args).catch(async err => {
        $.ui.status(undefined)
        await patch($, old => ({ ...old, status: 'failed', note: String(err) }))
      })
    })
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '🧬 ミューテーションテストを開始しました。リポジトリの複製で実行するので、作業ツリーは書き換えません。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const shown = await read($, run)
    if (shown === null) return <Text dimColor>準備中…</Text>

    const t = tallyOf(shown.mutants)
    const survivors = shown.mutants.filter(one => one.outcome === 'survived')
    const room = Math.max(1, Math.floor(((e.props.scroll.bodyRows ?? 24) - 5) / 3))
    const head =
      shown.status === 'running'
        ? `🧬 実行中 ${shown.ran}/${shown.mutants.length} · ${scoreLine(t)}`
        : shown.status === 'done'
          ? `🧬 完了 ${shown.mutants.length}件 · ${scoreLine(t)}`
          : shown.status === 'stopped'
            ? `🧬 停止 ${shown.ran}/${shown.mutants.length} · ${scoreLine(t)}`
            : '🧬 実行できませんでした'
    return (
      <Box flexDirection="column">
        <Text bold>{head}</Text>
        {shown.command !== '' && <Text dimColor wrap="truncate-end">{`$ ${shown.command}`}</Text>}
        {shown.note !== undefined && <Text color={shown.status === 'failed' ? 'red' : undefined}>{shown.note}</Text>}
        {survivors.length > 0 && <Text color="yellow">テストが見逃した改変:</Text>}
        {survivors.slice(0, room).map((one, index) => (
          <Box key={`s-${index}`} flexDirection="column">
            <Text wrap="truncate-end">{`✗ ${one.path}:${one.line}  ${one.operator}`}</Text>
            <Text dimColor wrap="truncate-end">{`  - ${one.original}`}</Text>
            <Text color="yellow" wrap="truncate-end">{`  + ${one.mutated}`}</Text>
          </Box>
        ))}
        {survivors.length > room && <Text dimColor>{`…ほか ${survivors.length - room} 件`}</Text>}
        {shown.status === 'done' && survivors.length === 0 && <Text color="green">見逃された改変はありません。</Text>}
      </Box>
    )
  })
}
