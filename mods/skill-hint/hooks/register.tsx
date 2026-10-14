import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { suggest } from './match'

const hints = atom({ plugin: 'skill-hint', key: 'hints' } as const, [])

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta) return next(e)

    const available = new Set((await $.command.list()).map(command => command.name))
    await update($, hints, () => suggest(e.text, available))

    return next(e)
  }).catch(($, e, next) => next(e)) // A hint is never worth holding a prompt back.

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, hints)
    if (e.props.hasSurvey || shown.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>
          💡 skill候補: {shown.map(name => `/${name}`).join(' ')}{' '}
        </Text>
        <Button key="dismiss" label="閉じる" onPress={() => update($, hints, () => [])} />
      </Box>
    )
  })
}
