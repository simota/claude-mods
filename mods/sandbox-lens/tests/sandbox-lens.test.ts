import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { merge, parseDenials } from '../hooks/parse'

const NETWORK_OUTPUT = [
  'Post "https://api.github.com/graphql": Forbidden',
  '<sandbox_violations>',
  'deny network-outbound api.github.com:443 (not in this command\'s allowed_domains — re-run the command with this host listed if it needs it)',
  'deny network-outbound api.github.com:443 (not in this command\'s allowed_domains — re-run the command with this host listed if it needs it)',
  '</sandbox_violations>',
].join('\n')

const FILE_OUTPUT = [
  'touch: /Users/someone/repos/app/out.txt: Operation not permitted',
  '<sandbox_violations>',
  'deny file-write-create /Users/someone/repos/app/out.txt',
  '</sandbox_violations>',
].join('\n')

const EPERM_ONLY = "ls: cannot open directory '/Users/someone/Library/Mail': Operation not permitted"

const START = { cwd: '/Users/someone', surface: 'terminal', isInteractive: true } as const

// The test's $ takes command.run's full input, as the engine stamps it for a typed command.
const RUN = {
  command: 'sandbox-report',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

function world(on: On, outputs: string[], statuses: (string | undefined)[]) {
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 14, 4, 30) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    const text = outputs.shift() ?? 'ok'
    return { result: { stdout: text, stderr: '', interrupted: false }, text }
  })
}

describe('parseDenials', () => {
  test('reads network denials once per host', () => {
    expect(parseDenials(NETWORK_OUTPUT)).toEqual([{ kind: 'network', target: 'api.github.com:443' }])
  })

  test('reads a file-write violation and the EPERM path beside it', () => {
    expect(parseDenials(FILE_OUTPUT)).toEqual([
      { kind: 'file-write', target: '/Users/someone/repos/app/out.txt' },
      { kind: 'eperm', target: '/Users/someone/repos/app/out.txt' },
    ])
  })

  test('reads an EPERM path with no violations block', () => {
    expect(parseDenials(EPERM_ONLY)).toEqual([{ kind: 'eperm', target: '/Users/someone/Library/Mail' }])
  })

  test('finds nothing in ordinary output', () => {
    expect(parseDenials('total 0\ndrwxr-xr-x  2 me staff 64 .')).toEqual([])
  })

  test('merge counts repeats and keeps the busiest first', () => {
    const once = merge([], [{ kind: 'network', target: 'a:443' }], 'curl a', 1)
    const twice = merge(once, [{ kind: 'network', target: 'a:443' }, { kind: 'file-read', target: '/x' }], 'curl a', 2)
    expect(twice.map(one => [one.target, one.count])).toEqual([['a:443', 2], ['/x', 1]])
  })
})

describe('sandbox-lens in a session', () => {
  test('tallies denials and reports them with hints', async ($, on) => {
    const statuses: (string | undefined)[] = []
    world(on, [NETWORK_OUTPUT, NETWORK_OUTPUT, FILE_OUTPUT], statuses)
    await $.session.start(START)

    await $.tool.call({ tool: 'Bash', command: 'gh repo view simota/claude-mods' })
    await $.tool.call({ tool: 'Bash', command: 'gh auth status' })
    await $.tool.call({ tool: 'Bash', command: 'touch /Users/someone/repos/app/out.txt' })

    expect(statuses).toEqual([
      'sandbox 拒否 1 種類（/sandbox-report で確認）',
      'sandbox 拒否 3 種類（/sandbox-report で確認）',
    ])

    const { text = '' } = await $.command.run({ ...RUN, args: '' })
    expect(text).toContain('api.github.com:443  ×2')
    expect(text).toContain('sandbox.network.allowedDomains に "api.github.com"')
    expect(text).toContain('sandbox.filesystem.allowWrite に "/Users/someone/repos/app/out.txt"')
    expect(text).toContain('例: gh auth status')
  })

  test('reset clears the session and the store', async ($, on) => {
    world(on, [NETWORK_OUTPUT], [])
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'gh repo view x/y' })

    const reset = await $.command.run({ ...RUN, args: 'reset' })
    expect(reset.text).toContain('消去しました')

    const { text = '' } = await $.command.run({ ...RUN, args: '' })
    expect(text).not.toContain('api.github.com')
    expect(text).toContain('拒否なし')
  })

  test('leaves ordinary Bash output alone', async ($, on) => {
    const statuses: (string | undefined)[] = []
    world(on, ['hello'], statuses)
    await $.session.start(START)

    const ran = await $.tool.call({ tool: 'Bash', command: 'echo hello' })
    expect(ran.text).toBe('hello')
    expect(statuses).toEqual([])
  })
})
