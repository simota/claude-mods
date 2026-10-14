import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, SessionUsage } from 'claude-code'

import { barFor, colorFor, compact, describe, sparkCells, GREEN, RED, YELLOW } from '../hooks/meter'

const SURFACES = ['terminal', 'desktop'] as const

// Stands for the engine beneath the plugin: usage answers what `bottom` says, the band draws a marker.
const engine = (on: On) => {
  const bottom: { usage: SessionUsage } = {
    usage: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }
  mock.clock(on, { now: 0 })
  on('session.usage', () => ({ value: bottom.usage }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'beneath' }, 'beneath') as RenderElement
  })
  return bottom
}

let turn = 0
const endTurn = ($: Engine, extra: { agentId?: string } = {}) =>
  $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: `t${++turn}`,
    reason: 'answer',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 2_000,
      output_tokens: 8_000,
      cache_read_input_tokens: 110_000,
      cache_creation_input_tokens: 8_000,
    },
    ...extra,
  })

const setContext = (bottom: ReturnType<typeof engine>, percent: number, usd?: number) => {
  bottom.usage = {
    startedAt: 0,
    context: { window: 200_000, tokens: percent * 2_000, percent },
    rateLimits: [],
    ...(usd === undefined ? {} : { cost: { usd } }),
  }
}

const band = (surface: (typeof SURFACES)[number], bodyColumns = 80) =>
  ({
    plugin: 'context-meter',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }) as const

test('helpers format, color and encode', () => {
  expect(compact(120_000)).toBe('120k')
  expect(compact(1_500_000)).toBe('1.5M')
  expect(compact(950)).toBe('950')
  // The unit follows the rounded value: 999,999 is 1M, not 1000k.
  expect(compact(999_999)).toBe('1M')
  expect(compact(999_500)).toBe('1M')
  expect(compact(999_499)).toBe('999k')
  // Half a tenth rounds up: 1.95M is 2M (toFixed read the float 1.95 as 1.9499… and gave 1.9M).
  expect(compact(1_950_000)).toBe('2M')
  expect(compact(1_250_000)).toBe('1.3M')
  expect(compact(1_049_999)).toBe('1M')
  expect(compact(12_340_000)).toBe('12.3M')
  expect(colorFor(10)).toBe(GREEN)
  expect(colorFor(50)).toBe(YELLOW)
  expect(colorFor(80)).toBe(RED)
  expect(barFor(0)).toBe(0x2581)
  expect(barFor(100)).toBe(0x2588)
  const one = { percent: 100, tokens: 0, window: 1, input: 0, output: 0, at: 0 }
  const bytes = Uint8Array.from(atob(sparkCells([one])), c => c.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  expect(bytes.length).toBe(12)
  expect(view.getUint32(0, true)).toBe(0x2588)
  expect(view.getUint32(4, true)).toBe(RED)
  expect(view.getUint32(8, true)).toBe(0x01000000)
})

test('describe shows the change since the last turn', () => {
  const at = (percent: number) => ({ percent, tokens: 126_000, window: 1, input: 1_200_000, output: 8_000, at: 0 })
  expect(describe([])).toBeUndefined()
  expect(describe([at(59), at(63)])).toEqual({
    percent: '63%',
    delta: ' ▲4',
    rest: ' · 126k · turn in 1.2M / out 8k',
  })
  expect(describe([at(63), at(40)])?.delta).toBe(' ▼23')
})

test('a turn with no usage shows the context size alone, never under the turn label', () => {
  const sample = { percent: 60, tokens: 120_000, window: 200_000, at: 0 }
  expect(describe([sample])?.rest).toBe(' · 120k')
})

test('nothing is drawn before the first measured turn; the plugins beneath still draw', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ text: /ctx/ })).toBeUndefined()
    expect(await ui.find({ text: 'beneath' })).toBeDefined()
    await ui.unmount()
  }
})

test('a main-loop turn draws the meter above what lies beneath', async ($, on) => {
  const bottom = engine(on)
  setContext(bottom, 59)
  await endTurn($)
  setContext(bottom, 63, 1.234)
  await endTurn($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    // 63% of 200k is 126k of context; the turn sent 2k + 110k + 8k and received 8k.
    const line = await ui.find({ type: 'Text', text: /ctx 63% ▲4 · 126k · turn in 120k \/ out 8k · \$1\.23/ })
    expect(line).toBeDefined()
    const percent = (await ui.findAll({ type: 'Text', text: /63%/ })).find(t => t.text === '63%')
    expect(percent?.props.color).toBe('#fabd2f')
    expect(await ui.find({ text: 'beneath' })).toBeDefined()
    if (surface === 'terminal') {
      const spark = await ui.find({ type: 'Raster', key: 'spark' })
      expect(spark?.props.columns).toBe(2)
    } else {
      expect(await ui.find({ type: 'Raster' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /▅▆/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('subagent turns are not sampled', async ($, on) => {
  const bottom = engine(on)
  setContext(bottom, 30)
  await endTurn($, { agentId: 'a1' })
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('the sparkline keeps to the band width', async ($, on) => {
  const bottom = engine(on)
  for (let i = 0; i < 40; i++) {
    setContext(bottom, i * 2)
    await endTurn($)
  }
  // The line is `ctx 78% ▲2 · 156k · turn in 120k / out 8k`: 10 + 7 + 24 = 41 columns.
  const ui = await $.ui.mount(band('terminal', 60))
  const spark = await ui.find({ type: 'Raster', key: 'spark' })
  expect(spark?.props.columns).toBe(60 - 41 - 1)
  await ui.unmount()

  // No room beside the text: no sparkline, rather than all 40 samples.
  const narrow = await $.ui.mount(band('terminal', 40))
  expect(await narrow.find({ type: 'Raster', key: 'spark' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: /ctx 78%/ })).toBeDefined()
  await narrow.unmount()
})

test('a survey holds the band: only what lies beneath draws', async ($, on) => {
  const bottom = engine(on)
  setContext(bottom, 20)
  await endTurn($)
  const shown = band('terminal')
  const ui = await $.ui.mount({ ...shown, props: { ...shown.props, hasSurvey: true } })
  expect(await ui.find({ text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('band off: samples recorded, nothing drawn', { options: { band: false } }, async ($, on) => {
  const bottom = engine(on)
  setContext(bottom, 20)
  await endTurn($)
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ text: /ctx/ })).toBeUndefined()
  expect(await ui.find({ text: 'beneath' })).toBeDefined()
  await ui.unmount()
})
