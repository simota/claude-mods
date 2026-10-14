import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { bodyLines, fmt, isUserRejection, parseNumstat, parseWc, titleFor, titleOf, turnDelta } from '../hooks/report'

type Seen = { toasts: string[]; notes: { text: string; title?: string }[]; argv: string[][] }

// What git answers: a mutable tree, so a test changes it between the turn's start and end.
type Tree = { numstat: string; others: string; wc: string }

type WorldOptions = { isRepo?: boolean; gitThrows?: boolean; tree?: Tree }

const CLEAN: Tree = { numstat: '', others: '', wc: '' }

// The world beneath the plugin: a repo at /repo, recorded toasts, notifications and processes.
function world(on: On, { isRepo = true, gitThrows = false, tree = { ...CLEAN } }: WorldOptions = {}): Seen {
  const seen: Seen = { toasts: [], notes: [], argv: [] }
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.notify', ($, e) => {
    seen.notes.push({ text: e.text, title: e.title })
    return { value: { isSent: true, channel: 'ghostty' } }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    seen.argv.push(argv)
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv[0] === 'git') {
      if (gitThrows) throw new Error('git: timed out')
      if (!isRepo) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
      if (argv.includes('--show-toplevel')) return ok('/repo\n')
      if (argv.includes('--verify')) return ok('abc123\n')
      if (argv.includes('--numstat')) return ok(tree.numstat)
      if (argv.includes('ls-files')) return ok(tree.others)
    }
    if (argv[0] === 'wc') return ok(tree.wc)
    return ok('')
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' && e.command === 'false') return { isError: true, result: 'exit 1', text: 'exit 1' }
    if (e.tool === 'Bash' && e.command === 'rejected') {
      return { isError: true, result: undefined, text: "The user doesn't want to proceed with this tool use." }
    }
    return { result: {} as never, text: 'ok' }
  })
  return seen
}

const USAGE = {
  input_tokens: 1200,
  output_tokens: 58_200,
  cache_read_input_tokens: 1_400_000,
  cache_creation_input_tokens: 32_000,
  model: 'claude-opus-5-5',
}

type Turn = {
  agentId?: string
  tools?: (($: Engine) => Promise<unknown>)[]
  reason?: 'answer' | 'error' | 'refusal'
  between?: () => void
}

const EDIT = ($: Engine) => $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })
const WRITE = ($: Engine) => $.tool.call({ tool: 'Write', file_path: '/repo/new.txt', content: 'z' })
const FAIL = ($: Engine) => $.tool.call({ tool: 'Bash', command: 'false' })

async function playTurn($: Engine, clock: { settle: () => Promise<void> }, turn: Turn = {}) {
  const { agentId, tools = [EDIT, WRITE, FAIL], reason = 'answer', between } = turn
  await $.turn.start({ text: 'go', turnId: 'turn-1', agentId })
  await clock.settle() // the starting snapshot
  for (const call of tools) await call($)
  between?.()
  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason,
    turnId: 'turn-1',
    agentId,
    usage: USAGE,
  } as never)
  await clock.settle()
}

test('formats numbers and titles as stop.sh did', () => {
  expect(fmt(950)).toBe('950')
  expect(fmt(58_200)).toBe('58.2k')
  expect(fmt(1_400_000)).toBe('1.4M')
  expect(titleFor(49)).toBe('SESSION COMPLETE')
  expect(titleFor(50)).toBe('◆ GOOD SESSION ◆')
  expect(titleFor(200)).toBe('★ EPIC SESSION ★')
  expect(titleFor(500)).toBe('⚔ LEGENDARY SESSION ⚔')
})

test('reads numstat -z and wc -l, and takes a turn as the difference of two snapshots', () => {
  // A binary file reads -\t-; a path may hold spaces.
  expect(parseNumstat('3\t1\tsrc/a b.ts\0-\t-\timg.png\0')).toEqual({
    'src/a b.ts': { added: 3, deleted: 1 },
    'img.png': { added: 0, deleted: 0 },
  })
  expect(parseWc('      10 new.txt\n       2 other file.md\n      12 total\n', ['new.txt', 'other file.md'])).toEqual({
    'new.txt': { added: 10, deleted: 0 },
    'other file.md': { added: 2, deleted: 0 },
  })
  // a.ts had 600 uncommitted lines before the turn and gained 5 and lost 2 in it; b.ts lost 3 of its earlier additions.
  const before = { 'a.ts': { added: 600, deleted: 0 }, 'b.ts': { added: 10, deleted: 0 } }
  const after = { 'a.ts': { added: 605, deleted: 2 }, 'b.ts': { added: 7, deleted: 0 }, 'new.txt': { added: 10, deleted: 0 } }
  expect(turnDelta(before, after)).toEqual({ added: 15, deleted: 5 })
  expect(turnDelta(before, before)).toEqual({ added: 0, deleted: 0 })
})

test('body lines show cache writes, and no line count when git could not tell', () => {
  const base = { inTokens: 1, outTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4000, edits: 1, errors: 0 }
  expect(bodyLines(base)).toEqual(['🧠 out 2 · in 1 · cache r 3 / w 4.0k', '✏ 1 edits'])
  expect(bodyLines({ ...base, lines: { added: 4, deleted: 1 } })[1]).toBe('✏ 1 edits · +4 / -1 lines')
  expect(titleOf({ ...base, failure: 'refusal' })).toBe('✗ TURN FAILED (refusal)')
  expect(isUserRejection("The user doesn't want to proceed with this tool use.")).toBe(true)
  expect(isUserRejection('exit 1')).toBe(false)
})

test("counts this turn's lines only, not changes left uncommitted before it", async ($, on) => {
  const clock = mock.clock(on)
  const tree: Tree = { numstat: '600\t0\ta.ts\0', others: '', wc: '' }
  const seen = world(on, { tree })
  await playTurn($, clock, {
    between: () => {
      tree.numstat = '605\t2\ta.ts\0'
      tree.others = 'new.txt\0'
      tree.wc = '      10 new.txt\n'
    },
  })

  expect(seen.notes).toEqual([
    {
      title: 'SESSION COMPLETE',
      text: '🧠 out 58.2k · in 1.2k · cache r 1.4M / w 32.0k\n✏ 2 edits · +15 / -2 lines\n⚠ 1 tool errors',
    },
  ])
  expect(seen.argv).toContainEqual(['afplay', '/System/Library/Sounds/Basso.aiff'])
})

test('a turn that edits nothing over 600 uncommitted lines reports +0 / -0', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { tree: { numstat: '600\t0\ta.ts\0', others: '', wc: '' } })
  await playTurn($, clock, { tools: [($: Engine) => $.tool.call({ tool: 'Bash', command: 'ls' })] })

  expect(seen.notes[0]?.title).toBe('SESSION COMPLETE')
  expect(seen.notes[0]?.text).toContain('✏ 0 edits · +0 / -0 lines')
})

test('runs git with fsmonitor and hooks off, and diffs against the turn-start HEAD', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock)

  const diffs = seen.argv.filter(argv => argv.includes('--numstat'))
  expect(diffs).toHaveLength(2)
  for (const argv of diffs) {
    expect(argv.slice(0, 5)).toEqual(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'])
    expect(argv).toContain('--no-ext-diff')
    expect(argv).toContain('abc123')
  }
})

test('outside a git repository the report goes out without a line count', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { isRepo: false })
  await playTurn($, clock)

  expect(seen.notes[0]?.title).toBe('SESSION COMPLETE')
  expect(seen.notes[0]?.text).toContain('✏ 2 edits\n')
  expect(seen.notes[0]?.text).not.toContain('lines')
})

test('a git failure does not suppress the report', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { gitThrows: true })
  await playTurn($, clock)

  expect(seen.toasts).toHaveLength(1)
  expect(seen.notes[0]?.text).toContain('✏ 2 edits')
})

test('a turn ended by an API error is reported failed with the error sound', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock, { tools: [], reason: 'error' })

  expect(seen.notes[0]?.title).toBe('✗ TURN FAILED (error)')
  expect(seen.argv).toContainEqual(['afplay', '/System/Library/Sounds/Basso.aiff'])
})

test('a call the person rejected is not a tool error', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock, { tools: [($: Engine) => $.tool.call({ tool: 'Bash', command: 'rejected' })] })

  expect(seen.notes[0]?.text).not.toContain('tool errors')
  expect(seen.argv).toContainEqual(['afplay', '/System/Library/Sounds/Glass.aiff'])
})

test('a turn that called no tool stays quiet by default', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock, { tools: [] })

  expect(seen.toasts).toEqual([])
  expect(seen.notes).toEqual([])
})

test('quietTurns off reports a turn with no tool call', { options: { quietTurns: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock, { tools: [] })

  expect(seen.toasts).toHaveLength(1)
})

test('keeps the turn counters in $.state, where a reload leaves them', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  const written: unknown[] = []
  on('state.set', ($, e, next) => {
    if (e.plugin === 'battle-report' && e.key === 'turn') written.push(e.value)
    return next(e)
  })
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await clock.settle()
  await EDIT($)
  await FAIL($)

  expect(written.at(-1)).toEqual({ turnId: 'turn-1', edits: 1, errors: 1, tools: 2 })
})

test('stays quiet when a subagent turn completes', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock, { agentId: 'agent-1' })

  expect(seen.toasts).toEqual([])
  expect(seen.notes).toEqual([])
  expect(seen.argv).toEqual([])
})

test('honours sound and notify being off', { options: { sound: false, notify: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock)

  expect(seen.toasts).toHaveLength(1)
  expect(seen.notes).toEqual([])
  expect(seen.argv.some(argv => argv[0] === 'afplay')).toBe(false)
})
