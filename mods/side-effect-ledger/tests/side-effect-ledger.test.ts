import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { classifyCommand, classifyTool, outcomeOf, pushRefs } from '../hooks/ledger'

const PUSH = ['To github.com:me/app.git', '   1a2b3c4..5d6e7f8  main -> main', ' * [new branch]      feat/x -> feat/x', ' + 9a9a9a9...8b8b8b8 wip -> wip (forced update)'].join('\n')

describe('ledger', () => {
  test('reads each ref git push moved', () => {
    expect(pushRefs(PUSH)).toEqual({
      remote: 'github.com:me/app.git',
      refs: [
        { old: '1a2b3c4', now: '5d6e7f8', ref: 'main', isNew: false, isForced: false, isDeleted: false },
        { ref: 'feat/x', isNew: true, isForced: false, isDeleted: false },
        { old: '9a9a9a9', now: '8b8b8b8', ref: 'wip', isNew: false, isForced: true, isDeleted: false },
      ],
    })
  })

  test('writes the undo of a push from what it printed', () => {
    const [one] = classifyCommand('cd app && git push origin main', '   1a2b3c4..5d6e7f8  main -> main')
    expect(one).toMatchObject({ kind: 'push', label: 'git push origin main', reversibility: 'easy', undo: 'git push --force-with-lease=main:5d6e7f8 origin 1a2b3c4:main' })
    expect(classifyCommand('git push -u origin feat/x', ' * [new branch]      feat/x -> feat/x')[0]?.undo).toBe('git push origin --delete feat/x')
  })

  test('two pushes in one command each undo only what they moved, on their own remote', () => {
    const output = ['To github.com:me/app.git', '   1a2b3c4..5d6e7f8  main -> main', 'To github.com:up/app.git', '   0f0f0f0..5d6e7f8  main -> main'].join('\n')
    const [mine, theirs] = classifyCommand('git push origin main && git push upstream main', output)
    expect(mine?.undo).toBe('git push --force-with-lease=main:5d6e7f8 origin 1a2b3c4:main')
    expect(theirs?.undo).toBe('git push --force-with-lease=main:5d6e7f8 upstream 0f0f0f0:main')
    // One push printed nothing (up to date): which block is whose is unknown, so neither undo names a sha.
    const unsure = classifyCommand('git push origin main && git push upstream main', ['Everything up-to-date', 'To github.com:up/app.git', '   0f0f0f0..5d6e7f8  main -> main'].join('\n'))
    expect(unsure.map(one => one.undo).join(' ')).not.toContain('0f0f0f0')
  })

  test('a push behind git options is still a push, and an option value is not the remote', () => {
    const moved = '   1a2b3c4..5d6e7f8  main -> main'
    expect(classifyCommand('git -C app push origin main', moved)[0]?.undo).toBe('git push --force-with-lease=main:5d6e7f8 origin 1a2b3c4:main')
    expect(classifyCommand('git -c core.sshCommand=ssh push origin main', moved)[0]?.kind).toBe('push')
    expect(classifyCommand('git push -o ci.skip origin main', moved)[0]?.undo).toBe('git push --force-with-lease=main:5d6e7f8 origin 1a2b3c4:main')
    // No remote named: the one git printed is the one pushed to, not necessarily origin.
    expect(classifyCommand('git push', `To github.com:fork/app.git\n${moved}`)[0]?.undo).toBe('git push --force-with-lease=main:5d6e7f8 github.com:fork/app.git 1a2b3c4:main')
  })

  test('knows GitHub, publishing, deploys and infrastructure', () => {
    const kinds = (command: string, output = '') => classifyCommand(command, output).map(one => `${one.kind}:${one.label}`)
    expect(kinds('gh pr create --fill', 'https://github.com/me/app/pull/42\n')).toEqual(['github:gh pr create → #42'])
    expect(classifyCommand('gh pr create --fill', 'https://github.com/me/app/pull/42')[0]?.undo).toBe('gh pr close 42 --delete-branch')
    expect(kinds('npm publish', '+ my-lib@1.2.3')).toEqual(['publish:npm publish → my-lib@1.2.3'])
    expect(kinds('NODE_ENV=production vercel --prod')).toEqual(['deploy:vercel --prod'])
    expect(kinds('kubectl apply -f k8s/')).toEqual(['infra:kubectl apply -f k8s/'])
    expect(kinds('curl -X POST https://api.example.com/v1/items -d @a.json')).toEqual(['api:POST https://api.example.com/v1/items'])
    expect(kinds('curl https://example.com | jq .')).toEqual([])
    expect(kinds('curl -X POST http://localhost:3000/api')).toEqual([])
    expect(kinds('rsync -av dist/ me@host:/srv/www')).toEqual(['remote:rsync -av dist/ me@host:/srv/www'])
    expect(kinds('git status && pnpm test')).toEqual([])
  })

  test('knows tools that write outside: MCP writes and artifact publishes, not reads', () => {
    expect(classifyTool('mcp__claude_ai_Slack__send_message', {})).toMatchObject({ kind: 'message', label: 'Slack: send_message' })
    expect(classifyTool('mcp__claude_ai_Notion__search', {})).toBeUndefined()
    expect(classifyTool('mcp__claude-in-chrome__form_input', {})).toBeUndefined()
    expect(classifyTool('Artifact', { file_path: 'a.html' })?.kind).toBe('publish')
    expect(classifyTool('Artifact', { action: 'read', url: 'x' })).toBeUndefined()
  })

  test('keeps the telling line of what a call answered', () => {
    expect(outcomeOf('Enumerating objects\nTo github.com:me/app.git\n   1a2..5d6  main -> main', true)).toBe('1a2..5d6 main -> main')
    expect(outcomeOf('remote: x\n! [rejected] main -> main (fetch first)\nerror: failed to push', false)).toBe('! [rejected] main -> main (fetch first)')
  })
})

type World = { toasts: string[]; status: (string | undefined)[]; kept: Record<string, unknown>; race?: (mine: unknown) => unknown }

function world(on: On): World {
  const w: World = { toasts: [], status: [], kept: {} }
  // A store in memory the test can read back.
  on('store.get', ($, e) => ({ value: w.kept[e.key] }) as never)
  on('store.set', ($, e) => {
    w.kept[e.key] = e.value
    // Another session, having read before this write, writes its own list over it once.
    const race = w.race
    if (race !== undefined) {
      w.race = undefined
      w.kept[e.key] = race(e.value)
    }
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete w.kept[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(w.kept) }))
  mock.clock(on, { now: 1_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.repo', () => ({ value: { root: '/w', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/w' }))
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
  on('tool.call', ($, e) => {
    const command = (e as unknown as { command?: string }).command
    if (command === 'git push origin main') return { result: {}, text: PUSH }
    if (command === 'npm publish') return { result: {}, text: 'npm error 403 Forbidden', isError: true }
    return { result: {}, text: 'ok' }
  })
  return w
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

describe('side-effect-ledger in a session', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the ${surface} ledger records outcomes and tracks whether the undo was checked`, async ($, on) => {
      const w = world(on)
      await $.session.start(START)
      await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
      await $.tool.call({ tool: 'Bash', command: 'npm publish' })
      await $.tool.call({ tool: 'Bash', command: 'git status' })
      expect(w.toasts[0]).toMatch(/^📒 git push origin main（強制） — 取り消し: git push --force-with-lease=main:5d6e7f8 origin 1a2b3c4:main/)
      expect(w.toasts[1]).toBe('📒 失敗を記録: npm publish')
      expect(w.status.at(-1)).toBe('📒 1 · 取消未確認 1')

      const ui = await $.ui.mount({
        plugin: 'side-effect-ledger',
        surface,
        component: 'Pane',
        requestId: 'side-effect-ledger',
        props: { title: '外部操作の台帳', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /✗ \[公開\] npm publish/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /↩ 戻すのが難しい: git push --force-with-lease=main:5d6e7f8/ })).toBeDefined()
      const confirm = (await ui.findAll({ type: 'Button' })).find(one => one.key?.startsWith('ok:'))
      await ui.press({ key: confirm?.key ?? '' })
      expect(await ui.find({ type: 'Text', text: /☑ 取消確認済み/ })).toBeDefined()
      expect(w.status.at(-1)).toBe('📒 1')
      await ui.unmount()
    })
  }

  test('keeps no credential a command carried', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'curl -X POST -H "Authorization: Bearer s3cr3t-value" "https://api.x.dev/v1/items?token=zzz999"' })
    const text = (await $.command.run({ command: 'ledger', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text
    expect(text).toContain('POST https://api.x.dev/v1/items?token=***')
    const kept = JSON.stringify(w.kept['ledger:/w'])
    expect(kept).toContain('Bearer ***')
    expect(kept).not.toContain('s3cr3t-value')
    expect(kept).not.toContain('zzz999')
  })

  test('an entry overwritten by another session at the same moment is written again', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const theirs = { id: 'other:0', at: 1, kind: 'push', label: 'git push origin other', source: 'git push origin other', isOk: true, outcome: '', undo: '', reversibility: 'easy', undoState: 'unchecked', sessionId: 's2' }
    w.race = () => [theirs]
    await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    const labels = (w.kept['ledger:/w'] as { label: string }[]).map(one => one.label)
    expect(labels).toContain('git push origin other')
    expect(labels.some(label => label.startsWith('git push origin main'))).toBe(true)
  })
})
