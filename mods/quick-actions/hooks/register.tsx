import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { actionsFor, parseActions, slashCommand } from './actions'
import type { Action } from './actions'
import { editsFiles } from './edits'

const isShown = atom({ plugin: 'quick-actions', key: 'isShown' } as const, false)
const hasEdits = atom({ plugin: 'quick-actions', key: 'hasEdits' } as const, false)
// Whether the prompt box holds a draft: the row steps aside while the person types.
const isTyping = atom({ plugin: 'quick-actions', key: 'isTyping' } as const, false)

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

const hide = ($: EngineInterface) => update($, isShown, () => false)

/** Runs one action; a failure says so and leaves the band up to try again. */
const runAction = async ($: EngineInterface, action: Action) => {
  await hide($)
  try {
    if (action.mode === 'fill') {
      // Inserted where the caret is, so a draft already typed is kept.
      const filled = await $.prompt.fill({ text: action.prompt, mode: 'insert' })
      if (!filled.isFilled) throw new Error('入力欄に入れられませんでした')
      return
    }
    const slash = slashCommand(action.prompt)
    if (slash !== undefined) {
      await $.command.run(slash)
      return
    }
    await $.prompt.submit({ text: action.prompt, asUser: true })
  } catch (error) {
    await update($, isShown, () => true)
    const reason = error instanceof Error ? error.message : String(error)
    await $.ui.toast(`${$.plugin.name}: 「${action.label}」を実行できませんでした: ${reason}`)
  }
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

  // A file changed through Bash is an edit too, read from the command's shape: no git is run.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && editsFiles(e.command)) {
      await update($, hasEdits, () => true)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted) {
      await update($, isShown, () => true)
    }
    return next(e)
  })

  // A draft in the box sets the row aside, and clearing the box brings it back, whatever
  // plugin above answers the submission. Written only when the draft starts or ends.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const hasDraft = box.text.trim() !== ''
    if (hasDraft !== (await read($, isTyping))) await update($, isTyping, () => hasDraft)
    return box
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    await hide($)
    // Sending empties the box without an edit the hook above would see.
    await update($, isTyping, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking || !(await read($, isShown)) || (await read($, isTyping))) {
      return next(e)
    }

    const shown = actionsFor(actions, await read($, hasEdits))
    // A row of nothing but 閉じる offers nothing.
    if (shown.length === 0) {
      return next(e)
    }

    const { Box, Button } = $.ui.resolve(e)
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
