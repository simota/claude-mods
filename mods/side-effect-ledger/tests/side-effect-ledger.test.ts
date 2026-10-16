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
    const [one] = classifyCommand('git push origin main', 'To github.com:me/app.git\n   1a2b3c4..5d6e7f8  main -> main')
    expect(one).toMatchObject({ kind: 'push', label: 'git push origin main', reversibility: 'easy', undo: 'git push --force-with-lease=main:5d6e7f8 origin 1a2b3c4:main' })
    expect(classifyCommand('git push -u origin feat/x', 'To github.com:me/app.git\n * [new branch]      feat/x -> feat/x')[0]?.undo).toBe('git push origin --delete feat/x')
  })

  test('a sha to force back is given only when the output pairs with the one push surely', () => {
    const moved = 'To github.com:me/app.git\n   1a2b3c4..5d6e7f8  main -> main'
    // Two pushes: blocks cannot be told apart (a remote may have two push URLs), so no sha.
    const two = classifyCommand('git push origin main && git push upstream main', `${moved}\nTo github.com:up/app.git\n   0f0f0f0..5d6e7f8  main -> main`)
    expect(two.map(one => one.undo).join(' ')).not.toMatch(/1a2b3c4|0f0f0f0/)
    // A fetch line before the push is not a ref the push moved.
    const pulled = classifyCommand('git pull --rebase && git push', `From github.com:me/app\n   1111111..2222222  main -> origin/main\n${moved}`)
    expect(pulled[0]?.undo).toBe('git push --force-with-lease=main:5d6e7f8 github.com:me/app.git 1a2b3c4:main')
    // Two push URLs print two blocks for one push: unsure, so no sha.
    expect(classifyCommand('git push origin main', `${moved}\n${moved.replace('me/app', 'me/mirror')}`)[0]?.undo).not.toContain('1a2b3c4')
  })

  test('a push in another directory names the remote git printed; option values and redirects are not the remote', () => {
    const moved = 'To github.com:me/app.git\n   1a2b3c4..5d6e7f8  main -> main'
    const created = 'To github.com:me/app.git\n * [new branch]      feat -> feat'
    // A remote name means a different remote from another directory: the URL means the same one anywhere.
    expect(classifyCommand('git -C app push origin main', moved)[0]?.undo).toBe('git push --force-with-lease=main:5d6e7f8 github.com:me/app.git 1a2b3c4:main')
    for (const command of ['cd app && git push origin feat', 'cd app && cd - && git push origin feat', '(cd app && git push origin feat)', 'pushd app && git push origin feat', 'GIT_DIR=x/.git git push origin feat']) {
      expect(classifyCommand(command, created)[0]?.undo).toBe('git push github.com:me/app.git --delete feat')
    }
    expect(classifyCommand('(cd app && git push origin feat)', created)[0]?.label).toBe('git push origin feat')
    expect(classifyCommand('git -c core.sshCommand=ssh push origin main', moved)[0]?.kind).toBe('push')
    expect(classifyCommand('git push -o ci.skip origin main', moved)[0]?.undo).toBe('git push --force-with-lease=main:5d6e7f8 origin 1a2b3c4:main')
    expect(classifyCommand('git push 2>&1 | tail -5', moved)[0]?.undo).toBe('git push --force-with-lease=main:5d6e7f8 github.com:me/app.git 1a2b3c4:main')
    // No remote named: the one git printed is the one pushed to, not necessarily origin.
    expect(classifyCommand('git push', moved.replace('me/app', 'fork/app'))[0]?.undo).toBe('git push --force-with-lease=main:5d6e7f8 github.com:fork/app.git 1a2b3c4:main')
  })

  test('undos never delete what existed before, and dry runs and reads are not recorded', () => {
    const undo = (command: string, output = '') => classifyCommand(command, output)[0]?.undo
    expect(undo('gh pr create --base main --head develop', 'https://github.com/me/app/pull/12')).toBe('gh pr close https://github.com/me/app/pull/12')
    expect(undo('gh release create --notes-start-tag v0.9 -R o/r --title "Big one" v1.0 dist/app.tgz', 'https://github.com/o/r/releases/tag/v1.0')).toBe(
      'gh release delete v1.0 -R o/r（タグも消すなら --cleanup-tag。release より前からあったタグなら付けない）',
    )
    expect(undo('helm uninstall web -n prod')).toBe('同じ chart と values で helm install web <chart> -n prod（--keep-history 付きで消したなら helm rollback）')
    const none = (command: string, output = '') => expect(classifyCommand(command, output)).toEqual([])
    none('git push --dry-run origin main', 'To github.com:me/app.git\n   1a2b3c4..5d6e7f8  main -> main')
    none('git push -n origin main')
    none('npm publish --dry-run', '+ my-lib@1.2.3')
    none('kubectl create deploy x --image=y --dry-run=client -o yaml')
    none('kubectl rollout status deploy/web')
    none('terraform state list')
    none('wrangler pages dev ./dist')
    expect(classifyCommand('kubectl apply -f k.yaml --dry-run=none', '')[0]?.kind).toBe('infra')
    expect(undo('vercel deploy')).not.toContain('rollback')
    expect(undo('vercel --prod')).toContain('rollback')
    expect(undo('helm install web ./chart -n prod', 'NAME: web\nSTATUS: deployed')).toBe('helm uninstall web -n prod')
    expect(undo('helm upgrade --install web ./chart --namespace prod', 'Release "web" does not exist. Installing it now.\nSTATUS: deployed')).toBe('helm uninstall web --namespace prod')
    expect(undo('helm upgrade --install web ./chart --namespace prod', 'Release "web" has been upgraded.')).toBe('helm history web --namespace prod → helm rollback web <revision> --namespace prod')
    expect(classifyCommand('helm uninstall web', '')[0]?.reversibility).toBe('hard')
    // A flag not known to take or not take a value: the release cannot be told, so none is named.
    expect(undo('helm install --replace web nginx -n prod', 'NAME: web\nSTATUS: deployed')).toBe('helm uninstall web -n prod')
    expect(undo('helm install --some-new-flag web nginx -n prod', 'NAME: web\nSTATUS: deployed')).toBe('helm uninstall <release> -n prod')
    expect(undo('helm install web nginx --set a=b -f v.yaml', 'NAME: web\nSTATUS: deployed')).toBe('helm uninstall web')
    // The tag cannot be told, so the release URL cannot be matched to it: nothing is deleted.
    expect(undo('gh release create --unknown-flag v1.0', 'https://github.com/o/r/releases/tag/v1.0')).toContain('gh release list で確認')
    // A production deploy is never undone by removing it.
    expect(undo('vercel deploy --target=production', 'https://proj.vercel.app')).toContain('rollback')
    expect(undo('vercel deploy --target production', 'https://proj.vercel.app')).toContain('rollback')
    expect(undo('vercel deploy', 'Preview: https://proj-abc123.vercel.app')).toBe('vercel remove https://proj-abc123.vercel.app（プレビューのみ、本番は変わっていない）')
    expect(undo('vercel deploy', 'https://proj.vercel.app')).toBe('vercel remove <プレビューURL>（プレビューのみ、本番は変わっていない）')
    none('vercel --version')
    // A delete or close is given only on the output's word that this call made the thing: a failure
    // hidden behind a pipe or `|| true` exits 0 but names what already existed.
    expect(undo('gh pr create --fill 2>&1 | tail -5', 'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/o/r/pull/7')).not.toContain('gh pr close')
    expect(undo('helm install web ./chart -n prod || true', 'Error: INSTALLATION FAILED: cannot re-use a name that is still in use')).not.toContain('helm uninstall')
    expect(undo('helm install web ./chart -n prod || true', 'Error: INSTALLATION FAILED: cannot re-use a name that is still in use')).toContain('helm status web -n prod')
    expect(undo('gh release create v1.0 || true', 'HTTP 422: Validation Failed (tag_name already exists)')).not.toContain('gh release delete')
    expect(undo('gh repo create o/x --private || true', 'GraphQL: Name already exists on this account')).not.toContain('gh repo delete')
    // Two commands that print the same kind of evidence: whose it is cannot be told, so nothing is closed or deleted.
    expect(undo('gh issue view 3 && gh issue create -t a', 'https://github.com/o/r/issues/3\nhttps://github.com/o/r/issues/4')).not.toContain('gh issue close')
    expect(classifyCommand('gh pr view 3; gh pr create --fill', 'https://github.com/o/r/pull/3\nhttps://github.com/o/r/pull/9').map(one => one.undo).join(' ')).not.toContain('gh pr close')
    expect(undo('gh release view v1.0; gh release create v1.0 || true', 'https://github.com/o/r/releases/tag/v1.0\nrelease with tag v1.0 already exists')).not.toContain('gh release delete')
    expect(classifyCommand('gh release create v1.0 || gh release edit v1.0 --notes x', 'https://github.com/o/r/releases/tag/v1.0').map(one => one.undo).join(' ')).not.toContain('gh release delete')
    // A release URL for another tag is not this one's.
    expect(undo('gh release create v1.1', 'https://github.com/o/r/releases/tag/v1.0')).not.toContain('gh release delete')
    // git push prints none of that evidence: the usual push-then-PR keeps its close.
    expect(classifyCommand('git push -u origin feat && gh pr create --fill', 'remote:   https://github.com/o/r/pull/new/feat\nTo github.com:o/r.git\n * [new branch]      feat -> feat\nhttps://github.com/o/r/pull/9')[1]?.undo).toBe('gh pr close https://github.com/o/r/pull/9')
    expect(undo('gh repo create --public foo', '✓ Created repository me/foo on GitHub')).toBe('gh repo delete me/foo（delete_repo 権限が必要）')
    expect(undo('vercel deploy --target=staging', 'https://proj-staging.vercel.app')).not.toContain('remove')
    // Where the release or repository lives rides along: another cluster's or repository's is not touched.
    expect(undo('helm install web ./chart --kubeconfig ~/.kube/prod', 'NAME: web\nSTATUS: deployed')).toBe('helm uninstall web --kubeconfig ~/.kube/prod')
    // Environment that pointed the command elsewhere is named for every command of the undo; a token is not replayed.
    expect(undo('KUBECONFIG=~/.kube/prod HELM_NAMESPACE=prod HELM_KUBETOKEN=t helm upgrade --install web ./chart')).toBe(
      'helm history web → helm rollback web <revision>（どれも KUBECONFIG=~/.kube/prod HELM_NAMESPACE=prod を付けて実行）',
    )
    expect(undo('GH_REPO=o/other gh release create v1.0', 'https://github.com/o/other/releases/tag/v1.0')).toMatch(/^gh release delete v1\.0.*（どれも GH_REPO=o\/other を付けて実行）$/)
    // kubectl's options before the subcommand do not hide the write, and say where it went.
    expect(undo('kubectl --context prod -n app apply -f x.yaml')).toBe('kubectl rollout undo <deployment>、または以前のマニフェストを kubectl apply（どれも --context prod -n app を付けて実行）')
    expect(classifyCommand('kubectl --insecure-skip-tls-verify apply -f x.yaml', '')[0]?.kind).toBe('infra')
    expect(classifyCommand('kubectl -v6 delete pod x', '')[0]?.kind).toBe('infra')
    none('kubectl --context prod get pods')
    expect(undo('KUBECONFIG=p.yaml kubectl -n app delete pod x')).toBe('削除したリソースは以前のマニフェストで kubectl apply し直す（どれも KUBECONFIG=p.yaml -n app を付けて実行）')
    expect(undo('NODE_ENV=production vercel --prod')).not.toContain('NODE_ENV')
    // A push rejected whole moved nothing.
    expect(undo('git push origin main', 'To github.com:me/app.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs')).toBe('push は拒否され、何も動いていない')
    // GitHub's hint after a push is not the PR; a fetch after the push is not a ref it moved.
    const chained = classifyCommand('git push -u origin feat && gh pr create --fill', 'remote: Create a pull request for feat:\nremote:   https://github.com/o/r/pull/new/feat\nTo github.com:o/r.git\n * [new branch]      feat -> feat\nhttps://github.com/o/r/pull/9')
    expect(chained[1]?.undo).toBe('gh pr close https://github.com/o/r/pull/9')
    expect(undo('git push origin main && git fetch upstream', 'To github.com:me/app.git\n   1a2b3c4..5d6e7f8  main -> main\nFrom github.com:up/app\n   3333333..4444444  main -> upstream/main')).toBe(
      'git push --force-with-lease=main:5d6e7f8 origin 1a2b3c4:main',
    )
  })

  test('knows GitHub, publishing, deploys and infrastructure', () => {
    const kinds = (command: string, output = '') => classifyCommand(command, output).map(one => `${one.kind}:${one.label}`)
    expect(kinds('gh pr create --fill', 'https://github.com/me/app/pull/42\n')).toEqual(['github:gh pr create → #42'])
    expect(classifyCommand('gh pr create --fill', 'https://github.com/me/app/pull/42')[0]?.undo).toBe('gh pr close https://github.com/me/app/pull/42')
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
    if (command === 'git push -u origin feat && gh pr create --fill') return { result: {}, text: 'To github.com:o/r.git\n * [new branch]      feat -> feat\na pull request for branch "feat" into branch "main" already exists:\nhttps://github.com/o/r/pull/7', isError: true }
    if (command === 'helm install web ./chart -n prod') return { result: {}, text: 'Error: INSTALLATION FAILED: cannot re-use a name that is still in use', isError: true }
    if (command === 'terraform apply -auto-approve') return { result: {}, text: 'aws_s3_bucket.a: Creation complete\nError: creating b: AccessDenied', isError: true }
    if (command === 'gh pr create --fill') return { result: {}, text: 'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/o/r/pull/7', isError: true }
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

  test('a call that failed is given no undo that would act on what was there before', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    const [entry] = w.kept['ledger:/w'] as { undo: string; isOk: boolean }[]
    expect(entry?.isOk).toBe(false)
    expect(entry?.undo).not.toContain('gh pr close')
    // In a chain too: the PR that already existed is not closed.
    await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat && gh pr create --fill' })
    expect(JSON.stringify(w.kept['ledger:/w'])).not.toContain('gh pr close')
    // Nor is a release that already existed uninstalled.
    await $.tool.call({ tool: 'Bash', command: 'helm install web ./chart -n prod' })
    expect(JSON.stringify(w.kept['ledger:/w'])).not.toContain('helm uninstall')
    // Infrastructure that failed partway may have applied a part: it says so, and to look before undoing anything.
    await $.tool.call({ tool: 'Bash', command: 'terraform apply -auto-approve' })
    const [applied] = w.kept['ledger:/w'] as { undo: string }[]
    expect(applied?.undo).toBe('失敗したが途中まで反映された可能性あり: 取り消す前に今の状態を確認（helm status / kubectl get / terraform plan など）')
  })

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

  test('past 12 ledgers the store drops one whose undos were all looked at, before one still unchecked', async ($, on) => {
    const w = world(on)
    const entry = (repo: string, at: number, undoState: string) => ({ id: `${repo}:${at}`, at, kind: 'push', label: 'git push', source: 'git push', isOk: true, outcome: '', undo: 'x', reversibility: 'easy', undoState, sessionId: 's0' })
    // Ledgers of 20 other repositories: /r0 is the oldest and still has an unchecked undo; the rest were checked.
    for (let i = 0; i < 20; i += 1) w.kept[`ledger:/r${i}`] = [entry(`/r${i}`, 100 + i, i === 0 ? 'unchecked' : 'confirmed')]
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    const ledgers = Object.keys(w.kept).filter(key => key.startsWith('ledger:'))
    expect(ledgers).toHaveLength(12)
    expect(ledgers).toContain("ledger:/w")
    // Still unchecked: kept though oldest. The checked ones least recently written leave first.
    expect(ledgers).toContain('ledger:/r0')
    expect(ledgers).toContain('ledger:/r19')
    expect(ledgers).not.toContain('ledger:/r1')
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
