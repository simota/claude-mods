import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'

import { parseViolations, ruleName } from '../hooks/audit'

const SURFACES = ['terminal', 'desktop'] as const

const LONG = '実装しました。'.repeat(40)

const USAGE = {
  input_tokens: 1_200,
  output_tokens: 180,
  cache_read_input_tokens: 110_000,
  cache_creation_input_tokens: 0,
} as const

const answered = (text: string): ModelForkResult => ({ isAnswered: true, text, usage: USAGE })

const FOUND = JSON.stringify({
  violations: [
    { rule: 'R1', quote: 'テストは全部通ります', why: 'このターンでテストを実行していない' },
    { rule: 'R5', quote: '他にも3案あります', why: '頼まれていない選択肢を並べた' },
    { rule: 'R3', quote: 'API は v2 で対応済み', why: '確認せずに断定した' },
  ],
})

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'self-audit',
  props: {
    title: '自己監査',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// Stands for the engine beneath the plugin: the fork answers what `bottom.reply` says, the band draws a marker.
function engine(on: On) {
  const bottom = { reply: answered(FOUND), forks: 0, opened: [] as string[] }
  on('model.fork', () => {
    bottom.forks += 1
    return { value: bottom.reply }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.open', ($, e) => {
    bottom.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="beneath">beneath</Text>
  })
  return bottom
}

let turn = 0
const endTurn = ($: Engine, extra: { answer?: string; agentId?: string; isAborted?: boolean } = {}) =>
  $.turn.complete({
    answer: LONG,
    durationMs: 1,
    isAborted: false,
    turnId: `t${++turn}`,
    reason: 'answer',
    ...extra,
  })

const submit = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })

describe('parseViolations', () => {
  test('reads bare and fenced JSON', () => {
    expect(parseViolations(FOUND)).toHaveLength(3)
    expect(parseViolations('```json\n{"violations":[{"rule":"R2","quote":"q","why":"w"}]}\n```')).toEqual([
      { rule: 'R2', quote: 'q', why: 'w' },
    ])
    expect(parseViolations('{"violations":[]}')).toEqual([])
  })

  test('drops malformed entries and refuses what is not the asked shape', () => {
    expect(parseViolations('{"violations":[{"rule":"R1"},{"rule":"R4","why":"w"}]}')).toEqual([
      { rule: 'R4', quote: '', why: 'w' },
    ])
    expect(parseViolations('違反はありません')).toBeUndefined()
    expect(parseViolations('{"violations": "none"}')).toBeUndefined()
    expect(parseViolations('{"violations": [')).toBeUndefined()
  })

  test('names rules by label', () => {
    expect(ruleName('R1')).toBe('未検証の完了報告')
    expect(ruleName('r5')).toBe('スコープの水増し')
    expect(ruleName('other')).toBe('other')
  })
})

test('a long main-loop reply is audited and its violations stack above the band beneath', async ($, on) => {
  const clock = mock.clock(on)
  const bottom = engine(on)
  await endTurn($)
  await clock.settle()
  expect(bottom.forks).toBe(1)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'self-audit', surface, ...BAND })
    const rows = (await ui.findAll({ type: 'Text', text: /⚠ self-audit/ })).map(one => one.text)
    expect(rows).toEqual([
      '⚠ self-audit: 未検証の完了報告 — このターンでテストを実行していない',
      '⚠ self-audit: スコープの水増し — 頼まれていない選択肢を並べた',
    ])
    expect((await ui.find({ type: 'Text', text: /⚠ self-audit/ }))?.props.color).toBe('#fb4934')
    expect(await ui.find({ type: 'Text', text: /他1件/ })).toBeDefined()
    expect(await ui.find({ text: 'beneath' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'self-audit', surface: 'terminal', ...BAND })
  await ui.press({ key: 'details' })
  expect(bottom.opened).toEqual(['self-audit'])
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ text: /⚠ self-audit/ })).toBeUndefined()
  expect(await ui.find({ text: 'beneath' })).toBeDefined()
  await ui.unmount()
})

test('short, subagent and aborted turns are not audited', async ($, on) => {
  const clock = mock.clock(on)
  const bottom = engine(on)
  await endTurn($, { answer: '了解です。' })
  await endTurn($, { agentId: 'a1' })
  await endTurn($, { isAborted: true })
  await clock.settle()
  expect(bottom.forks).toBe(0)
})

test('the next prompt hides the band, and an audit it outran is dropped', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  await endTurn($)
  await clock.settle()
  await submit($, '次の作業')

  let ui = await $.ui.mount({ plugin: 'self-audit', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /⚠ self-audit/ })).toBeUndefined()
  await ui.unmount()

  await endTurn($)
  await submit($, 'さらに次')
  await clock.settle()
  ui = await $.ui.mount({ plugin: 'self-audit', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /⚠ self-audit/ })).toBeUndefined()
  await ui.unmount()
})

test('a garbled or clean audit shows nothing', async ($, on) => {
  const clock = mock.clock(on)
  const bottom = engine(on)
  bottom.reply = answered('特に問題ありません。')
  await endTurn($)
  await clock.settle()
  bottom.reply = answered('{"violations":[]}')
  await endTurn($)
  await clock.settle()
  expect(bottom.forks).toBe(2)

  const ui = await $.ui.mount({ plugin: 'self-audit', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /⚠ self-audit/ })).toBeUndefined()
  expect(await ui.find({ text: 'beneath' })).toBeDefined()
  await ui.unmount()
})

test('the pane lists every violation with its quote and the fork cost', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  for (const surface of SURFACES) {
    const empty = await $.ui.mount({ plugin: 'self-audit', surface, ...PANE })
    expect(await empty.find({ text: /違反は見つかっていません/ })).toBeDefined()
    await empty.unmount()
  }

  await endTurn($)
  await clock.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'self-audit', surface, ...PANE })
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    expect(texts).toContain('「テストは全部通ります」')
    expect(texts).toContain('⚠ 未確認の断定（R3）')
    expect(texts).toContain('fork: cache_read 110k · in 1k · out 180')
    await ui.unmount()
  }
})
