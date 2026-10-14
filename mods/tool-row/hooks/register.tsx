import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { summarize } from './summary'

// Only Bash rows show a duration, so only Bash calls are timed: each write
// redraws the rows that read it.
const durations = atom({ plugin: 'tool-row', key: 'durations' } as const, {})
const KEEP = 300

function keepNewest(map: Record<string, number>): Record<string, number> {
  const entries = Object.entries(map)
  return entries.length > KEEP ? Object.fromEntries(entries.slice(-KEEP)) : map
}

export const register: Register = (on, options) => {
  const isCompact = options.compact !== false

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    const endedAt = await $.clock.now()
    await update($, durations, map => keepNewest({ ...map, [e.tool_use_id]: endedAt - startedAt }))
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isCompact || e.surface !== 'terminal') return next(e)
    const { tool, input, output, isRunning, isErrored, isInterrupted } = e.props
    if (isRunning || isInterrupted || output === undefined) return next(e)

    const durationMs = tool === 'Bash' ? (await read($, durations))[e.props.tool_use_id] : undefined
    const summary = summarize({ tool, input, output, isErrored, durationMs })
    if (summary === undefined) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Text color={summary.color}>{summary.icon}</Text>
        <Text color={isErrored ? summary.color : undefined} wrap="truncate-middle">{summary.label}</Text>
        {summary.stats.map(stat => <Text color={stat.color}>{stat.text}</Text>)}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
