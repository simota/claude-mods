import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { check, cssTokens, jsonTokens, parseColor, parseLength, parseProbe, probeScript, resolveTokens } from '../hooks/lens'

const CSS = `:root {
  --color-primary: #3b82f6;
  --color-text: var(--gray-900);
  --gray-900: rgb(17, 24, 39);
  --space-2: 0.5rem; --space-4: 1rem;
  --font-sans: "Inter", system-ui, sans-serif;
}`

const TOKENS = resolveTokens([...cssTokens(CSS, 'a.css'), ...jsonTokens({ radius: { md: { $value: '6px' } } }, 't.json')])

describe('lens', () => {
  test('parses colours and lengths in their CSS spellings', () => {
    expect(parseColor('#3b82f6')).toEqual([59, 130, 246, 1])
    expect(parseColor('rgb(59 130 246 / 50%)')).toEqual([59, 130, 246, 0.5])
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual([255, 0, 0, 1])
    expect(parseLength('1.5rem')).toBe(24)
    expect(parseLength('0')).toBe(0)
    expect(parseLength('auto')).toBeUndefined()
  })

  test('reads tokens from CSS and JSON, references resolved', () => {
    expect(TOKENS.find(t => t.name === '--color-text')).toMatchObject({ value: 'rgb(17, 24, 39)', kind: 'color' })
    expect(TOKENS.find(t => t.name === '--space-4')).toMatchObject({ kind: 'length' })
    expect(TOKENS.find(t => t.name === 'radius.md')).toMatchObject({ value: '6px', kind: 'length', source: 't.json' })
    expect(TOKENS.find(t => t.name === '--font-sans')?.kind).toBe('font')
  })

  test('checks a computed value: a token, an off-token value with the nearest, or nothing to check', () => {
    expect(check('color', 'rgb(17, 24, 39)', TOKENS)).toMatchObject({ status: 'token', tokens: ['--color-text', '--gray-900'] })
    expect(check('background-color', 'rgb(58, 123, 213)', TOKENS)).toMatchObject({ status: 'off', nearest: { name: '--color-primary' } })
    expect(check('background-color', 'rgba(0, 0, 0, 0)', TOKENS).status).toBe('skip')
    expect(check('padding-top', '16px', TOKENS)).toMatchObject({ status: 'token', tokens: ['--space-4'] })
    expect(check('margin-left', '13px', TOKENS)).toMatchObject({ status: 'off', nearest: { name: '--space-4', distance: 3 } })
    expect(check('margin-top', '0px', TOKENS).status).toBe('skip')
    expect(check('font-family', 'Inter, system-ui, sans-serif', TOKENS).status).toBe('token')
    expect(check('font-family', 'Arial', TOKENS).status).toBe('off')
  })

  test('reads the probe answer, quoted or not', () => {
    const body = '{"url":"http://x","elements":[{"label":"button","style":{"color":"red"}}]}'
    expect(parseProbe(body)?.elements).toHaveLength(1)
    expect(parseProbe(JSON.stringify(body))?.url).toBe('http://x')
    const quotedFont = JSON.stringify({ url: 'http://x', elements: [{ label: 'p', style: { 'font-family': '"Helvetica Neue", Arial' } }] })
    expect(parseProbe(quotedFont)?.elements[0]?.style['font-family']).toBe('"Helvetica Neue", Arial')
    expect(parseProbe(`Result: ${JSON.stringify(quotedFont)}`)?.elements[0]?.style['font-family']).toBe('"Helvetica Neue", Arial')
    expect(parseProbe(`Result:\n${quotedFont}\n`)?.url).toBe('http://x')
    expect(probeScript('.btn')).toContain('".btn"')
  })
})

const PROBE = JSON.stringify({
  url: 'http://localhost:5173/',
  elements: [{ label: 'button.btn', text: 'Save', style: { color: 'rgb(17, 24, 39)', 'background-color': 'rgb(58, 123, 213)', 'padding-top': '16px', 'margin-top': '0px', 'font-family': 'Inter' } }],
})

function world(on: On) {
  const w = { scripts: [] as string[] }
  mock.store(on, {})
  mock.clock(on, { now: 1_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/w', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'src/tokens.css\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: CSS }) as never)
  on('tool.call', ($, e) => {
    const input = e as unknown as { text?: string }
    if (String(e.tool).endsWith('__javascript_tool')) {
      w.scripts.push(input.text ?? '')
      return { result: {}, text: PROBE }
    }
    return { result: {}, text: 'ok' }
  })
  return w
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const run = (args: string) => ({ command: 'token-lens', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

describe('token-lens in a session', () => {
  test('probes the tab Claude drives and lists off-token values', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect((await $.command.run(run('.btn'))).text).toContain('タブがありません')

    await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'http://localhost:5173/', tabId: 7 } as never)
    const text = (await $.command.run(run('.btn'))).text
    expect(w.scripts[0]).toContain('".btn"')
    expect(text).toContain('1要素 · 独自値 1件')
    expect(text).toContain('✗ background-color: rgb(58, 123, 213)（最寄り --color-primary = #3b82f6')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'token-lens',
        surface,
        component: 'Pane',
        requestId: 'token-lens',
        props: { title: 'トークン照合', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /✓ padding-top: 16px = --space-4/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /✓ font-family: Inter = --font-sans/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
