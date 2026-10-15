import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { LanternServer } from '../types'
import { commandPorts, isServerCommand, judge, outputPathOf, outputPorts, parseLsof, statusOf, tailOf, urlsOf } from '../hooks/lantern'

const OUT = '/tmp/tasks/b1.output'
const BG = `Command running in background with ID: b1. Output is being written to: ${OUT}. You will be notified when it completes.`

describe('lantern', () => {
  test('knows commands that start servers', () => {
    expect(isServerCommand('pnpm dev')).toBe(true)
    expect(isServerCommand('npm run dev -- --host')).toBe(true)
    expect(isServerCommand('python3 -m http.server 8000')).toBe(true)
    expect(isServerCommand('pnpm test')).toBe(false)
  })

  test('reads local URLs and ports from coloured output and from the command', () => {
    const vite = '\u001b[32m  ➜  Local:\u001b[39m   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n  ➜  Network: use --host'
    expect(urlsOf(vite)).toEqual(['http://localhost:5173/'])
    expect(outputPorts('Server listening on port 3000.\nSee https://example.com:8443')).toEqual([3000])
    expect(urlsOf('Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)')).toEqual(['http://localhost:8000'])
    expect(commandPorts('PORT=4000 node server.js')).toEqual([4000])
    expect(commandPorts('python3 manage.py runserver 0.0.0.0:8001')).toEqual([8001])
    expect(commandPorts('vite --port 5174')).toEqual([5174])
  })

  test('finds the output file of a background command', () => {
    expect(outputPathOf(BG)).toBe(OUT)
    expect(outputPathOf('ok')).toBeUndefined()
  })

  test('keeps the last lines, colours off', () => {
    expect(tailOf('a\n\n\u001b[31mb\u001b[0m\nc', 2)).toEqual(['b', 'c'])
  })

  test('reads lsof field output, and judges a server by its ports', () => {
    const lsof = 'p501\ncnode\nn*:5173\nn[::1]:5173\np77\ncpython3\nn127.0.0.1:8000\n'
    const listening = parseLsof(lsof)
    expect(listening).toEqual([
      { port: 5173, pid: 501, process: 'node' },
      { port: 8000, pid: 77, process: 'python3' },
    ])
    const server: LanternServer = { id: 'b1', command: 'pnpm dev', startedAt: 0, urls: [], ports: [5173], state: 'unknown', tail: [], changedAt: 0 }
    expect(judge(server, listening, 9)).toMatchObject({ state: 'listening', pid: 501, changedAt: 9 })
    expect(judge(server, [], 9).state).toBe('down')
    expect(statusOf([{ ...server, state: 'listening' }])).toBe('🏮 :5173●')
  })
})

type World = { output: string; lsof: string; toasts: string[]; status: (string | undefined)[]; clock: ReturnType<typeof mock.clock> }

function world(on: On): World {
  const clock = mock.clock(on, { now: 0 })
  const w: World = { output: '', lsof: '', toasts: [], status: [], clock }
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'tail') return ok(w.output)
    if (e.argv[0] === 'lsof') return ok(w.lsof, w.lsof === '' ? 1 : 0)
    return ok('', 1)
  })
  on('tool.call', ($, e) => {
    const command = (e as unknown as { command?: string }).command ?? ''
    return command === 'pnpm dev' ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: BG } : { result: {}, text: 'ok' }
  })
  return w
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

describe('port-lantern in a session', () => {
  test('follows a background dev server from start to stop', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'pnpm dev', run_in_background: true })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(w.status.at(-1)).toBe('🏮 pnpm dev…')

    w.output = 'VITE v5 ready in 300 ms\n  ➜  Local:   http://localhost:5173/\n'
    w.lsof = 'p501\ncnode\nn*:5173\n'
    await w.clock.advance(5_000)
    expect(w.toasts).toEqual(['🏮 起動: http://localhost:5173/'])
    expect(w.status.at(-1)).toBe('🏮 :5173●')

    w.lsof = ''
    await w.clock.advance(5_000)
    expect(w.toasts.at(-1)).toBe('🏮 停止: :5173（pnpm dev）')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'port-lantern',
        surface,
        component: 'Pane',
        requestId: 'port-lantern',
        props: { title: '開発サーバ', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /○ 停止/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /│ +➜ +Local: +http:\/\/localhost:5173\// })).toBeDefined()
      await ui.unmount()
    }
  })
})
