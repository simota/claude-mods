import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

type Bottom = { isError: boolean; text: string }

// Stands for the engine beneath the plugin: tools answer what `bottom` says.
const engine = (on: On) => {
  const bottom: { next: Bottom; ran: string[] } = { next: { isError: false, text: 'ok' }, ran: [] }
  on('tool.call', ($, e) => {
    bottom.ran.push(String(e.tool))
    return { result: bottom.next.text, text: bottom.next.text, ...(bottom.next.isError ? { isError: true as const } : {}) }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine') as RenderElement
  })
  return bottom
}

let turn = 0
const startTurn = ($: Engine) => $.turn.start({ text: 'go', turnId: `t${++turn}` })
const endTurn = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: `t${turn}`, reason: 'answer' })

const edit = ($: Engine) =>
  $.tool.call({ tool: 'Edit', file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

const band = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'done-gate',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }) as const

const isBandShown = async ($: Engine, surface: (typeof SURFACES)[number]) => {
  const ui = await $.ui.mount(band(surface))
  const found = await ui.find({ text: /未検証の変更があります/ })
  await ui.unmount()
  return found !== undefined
}

test('an edit with no verification flags the band until a check runs', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    await startTurn($)
    await edit($)
    await endTurn($)
    expect(await isBandShown($, surface)).toBe(true)

    await startTurn($)
    await bash($, 'bun run typecheck')
    await endTurn($)
    expect(await isBandShown($, surface)).toBe(false)
  }
})

test('verification after the last edit leaves no band', async ($, on) => {
  engine(on)
  await startTurn($)
  await edit($)
  await bash($, 'cargo test')
  await endTurn($)
  for (const surface of SURFACES) {
    expect(await isBandShown($, surface)).toBe(false)
  }
})

test('a turn with no edits takes the band down', async ($, on) => {
  engine(on)
  await startTurn($)
  await edit($)
  await endTurn($)
  await startTurn($)
  await bash($, 'ls')
  await endTurn($)
  for (const surface of SURFACES) {
    expect(await isBandShown($, surface)).toBe(false)
  }
})

test('the dismiss button hides the band', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    await startTurn($)
    await edit($)
    await endTurn($)
    const ui = await $.ui.mount(band(surface))
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ text: /未検証の変更があります/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the same failure twice appends one note telling the model to diagnose', async ($, on) => {
  const bottom = engine(on)
  const session = mock.session(on)
  bottom.next = { isError: true, text: 'Error: build failed at 12:00:01 (exit 1)' }
  await bash($, 'swift build')
  expect(session.appended().length).toBe(0)
  bottom.next = { isError: true, text: 'Error: build failed at 12:00:09 (exit 1)' }
  await bash($, '  swift   build ')
  expect(session.appended().length).toBe(1)
  expect(JSON.stringify(session.appended()[0]?.message.content)).toContain('根本原因')
  await bash($, 'swift build')
  expect(session.appended().length).toBe(1)
})

test('a different error resets the count', async ($, on) => {
  const bottom = engine(on)
  const session = mock.session(on)
  bottom.next = { isError: true, text: 'error: missing module foo' }
  await bash($, 'swift build')
  bottom.next = { isError: true, text: 'error: type mismatch in bar' }
  await bash($, 'swift build')
  expect(session.appended().length).toBe(0)
})

test('git --no-verify is denied before the tool runs', async ($, on) => {
  const bottom = engine(on)
  for (const command of [
    'git commit -m "x" --no-verify',
    'git push --no-verify origin main',
    'git -C repo merge feature --no-verify',
    'git commit -n -m wip',
  ]) {
    const ran = await bash($, command)
    expect(ran.deny).toContain('--no-verify')
  }
  expect(bottom.ran.length).toBe(0)

  const ok = await bash($, 'git commit -m "mention no-verify in text"')
  expect(ok.deny).toBeUndefined()
  expect(bottom.ran).toEqual(['Bash'])
})
