import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { GRUVBOX, ICONS, graphemesFallback, summarize } from '../hooks/summary'

const DECORATED = 'a plugin beneath decorated this row'

type RowProps = {
  tool: string
  input: unknown
  output?: unknown
  isRunning?: boolean
  isErrored?: boolean
  isInterrupted?: boolean
  id?: string
}

// Beneath the plugin stands the engine: its answer is the engine's own row.
function engineRow(on: On) {
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'engine', ref: 0 }))
}

// A plugin beneath (image-preview, say) that drew the row itself.
function decoratedRow(on: On) {
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{DECORATED}</Text>
  })
}

async function texts($: Engine, surface: 'terminal' | 'desktop', row: RowProps) {
  const id = row.id ?? 'toolu_1'
  const ui = await $.ui.mount({
    plugin: 'tool-row',
    surface,
    component: 'ToolUse',
    requestId: id,
    props: {
      tool_use_id: id,
      tool: row.tool,
      input: row.input,
      output: row.output,
      isRunning: row.isRunning ?? false,
      isErrored: row.isErrored ?? false,
      isInterrupted: row.isInterrupted ?? false,
    },
  })
  const found = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  await ui.unmount()
  return found
}

const EDIT_OUTPUT = {
  filePath: '/repo/src/app.ts',
  structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }],
}

describe('summarize', () => {
  test('Edit counts added and removed lines from the patch', () => {
    const summary = summarize({ tool: 'Edit', input: { file_path: '/repo/src/app.ts' }, output: EDIT_OUTPUT, isErrored: false })
    expect(summary?.icon).toBe(ICONS.edit)
    expect(summary?.label).toBe('/repo/src/app.ts')
    expect(summary?.stats.map(stat => stat.text)).toEqual(['+2', '−1'])
  })

  test('Edit falls back to the input strings without a patch', () => {
    const summary = summarize({ tool: 'Edit', input: { file_path: '/f', old_string: 'x', new_string: 'y\nz' }, output: {}, isErrored: false })
    expect(summary?.stats.map(stat => stat.text)).toEqual(['+2', '−1'])
  })

  test('Write of a new file counts its content lines', () => {
    const summary = summarize({ tool: 'Write', input: { file_path: '/n.md', content: 'a\nb\nc\n' }, output: { type: 'create', structuredPatch: [] }, isErrored: false })
    expect(summary?.stats.map(stat => stat.text)).toEqual(['+3'])
  })

  test('Read shows the line count', () => {
    const summary = summarize({ tool: 'Read', input: { file_path: '/r.ts' }, output: { type: 'text', file: { numLines: 42 } }, isErrored: false })
    expect(summary?.stats.map(stat => stat.text)).toEqual(['(42行)'])
  })

  test('Bash shows the first line and no duration, and turns red on error', () => {
    const ok = summarize({ tool: 'Bash', input: { command: 'bun test\necho done' }, output: { stdout: '' }, isErrored: false })
    expect(ok?.label).toBe('bun test …')
    expect(ok?.stats).toEqual([])
    expect(ok?.color).toBe(GRUVBOX.aqua)

    const failed = summarize({ tool: 'Bash', input: { command: 'false' }, output: 'Exit code 1', isErrored: true })
    expect(failed?.color).toBe(GRUVBOX.red)
    expect(failed?.stats.map(stat => stat.text)).toEqual(['· error'])
  })

  test('a long command is cut to 60 characters', () => {
    const summary = summarize({ tool: 'Bash', input: { command: 'x'.repeat(100) }, output: {}, isErrored: false })
    expect(summary?.label).toBe(`${'x'.repeat(59)}…`)
  })

  test('a long command of emoji is cut between code points, never inside a surrogate pair', () => {
    const summary = summarize({ tool: 'Bash', input: { command: `echo ${'😀'.repeat(70)}` }, output: {}, isErrored: false })
    // "echo " is 5 code points, so 54 emoji fill the 59 before the ellipsis.
    expect(summary?.label).toBe(`echo ${'😀'.repeat(54)}…`)
  })

  test('a ZWJ emoji or a flag counts as one character and is never cut inside', () => {
    // 👩‍💻 is three code points (woman, ZWJ, laptop) and 🇯🇵 two regional indicators: one character each.
    const coder = summarize({ tool: 'Bash', input: { command: `echo ${'👩‍💻'.repeat(70)}` }, output: {}, isErrored: false })
    expect(coder?.label).toBe(`echo ${'👩‍💻'.repeat(54)}…`)
    const flags = summarize({ tool: 'Bash', input: { command: `echo ${'🇯🇵'.repeat(70)}` }, output: {}, isErrored: false })
    expect(flags?.label).toBe(`echo ${'🇯🇵'.repeat(54)}…`)
  })

  test('without Intl.Segmenter the fallback keeps the same characters whole', () => {
    // e + U+0301 (combining acute), 1 + U+FE0F + U+20E3 (keycap), two flags in a row.
    expect(graphemesFallback('a👩‍💻🇯🇵🇺🇸1️⃣é')).toEqual(['a', '👩‍💻', '🇯🇵', '🇺🇸', '1️⃣', 'é'])
    expect(graphemesFallback('👍🏽!')).toEqual(['👍🏽', '!'])
  })

  test('Grep, Glob, Agent, WebFetch, WebSearch and MCP tools', () => {
    expect(summarize({ tool: 'Grep', input: { pattern: 'TODO' }, output: {}, isErrored: false })?.label).toBe('TODO')
    expect(summarize({ tool: 'Glob', input: { pattern: '**/*.ts' }, output: {}, isErrored: false })?.icon).toBe(ICONS.search)
    expect(summarize({ tool: 'Agent', input: { description: 'look around', subagent_type: 'Explore' }, output: {}, isErrored: false })?.label).toBe('Explore: look around')
    expect(summarize({ tool: 'Agent', input: { description: 'plain' }, output: {}, isErrored: false })?.label).toBe('general-purpose: plain')
    expect(summarize({ tool: 'WebFetch', input: { url: 'https://code.claude.com/docs/en/x.md' }, output: {}, isErrored: false })?.label).toBe('code.claude.com/docs/en/x.md')
    expect(summarize({ tool: 'WebSearch', input: { query: 'claude mods' }, output: {}, isErrored: false })?.label).toBe('claude mods')
    expect(summarize({ tool: 'mcp__claude_ai_Figma__get_screenshot', input: {}, output: {}, isErrored: false })?.label).toBe('claude_ai_Figma:get_screenshot')
  })

  test('an unknown tool, or one missing its key input, is left to the engine', () => {
    expect(summarize({ tool: 'TodoWrite', input: {}, output: {}, isErrored: false })).toBeUndefined()
    expect(summarize({ tool: 'Edit', input: {}, output: {}, isErrored: false })).toBeUndefined()
  })
})

test('the terminal draws a finished Edit as one compact line', async ($, on) => {
  engineRow(on)
  const found = await texts($, 'terminal', { tool: 'Edit', input: { file_path: '/repo/src/app.ts' }, output: EDIT_OUTPUT })
  expect(found).toEqual([ICONS.edit, '/repo/src/app.ts', '+2', '−1'])
})

test('a finished Bash call shows its command alone, no duration, even after the call ran through the plugin', async ($, on) => {
  // A clock that answers, so a plugin timing the call could: 1.5 s pass while the call runs.
  const clock = mock.clock(on, { now: 10_000 })
  engineRow(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.advance(1_500)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  // The call runs first, as in a session: a plugin that timed it would now draw "· 0.0s" beside it.
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_1', command: 'bun test', description: 'test' })
  const found = await texts($, 'terminal', { tool: 'Bash', input: { command: 'bun test' }, output: { stdout: 'ok' } })
  expect(found).toEqual([ICONS.bash, 'bun test'])
})

test('a row a plugin beneath decorated is left as it drew it', async ($, on) => {
  decoratedRow(on)
  const found = await texts($, 'terminal', { tool: 'Write', input: { file_path: '/out/cat.png', content: '' }, output: { type: 'create' } })
  expect(found).toEqual([DECORATED])
})

test('running, interrupted, unresolved and unknown calls keep the engine row', async ($, on) => {
  engineRow(on)
  const cases: RowProps[] = [
    { tool: 'Bash', input: { command: 'sleep 9' }, isRunning: true },
    { tool: 'Bash', input: { command: 'sleep 9' }, output: 'Interrupted', isInterrupted: true },
    { tool: 'Read', input: { file_path: '/r' } },
    { tool: 'TodoWrite', input: { todos: [] }, output: {} },
  ]
  for (const row of cases) {
    expect(await texts($, 'terminal', row)).toEqual([])
  }
})

test('every other surface keeps the engine row', async ($, on) => {
  engineRow(on)
  expect(await texts($, 'desktop', { tool: 'Edit', input: { file_path: '/repo/src/app.ts' }, output: EDIT_OUTPUT })).toEqual([])
})

test('compact off keeps the engine row on the terminal', { options: { compact: false } }, async ($, on) => {
  engineRow(on)
  expect(await texts($, 'terminal', { tool: 'Edit', input: { file_path: '/repo/src/app.ts' }, output: EDIT_OUTPUT })).toEqual([])
})

const RESULT_TEXT = 'the engine result block'

// The engine's result block beneath, as one Text.
function engineResult(on: On) {
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{RESULT_TEXT}</Text>
  })
}

async function result($: Engine, id: string, tool: string, isErrored = false) {
  const ui = await $.ui.mount({
    plugin: 'tool-row',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool, output: {}, isErrored },
  })
  const found = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  await ui.unmount()
  return found
}

test('the result under a compacted row is hidden, so the call is one line', async ($, on) => {
  engineRow(on)
  engineResult(on)
  await texts($, 'terminal', { id: 'toolu_e', tool: 'Edit', input: { file_path: '/repo/src/app.ts' }, output: EDIT_OUTPUT })
  expect(await result($, 'toolu_e', 'Edit')).toEqual([])
})

test('an errored result, and one under a row left as drawn, stay', async ($, on) => {
  engineRow(on)
  engineResult(on)
  await texts($, 'terminal', { id: 'toolu_b', tool: 'Bash', input: { command: 'false' }, output: 'exit 1', isErrored: true })
  expect(await result($, 'toolu_b', 'Bash', true)).toEqual([RESULT_TEXT])
  await texts($, 'terminal', { id: 'toolu_t', tool: 'TodoWrite', input: { todos: [] }, output: {} })
  expect(await result($, 'toolu_t', 'TodoWrite')).toEqual([RESULT_TEXT])
  expect(await result($, 'toolu_never_drawn', 'Read')).toEqual([RESULT_TEXT])
})

test('compact off keeps the result', { options: { compact: false } }, async ($, on) => {
  engineRow(on)
  engineResult(on)
  await texts($, 'terminal', { id: 'toolu_e', tool: 'Edit', input: { file_path: '/repo/src/app.ts' }, output: EDIT_OUTPUT })
  expect(await result($, 'toolu_e', 'Edit')).toEqual([RESULT_TEXT])
})

test('a one-line command of megabytes is cut without reading it all, on every draw', () => {
  const command = `python3 -c '${'x = 1; '.repeat(150_000)}'`
  summarize({ tool: 'Bash', input: { command }, output: {}, isErrored: false })
  const started = performance.now()
  const summary = summarize({ tool: 'Bash', input: { command }, output: {}, isErrored: false })
  expect(performance.now() - started).toBeLessThan(20)
  expect(summary?.label).toBe(`${command.slice(0, 59)}…`)
  // Still cut between whole characters.
  expect(summarize({ tool: 'Bash', input: { command: '👩‍💻'.repeat(100_000) }, output: {}, isErrored: false })?.label).toBe(`${'👩‍💻'.repeat(59)}…`)
})
