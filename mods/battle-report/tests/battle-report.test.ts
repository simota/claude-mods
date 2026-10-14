import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { bodyLines, editLines, fmt, isUserRejection, titleFor, titleOf } from '../hooks/report'

type Seen = { toasts: string[]; notes: { text: string; title?: string }[]; argv: string[][] }

// An Edit's result as Claude Code records it: one hunk replacing line x with y and z.
const EDIT_RESULT = {
  filePath: '/repo/a.ts',
  structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-x', '+y', '+z'] }],
}

// The world beneath the plugin: recorded toasts, notifications and processes.
function world(on: On): Seen {
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
    seen.argv.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Edit') return { result: EDIT_RESULT as never, text: 'ok' }
    if (e.tool === 'Bash' && e.command === 'false') return { isError: true, result: 'exit 1', text: 'exit 1' }
    if (e.tool === 'Bash' && e.command === 'rejected') {
      return { isError: true, result: undefined, text: "The user doesn't want to proceed with this tool use. The tool use was rejected." }
    }
    if (e.tool === 'Bash' && e.command === 'oauth') {
      return { isError: true, result: 'exit 1', text: 'OAuth callback: user denied access' }
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
}

const EDIT = ($: Engine) => $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y\nz' })
// A new file: no hunks in its result, so its two content lines are counted.
const WRITE = ($: Engine) => $.tool.call({ tool: 'Write', file_path: '/repo/new.txt', content: 'one\ntwo\n' })
const FAIL = ($: Engine) => $.tool.call({ tool: 'Bash', command: 'false' })

async function playTurn($: Engine, clock: { settle: () => Promise<void> }, turn: Turn = {}) {
  const { agentId, tools = [EDIT, WRITE, FAIL], reason = 'answer' } = turn
  await $.turn.start({ text: 'go', turnId: 'turn-1', agentId })
  for (const call of tools) await call($)
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

test("counts lines from an edit's own patch, or a new file's content", () => {
  expect(editLines('Edit', {}, EDIT_RESULT)).toEqual({ added: 2, deleted: 1 })
  // Overwriting a file: its patch is the count, not the content's length.
  const overwrite = { structuredPatch: [{ lines: ['-a', '-b', '+c'] }] }
  expect(editLines('Write', { content: 'c\n' }, overwrite)).toEqual({ added: 1, deleted: 2 })
  expect(editLines('Write', { content: 'one\ntwo\n' }, { type: 'create' })).toEqual({ added: 2, deleted: 0 })
  expect(editLines('Write', { content: '' }, {})).toEqual({ added: 0, deleted: 0 })
  expect(editLines('NotebookEdit', { new_source: 'x' }, {})).toEqual({ added: 0, deleted: 0 })
})

test("reads a rejection only from Claude Code's own wording, at the start of the result", () => {
  expect(isUserRejection("The user doesn't want to proceed with this tool use. The tool use was rejected.")).toBe(true)
  expect(isUserRejection("The user doesn't want to take this action right now. STOP what you are doing.")).toBe(true)
  expect(isUserRejection('Permission to use Bash with command rm -rf x has been denied.')).toBe(true)
  expect(isUserRejection('Permission to use Edit has been denied by your rule Edit(.env).')).toBe(true)
  expect(isUserRejection('Permission for this action has been denied.')).toBe(true)
  // Real failures that merely mention a denial stay errors.
  expect(isUserRejection('FAIL  src/auth.test.ts > token rejected by the user')).toBe(false)
  expect(isUserRejection('OAuth callback: user denied access')).toBe(false)
  expect(isUserRejection('Error: user rejected the transaction')).toBe(false)
  expect(isUserRejection('sudo: a password is required; user declined')).toBe(false)
  expect(isUserRejection("log: The user doesn't want to proceed with this tool use.")).toBe(false)
  expect(isUserRejection('exit 1')).toBe(false)
})

test('body lines show cache writes and the edit-tool line count', () => {
  const base = {
    inTokens: 1,
    outTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4000,
    edits: 1,
    errors: 0,
    lines: { added: 4, deleted: 1 },
  }
  expect(bodyLines(base)).toEqual(['🧠 out 2 · in 1 · cache r 3 / w 4.0k', '✏ 1 edits · +4 / -1 lines (Edit/Write)'])
  expect(titleOf({ ...base, failure: 'refusal' })).toBe('✗ TURN FAILED (refusal)')
})

test("counts this turn's lines from the edit calls, and runs no git or wc", async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock)

  // Edit +2 / -1, Write of a 2-line new file +2.
  expect(seen.notes).toEqual([
    {
      title: 'SESSION COMPLETE',
      text: '🧠 out 58.2k · in 1.2k · cache r 1.4M / w 32.0k\n✏ 2 edits · +4 / -1 lines (Edit/Write)\n⚠ 1 tool errors',
    },
  ])
  expect(seen.argv).toEqual([['afplay', '/System/Library/Sounds/Basso.aiff']])
})

test('changes made through Bash are not counted', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock, { tools: [($: Engine) => $.tool.call({ tool: 'Bash', command: "sed -i '' s/a/b/ a.ts" })] })

  expect(seen.notes[0]?.title).toBe('SESSION COMPLETE')
  expect(seen.notes[0]?.text).toContain('✏ 0 edits · +0 / -0 lines (Edit/Write)')
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

test("a real failure that mentions 'user denied' is still a tool error", async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, clock, { tools: [($: Engine) => $.tool.call({ tool: 'Bash', command: 'oauth' })] })

  expect(seen.notes[0]?.text).toContain('⚠ 1 tool errors')
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

test('keeps the turn counters, line counts included, in $.state where a reload leaves them', async ($, on) => {
  world(on)
  const written: unknown[] = []
  on('state.set', ($, e, next) => {
    if (e.plugin === 'battle-report' && e.key === 'turn') written.push(e.value)
    return next(e)
  })
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await EDIT($)
  await FAIL($)

  expect(written.at(-1)).toEqual({ turnId: 'turn-1', edits: 1, errors: 1, tools: 2, added: 2, deleted: 1 })
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
  expect(seen.argv).toEqual([])
})
