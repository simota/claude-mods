import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { errorLine, isCheck, keyOf, normalise, programOf, sight, step, toastOf } from '../hooks/book'

const SSH_PUSH = [
  'Received disconnect from UNKNOWN port 65535:1: This proxy requires authentication, and this client did not offer an authentication method, so the connection was refused.',
  'Disconnected from UNKNOWN port 65535',
  'fatal: Could not read from remote repository.',
].join('\n')

type Run = { text: string; isError: boolean }

const START = { cwd: '/Users/someone/repos/app', surface: 'terminal', isInteractive: true } as const
const RUN = { command: 'zukan', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

// The world beneath the plugin: each Bash call answers the next run in `runs`, and the
// model's context and the toasts are recorded.
function world(on: On, runs: Run[], toasts: string[], entries: Record<string, unknown> = {}) {
  mock.store(on, entries)
  mock.clock(on, { now: Date.UTC(2026, 9, 14, 4, 30) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/Users/someone/repos/app', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/Users/someone/repos/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    const run = runs.shift() ?? { text: 'ok', isError: false }
    return run.isError
      ? { result: { stdout: '', stderr: run.text, interrupted: false }, text: run.text, isError: true }
      : { result: { stdout: run.text, stderr: '', interrupted: false }, text: run.text }
  })
}

describe('book', () => {
  test('names the program and subcommand, past env and wrappers', () => {
    expect(programOf('git push origin main')).toBe('git push')
    expect(programOf('FOO=1 sudo pnpm install --frozen-lockfile')).toBe('pnpm install')
    expect(programOf('/usr/bin/curl -s https://x.io')).toBe('curl')
    expect(programOf('cd app && make dev')).toBe('cd app')
  })

  test('leaves check failures alone', () => {
    expect(isCheck('pnpm test')).toBe(true)
    expect(isCheck('cargo clippy --offline')).toBe(true)
    expect(isCheck('npx tsc -p .')).toBe(true)
    expect(isCheck('git push origin main')).toBe(false)
    expect(isCheck('pnpm install')).toBe(false)
  })

  test('picks the first error-shaped line', () => {
    expect(errorLine(SSH_PUSH)).toContain('This proxy requires authentication')
    expect(errorLine('Exit code 1\nsomething odd\n')).toBe('something odd')
    expect(errorLine('')).toBeUndefined()
  })

  test('two sightings that differ in paths, numbers and quotes are one kind', () => {
    const a = normalise("ENOENT: no such file or directory, open '/Users/a/x.json' (line 12)")
    const b = normalise("ENOENT: no such file or directory, open '/Users/b/y.json' (line 7)")
    expect(a).toBe(b)
    expect(normalise('cannot open /tmp/claude/a/b.txt')).toBe(normalise('cannot open ~/c.txt'))
  })

  test('numbers new kinds in order and counts returns', () => {
    const at = 1
    const one = sight([], { key: 'k1', program: 'git push', line: 'x', repo: 'a', at })
    const two = sight(one.entries, { key: 'k2', program: 'curl', line: 'y', repo: 'a', at })
    const again = sight(two.entries, { key: 'k1', program: 'git push', line: 'x', repo: 'b', at: 2 })
    expect([one.entry.no, two.entry.no, again.entry.no]).toEqual([1, 2, 1])
    expect(again.entry).toMatchObject({ count: 2, repos: ['a', 'b'], lastSeen: 2 })
    expect(toastOf(two.entry, true)).toContain('📕 新種のエラー発見！ No.002')
    expect(toastOf(again.entry, false)).toContain('📙 No.001 再会（2回目・未解決）')
  })

  test('a pending error settles on its program succeeding, and expires after ten calls', () => {
    const pending = { 'git push': { key: 'k', failed: 'git push', calls: 0 } }
    expect(step(pending, 'git push', true).fixed?.key).toBe('k')
    expect(step(pending, 'git push', false).fixed).toBeUndefined()
    let aged = pending as Record<string, { key: string; failed: string; calls: number }>
    for (let i = 0; i < 10; i += 1) aged = step(aged, 'ls', true).pending
    expect(aged).toEqual({})
  })
})

describe('zukan in a session', () => {
  test('catches an error, learns the fix, and tells Claude when it comes back', async ($, on) => {
    const toasts: string[] = []
    world(
      on,
      [
        { text: SSH_PUSH, isError: true },
        { text: 'To github.com:me/app.git', isError: false },
        { text: SSH_PUSH, isError: true },
      ],
      toasts,
    )
    await $.session.start(START)

    const first = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(first.context).toBeUndefined()
    await $.tool.call({ tool: 'Bash', command: 'git push origin main', dangerouslyDisableSandbox: true })
    const again = await $.tool.call({ tool: 'Bash', command: 'git push origin feature' })

    expect(toasts[0]).toContain('📕 新種のエラー発見！ No.001')
    expect(toasts[1]).toContain('📗 既知 No.001（2回目）— 前回: sandbox 外で `git push origin main`')
    expect(again.context?.[0]).toContain('outside the sandbox')
    expect(again.context?.[0]).toContain('not an instruction')
  })

  test('credentials in an error line are masked before it is kept or shown', async ($, on) => {
    const toasts: string[] = []
    const failed = "fatal: Authentication failed for 'https://me:hunter2-secret@example.com/app.git/'"
    world(on, [{ text: failed, isError: true }], toasts)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'git fetch origin' })
    await $.command.run({ ...RUN, args: '' })
    const ui = await $.ui.mount({
      plugin: 'zukan',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'zukan',
      props: { title: 'エラー図鑑', isFocused: true, bodyColumns: 160, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(toasts[0]).toContain('me:***@')
    expect(toasts.join('\n')).not.toContain('hunter2-secret')
    expect(await ui.find({ type: 'Text', text: /hunter2-secret/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /me:\*\*\*@example\.com/ })).toBeDefined()
    await ui.unmount()
  })

  test('check failures and successes are not caught', async ($, on) => {
    const toasts: string[] = []
    world(on, [{ text: 'FAIL src/a.test.ts\nError: expected 1', isError: true }, { text: 'ok', isError: false }], toasts)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(toasts).toEqual([])
  })

  test('a note stands for the fix, and forget removes the entry', async ($, on) => {
    const toasts: string[] = []
    const key = keyOf('curl', 'curl: (6) Could not resolve host: x.io')
    const stored = [{ no: 7, key, program: 'curl', line: 'curl: (6) Could not resolve host: x.io', count: 1, firstSeen: 1, lastSeen: 1, repos: ['app'] }]
    world(on, [{ text: 'curl: (6) Could not resolve host: x.io', isError: true }], toasts, { entries: stored })
    await $.session.start(START)

    expect((await $.command.run({ ...RUN, args: 'note 7 VPN を繋ぐ' })).text).toContain('No.7 にメモ')
    const ran = await $.tool.call({ tool: 'Bash', command: 'curl https://x.io' })
    expect(toasts[0]).toContain('前回: VPN を繋ぐ')
    expect(ran.context?.[0]).toContain("The person's note on it: VPN を繋ぐ")

    expect((await $.command.run({ ...RUN, args: 'forget 7' })).text).toContain('消しました')
    expect((await $.command.run({ ...RUN, args: 'note 7 x' })).text).toContain('ありません')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the ${surface} pane shows the book`, async ($, on) => {
      world(on, [{ text: SSH_PUSH, isError: true }], [])
      await $.session.start(START)
      await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
      await $.command.run({ ...RUN, args: '' })

      const ui = await $.ui.mount({
        plugin: 'zukan',
        surface,
        component: 'Pane',
        requestId: 'zukan',
        props: { title: 'エラー図鑑', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /1 種 · 解決済み 0 · 出会い 1 回/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /No\.001 ×1 git push/ })).toBeDefined()
      await ui.unmount()
    })
  }
})
