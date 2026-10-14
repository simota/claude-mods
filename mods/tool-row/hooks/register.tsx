import type { Register } from 'claude-code'

import { summarize } from './summary'

export const register: Register = (on, options) => {
  const isCompact = options.compact !== false

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isCompact || e.surface !== 'terminal') return next(e)
    const { tool, input, output, isRunning, isErrored, isInterrupted } = e.props
    if (isRunning || isInterrupted || output === undefined) return next(e)

    const summary = summarize({ tool, input, output, isErrored })
    if (summary === undefined) return next(e)

    // Only the engine's own row is replaced: a row a plugin beneath drew or
    // decorated (image-preview's thumbnail under it) is left as that plugin drew it.
    const below = await next(e)
    if (below.type !== 'engine') return below

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
