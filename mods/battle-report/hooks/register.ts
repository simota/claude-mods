import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BattleReportTurn } from '../types'
import { EDIT_TOOLS, bodyLines, isUserRejection, parseNumstat, parseWc, titleOf, turnDelta } from './report'
import type { Snapshot, TurnStats } from './report'

type Settings = { isSoundOn: boolean; isNotifyOn: boolean; isQuiet: boolean }
type Base = { root: string; base: string }
type Taken = { base: Base; snap: Snapshot }

// The repo's own config must not run anything: no fsmonitor daemon, no hooks, no external diff.
const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const GIT_TIMEOUT_MS = 10_000
const MAX_UNTRACKED = 200

// The main loop's counters for the turn under way, in $.state so a reload mid-turn keeps them.
const turn = atom({ plugin: 'battle-report', key: 'turn' } as const, { turnId: '', edits: 0, errors: 0, tools: 0 })

async function git($: EngineInterface, args: string[], cwd: string): Promise<string | undefined> {
  try {
    const ran = await $.process.run([...GIT, ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return ran.exitCode === 0 ? ran.stdout : undefined
  } catch {
    return undefined
  }
}

/**
 * The working tree's line changes against the turn's base (HEAD when the turn began),
 * untracked files counted whole. Undefined outside a repository or when git fails.
 */
async function snapshot($: EngineInterface, cwd: string, known?: Base): Promise<Taken | undefined> {
  const root = known?.root ?? (await git($, ['rev-parse', '--show-toplevel'], cwd))?.trim()
  if (!root) return undefined
  const base = known?.base ?? ((await git($, ['rev-parse', '--verify', '-q', 'HEAD'], root))?.trim() || EMPTY_TREE)

  const numstat = await git($, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', base, '--'], root)
  const others = await git($, ['ls-files', '--others', '--exclude-standard', '-z'], root)
  if (numstat === undefined || others === undefined) return undefined

  const files = others.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED)
  let untracked: Snapshot = {}
  if (files.length > 0) {
    try {
      const counted = await $.process.run(['wc', '-l', '--', ...files], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
      untracked = parseWc(counted.stdout, files)
    } catch {
      untracked = {}
    }
  }
  return { base: { root, base }, snap: { ...untracked, ...parseNumstat(numstat) } }
}

async function lineStats($: EngineInterface, cwd: string, start: Promise<Taken | undefined> | undefined) {
  const before = await start
  if (before === undefined) return undefined
  const after = await snapshot($, cwd, before.base)
  return after === undefined ? undefined : turnDelta(before.snap, after.snap)
}

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

  // Each main-loop turn's starting snapshot, by turn id. A reload mid-turn loses it,
  // and that turn is then reported without line counts.
  const starts = new Map<string, Promise<Taken | undefined>>()

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turn, () => ({ turnId: e.turnId, edits: 0, errors: 0, tools: 0 }))
      const cwd = await $.session.cwd()
      // Taken from a timer so git never holds the turn's start.
      $.clock.after(0, () => {
        starts.set(e.turnId, snapshot($, cwd))
        for (const id of [...starts.keys()].slice(0, -4)) starts.delete(id)
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      const isFailed = ran.isError === true && !isUserRejection(ran.text)
      const isEdit = ran.deny === undefined && ran.isError !== true && EDIT_TOOLS.has(String(e.tool))
      await update($, turn, now => ({
        ...now,
        tools: now.tools + 1,
        errors: now.errors + (isFailed ? 1 : 0),
        edits: now.edits + (isEdit ? 1 : 0),
      }))
    }
    return ran
  }).catch(($, e, next) => next(e)) // counting only: a failure here never changes the call

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const start = starts.get(e.turnId)
    starts.delete(e.turnId)
    if (e.isAborted) return done

    const now = await read($, turn)
    const counters: BattleReportTurn = now.turnId === e.turnId ? now : { turnId: e.turnId, edits: 0, errors: 0, tools: 0 }
    if (settings.isQuiet && e.reason === 'answer' && counters.tools === 0) return done

    const partial = {
      inTokens: e.usage?.input_tokens ?? 0,
      outTokens: e.usage?.output_tokens ?? 0,
      cacheReadTokens: e.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: e.usage?.cache_creation_input_tokens ?? 0,
      edits: counters.edits,
      errors: counters.errors,
      failure: e.reason === 'error' || e.reason === 'refusal' ? e.reason : undefined,
    }
    const cwd = await $.session.cwd()
    // Report from a timer so git, the notification and the sound never hold the turn's end.
    $.clock.after(0, () => {
      lineStats($, cwd, start)
        .catch(() => undefined) // without line counts, the report still goes out
        .then(lines => report($, { ...partial, lines }, settings))
        .catch(err => $.ui.log(`battle-report: ${String(err)}`, { to: 'debug' }))
    })
    return done
  })
}
