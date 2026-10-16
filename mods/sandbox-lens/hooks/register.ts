import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { fromStore, hasNew, isOverwritten, merge, parseDenials, union } from './parse'
import type { Hit } from './parse'
import { formatReport } from './report'

const STORE_KEY = 'denials'
const STATUS_MS = 8000

const denials = atom({ plugin: 'sandbox-lens', key: 'denials' } as const, [])

// $.store has no versioned write. Within this module, writes run one after another, each
// reading the store afresh, so two Bash calls at once both land and a reset is not undone.
let queue: Promise<unknown> = Promise.resolve()

function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

/**
 * Writes the merged tally, then reads it back: when another session wrote over it in
 * between, the two are merged and written once more. Left over: a write from another
 * session landing inside that second window, and two sessions counting the same denial
 * at once, which reads as one sighting rather than two.
 */
function record($: EngineInterface, hits: readonly Hit[], command: string, now: number): Promise<void> {
  return serially(async () => {
    const wrote = merge(fromStore(await $.store.get(STORE_KEY)), hits, command, now)
    await $.store.set(STORE_KEY, wrote)
    const stored = fromStore(await $.store.get(STORE_KEY))
    if (isOverwritten(wrote, stored)) await $.store.set(STORE_KEY, union(stored, wrote))
  })
}

function forget($: EngineInterface): Promise<void> {
  return serially(() => $.store.delete(STORE_KEY))
}

export const register: Register = on => {
  let clearStatus: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sandbox-report',
      description: 'sandbox の拒否（ネットワーク・ファイル）を集計して表示',
      argumentHint: '[reset]',
    })

    return next(e)
  })

  // Observes only: a failure here must never change what the tool returned.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.text === undefined) return ran

    // A command that succeeded, or was interrupted, keeps its record: its own output in `stdout`
    // and the harness's block alone in `stderr`, so a block in the output was printed by the
    // command (`cat saved.log`), even at the end. One that failed keeps only its error text,
    // and the block that ends it is read: there a printed block cannot be told apart.
    const typed = ran.result
    const stderr = typeof typed === 'object' && typed !== null ? (typed as { stderr?: unknown }).stderr : undefined
    const hits = parseDenials(ran.text, e.command, await $.session.cwd(), typeof stderr === 'string' ? stderr : ran.text)
    if (hits.length === 0) return ran

    const now = await $.clock.now()
    const before = await read($, denials)
    const after = await update($, denials, list => merge(list, hits, e.command, now))
    await record($, hits, e.command, now)

    if (hasNew(before, hits)) {
      $.ui.status(`sandbox 拒否 ${after.length} 種類（/sandbox-report で確認）`)
      clearStatus?.cancel()
      clearStatus = $.clock.after(STATUS_MS, () => $.ui.status(undefined))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sandbox-report' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      await forget($)
      await update($, denials, () => [])
      return { text: 'sandbox 拒否の記録を消去しました（このセッションと全期間）。' }
    }

    const session = await read($, denials)
    const allTime = fromStore(await $.store.get(STORE_KEY))

    return { text: formatReport(session, allTime) }
  })
}
