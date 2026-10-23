import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Diff, Finding, Result, Run, Scope } from '../types'

import {
  clockText,
  failureText,
  fixPrompt,
  hash,
  lineSplitter,
  location,
  parseReview,
  parseShortstat,
  readEvent,
  reviewArgv,
  scopeLabel,
} from './codex'

const PANE = 'cross-check'
const PANE_TITLE = 'Codex レビュー'

const diff = atom({ plugin: 'cross-check', key: 'diff' } as const, null as Diff | null)
const run = atom({ plugin: 'cross-check', key: 'run' } as const, null as Run | null)
const result = atom({ plugin: 'cross-check', key: 'result' } as const, null as Result | null)
const error = atom({ plugin: 'cross-check', key: 'error' } as const, null as string | null)
const dismissed = atom({ plugin: 'cross-check', key: 'dismissed' } as const, [] as string[])
const hiddenFor = atom({ plugin: 'cross-check', key: 'hiddenFor' } as const, null as string | null)

const SEVERITY_COLOR = { high: 'red', medium: 'yellow', low: 'gray' } as const

type Api = EngineInterface

// Set by register from the options; module-local, as a reload runs register again.
let timeoutMin = 15
// The running child's stop: module-local, as the child dies with the module anyway.
let stop: (() => void) | undefined
let isCancelled = false

async function git($: Api, args: string[], stdin?: string) {
  const ran = await $.process.run(['git', ...args], stdin === undefined ? undefined : { stdin })
  return ran.exitCode === 0 ? ran.stdout : undefined
}

/** The base a branch is reviewed against: origin's default branch, else a local main. */
async function baseRef($: Api) {
  const remote = (await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim()
  if (remote !== undefined && remote !== '') {
    return remote
  }
  return (await git($, ['rev-parse', '--verify', '--quiet', 'main'])) === undefined ? undefined : 'main'
}

/** What a press would review now, and its key: the uncommitted changes first, else the branch. */
async function measure($: Api): Promise<Diff | null> {
  const head = (await git($, ['rev-parse', 'HEAD']))?.trim()
  if (head === undefined) {
    return null
  }

  const stat = (await git($, ['diff', 'HEAD', '--shortstat'])) ?? ''
  // -z: the names as they are, not quoted as core.quotePath quotes a non-ASCII one.
  const untracked = ((await git($, ['ls-files', '-z', '--others', '--exclude-standard'])) ?? '').split('\0').filter(name => name !== '')
  if (stat.trim() !== '' || untracked.length > 0) {
    const patch = (await git($, ['diff', 'HEAD'])) ?? ''
    // An untracked file's content is in no diff: every one's blob hash stands for it, in one process.
    const blobs = untracked.length === 0 ? '' : ((await git($, ['hash-object', '--stdin-paths'], untracked.join('\n'))) ?? '')
    const counted = parseShortstat(stat)
    return {
      key: hash(`${head}\n${patch}\n${untracked.join('\0')}\n${blobs}`),
      scope: { kind: 'uncommitted' },
      ...counted,
      files: counted.files + untracked.length,
    }
  }

  const base = await baseRef($)
  if (base === undefined || Number((await git($, ['rev-list', '--count', `${base}..HEAD`]))?.trim() ?? 0) === 0) {
    return null
  }
  const range = `${base}...HEAD`
  const patch = (await git($, ['diff', range])) ?? ''
  return {
    key: hash(`${base}\n${head}\n${patch}`),
    scope: { kind: 'base', base },
    ...parseShortstat((await git($, ['diff', range, '--shortstat'])) ?? ''),
  }
}

async function refresh($: Api) {
  const now = await measure($)
  await update($, diff, () => now)
  return now
}

const visibleFindings = (all: readonly Finding[], hidden: readonly string[]) => all.filter(f => !hidden.includes(f.id))

async function setStatus($: Api) {
  const r = await read($, run)
  if (r !== null) {
    $.ui.status(`🔍 codex ${clockText(r.elapsedS)}`)
    return
  }
  if ((await read($, error)) !== null) {
    $.ui.status('🔍 codex 失敗')
    return
  }
  const done = await read($, result)
  $.ui.status(done === null ? undefined : `🔍 codex ${visibleFindings(done.findings, await read($, dismissed)).length}件`)
}

async function tickRun($: Api) {
  const now = await $.clock.now()
  await update($, run, r => (r === null ? r : { ...r, elapsedS: Math.round((now - r.startedAt) / 1000) }))
  await setStatus($)
}

async function review($: Api) {
  const target = await refresh($)
  if (target === null) {
    await update($, error, () => 'レビューする差分がありません')
    return
  }

  // Decided inside the write, so two presses before the redraw start one child.
  const startedAt = await $.clock.now()
  let isFirst = false
  await update($, run, current => {
    isFirst = current === null
    return current ?? { key: target.key, startedAt, elapsedS: 0, phase: '起動中' }
  })
  if (!isFirst) {
    return
  }
  await update($, error, () => null)
  await update($, hiddenFor, () => null)
  isCancelled = false
  let isTimedOut = false

  const tick = $.clock.every(1000, () => void tickRun($))
  const stream = $.process.spawn({ argv: reviewArgv(target.scope, `${$.plugin.root}/hooks/schema.json`) })
  stop = () => void stream.return(undefined as never)
  const limit = $.clock.after(timeoutMin * 60_000, () => {
    isTimedOut = true
    stop?.()
  })

  const split = lineSplitter()
  let message: string | undefined
  let failure: string | undefined
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
        const seen = readEvent(line)
        message = seen.message ?? message
        failure = seen.failure ?? failure
        const phase = seen.phase
        if (phase !== undefined) {
          await update($, run, r => (r === null ? r : { ...r, phase }))
        }
      }
    }
    code = (await stream.result).code
  } catch (err) {
    startError = /ENOENT|not found|no such file/i.test(String(err)) ? 'codex が見つかりません（PATH）' : String(err).slice(0, 200)
  } finally {
    tick.cancel()
    limit.cancel()
    stop = undefined
  }

  if (isCancelled) {
    // 中止: nothing to report.
  } else if (isTimedOut) {
    await update($, error, () => `${timeoutMin}分で打ち切りました`)
  } else if (startError !== undefined || code !== 0 || message === undefined) {
    await update($, error, () => startError ?? failureText(stderr, failure, code ?? null))
  } else {
    const parsed = parseReview(message)
    const finishedAt = await $.clock.now()
    await update($, result, () => ({ key: target.key, scope: target.scope, ...parsed, finishedAt }))
    await update($, dismissed, () => [])
    $.ui.toast(parsed.findings.length === 0 ? '🔍 Codex: 指摘なし' : `🔍 Codex: ${parsed.findings.length}件の指摘`)
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
  // Outlives the press that started it: the loop is the child's life, ended by 中止, the timeout or the module.
  void review($).catch(err => failRun($, err))
}

function cancel() {
  isCancelled = true
  stop?.()
}

async function fill($: Api, findings: readonly Finding[], scope: Scope) {
  await $.prompt.fill({ text: fixPrompt(findings, scope), mode: 'insert' })
}

async function openPane($: Api) {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

export const register: Register = (on, options) => {
  timeoutMin = typeof options.timeoutMin === 'number' && options.timeoutMin > 0 ? options.timeoutMin : 15

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload killed any child this module had: what it was doing is over.
    await update($, run, () => null)
    await $.command.register({ name: 'codex-review', description: 'Codex に現在の差分をレビューさせる（読み取り専用）' })
    await $.command.register({ name: 'codex', description: 'Codex のレビュー指摘をペインで開く' })
    await refresh($)
    await setStatus($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await refresh($)
    }
    return done
  })

  on('command.run', { command: 'codex-review' }, async $ => {
    if ((await read($, run)) !== null) {
      return { text: 'Codex のレビューはもう走っています。' }
    }
    startReview($)
    return { text: 'Codex のレビューを始めました。結果は入力欄の上の帯と /codex に出ます。' }
  })

  on('command.run', { command: 'codex' }, async $ => {
    await openPane($)
    return { text: 'Codex レビューのペインを開きました。' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const now = await read($, diff)
    const running = await read($, run)
    const done = await read($, result)
    const failed = await read($, error)
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
            🔍 codex {clockText(running.elapsedS)} · {running.phase}{' '}
          </Text>
          <Button key="cancel" label="中止" onPress={cancel} />
        </Box>,
      )
    }
    if (failed !== null) {
      return stack(
        <Box>
          <Text color="red" wrap="truncate-end">
            🔍 codex 失敗: {failed}{' '}
          </Text>
          {now !== null && <Button key="retry" label="再試行" variant="primary" onPress={() => startReview($)} />}
          <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, error, () => null)} />
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
      if (top === undefined) {
        return stack(
          <Box>
            <Text color="green" wrap="truncate-end">
              🔍 codex 指摘なし{done.summary === '' ? '' : ` · ${done.summary}`}{' '}
            </Text>
            {close}
          </Box>,
        )
      }
      return stack(
        <Box>
          <Text color={SEVERITY_COLOR[top.severity]} wrap="truncate-end">
            🔍 {top.severity} · {location(top)} {top.title}
            {left.length > 1 ? ` · ほか${left.length - 1}件` : ''}{' '}
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
        <Button key="review" label="Codex でレビュー" variant="primary" onPress={() => startReview($)} />
        {close}
      </Box>,
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, diff)
    const running = await read($, run)
    const done = await read($, result)
    const failed = await read($, error)
    const hidden = await read($, dismissed)
    const left = done === null ? [] : visibleFindings(done.findings, hidden)
    const isStale = done !== null && now?.key !== done.key
    const head =
      running !== null
        ? `実行中 ${clockText(running.elapsedS)} · ${running.phase}`
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
            now !== null && <Button key="review" label="Codex でレビュー" variant="primary" onPress={() => startReview($)} />
          )}
        </Box>
        {done !== null && done.summary !== '' && (
          <Text dimColor wrap="truncate-end">
            {done.summary}
          </Text>
        )}
        {done !== null &&
          // Every finding: the engine scrolls the pane's body over a tree taller than it.
          left.map(f => (
            <Box flexDirection="column" key={`f-${f.id}`}>
              <Box>
                <Text color={SEVERITY_COLOR[f.severity]} dimColor={isStale} wrap="truncate-end">
                  {f.severity} {location(f)} {f.title}{' '}
                </Text>
                <Button key={`fix-${f.id}`} label="直させる" onPress={() => fill($, [f], done.scope)} />
                <Button key={`drop-${f.id}`} label="却下" onPress={() => update($, dismissed, all => [...all, f.id])} />
              </Box>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {f.body}
              </Text>
            </Box>
          ))}
      </Box>
    )
  })
}
