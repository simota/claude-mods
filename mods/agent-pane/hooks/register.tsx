import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRun, AgentRunStatus } from '../types'

const PANE = 'agent-pane'
const TITLE = 'エージェント'
const KEEP = 100
const TICK_MS = 1000

const runs = atom({ plugin: 'agent-pane', key: 'runs' } as const, [])
const now = atom({ plugin: 'agent-pane', key: 'now' } as const, 0)

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

let ticker: Timer | undefined
// Learnt from drawings and commands: session.start carries no viewport.
let isFullscreen: boolean | undefined
let hasAutoOpened = false
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
      if (agent === undefined || !ENDED.has(agent.status)) continue
      const status = agent.status === 'completed' ? 'completed' : 'failed'
      await update($, runs, list => finish(list, run.id, status, at))
    }
  }

  if ((await refreshStatus($)) === 0) {
    ticker?.cancel()
    ticker = undefined
  }
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

    if (isFullscreen === true && !hasAutoOpened) {
      hasAutoOpened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }

    const ran = await next(e)
    const endedAt = await $.clock.now()

    if (ran.deny !== undefined || ran.isError === true) {
      await update($, runs, list => finish(list, run.id, 'failed', endedAt))
    } else {
      // A background launch (the model's, or a plugin's spawn record) ends later; a teammate is not followed.
      const record = ran.result
      const agentId = !('status' in record)
        ? record.agentId
        : record.status === 'async_launched'
          ? record.agentId
          : undefined
      await update($, runs, list =>
        agentId === undefined
          ? finish(list, run.id, 'completed', endedAt)
          : list.map(one => (one.id === run.id ? { ...one, agentId } : one)),
      )
    }
    await refreshStatus($)

    return ran
  })

  // Learned from the band's viewport, not from every command.run: a hook there would
  // put this plugin's name on the output of every slash command.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
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
        {finished.map(run => (
          <Text key={run.id} wrap="truncate-end" dimColor={run.status === 'completed'}>
            <Text color={run.status === 'completed' ? 'success' : 'error'}>
              {run.status === 'completed' ? '✓ ' : '✗ '}
            </Text>
            {run.description}{' '}
            <Text dimColor>
              {run.type} · {formatDuration((run.endedAt ?? at) - run.startedAt)}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })
}
