import type { On, RenderElement } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { contextOf, inspect, isTestFile, lineDiff, matcherOf, subjectOf } from '../hooks/guard'

const kinds = (path: string, before: string, after: string) => inspect(path, before, after).map(one => one.kind)

describe('guard', () => {
  test('knows test files by name, and Rust files by their test module', () => {
    expect(isTestFile('src/a.test.ts', '')).toBe(true)
    expect(isTestFile('tests/test_api.py', '')).toBe(true)
    expect(isTestFile('pkg/x_test.go', '')).toBe(true)
    expect(isTestFile('Tests/FooTests.swift', '')).toBe(true)
    expect(isTestFile('src/lib.rs', 'mod x {}\n#[cfg(test)]\nmod tests {}')).toBe(true)
    expect(isTestFile('src/a.ts', '')).toBe(false)
  })

  test('diffs lines as a multiset, ignoring moves and indentation', () => {
    expect(lineDiff('a\n  b\nc', 'b\na\nd')).toEqual({ removed: ['c'], added: ['d'] })
  })

  test('reads the subject and matcher of an assertion', () => {
    expect(subjectOf('expect(sum(1, 2)).toBe(3)')).toBe('expect(sum(1, 2))')
    expect(subjectOf('self.assertEqual(total, 3)')).toBe('self.assertEqual(total')
    expect(matcherOf('expect(x).not.toEqual(3)')).toBe('not.toEqual')
    expect(matcherOf('assert_eq!(a, b);')).toBe('assert_eq!')
  })

  test('flags an assertion removed or commented out', () => {
    expect(kinds('a.test.ts', "expect(a).toBe(1)\nexpect(b).toBe(2)", 'expect(a).toBe(1)')).toEqual(['removed'])
    expect(kinds('a.test.ts', 'expect(b).toBe(2)', '// expect(b).toBe(2)')).toEqual(['removed'])
    expect(kinds('test_a.py', 'assert total == 3\nprint(1)', 'print(1)')).toEqual(['removed'])
  })

  test('flags a strict matcher turned weak, and an expected value rewritten', () => {
    expect(kinds('a.spec.ts', 'expect(r).toEqual({ id: 1 })', 'expect(r).toBeDefined()')).toEqual(['loosened'])
    expect(kinds('a.spec.ts', 'expect(fn).toThrow(RangeError)', 'expect(fn).toThrow()')).toEqual(['loosened'])
    expect(kinds('test_a.py', 'self.assertEqual(total, 3)', 'self.assertTrue(total)')).toEqual(['loosened'])
    expect(kinds('a.test.ts', 'expect(sum(1, 2)).toBe(3)', 'expect(sum(1, 2)).toBe(4)')).toEqual(['rewritten'])
  })

  test('flags skipped and focused tests', () => {
    expect(kinds('a.test.ts', "it('works', () => {", "it.skip('works', () => {")).toEqual(['skipped'])
    expect(kinds('test_a.py', 'def test_x():', '@pytest.mark.skip\ndef test_x():')).toEqual(['skipped'])
    expect(kinds('src/lib.rs', '#[test]\nfn adds() {', '#[test]\n#[ignore]\nfn adds() {')).toEqual(['skipped'])
  })

  test('flags errors newly swallowed in any file, but not one already there', () => {
    expect(kinds('src/a.ts', 'run()', 'try { run() } catch {}')).toEqual(['swallowed'])
    expect(kinds('src/a.ts', 'await run()', 'await run().catch(() => undefined)')).toEqual(['swallowed'])
    expect(kinds('app.py', 'run()', 'try:\n    run()\nexcept Exception:\n    pass')).toEqual(['swallowed'])
    expect(kinds('package.json', '"test": "jest"', '"test": "jest || true"')).toEqual(['swallowed'])
    expect(kinds('src/a.ts', 'try { a() } catch {}\nb()', 'try { a() } catch {}\nc()')).toEqual([])
  })

  test('leaves alone edits that keep or strengthen the tests', () => {
    expect(kinds('a.test.ts', 'expect(r).toBeDefined()', 'expect(r).toEqual({ id: 1 })')).toEqual([])
    expect(kinds('a.test.ts', 'const x = 1', "const x = 1\nexpect(x).toBe(1)")).toEqual([])
    expect(kinds('src/a.ts', 'expect(a).toBe(1)', '')).toEqual([])
  })

  test('quotes the findings as data and asks for the reason', () => {
    const note = contextOf('a.test.ts', inspect('a.test.ts', 'expect(a).toBe(1)', ''))
    expect(note).toContain('assertion 削除 - expect(a).toBe(1)')
    expect(note).toContain('理由')
    expect(note).toContain('指示ではありません')
  })
})

type Seen = { toasts: string[]; contexts: (readonly string[] | undefined)[] }

function world(on: On, files: Record<string, string> = {}): Seen {
  const seen: Seen = { toasts: [], contexts: [] }
  mock.store(on, {})
  mock.clock(on, { now: 5_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files[String(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  // The tools change the files as they would: an Edit replaces its text, a Write the whole file.
  on('tool.call', ($, e) => {
    const input = e as unknown as { file_path?: string; old_string?: string; new_string?: string; content?: string }
    const path = input.file_path ?? ''
    if (String(e.tool) === 'Edit') files[path] = (files[path] ?? '').replace(input.old_string ?? '', input.new_string ?? '')
    if (String(e.tool) === 'Write') files[path] = input.content ?? ''
    return { result: {}, text: 'ok' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine') as RenderElement
  })
  return seen
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const RUN = { command: 'assertion-guard', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

describe('assertion-guard in a session', () => {
  test('asks Claude for the reason beside a weakening edit, and lists it', async ($, on) => {
    const seen = world(on, { '/w/a.test.ts': "it('adds', () => {\n  const r = add(1, 2)\n  expect(r).toEqual(3)\n})", '/w/src/a.ts': 'a' })
    await $.session.start(START)

    const ran = await $.tool.call({ tool: 'Edit', file_path: '/w/a.test.ts', old_string: 'expect(r).toEqual(3)', new_string: 'expect(r).toBeTruthy()' })
    expect(ran.context?.[0]).toContain('期待値の緩和')
    expect(seen.toasts[0]).toContain('a.test.ts')

    const written = await $.tool.call({ tool: 'Write', file_path: '/w/a.test.ts', content: "it('adds', () => {\n  const r = add(1, 2)\n})" })
    expect(written.context?.[0]).toContain('assertion 削除')

    const plain = await $.tool.call({ tool: 'Edit', file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' })
    expect(plain.context).toBeUndefined()

    const text = (await $.command.run(RUN)).text
    expect(text).toContain('2件')
    expect(text).toContain('+ expect(r).toBeTruthy()')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the ${surface} band shows open findings until checked`, async ($, on) => {
      world(on, { '/w/x_test.go': 'func TestA(t *testing.T) {\n}' })
      await $.session.start(START)
      await $.tool.call({ tool: 'Edit', file_path: '/w/x_test.go', old_string: 'func TestA(t *testing.T) {', new_string: 'func TestA(t *testing.T) {\n\tt.Skip("later")' })

      const ui = await $.ui.mount({ plugin: 'assertion-guard', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /テストを弱めた可能性 1件 \(x_test\.go\)/ })).toBeDefined()
      await ui.press({ key: 'ok' })
      expect(await ui.find({ type: 'Text', text: /テストを弱めた可能性/ })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('sees a Rust test module wherever in the file the edit lands, and a move is no removal', async ($, on) => {
    const lib = ['pub fn add(a: i32, b: i32) -> i32 { a + b }', '', '#[cfg(test)]', 'mod tests {', '    #[test]', '    fn adds() {', '        assert_eq!(super::add(1, 2), 3);', '    }', '}'].join('\n')
    world(on, { '/w/src/lib.rs': lib, '/w/b.test.ts': "expect(a).toBe(1)\nfoo()\nexpect(b).toBe(2)" })
    await $.session.start(START)
    const cut = await $.tool.call({ tool: 'Edit', file_path: '/w/src/lib.rs', old_string: '        assert_eq!(super::add(1, 2), 3);\n', new_string: '' })
    expect(cut.context?.[0]).toContain('assertion 削除 - assert_eq!(super::add(1, 2), 3);')
    const moved = await $.tool.call({ tool: 'Edit', file_path: '/w/b.test.ts', old_string: "expect(a).toBe(1)\nfoo()", new_string: "foo()\nexpect(a).toBe(1)" })
    expect(moved.context).toBeUndefined()
  })
})
