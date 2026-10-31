import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { errorLine, isCheck, keyOf, normalise, programOf, reconcile, sight, step, toastOf } from '../hooks/book'
import { maskedOf } from '../hooks/mask'

const SSH_PUSH = [
  'Received disconnect from UNKNOWN port 65535:1: This proxy requires authentication, and this client did not offer an authentication method, so the connection was refused.',
  'Disconnected from UNKNOWN port 65535',
  'fatal: Could not read from remote repository.',
].join('\n')

type Run = { text: string; isError: boolean }

describe('maskedOf', () => {
  test('masks credentials in headers, names and token shapes the first version let through', () => {
    const masked: [string, string][] = [
      [`curl -H "X-API-Key: abcdef1234567890" https://api.x`, `curl -H "X-API-Key: ***" https://api.x`],
      [`curl --header 'PRIVATE-TOKEN: glpat-abcdefghij1234567890' https://gl`, `curl --header 'PRIVATE-TOKEN: ***' https://gl`],
      [`PGPASSWORD=hunter2 psql -h db`, `PGPASSWORD=*** psql -h db`],
      [`node app.js --accessToken=abc123 clientSecret=zzz9 APIKey=k1`, `node app.js --accessToken=*** clientSecret=*** APIKey=***`],
      [`stripe login sk_live_abcdefghijklmnop1234`, `stripe login sk_live_***`],
      [`echo npm_abcdefghijklmnopqrstuvwxyz0123456789`, `echo npm_***`],
      [`echo glpat-abcdefghij1234567890`, `echo glpat-***`],
      [`key=1 AIzaSyA1234567890abcdefghijklmnopqrstuv`, `key=*** AIza***`],
      [`curl -d eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl`, `curl -d eyJ***`],
      [`error: {"api_key": "abcd1234efgh", "id": "x"}`, `error: {"api_key": "***", "id": "x"}`],
    ]
    for (const [given, want] of masked) expect(maskedOf(given)).toBe(want)
  })

  test('a long hyphenated run is masked in linear time, and a long name still loses its value', () => {
    // Quadratic before: 80k characters took seconds, holding up the Bash call's hook.
    const run = 'a-'.repeat(160_000)
    const started = performance.now()
    expect(maskedOf(run)).toBe(run)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(maskedOf(`${'x'.repeat(200)}-MY_TOKEN=abc`)).toBe(`${'x'.repeat(200)}-MY_TOKEN=***`)
  })

  test('every shape stays linear on a long adversarial run', () => {
    for (const piece of ['eyJ-', 'docker ', 'a-', 'sk-', ' -H"a', 'a=', '\\"', '\\', "'a'", '"a"']) {
      const run = piece.repeat(Math.ceil(200_000 / piece.length))
      const started = performance.now()
      maskedOf(run)
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  })

  test('a header value is masked whole, also right after -H, and literals inside a value', () => {
    expect(maskedOf(`curl -H "X-Auth: Token abc123" x`)).toBe(`curl -H "X-Auth: ***" x`)
    expect(maskedOf(`curl -H"X-API-Key: abc" x`)).toBe(`curl -H"X-API-Key: ***" x`)
    expect(maskedOf(`curl -HX-API-Key:abc x`)).toBe(`curl -HX-API-Key:*** x`)
    expect(maskedOf(`curl -H "X-Api-Key: abc'def" x`)).toBe(`curl -H "X-Api-Key: ***" x`)
    expect(maskedOf(`{"private_key": "-----BEGIN", "access_key": "AK", "pwd": "p"}`)).toBe(`{"private_key": "***", "access_key": "***", "pwd": "***"}`)
    expect(maskedOf(`kubectl create secret generic s --from-literal=password=hunter2`)).toBe(
      `kubectl create secret generic s --from-literal=password=***`,
    )
  })

  test('masks escaped quotes, adjacent quoted pieces and escaped word separators', () => {
    const values = [
      String.raw`"prefix\"SENTINEL_SUFFIX"`,
      String.raw`'prefix'\''SENTINEL_SUFFIX'`,
      String.raw`prefix\ SENTINEL_SUFFIX`,
      String.raw`prefix\;SENTINEL_SUFFIX`,
      String.raw`'prefix'"SENTINEL_SUFFIX"`,
      String.raw`prefix"SENTINEL_SUFFIX"`,
      String.raw`"prefix"SENTINEL_SUFFIX`,
      String.raw`'prefix SENTINEL_SUFFIX'`,
      String.raw`"prefix'SENTINEL_SUFFIX"`,
    ]
    for (const value of values) {
      for (const prefix of ['PASSWORD=', 'tool --token ', 'tool --password=', 'kubectl --from-literal=password=', 'mysql -p', 'docker login -p ']) {
        expect(maskedOf(`${prefix}${value} next=VISIBLE`)).toBe(`${prefix}*** next=VISIBLE`)
      }
    }
    const cases = [
      [String.raw`curl -H "X-Api-Key: prefix\"SENTINEL_SUFFIX" next=VISIBLE`, 'curl -H "X-Api-Key: ***" next=VISIBLE'],
      [String.raw`curl -H 'X-Api-Key: prefix'\''SENTINEL_SUFFIX' next=VISIBLE`, "curl -H 'X-Api-Key: ***' next=VISIBLE"],
      [String.raw`curl --header='X-Api-Key: prefix'"SENTINEL_SUFFIX" next=VISIBLE`, "curl --header='X-Api-Key: ***' next=VISIBLE"],
      [String.raw`curl -H X-Api-Key:prefix\ SENTINEL_SUFFIX next=VISIBLE`, 'curl -H X-Api-Key:*** next=VISIBLE'],
      [String.raw`curl --user "user:prefix\"SENTINEL_SUFFIX" next=VISIBLE`, 'curl --user "user:***" next=VISIBLE'],
      [String.raw`curl -u 'user:prefix SENTINEL_SUFFIX' next=VISIBLE`, "curl -u 'user:***' next=VISIBLE"],
      [String.raw`curl -u user:prefix\ SENTINEL_SUFFIX next=VISIBLE`, 'curl -u user:*** next=VISIBLE'],
      [String.raw`curl -u'user:prefix'"SENTINEL_SUFFIX" next=VISIBLE`, "curl -u'user:***' next=VISIBLE"],
    ] as const
    for (const [input, expected] of cases) expect(maskedOf(input)).toBe(expected)
  })

  test('masks entire escaped JSON strings and preserves the following field', () => {
    for (const value of ['prefix"SENTINEL_SUFFIX', 'prefix\\SENTINEL_SUFFIX', 'prefix\\"SENTINEL_SUFFIX', 'prefix\nSENTINEL_SUFFIX']) {
      const input = JSON.stringify({ password: value, public: 'VISIBLE' })
      expect(JSON.parse(maskedOf(input))).toEqual({ password: '***', public: 'VISIBLE' })
    }
  })

  test('masks an unfinished JSON credential even when its last escape is incomplete', () => {
    for (const value of ['SENTINEL_SUFFIX', String.raw`prefix\"SENTINEL_SUFFIX`]) {
      const head = '{"password":"' + value
      expect(maskedOf(head)).toBe('{"password":"***"')
      expect(maskedOf(head + '\\')).toBe('{"password":"***"')
    }
  })

  test('keeps URL host and path while masking apostrophes and quoted userinfo fragments', () => {
    const cases = [
      [String.raw`curl "https://user:prefix'SENTINEL_SUFFIX@x.io/p" next=VISIBLE`, 'curl "https://user:***@x.io/p" next=VISIBLE'],
      [String.raw`curl 'https://user:prefix'"SENTINEL_SUFFIX"'@x.io/p' next=VISIBLE`, "curl 'https://user:***@x.io/p' next=VISIBLE"],
      [String.raw`curl 'https://user:prefixSENTINEL_SUFFIX'@x.io/p next=VISIBLE`, "curl 'https://user:***'@x.io/p next=VISIBLE"],
      [String.raw`curl "https://prefix'SENTINEL_SUFFIX@x.io/p" next=VISIBLE`, 'curl "https://***@x.io/p" next=VISIBLE'],
      [String.raw`curl 'https://prefix'"SENTINEL_SUFFIX"'@x.io/p' next=VISIBLE`, "curl 'https://***@x.io/p' next=VISIBLE"],
      [String.raw`curl 'https://prefixSENTINEL_SUFFIX'@x.io/p next=VISIBLE`, "curl 'https://***'@x.io/p next=VISIBLE"],
      ['curl https://user:password=SENTINEL_SUFFIX@x.io/p next=VISIBLE', 'curl https://user:***@x.io/p next=VISIBLE'],
    ] as const
    for (const [input, expected] of cases) expect(maskedOf(input)).toBe(expected)
    expect(maskedOf('curl "https://x.io:443/p" next=VISIBLE')).toBe('curl "https://x.io:443/p" next=VISIBLE')
  })

  test('preserves adjacent JSON fields when a credential marker is inside a public string', () => {
    for (const [message, masked] of [
      ['Authorization: Bearer SENTINEL_SUFFIX', 'Authorization: Bearer ***'],
      ['PASSWORD=SENTINEL_SUFFIX', 'PASSWORD=***'],
    ]) {
      const input = JSON.stringify({ message, public: 'VISIBLE' })
      const expected = JSON.stringify({ message: masked, public: 'VISIBLE' })
      expect(maskedOf(input)).toBe(expected)
      expect(maskedOf(`curl -d '${input}' next=OK`)).toBe(`curl -d '${expected}' next=OK`)
    }
    expect(maskedOf('PASSWORD="" next=VISIBLE')).toBe('PASSWORD=*** next=VISIBLE')
    const url = JSON.stringify({ url: "https://user:prefix'SENTINEL_SUFFIX@x.io/p", public: 'VISIBLE' })
    expect(maskedOf(url)).toBe(JSON.stringify({ url: 'https://user:***@x.io/p', public: 'VISIBLE' }))
    const separate = { url: 'https://x', message: "PASSWORD='prefix;SENTINEL_SUFFIX'", public: 'V' }
    expect(maskedOf(JSON.stringify(separate))).toBe(JSON.stringify({ ...separate, message: 'PASSWORD=***' }))
    const message = { message: "https://x PASSWORD='prefix;SENTINEL_SUFFIX'", public: 'V' }
    expect(maskedOf(JSON.stringify(message))).toBe(JSON.stringify({ ...message, message: 'https://x PASSWORD=***' }))


  })

  test('masks a credential URL nested in a query or fragment', () => {
    for (const separator of ['?next=', '#']) {
      const prefix = `curl 'https://outer.invalid${separator}https://user:`
      expect(maskedOf(`${prefix}SENTINEL_SUFFIX@x.io/p' next=VISIBLE`)).toBe(`${prefix}***@x.io/p' next=VISIBLE`)
    }
  })

  test('keeps nonsecret quoting and the closing quote of a URL', () => {
    for (const input of [
      String.raw`tool --filter "prefix\"VISIBLE" next=VISIBLE`,
      String.raw`{"key":"prefix\"VISIBLE","session":"VISIBLE"}`,
      String.raw`curl -H "Content-Type: application/json" next=VISIBLE`,
    ]) expect(maskedOf(input)).toBe(input)
    expect(maskedOf('curl "https://x.io/a?api_key=VALUE" next=VISIBLE')).toBe('curl "https://x.io/a?api_key=***" next=VISIBLE')
    expect(maskedOf('curl "https://x.io/a?api_key=VALUE&b=1" next=VISIBLE')).toBe('curl "https://x.io/a?api_key=***&b=1" next=VISIBLE')
    const query = { url: 'https://x.io/?api_key=SENTINEL_SUFFIX&visible=1', public: 'VISIBLE' }
    expect(maskedOf(JSON.stringify(query))).toBe(JSON.stringify({ ...query, url: 'https://x.io/?api_key=***&visible=1' }))
  })

  test('leaves alone what only looks like a credential name', () => {
    const kept = [
      `SyntaxError: Unexpected token: '<'`,
      `curl -H "Content-Type: application/json" https://x`,
      `MAX_TOKENS=100 keyboardLayout=us tokenizer=bert`,
      `primaryKey=id sessionId=3 cacheKey=a publicKey=b`,
      `{"key": "src/a.ts", "sortKey": "x", "session": "s1"}`,
      `grep -H password: config.yml`,
      `grep -H "secret_key:" settings.py`,
      `{"tokens": 12, "id": "abc"}`,
    ]
    for (const given of kept) expect(maskedOf(given)).toBe(given)
  })
})

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
    expect(programOf('cd app && make dev')).toBe('make dev')
  })

  test('a leading cd, export or source does not stand for the program', () => {
    // Before: every `cd <dir> && …` was program `cd`, so any later `cd <dir> && ls` "fixed" it.
    expect(programOf('cd /Users/me/app && npm install')).toBe('npm install')
    expect(programOf('cd /a/b && ls')).toBe('ls')
    expect(programOf('source .venv/bin/activate && pip install x')).toBe('pip install')
    expect(programOf('export FOO=1; npm ci')).toBe('npm ci')
    expect(programOf('(cd web && pnpm install)')).toBe('pnpm install')
    expect(programOf('git -C /x/y push origin main')).toBe('git push')
    expect(programOf('git -c core.x=1 --no-pager fetch')).toBe('git fetch')
    expect(programOf('npm install 2>&1 | tail -5')).toBe('npm install')
    expect(programOf('timeout 30 curl -s https://x.io')).toBe('curl')
    expect(programOf('git --config-env n=E push')).toBe('git push')
    // Markers and pauses between the steps do not stand for it either.
    expect(programOf('cd app && echo "=== build ===" && npm run build')).toBe('npm run')
    expect(programOf('cd app && pwd && sleep 2 && curl -s x')).toBe('curl')
    expect(programOf('cd app || exit 1; npm i')).toBe('npm i')
    expect(programOf('if [ -f x ]; then npm i; fi')).toBe('npm i')
    expect(programOf('bash -c "cd a && make build"')).toBe('make build')
    // A substitution names it only when nothing else runs; a cd alone is the program.
    expect(programOf('cd $(dirname foo)')).toBe('cd')
    expect(programOf('cd "$(git rev-parse --show-toplevel)" && npm ci')).toBe('npm ci')
    expect(programOf('X=$(git rev-parse HEAD)')).toBe('git rev-parse')
    expect(programOf('cd /nope')).toBe('cd')
    expect(programOf('echo "a" && echo "b"')).toBe('echo')
    // A shell text that is itself fetched or expanded is named by the shell; find keeps its own name.
    expect(programOf('/bin/bash -c "$(curl -fsSL https://x/install.sh)"')).toBe('bash')
    expect(programOf('eval "$(ssh-agent -s)"')).toBe('eval')
    expect(programOf('sh -c "$CMD"')).toBe('sh')
    expect(programOf('find . -name "*.ts" -exec grep -l foo {} +')).toBe('find')
    expect(programOf(`bash -c 'cd a && $X'`)).toBe('cd')
    expect(programOf('bash -c "echo hi; $CMD"')).toBe('echo')
    expect(programOf(`cd app && ${'x'.repeat(10_100)}`)).toHaveLength(60)
  })

  test('a line the shell reader cannot hold is named by its first word, without throwing', () => {
    expect(programOf(`echo ${'"$('.repeat(20_000)}`)).toBe('echo')
    expect(programOf(`npm install ${'"$('.repeat(3_000)}`)).toBe('npm install')
    // A long line is read by its head, so a leading cd still does not stand for it.
    expect(programOf(`cd app && npm install ${'x'.repeat(20_000)}`)).toBe('npm install')
  })

  test('leaves check failures alone', () => {
    expect(isCheck('pnpm test')).toBe(true)
    expect(isCheck('cargo clippy --offline')).toBe(true)
    expect(isCheck('npx tsc -p .')).toBe(true)
    expect(isCheck('git push origin main')).toBe(false)
    expect(isCheck('pnpm install')).toBe(false)
  })

  test('judges a check as done-gate does (its shell reader is a copy of done-gate\'s)', () => {
    for (const command of ['go vet ./...', 'pyright', 'shellcheck a.sh', 'golangci-lint run', 'cargo nextest run', 'cd app && make test']) {
      expect(isCheck(command)).toBe(true)
    }
    // A failure that is not the check's: the pipe's last command or a fallback decides the status.
    for (const command of ['npm test | tail', 'npm test || true', 'git push', 'curl x.io']) expect(isCheck(command)).toBe(false)
  })

  test('picks the first error-shaped line', () => {
    expect(errorLine(SSH_PUSH)).toContain('This proxy requires authentication')
    // Colour codes and other controls would be drawn raw in the toast and the pane.
    expect(errorLine('\u001b[1m\u001b[31merror\u001b[0m: could not compile `app`\u0007')).toBe('error: could not compile `app`')
    // An unclosed title sequence ends at its line, not at the end of the output.
    expect(errorLine('ok line\n\u001b]0;title\nerror: build failed\nmore')).toBe('error: build failed')
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

  test("another session's write is kept: this write's changes are laid on top of it", () => {
    const base = sight([], { key: 'k1', program: 'git push', line: 'x', repo: 'a', at: 1 }).entries
    const noted = base.map(one => ({ ...one, note: 'old' }))
    // This session: a sighting of k1, the note cleared, and a new kind numbered 2.
    const mine = sight(sight(noted, { key: 'k1', program: 'git push', line: 'x', repo: 'a', at: 2 }).entries, { key: 'k2', program: 'curl', line: 'y', repo: 'a', at: 2 })
      .entries.map(one => (one.key === 'k1' ? (({ note: _, ...rest }) => rest)(one) : one))
    // The other session, meanwhile: a sighting of k1 and its own new kind, also numbered 2.
    const theirs = sight(sight(noted, { key: 'k1', program: 'git push', line: 'x', repo: 'b', at: 3 }).entries, { key: 'k3', program: 'npm ci', line: 'z', repo: 'b', at: 3 }).entries
    const book = reconcile(noted, mine, theirs)
    const k1 = book.find(one => one.key === 'k1')
    expect(k1?.count).toBe(3)
    expect(k1?.note).toBeUndefined()
    expect(book.map(one => [one.key, one.no]).sort()).toEqual([['k1', 1], ['k2', 3], ['k3', 2]])

    const forgotten = reconcile(noted, [], theirs)
    expect(forgotten.map(one => one.key)).toEqual(['k3'])
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

  test('a cd-prefixed failure is settled by its own program, not by any other cd', async ($, on) => {
    const toasts: string[] = []
    const failed = 'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree'
    world(
      on,
      [
        { text: failed, isError: true },
        { text: 'a.ts b.ts', isError: false },
        { text: 'added 12 packages', isError: false },
        { text: failed, isError: true },
      ],
      toasts,
    )
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'cd /Users/someone/repos/app && npm install' })
    await $.tool.call({ tool: 'Bash', command: 'cd /Users/someone/repos/app && ls' })
    await $.tool.call({ tool: 'Bash', command: 'cd /Users/someone/repos/app && npm install --legacy-peer-deps' })
    const again = await $.tool.call({ tool: 'Bash', command: 'cd /Users/someone/repos/other && npm install' })
    expect(again.context?.[0]).toContain('npm install --legacy-peer-deps')
    expect(again.context?.[0]).not.toContain('&& ls')
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
