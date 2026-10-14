import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { bodyLines, fmt, parseShortstat, titleFor } from '../hooks/report'

type Seen = { toasts: string[]; notes: { text: string; title?: string }[]; argv: string[][] }

const SHORTSTAT = ' 3 files changed, 180 insertions(+), 40 deletions(-)\n'

// The world beneath the plugin: a repo at /repo, recorded toasts, notifications and processes.
function world(on: On, { isRepo = true } = {}): Seen {
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
    const isGit = e.argv[0] === 'git'
    const exitCode = isGit && !isRepo ? 128 : 0
    const stdout = isGit && isRepo ? SHORTSTAT : ''
    return {
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('tool.call', ($, e) =>
    e.tool === 'Bash' && e.command === 'false'
      ? { isError: true, result: 'exit 1', text: 'exit 1' }
      : { result: {} as never, text: 'ok' },
  )
  return seen
}

const USAGE = {
  input_tokens: 1200,
  output_tokens: 58_200,
  cache_read_input_tokens: 1_400_000,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
}

async function playTurn($: Engine, { agentId }: { agentId?: string } = {}) {
  await $.turn.start({ text: 'go', turnId: 'turn-1', agentId })
  // A plugin's $.tool.call cannot name a loop, so these always count as the main loop's.
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/b.ts', content: 'z' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
    turnId: 'turn-1',
    agentId,
    usage: USAGE,
  })
}

test('formats numbers and titles as stop.sh did', () => {
  expect(fmt(950)).toBe('950')
  expect(fmt(58_200)).toBe('58.2k')
  expect(fmt(1_400_000)).toBe('1.4M')
  expect(titleFor(49)).toBe('SESSION COMPLETE')
  expect(titleFor(50)).toBe('◆ GOOD SESSION ◆')
  expect(titleFor(200)).toBe('★ EPIC SESSION ★')
  expect(titleFor(500)).toBe('⚔ LEGENDARY SESSION ⚔')
  expect(parseShortstat(SHORTSTAT)).toEqual({ added: 180, deleted: 40 })
  expect(parseShortstat(' 1 file changed, 2 deletions(-)')).toEqual({ added: 0, deleted: 2 })
  expect(bodyLines({ inTokens: 1, outTokens: 2, cacheTokens: 3, edits: 0, errors: 0, linesAdded: 0, linesDeleted: 0 })).toHaveLength(2)
})

test('reports a main-loop turn with toast, notification and the error sound', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($)
  await clock.settle()

  expect(seen.notes).toEqual([
    {
      title: '★ EPIC SESSION ★',
      text: '🧠 out 58.2k · in 1.2k · cache 1.4M\n✏ 2 edits · +180 / -40 lines\n⚠ 1 tool errors',
    },
  ])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('★ EPIC SESSION ★')
  expect(seen.argv).toContainEqual(['git', 'diff', '--shortstat', 'HEAD'])
  expect(seen.argv).toContainEqual(['afplay', '/System/Library/Sounds/Basso.aiff'])
})

test('reports 0 / 0 lines outside a git repository', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { isRepo: false })
  await playTurn($)
  await clock.settle()

  expect(seen.notes[0]?.title).toBe('SESSION COMPLETE')
  expect(seen.notes[0]?.text).toContain('+0 / -0 lines')
})

test('stays quiet when a subagent turn completes',async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($, { agentId: 'agent-1' })
  await clock.settle()

  expect(seen.toasts).toEqual([])
  expect(seen.notes).toEqual([])
  expect(seen.argv).toEqual([])
})

test('honours sound and notify being off', { options: { sound: false, notify: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await playTurn($)
  await clock.settle()

  expect(seen.toasts).toHaveLength(1)
  expect(seen.notes).toEqual([])
  expect(seen.argv.some(argv => argv[0] === 'afplay')).toBe(false)
})
