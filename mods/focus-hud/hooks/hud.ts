// The HUD, pure: what a call is about, and the one line drawn from the session's state.

import type { HudCall, HudState } from '../types'

export const blank = (): HudState => ({ goal: '', step: '', target: '', isRunning: false, turnStartedAt: 0, calls: [], asking: [] })

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
const base = (path: string) => path.slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1)
const host = (url: string) => url.replace(/^https?:\/\//, '').split(/[/?#]/)[0] ?? url

export const firstLine = (text: string, max = 40): string => clip(text.split('\n').find(line => line.trim() !== '') ?? '', max)

/** What a call acts on, short: a file's name, a page's host, a command's program. */
export function targetOf(tool: string, input: Record<string, unknown>): string | undefined {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  const path = str('file_path') ?? str('notebook_path') ?? str('path')
  if (path !== undefined) return base(path)
  const url = str('url')
  if (url !== undefined) return host(url)
  if (tool === 'Bash') {
    const command = str('command') ?? ''
    const words = command.replace(/^(?:\s*(?:cd\s+\S+|export\s+\S+)\s*&&\s*)+/, '').trim().split(/\s+/)
    const first = words.find(word => !/^\w+=/.test(word)) ?? ''
    const program = base(first)
    const sub = words[words.indexOf(first) + 1]
    return clip(sub !== undefined && /^[a-z][\w:-]*$/.test(sub) ? `${program} ${sub}` : program, 30)
  }
  const pattern = str('pattern') ?? str('query')
  return pattern === undefined ? undefined : clip(`"${pattern}"`, 30)
}

export function summaryOf(tool: string, input: Record<string, unknown>): string {
  const short = tool.replace(/^mcp__(?:[^_]+(?:_[^_]+)*)__/, '')
  const target = targetOf(tool, input)
  return target === undefined ? short : `${short} ${target}`
}

/** The todo in progress, from a TodoWrite call's list. */
export function stepOf(todos: unknown): string | undefined {
  if (!Array.isArray(todos)) return undefined
  const doing = todos.find(one => typeof one === 'object' && one !== null && (one as { status?: unknown }).status === 'in_progress') as { content?: unknown; activeForm?: unknown } | undefined
  if (doing === undefined) return ''
  const text = typeof doing.activeForm === 'string' ? doing.activeForm : typeof doing.content === 'string' ? doing.content : ''
  return clip(text, 40)
}

export const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])

/** What the session waits on now, in a few words. */
export function waitOf(s: HudState, now: number): string {
  const asked = s.calls.find(call => s.asking.includes(call.id))
  if (asked !== undefined) return `許可待ち: ${asked.summary}`
  const question = s.calls.find(call => ASKING_TOOLS.has(call.tool))
  if (question !== undefined) return 'あなたの回答待ち'
  if (!s.isRunning) return 'あなたの入力待ち'
  const agents = s.calls.filter(call => AGENT_TOOLS.has(call.tool))
  const own = s.calls.filter(call => call.agentId === undefined && !AGENT_TOOLS.has(call.tool))
  const oldest = own[0]
  if (oldest !== undefined) return `${oldest.tool} の終了待ち (${elapsed(now - oldest.startedAt)})`
  if (agents.length > 0) return `サブエージェント ${agents.length}件の終了待ち`
  return `応答生成中 (${elapsed(now - s.turnStartedAt)})`
}

/** The one line: goal › step · target · running · wait. Parts with nothing to say are left out. */
export function lineOf(s: HudState, now: number): string | undefined {
  if (s.goal === '' && !s.isRunning && s.calls.length === 0) return undefined
  const running = s.calls.filter(call => call.agentId === undefined)
  const parts = [
    s.goal === '' ? '' : `🎯 ${s.goal}${s.step === '' ? '' : ` › ${s.step}`}`,
    s.target === '' ? '' : `📄 ${s.target}`,
    running.length === 0 ? '' : `⚙ ${running.at(-1)?.summary}${running.length > 1 ? ` +${running.length - 1}` : ''}`,
    `⏳ ${waitOf(s, now)}`,
  ]
  return parts.filter(Boolean).join(' · ')
}

/** The detail /focus answers with. */
export function detailOf(s: HudState, now: number): string {
  const rows = [
    `目的: ${s.goal || '（まだ依頼がありません）'}`,
    `手順: ${s.step || '—'}`,
    `対象: ${s.target || '—'}`,
    `実行中: ${s.calls.length === 0 ? '—' : s.calls.map((call: HudCall) => `${call.summary}${call.agentId === undefined ? '' : '（サブエージェント）'} ${elapsed(now - call.startedAt)}`).join(' / ')}`,
    `待ち: ${waitOf(s, now)}`,
  ]
  return rows.join('\n')
}
