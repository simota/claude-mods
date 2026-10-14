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
  const agents: AgentInfo[] = []
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

  agents.push({ id: 'a-bg', description: 'background', type: 'fork', status: 'completed' } as AgentInfo)
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

test('the pane says when nothing ran yet', async $ => {
  for (const surface of SURFACES) {
    expect((await paneTexts($, surface)).some(text => text.includes('まだエージェントは起動していません'))).toBe(true)
  }
})
