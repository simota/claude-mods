import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HitAssertion, HitAudit, HitDoneGate, HitRecall, HitTable, HitVerdict } from '../types'
import { isVerification } from './shell'
import { addVerdicts, auditStep, DEFAULT_THRESHOLD, fromStore, guardRules, isSame, marksOf, mutedOf, recallStep, reportLines, revertedRules, thresholdOf, withoutRules } from './verdicts'

const STORE_KEY = 'table'
const LAST_KEPT = 30

const table = atom({ plugin: 'hit-rate', key: 'table' } as const, {} as HitTable)
const muted = atom({ plugin: 'hit-rate', key: 'muted' } as const, [] as string[])
const doneGate = atom({ plugin: 'hit-rate', key: 'doneGate' } as const, 'idle' as HitDoneGate)
const assertions = atom({ plugin: 'hit-rate', key: 'assertions' } as const, {} as Record<string, HitAssertion>)
const seen = atom({ plugin: 'hit-rate', key: 'seen' } as const, [] as string[])
const audit = atom({ plugin: 'hit-rate', key: 'audit' } as const, null as HitAudit | null)
const recalls = atom({ plugin: 'hit-rate', key: 'recalls' } as const, {} as Record<string, HitRecall>)
const turn = atom({ plugin: 'hit-rate', key: 'turn' } as const, 0)
const last = atom({ plugin: 'hit-rate', key: 'last' } as const, [] as HitVerdict[])

// The detectors' values, read only: their owners alone write them.
const flagged = { plugin: 'done-gate', key: 'isFlagged' } as const
const guardEntries = { plugin: 'assertion-guard', key: 'entries' } as const
const auditLatest = { plugin: 'self-audit', key: 'latest' } as const
const auditViolations = { plugin: 'self-audit', key: 'violations' } as const
const zukanPending = { plugin: 'zukan', key: 'pending' } as const
const zukanEntries = { plugin: 'zukan', key: 'entries' } as const

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

type Verdict = Omit<HitVerdict, 'at'>

// $.store has no versioned write: this module's writes run one after another, and when
// another session wrote over the table in between, these verdicts are added to theirs and
// written once more, as loopback does.
let queue: Promise<unknown> = Promise.resolve()

type Gate = { minN: number; threshold: number }

// Tool calls Claude issues in one message are dispatched at once, so two hooks may hold the
// same finding. Each decision is claimed inside an `update` callback, which sees the value as
// it stands at the write: whichever call claims a finding first decides it, the other finds it
// gone (as done-gate decides its nudge).

const drop = <T>(all: Readonly<Record<string, T>>, ids: readonly string[]): Record<string, T> =>
  Object.fromEntries(Object.entries(all).filter(([id]) => !ids.includes(id)))

function publish($: EngineInterface, gate: Gate, now: HitTable): Promise<unknown> {
  return Promise.all([update($, table, () => now), update($, muted, () => mutedOf(now, gate.minN, gate.threshold))])
}

function record($: EngineInterface, gate: Gate, verdicts: readonly Verdict[]): Promise<void> {
  if (verdicts.length === 0) return Promise.resolve()
  const run = queue.then(async () => {
    const at = await $.clock.now()
    await update($, last, list => [...list, ...verdicts.map(v => ({ ...v, at }))].slice(-LAST_KEPT))
    const wrote = addVerdicts(fromStore(await $.store.get(STORE_KEY)), verdicts)
    await $.store.set(STORE_KEY, wrote)
    let stored = fromStore(await $.store.get(STORE_KEY))
    if (!isSame(stored, wrote)) {
      stored = addVerdicts(stored, verdicts)
      await $.store.set(STORE_KEY, stored)
    }
    await publish($, gate, stored)
  })
  queue = run.catch(() => undefined)
  return run
}

/** Brings what hit-rate holds up to the detectors' state as it stands now. */
async function sweep($: EngineInterface, gate: Gate): Promise<void> {
  const [isFlagged, entries, latest, violations, pending, book] = await Promise.all([
    $.state.get(flagged),
    $.state.get(guardEntries),
    $.state.get(auditLatest),
    $.state.get(auditViolations),
    $.state.get(zukanPending),
    $.state.get(zukanEntries),
  ])
  const now = await $.clock.now()
  const turnNow = await read($, turn)

  // done-gate: a flag taken down with no check seen (閉じる) decides nothing.
  let isDismissed = false
  await update($, doneGate, flag => {
    isDismissed = isFlagged.value !== true && flag === 'open'
    if (isFlagged.value === true) return flag === 'idle' ? 'open' : flag
    return 'idle'
  })

  // assertion-guard: open each new entry with its lines counted in the file as it stands.
  for (const entry of entries.value ?? []) {
    let isNew = false
    await update($, seen, list => {
      isNew = !list.includes(entry.id)
      return isNew ? [...list, entry.id].slice(-200) : list
    })
    if (isNew) {
      const text = await $.fs.read(entry.path).then(String).catch(() => undefined)
      if (text !== undefined) {
        const held: HitAssertion = { path: entry.path, rules: guardRules(entry.findings), marks: marksOf(entry.findings, text) }
        await update($, assertions, all => ({ ...all, [entry.id]: held }))
      }
    }
    if (entry.isReviewed) {
      await update($, assertions, all => {
        const one = all[entry.id]
        return one === undefined || one.reviewedTurn !== undefined ? all : { ...all, [entry.id]: { ...one, reviewedTurn: turnNow } }
      })
    }
  }

  let audited: Verdict[] = []
  await update($, audit, held => {
    const step = auditStep(held, latest.value, violations.value)
    audited = step.verdicts
    return step.audit
  })

  let recalled: Verdict[] = []
  await update($, recalls, held => {
    const step = recallStep(held, pending.value, book.value, now)
    recalled = step.verdicts
    return step.recalls
  })

  const dismissed: Verdict[] = isDismissed ? [{ rule: 'done-gate:unverified', verdict: 'unknown', why: '確認コマンドを見ないまま帯が消えた' }] : []
  await record($, gate, [...dismissed, ...audited, ...recalled])
}

/** Settles the rules of the open assertion-guard entries on `paths` whose weakening the files now undo. */
async function checkReverts($: EngineInterface, gate: Gate, paths: readonly string[] | 'all'): Promise<void> {
  const open = Object.entries(await read($, assertions)).filter(([, one]) => paths === 'all' || paths.includes(one.path))
  const undone: [string, string[]][] = []
  for (const [id, one] of open) {
    const text = await $.fs.read(one.path).then(String).catch(() => undefined)
    const rules = text === undefined ? [] : revertedRules(one, text)
    if (rules.length > 0) undone.push([id, rules])
  }
  if (undone.length === 0) return
  let claimed: string[] = []
  await update($, assertions, all => {
    claimed = []
    const next = { ...all }
    for (const [id, rules] of undone) {
      const one = all[id]
      if (one === undefined) continue
      const settled = rules.filter(rule => one.rules.includes(rule))
      claimed.push(...settled)
      const left = withoutRules(one, settled)
      if (left === null) delete next[id]
      else next[id] = left
    }
    return next
  })
  await record($, gate, claimed.map(rule => ({ rule, verdict: 'tp' as const, why: '弱めた編集が元に戻された' })))
}

/** At session end, what nothing decided counts as unknown, and the session's holdings are cleared. */
async function closeSession($: EngineInterface, gate: Gate): Promise<void> {
  const why = 'セッション終了まで判定できなかった'
  const open: Verdict[] = []
  let wasOpen = false
  await update($, doneGate, (held): HitDoneGate => {
    wasOpen = held === 'open'
    return 'idle'
  })
  if (wasOpen) open.push({ rule: 'done-gate:unverified', verdict: 'unknown', why })
  let held: HitAssertion[] = []
  await update($, assertions, all => {
    held = Object.values(all)
    return {}
  })
  for (const one of held) open.push(...one.rules.map(rule => ({ rule, verdict: 'unknown' as const, why })))
  let rules: string[] = []
  await update($, audit, one => {
    rules = one?.rules ?? []
    return null
  })
  for (const rule of rules) open.push({ rule: `self-audit:${rule}`, verdict: 'unknown', why })
  let waiting = 0
  await update($, recalls, all => {
    waiting = Object.keys(all).length
    return {}
  })
  for (let i = 0; i < waiting; i++) open.push({ rule: 'zukan:recall', verdict: 'unknown', why })
  await record($, gate, open)
}

export const register: Register = (on, options) => {
  const isEnabled = options.enabled === true
  const minN = typeof options.minN === 'number' && options.minN > 0 ? options.minN : 20
  const threshold = thresholdOf(options.threshold)
  const gate: Gate = { minN, threshold: threshold.value }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hit-rate', description: '検出 mod の各ルールの的中率（TP/FP/unknown）と、loopback が返すのをやめたルールを表示' })
    if (isEnabled) await publish($, gate, fromStore(await $.store.get(STORE_KEY)))
    return next(e)
  })

  // A prompt settles what the last turn left (self-audit's audit, done-gate's flag). Whether
  // loopback reads `muted` before or after this sweep depends on the plugins' order: at worst
  // it reads the list as of the previous verdict.
  on('prompt.submit', async ($, e, next) => {
    if (isEnabled) await sweep($, gate)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (isEnabled && e.agentId === undefined) await update($, turn, n => n + 1)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!isEnabled) return next(e)
    const tool = String(e.tool)
    const isBash = tool === 'Bash'
    if (!isBash && !EDIT_TOOLS.includes(tool)) return next(e)
    // Seen before the call, so a pending error or a raised flag is known before this call settles it.
    await sweep($, gate).catch(err => $.ui.log(`hit-rate: ${String(err)}`, { to: 'debug' }))

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    try {
      const input = e as unknown as Record<string, unknown>
      if (isBash && typeof input.command === 'string' && isVerification(input.command)) {
        // The first check after the flag decides it: failing, the edits did need checking.
        let isFirst = false
        await update($, doneGate, flag => {
          isFirst = flag === 'open'
          return isFirst ? 'settled' : flag
        })
        if (isFirst) {
          await record($, gate, [
            ran.isError === true
              ? { rule: 'done-gate:unverified', verdict: 'tp', why: 'フラグ後の最初の確認コマンドが失敗' }
              : { rule: 'done-gate:unverified', verdict: 'fp', why: 'フラグ後の最初の確認コマンドが一発で成功' },
          ])
        }
      }
      if (ran.isError !== true) {
        // A Bash call may undo a weakening too (`git restore`, `git checkout --`, `git stash`): every open file is read again.
        const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
        if (isBash) await checkReverts($, gate, 'all')
        else if (path !== undefined) await checkReverts($, gate, [path])
      }
    } catch (err) {
      $.ui.log(`hit-rate: ${String(err)}`, { to: 'debug' })
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here leaves the call as it was

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!isEnabled || e.agentId !== undefined) return done
    // Reviewed by the person and still standing a whole turn later: the weakening was accepted.
    const now = await read($, turn)
    let standing: HitAssertion[] = []
    await update($, assertions, all => {
      const ids = Object.keys(all).filter(id => (all[id]?.reviewedTurn ?? now) < now)
      standing = ids.flatMap(id => (all[id] === undefined ? [] : [all[id]]))
      return drop(all, ids)
    })
    await record($, gate, standing.flatMap(one => one.rules.map(rule => ({ rule, verdict: 'fp' as const, why: '確認後も弱めた編集がそのまま残った' }))))
    return done
  })

  on('session.end', async ($, e, next) => {
    if (isEnabled) await closeSession($, gate).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'hit-rate' }, async $ => {
    const state = isEnabled ? '有効' : '無効（/plugin configure hit-rate で有効化）'
    const now = fromStore(await $.store.get(STORE_KEY))
    return {
      text: [
        `hit-rate: ${state}（n≥${minN} で precision < ${Math.round(gate.threshold * 100)}% のルールは loopback が返さない）`,
        ...(threshold.ignored === undefined ? [] : [`threshold ${threshold.ignored} は 0〜1 の範囲外のため無視し、既定の ${DEFAULT_THRESHOLD} を使っています。`]),
        ...reportLines(now, mutedOf(now, minN, gate.threshold), await read($, last), minN),
      ].join('\n'),
    }
  })
}
