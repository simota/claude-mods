import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BattleReportTurn } from '../types'
import { EDIT_TOOLS, bodyLines, editLines, isUserRejection, titleOf } from './report'
import type { TurnStats } from './report'

type Settings = { isSoundOn: boolean; isNotifyOn: boolean; isQuiet: boolean }

const EMPTY = (turnId: string): BattleReportTurn => ({ turnId, edits: 0, errors: 0, tools: 0, added: 0, deleted: 0 })

// The main loop's counters for the turn under way, in $.state so a reload mid-turn keeps them.
// Line counts come from the edit tools' own results: no git or wc runs, so nothing a repository
// configures (clean filters, fsmonitor, the index) is ever run or written outside the sandbox.
const turn = atom({ plugin: 'battle-report', key: 'turn' } as const, EMPTY(''))

async function report($: EngineInterface, stats: TurnStats, settings: Settings) {
  const title = titleOf(stats)
  const body = bodyLines(stats)

  $.ui.toast(`${title}  ${body.join('  ')}`, { timeoutMs: 8000 })
  if (settings.isNotifyOn) await $.ui.notify(body.join('\n'), { title })
  if (settings.isSoundOn) {
    const sound = stats.errors > 0 || stats.failure !== undefined ? 'Basso' : 'Glass'
    // afplay exists on macOS only; elsewhere the call rejects and the report stays silent.
    await $.process.run(['afplay', `/System/Library/Sounds/${sound}.aiff`]).catch(() => undefined)
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    isSoundOn: options.sound !== false,
    isNotifyOn: options.notify !== false,
    isQuiet: options.quietTurns !== false,
  }

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, turn, () => EMPTY(e.turnId))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      const isFailed = ran.isError === true && !isUserRejection(ran.text)
      const isEdit = ran.deny === undefined && ran.isError !== true && EDIT_TOOLS.has(String(e.tool))
      const lines = isEdit ? editLines(String(e.tool), e, ran.result) : { added: 0, deleted: 0 }
      await update($, turn, now => ({
        ...now,
        tools: now.tools + 1,
        errors: now.errors + (isFailed ? 1 : 0),
        edits: now.edits + (isEdit ? 1 : 0),
        added: now.added + lines.added,
        deleted: now.deleted + lines.deleted,
      }))
    }
    return ran
  }).catch(($, e, next) => next(e)) // counting only: a failure here never changes the call

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.isAborted) return done

    const now = await read($, turn)
    const counters = now.turnId === e.turnId ? now : EMPTY(e.turnId)
    if (settings.isQuiet && e.reason === 'answer' && counters.tools === 0) return done

    const stats: TurnStats = {
      inTokens: e.usage?.input_tokens ?? 0,
      outTokens: e.usage?.output_tokens ?? 0,
      cacheReadTokens: e.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: e.usage?.cache_creation_input_tokens ?? 0,
      edits: counters.edits,
      errors: counters.errors,
      lines: { added: counters.added, deleted: counters.deleted },
      failure: e.reason === 'error' || e.reason === 'refusal' ? e.reason : undefined,
    }
    // Report from a timer so the notification and the sound never hold the turn's end.
    $.clock.after(0, () => {
      report($, stats, settings).catch(err => $.ui.log(`battle-report: ${String(err)}`, { to: 'debug' }))
    })
    return done
  })
}
