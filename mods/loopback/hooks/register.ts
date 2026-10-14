import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LoopbackLast, LoopbackPending } from '../types'
import { addOutcome, collect, contextOf, fresh, fromStore, rateLine, settle, summaryOf } from './findings'

const STORE_KEY = 'outcomes'

const fed = atom({ plugin: 'loopback', key: 'fed' } as const, [] as string[])
const last = atom({ plugin: 'loopback', key: 'last' } as const, null as LoopbackLast | null)
const pending = atom({ plugin: 'loopback', key: 'pending' } as const, null as LoopbackPending | null)

// The detectors' values, read only: their owners alone write them.
const auditLatest = { plugin: 'self-audit', key: 'latest' } as const
const auditViolations = { plugin: 'self-audit', key: 'violations' } as const
const unverified = { plugin: 'done-gate', key: 'isFlagged' } as const
const denials = { plugin: 'sandbox-lens', key: 'denials' } as const

// $.store has no versioned write: this module's writes run one after another.
let queue: Promise<unknown> = Promise.resolve()

function count($: EngineInterface, outcome: { fed: number; repeated: number }): Promise<void> {
  const run = queue.then(async () => {
    await $.store.set(STORE_KEY, addOutcome(fromStore(await $.store.get(STORE_KEY)), outcome))
  })
  queue = run.catch(() => undefined)
  return run
}

export const register: Register = (on, options) => {
  const isEnabled = options.enabled === true

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'loopback', description: 'loopback が最後にモデルへ返した発見と、self-audit 再発率を表示' })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed at an idle prompt: never a command, a hidden prompt, a
    // prompt typed over a running turn, or one a plugin sent.
    if (!isEnabled || e.origin.kind !== 'composer' || e.command !== undefined || e.isMeta || e.turnId !== undefined) {
      return next(e)
    }

    const [latest, violations, isFlagged, held] = await Promise.all([
      $.state.get(auditLatest),
      $.state.get(auditViolations),
      $.state.get(unverified),
      $.state.get(denials),
    ])
    const selfAudit = { latest: latest.value, violations: violations.value }

    const settled = settle(await read($, pending), selfAudit.latest, selfAudit.violations)
    if (settled.outcome !== null) {
      await count($, settled.outcome)
      await update($, pending, () => settled.pending)
    }

    const found = collect({ selfAudit, isUnverified: isFlagged.value === true, denials: held.value })
    const picked = fresh(found, await read($, fed))
    await update($, fed, () => picked.fed)
    if (picked.feed.length === 0) return next(e)

    const audited = picked.feed.filter(f => f.source === 'self-audit')
    if (audited.length > 0 && selfAudit.latest?.status === 'audited') {
      const turnId = selfAudit.latest.turnId
      const rules = audited.map(f => f.key.slice(`self-audit:${turnId}:`.length))
      await update($, pending, () => ({ turnId, rules }))
    }
    const at = await $.clock.now()
    await update($, last, () => ({ at, findings: picked.feed }))
    $.ui.toast(summaryOf(picked.feed))

    return next({ ...e, context: [...(e.context ?? []), contextOf(picked.feed)] })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'loopback' }, async $ => {
    const shown = await read($, last)
    const rate = rateLine(fromStore(await $.store.get(STORE_KEY)))
    const state = isEnabled ? '有効' : '無効（/plugin configure loopback で有効化）'
    if (shown === null) return { text: [`loopback: ${state}`, 'このセッションではまだ何も返していません。', rate].join('\n') }
    return {
      text: [
        `loopback: ${state}`,
        `最後に返した発見（${new Date(shown.at).toLocaleTimeString()}）:`,
        ...shown.findings.map(f => `- [${f.source}] ${f.text}`),
        rate,
      ].join('\n'),
    }
  })
}
