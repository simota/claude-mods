import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { GRUVBOX, ICONS, formatDuration, summarize } from '../hooks/summary'

const ENGINE_ROW = 'engine row'

type RowProps = {
  tool: string
  input: unknown
  output?: unknown
  isRunning?: boolean
  isErrored?: boolean
  isInterrupted?: boolean
  id?: string
}

// The engine's own row: one Text, drawn when the plugin passes.
function engineRow(on: On) {
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{ENGINE_ROW}</Text>
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

  test('Bash shows the first line, the duration, and turns red on error', () => {
    const ok = summarize({ tool: 'Bash', input: { command: 'bun test\necho done' }, output: { stdout: '' }, isErrored: false, durationMs: 1_234 })
    expect(ok?.label).toBe('bun test …')
    expect(ok?.stats.map(stat => stat.text)).toEqual(['· 1.2s'])
    expect(ok?.color).toBe(GRUVBOX.aqua)

    const failed = summarize({ tool: 'Bash', input: { command: 'false' }, output: 'Exit code 1', isErrored: true, durationMs: 80 })
    expect(failed?.color).toBe(GRUVBOX.red)
    expect(failed?.stats.map(stat => stat.text)).toEqual(['· error', '· 80ms'])
  })

  test('a long command is cut', () => {
    const summary = summarize({ tool: 'Bash', input: { command: 'x'.repeat(100) }, output: {}, isErrored: false })
    expect(summary?.label.length).toBe(60)
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

  test('durations read as ms, seconds and minutes', () => {
    expect(formatDuration(450)).toBe('450ms')
    expect(formatDuration(12_340)).toBe('12.3s')
    expect(formatDuration(125_000)).toBe('2m5s')
  })
})

test('the terminal draws a finished Edit as one compact line', async ($, on) => {
  engineRow(on)
  const found = await texts($, 'terminal', { tool: 'Edit', input: { file_path: '/repo/src/app.ts' }, output: EDIT_OUTPUT })
  expect(found).toEqual([ICONS.edit, '/repo/src/app.ts', '+2', '−1'])
})

test('the terminal shows a Bash call with the time tool.call measured', async ($, on) => {
  engineRow(on)
  const clock = mock.clock(on, { now: 0 })
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.advance(2_500)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })

  await $.tool.call({ tool: 'Bash', command: 'bun test', tool_use_id: 'toolu_bash' })

  const found = await texts($, 'terminal', { tool: 'Bash', input: { command: 'bun test' }, output: { stdout: 'ok' }, id: 'toolu_bash' })
  expect(found).toEqual([ICONS.bash, 'bun test', '· 2.5s'])
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
    expect(await texts($, 'terminal', row)).toEqual([ENGINE_ROW])
  }
})

test('every other surface keeps the engine row', async ($, on) => {
  engineRow(on)
  expect(await texts($, 'desktop', { tool: 'Edit', input: { file_path: '/repo/src/app.ts' }, output: EDIT_OUTPUT })).toEqual([ENGINE_ROW])
})

test('compact off keeps the engine row on the terminal', { options: { compact: false } }, async ($, on) => {
  engineRow(on)
  expect(await texts($, 'terminal', { tool: 'Edit', input: { file_path: '/repo/src/app.ts' }, output: EDIT_OUTPUT })).toEqual([ENGINE_ROW])
})
