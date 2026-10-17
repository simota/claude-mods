// The ledger, pure: which calls reach outside the working tree, and how each would be undone,
// read from the call and from what it answered.

import type { LedgerEntry, LedgerKind } from '../types'

export type Classified = Pick<LedgerEntry, 'kind' | 'label' | 'undo' | 'reversibility'>

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const words = (part: string) => (part.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(word => word.replace(/^['"]|['"]$/g, ''))

/** A part less the `)` closing a subshell at its end, by a loop: /\)+\s*$/ tries from each `)` of a run. */
function withoutClosers(part: string): string {
  const text = part.trimEnd()
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 41) end -= 1
  return end < text.length ? text.slice(0, end) : part
}

/** What `git push` printed: the remote, and each ref's old and new commit. */
export function pushRefs(output: string): { remote?: string; refs: { old?: string; now?: string; ref: string; isNew: boolean; isForced: boolean; isDeleted: boolean }[] } {
  const remote = output.match(/^To (\S+)/m)?.[1]
  const refs: { old?: string; now?: string; ref: string; isNew: boolean; isForced: boolean; isDeleted: boolean }[] = []
  for (const line of output.split('\n')) {
    // ` + old...new` (forced) or `   old..new`: the flag read once after the leading space, not by
    // /^\s*([+ ])\s*/, which tries every split of a long run of spaces.
    const body = line.trimStart()
    const isForced = body.startsWith('+')
    const updated =
      isForced || line.slice(0, line.length - body.length).includes(' ')
        ? (isForced ? body.slice(1) : body).match(/^\s*([0-9a-f]{7,40})\.{2,3}([0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)/)
        : null
    if (updated !== null) {
      refs.push({ old: updated[1], now: updated[2], ref: updated[3] as string, isNew: false, isForced, isDeleted: false })
      continue
    }
    const created = line.match(/^\s*\*\s+\[new (?:branch|tag)\]\s+\S+\s+->\s+(\S+)/)
    if (created !== null) refs.push({ ref: created[1] as string, isNew: true, isForced: false, isDeleted: false })
    const deleted = line.match(/^\s*-\s+\[deleted\]\s+(\S+)/)
    if (deleted !== null) refs.push({ ref: deleted[1] as string, isNew: false, isForced: false, isDeleted: true })
  }
  return { ...(remote === undefined ? {} : { remote }), refs }
}

/** What `git push` printed, one block per remote it pushed to (each from its `To <remote>` line). */
export const pushBlocks = (output: string): string[] =>
  output
    .split(/^(?=To \S)/m)
    .filter(block => block.startsWith('To '))
    // A fetch after the push (`From …` and its ref lines) is not part of it.
    .map(block => block.split(/^From \S/m)[0] as string)

// git push options whose value is the next word, so it is not taken for the remote.
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo'])

function gitPush(argv: string[], output: string, isElsewhere: boolean): Classified {
  const positional: string[] = []
  for (let i = 2; i < argv.length; i++) {
    const word = argv[i] as string
    if (PUSH_VALUE_OPTIONS.has(word)) i++
    else if (!word.startsWith('-')) positional.push(word)
  }
  const { remote, refs } = pushRefs(output)
  // With no remote named, git pushed to the branch's upstream: the remote it printed, not necessarily
  // origin. Run in another directory (cd, -C, a subshell), a remote's name may mean another
  // remote where the undo is run: the URL git printed means the same one anywhere.
  const remoteName = isElsewhere ? (remote ?? '<リモートURL>') : (positional[0] ?? remote ?? 'origin')
  const label = `git ${argv.slice(1).join(' ')}`
  // No ref printed as moved and the push refused: there is nothing to put back.
  if (refs.length === 0 && /\[(?:remote )?rejected\]|error: failed to push/.test(output)) {
    return { kind: 'push', label, undo: 'push は拒否され、何も動いていない', reversibility: 'easy' }
  }
  if (refs.length === 0) return { kind: 'push', label, undo: `押し出したコミットを ${remoteName} の以前の位置へ戻す: git push --force-with-lease ${remoteName} <以前のsha>:<ブランチ>（以前の sha は push の出力か git reflog で確認）`, reversibility: 'manual' }
  const undo = refs
    .map(one =>
      one.isDeleted
        ? `${one.ref} を復元: git push ${remoteName} <削除前のsha>:${one.ref}`
        : one.isNew
          ? `git push ${remoteName} --delete ${one.ref}`
          : `git push --force-with-lease=${one.ref}:${one.now} ${remoteName} ${one.old}:${one.ref}`,
    )
    .join(' / ')
  const forced = refs.some(one => one.isForced)
  return { kind: 'push', label: `${label}${forced ? '（強制）' : ''}`, undo, reversibility: forced || refs.some(one => one.isDeleted) ? 'hard' : 'easy' }
}

/**
 * The first positional word after options, and the options of `where` with their values. An
 * option in neither list may or may not take the next word: the positional word cannot be told
 * once one comes before it, and none is named rather than a wrong one.
 */
function firstPositional(args: readonly string[], flags: ReadonlySet<string>, values: ReadonlySet<string>, where: RegExp): { first?: string; kept: string[] } {
  const kept: string[] = []
  let isUnsure = false
  let first: string | undefined
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string
    if (!word.startsWith('-')) {
      if (first === undefined && !isUnsure) first = word
      isUnsure ||= first === undefined
      continue
    }
    const name = word.split('=')[0] as string
    if (where.test(name)) kept.push(...(word.includes('=') ? [word] : [word, args[i + 1] ?? '']))
    if (word.includes('=') || flags.has(word)) continue
    if (values.has(word)) i++
    else if (first === undefined) isUnsure = true
  }
  return { ...(first === undefined ? {} : { first }), kept }
}

const RELEASE_FLAGS = new Set(['-d', '--draft', '-p', '--prerelease', '--generate-notes', '--latest', '--verify-tag', '--notes-from-tag', '--fail-on-no-commits'])
const RELEASE_VALUES = new Set(['-t', '--title', '-n', '--notes', '-F', '--notes-file', '--target', '-R', '--repo', '--notes-start-tag', '--discussion-category'])

/** The tag of `gh release create` and its -R. */
function releaseArgs(args: readonly string[]): { tag?: string; repo: string[] } {
  const { first, kept } = firstPositional(args, RELEASE_FLAGS, RELEASE_VALUES, /^(?:-R|--repo)$/)
  return { ...(first === undefined ? {} : { tag: first }), repo: kept }
}

function github(argv: string[], output: string): Classified | undefined {
  const [, area = '', action = ''] = argv
  // A numbered PR or issue only: GitHub's hint after a push (`…/pull/new/<branch>`) is not one. The
  // last, as gh prints what it made last.
  const url = [...output.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull\/\d+|issues\/\d+|releases\/tag\/[\w.%-]+)/g)].at(-1)?.[0]
  const number = url?.match(/\/(?:pull|issues)\/(\d+)/)?.[1]
  const tail = number !== undefined ? ` → #${number}` : url !== undefined ? ` → ${url}` : ''
  const label = `gh ${area} ${action}${tail}`
  // A close or delete only on the output's word that this call made the thing: a failure hidden
  // behind a pipe or `|| true` exits 0 and prints what already existed. By URL, so a PR made with
  // -R is closed in its repository; the head branch is left alone (it may predate the PR).
  if (area === 'pr' && action === 'create') {
    if (/already exists/i.test(output) || url === undefined) return { kind: 'github', label, undo: 'PR が作られたかは gh pr list で確認（既にあった PR は閉じない）', reversibility: 'manual' }
    return { kind: 'github', label, undo: `gh pr close ${url}`, reversibility: 'easy' }
  }
  if (area === 'pr' && action === 'merge') return { kind: 'github', label, undo: 'マージコミットを git revert -m 1 <sha> して push（またはリバート PR を作る）', reversibility: 'manual' }
  if (area === 'pr' && /^(?:comment|review|edit|close|ready|reopen)$/.test(action)) return { kind: 'github', label, undo: `gh pr ${action === 'close' ? 'reopen' : 'view --web'} ${argv[3] ?? ''}（コメント・レビューは GitHub 上で削除/編集）`.trim(), reversibility: 'manual' }
  if (area === 'issue' && action === 'create') {
    // gh prints the new issue's URL last; an earlier one in a chain (gh issue view) is another issue.
    const made = url?.includes('/issues/') === true ? url : undefined
    if (made === undefined) return { kind: 'github', label, undo: 'issue が作られたかは gh issue list で確認', reversibility: 'manual' }
    return { kind: 'github', label, undo: `gh issue close ${made}（削除は gh issue delete）`, reversibility: 'easy' }
  }
  if (area === 'issue' && /^(?:comment|edit|close|reopen|delete|transfer)$/.test(action)) return { kind: 'github', label, undo: action === 'delete' ? '削除した issue は戻せません' : 'GitHub 上で編集・再オープン', reversibility: action === 'delete' ? 'hard' : 'manual' }
  if (area === 'release' && action === 'create') {
    const { tag, repo } = releaseArgs(argv.slice(3))
    const target = [tag ?? '<タグ>', ...repo].join(' ')
    const isMade = tag !== undefined && !/already exists/i.test(output) && url?.endsWith(`/releases/tag/${encodeURIComponent(tag)}`) === true
    if (!isMade) return { kind: 'publish', label: `gh release create ${tag ?? ''}`.trim(), undo: 'release が作られたかは gh release list で確認（既にあった release は消さない）', reversibility: 'manual' }
    return {
      kind: 'publish',
      label: `gh release create ${tag ?? ''}`.trim(),
      undo: `gh release delete ${target}（タグも消すなら --cleanup-tag。release より前からあったタグなら付けない）`,
      reversibility: 'easy',
    }
  }
  if (area === 'repo' && action === 'create') {
    const made = output.match(/Created repository ([\w.-]+\/[\w.-]+)/)?.[1]
    if (made === undefined) return { kind: 'github', label, undo: 'リポジトリが作られたかは gh repo view で確認（既にあったリポジトリは消さない）', reversibility: 'manual' }
    return { kind: 'github', label, undo: `gh repo delete ${made}（delete_repo 権限が必要）`, reversibility: 'manual' }
  }
  if (area === 'repo' && action === 'delete') return { kind: 'github', label, undo: '削除したリポジトリは 90 日以内なら Settings から復元を依頼できる場合あり', reversibility: 'hard' }
  if (area === 'workflow' && action === 'run') return { kind: 'deploy', label, undo: '起動したワークフローは gh run cancel <run-id>。実行済みの副作用はワークフロー次第', reversibility: 'manual' }
  if (area === 'api' && argv.some((word, i) => /^(?:-X|--method)$/.test(word) && /^(?:POST|PUT|PATCH|DELETE)$/i.test(argv[i + 1] ?? ''))) {
    return { kind: 'api', label: `gh api ${argv.slice(2).join(' ')}`, undo: '逆の API 呼び出し（作成なら DELETE、更新なら以前の値で PATCH）', reversibility: 'manual' }
  }
  return undefined
}

// git options before the subcommand whose value is the next word (`git -C app push`).
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])

/**
 * The git command with the options before its subcommand taken off (`git -C app push` is
 * `git push`), and those of them that say which repository it ran in.
 */
function withoutGitOptions(argv: string[]): { argv: string[]; location: string[] } {
  if ((argv[0] ?? '').replace(/^.*\//, '') !== 'git') return { argv, location: [] }
  const location: string[] = []
  let i = 1
  while (i < argv.length && (argv[i] as string).startsWith('-')) {
    const word = argv[i] as string
    const takesValue = GIT_VALUE_OPTIONS.has(word)
    if (/^(?:-C|--git-dir|--work-tree)$/.test(word)) location.push(word, argv[i + 1] ?? '')
    else if (/^(?:--git-dir|--work-tree)=/.test(word)) location.push(word)
    i += takesValue ? 2 : 1
  }
  return { argv: [argv[0] as string, ...argv.slice(i)], location }
}

/** The words with shell redirections taken off (`2>&1`, `> out.log`, `2>/dev/null`). */
function withoutRedirects(argv: readonly string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string
    if (/^\d*(?:>>?|<)$/.test(word)) i++
    else if (!/^\d*(?:>>?|<)/.test(word)) kept.push(word)
  }
  return kept
}

const isGitPush = (argv: readonly string[]) => (argv[0] ?? '').replace(/^.*\//, '') === 'git' && argv[1] === 'push'

const HELM_FLAGS = new Set(['-i', '--install', '--wait', '--wait-for-jobs', '--atomic', '--create-namespace', '--force', '--reuse-values', '--reset-values', '--reset-then-reuse-values', '--debug', '--devel', '--cleanup-on-fail', '--keep-history', '--no-hooks', '--skip-crds', '--dependency-update', '--replace', '--insecure-skip-tls-verify', '--take-ownership', '--plain-http', '--hide-notes', '--render-subchart-notes', '--disable-openapi-validation', '--verify', '--pass-credentials', '--enable-dns', '--skip-schema-validation', '-g', '--generate-name'])
const HELM_VALUES = new Set(['-f', '--values', '--set', '--set-string', '--set-file', '--set-json', '--set-literal', '--version', '-n', '--namespace', '--kube-context', '--kubeconfig', '--timeout', '--repo', '-o', '--output', '--description', '--post-renderer', '--post-renderer-args', '--username', '--password', '--ca-file', '--cert-file', '--key-file', '--history-max', '--keyring', '--registry-config', '--repository-cache', '--repository-config', '--name-template', '--labels', '--max-history', '--cascade'])

/** helm's release and the options that say where it lives. */
function helmArgs(args: readonly string[]): { release: string; where: string } {
  const { first, kept } = firstPositional(args, HELM_FLAGS, HELM_VALUES, /^(?:-n|--namespace|--kube-context|--kubeconfig)$/)
  return { release: first ?? '<release>', where: kept.length === 0 ? '' : ` ${kept.join(' ')}` }
}

function helm(sub: string, args: readonly string[], output: string): Classified {
  const { release, where } = helmArgs(args)
  const label = `helm ${sub} ${args.join(' ')}`.trim()
  const back = `helm history ${release}${where} → helm rollback ${release} <revision>${where}`
  // An uninstall only on helm's word that this call installed the release: a name already in use
  // fails, and behind `|| true` exits 0.
  const isInstalled = sub === 'install' ? /^STATUS: deployed/m.test(output) : /does not exist\. Installing it now/.test(output)
  if (sub === 'install') {
    if (!isInstalled) return { kind: 'infra', label, undo: `helm status ${release}${where} で状態を確認（入っていたリリースを消さないよう uninstall はしない）`, reversibility: 'manual' }
    return { kind: 'infra', label, undo: `helm uninstall ${release}${where}`, reversibility: 'easy' }
  }
  if (sub === 'uninstall' || sub === 'delete') return { kind: 'infra', label, undo: `同じ chart と values で helm install ${release} <chart>${where}（--keep-history 付きで消したなら helm rollback）`, reversibility: 'hard' }
  if (sub === 'upgrade' && isInstalled) return { kind: 'infra', label, undo: `helm uninstall ${release}${where}`, reversibility: 'easy' }
  return { kind: 'infra', label, undo: back, reversibility: 'easy' }
}

const KUBECTL_WHERE = /^(?:--context|-n|--namespace|--kubeconfig|--cluster|-s|--server)$/
// kubectl's options before the subcommand that take no value; the others take the next word.
const KUBECTL_FLAGS = new Set(['--insecure-skip-tls-verify', '--match-server-version', '--warnings-as-errors', '--disable-compression'])

/** kubectl with its options before the subcommand read past (`kubectl --context prod apply`); where it acted rides on the undo. */
function kubectl(args: readonly string[]): Classified | undefined {
  const where: string[] = []
  let i = 0
  while (i < args.length && (args[i] as string).startsWith('-')) {
    const word = args[i] as string
    i += word.includes('=') || KUBECTL_FLAGS.has(word) || /^-v\d+$/.test(word) ? 1 : 2
  }
  const [sub = '', third = ''] = args.slice(i)
  for (let j = 0; j < args.length; j++) {
    const word = args[j] as string
    if (KUBECTL_WHERE.test(word.split('=')[0] as string)) where.push(...(word.includes('=') ? [word] : [word, args[j + 1] ?? '']))
  }
  if (!(/^(?:apply|create|delete|replace|patch|scale|set|edit|label|annotate)$/.test(sub) || (sub === 'rollout' && /^(?:undo|restart|pause|resume)$/.test(third)))) return undefined
  const undo = sub === 'delete' ? '削除したリソースは以前のマニフェストで kubectl apply し直す' : 'kubectl rollout undo <deployment>、または以前のマニフェストを kubectl apply'
  return { kind: 'infra', label: `kubectl ${args.join(' ')}`, undo: withWhere(undo, where), reversibility: sub === 'delete' ? 'hard' : 'manual' }
}

/** Whether the command only shows what it would do. */
const isDryRun = (argv: readonly string[]): boolean =>
  argv.some(word => word === '--dry-run' || (word.startsWith('--dry-run=') && word !== '--dry-run=none')) ||
  (isGitPush(argv) && argv.slice(2).some(word => /^-[A-Za-z]*n[A-Za-z]*$/.test(word)))

/** What one shell command (no pipes or chains) reaches outside, or undefined. */
export function classifyArgv(given: string[], output: string, isElsewhere = false): Classified | undefined {
  const { argv, location } = withoutGitOptions(given)
  if (isDryRun(argv)) return undefined
  const [program = '', sub = '', third = ''] = argv
  const name = program.replace(/^.*\//, '')
  const rest = argv.slice(1).join(' ')
  if (name === 'git' && sub === 'push') return gitPush(argv, output, isElsewhere || location.length > 0)
  if (name === 'gh') return github(argv, output)
  if (/^(?:npm|pnpm|yarn|bun)$/.test(name) && sub === 'publish') {
    const version = output.match(/\+\s*([@\w./-]+@\d+\.\d+\.\d+[\w.-]*)/)?.[1]
    return { kind: 'publish', label: `${name} publish${version ? ` → ${version}` : ''}`, undo: `npm unpublish ${version ?? '<pkg>@<version>'}（72時間以内・依存がない場合のみ。以後は npm deprecate）`, reversibility: 'hard' }
  }
  if (name === 'cargo' && sub === 'publish') return { kind: 'publish', label: 'cargo publish', undo: 'cargo yank --version <version>（削除はできず、新規依存を止めるだけ）', reversibility: 'hard' }
  if ((name === 'twine' && sub === 'upload') || (name === 'poetry' && sub === 'publish') || (name === 'uv' && sub === 'publish') || (name === 'flit' && sub === 'publish')) {
    return { kind: 'publish', label: `${name} ${sub}`, undo: 'PyPI の管理画面で yank（同じバージョン番号は再利用不可）', reversibility: 'hard' }
  }
  if (name === 'gem' && sub === 'push') return { kind: 'publish', label: 'gem push', undo: 'gem yank <gem> -v <version>', reversibility: 'hard' }
  if (name === 'docker' && (sub === 'push' || (sub === 'buildx' && /--push\b/.test(rest)) || (sub === 'image' && third === 'push'))) {
    return { kind: 'publish', label: `docker ${rest}`, undo: 'レジストリ側でタグを削除し、以前のダイジェストを付け直す', reversibility: 'manual' }
  }
  if (name === 'kubectl') return kubectl(argv.slice(1))
  if (name === 'helm' && /^(?:install|upgrade|uninstall|rollback|delete)$/.test(sub)) return helm(sub, argv.slice(2), output)
  if (name === 'terraform' && (/^(?:apply|destroy|import)$/.test(sub) || (sub === 'state' && /^(?:rm|mv|push|replace-provider)$/.test(third)))) return { kind: 'infra', label: `terraform ${rest}`, undo: '以前の設定に戻して terraform apply（state のバックアップは terraform.tfstate.backup）', reversibility: sub === 'destroy' ? 'hard' : 'manual' }
  if ((name === 'pulumi' && /^(?:up|destroy)$/.test(sub)) || (name === 'cdk' && /^(?:deploy|destroy)$/.test(sub))) return { kind: 'infra', label: `${name} ${rest}`, undo: '以前のコードに戻して再デプロイ（pulumi stack history / cdk diff で差を確認）', reversibility: 'manual' }
  if (name === 'vercel' && (sub === '' || sub === 'deploy' || (sub.startsWith('-') && !/^(?:-v|--version|-h|--help)$/.test(sub)))) {
    // A production deploy is rolled back, never removed; only a preview is removed, by the URL
    // vercel printed as the preview's.
    if (/--prod\b|--target(?:=|\s+)production\b/.test(rest)) return { kind: 'deploy', label: `vercel ${rest}`.trim(), undo: 'vercel rollback（または以前のデプロイを vercel promote）', reversibility: 'easy' }
    if (/--target(?:=|\s+)(?!preview\b)\S/.test(rest)) return { kind: 'deploy', label: `vercel ${rest}`.trim(), undo: 'Vercel ダッシュボードでその環境の以前のデプロイを promote（デプロイは削除しない）', reversibility: 'manual' }
    const preview = output.match(/Preview:\s*(https:\/\/[\w.-]+\.vercel\.app)\b/)?.[1]
    return { kind: 'deploy', label: `vercel ${rest}`.trim(), undo: `vercel remove ${preview ?? '<プレビューURL>'}（プレビューのみ、本番は変わっていない）`, reversibility: 'easy' }
  }
  if (name === 'netlify' && sub === 'deploy') return { kind: 'deploy', label: `netlify ${rest}`, undo: 'Netlify の Deploys 画面で以前のデプロイを Publish', reversibility: 'easy' }
  if ((name === 'fly' || name === 'flyctl') && sub === 'deploy') return { kind: 'deploy', label: `${name} deploy`, undo: 'fly releases で以前のイメージを確認し fly deploy --image <以前のイメージ>', reversibility: 'manual' }
  if (name === 'wrangler' && /^(?:deploy|publish)$/.test(sub)) return { kind: 'deploy', label: `wrangler ${rest}`, undo: 'wrangler rollback', reversibility: 'easy' }
  if (name === 'wrangler' && sub === 'pages' && /^(?:deploy|publish)$/.test(third)) return { kind: 'deploy', label: `wrangler ${rest}`, undo: 'Cloudflare ダッシュボードの Pages で以前のデプロイへロールバック', reversibility: 'easy' }
  if (name === 'firebase' && sub === 'deploy') return { kind: 'deploy', label: `firebase ${rest}`, undo: 'Hosting はコンソールで以前のリリースへロールバック、Functions は以前のコードで再デプロイ', reversibility: 'manual' }
  if (name === 'heroku' && /^(?:releases:rollback|rollback|config:set|ps:scale)$/.test(sub)) return { kind: 'deploy', label: `heroku ${rest}`, undo: 'heroku releases → heroku rollback v<番号>', reversibility: 'easy' }
  if (name === 'gcloud' && /\b(?:deploy|delete|create|update)\b/.test(rest)) return { kind: 'deploy', label: `gcloud ${rest}`, undo: 'Cloud Run は gcloud run services update-traffic --to-revisions=<以前のrevision>=100、その他は以前の設定で再実行', reversibility: 'manual' }
  if (name === 'aws' && (/^s3$/.test(sub) ? /^(?:cp|mv|rm|sync)$/.test(third) : /\b(?:deploy|create|update|delete|put|run-instances|terminate)/.test(third))) {
    return { kind: 'infra', label: `aws ${sub} ${third}`, undo: sub === 's3' ? 'バケットのバージョニングがあれば以前のバージョンへ戻す（なければ元ファイルから再アップロード）' : '以前の設定で同じ API を呼び直す', reversibility: third === 'rm' || third === 'delete' || third === 'terminate-instances' ? 'hard' : 'manual' }
  }
  if (/^(?:curl|http|https|xh|wget)$/.test(name)) {
    const method = argv.find((word, i) => /^(?:-X|--request)$/.test(argv[i - 1] ?? '') && /^(?:POST|PUT|PATCH|DELETE)$/i.test(word)) ?? (argv.some(word => /^(?:-d|--data|--data-raw|--data-binary|--json|-F|--form)$/.test(word) || /^--data/.test(word)) ? 'POST' : undefined)
    const httpieMethod = /^(?:http|https|xh)$/.test(name) && /^(?:POST|PUT|PATCH|DELETE)$/i.test(sub) ? sub.toUpperCase() : undefined
    const verb = (method ?? httpieMethod)?.toUpperCase()
    if (verb === undefined) return undefined
    const url = argv.find(word => /^https?:\/\//.test(word)) ?? ''
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(url)) return undefined
    return { kind: 'api', label: `${verb} ${clip(url, 80)}`, undo: verb === 'DELETE' ? '削除したリソースは API 側で復元できるか確認' : '逆の API 呼び出し（作成なら DELETE、更新なら以前の値で PUT/PATCH）', reversibility: verb === 'DELETE' ? 'hard' : 'manual' }
  }
  if ((name === 'scp' || name === 'rsync') && argv.slice(1).some(word => /^[\w.-]+@?[\w.-]*:[^/]/.test(word) || /^[\w.-]+@[\w.-]+:/.test(word))) {
    return { kind: 'remote', label: `${name} ${clip(rest, 80)}`, undo: 'リモートの上書き前のファイルはバックアップから戻す（rsync --delete で消えたものは戻らない）', reversibility: /--delete\b/.test(rest) ? 'hard' : 'manual' }
  }
  return undefined
}

// Environment that says which cluster, namespace or repository a command acts on.
// A token is not among them: masked, it could not be replayed anyway.
const WHERE_ENV = /^(?:KUBECONFIG|HELM_(?:NAMESPACE|KUBECONTEXT|KUBEAPISERVER|DRIVER)|GH_REPO|GH_HOST)=/

const WHERE_NOTE = /（どれも (.+) を付けて実行）$/

/** The undo with where its command acted named for every command in it (an undo may name several); one note, however many sources. */
export function withWhere(undo: string, where: readonly string[]): string {
  if (where.length === 0) return undo
  const noted = undo.match(WHERE_NOTE)
  const all = noted === null ? where : [...where, noted[1] as string]
  return `${noted === null ? undo : undo.slice(0, -noted[0].length)}（どれも ${all.join(' ')} を付けて実行）`
}

/**
 * Every outside-reaching part of a Bash command; env prefixes, redirections and subshell
 * parentheses taken off. A push is given a sha to force back only when it is the command's one
 * push and git printed one `To` block: with two pushes, or a remote with two push URLs, a block
 * could be another remote's. A command that may run git elsewhere (cd, pushd, a subshell,
 * GIT_DIR) names the remote by the URL git printed.
 */
export function classifyCommand(command: string, output: string): Classified[] {
  let isElsewhere = false
  const parts = command.split(/&&|\|\||;|\n|\|/).map(part => {
    if (/^\s*\(/.test(part)) isElsewhere = true
    const argv = withoutRedirects(words(withoutClosers(part.replace(/^\s*\(+/, ''))))
    const where: string[] = []
    while (argv.length > 0 && (/^\w+=/.test(argv[0] as string) || argv[0] === 'sudo' || argv[0] === 'env' || argv[0] === 'command')) {
      const word = argv.shift() as string
      if (/^GIT_(?:DIR|WORK_TREE)=/.test(word)) isElsewhere = true
      if (WHERE_ENV.test(word)) where.push(word)
    }
    if (/^(?:cd|pushd|popd)$/.test(argv[0] ?? '')) isElsewhere = true
    return { argv, where }
  })
  const pushes = parts.filter(({ argv }) => isGitPush(withoutGitOptions(argv).argv)).length
  // gh and helm print the evidence a close, delete or uninstall is given on (a PR URL, `STATUS:
  // deployed`); with two of them in one command, whose it is cannot be told, so neither sees it.
  // git prints none of it, so `git push && gh pr create` keeps it.
  const isShared = parts.filter(({ argv }) => /^(?:gh|helm)$/.test((argv[0] ?? '').replace(/^.*\//, ''))).length > 1
  const blocks = pushBlocks(output)
  const pushOutput = pushes === 1 && blocks.length === 1 ? (blocks[0] as string) : ''
  const found: Classified[] = []
  for (const { argv, where } of parts) {
    if (/^(?:cd|pushd|popd)$/.test(argv[0] ?? '')) continue
    const program = (argv[0] ?? '').replace(/^.*\//, '')
    const seen = isGitPush(withoutGitOptions(argv).argv) ? pushOutput : isShared && /^(?:gh|helm)$/.test(program) ? '' : output
    const one = classifyArgv(argv, seen, isElsewhere)
    if (one === undefined) continue
    // The undo of a command its environment pointed elsewhere (KUBECONFIG, GH_REPO) goes there too.
    found.push(where.length > 0 && /^(?:helm|gh|kubectl)$/.test(program) ? { ...one, undo: withWhere(one.undo, where) } : one)
  }
  return found
}

const MCP_WRITE = /(?:^|_)(?:create|update|delete|remove|send|post|publish|upload|merge|close|comment|reply|archive|move|rename|share|invite|add|set|write|edit|insert|append|schedule|cancel|deploy|trigger)(?:_|$)/i

/** A tool other than Bash that reaches outside: an MCP write, an artifact publish. */
export function classifyTool(tool: string, input: Record<string, unknown>): Classified | undefined {
  if (tool === 'Artifact') {
    const action = typeof input.action === 'string' ? input.action : 'publish'
    if (action === 'publish' && input.asset !== true) return { kind: 'publish', label: `Artifact publish${typeof input.url === 'string' ? `（更新 ${input.url}）` : ''}`, undo: 'Artifact を action: "delete" で削除（共有済みの閲覧は止まる）', reversibility: 'easy' }
    if (action === 'delete') return { kind: 'publish', label: 'Artifact delete', undo: '削除した Artifact は戻せません', reversibility: 'hard' }
    return undefined
  }
  const m = tool.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
  if (m === null) return undefined
  const [, server = '', action = ''] = m
  if (/claude-in-chrome|Claude_Browser|plugin-authoring/.test(server) || !MCP_WRITE.test(action)) return undefined
  const isMessage = /send|post|reply|comment|invite|share/i.test(action)
  return {
    kind: isMessage ? 'message' : 'api',
    label: `${server.replace(/^claude_ai_/, '')}: ${action}`,
    undo: isMessage ? '送信したメッセージは相手側に残る（削除・訂正はサービス上で）' : `${server.replace(/^claude_ai_/, '')} 上で元に戻す（対応する delete/update を呼ぶ）`,
    reversibility: isMessage ? 'hard' : 'manual',
  }
}

/** A line of what the call answered, for the ledger. */
export function outcomeOf(text: string, isOk: boolean): string {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const pick = isOk ? (lines.find(line => /https?:\/\/|->|→|published|deployed|created|✓|success/i.test(line)) ?? lines.at(-1)) : (lines.find(line => /error|fatal|denied|rejected|failed/i.test(line)) ?? lines.at(-1))
  return clip(pick ?? (isOk ? '成功' : '失敗'), 160)
}

export const KIND_LABEL: Record<LedgerKind, string> = { push: 'push', publish: '公開', deploy: 'デプロイ', infra: 'インフラ', github: 'GitHub', api: 'API', remote: 'リモート', message: '送信' }
export const REVERSIBILITY_LABEL: Record<LedgerEntry['reversibility'], string> = { easy: '戻しやすい', manual: '手作業で戻す', hard: '戻すのが難しい' }
