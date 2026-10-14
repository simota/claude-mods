import type { SandboxLensDenial, SandboxLensKind } from '../types'

import { ranked } from './parse'

const SHOWN = 10

const LABEL: Record<SandboxLensKind, string> = {
  network: 'ネットワーク',
  'file-write': '書き込み',
  'file-read': '読み取り',
  eperm: 'EPERM',
}

export function hostOf(target: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(target)
  if (bracketed) return bracketed[1] ?? target
  // A bare IPv6 address (`::1`, `fe80::1`) has no port that can be told from its last group.
  if ((target.match(/:/g) ?? []).length > 1) return target
  return target.replace(/:\d+$/, '')
}

/** Loopback and private addresses: their allowedDomains entry opens every port unless it names one. */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase()
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1' || name === '0.0.0.0') return true
  if (name.includes(':')) return /^(fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/.test(name) // link-local, unique-local
  const octets = name.split('.').map(Number)
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a = -1, b = -1] = octets
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}

/** The allowedDomains entry to suggest: a local address keeps its port, so the hint never opens every port. */
export function networkEntry(target: string): string {
  return isLocalHost(hostOf(target)) ? target : hostOf(target)
}

/** Which setting would allow a denial: a hint for the person, never applied. */
export function hintFor(denial: SandboxLensDenial): string {
  switch (denial.kind) {
    case 'network':
      return `sandbox.network.allowedDomains に "${networkEntry(denial.target)}"`
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
