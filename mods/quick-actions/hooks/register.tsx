import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { actionsFor, parseActions, slashCommand } from './actions'
import type { Action } from './actions'

const isShown = atom({ plugin: 'quick-actions', key: 'isShown' } as const, false)
const hasEdits = atom({ plugin: 'quick-actions', key: 'hasEdits' } as const, false)

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

const hide = ($: EngineInterface) => update($, isShown, () => false)

const runAction = async ($: EngineInterface, action: Action) => {
  await hide($)
  if (action.mode === 'fill') {
    await $.prompt.fill({ text: action.prompt })
    return
  }
  const slash = slashCommand(action.prompt)
  if (slash !== undefined) {
    await $.command.run(slash)
    return
  }
  await $.prompt.submit({ text: action.prompt, asUser: true })
}

export const register: Register = (on, options) => {
  const { actions, error } = parseActions(options.actions)

  on('session.start', ($, e, next) => {
    if (error !== undefined) {
      $.ui.toast(`${$.plugin.name}: ${error}。既定のボタンを使います`)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await hide($)
      await update($, hasEdits, () => false)
    }
    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, hasEdits, () => true)
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted) {
      await update($, isShown, () => true)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await hide($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking || !(await read($, isShown))) {
      return next(e)
    }

    const { Box, Button } = $.ui.resolve(e)
    const shown = actionsFor(actions, await read($, hasEdits))
    const mine = (
      <Box key="quick-actions" flexDirection="row" gap={2}>
        {shown.map(action => (
          <Button
            key={`action-${action.key}`}
            hotkey={action.key}
            plain
            onPress={() => runAction($, action)}
          >
            {action.label}
          </Button>
        ))}
        <Button key="dismiss" hotkey="x" plain dimColor role="dismiss" onPress={() => hide($)}>
          閉じる
        </Button>
      </Box>
    )

    // Stack this row above what the plugins beneath and the engine draw, rather than in its place.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })
}
