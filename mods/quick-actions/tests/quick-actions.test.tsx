import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { DEFAULT_ACTIONS, parseActions, slashCommand } from '../hooks/actions'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'quick-actions',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

type Calls = { submitted: string[]; filled: string[]; ran: string[] }

// Stands for the engine beneath the plugin, recording what the buttons asked for.
const engine = (on: On): Calls => {
  const calls: Calls = { submitted: [], filled: [], ran: [] }
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    calls.submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    calls.filled.push(e.text)
    return { isFilled: true, box: { text: e.text, cursor: e.text.length } }
  })
  on('command.run', ($, e) => {
    calls.ran.push(`/${e.command} ${e.args}`.trim())
    return {}
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return calls
}

let turn = 0
const runTurn = async ($: Engine, withEdit: boolean) => {
  const turnId = `t${++turn}`
  await $.turn.start({ text: 'go', turnId })
  if (withEdit) {
    await $.tool.call({ tool: 'Edit', file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' })
  }
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

const labels = async ($: Engine, surface: (typeof SURFACES)[number]) => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const found = []
  for (const key of ['action-1', 'action-2', 'action-3', 'action-c', 'dismiss']) {
    if ((await ui.find({ key })) !== undefined) {
      found.push(key)
    }
  }
  await ui.unmount()
  return found
}

describe('parseActions', () => {
  test('empty setting uses the defaults', () => {
    expect(parseActions('')).toEqual({ actions: DEFAULT_ACTIONS })
  })

  test('bad JSON, bad shape or a clash falls back with a reason', () => {
    expect(parseActions('{').error).toBeDefined()
    expect(parseActions('[{"key":"x","label":"a","prompt":"b","mode":"submit","when":"always"}]').error).toBeDefined()
    const twice = JSON.stringify([
      { key: '1', label: 'a', prompt: 'b', mode: 'submit', when: 'always' },
      { key: '1', label: 'c', prompt: 'd', mode: 'fill', when: 'edits' },
    ])
    expect(parseActions(twice).actions).toEqual(DEFAULT_ACTIONS)
  })

  test('a valid list replaces the defaults', () => {
    const mine = [{ key: 'g', label: 'Go', prompt: 'go', mode: 'submit', when: 'always' }]
    expect(parseActions(JSON.stringify(mine))).toEqual({ actions: mine })
  })

  test('slash prompts become command runs', () => {
    expect(slashCommand('/code-review')).toEqual({ command: 'code-review', args: '' })
    expect(slashCommand('/code-review high')).toEqual({ command: 'code-review', args: 'high' })
    expect(slashCommand('続けて')).toBeUndefined()
  })
})

test('a turn with edits shows every button, one without only continue', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    await runTurn($, true)
    expect(await labels($, surface)).toEqual(['action-1', 'action-2', 'action-3', 'action-c', 'dismiss'])
    await runTurn($, false)
    expect(await labels($, surface)).toEqual(['action-c', 'dismiss'])
  }
})

test('presses submit, run the slash command, or fill the prompt', async ($, on) => {
  const calls = engine(on)
  for (const surface of SURFACES) {
    for (const key of ['action-1', 'action-2', 'action-3', 'action-c']) {
      await runTurn($, true)
      const ui = await $.ui.mount({ ...BAND, surface })
      await ui.press({ key })
      await ui.unmount()
    }
  }
  expect(calls.submitted).toEqual([
    DEFAULT_ACTIONS[0]?.prompt, '続けて', DEFAULT_ACTIONS[0]?.prompt, '続けて',
  ])
  expect(calls.ran).toEqual(['/code-review', '/code-review'])
  expect(calls.filled).toEqual(['変更をコミットして', '変更をコミットして'])
})

test('a press hides the row', async ($, on) => {
  engine(on)
  await runTurn($, true)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'action-c' })).toBeUndefined()
  await ui.unmount()
})

test('the next prompt or turn hides the row', async ($, on) => {
  engine(on)
  await runTurn($, true)
  await $.prompt.submit({ text: 'something else', wait: false, origin: { kind: 'composer' } })
  expect(await labels($, 'terminal')).toEqual([])

  await runTurn($, false)
  await $.turn.start({ text: 'again', turnId: 'next' })
  expect(await labels($, 'terminal')).toEqual([])
})

test('what the plugins beneath draw stays under the row', async ($, on) => {
  // Registered first, so it answers above the engine's empty band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="below">beneath</Text>
  })
  engine(on)
  await runTurn($, false)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'action-c' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /beneath/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a running turn or a survey keeps the row out', async ($, on) => {
  engine(on)
  await runTurn($, true)
  for (const props of [{ isWorking: true }, { hasSurvey: true }]) {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, ...props } })
    expect(await ui.find({ key: 'action-c' })).toBeUndefined()
    await ui.unmount()
  }
})
