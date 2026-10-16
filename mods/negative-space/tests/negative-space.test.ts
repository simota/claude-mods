import type { On, RenderElement } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { boundsOf, candidatesOf, enclosingName, namesOn, requestOf, testsFor, triggersOf, withTest } from '../hooks/space'

const kinds = (path: string, before: string, after: string) => triggersOf(path, before, after, 1).map(one => one.kind)

describe('space', () => {
  test('finds authorization, validation and error handling in the lines an edit added to source', () => {
    expect(kinds('src/api.ts', 'return doc', "if (!user.isAdmin) throw new Forbidden('no')\nreturn doc")).toEqual(['auth', 'error'])
    expect(kinds('src/form.ts', '', 'const Name = z.string().min(1).max(40)')).toEqual(['validation'])
    expect(kinds('app/views.py', 'x = 1', 'x = 1\ntry:\n    save()\nexcept IOError:\n    log()')).toEqual(['error'])
    expect(kinds('src/api.ts', '', "// check permission later\nimport { authorize } from './auth'")).toEqual([])
    expect(kinds('src/api.test.ts', '', 'expect(res.status).toBe(403)')).toEqual([])
    expect(kinds('README.md', '', 'requires permission')).toEqual([])
  })

  test('reads the bounds a line compares against, leaving HTTP statuses out', () => {
    expect(boundsOf('if (name.length > 40 || age < 0) return res.status(400)')).toEqual([40, 0])
    expect(boundsOf('z.string().min(1).max(255)')).toEqual([1, 255])
    expect(boundsOf('maxLength: 20')).toEqual([20])
  })

  test('matches tests to a source file by its stem', () => {
    const tests = { 'tests/api.test.ts': 'A', 'tests/form.test.ts': 'B', 'tests/test_api.py': 'C' }
    expect(testsFor('src/api.ts', tests)).toBe('A\nC')
  })

  test('asks for a refusal test and each bound, until the tests of that file speak of them', () => {
    const found = triggersOf('src/form.ts', '', "if (title.length > 40) throw new ValidationError('long')", 1)
    const none = candidatesOf(found, {}, [])
    expect(none.map(one => one.ask)).toEqual(['不正・空・型違いの入力で拒否されるか', '境界値 39 / 40 / 41', '失敗（例外・タイムアウト・依存先エラー）時にどう振る舞うか'])

    const covered = candidatesOf(found, { 'src/form.test.ts': "it('rejects an invalid title', () => { expect(() => f('x'.repeat(41))).toThrow(); f('x'.repeat(40)) })" }, [])
    expect(covered).toEqual([])

    expect(candidatesOf(found, {}, none.map(one => one.key))).toEqual([])
  })

  test('knows the function a line sits in, and the names on it', () => {
    const file = ['export async function chargeCard(card) {', '  try {', '    await gateway.charge(card)', '  } catch (e) {', '    return retry(card)', '  }', '}'].join('\n')
    expect(enclosingName(file.split('\n'), 4)).toBe('chargeCard')
    expect(enclosingName(['const save = async (doc) => {', '  if (!doc.ownerId) throw x'], 1)).toBe('save')
    expect(namesOn("if (!user.isAdmin) return res.status(403)")).toEqual(['user', 'isAdmin'])
    expect(triggersOf('src/pay.ts', '', file, 1).find(t => t.kind === 'error')?.names).toContain('chargeCard')
  })

  test('a stray word in a test of the file does not cover a failure it never names', () => {
    const file = 'export async function chargeCard(card) {\n  try { await gateway.charge(card) } catch (e) { return retry(card) }\n}'
    const found = triggersOf('src/pay.ts', '', file, 1)
    expect(candidatesOf(found, { 'src/pay.test.ts': "it('lists items', () => { expect(res.error).toBeUndefined() })" }, []).map(one => one.kind)).toEqual(['error'])
    expect(candidatesOf(found, { 'src/pay.test.ts': "it('chargeCard retries when the gateway fails', () => {})" }, [])).toEqual([])
  })

  test('the tests seen in a long session are held to the latest 30, each to its last 200 KB', () => {
    let held: Record<string, string> = {}
    for (let i = 0; i < 45; i += 1) held = withTest(held, `/w/tests/t${i}.test.ts`, `it('t${i}', () => {})`)
    expect(Object.keys(held)).toHaveLength(30)
    expect(held['/w/tests/t44.test.ts']).toBeDefined()
    expect(held['/w/tests/t0.test.ts']).toBeUndefined()
    // Seen again, a file is the newest: it stays past the next ones.
    held = withTest(held, '/w/tests/t15.test.ts', 'again')
    for (let i = 45; i < 70; i += 1) held = withTest(held, `/w/tests/t${i}.test.ts`, 'x')
    expect(held['/w/tests/t15.test.ts']).toBe('again')
    expect(withTest({}, 'a.test.ts', 'y'.repeat(300_000))['a.test.ts']).toHaveLength(200_000)
  })

  test('words the request with the trigger line quoted', () => {
    const list = candidatesOf(triggersOf('src/api.ts', '', 'if (!can(user)) return res.status(403)', 1), {}, [])
    expect(requestOf(list)).toContain('src/api.ts: 認可 — 権限のない')
  })
})

type Seen = { fills: string[] }

function world(on: On): Seen {
  const seen: Seen = { fills: [] }
  mock.store(on, {})
  mock.clock(on, { now: 1_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('prompt.fill', ($, e) => {
    seen.fills.push(e.text)
    return { isFilled: true } as never
  })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine') as RenderElement
  })
  return seen
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const RUN = { command: 'negative-space', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const done = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

describe('negative-space in a session', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the ${surface} band offers the open candidates after the turn`, async ($, on) => {
      const seen = world(on)
      await $.session.start(START)
      await $.tool.call({ tool: 'Edit', file_path: '/w/src/api.ts', old_string: 'return doc', new_string: "if (!user.isAdmin) return res.status(403)\nreturn doc" })
      await $.tool.call({ tool: 'Write', file_path: '/w/src/api.test.ts', content: "it('reads a doc', () => { expect(get(1)).toEqual(doc) })" })

      const ui = await $.ui.mount({ plugin: 'negative-space', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /テスト不足候補/ })).toBeUndefined()
      await ui.unmount()

      await $.turn.complete(done)
      const band = await $.ui.mount({ plugin: 'negative-space', surface, ...BAND })
      expect(await band.find({ type: 'Text', text: /拒否\/境界のテスト不足候補 1件: 認可 \(api\.ts\)/ })).toBeDefined()
      await band.press({ key: 'ask' })
      expect(seen.fills[0]).toContain('/w/src/api.ts: 認可')
      await band.press({ key: 'dismiss' })
      expect(await band.find({ type: 'Text', text: /テスト不足候補/ })).toBeUndefined()
      await band.unmount()
    })
  }

  test('a test that tries the refusal closes the candidate', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Edit', file_path: '/w/src/api.ts', old_string: 'a', new_string: 'if (!user.isAdmin) return res.status(403)' })
    expect((await $.command.run(RUN)).text).toContain('候補 1件')
    await $.tool.call({ tool: 'Edit', file_path: '/w/tests/api.test.ts', old_string: 'x', new_string: "it('refuses a guest user with 403', () => {})" })
    expect((await $.command.run(RUN)).text).toContain('候補はありません')
  })
})
