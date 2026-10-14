import { describe, expect, test } from 'claude-code/testing'
import type { CommandInfo, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { suggest } from '../hooks/match'

const ALL = new Set([
  'coding-debug', 'coding-review', 'quality-review', 'security-scan', 'performance-scan',
  'research-route', 'planning-router', 'coding-refactor', 'coding-test', 'coding-implement',
  'design-ux', 'ux-scan', 'image-direction', 'clarify',
])

const HINTS = { type: 'Text', text: /skill候補/ }

const BAND = {
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

describe('suggest', () => {
  test('matches Japanese and English keywords', () => {
    expect(suggest('ログイン画面のバグを直して', ALL)).toEqual(['coding-debug'])
    expect(suggest('画像のデザインを整えて', ALL)).toEqual(['design-ux', 'ux-scan', 'image-direction'])
    expect(suggest('please review this diff', ALL)).toEqual(['coding-review', 'quality-review'])
    expect(suggest('APIが遅いので調査して', ALL)).toEqual(['performance-scan', 'research-route'])
  })

  test('caps at three suggestions', () => {
    expect(suggest('バグとセキュリティとパフォーマンスとテスト', ALL)).toHaveLength(3)
  })

  test('drops skills that are not available', () => {
    expect(suggest('please review this', new Set(['quality-review']))).toEqual(['quality-review'])
    expect(suggest('バグを直して', new Set())).toEqual([])
  })

  test('stays quiet when a skill is already named', () => {
    expect(suggest('coding-debug でバグを見て', ALL)).toEqual([])
  })

  test('does not match words inside other words', () => {
    expect(suggest('explain the planet layout', ALL)).toEqual([])
  })

  test('a one-word skill name in prose does not silence the hints', () => {
    expect(suggest('Can you clarify why this test throws an error?', ALL)).toEqual(['coding-debug', 'coding-test'])
  })

  test('a slash name or a hyphenated name does count as naming a skill', () => {
    expect(suggest('/simplify this bug fix', new Set([...ALL, 'simplify']))).toEqual([])
    expect(suggest('use coding-debug on this bug', ALL)).toEqual([])
    expect(suggest('use /clarify first; the bug is odd', ALL)).toEqual([])
  })

  test('a name the session does not have is not a skill', () => {
    expect(suggest('use coding-debug on this bug', new Set(['coding-test']))).toEqual([])
    expect(suggest('use foo-bar on this test', new Set(['coding-test']))).toEqual(['coding-test'])
  })

  test('Japanese keywords need the intent, not a substring', () => {
    expect(suggest('コンテストの結果ページを作って', ALL)).toEqual([])
    expect(suggest('いい感じです、ありがとう', ALL)).toEqual([])
    expect(suggest('この画面をいい感じにして', ALL)).toEqual(['clarify'])
    expect(suggest('デザインパターンでリファクタして', ALL)).toEqual(['coding-refactor'])
    expect(suggest('エラー処理を追加して', ALL)).toEqual([])
    expect(suggest('ユニットテストを書いて', ALL)).toEqual(['coding-test'])
  })

  test('English keywords need the intent', () => {
    expect(suggest('Add error handling to the parser', ALL)).toEqual([])
    expect(suggest('the build fails on CI', ALL)).toEqual(['coding-debug'])
    expect(suggest('apply the strategy design pattern', ALL)).toEqual([])
  })

  test("a plugin's skill matches by its short name and is suggested in full", () => {
    expect(suggest('バグを直して', new Set(['myplug:coding-debug']))).toEqual(['myplug:coding-debug'])
    expect(suggest('バグを直して', new Set(['myplug:coding-debug', 'coding-debug']))).toEqual(['coding-debug'])
  })
})

function bottoms(on: On, names: readonly string[]) {
  const commands: CommandInfo[] = names.map(name => ({ name, description: '', source: 'user' }))
  on('command.list', () => ({ value: commands }))
  // The engine's own band: an empty box, drawn when the plugin passes.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
}

function submit($: Engine, text: string) {
  return $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
}

test('the band shows hints after a prompt and hides on dismiss', async ($, on) => {
  bottoms(on, ['coding-debug', 'coding-test'])
  const ran = await submit($, 'テストが落ちるバグ')
  expect(ran.text).toBe('テストが落ちるバグ')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'skill-hint', surface, ...BAND })
    expect((await ui.find(HINTS))?.text).toMatch('/coding-debug /coding-test')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'skill-hint', surface: 'terminal', ...BAND })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find(HINTS)).toBeUndefined()
  await ui.unmount()
})

test('a slash command clears earlier hints, as any next prompt does', async ($, on) => {
  bottoms(on, ['coding-debug'])
  await submit($, 'バグ')
  await $.prompt.submit({
    text: '/coding-debug',
    command: { name: 'coding-debug', args: '' },
    origin: { kind: 'composer' },
    wait: false,
  })

  const ui = await $.ui.mount({ plugin: 'skill-hint', surface: 'terminal', ...BAND })
  expect(await ui.find(HINTS)).toBeUndefined()
  await ui.unmount()
})

test('a prompt with no intent clears earlier hints', async ($, on) => {
  bottoms(on, ['coding-debug'])
  await submit($, 'バグ')
  await submit($, 'ありがとう')

  const ui = await $.ui.mount({ plugin: 'skill-hint', surface: 'terminal', ...BAND })
  expect(await ui.find(HINTS)).toBeUndefined()
  await ui.unmount()
})
