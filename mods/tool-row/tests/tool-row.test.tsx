import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { GRUVBOX, ICONS, summarize } from '../hooks/summary'

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

test('a finished Bash call shows its command alone, no duration', async ($, on) => {
  engineRow(on)
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
