import type { SandboxLensDenial, SandboxLensKind } from '../types'

import { ranked } from './parse'

const SHOWN = 10

const LABEL: Record<SandboxLensKind, string> = {
  network: 'ネットワーク',
  'file-write': '書き込み',
  'file-read': '読み取り',
  eperm: 'EPERM',
}

function hostOf(target: string): string {
  return target.replace(/:\d+$/, '')
}

/** Which setting would allow a denial: a hint for the person, never applied. */
export function hintFor(denial: SandboxLensDenial): string {
  switch (denial.kind) {
    case 'network':
      return `sandbox.network.allowedDomains に "${hostOf(denial.target)}"`
    case 'file-write':
      return `sandbox.filesystem.allowWrite に "${denial.target}"`
    case 'file-read':
      return `sandbox.filesystem.allowRead に "${denial.target}"（denyRead に含まれていないか確認）`
    case 'eperm':
      return denial.target.startsWith('(')
        ? 'パス不明: 該当コマンドを --debug で再確認'
        : `書き込みなら sandbox.filesystem.allowWrite に "${denial.target}"`
  }
}

function clock(ms: number): string {
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function section(title: string, list: readonly SandboxLensDenial[]): string {
  if (list.length === 0) return `■ ${title}\n  拒否なし`

  const total = list.reduce((sum, one) => sum + one.count, 0)
  const rows = ranked(list)
    .slice(0, SHOWN)
    .map(
      one =>
        `  ${LABEL[one.kind]}  ${one.target}  ×${one.count}  (最終 ${clock(one.lastSeen)})\n` +
        `    例: ${one.example}\n` +
        `    ヒント: ${hintFor(one)}`,
    )
  const rest = list.length > SHOWN ? [`  …ほか ${list.length - SHOWN} 件`] : []

  return [`■ ${title}（${list.length} 種類 / 計 ${total} 回）`, ...rows, ...rest].join('\n')
}

export function formatReport(
  session: readonly SandboxLensDenial[],
  allTime: readonly SandboxLensDenial[],
): string {
  return [
    'sandbox 拒否レポート',
    section('このセッション', session),
    section('全期間', allTime),
    '設定は変更していません。ヒントは許可する場合の候補です。',
  ].join('\n\n')
}
