import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PerfReport, PerfSample } from '../types'
import { baselineKey, commandStderr, isSafeRef, parseArgs, parseTime, reportLines, statsOf, verdictOf } from './delta'

const PANE = 'perf-delta'
const TITLE = '性能差'
const BASELINES = 'baselines'
const KEEP_BASELINES = 30

const report = atom({ plugin: 'perf-delta', key: 'report' } as const, null as PerfReport | null)

type Settings = { runs: number; timeoutMs: number }

// Whether /usr/bin/time takes -l (BSD, macOS) or -v (GNU), learned once per load.
let timeFlag: '-l' | '-v' | null | undefined
let isBusy = false

async function flagOf($: EngineInterface): Promise<'-l' | '-v' | null> {
  if (timeFlag !== undefined) return timeFlag
  const exists = await $.fs.exists('/usr/bin/time').catch(() => false)
  const os = exists ? await $.process.run(['uname', '-s']).catch(() => undefined) : undefined
  timeFlag = !exists ? null : os?.stdout.trim() === 'Darwin' ? '-l' : '-v'
  return timeFlag
}

/** One warm-up run, then `runs` measured ones, in `cwd`. Throws on a failing run. */
async function measure($: EngineInterface, cwd: string, command: string, label: string, s: Settings): Promise<PerfSample> {
  const flag = await flagOf($)
  const argv = flag === null ? ['/bin/sh', '-c', command] : ['/usr/bin/time', flag, '/bin/sh', '-c', command]
  const timesMs: number[] = []
  const rssBytes: number[] = []
  for (let i = 0; i <= s.runs; i += 1) {
    await update($, report, old => (old === null ? null : { ...old, note: `${label}: ${i === 0 ? 'ウォームアップ' : `${i}/${s.runs} 回目`}` }))
    const started = await $.clock.now()
    let failure: unknown
    const ran = await $.process.run(argv, { cwd, timeoutMs: s.timeoutMs }).catch(err => {
      failure = err
      return undefined
    })
    const elapsed = (await $.clock.now()) - started
    // The run rejects both when it outlasts the timeout and when it cannot start (a missing folder).
    if (ran === undefined && elapsed < s.timeoutMs) {
      throw new Error(`${label}: 起動できませんでした — ${failure instanceof Error ? failure.message : String(failure)}`.slice(0, 300))
    }
    if (ran === undefined) throw new Error(`${label}: ${s.timeoutMs / 1000}秒以内に終わりませんでした`)
    if (ran.exitCode !== 0) throw new Error(`${label}: 終了コード ${ran.exitCode}${commandStderr(ran.stderr) === '' ? '' : ` — ${commandStderr(ran.stderr).slice(-300)}`}`)
    if (i === 0) continue
    const parsed = parseTime(ran.stderr)
    // time(1) reports to 10 ms: under a second the host clock's own measure is the finer one.
    timesMs.push(parsed.wallMs !== undefined && (parsed.wallMs >= 1000 || elapsed <= 0) ? parsed.wallMs : elapsed)
    if (parsed.rssBytes !== undefined) rssBytes.push(parsed.rssBytes)
  }
  return { label, command, at: await $.clock.now(), timesMs, rssBytes }
}

type Baselines = Record<string, PerfSample>
const baselinesOf = async ($: EngineInterface): Promise<Baselines> => ((await $.store.get(BASELINES)) as Baselines | undefined) ?? {}

async function saveBaseline($: EngineInterface, key: string, sample: PerfSample): Promise<void> {
  const all = { ...(await baselinesOf($)), [key]: { ...sample, label: '基準' } }
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, KEEP_BASELINES)
  await $.store.set(BASELINES, Object.fromEntries(kept))
}

async function git($: EngineInterface, cwd: string, argv: string[]) {
  return $.process.run(['git', ...argv], { cwd, timeoutMs: 120_000 }).catch(() => undefined)
}

/** Runs `command` in a temporary worktree of `ref`, in the same folder relative to the root. */
async function measureRef($: EngineInterface, root: string, cwd: string, ref: string, command: string, s: Settings): Promise<PerfSample> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const dir = `${tmp}/perf-delta-${await $.clock.now()}`
  const added = await git($, root, ['worktree', 'add', '--detach', '--', dir, ref])
  if (added?.exitCode !== 0) throw new Error(`git worktree add ${ref} に失敗: ${added?.stderr.trim().slice(-200) ?? ''}`)
  try {
    const below = cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : ''
    const inside = below === '' ? dir : `${dir}/${below}`
    if (below !== '' && !(await $.fs.exists(inside).catch(() => false))) throw new Error(`${ref} には ${below} がありません（このフォルダはその時点のコミットにありません）`)
    return await measure($, inside, command, ref, s)
  } finally {
    await git($, root, ['worktree', 'remove', '--force', '--', dir])
  }
}

function toastOf(r: PerfReport): string {
  const t = verdictOf(r.before === undefined ? undefined : statsOf(r.before.timesMs), r.after === undefined ? undefined : statsOf(r.after.timesMs))
  if (r.before === undefined) return '⏱ 基準を保存しました'
  if (t.deltaPct === undefined) return '⏱ 計測しました'
  const word = t.verdict === 'faster' ? '速くなった' : t.verdict === 'slower' ? '遅くなった' : t.verdict === 'few' ? '回数が少なく判定できません' : 'ばらつきの範囲内'
  return `⏱ ${t.deltaPct > 0 ? '+' : ''}${t.deltaPct.toFixed(1)}% ${word} — /perf`
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    runs: Math.max(1, Math.min(50, Math.round(Number(options.runs ?? 5)) || 5)),
    timeoutMs: Math.max(5, Math.min(600, Number(options.timeoutSec ?? 300) || 300)) * 1000,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'perf',
      description: 'ベンチマークの変更前後を比較（/perf <cmd> · /perf base <cmd> · /perf ref <git-ref> <cmd> · /perf show）',
      argumentHint: '<cmd> | base <cmd> | ref <git-ref> <cmd> | show | clear [cmd]',
    })
    return next(e)
  })

  on('command.run', { command: 'perf' }, async ($, e) => {
    const { mode, ref, command } = parseArgs(e.args)
    const root = (await $.session.repo())?.root ?? (await $.session.cwd())
    const cwd = await $.session.cwd()

    if (mode === 'show') {
      const shown = await read($, report)
      if (shown === null) return { text: '⏱ まだ計測していません。/perf <コマンド> で計測します。' }
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: [`⏱ ${shown.command}`, ...reportLines(shown.before, shown.after)].join('\n') }
    }
    if (mode === 'clear') {
      const all = await baselinesOf($)
      const kept = command === '' ? {} : Object.fromEntries(Object.entries(all).filter(([key]) => key !== baselineKey(root, command, cwd)))
      await $.store.set(BASELINES, kept)
      return { text: `⏱ 基準を${command === '' ? 'すべて' : ''}削除しました。` }
    }
    if (command === '') return { text: '⏱ 計測するコマンドを指定してください。' }
    if (mode === 'ref' && (ref === undefined || !isSafeRef(ref))) return { text: `⏱ git ref として使えない値です: ${ref ?? ''}` }
    if (isBusy) return { text: '⏱ 計測中です。終わるまでお待ちください。' }

    const key = baselineKey(root, command, cwd)
    const saved = (await baselinesOf($))[key]
    isBusy = true
    await update($, report, (): PerfReport => ({ status: 'running', command, note: '準備中' }))
    $.ui.status('⏱ 計測中')
    $.clock.after(0, () => {
      void (async () => {
        try {
          if (mode === 'base') {
            const after = await measure($, cwd, command, '基準', settings)
            await saveBaseline($, key, after)
            await update($, report, (): PerfReport => ({ status: 'done', command, after }))
          } else if (mode === 'ref') {
            const before = await measureRef($, root, cwd, ref as string, command, settings)
            const after = await measure($, cwd, command, '現在', settings)
            await update($, report, (): PerfReport => ({ status: 'done', command, before, after }))
          } else {
            const after = await measure($, cwd, command, saved === undefined ? '基準' : '現在', settings)
            if (saved === undefined) await saveBaseline($, key, after)
            await update($, report, (): PerfReport => ({ status: 'done', command, ...(saved === undefined ? {} : { before: saved }), after }))
          }
          const done = await read($, report)
          if (done !== null) $.ui.toast(toastOf(done))
        } catch (err) {
          await update($, report, (): PerfReport => ({ status: 'failed', command, note: err instanceof Error ? err.message : String(err) }))
          $.ui.toast('⏱ 計測に失敗しました — /perf show')
        } finally {
          isBusy = false
          $.ui.status(undefined)
        }
      })()
    })
    await $.ui.open({ id: PANE, title: TITLE })
    const plan =
      mode === 'ref' ? `${ref} を一時 worktree で計測してから現在を計測` : mode === 'base' || saved === undefined ? '基準として計測（次回の /perf と比較）' : `保存済みの基準（${new Date(saved.at).toLocaleString()}）と比較`
    return { text: `⏱ ${command}: ${plan}。ウォームアップ1回 + ${settings.runs}回。` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const shown = await read($, report)
    if (shown === null) return <Text dimColor>まだ計測していません。</Text>
    const lines = reportLines(shown.before, shown.after)
    const color = (line: string) => (line.includes('悪化') ? 'red' : line.includes('改善') ? 'green' : line.includes('⚠') ? 'yellow' : undefined)
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">{`⏱ ${shown.command}`}</Text>
        {shown.status === 'running' && <Text color="cyan">{`計測中… ${shown.note ?? ''}`}</Text>}
        {shown.status === 'failed' && <Text color="red">{`失敗: ${shown.note ?? ''}`}</Text>}
        {shown.status === 'done' && shown.before === undefined && <Text dimColor>基準として保存しました。変更後にもう一度 /perf を実行すると比較します。</Text>}
        {lines.map((line, index) => (
          <Text key={`l-${index}`} color={color(line)} bold={!line.startsWith(' ')} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    )
  })
}
