import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Duelist, Lane, Proposal, Result, Round, Run, Scores, Standing } from '../types'
import { DUELISTS, clockText, duelArgv, duelistsOf, failureText, lineSplitter, names, readEvent, startFailureText } from './cli'
import {
  SCHEMAS,
  adoptPrompt,
  critiquePrompt,
  labelsOf,
  parseCritiques,
  parseProposal,
  parseRevision,
  proposePrompt,
  revisePrompt,
  scoresText,
  tally,
  totalText,
} from './duel'
import type { SchemaName } from './duel'

const PANE = 'design-duel'
const PANE_TITLE = '設計対決'

const run = atom({ plugin: 'design-duel', key: 'run' } as const, null as Run | null)
const result = atom({ plugin: 'design-duel', key: 'result' } as const, null as Result | null)
const error = atom({ plugin: 'design-duel', key: 'error' } as const, null as { topic: string; text: string } | null)
const isHidden = atom({ plugin: 'design-duel', key: 'isHidden' } as const, false)

const ROUND_TEXT: Record<Round, string> = { propose: '提案', critique: '相互採点', revise: '修正', rescore: '再採点' }

type Api = EngineInterface

// Set by register from the options; module-local, as a reload runs register again.
let timeoutMin = 30
let duelists: Duelist[] = [...DUELISTS]
let isRevising = false
// The running children's stops: module-local, as the children die with the module anyway.
let stops: (() => void)[] = []
let isCancelled = false

/** Where the duelists read: the repository's root, else the session's directory. */
async function rootOf($: Api) {
  const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  const root = ran.stdout.trim()
  return ran.exitCode === 0 && root !== '' ? root : $.session.cwd()
}

const laneText = (lane: Lane) => (lane.state === 'done' ? `${lane.duelist} ✓` : lane.state === 'failed' ? `${lane.duelist} ✗` : `${lane.duelist}: ${lane.phase}`)

const partialNote = (done: Result) => {
  const who = [...new Set(done.failures.map(f => f.duelist))]
  return who.length === 0 ? '' : ` · ${names(who)} 失敗あり`
}

async function setStatus($: Api) {
  const r = await read($, run)
  if (r !== null) {
    const finished = r.lanes.filter(lane => lane.state !== 'running').length
    $.ui.status(`⚔ duel ${clockText(r.elapsedS)} ${ROUND_TEXT[r.round]} (${finished}/${r.lanes.length})`)
    return
  }
  if ((await read($, error)) !== null) {
    $.ui.status('⚔ duel 失敗')
    return
  }
  const done = await read($, result)
  $.ui.status(done === null ? undefined : done.winner === null ? '⚔ duel 勝者なし' : `⚔ duel 勝者 ${done.winner}`)
}

async function tickRun($: Api) {
  const now = await $.clock.now()
  await update($, run, r => (r === null ? r : { ...r, elapsedS: Math.round((now - r.startedAt) / 1000) }))
  await setStatus($)
}

const setLane = ($: Api, duelist: Duelist, lane: Partial<Lane>) =>
  update($, run, r => (r === null ? r : { ...r, lanes: r.lanes.map(one => (one.duelist === duelist ? { ...one, ...lane } : one)) }))

/** One duelist's child, from spawn to its schema-held answer or why there is none. */
async function ask($: Api, duelist: Duelist, prompt: string, schema: SchemaName, root: string, isTimedOut: () => boolean): Promise<{ message?: string; error?: string }> {
  const split = lineSplitter()
  let message: string | undefined
  let failure: string | undefined
  let stderr = ''
  let code: number | undefined
  try {
    if (isCancelled || isTimedOut()) throw new Error('stopped before start')
    const argv = duelArgv(duelist, prompt, { path: `${$.plugin.root}/hooks/${schema}.schema.json`, value: SCHEMAS[schema] }, root)
    // agy runs in the mod's own workspace, where its read-only agent is defined.
    const stream = $.process.spawn({ argv, cwd: duelist === 'agy' ? `${$.plugin.root}/agy` : root })
    stops.push(() => void stream.return(undefined as never))
    for await (const chunk of stream) {
      if (chunk.stream === 'stderr') {
        stderr = (stderr + chunk.text).slice(-4000)
        continue
      }
      for (const line of split(chunk.text)) {
        const seen = readEvent(duelist, line)
        message = seen.message ?? message
        failure = seen.failure ?? failure
        if (seen.phase !== undefined) await setLane($, duelist, { phase: seen.phase })
      }
    }
    code = (await stream.result).code ?? undefined
  } catch (err) {
    return { error: isTimedOut() ? `${timeoutMin}分で打ち切りました` : startFailureText(duelist, err) }
  }
  if (isTimedOut()) return { error: `${timeoutMin}分で打ち切りました` }
  if (code !== 0 || message === undefined) return { error: failureText(duelist, stderr, failure, code ?? null) }
  return { message }
}

type Failures = Result['failures']

/** One round: every participant at once, each answer held to its schema; a failure fails that participant alone. */
async function roundOf<T>(
  $: Api,
  round: Round,
  asks: readonly { duelist: Duelist; prompt: string; schema: SchemaName; parse: (text: string) => T }[],
  root: string,
  isTimedOut: () => boolean,
  failures: Failures,
): Promise<{ duelist: Duelist; value: T }[]> {
  await update($, run, r => (r === null ? r : { ...r, round, lanes: asks.map(({ duelist }): Lane => ({ duelist, state: 'running', phase: '起動中' })) }))
  await setStatus($)
  const answers = await Promise.all(
    asks.map(async ({ duelist, prompt, schema, parse }) => {
      const asked = await ask($, duelist, prompt, schema, root, isTimedOut)
      let value: T | undefined
      let why = asked.error
      if (asked.message !== undefined) {
        try {
          value = parse(asked.message)
        } catch (err) {
          why = (err as Error).message
        }
      }
      await setLane($, duelist, { state: value === undefined ? 'failed' : 'done' })
      if (value === undefined) {
        if (!isCancelled) failures.push({ duelist, round, error: why ?? 'error' })
        return []
      }
      return [{ duelist, value }]
    }),
  )
  return answers.flat()
}

type Entry = { duelist: Duelist; label: string; proposal: Proposal; rebuttal?: string }

/** Every duelist judges every proposal but its own; one that failed to propose judges them all. */
async function scoreRound($: Api, round: Round, topic: string, entries: readonly Entry[], root: string, isTimedOut: () => boolean, failures: Failures) {
  const asks = duelists.map(judge => {
    const others = entries.filter(e => e.duelist !== judge).sort((a, b) => a.label.localeCompare(b.label))
    return {
      duelist: judge,
      prompt: critiquePrompt(topic, judge, root, others),
      schema: 'critique' as const,
      parse: (text: string) => parseCritiques(text, others.map(e => e.label)),
    }
  })
  const answered = await roundOf($, round, asks, root, isTimedOut, failures)
  return answered.flatMap(({ duelist, value }) => value.map(c => ({ judge: duelist, ...c })))
}

async function rounds($: Api, topic: string, startedAt: number, isTimedOut: () => boolean): Promise<Omit<Result, 'finishedAt'> | { error: string }> {
  const root = await rootOf($)
  const failures: Failures = []
  const proposed = await roundOf(
    $,
    'propose',
    duelists.map(duelist => ({ duelist, prompt: proposePrompt(topic, duelist, root), schema: 'proposal' as const, parse: parseProposal })),
    root,
    isTimedOut,
    failures,
  )
  if (proposed.length < 2) {
    const why = failures.map(f => `${f.duelist}: ${f.error}`).join(' / ')
    return { error: `比べられる案が2つ未満です${why === '' ? '' : `（${why}）`}` }
  }
  const labels = labelsOf(proposed.map(p => p.duelist), `${topic}\n${startedAt}`)
  const entries: Entry[] = proposed.map(({ duelist, value }) => ({ duelist, label: labels[duelist], proposal: value }))

  let critiques: { judge: Duelist; label: string; scores: Scores; objection: string }[] = []
  let isRevised = false
  if (!isCancelled && !isTimedOut()) critiques = await scoreRound($, 'critique', topic, entries, root, isTimedOut, failures)

  // Only a proposal with objections to answer is revised, and the revised ones are judged again from scratch.
  const objected = entries.filter(e => critiques.some(c => c.label === e.label))
  if (isRevising && objected.length > 0 && !isCancelled && !isTimedOut()) {
    const revised = await roundOf(
      $,
      'revise',
      objected.map(e => ({
        duelist: e.duelist,
        prompt: revisePrompt(topic, e.duelist, root, e.proposal, critiques.filter(c => c.label === e.label).map(c => c.objection)),
        schema: 'revision' as const,
        parse: parseRevision,
      })),
      root,
      isTimedOut,
      failures,
    )
    for (const { duelist, value } of revised) {
      const entry = entries.find(e => e.duelist === duelist)!
      entry.proposal = value.proposal
      entry.rebuttal = value.rebuttal
    }
    isRevised = revised.length > 0
    if (isRevised) critiques = !isCancelled && !isTimedOut() ? await scoreRound($, 'rescore', topic, entries, root, isTimedOut, failures) : []
  }

  const { standings, winner } = tally(entries, critiques)
  return { topic, standings, winner, isRevised, failures }
}

async function duel($: Api, topic: string) {
  // Decided inside the write, so two starts before the redraw start one duel.
  const startedAt = await $.clock.now()
  let isFirst = false
  await update($, run, current => {
    isFirst = current === null
    return current ?? { topic, round: 'propose' as const, startedAt, elapsedS: 0, lanes: [] }
  })
  if (!isFirst) return
  await update($, isHidden, () => false)
  await update($, result, () => null)
  await update($, error, () => null)
  isCancelled = false
  stops = []
  let isTimedOut = false

  const tick = $.clock.every(1000, () => void tickRun($))
  const limit = $.clock.after(timeoutMin * 60_000, () => {
    isTimedOut = true
    for (const stop of stops) stop()
  })
  let outcome: Awaited<ReturnType<typeof rounds>>
  try {
    outcome = await rounds($, topic, startedAt, () => isTimedOut)
  } finally {
    tick.cancel()
    limit.cancel()
    stops = []
  }

  if (!isCancelled) {
    if ('error' in outcome) {
      await update($, error, () => ({ topic, text: outcome.error }))
    } else {
      const finishedAt = await $.clock.now()
      await update($, result, () => ({ ...outcome, finishedAt }))
      await update($, error, () => null)
      const top = outcome.standings[0]!
      $.ui.toast(outcome.winner === null ? '⚔ 設計対決: 勝者なし（同点か採点なし）' : `⚔ 設計対決: ${outcome.winner} の案が ${totalText(top.total)} で勝ちました`)
    }
  }
  await update($, run, () => null)
  await setStatus($)
}

function startDuel($: Api, topic: string) {
  // Outlives the command that started it: the children's lives, ended by 中止, the timeout or the module.
  void duel($, topic).catch(async err => {
    await update($, run, () => null)
    await update($, error, () => ({ topic, text: String(err).slice(0, 200) }))
    await setStatus($)
  })
}

function cancel() {
  isCancelled = true
  for (const stop of stops) stop()
}

async function adopt($: Api, topic: string, chosen: Standing) {
  await $.prompt.fill({ text: adoptPrompt(topic, chosen, duelists), mode: 'insert' })
}

async function openPane($: Api) {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

export const register: Register = (on, options) => {
  timeoutMin = typeof options.timeoutMin === 'number' && options.timeoutMin > 0 ? options.timeoutMin : 30
  duelists = duelistsOf(options.duelists)
  isRevising = options.revise === true

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload killed any child this module had: what it was doing is over.
    await update($, run, () => null)
    await $.command.register({ name: 'design-duel', description: `${names(duelists)} に同じお題で設計案を競わせる（読み取り専用）。お題なしで結果のペインを開く` })
    await setStatus($)
    return started
  })

  on('command.run', { command: 'design-duel' }, async ($, e) => {
    const topic = e.args.trim()
    if (topic === '') {
      if ((await read($, run)) === null && (await read($, result)) === null && (await read($, error)) === null) {
        return { text: '使い方: /design-duel <お題>（例: /design-duel 設定の読み込みをキャッシュする設計）' }
      }
      await openPane($)
      return { text: '設計対決のペインを開きました。' }
    }
    if ((await read($, run)) !== null) {
      return { text: '設計対決はもう走っています。' }
    }
    if (duelists.length < 2) {
      return { text: `参加者が2つ未満です（duelists: ${names(duelists)}）。/plugin configure design-duel@simota-mods で2つ以上にしてください。` }
    }
    startDuel($, topic)
    return { text: `${names(duelists)} が設計を競います${isRevising ? '（修正ラウンドあり）' : ''}。結果は入力欄の上の帯と /design-duel（お題なし）に出ます。` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const running = await read($, run)
    const done = await read($, result)
    const failed = await read($, error)
    const hidden = await read($, isHidden)
    const { Box, Button, Text } = $.ui.resolve(e)

    // Stack this row above what the plugins beneath and the engine draw, rather than in its place.
    const below = await next(e)
    const stack = (row: RenderChildren) => (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )

    if (running !== null) {
      return stack(
        <Box>
          <Text color="cyan" wrap="truncate-end">
            ⚔ {clockText(running.elapsedS)} · {ROUND_TEXT[running.round]} · {running.lanes.map(laneText).join(' · ')}{' '}
          </Text>
          <Button key="cancel" label="中止" onPress={cancel} />
        </Box>,
      )
    }
    if (hidden) return below
    const close = <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, isHidden, () => true)} />
    if (failed !== null) {
      return stack(
        <Box>
          <Text color="red" wrap="truncate-end">
            ⚔ 設計対決 失敗: {failed.text}{' '}
          </Text>
          <Button key="retry" label="再試行" variant="primary" onPress={() => startDuel($, failed.topic)} />
          {close}
        </Box>,
      )
    }
    if (done === null) return below

    const others = done.standings.slice(1).map(s => `${s.duelist} ${totalText(s.total)}`).join(' · ')
    const top = done.standings[0]!
    const winner = done.winner === null ? undefined : top
    return stack(
      <Box>
        <Text color={winner === undefined ? 'yellow' : 'green'} wrap="truncate-end">
          {winner === undefined
            ? `⚔ 勝者なし · ${done.standings.map(s => `${s.duelist} ${totalText(s.total)}`).join(' · ')}`
            : `⚔ 勝者 ${winner.duelist}「${winner.proposal.title}」${totalText(winner.total)}${others === '' ? '' : ` · ${others}`}`}
          {partialNote(done)}{' '}
        </Text>
        {winner !== undefined && <Button key="adopt" label="この案で進めさせる" variant="primary" onPress={() => adopt($, done.topic, winner)} />}
        <Button key="detail" label="詳細" variant={winner === undefined ? 'primary' : undefined} onPress={() => openPane($)} />
        {close}
      </Box>,
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const running = await read($, run)
    const done = await read($, result)
    const failed = await read($, error)
    const head =
      running !== null
        ? `実行中 ${clockText(running.elapsedS)} · ${ROUND_TEXT[running.round]} · ${running.lanes.map(laneText).join(' · ')}`
        : failed !== null
          ? `失敗: ${failed.text}`
          : done === null
            ? 'まだ対決していません（/design-duel <お題>）'
            : done.winner === null
              ? '勝者なし（同点か採点なし）'
              : `勝者 ${done.winner}${done.isRevised ? ' · 修正後の再採点' : ''}`

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold wrap="truncate-end">
            {head}{' '}
          </Text>
          {running !== null && <Button key="cancel" label="中止" onPress={cancel} />}
        </Box>
        {done !== null && <Text dimColor>お題: {done.topic}</Text>}
        {done !== null &&
          done.failures.map((f, i) => (
            <Text key={`x-${i}`} color="red" wrap="truncate-end">
              {f.duelist} 失敗（{ROUND_TEXT[f.round]}）: {f.error}
            </Text>
          ))}
        {done !== null &&
          // Every proposal: the engine scrolls the pane's body over a tree taller than it.
          done.standings.map((s, place) => (
            <Box flexDirection="column" key={`s-${s.duelist}`}>
              <Box>
                <Text bold color={s.duelist === done.winner ? 'green' : undefined} wrap="truncate-end">
                  {place + 1}位 {s.duelist}（案{s.label}） {totalText(s.total)}「{s.proposal.title}」{' '}
                </Text>
                <Button key={`adopt-${s.duelist}`} label="この案で進めさせる" onPress={() => adopt($, done.topic, s)} />
              </Box>
              <Text>{s.proposal.summary}</Text>
              <Text dimColor>設計: {s.proposal.approach}</Text>
              <Text dimColor>トレードオフ: {s.proposal.tradeoffs}</Text>
              <Text dimColor>リスク: {s.proposal.risks}</Text>
              {s.rebuttal !== undefined && s.rebuttal !== '' && <Text dimColor>反論への回答: {s.rebuttal}</Text>}
              {s.critiques.map(c => (
                <Text key={`c-${s.duelist}-${c.judge}`}>
                  {'  '}
                  {c.judge}（{scoresText(c.scores)}）: {c.objection}
                </Text>
              ))}
            </Box>
          ))}
      </Box>
    )
  })
}
