import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { clampTimeout, isJudgeable, parseVerdict } from '../hooks/judge'

const SURFACES = ['terminal', 'desktop'] as const
const ON = { options: { enabled: true } } as const

const VAGUE = 'このページをいい感じにしておいて'
const CLEAR = 'src/app.ts の parseDate を ISO 8601 に対応させて、既存テストが通るようにして'

const BAND = {
  plugin: 'prompt-coach',
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

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Calls = { judged: string[]; entered: string[]; filled: string[]; timeouts: (number | undefined)[] }

// Stands for the engine beneath the plugin: a judge that calls only VAGUE ambiguous,
// or never answers in time when `isSlow`.
const engine = (on: On, isSlow = false): Calls => {
  const calls: Calls = { judged: [], entered: [], filled: [], timeouts: [] }
  on('model.complete', ($, e) => {
    calls.judged.push(e.prompt)
    calls.timeouts.push(e.timeoutMs)
    if (isSlow) return { value: { isAnswered: false, reason: 'aborted', usage: USAGE } as const }
    const isVague = e.prompt.includes(VAGUE)
    const text = isVague
      ? '{"ambiguous": true, "missing": ["対象の範囲", "完了条件"], "rewrite": "<対象> を <完了条件> になるよう整えて"}'
      : '{"ambiguous": false, "missing": []}'
    return { value: { isAnswered: true, text, usage: USAGE } as const }
  })
  on('prompt.submit', ($, e) => {
    calls.entered.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    calls.filled.push(e.text)
    return { isFilled: true, box: { text: e.text, cursor: e.text.length } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return calls
}

const typed = ($: Engine, text: string, extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra })

describe('judge helpers', () => {
  test('parseVerdict reads JSON around prose and rejects anything unclear', () => {
    expect(parseVerdict('ok {"ambiguous": true, "missing": ["a", "b", "c"], "rewrite": "r"}')).toEqual({
      isAmbiguous: true,
      missing: ['a', 'b'],
      rewrite: 'r',
    })
    expect(parseVerdict('{"ambiguous": false}')).toEqual({ isAmbiguous: false, missing: [] })
    expect(parseVerdict('maybe')).toBeUndefined()
    expect(parseVerdict('{"ambiguous": "yes"}')).toBeUndefined()
    expect(parseVerdict('{broken')).toBeUndefined()
  })

  test('only mid-length prompts that are not commands are judged', () => {
    expect(isJudgeable('続けて')).toBe(false)
    expect(isJudgeable('/code-review high please now')).toBe(false)
    expect(isJudgeable(VAGUE)).toBe(true)
    expect(isJudgeable('x'.repeat(1501))).toBe(false)
  })

  test('the time limit stays within 0.5 to 3 seconds', () => {
    expect(clampTimeout(10000)).toBe(3000)
    expect(clampTimeout(100)).toBe(500)
    expect(clampTimeout(undefined)).toBe(3000)
  })
})

test('off by default: nothing is judged', async ($, on) => {
  const calls = engine(on)
  const result = await typed($, VAGUE)
  expect(result.drop).toBeUndefined()
  expect(calls.judged).toEqual([])
  expect(calls.entered).toEqual([VAGUE])
})

test('skips commands, hidden prompts, prompts typed over a turn, queued and short ones', ON, async ($, on) => {
  const calls = engine(on)
  await typed($, `/review ${VAGUE}`, { command: { name: 'review', args: VAGUE } })
  await typed($, VAGUE, { isMeta: true })
  await typed($, VAGUE, { turnId: 't1' })
  await typed($, VAGUE, { wait: true })
  await typed($, 'はい、それで')
  expect(calls.judged).toEqual([])
  expect(calls.entered.length).toBe(5)
})

test('an ambiguous prompt is held back once, with the band', ON, async ($, on) => {
  const calls = engine(on)
  const result = await typed($, VAGUE)
  expect(result.drop).toContain('曖昧')
  expect(calls.entered).toEqual([])
  expect(calls.timeouts).toEqual([3000])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /対象の範囲 \/ 完了条件/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /案: <対象>/ })).toBeDefined()
    expect(await ui.find({ key: 'send' })).toBeDefined()
    await ui.unmount()
  }

  // The same text again goes through, unjudged.
  const again = await typed($, VAGUE)
  expect(again.drop).toBeUndefined()
  expect(calls.judged.length).toBe(1)
  expect(calls.entered).toEqual([VAGUE])
})

test('a clear prompt goes through unchanged', ON, async ($, on) => {
  const calls = engine(on)
  const result = await typed($, CLEAR)
  expect(result.drop).toBeUndefined()
  expect(calls.entered).toEqual([CLEAR])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.unmount()
})

test('a judge that runs out of time lets the prompt through', { options: { enabled: true, timeoutMs: 800 } }, async ($, on) => {
  const calls = engine(on, true)
  const result = await typed($, VAGUE)
  expect(result.drop).toBeUndefined()
  expect(calls.entered).toEqual([VAGUE])
  expect(calls.timeouts).toEqual([800])
})

test('send as is submits the original, which the coach then lets through', ON, async ($, on) => {
  const calls = engine(on)
  for (const surface of SURFACES) {
    const text = `${VAGUE} (${surface})`
    await typed($, text)
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'send' })
    expect(await ui.find({ key: 'send' })).toBeUndefined()
    await ui.unmount()
  }
  expect(calls.entered).toEqual([`${VAGUE} (terminal)`, `${VAGUE} (desktop)`])
  expect(calls.judged.length).toBe(2)
})

test('add a condition fills the prompt; dismiss puts the original back', ON, async ($, on) => {
  const calls = engine(on)
  for (const surface of SURFACES) {
    await typed($, `${VAGUE} 1 ${surface}`)
    let ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'add' })
    await ui.unmount()

    await typed($, `${VAGUE} 2 ${surface}`)
    ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ key: 'send' })).toBeUndefined()
    await ui.unmount()
  }
  expect(calls.filled).toEqual([
    `${VAGUE} 1 terminal\n完了条件: `,
    `${VAGUE} 2 terminal`,
    `${VAGUE} 1 desktop\n完了条件: `,
    `${VAGUE} 2 desktop`,
  ])
  expect(calls.entered).toEqual([])
})

test('what the plugins beneath draw stays under the row', ON, async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="below">beneath</Text>
  })
  engine(on)
  await typed($, VAGUE)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'send' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /beneath/ })).toBeDefined()
    await ui.unmount()
  }
})
