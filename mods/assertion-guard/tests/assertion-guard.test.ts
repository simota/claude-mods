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
  })

  test('prose that quotes a swallow is no swallow: a report or a README swallows nothing', () => {
    for (const path of ['build-report.md', 'docs/guide.MDX', 'NOTES.txt', 'README.rst', 'a.adoc']) {
      expect(kinds(path, '', 'cargo with `|| true`, go with `; echo`')).toEqual([])
      expect(kinds(path, '', '```ts\ntry { run() } catch {}\n```')).toEqual([])
    }
    // A test file in prose clothes is still read for weakened assertions.
    expect(kinds('src/a.md.ts', 'run()', 'try { run() } catch {}')).toEqual(['swallowed'])
    expect(kinds('src/a.ts', 'try { a() } catch {}\nb()', 'try { a() } catch {}\nc()')).toEqual([])
  })

  test('a formatting-only change to an assertion is no rewrite', () => {
    // Quotes, a closing semicolon or comma, and spaces around punctuation, as a formatter changes them.
    expect(kinds('a.test.ts', "expect(x).toBe('a')\nexpect(y).toEqual([1, 2])", 'expect(x).toBe("a");\nexpect(y).toEqual([1,2]);')).toEqual([])
    expect(kinds('test_a.py', "self.assertEqual(f( 1 ), 'x')", 'self.assertEqual(f(1), "x"),')).toEqual([])
    // A value that changed is still one.
    expect(kinds('a.test.ts', "expect(x).toBe('a b')", "expect(x).toBe('ab')")).toEqual(['rewritten'])
    expect(kinds('a.test.ts', 'expect(x).toBe(1)', 'expect(x).toBe(2);')).toEqual(['rewritten'])
  })

  test('every pattern stays fast on a whole file, also on lines built to make it backtrack', () => {
    // Exponential before: a catch block opening on a 40-slash divider took seconds per edit.
    const hostile = [
      `try { f() } catch (e) {\n  ${'/'.repeat(400)}\n  log(e)\n}`,
      `except${' a'.repeat(20_000)}`,
      `${'except a b c '.repeat(20_000)}`,
      `rescue${' '.repeat(20_000)}`,
      `catch (${'('.repeat(20_000)}`,
    ]
    for (const text of hostile) {
      const started = performance.now()
      inspect('a.test.py', '', text)
      expect(performance.now() - started).toBeLessThan(500)
    }
    // Still caught: a comment-only catch block, on its own lines or after the brace.
    expect(kinds('a.ts', '', 'try { f() } catch (e) {\n  // ignore\n  // really\n}')).toEqual(['swallowed'])
    expect(kinds('a.ts', '', 'try { f() } catch {}')).toEqual(['swallowed'])
    expect(kinds('a.py', '', 'try:\n  f()\nexcept (ValueError, KeyError) as e:\n  pass')).toEqual(['swallowed'])
  })

  test('long or odd edits are read in time: rewritten subjects, # runs after except, commented catch lines', () => {
    const time = (run: () => unknown) => {
      const started = performance.now()
      run()
      return performance.now() - started
    }
    // Every assertion given a new subject: each removed line is paired once, not searched for.
    const before = Array.from({ length: 4000 }, (_, n) => `expect(a${n}).toBe(${n})`).join('\n')
    const after = Array.from({ length: 4000 }, (_, n) => `expect(b${n}).toBe(${n})`).join('\n')
    expect(time(() => inspect('a.test.ts', before, after))).toBeLessThan(300)
    // A run of # after `except:` is one comment, not exponentially many ways to split one.
    expect(time(() => inspect('a.py', '', `except Exception:  ${'#'.repeat(40)}\n`))).toBeLessThan(50)
    // Lines of `// catch {` do not each read every comment line after them.
    expect(time(() => inspect('a.ts', '', '// catch {\n'.repeat(20_000)))).toBeLessThan(300)
    // `pass` inside a comment on the except line is prose, not the clause's body.
    expect(kinds('app.py', 'run()', 'try:\n    run()\nexcept Exception:  # we pass on this\n    log()')).toEqual([])
  })

  test('a comment on its own line before pass is still a swallow; prose starting with except is not', () => {
    expect(kinds('app.py', 'run()', 'try:\n    run()\nexcept Exception:\n    # best effort\n    pass')).toEqual(['swallowed'])
    expect(kinds('app.py', 'run()', 'try:\n    run()\nexcept Exception:  # noqa\n    # a\n    # b\n    ...')).toEqual(['swallowed'])
    expect(kinds('README.md', 'x', 'x\nexcept in rare cases: ...see below')).toEqual([])
    expect(kinds('app.py', 'run()', 'try:\n    run()\nexcept E: ...  # todo')).toEqual(['swallowed'])
  })

  test('a change inside a string, to its kind of quotes where that matters, or to the opposite matcher is still a rewrite', () => {
    expect(kinds('a.test.ts', "expect(x).toBe('a, b')", "expect(x).toBe('a,b')")).toEqual(['rewritten'])
    expect(kinds('a.test.ts', "expect(x).toBe('x: 1')", "expect(x).toBe('x:1');")).toEqual(['rewritten'])
    expect(kinds('a.test.ts', 'expect(x).toBe(`${y}`)', "expect(x).toBe('${y}')")).toEqual(['rewritten'])
    expect(kinds('pkg/x_test.go', "assert.Equal(t, 'a', s)", 'assert.Equal(t, "a", s)')).toEqual(['rewritten'])
    expect(kinds('a.test.ts', 'expect(t).toBe(10)', 'expect(t).not.toBe(10)')).toEqual(['rewritten'])
  })

  test('an assertion replaced by one about a literal is loosened', () => {
    expect(kinds('a.test.ts', 'expect(total).toBe(10)', 'expect(true).toBe(true)')).toEqual(['loosened'])
    expect(kinds('test_a.py', 'self.assertEqual(total, 3)', 'self.assertTrue(True)')).toEqual(['loosened'])
    expect(kinds('a.test.ts', 'expect(total).toBe(10)', 'expect(sum).toBe(10)')).toEqual([])
    expect(kinds('x_test.go', 'assert.Equal(t, total, 10)', 'assert.Equal(t, true, true)')).toEqual(['loosened'])
    expect(kinds('test_a.py', 'assert total == 10', 'assert 1 == 1')).toEqual(['loosened'])
    expect(kinds('a.test.ts', 'expect(total).toBe(10)', 'expect  (true).toBe(true)')).toEqual(['loosened'])
  })

  test('a literal elsewhere on the line, or an expected value written first, is no loosening', () => {
    // The subject is the assertion's own argument, not the first parenthesis on the line.
    expect(kinds('a.test.ts', 'expect(add(1, 2)).toBe(3)', "it('adds', () => expect(add(1, 2)).toBe(3))")).toEqual([])
    expect(kinds('test_a.py', 'assert fn(x) == y', "assert fn('a') == 'b'")).toEqual([])
    // Arguments in the other order: one of them is still not a literal.
    expect(kinds('src/lib.rs', '#[cfg(test)]\nassert_eq!(total, 10);', '#[cfg(test)]\nassert_eq!(10, total);')).toEqual([])
    expect(kinds('test_a.py', 'self.assertEqual(total, 10)', 'self.assertEqual(10, total)')).toEqual([])
  })

  test('no pattern is quadratic on long runs either', () => {
    const hostile: [string, string][] = [
      ['a.py', `except:${' '.repeat(80_000)}`],
      ['a.ts', `catch${' '.repeat(80_000)}`],
      ['a.ts', 'catch('.repeat(15_000)],
      ['a.ts', `.catch((${' '.repeat(80_000)}`],
      ['a.test.ts', `expect(x)${' '.repeat(80_000)}y`],
      ['a.test.ts', `${';'.repeat(80_000)}x`],
      ['a.test.ts', `assert ${'a'.repeat(80_000)}`],
      ['test_a.py', 'assert a '.repeat(10_000)],
      ['a.test.ts', `"${'\\"'.repeat(30_000)}`],
    ]
    for (const [path, text] of hostile) {
      const started = performance.now()
      inspect(path, 'x', text)
      inspect(path, text, 'x')
      expect(performance.now() - started).toBeLessThan(500)
    }
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
