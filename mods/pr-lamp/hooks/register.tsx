import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PrSnapshot, PrThread } from '../types'
import {
  changeOf,
  contextOf,
  FAST_MS,
  jobOf,
  logTail,
  paneLines,
  PR_FIELDS,
  repoOf,
  SLOW_MS,
  snapshotOf,
  statusOf,
  THREADS_QUERY,
  threadsOf,
} from './lamp'

const PANE = 'pr-lamp'

const snapshot = atom({ plugin: 'pr-lamp', key: 'snapshot' } as const, null as PrSnapshot | null)
const problem = atom({ plugin: 'pr-lamp', key: 'problem' } as const, null as string | null)
const feed = atom({ plugin: 'pr-lamp', key: 'feed' } as const, [] as string[])

// Commands after which the pull request is worth asking about at once.
const MOVES = /\b(?:git\s+(?:push|checkout|switch|pull|merge|rebase)|gh\s+pr\s+(?:create|ready|merge|close|reopen|checkout|review|comment))\b/

/** gh's or git's answer, or why there is none. */
async function run($: EngineInterface, argv: string[]): Promise<{ ok: true; stdout: string } | { ok: false; why: string }> {
  try {
    const done = await $.process.run(argv, { timeoutMs: 30_000 })
    return done.exitCode === 0 ? { ok: true, stdout: done.stdout } : { ok: false, why: done.stderr.trim() || `exit ${done.exitCode}` }
  } catch {
    return { ok: false, why: "コマンドが見つかりません" }
  }
}

const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// The session's poll: one timer, and one fetch at a time (a push during a poll waits for it
// and then asks again). Feeding is the person's option, read once at load.
let isFeeding = true
let timer: Timer | undefined
let queue: Promise<unknown> = Promise.resolve()

async function nothing($: EngineInterface, why: string): Promise<void> {
  await update($, snapshot, () => null)
  await update($, problem, () => why)
  $.ui.status(undefined)
}

async function ask($: EngineInterface, isSoon: boolean): Promise<void> {
  if ((await $.session.repo())?.remote == null) return nothing($, 'origin リモートがありません')
  const head = await run($, ['git', 'branch', '--show-current'])
  const branch = head.ok ? head.stdout.trim() : ''
  if (branch === '') return nothing($, 'ブランチにいません（detached HEAD）')

  const viewed = await run($, ['gh', 'pr', 'view', '--json', PR_FIELDS])
  if (!viewed.ok) {
    if (/no pull requests? found/i.test(viewed.why)) return nothing($, `⎇ ${branch} に PR はありません`)
    // gh failing (offline, signed out) is asked again later rather than given up on.
    await nothing($, `gh: ${viewed.why.split('\n')[0]}`)
    return schedule($, SLOW_MS)
  }

  const pr = json(viewed.stdout) as { number?: unknown; url?: unknown } | null
  const prev = await read($, snapshot)
  const isSame = (s: PrSnapshot | null): s is PrSnapshot => s !== null && s.branch === branch && s.number === pr?.number
  const where = repoOf(typeof pr?.url === 'string' ? pr.url : '')
  let threads: PrThread[] | undefined
  if (where !== undefined && typeof pr?.number === 'number') {
    const query = ['-f', `query=${THREADS_QUERY}`, '-F', `owner=${where.owner}`, '-F', `name=${where.name}`, '-F', `number=${pr.number}`]
    const asked = await run($, ['gh', 'api', 'graphql', ...query])
    if (asked.ok) threads = threadsOf(json(asked.stdout))
  }
  // Threads that could not be read stay as they were, so they do not come back as new.
  const next = snapshotOf(pr, threads ?? (isSame(prev) ? prev.threads : []), branch, await $.clock.now())
  if (next === null) return nothing($, 'gh の答えを読めませんでした')

  await update($, snapshot, () => next)
  await update($, problem, () => null)
  $.ui.status(statusOf(next))

  // The first sight of a pull request is its baseline: only what changes after is news.
  if (isSame(prev)) {
    const change = changeOf(prev, next)
    if (change.toasts.length > 0) $.ui.toast(change.toasts.join(' · '))
    if (isFeeding && change.feed.length > 0) {
      const logs: string[] = []
      for (const check of change.failed) {
        const job = jobOf(check.url)
        if (job === undefined) continue
        const log = await run($, ['gh', 'run', 'view', '--job', job, '--log-failed'])
        if (log.ok && log.stdout.trim() !== '') logs.push(`Last lines of the failed log of ${check.name}:\n\`\`\`\n${logTail(log.stdout)}\n\`\`\``)
      }
      await update($, feed, all => [...all, ...change.feed, ...logs])
    }
  }

  if (next.state !== 'OPEN') return schedule($, undefined)
  const isRunning = next.checks.some(c => c.state === 'pending')
  schedule($, isSoon || isRunning ? FAST_MS : SLOW_MS)
}

/** The next ask after `ms`, replacing any; none when undefined. */
function schedule($: EngineInterface, ms: number | undefined): void {
  timer?.cancel()
  timer = ms === undefined ? undefined : $.clock.after(ms, () => void refresh($, false))
}

function refresh($: EngineInterface, isSoon: boolean): Promise<void> {
  const ran = queue.then(() => ask($, isSoon))
  queue = ran.catch(() => undefined)
  return ran.catch(() => undefined)
}

export const register: Register = (on, options) => {
  isFeeding = options.feed !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pr', description: '今のブランチの PR を開く（CI・レビュー・未解決スレッド・マージまでの残り）' })
    const started = await next(e)
    void refresh($, false)
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && MOVES.test(e.command)) void refresh($, /\bgit\s+push\b|\bgh\s+pr\s+create\b/.test(e.command))
    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed at an idle prompt, as loopback does.
    if (!isFeeding || e.origin.kind !== 'composer' || e.command !== undefined || e.isMeta || e.turnId !== undefined) return next(e)
    const waiting = await read($, feed)
    const s = await read($, snapshot)
    if (waiting.length === 0 || s === null) return next(e)
    await update($, feed, () => [])
    return next({ ...e, context: [...(e.context ?? []), contextOf(s, waiting)] })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'pr' }, async $ => {
    await refresh($, false)
    await $.ui.open({ id: PANE, title: 'Pull request' })
    const s = await read($, snapshot)
    return { text: s === null ? `pr-lamp: ${(await read($, problem)) ?? 'PR はありません'}` : `pr-lamp: ${statusOf(s)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    if (s === null) return <Text dimColor>{(await read($, problem)) ?? 'まだ PR を見ていません。'}</Text>
    const lines = paneLines(s)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 8)
    const rows = [...lines.checks, ...lines.threads]
    return (
      <Box flexDirection="column">
        <Text bold>{lines.head}</Text>
        <Text dimColor>{lines.meta}</Text>
        {lines.left.map(line => (
          <Text bold color={line.startsWith('🟢') ? 'green' : 'yellow'}>{line}</Text>
        ))}
        {rows.slice(0, room).map(row => (
          <Text color={row.startsWith('✗') ? 'red' : undefined} dimColor={row.startsWith('✓') || row.startsWith('–')}>{row}</Text>
        ))}
        {rows.length > room && <Text dimColor>…ほか {rows.length - room} 行</Text>}
        <Text dimColor>{s.url}</Text>
      </Box>
    )
  })
}
