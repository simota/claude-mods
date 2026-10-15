// The ledger, pure: which calls reach outside the working tree, and how each would be undone,
// read from the call and from what it answered.

import type { LedgerEntry, LedgerKind } from '../types'

export type Classified = Pick<LedgerEntry, 'kind' | 'label' | 'undo' | 'reversibility'>

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const words = (part: string) => (part.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(word => word.replace(/^['"]|['"]$/g, ''))

/** What `git push` printed: the remote, and each ref's old and new commit. */
export function pushRefs(output: string): { remote?: string; refs: { old?: string; now?: string; ref: string; isNew: boolean; isForced: boolean; isDeleted: boolean }[] } {
  const remote = output.match(/^To (\S+)/m)?.[1]
  const refs: { old?: string; now?: string; ref: string; isNew: boolean; isForced: boolean; isDeleted: boolean }[] = []
  for (const line of output.split('\n')) {
    const updated = line.match(/^\s*([+ ])\s*([0-9a-f]{7,40})\.{2,3}([0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)/)
    if (updated !== null) {
      refs.push({ old: updated[2], now: updated[3], ref: updated[4] as string, isNew: false, isForced: updated[1] === '+', isDeleted: false })
      continue
    }
    const created = line.match(/^\s*\*\s+\[new (?:branch|tag)\]\s+\S+\s+->\s+(\S+)/)
    if (created !== null) refs.push({ ref: created[1] as string, isNew: true, isForced: false, isDeleted: false })
    const deleted = line.match(/^\s*-\s+\[deleted\]\s+(\S+)/)
    if (deleted !== null) refs.push({ ref: deleted[1] as string, isNew: false, isForced: false, isDeleted: true })
  }
  return { ...(remote === undefined ? {} : { remote }), refs }
}

function gitPush(argv: string[], output: string): Classified {
  const positional = argv.slice(2).filter(word => !word.startsWith('-'))
  const remoteName = positional[0] ?? 'origin'
  const { refs } = pushRefs(output)
  const label = `git ${argv.slice(1).join(' ')}`
  if (refs.length === 0) return { kind: 'push', label, undo: `押し出したコミットを ${remoteName} の以前の位置へ戻す: git push --force-with-lease ${remoteName} <以前のsha>:<ブランチ>（以前の sha は git reflog で確認）`, reversibility: 'manual' }
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

function github(argv: string[], output: string): Classified | undefined {
  const [, area = '', action = ''] = argv
  const url = output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues|releases\/tag)\/[\w.%-]+/)?.[0]
  const number = url?.match(/\/(?:pull|issues)\/(\d+)/)?.[1]
  const tail = number !== undefined ? ` → #${number}` : url !== undefined ? ` → ${url}` : ''
  const label = `gh ${area} ${action}${tail}`
  if (area === 'pr' && action === 'create') return { kind: 'github', label, undo: `gh pr close ${number ?? '<番号>'} --delete-branch`, reversibility: 'easy' }
  if (area === 'pr' && action === 'merge') return { kind: 'github', label, undo: 'マージコミットを git revert -m 1 <sha> して push（またはリバート PR を作る）', reversibility: 'manual' }
  if (area === 'pr' && /^(?:comment|review|edit|close|ready|reopen)$/.test(action)) return { kind: 'github', label, undo: `gh pr ${action === 'close' ? 'reopen' : 'view --web'} ${argv[3] ?? ''}（コメント・レビューは GitHub 上で削除/編集）`.trim(), reversibility: 'manual' }
  if (area === 'issue' && action === 'create') return { kind: 'github', label, undo: `gh issue close ${number ?? '<番号>'}（削除は gh issue delete）`, reversibility: 'easy' }
  if (area === 'issue' && /^(?:comment|edit|close|reopen|delete|transfer)$/.test(action)) return { kind: 'github', label, undo: action === 'delete' ? '削除した issue は戻せません' : 'GitHub 上で編集・再オープン', reversibility: action === 'delete' ? 'hard' : 'manual' }
  if (area === 'release' && action === 'create') {
    const tag = argv.slice(3).find(word => !word.startsWith('-'))
    return { kind: 'publish', label: `gh release create ${tag ?? ''}`.trim(), undo: `gh release delete ${tag ?? '<タグ>'} --cleanup-tag`, reversibility: 'easy' }
  }
  if (area === 'repo' && action === 'create') return { kind: 'github', label, undo: `gh repo delete ${argv[3] ?? '<owner/repo>'}（delete_repo 権限が必要）`, reversibility: 'manual' }
  if (area === 'repo' && action === 'delete') return { kind: 'github', label, undo: '削除したリポジトリは 90 日以内なら Settings から復元を依頼できる場合あり', reversibility: 'hard' }
  if (area === 'workflow' && action === 'run') return { kind: 'deploy', label, undo: '起動したワークフローは gh run cancel <run-id>。実行済みの副作用はワークフロー次第', reversibility: 'manual' }
  if (area === 'api' && argv.some((word, i) => /^(?:-X|--method)$/.test(word) && /^(?:POST|PUT|PATCH|DELETE)$/i.test(argv[i + 1] ?? ''))) {
    return { kind: 'api', label: `gh api ${argv.slice(2).join(' ')}`, undo: '逆の API 呼び出し（作成なら DELETE、更新なら以前の値で PATCH）', reversibility: 'manual' }
  }
  return undefined
}

/** What one shell command (no pipes or chains) reaches outside, or undefined. */
export function classifyArgv(argv: string[], output: string): Classified | undefined {
  const [program = '', sub = '', third = ''] = argv
  const name = program.replace(/^.*\//, '')
  const rest = argv.slice(1).join(' ')
  if (name === 'git' && sub === 'push') return gitPush(argv, output)
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
  if (name === 'kubectl' && /^(?:apply|create|delete|replace|patch|scale|set|edit|rollout|label|annotate)$/.test(sub)) {
    return { kind: 'infra', label: `kubectl ${rest}`, undo: sub === 'delete' ? '削除したリソースは以前のマニフェストで kubectl apply し直す' : 'kubectl rollout undo <deployment>、または以前のマニフェストを kubectl apply', reversibility: sub === 'delete' ? 'hard' : 'manual' }
  }
  if (name === 'helm' && /^(?:install|upgrade|uninstall|rollback|delete)$/.test(sub)) {
    return { kind: 'infra', label: `helm ${rest}`, undo: sub === 'install' ? `helm uninstall ${third}` : `helm history ${third} → helm rollback ${third} <revision>`, reversibility: 'easy' }
  }
  if (name === 'terraform' && /^(?:apply|destroy|import|state)$/.test(sub)) return { kind: 'infra', label: `terraform ${rest}`, undo: '以前の設定に戻して terraform apply（state のバックアップは terraform.tfstate.backup）', reversibility: sub === 'destroy' ? 'hard' : 'manual' }
  if ((name === 'pulumi' && /^(?:up|destroy)$/.test(sub)) || (name === 'cdk' && /^(?:deploy|destroy)$/.test(sub))) return { kind: 'infra', label: `${name} ${rest}`, undo: '以前のコードに戻して再デプロイ（pulumi stack history / cdk diff で差を確認）', reversibility: 'manual' }
  if (name === 'vercel' && (sub === '' || sub === 'deploy' || sub.startsWith('--prod') || /--prod\b/.test(rest))) return { kind: 'deploy', label: `vercel ${rest}`.trim(), undo: 'vercel rollback（または以前のデプロイを vercel promote）', reversibility: 'easy' }
  if (name === 'netlify' && sub === 'deploy') return { kind: 'deploy', label: `netlify ${rest}`, undo: 'Netlify の Deploys 画面で以前のデプロイを Publish', reversibility: 'easy' }
  if ((name === 'fly' || name === 'flyctl') && sub === 'deploy') return { kind: 'deploy', label: `${name} deploy`, undo: 'fly releases で以前のイメージを確認し fly deploy --image <以前のイメージ>', reversibility: 'manual' }
  if (name === 'wrangler' && /^(?:deploy|publish|pages)$/.test(sub)) return { kind: 'deploy', label: `wrangler ${rest}`, undo: 'wrangler rollback（Pages はダッシュボードで以前のデプロイへ）', reversibility: 'easy' }
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

/** Every outside-reaching part of a Bash command; `cd x &&` and env prefixes taken off. */
export function classifyCommand(command: string, output: string): Classified[] {
  const found: Classified[] = []
  for (const part of command.split(/&&|\|\||;|\n|\|/)) {
    const argv = words(part)
    while (argv.length > 0 && (/^\w+=/.test(argv[0] as string) || argv[0] === 'sudo' || argv[0] === 'env' || argv[0] === 'command')) argv.shift()
    if (argv[0] === 'cd') continue
    const one = classifyArgv(argv, output)
    if (one !== undefined) found.push(one)
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
