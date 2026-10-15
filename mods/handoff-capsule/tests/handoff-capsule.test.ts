import type { On, RenderElement } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Capsule } from '../types'
import { capsuleOf, contextOf, emptyLog, withAnswer, withCommand, withFile, withPrompt, withTodos } from '../hooks/capsule'

describe('capsule', () => {
  test('keeps decisions and what is left from a reply, not code or quotes', () => {
    const answer = ['方針: キャッシュは Redis ではなくメモリ内 LRU を採用しました。', '```', 'TODO: not this', '```', '- #TODO(agent): 認可のテストを追加', '> 決定は引用', 'Tests pass.'].join('\n')
    const log = withAnswer(emptyLog(), answer)
    expect(log.decisions).toEqual(['方針: キャッシュは Redis ではなくメモリ内 LRU を採用しました。'])
    expect(log.open).toEqual(['#TODO(agent): 認可のテストを追加'])
  })

  test('keeps commands worth running again, the newest outcome of each', () => {
    let log = withCommand(emptyLog(), 'ls -la', true)
    log = withCommand(log, 'pnpm test', false)
    log = withCommand(log, 'git status', true)
    log = withCommand(log, 'pnpm test', true)
    expect(log.commands).toEqual([{ command: 'pnpm test', isOk: true }])
  })

  test('makes a capsule: first and latest request, open todos first, most edited files first', () => {
    let log = withPrompt(emptyLog(), 'ログインを直して')
    log = withPrompt(log, 'テストも足して')
    log = withPrompt(log, 'README も更新')
    log = withTodos(log, [
      { content: 'fix login', status: 'completed' },
      { content: 'add tests', status: 'in_progress' },
      { content: 'update README', status: 'pending' },
    ])
    log = withFile(withFile(withFile(log, '/w/src/a.ts'), '/w/src/b.ts'), '/w/src/b.ts')
    const c = capsuleOf(log, { id: 'x', at: 1, sessionId: 's', root: '/w', reason: 'end' })
    expect(c.goal).toEqual(['ログインを直して', 'README も更新'])
    expect(c.open).toEqual(['▶ add tests', 'update README'])
    expect(c.files).toEqual(['src/b.ts', 'src/a.ts'])
  })

  test('reads back only the chosen parts, as a record to check', () => {
    const c = capsuleOf(withCommand(withPrompt(emptyLog(), 'goal'), 'make test', false), { id: 'x', at: 1, sessionId: 's', root: '/w', reason: 'compact' })
    const text = contextOf(c, ['commands'])
    expect(text).toContain('## コマンド\n- ✗ make test')
    expect(text).not.toContain('## 目的')
    expect(text).toContain('照合してから')
  })
})

const ROOT = '/w'
const EARLIER: Capsule = {
  id: 's1:1',
  at: 1_000,
  sessionId: 's1',
  root: ROOT,
  branch: 'feat/login',
  reason: 'end',
  goal: ['ログインを直して'],
  decisions: ['JWT の有効期限は 15 分に決定'],
  open: ['認可のテストが未完了'],
  commands: [{ command: 'pnpm test', isOk: false }],
  files: ['src/auth.ts'],
}

type World = { contexts: (readonly string[] | undefined)[]; kept: Record<string, unknown>; race?: (mine: unknown) => unknown }

function world(on: On, sessionId: string, store: Record<string, unknown> = {}): World {
  const w: World = { contexts: [], kept: { ...store } }
  // A store in memory the test can read back.
  on('store.get', ($, e) => ({ value: w.kept[e.key] }) as never)
  on('store.set', ($, e) => {
    w.kept[e.key] = e.value
    // Another session, having read before this write, writes its own list over it once.
    const race = w.race
    if (race !== undefined) {
      w.race = undefined
      w.kept[e.key] = race(e.value)
    }
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete w.kept[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(w.kept) }))
  mock.clock(on, { now: 2 * 60 * 60 * 1000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    w.contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine') as RenderElement
  })
  return w
}

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

describe('handoff-capsule in a session', () => {
  test('keeps a capsule when the session ends', async ($, on) => {
    const w = world(on, 's1')
    await $.session.start(START)
    await $.prompt.submit({ text: 'ログインを直して', origin: { kind: 'composer' }, wait: false })
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/auth.ts`, old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    await $.tool.call({ tool: 'Bash', command: 'NPM_TOKEN=npm_abcdef123456 pnpm publish' })
    await $.turn.complete({ answer: 'JWT の有効期限は 15 分にしました。\n認可のテストはまだです。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: {} as never })

    const read = await $.command.run({ command: 'handoff', args: 'load', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(read.text).toContain('カプセルを用意しました')
    const kept = JSON.stringify(w.kept.capsules)
    expect(kept).toContain('NPM_TOKEN=*** pnpm publish')
    expect(kept).not.toContain('npm_abcdef123456')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the ${surface} band brings back the chosen parts beside the next prompt`, async ($, on) => {
      const w = world(on, 's2', { capsules: { [ROOT]: [EARLIER] } })
      await $.session.start(START)

      const ui = await $.ui.mount({ plugin: 'handoff-capsule', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /引き継ぎ（2時間前・終了時）/ })).toBeDefined()
      await ui.press({ key: 's-files' })
      await ui.press({ key: 's-goal' })
      await ui.press({ key: 'take' })
      expect(await ui.find({ type: 'Text', text: /引き継ぎ（/ })).toBeUndefined()
      await ui.unmount()

      await $.prompt.submit({ text: '続きを', origin: { kind: 'composer' }, wait: false })
      const carried = w.contexts[0]?.[0] ?? ''
      expect(carried).toContain('## 決定\n- JWT の有効期限は 15 分に決定')
      expect(carried).toContain('## コマンド\n- ✗ pnpm test')
      expect(carried).not.toContain('src/auth.ts')
      expect(carried).not.toContain('## 目的')

      await $.prompt.submit({ text: 'もう一つ', origin: { kind: 'composer' }, wait: false })
      expect(w.contexts[1]).toBeUndefined()
    })
  }

  test('a capsule overwritten by another session at the same moment is written again', async ($, on) => {
    const w = world(on, 's3')
    await $.session.start(START)
    await $.prompt.submit({ text: '検索を速くして', origin: { kind: 'composer' }, wait: false })
    w.race = () => ({ [ROOT]: [EARLIER] })
    await $.command.run({ command: 'handoff', args: 'save', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    const kept = (w.kept.capsules as Record<string, Capsule[]>)[ROOT] ?? []
    expect(kept.map(one => one.sessionId).sort()).toEqual(['s1', 's3'])
  })
})
