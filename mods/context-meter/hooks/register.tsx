import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Sample } from '../types'
import { FG4, MAX_SAMPLES, barFor, colorFor, describe, hex, lineText, sparkCells } from './meter'

const samples = atom({ plugin: 'context-meter', key: 'samples' } as const, [] as Sample[])

export const register: Register = (on, options) => {
  const isBandOn = options.band !== false

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const { context, cost } = await $.session.usage()
    if (context.percent !== undefined) {
      const usage = e.usage
      const sample: Sample = {
        percent: context.percent,
        tokens: context.tokens ?? 0,
        window: context.window,
        ...(usage === undefined
          ? {}
          : {
              input: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
              output: usage.output_tokens,
            }),
        ...(cost === undefined ? {} : { costUsd: cost.usd }),
        at: await $.clock.now(),
      }
      await update($, samples, list => [...list, sample].slice(-MAX_SAMPLES))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isBandOn || e.props.hasSurvey) {
      return next(e)
    }

    const list = await read($, samples)
    const parts = describe(list)
    if (parts === undefined) {
      return next(e)
    }

    // Draw this line on top of whatever the plugins beneath draw, rather than in its place.
    const below = await next(e)
    const text = lineText(parts)
    const room = Math.max(0, e.props.bodyColumns - text.length - 1)
    // slice(-0) is the whole list: with no room left, there is no sparkline at all.
    const spark = room === 0 ? [] : list.slice(-Math.min(list.length, room))
    const percentColor = hex(colorFor(list.at(-1)?.percent ?? 0))
    const dim = hex(FG4)
    const { Box, Text } = $.ui.resolve(e)

    const label = (
      <Text>
        <Text color={dim}>ctx </Text>
        <Text color={percentColor}>{parts.percent}</Text>
        <Text color={dim}>
          {parts.delta}
          {parts.rest}
        </Text>
      </Text>
    )

    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {spark.length > 0 && <Raster key="spark" columns={spark.length} rows={1} cells={sparkCells(spark)} />}
            <Text> </Text>
            {label}
          </Box>
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={percentColor}>{spark.map(s => String.fromCodePoint(barFor(s.percent))).join('')} </Text>
          {label}
        </Box>
        {below}
      </Box>
    )
  })
}
