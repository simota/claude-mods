import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import { fromStore, merge, parseDenials } from './parse'
import { formatReport } from './report'

const STORE_KEY = 'denials'
const STATUS_MS = 8000

const denials = atom({ plugin: 'sandbox-lens', key: 'denials' } as const, [])

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

    const hits = parseDenials(ran.text)
    if (hits.length === 0) return ran

    const now = await $.clock.now()
    const before = await read($, denials)
    const after = await update($, denials, list => merge(list, hits, e.command, now))
    await $.store.set(STORE_KEY, merge(fromStore(await $.store.get(STORE_KEY)), hits, e.command, now))

    if (after.length > before.length) {
      $.ui.status(`sandbox 拒否 ${after.length} 種類（/sandbox-report で確認）`)
      clearStatus?.cancel()
      clearStatus = $.clock.after(STATUS_MS, () => $.ui.status(undefined))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sandbox-report' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      await $.store.delete(STORE_KEY)
      await update($, denials, () => [])
      return { text: 'sandbox 拒否の記録を消去しました（このセッションと全期間）。' }
    }

    const session = await read($, denials)
    const allTime = fromStore(await $.store.get(STORE_KEY))

    return { text: formatReport(session, allTime) }
  })
}
