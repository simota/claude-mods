import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Diff, Finding, Lane, Result, Reviewer, Run, Scope } from '../types'
import { untrackedHashes } from './fingerprint'

import {
  REVIEWERS,
  MAX_INPUT,
  diffInput,
  clockText,
  failureText,
  fixPrompt,
  hash,
  lineSplitter,
  location,
  mergeReviews,
  names,
  parseReview,
  parseShortstat,
  readEvent,
  reviewArgv,
  reviewersIn,
  reviewersOf,
  scopeLabel,
  startFailureText,
} from './reviewers'
import type { Handed, Review } from './reviewers'

const PANE = 'review-mods'
const PANE_TITLE = 'レビュー'

const diff = atom({ plugin: 'review-mods', key: 'diff' } as const, null as Diff | null)
const run = atom({ plugin: 'review-mods', key: 'run' } as const, null as Run | null)
const result = atom({ plugin: 'review-mods', key: 'result' } as const, null as Result | null)
const error = atom({ plugin: 'review-mods', key: 'error' } as const, null as string | null)
const measurementError = atom({ plugin: 'review-mods', key: 'measurementError' } as const, null as string | null)
const dismissed = atom({ plugin: 'review-mods', key: 'dismissed' } as const, [] as string[])
const hiddenFor = atom({ plugin: 'review-mods', key: 'hiddenFor' } as const, null as string | null)

const SEVERITY_COLOR = { high: 'red', medium: 'yellow', low: 'gray' } as const

type Api = EngineInterface

// Set by register from the options; module-local, as a reload runs register again.
let timeoutMin = 15
let reviewers: Reviewer[] = [...REVIEWERS]
// The running children's stops: module-local, as the children die with the module anyway.
let stops: (() => void)[] = []
let isCancelled = false

async function git($: Api, args: string[], stdin?: string) {
  const ran = await $.process.run(['git', ...args], stdin === undefined ? undefined : { stdin })
  return ran.exitCode === 0 && !ran.isStdoutTruncated ? ran.stdout : undefined
}

async function checkedGit($: Api, args: string[]) {
  const text = await git($, args)
  if (text === undefined) throw new Error('Git の差分を確認できません')
  return text
}

/** A missing initial repository or unborn branch has no target; a lost HEAD is an error. */
async function headOf($: Api): Promise<string | undefined> {
  const ran = await $.process.run(['git', 'rev-parse', 'HEAD'])
  const head = ran.stdout.trim()
  if (ran.exitCode === 0 && !ran.isStdoutTruncated && head !== '') return head

  const hadTarget = (await read($, diff)) !== null || (await read($, result)) !== null || (await read($, measurementError)) !== null
  if (!hadTarget && ran.exitCode !== 0 && !ran.isStdoutTruncated && !ran.isStderrTruncated) {
    if (/^fatal: not a git repository\b/m.test(ran.stderr)) return undefined
    // Verify an unborn/orphan branch through Git, rather than treating every
    // failed rev-parse (permissions, damaged objects, etc.) as an empty tree.
    if ((await git($, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true') {
      const branch = (await git($, ['symbolic-ref', '--quiet', 'HEAD']))?.trim()
      if (branch?.startsWith('refs/heads/')) {
        const exists = await $.process.run(['git', 'show-ref', '--verify', '--quiet', branch])
        if (exists.exitCode === 1 && !exists.isStdoutTruncated && !exists.isStderrTruncated && exists.stdout === '' && exists.stderr === '') return undefined
      }
    }
  }
  throw new Error('Git の HEAD を取得できず、差分を確認できません')
}

const BASES = ['origin/main', 'origin/master', 'main', 'master']

/** The base a branch is reviewed against: origin's default branch, else the first of BASES that exists. */
async function baseRef($: Api) {
  const remote = (await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim()
  if (remote !== undefined && remote !== '') {
    return remote
  }
  for (const ref of BASES) {
    if ((await git($, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== undefined) return ref
  }
  return undefined
}

/** Where HEAD left the base; undefined when they share no history (an orphan branch, a shallow clone). */
async function mergeBaseOf($: Api, base: string) {
  const ran = await $.process.run(['git', 'merge-base', base, 'HEAD'])
  const found = ran.stdout.trim()
  if (ran.exitCode === 0 && !ran.isStdoutTruncated && found !== '') return found
  // Exit 1 with nothing said is Git's answer for no common ancestor; anything else is a failure.
  if (ran.exitCode === 1 && ran.stdout === '' && ran.stderr === '') return undefined
  throw new Error('Git の差分を確認できません')
}

/**
 * What a press would review now, and its key: the working tree against where the branch left its
 * base, so the commits and the uncommitted changes go in together; with no base or no common ancestor, the uncommitted alone.
 */
async function measure($: Api): Promise<Diff | null> {
  const head = await headOf($)
  if (head === undefined) {
    return null
  }

  const base = await baseRef($)
  const mergeBase = base === undefined ? undefined : await mergeBaseOf($, base)
  const from = mergeBase ?? 'HEAD'
  const stat = await checkedGit($, ['diff', from, '--shortstat'])
  // -z: the names as they are, not quoted as core.quotePath quotes a non-ASCII one.
  const untracked = (await checkedGit($, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(name => name !== '')
  if (stat.trim() === '' && untracked.length === 0) {
    return null
  }
  const patch = await checkedGit($, ['diff', from])
  const blobs = await untrackedHashes($, untracked)
  const counted = parseShortstat(stat)
  return {
    key: hash(`${base === undefined || mergeBase === undefined ? '' : `${base}\n${mergeBase}\n`}${head}\n${patch}\n${untracked.join('\0')}\n${blobs}`),
    scope: base === undefined || mergeBase === undefined ? { kind: 'uncommitted' } : { kind: 'base', base, mergeBase },
    ...counted,
    files: counted.files + untracked.length,
  }
}

async function refresh($: Api) {
  try {
    const now = await measure($)
    await update($, diff, () => now)
    await update($, measurementError, () => null)
    return now
  } catch (err) {
    await update($, diff, () => null)
    await update($, measurementError, () => `差分を確認できません: ${String(err).slice(0, 200)}`)
    return null
  }
}

const visibleFindings = (all: readonly Finding[], hidden: readonly string[]) => all.filter(f => !hidden.includes(f.id))

/** What a result did not cover: reviewers that failed, and those that saw only part of the diff. */
const partialNote = (done: Result) => {
  const cut = done.reviews.filter(r => r.isCut).map(r => r.reviewer)
  return `${done.failures.length === 0 ? '' : ` · ${names(done.failures.map(f => f.reviewer))} 失敗`}${cut.length === 0 ? '' : ` · ${names(cut)} は差分の一部のみ`}`
}

const laneText = (lane: Lane) => (lane.state === 'done' ? `${lane.reviewer} ✓` : lane.state === 'failed' ? `${lane.reviewer} ✗` : `${lane.reviewer}: ${lane.phase}`)

async function setStatus($: Api) {
  const r = await read($, run)
  if (r !== null) {
    const finished = r.lanes.filter(lane => lane.state !== 'running').length
    $.ui.status(`🔍 review ${clockText(r.elapsedS)} (${finished}/${r.lanes.length})`)
    return
  }
  if ((await read($, measurementError)) !== null || (await read($, error)) !== null) {
    $.ui.status('🔍 review 失敗')
    return
  }
  const done = await read($, result)
  $.ui.status(done === null ? undefined : `🔍 review ${visibleFindings(done.findings, await read($, dismissed)).length}件${partialNote(done)}`)
}

async function tickRun($: Api) {
  const now = await $.clock.now()
  await update($, run, r => (r === null ? r : { ...r, elapsedS: Math.round((now - r.startedAt) / 1000) }))
  await setStatus($)
}

const setLane = ($: Api, reviewer: Reviewer, lane: Partial<Lane>) =>
  update($, run, r => (r === null ? r : { ...r, lanes: r.lanes.map(one => (one.reviewer === reviewer ? { ...one, ...lane } : one)) }))

type Outcome = { reviewer: Reviewer; review?: Review; error?: string; isCut?: boolean }

/** The diff claude and agy are handed, as measure takes it: the same base, the untracked named. */
async function handedOf($: Api, scope: Scope): Promise<Handed> {
  const from = scope.kind === 'base' ? scope.mergeBase : 'HEAD'
  const root = (await checkedGit($, ['rev-parse', '--show-toplevel'])).trim()
  const changed = (await checkedGit($, ['diff', '-z', '--name-only', from])).split('\0').filter(name => name !== '')
  const patch = await checkedGit($, ['diff', from])
  // From the repository root, as the diff names its files, though the session may sit below it.
  const untracked = (await checkedGit($, ['ls-files', '-z', '--full-name', '--others', '--exclude-standard'])).split('\0').filter(name => name !== '')
  return { root, changed, patch, untracked }
}

/** One reviewer's child, from spawn to its answer or why there is none. */
async function reviewWith($: Api, reviewer: Reviewer, scope: Scope, isTimedOut: () => boolean): Promise<Outcome> {
  const split = lineSplitter()
  let message: string | undefined
  let failure: string | undefined
  let stderr = ''
  let code: number | null | undefined
  let startError: string | undefined
  let isCut = false
  try {
    const handed = reviewer === 'codex' ? undefined : await handedOf($, scope)
    // 中止 or the timeout while the diff was read stopped the children there were; start none after it.
    if (isCancelled || isTimedOut()) throw new Error('stopped before start')
    const input = handed === undefined || reviewer === 'codex' ? undefined : diffInput(handed, MAX_INPUT[reviewer])
    isCut = input?.isCut === true
    const argv = reviewArgv(reviewer, scope, `${$.plugin.root}/hooks/schema.json`, input && { root: handed!.root, text: input.text })
    const stream = $.process.spawn(
      reviewer === 'claude'
        ? // At the root, where the paths it is handed start, though the session may sit below it.
          { argv, input: input!.text, cwd: handed!.root }
        : // agy runs in the mod's own workspace, where its read-only agent is defined.
          reviewer === 'agy'
          ? { argv, cwd: `${$.plugin.root}/agy` }
          : { argv },
    )
    stops.push(() => void stream.return(undefined as never))
    for await (const chunk of stream) {
      if (chunk.stream === 'stderr') {
        stderr = (stderr + chunk.text).slice(-4000)
        continue
      }
      for (const line of split(chunk.text)) {
        const seen = readEvent(reviewer, line)
        message = seen.message ?? message
        failure = seen.failure ?? failure
        const phase = seen.phase
        if (phase !== undefined) {
          await setLane($, reviewer, { phase })
        }
      }
    }
    code = (await stream.result).code
  } catch (err) {
    startError = startFailureText(reviewer, err)
  }

  let outcome: Outcome
  if (isTimedOut()) {
    outcome = { reviewer, error: `${timeoutMin}分で打ち切りました` }
  } else if (startError !== undefined || code !== 0 || message === undefined) {
    outcome = { reviewer, error: startError ?? failureText(reviewer, stderr, failure, code ?? null) }
  } else {
    try {
      outcome = { reviewer, review: parseReview(message), isCut }
    } catch (err) {
      outcome = { reviewer, error: (err as Error).message }
    }
  }
  await setLane($, reviewer, { state: outcome.review === undefined ? 'failed' : 'done' })
  return outcome
}

async function review($: Api) {
  const target = await refresh($)
  if (target === null) {
    if ((await read($, measurementError)) === null) await update($, error, () => 'レビューする差分がありません')
    await setStatus($)
    return
  }

  // Decided inside the write, so two presses before the redraw start one set of children.
  const startedAt = await $.clock.now()
  const chosen = reviewers
  let isFirst = false
  await update($, run, current => {
    isFirst = current === null
    return current ?? { key: target.key, startedAt, elapsedS: 0, lanes: chosen.map((reviewer): Lane => ({ reviewer, state: 'running', phase: '起動中' })) }
  })
  if (!isFirst) {
    return
  }
  // Retrying is not recovery: cancellation must leave the last failure visible.
  await update($, hiddenFor, () => null)
  isCancelled = false
  stops = []
  let isTimedOut = false

  const tick = $.clock.every(1000, () => void tickRun($))
  const limit = $.clock.after(timeoutMin * 60_000, () => {
    isTimedOut = true
    for (const stop of stops) stop()
  })
  let outcomes: Outcome[]
  try {
    outcomes = await Promise.all(chosen.map(reviewer => reviewWith($, reviewer, target.scope, () => isTimedOut)))
  } finally {
    tick.cancel()
    limit.cancel()
    stops = []
  }

  if (!isCancelled) {
    const answered = outcomes.flatMap(o => (o.review === undefined ? [] : [{ reviewer: o.reviewer, review: o.review, isCut: o.isCut === true }]))
    const failures = outcomes.flatMap(o => (o.error === undefined ? [] : [{ reviewer: o.reviewer, error: o.error }]))
    if (answered.length === 0) {
      // No reviewer answered: nothing stands for a review, least of all an earlier one.
      await update($, error, () => failures.map(f => `${f.reviewer}: ${f.error}`).join(' / '))
    } else {
      const findings = mergeReviews(answered)
      const finishedAt = await $.clock.now()
      const reviews = answered.map(({ reviewer, review, isCut }) => ({ reviewer, summary: review.summary, count: review.opinions.length, isCut }))
      await update($, result, () => ({ key: target.key, scope: target.scope, findings, reviews, failures, finishedAt }))
      await update($, error, () => null)
      await update($, dismissed, () => [])
      const failed = failures.length === 0 ? '' : `（${names(failures.map(f => f.reviewer))} は失敗）`
      $.ui.toast(findings.length === 0 ? `🔍 レビュー: 指摘なし${failed}` : `🔍 レビュー: ${findings.length}件の指摘${failed}`)
    }
  }
  await update($, run, () => null)
  await setStatus($)
}

async function failRun($: Api, err: unknown) {
  await update($, run, () => null)
  await update($, error, () => String(err).slice(0, 200))
  await setStatus($)
}

function startReview($: Api) {
  // Outlives the press that started it: the children's lives, ended by 中止, the timeout or the module.
  void review($).catch(err => failRun($, err))
}

function cancel() {
  isCancelled = true
  for (const stop of stops) stop()
}

async function fill($: Api, findings: readonly Finding[], scope: Scope) {
  await $.prompt.fill({ text: fixPrompt(findings, scope), mode: 'insert' })
}

async function openPane($: Api) {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

export const register: Register = (on, options) => {
  timeoutMin = typeof options.timeoutMin === 'number' && options.timeoutMin > 0 ? options.timeoutMin : 15
  reviewers = reviewersOf(options.reviewers)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload killed any child this module had: what it was doing is over.
    await update($, run, () => null)
    await $.command.register({ name: 'review-diff', description: `${names(reviewers)} に現在の差分をレビューさせる（読み取り専用）` })
    await $.command.register({ name: 'review-mods', description: 'レビューの指摘をペインで開く' })
    await refresh($)
    await setStatus($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await refresh($)
      await setStatus($)
    }
    return done
  })

  on('command.run', { command: 'review-diff' }, async $ => {
    if ((await read($, run)) !== null) {
      return { text: 'レビューはもう走っています。' }
    }
    startReview($)
    return { text: `${names(reviewers)} のレビューを始めました。結果は入力欄の上の帯と /review-mods に出ます。` }
  })

  on('command.run', { command: 'review-mods' }, async $ => {
    await openPane($)
    return { text: 'レビューのペインを開きました。' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const now = await read($, diff)
    const running = await read($, run)
    const done = await read($, result)
    const unmeasured = await read($, measurementError)
    const failed = unmeasured ?? (await read($, error))
    const hidden = await read($, dismissed)
    const closedFor = await read($, hiddenFor)
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
            🔍 {clockText(running.elapsedS)} · {running.lanes.map(laneText).join(' · ')}{' '}
          </Text>
          <Button key="cancel" label="中止" onPress={cancel} />
        </Box>,
      )
    }
    if (failed !== null) {
      // Dismissal hides the band, not the failure that invalidated the last result.
      if (unmeasured === null && closedFor === `error:${failed}`) return below
      return stack(
        <Box>
          <Text color="red" wrap="truncate-end">
            🔍 レビュー失敗: {failed}{' '}
          </Text>
          {now !== null && <Button key="retry" label="再試行" variant="primary" onPress={() => startReview($)} />}
          {unmeasured !== null ? (
            <Button key="remeasure" label="再確認" onPress={async () => {
              await refresh($)
              await setStatus($)
            }} />
          ) : (
            <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, hiddenFor, () => `error:${failed}`)} />
          )}
        </Box>,
      )
    }
    if (now === null || closedFor === now.key) {
      return below
    }

    const close = <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, hiddenFor, () => now.key)} />
    if (done !== null && done.key === now.key) {
      const left = visibleFindings(done.findings, hidden)
      const top = left[0]
      const partial = partialNote(done)
      if (top === undefined) {
        const said = done.reviews.filter(r => r.summary !== '').map(r => `${r.reviewer}: ${r.summary}`).join(' / ')
        return stack(
          <Box>
            {/* A partial result is not a clean one: a reviewer that failed found nothing only by not looking. */}
            <Text color={partial === '' ? 'green' : 'yellow'} wrap="truncate-end">
              🔍 指摘なし（{names(done.reviews.map(r => r.reviewer))}）{partial}
              {said === '' ? '' : ` · ${said}`}{' '}
            </Text>
            {/* Reviewing the same diff again can bring back a failed reviewer, not the part a cut one missed. */}
            {done.failures.length > 0 && <Button key="again" label="再レビュー" onPress={() => startReview($)} />}
            {close}
          </Box>,
        )
      }
      return stack(
        <Box>
          <Text color={SEVERITY_COLOR[top.severity]} wrap="truncate-end">
            🔍 {top.severity} · {location(top)} {top.title}（{names(reviewersIn(top))}）
            {left.length > 1 ? ` · ほか${left.length - 1}件` : ''}
            {partial}{' '}
          </Text>
          <Button key="fix" label="Claude に直させる" variant="primary" onPress={() => fill($, left, done.scope)} />
          <Button key="detail" label="詳細" onPress={() => openPane($)} />
          <Button key="again" label="再レビュー" onPress={() => startReview($)} />
          {close}
        </Box>,
      )
    }

    const stale = done === null ? '' : ` · 前回の${done.findings.length}件は古い`
    return stack(
      <Box>
        <Text dimColor wrap="truncate-end">
          🔍 未レビュー（{scopeLabel(now.scope)}） {now.files}ファイル +{now.insertions} −{now.deletions}
          {stale}{' '}
        </Text>
        <Button key="review" label={`${names(reviewers)} でレビュー`} variant="primary" onPress={() => startReview($)} />
        {close}
      </Box>,
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, diff)
    const running = await read($, run)
    const done = await read($, result)
    const failed = (await read($, measurementError)) ?? (await read($, error))
    const hidden = await read($, dismissed)
    const left = done === null ? [] : visibleFindings(done.findings, hidden)
    const isStale = done !== null && now?.key !== done.key
    const head =
      running !== null
        ? `実行中 ${clockText(running.elapsedS)} · ${running.lanes.map(laneText).join(' · ')}`
        : failed !== null
          ? `失敗: ${failed}`
          : done === null
            ? 'まだレビューしていません'
            : `${scopeLabel(done.scope)} · ${left.length}件${isStale ? ' · 古い' : ''}`

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold wrap="truncate-end">
            {head}{' '}
          </Text>
          {running !== null ? (
            <Button key="cancel" label="中止" onPress={cancel} />
          ) : (
            now !== null && <Button key="review" label={`${names(reviewers)} でレビュー`} variant="primary" onPress={() => startReview($)} />
          )}
        </Box>
        {done !== null &&
          done.reviews.map(r => (
            <Text key={`r-${r.reviewer}`} dimColor wrap="truncate-end">
              {r.reviewer}（{r.count}件{r.isCut ? '・差分の一部のみ' : ''}）{r.summary === '' ? '' : `: ${r.summary}`}
            </Text>
          ))}
        {done !== null &&
          done.failures.map(f => (
            <Text key={`x-${f.reviewer}`} color="red" wrap="truncate-end">
              {f.reviewer} 失敗: {f.error}
            </Text>
          ))}
        {done !== null &&
          // Every finding: the engine scrolls the pane's body over a tree taller than it.
          left.map(f => (
            <Box flexDirection="column" key={`f-${f.id}`}>
              <Box>
                <Text color={SEVERITY_COLOR[f.severity]} dimColor={isStale} wrap="truncate-end">
                  {f.severity} {location(f)} {f.title}（{names(reviewersIn(f))}）{' '}
                </Text>
                <Button key={`fix-${f.id}`} label="直させる" onPress={() => fill($, [f], done.scope)} />
                <Button key={`drop-${f.id}`} label="却下" onPress={() => update($, dismissed, all => [...all, f.id])} />
              </Box>
              {f.opinions.map(o => (
                <Text key={`o-${f.id}-${o.reviewer}`} dimColor wrap="truncate-end">
                  {'  '}
                  {o.reviewer}: {o.body}
                </Text>
              ))}
            </Box>
          ))}
      </Box>
    )
  })
}
