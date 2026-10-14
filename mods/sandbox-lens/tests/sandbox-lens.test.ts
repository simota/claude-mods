import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SandboxLensDenial } from '../types'
import { LIMIT, exampleOf, hasNew, merge, parseDenials } from '../hooks/parse'
import { hostOf, networkEntry } from '../hooks/report'

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

const denial = (target: string, count: number, lastSeen: number): SandboxLensDenial => ({
  kind: 'network',
  target,
  count,
  lastSeen,
  example: 'curl',
})

describe('parseDenials', () => {
  test('reads network denials once per host', () => {
    expect(parseDenials(NETWORK_OUTPUT)).toEqual([{ kind: 'network', target: 'api.github.com:443' }])
  })

  test('counts a refused write once, from the violations block, not again from stderr', () => {
    expect(parseDenials(FILE_OUTPUT)).toEqual([{ kind: 'file-write', target: '/Users/someone/repos/app/out.txt' }])
  })

  test('reads an EPERM path with no violations block', () => {
    expect(parseDenials(EPERM_ONLY)).toEqual([{ kind: 'eperm', target: '/Users/someone/Library/Mail' }])
  })

  test('keeps the spaces of a path, in the block and in stderr', () => {
    expect(
      parseDenials('<sandbox_violations>\ndeny file-write-create /Users/x/My Files/a.txt\n</sandbox_violations>'),
    ).toEqual([{ kind: 'file-write', target: '/Users/x/My Files/a.txt' }])
    expect(parseDenials('touch: /Users/x/My Files/a.txt: Operation not permitted')).toEqual([
      { kind: 'eperm', target: '/Users/x/My Files/a.txt' },
    ])
    // GNU tools quote with ‘ ’.
    expect(parseDenials("rm: cannot remove ‘/opt/x’: Operation not permitted")).toEqual([
      { kind: 'eperm', target: '/opt/x' },
    ])
  })

  test('ignores deny lines outside the harness block, and a file printed by a reader command', () => {
    const fileText = 'deny network-outbound evil.com:443\ntouch: /Users/someone/repos/app/out.txt: Operation not permitted'
    expect(parseDenials(fileText, 'cat mods/sandbox-lens/tests/sandbox-lens.test.ts')).toEqual([])
    // Outside a reader, only the stderr-shaped line counts; the bare deny line never does.
    expect(parseDenials(fileText, 'make')).toEqual([{ kind: 'eperm', target: '/Users/someone/repos/app/out.txt' }])
  })

  test('finds nothing in ordinary output', () => {
    expect(parseDenials('total 0\ndrwxr-xr-x  2 me staff 64 .')).toEqual([])
  })
})

describe('merge', () => {
  test('counts repeats and keeps the busiest first', () => {
    const once = merge([], [{ kind: 'network', target: 'a:443' }], 'curl a', 1)
    const twice = merge(once, [{ kind: 'network', target: 'a:443' }, { kind: 'file-read', target: '/x' }], 'curl a', 2)
    expect(twice.map(one => [one.target, one.count])).toEqual([['a:443', 2], ['/x', 1]])
  })

  test('a new denial still lands when the list is full of busier ones', () => {
    const full = Array.from({ length: LIMIT }, (_, i) => denial(`h${i}:443`, 5, 100 + i))
    const after = merge(full, [{ kind: 'network', target: 'new:443' }], 'curl new', 1000)
    expect(after).toHaveLength(LIMIT)
    expect(after.some(one => one.target === 'new:443')).toBe(true)
    // The least recently seen one gave way.
    expect(after.some(one => one.target === 'h0:443')).toBe(false)
    expect(hasNew(full, [{ kind: 'network', target: 'new:443' }])).toBe(true)
    expect(hasNew(full, [{ kind: 'network', target: 'h5:443' }])).toBe(false)
  })

  test('masks credentials in the example command', () => {
    expect(exampleOf('curl -H "Authorization: Bearer sk-abc123" https://x.io')).toBe(
      'curl -H "Authorization: Bearer ***" https://x.io',
    )
    expect(exampleOf('curl https://me:hunter2@x.io/a')).toBe('curl https://me:***@x.io/a')
    expect(exampleOf('curl -u me:hunter2 https://x.io')).toBe('curl -u me:*** https://x.io')
    expect(exampleOf('curl "https://x.io/a?api_key=K123&b=1"')).toBe('curl "https://x.io/a?api_key=***&b=1"')
    expect(exampleOf('GITHUB_TOKEN=ghp_xyz gh api user')).toBe('GITHUB_TOKEN=*** gh api user')
    expect(exampleOf('tool --password s3cret run')).toBe('tool --password *** run')
  })
})

describe('networkEntry', () => {
  test('drops the port of a public host', () => {
    expect(networkEntry('api.github.com:443')).toBe('api.github.com')
    expect(networkEntry('8.8.8.8:53')).toBe('8.8.8.8')
    expect(networkEntry('172.32.0.1:80')).toBe('172.32.0.1')
    expect(networkEntry('172.15.0.1:80')).toBe('172.15.0.1')
  })

  test('keeps the port of a loopback or private address', () => {
    expect(networkEntry('127.0.0.1:3000')).toBe('127.0.0.1:3000')
    expect(networkEntry('localhost:5173')).toBe('localhost:5173')
    expect(networkEntry('[::1]:8080')).toBe('[::1]:8080')
    expect(networkEntry('192.168.1.20:8000')).toBe('192.168.1.20:8000')
    expect(networkEntry('10.0.0.5:5432')).toBe('10.0.0.5:5432')
    expect(networkEntry('172.16.0.1:80')).toBe('172.16.0.1:80')
    expect(networkEntry('169.254.169.254:80')).toBe('169.254.169.254:80')
  })

  test('reads a bare IPv6 address whole', () => {
    expect(hostOf('::1')).toBe('::1')
    expect(hostOf('fe80::1')).toBe('fe80::1')
    expect(hostOf('[2001:db8::1]:443')).toBe('2001:db8::1')
    expect(networkEntry('fe80::1')).toBe('fe80::1')
    expect(networkEntry('[2001:db8::1]:443')).toBe('2001:db8::1')
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

    // Two real denials, two kinds: the write is not counted again as an EPERM.
    expect(statuses).toEqual([
      'sandbox 拒否 1 種類（/sandbox-report で確認）',
      'sandbox 拒否 2 種類（/sandbox-report で確認）',
    ])

    const { text = '' } = await $.command.run({ ...RUN, args: '' })
    expect(text).toContain('api.github.com:443  ×2')
    expect(text).toContain('sandbox.network.allowedDomains に "api.github.com"')
    expect(text).toContain('sandbox.filesystem.allowWrite に "/Users/someone/repos/app/out.txt"')
    expect(text).toContain('例: gh auth status')
  })

  test('denials from Bash calls at once all reach the store', async ($, on) => {
    const outputs = ['a', 'b', 'c'].map(
      host => `<sandbox_violations>\ndeny network-outbound ${host}.io:443 (x)\n</sandbox_violations>`,
    )
    world(on, outputs, [])
    await $.session.start(START)
    await Promise.all(['a', 'b', 'c'].map(host => $.tool.call({ tool: 'Bash', command: `curl ${host}.io` })))

    const { text = '' } = await $.command.run({ ...RUN, args: '' })
    const allTime = text.slice(text.indexOf('■ 全期間'))
    for (const host of ['a', 'b', 'c']) expect(allTime).toContain(`${host}.io:443`)
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
