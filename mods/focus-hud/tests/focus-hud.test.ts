import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { blank, lineOf, stepOf, summaryOf, targetOf, waitOf } from '../hooks/hud'

describe('hud', () => {
  test('names what a call acts on, short', () => {
    expect(targetOf('Edit', { file_path: '/w/src/app.ts' })).toBe('app.ts')
    expect(targetOf('Bash', { command: 'cd web && PORT=1 pnpm test --watch' })).toBe('pnpm test')
    expect(targetOf('mcp__claude-in-chrome__navigate', { url: 'https://example.com/a?b' })).toBe('example.com')
    expect(targetOf('Grep', { pattern: 'TODO' })).toBe('"TODO"')
    expect(summaryOf('mcp__claude-in-chrome__navigate', { url: 'https://x.dev' })).toBe('navigate x.dev')
  })

  test('takes the todo in progress', () => {
    expect(stepOf([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Writing tests' }])).toBe('Writing tests')
    expect(stepOf([{ content: 'a', status: 'pending' }])).toBe('')
  })

  test('says what it waits on, the person first', () => {
    const s = { ...blank(), goal: 'fix login', isRunning: true, turnStartedAt: 0 }
    expect(waitOf({ ...s, isRunning: false }, 0)).toBe('あなたの入力待ち')
    expect(waitOf(s, 4_000)).toBe('応答生成中 (4s)')
    const bash = { id: 'c1', tool: 'Bash', summary: 'Bash pnpm test', startedAt: 1_000 }
    expect(waitOf({ ...s, calls: [bash] }, 75_000)).toBe('Bash の終了待ち (1m14s)')
    expect(waitOf({ ...s, calls: [bash], asking: ['c1'] }, 2_000)).toBe('許可待ち: Bash pnpm test')
    expect(waitOf({ ...s, calls: [{ ...bash, tool: 'AskUserQuestion' }] }, 2_000)).toBe('あなたの回答待ち')
    expect(lineOf({ ...s, step: 'Writing tests', target: 'app.ts', calls: [bash] }, 3_000)).toBe('🎯 fix login › Writing tests · 📄 app.ts · ⚙ Bash pnpm test · ⏳ Bash の終了待ち (2s)')
    expect(lineOf(blank(), 0)).toBeUndefined()
  })
})

function world(on: On) {
  const clock = mock.clock(on, { now: 0 })
  const w = { status: [] as (string | undefined)[], during: [] as (string | undefined)[], clock }
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', async () => {
    await clock.sleep(3_000)
    w.during.push(w.status.at(-1))
    return { result: {}, text: 'ok' }
  })
  return w
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

describe('focus-hud in a session', () => {
  test('keeps one line of goal, target, running call and wait', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.prompt.submit({ text: 'ログインのバグを直して\n詳細は issue #12', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(w.status.at(-1)).toBe('🎯 ログインのバグを直して · ⏳ 応答生成中 (0s)')

    const call = $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    await w.clock.advance(3_000)
    await call
    expect(w.during[0]).toBe('🎯 ログインのバグを直して · 📄 pnpm test · ⚙ Bash pnpm test · ⏳ Bash の終了待ち (2s)')
    expect(w.status.at(-1)).toBe('🎯 ログインのバグを直して · 📄 pnpm test · ⏳ 応答生成中 (3s)')

    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(w.status.at(-1)).toBe('🎯 ログインのバグを直して · 📄 pnpm test · ⏳ あなたの入力待ち')

    const detail = (await $.command.run({ command: 'focus', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text
    expect(detail).toContain('目的: ログインのバグを直して')
    expect(detail).toContain('待ち: あなたの入力待ち')
  })
})

test('a path ending a long run of slashes is read in linear time', () => {
  for (const input of [{ file_path: `${'/'.repeat(32_000)}x` }, { command: `${'/'.repeat(32_000)}x` }]) {
    const started = performance.now()
    expect(targetOf(input.command === undefined ? 'Read' : 'Bash', input)).toBe('x')
    expect(performance.now() - started).toBeLessThan(50)
  }
  expect(targetOf('Read', { file_path: '/repo/src/' })).toBe('src/')
})
