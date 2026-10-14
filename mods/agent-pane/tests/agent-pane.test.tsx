import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'エージェント',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

const SURFACES = ['terminal', 'desktop'] as const

function completed(prompt: string) {
  return {
    status: 'completed',
    agentId: 'a-sync',
    agentType: 'Explore',
    content: [{ type: 'text', text: 'done' }],
    totalToolUseCount: 1,
    totalDurationMs: 2000,
    totalTokens: 10,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    prompt,
  } as const
}

function launched(agentId: string, description: string) {
  return { status: 'async_launched', agentId, description, prompt: 'p', outputFile: '/tmp/out' } as const
}

// What the engine answers beneath the plugin: the status line and the agent roster.
function beneath(on: On, agents: AgentInfo[]) {
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: agents }))
  return statuses
}

async function paneTexts($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ plugin: 'agent-pane', surface, component: 'Pane', requestId: 'agent-pane', props: PANE_PROPS })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  await ui.unmount()
  return texts
}

test('a foreground agent shows running in the status line, then finished with its duration', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const statuses = beneath(on, [])
  on('tool.call', { tool: 'Agent' }, async () => {
    await clock.advance(3_000)
    return { result: completed('look around') }
  })

  await $.tool.call({ tool: 'Agent', description: 'look around', prompt: 'p', subagent_type: 'Explore' })

  expect(statuses).toEqual(['agents: 1 running', undefined])
  for (const surface of SURFACES) {
    const texts = await paneTexts($, surface)
    const row = texts.find(text => text.includes('look around'))
    expect(row).toContain('✓')
    expect(row).toContain('Explore')
    expect(row).toContain('3秒')
  }
})

test('a refused call is drawn as failed, typed general-purpose', async ($, on) => {
  mock.clock(on)
  beneath(on, [])
  on('tool.call', { tool: 'Agent' }, () => ({ deny: 'no' }))

  await $.tool.call({ tool: 'Agent', description: 'refused', prompt: 'p' })

  for (const surface of SURFACES) {
    const row = (await paneTexts($, surface)).find(text => text.includes('refused'))
    expect(row).toContain('✗')
    expect(row).toContain('general-purpose')
  }
})

test('a background agent keeps running, its time ticking, until the roster says it ended', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const agents: AgentInfo[] = [{ id: 'a-bg', description: 'background', type: 'fork', status: 'running' } as AgentInfo]
  const statuses = beneath(on, agents)
  on('tool.call', { tool: 'Agent' }, () => ({ result: launched('a-bg', 'background') }))

  await $.tool.call({ tool: 'Agent', description: 'background', prompt: 'p', subagent_type: 'fork' })
  expect(statuses.at(-1)).toBe('agents: 1 running')

  await clock.advance(5_000)
  for (const surface of SURFACES) {
    const texts = await paneTexts($, surface)
    expect(texts.some(text => text.includes('実行中 (1)'))).toBe(true)
    expect(texts.find(text => text.includes('background'))).toContain('5秒')
  }

  agents[0] = { id: 'a-bg', description: 'background', type: 'fork', status: 'completed' } as AgentInfo
  await clock.advance(1_000)
  expect(statuses.at(-1)).toBeUndefined()
  for (const surface of SURFACES) {
    const row = (await paneTexts($, surface)).find(text => text.includes('background'))
    expect(row).toContain('✓')
    expect(row).toContain('6秒')
  }

  // The timer stopped with nothing running: no more status writes.
  const count = statuses.length
  await clock.advance(10_000)
  expect(statuses.length).toBe(count)
})

test('running agents are listed before finished ones', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  beneath(on, [])
  on('tool.call', { tool: 'Agent' }, async ($, e) => {
    if (e.description === 'live work') return { result: launched('a-live', 'live work') }
    if (e.description === 'broken plan') {
      await clock.advance(65_000)
      return { deny: 'no' }
    }
    return { result: completed('old search') }
  })

  await $.tool.call({ tool: 'Agent', description: 'old search', prompt: 'p', subagent_type: 'Explore' })
  await $.tool.call({ tool: 'Agent', description: 'broken plan', prompt: 'p', subagent_type: 'Plan' })
  await $.tool.call({ tool: 'Agent', description: 'live work', prompt: 'p', subagent_type: 'fork' })

  for (const surface of SURFACES) {
    const texts = await paneTexts($, surface)
    const at = (needle: string) => texts.findIndex(text => text.includes(needle))
    expect(at('実行中 (1)')).toBe(0)
    expect(at('live work')).toBeLessThan(at('完了 (2)'))
    expect(at('完了 (2)')).toBeLessThan(at('broken plan'))
    expect(texts[at('broken plan')]).toContain('1分5秒')
    expect(at('broken plan')).toBeLessThan(at('old search'))
  }
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
} as const

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

test('a teammate or a remote launch is drawn as launched and untracked, never as completed', async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, [])
  on('tool.call', { tool: 'Agent' }, ($, e) =>
    e.description === 'scout'
      ? { result: { status: 'teammate_spawned', agentId: 't-1', name: 'scout', model: 'opus' } as never }
      : { result: { status: 'remote_launched', taskId: 'r-1', sessionUrl: 'https://x', description: 'cloud', prompt: 'p' } as never },
  )

  await $.tool.call({ tool: 'Agent', description: 'scout', prompt: 'p', name: 'scout' } as never)
  await $.tool.call({ tool: 'Agent', description: 'cloud', prompt: 'p' })

  for (const surface of SURFACES) {
    const texts = await paneTexts($, surface)
    for (const name of ['scout', 'cloud']) {
      const row = texts.find(text => text.includes(name)) ?? ''
      expect(row).toContain('↗')
      expect(row).toContain('起動済み（追跡外）')
      expect(row).not.toContain('✓')
    }
  }
})

test('a background run the roster drops is ended as unknown after three ticks, and the timer stops', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const statuses = beneath(on, [])
  on('tool.call', { tool: 'Agent' }, () => ({ result: launched('a-gone', 'vanished') }))

  await $.tool.call({ tool: 'Agent', description: 'vanished', prompt: 'p', subagent_type: 'fork' })
  await clock.advance(2_000)
  expect(statuses.at(-1)).toBe('agents: 1 running')

  await clock.advance(1_000)
  expect(statuses.at(-1)).toBeUndefined()
  for (const surface of SURFACES) {
    const row = (await paneTexts($, surface)).find(text => text.includes('vanished')) ?? ''
    expect(row).toContain('?')
    expect(row).toContain('結果不明')
  }

  const count = statuses.length
  await clock.advance(10_000)
  expect(statuses.length).toBe(count)
})

test('session.start ends a foreground run whose waiting call a reload lost', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const statuses = beneath(on, [])
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', { tool: 'Agent' }, () => new Promise<never>(() => {}))

  $.tool.call({ tool: 'Agent', description: 'orphan', prompt: 'p', subagent_type: 'Explore' }).catch(() => {})
  await clock.advance(0)
  expect(statuses.at(-1)).toBe('agents: 1 running')

  await $.session.start(START)
  expect(statuses.at(-1)).toBeUndefined()
  const row = (await paneTexts($, 'terminal')).find(text => text.includes('orphan')) ?? ''
  expect(row).toContain('結果不明')
})

test('the pane opens unasked once, and only from a fullscreen terminal', async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, [])
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('tool.call', { tool: 'Agent' }, () => ({ result: completed('x') }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // A desktop surface that docks panes says nothing about the terminal.
  const desk = await $.ui.mount({ plugin: 'agent-pane', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS, viewport: { columns: 200, rows: 50, isFullscreen: true } })
  await desk.unmount()
  await $.tool.call({ tool: 'Agent', description: 'one', prompt: 'p' })
  expect(opened).toEqual([])

  const term = await $.ui.mount({ plugin: 'agent-pane', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS, viewport: { columns: 200, rows: 50, isFullscreen: true } })
  await term.unmount()
  await $.tool.call({ tool: 'Agent', description: 'two', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', description: 'three', prompt: 'p' })
  expect(opened).toEqual(['agent-pane'])
})

test('the pane says when nothing ran yet', async $ => {
  for (const surface of SURFACES) {
    expect((await paneTexts($, surface)).some(text => text.includes('まだエージェントは起動していません'))).toBe(true)
  }
})
