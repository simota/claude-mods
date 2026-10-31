import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { addVerdicts, auditStep, guardRules, isReverted, marksOf, mutedOf, recallStep, revertedRules, thresholdOf, withoutRules } from '../hooks/verdicts'

type Detectors = {
  isFlagged?: boolean
  guard?: { id: string; at: number; path: string; findings: { kind: string; path: string; before?: string; after?: string }[]; isReviewed: boolean }[]
  latest?: { status: string; turnId?: string }
  violations?: { rule: string; quote: string; why: string }[]
  pending?: Record<string, { key: string; failed: string; calls: number }>
  book?: { key: string; fix?: { command: string; isSandboxOff: boolean; repo: string; at: number } }[]
}

type Bottom = { isError: boolean; files: Record<string, string> }

// The world beneath the plugin: the detectors' state as `d` holds it now, files the tools change, and a clock.
function world(on: On, d: Detectors, store: Record<string, unknown> = {}): Bottom {
  const bottom: Bottom = { isError: false, files: {} }
  mock.store(on, store)
  mock.clock(on, { now: 1_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const detectors = (): Record<string, unknown> => ({
    'done-gate.isFlagged': d.isFlagged,
    'assertion-guard.entries': d.guard,
    'self-audit.latest': d.latest,
    'self-audit.violations': d.violations,
    'zukan.pending': d.pending,
    'zukan.entries': d.book,
  })
  on('state.get', ($, e, next) => {
    const name = `${e.plugin}.${e.key}`
    const now = detectors()
    return name in now ? ({ value: { value: now[name], version: 1 } } as never) : next(e)
  })
  on('fs.read', ($, e) => {
    const text = bottom.files[String(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('tool.call', ($, e) => {
    const input = e as unknown as { file_path?: string; old_string?: string; new_string?: string }
    if (String(e.tool) === 'Edit' && input.file_path !== undefined) {
      bottom.files[input.file_path] = (bottom.files[input.file_path] ?? '').replace(input.old_string ?? '', input.new_string ?? '')
    }
    return { result: 'ok', text: 'ok', ...(bottom.isError ? { isError: true as const } : {}) }
  })
  return bottom
}

const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as const
const ON = { options: { enabled: true, minN: 2, threshold: 0.5 } }

let turnNo = 0
const startTurn = ($: Engine) => $.turn.start({ text: 'go', turnId: `t${++turnNo}` })
const endTurn = ($: Engine) => $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: `t${turnNo}`, reason: 'answer' })
const type = ($: Engine, text = 'next') => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const report = async ($: Engine) =>
  (await $.command.run({ command: 'hit-rate', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text

const R1 = { rule: 'R1', quote: 'All done.', why: 'claims done without a check' }

describe('verdicts', () => {
  test('self-audit: a rule gone on the next audited reply held, one flagged again did not', () => {
    const first = auditStep(null, { status: 'audited', turnId: 'a' }, [R1, { rule: 'R3', quote: 'q', why: 'w' }])
    expect(first.verdicts).toEqual([])
    expect(auditStep(first.audit, { status: 'skipped', turnId: 'b', reason: 'short' }, []).verdicts).toEqual([])
    const next = auditStep(first.audit, { status: 'audited', turnId: 'b' }, [R1])
    expect(next.verdicts.map(v => `${v.rule}:${v.verdict}`)).toEqual(['self-audit:R1:fp', 'self-audit:R3:tp'])
  })

  test('zukan: the recalled fix reused is tp, another command fp, aged out unknown', () => {
    const fix = { command: 'git push -u origin HEAD', isSandboxOff: false, repo: 'r', at: 10 }
    const opened = recallStep({}, { git: { key: 'k', failed: 'git push', calls: 0 } }, [{ key: 'k', fix } as never], 100)
    expect(opened.recalls.git?.suggested).toBe('git push -u origin HEAD')

    const same = recallStep(opened.recalls, {}, [{ key: 'k', fix: { ...fix, at: 120 } } as never], 130)
    expect(same.verdicts.map(v => v.verdict)).toEqual(['tp'])
    const other = recallStep(opened.recalls, {}, [{ key: 'k', fix: { ...fix, command: 'git push --force', at: 120 } } as never], 130)
    expect(other.verdicts.map(v => v.verdict)).toEqual(['fp'])
    const aged = recallStep(opened.recalls, {}, [{ key: 'k', fix } as never], 130)
    expect(aged.verdicts.map(v => v.verdict)).toEqual(['unknown'])

    expect(recallStep({}, { git: { key: 'k', failed: 'git push', calls: 0 } }, [{ key: 'k' } as never], 100).recalls).toEqual({})
  })

  test('zukan: the same error failing again from another command keeps the recall waiting', () => {
    const fix = { command: 'git push -u origin HEAD', isSandboxOff: false, repo: 'r', at: 10 }
    const opened = recallStep({}, { git: { key: 'k', failed: 'git push', calls: 0 } }, [{ key: 'k', fix } as never], 100)
    const retried = recallStep(opened.recalls, { git: { key: 'k', failed: 'git push origin main', calls: 0 } }, [{ key: 'k', fix } as never], 110)
    expect(retried.verdicts).toEqual([])
    expect(retried.recalls).toEqual(opened.recalls)
    // Another error of the same program is another episode: the first ends undecided.
    const other = recallStep(opened.recalls, { git: { key: 'k2', failed: 'git push', calls: 0 } }, [{ key: 'k', fix } as never], 110)
    expect(other.verdicts.map(v => v.verdict)).toEqual(['unknown'])
  })

  test('assertion-guard: a revert is the old line back and the new one gone, counted against duplicates', () => {
    const findings = [{ kind: 'loosened' as const, path: 'a.test.ts', before: '  expect(x).toBe(1)', after: '  expect(x).toBeTruthy()' }]
    const weakened = 'expect(x).toBe(1)\nexpect(x).toBeTruthy()\n'
    const marks = marksOf(findings, weakened)
    expect(isReverted(marks, weakened)).toBe(false)
    expect(isReverted(marks, 'expect(x).toBe(1)\nexpect(x).toBe(1)\n')).toBe(true)
    // The new line deleted without the old one back is no revert.
    expect(isReverted(marks, 'expect(x).toBe(1)\n')).toBe(false)
  })

  test('assertion-guard: thousands of findings in a long file are counted in linear time', () => {
    // Read before every Bash and Edit call and every prompt, and after every Bash call while open.
    const findings = Array.from({ length: 4000 }, (_, n) => ({ kind: 'removed' as const, path: 'a.test.ts', before: `expect(a${n}).toBe(${n})` }))
    const text = Array.from({ length: 4000 }, (_, n) => `  other(${n})`).join('\n')
    let started = performance.now()
    const marks = marksOf(findings, text)
    expect(performance.now() - started).toBeLessThan(100)
    const one = { path: 'a.test.ts', rules: guardRules(findings), marks }
    started = performance.now()
    expect(revertedRules(one, text)).toEqual([])
    expect(isReverted(marks, text)).toBe(false)
    expect(performance.now() - started).toBeLessThan(100)
    expect(revertedRules(one, `${text}\n  expect(a7).toBe(7)`)).toEqual(['assertion-guard:removed'])
  })

  test('assertion-guard: one verdict per kind per edit, and the kinds left keep their lines', () => {
    const loosened = (v: string) => ({ kind: 'loosened' as const, path: 'a.test.ts', before: `expect(${v}).toBe(1)`, after: `expect(${v}).toBeTruthy()` })
    const swallowed = { kind: 'swallowed' as const, path: 'a.test.ts', after: 'catch {}' }
    const blank = { kind: 'removed' as const, path: 'a.test.ts' }
    const findings = [loosened('x'), loosened('y'), swallowed, blank]
    const weakened = 'expect(x).toBeTruthy()\nexpect(y).toBeTruthy()\ncatch {}\n'
    const one = { path: 'a.test.ts', rules: guardRules(findings), marks: marksOf(findings, weakened) }
    const undone = 'expect(x).toBe(1)\nexpect(y).toBeTruthy()\ncatch {}\n'
    expect(revertedRules(one, undone)).toEqual(['assertion-guard:loosened'])
    const left = withoutRules(one, ['assertion-guard:loosened'])
    expect(left?.rules).toEqual(['assertion-guard:swallowed', 'assertion-guard:removed'])
    expect(left?.marks.map(m => m.rule)).toEqual(['assertion-guard:swallowed', 'assertion-guard:removed'])
    // A finding with no line to look for is never undone.
    expect(revertedRules(left!, '')).toEqual(['assertion-guard:swallowed'])
    expect(withoutRules(left!, ['assertion-guard:swallowed', 'assertion-guard:removed'])).toBeNull()
  })

  test('threshold: 0 to 1 is used, unset or cleared is the default quietly, anything else is named', () => {
    expect(thresholdOf(0)).toEqual({ value: 0 })
    expect(thresholdOf(1)).toEqual({ value: 1 })
    expect(thresholdOf(undefined)).toEqual({ value: 0.5 })
    expect(thresholdOf(null)).toEqual({ value: 0.5 })
    expect(thresholdOf('')).toEqual({ value: 0.5 })
    expect(thresholdOf(50)).toEqual({ value: 0.5, ignored: '50' })
    expect(thresholdOf(Number.NaN)).toEqual({ value: 0.5, ignored: 'NaN' })
  })

  test('a rule is muted only with enough verdicts and a precision below the threshold', () => {
    const table = addVerdicts({}, [
      { rule: 'a', verdict: 'fp' },
      { rule: 'a', verdict: 'fp' },
      { rule: 'a', verdict: 'tp' },
      { rule: 'b', verdict: 'fp' },
      { rule: 'c', verdict: 'unknown' },
      { rule: 'c', verdict: 'unknown' },
      { rule: 'c', verdict: 'unknown' },
    ])
    expect(mutedOf(table, 3, 0.5)).toEqual(['a'])
    expect(mutedOf(table, 1, 0.5)).toEqual(['a', 'b'])
  })
})

describe('hit-rate', () => {
  test('off by default: nothing is scored', async ($, on) => {
    const d: Detectors = { isFlagged: true }
    world(on, d)
    await $.session.start(START)
    await type($)
    await bash($, 'bun test')
    expect(await report($)).toContain('まだ判定はありません')
  })

  test('done-gate: the first check after the flag decides it, once per episode', ON, async ($, on) => {
    const d: Detectors = { isFlagged: true }
    const bottom = world(on, d)
    await $.session.start(START)
    await type($)

    bottom.isError = true
    await bash($, 'bun test')
    // A second failing check while the flag still stands is not a second verdict.
    await bash($, 'bun test')
    bottom.isError = false
    await bash($, 'bun test')
    d.isFlagged = false
    await bash($, 'ls')
    expect(await report($)).toContain('done-gate:unverified  TP 1 / FP 0 / unknown 0')

    d.isFlagged = true
    await type($)
    await bash($, 'bun test')
    expect(await report($)).toContain('done-gate:unverified  TP 1 / FP 1 / unknown 0')

    // Taken down with 閉じる, no check seen.
    await type($)
    d.isFlagged = false
    await type($)
    d.isFlagged = true
    await type($)
    d.isFlagged = false
    await type($)
    expect(await report($)).toContain('unknown 1')
  })

  test('done-gate: skipped or negated checks do not turn an unverified finding into a false positive', ON, async ($, on) => {
    const d: Detectors = { isFlagged: true }
    const bottom = world(on, d)
    await $.session.start(START)
    await type($)
    for (const command of ['true || bun test', '! bun test', '(bun test && echo done) | cat', '/usr/bin/env --help bun test']) {
      await bash($, command)
      expect(await report($), command).toContain('まだ判定はありません')
    }
    bottom.isError = true
    await bash($, 'bun test')
    expect(await report($)).toContain('done-gate:unverified  TP 1 / FP 0 / unknown 0')
  })

  test('assertion-guard: a reverted weakening is tp, one reviewed and left standing a turn is fp', ON, async ($, on) => {
    const d: Detectors = {}
    const bottom = world(on, d)
    bottom.files['/p/a.test.ts'] = 'expect(x).toBeTruthy()\n'
    bottom.files['/p/b.test.ts'] = 'expect(y).toBeTruthy()\n'
    const loosened = (path: string, v: string) => ({ kind: 'loosened', path, before: `expect(${v}).toBe(1)`, after: `expect(${v}).toBeTruthy()` })
    d.guard = [
      { id: 'g1', at: 1, path: '/p/a.test.ts', findings: [loosened('/p/a.test.ts', 'x')], isReviewed: false },
      { id: 'g2', at: 1, path: '/p/b.test.ts', findings: [loosened('/p/b.test.ts', 'y')], isReviewed: false },
    ]
    await $.session.start(START)
    await type($)

    await startTurn($)
    await $.tool.call({ tool: 'Edit', file_path: '/p/a.test.ts', old_string: 'toBeTruthy()', new_string: 'toBe(1)' })
    await endTurn($)
    expect(await report($)).toContain('assertion-guard:loosened  TP 1 / FP 0')

    d.guard = d.guard.map(one => ({ ...one, isReviewed: true }))
    await type($)
    await startTurn($)
    await endTurn($)
    expect(await report($)).toContain('assertion-guard:loosened  TP 1 / FP 1')
  })

  test('an edit that weakened two ways: undoing one kind scores that kind only', ON, async ($, on) => {
    const d: Detectors = {}
    const bottom = world(on, d)
    bottom.files['/p/a.test.ts'] = 'expect(x).toBeTruthy()\ntry { run() } catch {}\n'
    d.guard = [
      {
        id: 'g1',
        at: 1,
        path: '/p/a.test.ts',
        findings: [
          { kind: 'loosened', path: '/p/a.test.ts', before: 'expect(x).toBe(1)', after: 'expect(x).toBeTruthy()' },
          { kind: 'swallowed', path: '/p/a.test.ts', after: 'try { run() } catch {}' },
        ],
        isReviewed: false,
      },
    ]
    await $.session.start(START)
    await type($)

    await startTurn($)
    await $.tool.call({ tool: 'Edit', file_path: '/p/a.test.ts', old_string: 'toBeTruthy()', new_string: 'toBe(1)' })
    await endTurn($)
    let text = await report($)
    expect(text).toContain('assertion-guard:loosened  TP 1 / FP 0')
    expect(text).not.toContain('assertion-guard:swallowed')

    // The swallowed error still stands after the person checked it: that kind alone is fp.
    d.guard = d.guard.map(one => ({ ...one, isReviewed: true }))
    await type($)
    await startTurn($)
    await endTurn($)
    text = await report($)
    expect(text).toContain('assertion-guard:loosened  TP 1 / FP 0')
    expect(text).toContain('assertion-guard:swallowed  TP 0 / FP 1')
  })

  test('a threshold outside 0 to 1 is not used: a rule always right is never muted', { options: { enabled: true, minN: 2, threshold: 50 } }, async ($, on) => {
    world(on, { isFlagged: true }, { table: { 'done-gate:unverified': { tp: 5, fp: 0, unknown: 0 } } })
    await $.session.start(START)
    const text = await report($)
    expect(text).not.toContain('🔇')
    expect(text).toContain('threshold 50')
  })

  test('a weakening undone through Bash (git restore) is tp, not fp after review', ON, async ($, on) => {
    const d: Detectors = {}
    const bottom = world(on, d)
    bottom.files['/p/a.test.ts'] = 'expect(x).toBeTruthy()\n'
    d.guard = [
      {
        id: 'g1',
        at: 1,
        path: '/p/a.test.ts',
        findings: [{ kind: 'loosened', path: '/p/a.test.ts', before: 'expect(x).toBe(1)', after: 'expect(x).toBeTruthy()' }],
        isReviewed: true,
      },
    ]
    await $.session.start(START)
    await type($)
    await startTurn($)
    bottom.files['/p/a.test.ts'] = 'expect(x).toBe(1)\n'
    await bash($, 'git restore /p/a.test.ts')
    await endTurn($)
    await startTurn($)
    await endTurn($)
    expect(await report($)).toContain('assertion-guard:loosened  TP 1 / FP 0')
  })

  test('calls issued together settle one change once', ON, async ($, on) => {
    const d: Detectors = { isFlagged: true, latest: { status: 'audited', turnId: 'a' }, violations: [R1] }
    world(on, d)
    await $.session.start(START)
    await type($)
    d.latest = { status: 'audited', turnId: 'b' }
    d.violations = []
    await Promise.all([bash($, 'bun test'), bash($, 'bun run typecheck')])
    const text = await report($)
    expect(text).toContain('self-audit:R1  TP 1 / FP 0 / unknown 0')
    expect(text).toContain('done-gate:unverified  TP 0 / FP 1 / unknown 0')
  })

  test('self-audit and the session end: what nothing decided is unknown', ON, async ($, on) => {
    const d: Detectors = { latest: { status: 'audited', turnId: 'a' }, violations: [R1] }
    world(on, d)
    await $.session.start(START)
    await type($)
    d.latest = { status: 'audited', turnId: 'b' }
    d.violations = []
    await type($)
    expect(await report($)).toContain('self-audit:R1  TP 1 / FP 0 / unknown 0')

    d.latest = { status: 'audited', turnId: 'c' }
    d.violations = [R1]
    await type($)
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
    expect(await report($)).toContain('self-audit:R1  TP 1 / FP 0 / unknown 1')
  })

  test('mutes a rule found mostly wrong, counting on the stored total', ON, async ($, on) => {
    const d: Detectors = { isFlagged: true }
    world(on, d, { table: { 'done-gate:unverified': { tp: 0, fp: 1, unknown: 4 } } })
    await $.session.start(START)
    expect(await report($)).not.toContain('🔇')
    await type($)
    await bash($, 'cargo test')
    expect(await report($)).toContain('done-gate:unverified  TP 0 / FP 2 / unknown 4  precision 0%  n=2  🔇 loopback 停止中')
  })
})
