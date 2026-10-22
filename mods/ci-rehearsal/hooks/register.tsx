import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Failure, Problem, Result, Run, Tree } from '../types'

import type { Mode } from './runthrough'
import { clockText, failureLabel, fixPrompt, hash, lineSplitter, listedEvents, logReader, planJobs, problemText, runArgv, secsText } from './runthrough'

const PANE = 'ci-rehearsal'
const PANE_TITLE = 'ローカル CI'

const tree = atom({ plugin: 'ci-rehearsal', key: 'tree' } as const, null as Tree | null)
const run = atom({ plugin: 'ci-rehearsal', key: 'run' } as const, null as Run | null)
const result = atom({ plugin: 'ci-rehearsal', key: 'result' } as const, null as Result | null)
const problem = atom({ plugin: 'ci-rehearsal', key: 'problem' } as const, null as Problem | null)
const hiddenFor = atom({ plugin: 'ci-rehearsal', key: 'hiddenFor' } as const, null as string | null)

type Api = EngineInterface

const said = (text: string): Problem => ({ kind: 'other', text })

// Set by register from the options; module-local, as a reload runs register again.
let mode: Mode = 'container'
let isCommitted = false
let event = 'push'
let isAuto = false
let timeoutMin = 20
// The running child's stop: module-local, as the child dies with the module anyway.
let stop: (() => void) | undefined
let isCancelled = false

async function git($: Api, args: string[], stdin?: string) {
  const ran = await $.process.run(['git', ...args], stdin === undefined ? undefined : { stdin })
  return ran.exitCode === 0 ? ran.stdout : undefined
}

/** The jobs the event triggers on this branch: the plan applies the branch and tag filters `-l` ignores. */
async function jobsFor($: Api, ev: string) {
  const plan = await $.process.run(['runthrough', '-n', ev])
  return plan.exitCode === 0 ? planJobs(plan.stdout) : 0
}

/** The configured event, else the first listed event that triggers a job here, as a pull_request-only repository needs. */
async function pickEvent($: Api) {
  const jobs = await jobsFor($, event)
  if (jobs > 0) {
    return { event, jobs }
  }
  const listed = await $.process.run(['runthrough', '-l'])
  for (const other of listed.exitCode === 0 ? listedEvents(listed.stdout) : []) {
    const found = other === event ? 0 : await jobsFor($, other)
    if (found > 0) {
      return { event: other, jobs: found }
    }
  }
  return undefined
}

/** What a run would see now, and its key: HEAD alone when committed, else HEAD with every change. */
async function measure($: Api): Promise<Tree | null> {
  const picked = await pickEvent($)
  if (picked === undefined) {
    return null
  }
  const head = (await git($, ['rev-parse', 'HEAD']))?.trim() ?? ''
  if (isCommitted) {
    return { key: hash(`${picked.event}\n${head}`), ...picked }
  }
  const patch = (await git($, ['diff', 'HEAD'])) ?? ''
  // -z: the names as they are, not quoted as core.quotePath quotes a non-ASCII one.
  const untracked = ((await git($, ['ls-files', '-z', '--others', '--exclude-standard'])) ?? '').split('\0').filter(name => name !== '')
  // An untracked file's content is in no diff: every one's blob hash stands for it, in one process.
  const blobs = untracked.length === 0 ? '' : ((await git($, ['hash-object', '--stdin-paths'], untracked.join('\n'))) ?? '')
  return { key: hash(`${picked.event}\n${head}\n${patch}\n${untracked.join('\0')}\n${blobs}`), ...picked }
}

async function refresh($: Api) {
  const now = await measure($)
  await update($, tree, () => now)
  await setStatus($)
  return now
}

async function setStatus($: Api) {
  const r = await read($, run)
  if (r !== null) {
    $.ui.status(`▶ CI ${clockText(r.elapsedS)}`)
    return
  }
  if ((await read($, problem)) !== null) {
    $.ui.status('CI 止まった')
    return
  }
  const done = await read($, result)
  if (done === null) {
    $.ui.status(undefined)
    return
  }
  const isStale = (await read($, tree))?.key !== done.key
  $.ui.status(isStale ? 'CI 古い' : done.ok ? 'CI ✅' : `CI ❌ ${done.failures.length}`)
}

async function tickRun($: Api) {
  const now = await $.clock.now()
  await update($, run, r => (r === null ? r : { ...r, elapsedS: Math.round((now - r.startedAt) / 1000) }))
  await setStatus($)
}

async function rehearse($: Api, how: { mode: Mode; only?: string }) {
  const target = await refresh($)
  if (target === null) {
    await update($, problem, () => said(`${event} でもほかのイベントでも、このブランチで走るジョブがありません`))
    await setStatus($)
    return
  }
  if (how.mode === 'container' && (await $.process.run(['docker', 'info'])).exitCode !== 0) {
    await update($, problem, (): Problem => ({ kind: 'no-docker' }))
    await setStatus($)
    return
  }

  // Decided inside the write, so two presses before the redraw start one child.
  const startedAt = await $.clock.now()
  let isFirst = false
  await update($, run, current => {
    isFirst = current === null
    return current ?? { key: target.key, startedAt, elapsedS: 0, job: '起動中', done: 0, total: how.only === undefined ? target.jobs : 1, only: how.only }
  })
  if (!isFirst) {
    return
  }
  await update($, problem, () => null)
  await update($, hiddenFor, () => null)
  isCancelled = false
  let isTimedOut = false

  const tick = $.clock.every(1000, () => void tickRun($))
  const stream = $.process.spawn({ argv: runArgv({ event: target.event, mode: how.mode, isCommitted, only: how.only }) })
  stop = () => void stream.return(undefined as never)
  const limit = $.clock.after(timeoutMin * 60_000, () => {
    isTimedOut = true
    stop?.()
  })

  const split = lineSplitter()
  const log = logReader()
  let stderr = ''
  let code: number | null | undefined
  let startError: string | undefined
  try {
    for await (const chunk of stream) {
      if (chunk.stream === 'stderr') {
        stderr = (stderr + chunk.text).slice(-4000)
        continue
      }
      for (const line of split(chunk.text)) {
        const seen = log.read(line)
        if (seen.job !== undefined || seen.isJobDone === true) {
          const job = seen.job
          await update($, run, r => (r === null ? r : { ...r, job: job ?? r.job, done: r.done + (seen.isJobDone === true ? 1 : 0) }))
        }
      }
    }
    code = (await stream.result).code
  } catch (err) {
    startError = /ENOENT|not found|no such file/i.test(String(err)) ? 'runthrough が見つかりません（PATH）' : String(err).slice(0, 200)
  } finally {
    tick.cancel()
    limit.cancel()
    stop = undefined
  }

  const summary = log.summary()
  if (isCancelled) {
    // 止める: nothing to report.
  } else if (isTimedOut) {
    await update($, problem, () => said(`${timeoutMin}分で打ち切りました`))
  } else if (startError !== undefined || summary === undefined) {
    await update($, problem, () => said(startError ?? problemText(stderr, code ?? null)))
  } else {
    const failures = log.failures()
    await update($, result, () => ({ key: target.key, event: target.event, ...summary, failures, only: how.only }))
    $.ui.toast(summary.ok ? `CI ✅ ${summary.jobs.length} jobs 通過` : `CI ❌ ${failures.length}件の失敗`)
  }
  await update($, run, () => null)
  await setStatus($)
}

async function failRun($: Api, err: unknown) {
  await update($, run, () => null)
  await update($, problem, () => said(String(err).slice(0, 200)))
  await setStatus($)
}

function start($: Api, how: { mode?: Mode; only?: string } = {}) {
  // Outlives the press that started it: the loop is the child's life, ended by 止める, the timeout or the module.
  void rehearse($, { mode: how.mode ?? mode, only: how.only }).catch(err => failRun($, err))
}

function cancel() {
  isCancelled = true
  stop?.()
}

async function fill($: Api, failures: readonly Failure[], ev: string) {
  await $.prompt.fill({ text: fixPrompt(failures, ev), mode: 'insert' })
}

async function openPane($: Api) {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

const option = <T extends string>(value: unknown, allowed: readonly T[], fallback: T) =>
  allowed.find(one => one === value) ?? fallback

export const register: Register = (on, options) => {
  mode = option(options.mode, ['container', 'host', 'apple-container'] as const, 'container')
  isCommitted = options.scope === 'committed'
  event = typeof options.event === 'string' && options.event.trim() !== '' ? options.event.trim() : 'push'
  isAuto = options.auto === 'turn-end'
  timeoutMin = typeof options.timeoutMin === 'number' && options.timeoutMin > 0 ? options.timeoutMin : 20

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload killed any child this module had: what it was doing is over.
    await update($, run, () => null)
    await $.command.register({ name: 'ci-run', description: 'runthrough で CI のワークフローをローカル実行する' })
    await $.command.register({ name: 'ci', description: 'ローカル CI の結果をペインで開く' })
    await refresh($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      return done
    }
    const now = await refresh($)
    const last = await read($, result)
    if (isAuto && now !== null && (await read($, run)) === null && last?.key !== now.key && (await read($, problem)) === null) {
      start($)
    }
    return done
  })

  on('command.run', { command: 'ci-run' }, async $ => {
    if ((await read($, run)) !== null) {
      return { text: 'ローカル CI はもう走っています。' }
    }
    start($)
    return { text: 'runthrough を走らせ始めました。結果は入力欄の上の帯と /ci に出ます。' }
  })

  on('command.run', { command: 'ci' }, async $ => {
    await openPane($)
    return { text: 'ローカル CI のペインを開きました。' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const now = await read($, tree)
    const running = await read($, run)
    const done = await read($, result)
    const stopped = await read($, problem)
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
    const dismissProblem = <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, problem, () => null)} />

    if (running !== null) {
      return stack(
        <Box>
          <Text color="cyan" wrap="truncate-end">
            ▶ CI {clockText(running.elapsedS)} · {running.job} {running.done}/{running.total}{' '}
          </Text>
          <Button key="cancel" label="止める" onPress={cancel} />
        </Box>,
      )
    }
    if (stopped?.kind === 'no-docker') {
      return stack(
        <Box>
          <Text color="yellow" wrap="truncate-end">
            CI: Docker が動いていません{' '}
          </Text>
          <Button key="host" label="host で走らせる" onPress={() => start($, { mode: 'host' })} />
          {dismissProblem}
        </Box>,
      )
    }
    if (stopped !== null) {
      return stack(
        <Box>
          <Text color="red" wrap="truncate-end">
            CI 止まった: {stopped.text}{' '}
          </Text>
          {now !== null && <Button key="retry" label="再試行" variant="primary" onPress={() => start($)} />}
          {dismissProblem}
        </Box>,
      )
    }
    if (now === null || closedFor === now.key) {
      return below
    }

    const close = <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, hiddenFor, () => now.key)} />
    if (done !== null && done.key === now.key) {
      const top = done.failures[0]
      if (done.ok || top === undefined) {
        return stack(
          <Box>
            <Text color={done.ok ? 'green' : 'red'} wrap="truncate-end">
              CI {done.ok ? '✅' : '❌'} {done.jobs.filter(j => j.result === 'success').length}/{done.jobs.length} {secsText(done.secs)}
              {done.only === undefined ? '' : ` · ${done.only} のみ`}{' '}
            </Text>
            {!done.ok && <Button key="detail" label="詳細" onPress={() => openPane($)} />}
            {close}
          </Box>,
        )
      }
      return stack(
        <Box>
          <Text color="red" wrap="truncate-end">
            CI ❌ {failureLabel(top)}
            {done.failures.length > 1 ? ` · ほか${done.failures.length - 1}件` : ''}{' '}
          </Text>
          <Button key="fix" label="Claude に頼む" variant="primary" onPress={() => fill($, done.failures, done.event)} />
          <Button key="detail" label="詳細" onPress={() => openPane($)} />
          <Button key="again" label="再実行" onPress={() => start($, { only: done.only })} />
          {close}
        </Box>,
      )
    }

    const stale = done === null ? '' : ` · 前回の${done.ok ? '✅' : '❌'}は古い`
    return stack(
      <Box>
        <Text dimColor wrap="truncate-end">
          CI 未確認 · {now.event} {now.jobs} jobs{now.event === event ? '' : `（${event} では走らない）`}{isCommitted ? '（HEAD）' : ''}
          {stale}{' '}
        </Text>
        <Button key="run" label="走らせる" variant="primary" onPress={() => start($)} />
        {close}
      </Box>,
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, tree)
    const running = await read($, run)
    const done = await read($, result)
    const stopped = await read($, problem)
    const isStale = done !== null && now?.key !== done.key
    const head =
      running !== null
        ? `実行中 ${clockText(running.elapsedS)} · ${running.job} ${running.done}/${running.total}`
        : stopped !== null
          ? stopped.kind === 'no-docker'
            ? 'Docker が動いていません'
            : `止まった: ${stopped.text}`
          : done === null
            ? 'まだ走らせていません'
            : `${done.ok ? '✅ 通過' : `❌ ${done.failures.length}件の失敗`} · ${secsText(done.secs)}${isStale ? ' · 古い' : ''}`

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold wrap="truncate-end">
            {head}{' '}
          </Text>
          {running !== null ? (
            <Button key="cancel" label="止める" onPress={cancel} />
          ) : (
            now !== null && <Button key="run" label="全部走らせる" variant="primary" onPress={() => start($)} />
          )}
        </Box>
        {done?.jobs.map(j => (
          <Text key={`j-${j.job}`} color={j.result === 'success' ? 'green' : j.result === 'failure' ? 'red' : 'gray'} dimColor={isStale} wrap="truncate-end">
            {j.result === 'success' ? '✅' : j.result === 'failure' ? '❌' : '·'} {j.job} {j.result}
          </Text>
        ))}
        {done?.failures.map(f => (
          // Every line: the engine scrolls the pane's body over a tree taller than it.
          <Box flexDirection="column" key={`f-${f.id}`}>
            <Box>
              <Text color="red" bold dimColor={isStale} wrap="truncate-end">
                {failureLabel(f)}{' '}
              </Text>
              <Button key={`fix-${f.id}`} label="直させる" onPress={() => fill($, [f], done.event)} />
              {running === null && <Button key={`only-${f.id}`} label="このジョブだけ" onPress={() => start($, { only: f.jobId })} />}
            </Box>
            {f.tail.map((line, i) => (
              <Text key={`t-${f.id}-${i}`} dimColor wrap="truncate-end">
                {'  '}
                {line}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
