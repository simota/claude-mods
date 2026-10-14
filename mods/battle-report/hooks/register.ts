import type { EngineInterface, Register } from 'claude-code'

import { EDIT_TOOLS, bodyLines, parseShortstat, titleFor } from './report'
import type { TurnStats } from './report'

type Settings = { isSoundOn: boolean; isNotifyOn: boolean }

async function lineStats($: EngineInterface, cwd: string) {
  // Outside a git repository (or before the first commit) git exits non-zero: report 0 / 0.
  const ran = await $.process.run(['git', 'diff', '--shortstat', 'HEAD'], { cwd })
  return ran.exitCode === 0 ? parseShortstat(ran.stdout) : { added: 0, deleted: 0 }
}

async function report(
  $: EngineInterface,
  stats: Omit<TurnStats, 'linesAdded' | 'linesDeleted'>,
  cwd: string,
  { isSoundOn, isNotifyOn }: Settings,
) {
  const lines = await lineStats($, cwd)
  const full: TurnStats = { ...stats, linesAdded: lines.added, linesDeleted: lines.deleted }
  const title = titleFor(full.linesAdded + full.linesDeleted)
  const body = bodyLines(full)

  $.ui.toast(`${title}  ${body.join('  ')}`, { timeoutMs: 8000 })
  if (isNotifyOn) await $.ui.notify(body.join('\n'), { title })
  if (isSoundOn) {
    const sound = full.errors > 0 ? 'Basso' : 'Glass'
    // afplay exists on macOS only; elsewhere the call rejects and the report stays silent.
    await $.process.run(['afplay', `/System/Library/Sounds/${sound}.aiff`]).catch(() => undefined)
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    isSoundOn: options.sound !== false,
    isNotifyOn: options.notify !== false,
  }

  // Main-loop counters for the turn under way; subagent loops (agentId set) are left out.
  let edits = 0
  let errors = 0

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      edits = 0
      errors = 0
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      if (ran.deny !== undefined || ran.isError === true) errors += 1
      else if (EDIT_TOOLS.has(String(e.tool))) edits += 1
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.isAborted) return done

    const stats = {
      inTokens: e.usage?.input_tokens ?? 0,
      outTokens: e.usage?.output_tokens ?? 0,
      cacheTokens: e.usage?.cache_read_input_tokens ?? 0,
      edits,
      errors,
    }
    const cwd = await $.session.cwd()
    // Report from a timer so git, the notification and the sound never hold the turn's end.
    $.clock.after(0, () => {
      report($, stats, cwd, settings).catch(err =>
        $.ui.log(`battle-report: ${String(err)}`, { to: 'debug' }),
      )
    })
    return done
  })
}
