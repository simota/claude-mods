import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRun, AgentRunStatus } from '../types'

const PANE = 'agent-pane'
const TITLE = 'エージェント'
const KEEP = 100
const TICK_MS = 1000
// Ticks in a row a background run may be missing from the roster before it counts as ended.
const MISS_LIMIT = 3

const runs = atom({ plugin: 'agent-pane', key: 'runs' } as const, [])
const now = atom({ plugin: 'agent-pane', key: 'now' } as const, 0)
const hasAutoOpened = atom({ plugin: 'agent-pane', key: 'hasAutoOpened' } as const, false)

const ENDED = new Set(['completed', 'failed', 'killed'])

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分${s % 60}秒`
  return `${Math.floor(m / 60)}時間${m % 60}分`
}

function finish(list: AgentRun[], id: string, status: AgentRunStatus, endedAt: number): AgentRun[] {
  return list.map(run => (run.id === id ? { ...run, status, endedAt } : run))
}

const GLYPH: Record<Exclude<AgentRunStatus, 'running'>, { mark: string; color: string }> = {
  completed: { mark: '✓ ', color: 'success' },
  failed: { mark: '✗ ', color: 'error' },
  unknown: { mark: '? ', color: 'warning' },
  detached: { mark: '↗ ', color: 'suggestion' },
}

// The timer lives in this environment only; a reload drops it and session.start starts it again.
let ticker: Timer | undefined
// Learnt from the terminal's band drawing: session.start carries no viewport.
let isFullscreen: boolean | undefined
let shownStatus: string | undefined

async function refreshStatus($: EngineInterface): Promise<number> {
  const running = (await read($, runs)).filter(run => run.status === 'running').length
  const text = running > 0 ? `agents: ${running} running` : undefined
  if (text !== shownStatus) {
    shownStatus = text
    $.ui.status(text)
  }
  return running
}

// Background agents return from their Agent call at launch; their end is read from $.agent.list().
async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)

  const pending = (await read($, runs)).filter(run => run.status === 'running' && run.agentId !== undefined)
  if (pending.length > 0) {
    const agents = await $.agent.list()
    for (const run of pending) {
      const agent = agents.find(one => one.id === run.agentId)
      if (agent === undefined) {
        // The engine drops a subagent's entry some time after it ends: past the limit, its end is unknown.
        const misses = (run.misses ?? 0) + 1
        await update($, runs, list =>
          list.map(one =>
            one.id !== run.id
              ? one
              : misses >= MISS_LIMIT
                ? { ...one, misses, status: 'unknown', endedAt: at }
                : { ...one, misses },
          ),
        )
        continue
      }
      if (!ENDED.has(agent.status)) {
        if (run.misses) await update($, runs, list => list.map(one => (one.id === run.id ? { ...one, misses: 0 } : one)))
        continue
      }
      const status = agent.status === 'completed' ? 'completed' : 'failed'
      await update($, runs, list => finish(list, run.id, status, at))
    }
  }

  if ((await refreshStatus($)) === 0) {
    ticker?.cancel()
    ticker = undefined
  }
}

/**
 * Pairs runs whose call was lost with the roster's still-working agents of the same description
 * and type: the newest run first, each agent at most once, never one another run already follows.
 * The roster lists in spawn order, so the last unclaimed match is the newest agent.
 */
async function adoptFromRoster(
  $: EngineInterface,
  list: readonly AgentRun[],
  orphans: readonly AgentRun[],
): Promise<Map<string, string>> {
  const agents = await $.agent.list().catch(() => [])
  const claimed = new Set(list.flatMap(run => (run.agentId !== undefined ? [run.agentId] : [])))
  const matched = new Map<string, string>()
  for (const run of [...orphans].sort((a, b) => b.startedAt - a.startedAt)) {
    const agent = [...agents]
      .reverse()
      .find(one => !claimed.has(one.id) && !ENDED.has(one.status) && one.description === run.description && one.type === run.type)
    if (agent === undefined) continue
    claimed.add(agent.id)
    matched.set(run.id, agent.id)
  }
  return matched
}

function ensureTicker($: EngineInterface): void {
  if (ticker !== undefined) return
  ticker = $.clock.every(TICK_MS, () => void tick($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      // `/agents` is Claude Code's own command, which a plugin may not take.
      name: 'agent-pane',
      description: 'サブエージェントの実行状況をペインに表示する',
    })

    // After a reload a foreground run's waiting call is gone. One the roster still lists as
    // working (same description and type) is followed from the roster like a background run;
    // only one it no longer lists has an end that cannot be learnt.
    const at = await $.clock.now()
    const list = await read($, runs)
    const orphans = list.filter(run => run.status === 'running' && run.agentId === undefined)
    if (orphans.length > 0) {
      const matched = await adoptFromRoster($, list, orphans)
      await update($, runs, all =>
        all.map(run => {
          if (run.status !== 'running' || run.agentId !== undefined) return run
          const agentId = matched.get(run.id)
          return agentId !== undefined ? { ...run, agentId, misses: 0 } : { ...run, status: 'unknown', endedAt: at }
        }),
      )
    }
    if ((await read($, runs)).some(run => run.status === 'running' && run.agentId !== undefined)) ensureTicker($)
    await refreshStatus($)

    return next(e)
  })

  on('command.run', { command: 'agent-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'エージェントペインを開きました。' }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const run: AgentRun = {
      id: e.tool_use_id,
      type: e.subagent_type ?? 'general-purpose',
      description: e.description,
      startedAt,
      status: 'running',
    }
    await update($, now, () => startedAt)
    await update($, runs, list => [...list.filter(one => one.id !== run.id), run].slice(-KEEP))
    await refreshStatus($)
    ensureTicker($)

    if (isFullscreen === true && !(await read($, hasAutoOpened))) {
      await update($, hasAutoOpened, () => true)
      void $.ui.open({ id: PANE, title: TITLE })
    }

    const ran = await next(e)
    const endedAt = await $.clock.now()

    if (ran.deny !== undefined || ran.isError === true) {
      await update($, runs, list => finish(list, run.id, 'failed', endedAt))
    } else {
      // A background launch (the model's, or a plugin's spawn record) ends later and is followed;
      // a teammate or a remote launch is not followed, so it is drawn as launched, never as done.
      // Another plugin may answer the call with something other than the tool's record.
      const record: unknown = ran.result
      const isRecord = typeof record === 'object' && record !== null
      const status = isRecord && 'status' in record ? (record as { status?: unknown }).status : undefined
      const named = isRecord && 'agentId' in record ? (record as { agentId?: unknown }).agentId : undefined
      const agentId =
        isRecord && (status === undefined || status === 'async_launched') && typeof named === 'string' ? named : undefined
      if (agentId !== undefined) {
        await update($, runs, list => list.map(one => (one.id === run.id ? { ...one, agentId } : one)))
      } else if (status === 'completed' || !isRecord) {
        // A plain answer from another plugin is the call's whole result: it is done.
        await update($, runs, list => finish(list, run.id, 'completed', endedAt))
      } else {
        await update($, runs, list => finish(list, run.id, 'detached', endedAt))
      }
    }
    await refreshStatus($)

    return ran
  })

  // Learned from the terminal's band viewport, not from every command.run: a hook there would
  // put this plugin's name on the output of every slash command. Another surface's layout says
  // nothing about whether the terminal docks a pane.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.surface === 'terminal' && e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const at = await read($, now)
    const running = list.filter(run => run.status === 'running').reverse()
    const finished = list.filter(run => run.status !== 'running').reverse()

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>まだエージェントは起動していません。</Text>}
        {running.length > 0 && <Text bold>実行中 ({running.length})</Text>}
        {running.map(run => (
          <Text key={run.id} wrap="truncate-end">
            <Text color="warning">● </Text>
            {run.description} <Text dimColor>{run.type} · {formatDuration(at - run.startedAt)}</Text>
          </Text>
        ))}
        {finished.length > 0 && <Text bold>完了 ({finished.length})</Text>}
        {finished.map(run => {
          const glyph = GLYPH[run.status as Exclude<AgentRunStatus, 'running'>]
          const detail =
            run.status === 'detached'
              ? '起動済み（追跡外）'
              : run.status === 'unknown'
                ? `結果不明 · ${formatDuration((run.endedAt ?? at) - run.startedAt)}以上`
                : formatDuration((run.endedAt ?? at) - run.startedAt)
          return (
            <Text key={run.id} wrap="truncate-end" dimColor={run.status === 'completed'}>
              <Text color={glyph.color}>{glyph.mark}</Text>
              {run.description}{' '}
              <Text dimColor>
                {run.type} · {detail}
              </Text>
            </Text>
          )
        })}
      </Box>
    )
  })
}
