import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HudState } from '../types'
import { blank, detailOf, firstLine, lineOf, stepOf, summaryOf, targetOf } from './hud'

const hud = atom({ plugin: 'focus-hud', key: 'hud' } as const, blank())

const TICK_MS = 1_000

let seq = 0
let last: string | undefined

async function draw($: EngineInterface, state?: HudState): Promise<void> {
  const line = lineOf(state ?? (await read($, hud)), await $.clock.now())
  if (line === last) return
  last = line
  $.ui.status(line)
}

async function change($: EngineInterface, fn: (s: HudState) => HudState): Promise<void> {
  await draw($, await update($, hud, fn))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'focus', description: '今の目的・対象・実行中の処理・待ち理由をまとめて表示' })
    const started = await next(e)
    last = undefined
    await draw($)
    // The seconds tick on while something runs; an idle session is not redrawn.
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const state = await read($, hud)
        if (state.isRunning || state.calls.length > 0) await draw($, state)
      })().catch(() => undefined)
    })
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && e.command === undefined && !e.isMeta && e.text.trim() !== '') {
      await change($, s => ({ ...s, goal: firstLine(e.text), step: '' }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await change($, s => ({ ...s, isRunning: true, turnStartedAt: now }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await change($, s => ({ ...s, isRunning: false, calls: s.calls.filter(call => call.agentId !== undefined), asking: [] }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const id = e.tool_use_id ?? `call-${++seq}`
    const now = await $.clock.now()
    const target = e.agentId === undefined ? targetOf(tool, input) : undefined
    const step = tool === 'TodoWrite' ? stepOf(input.todos) : undefined
    await change($, s => ({
      ...s,
      calls: [...s.calls, { id, tool, summary: summaryOf(tool, input), startedAt: now, ...(e.agentId === undefined ? {} : { agentId: e.agentId }) }],
      ...(target === undefined || tool === 'TodoWrite' ? {} : { target }),
      ...(step === undefined ? {} : { step }),
    }))
    try {
      return await next(e)
    } finally {
      await change($, s => ({ ...s, calls: s.calls.filter(call => call.id !== id), asking: s.asking.filter(one => one !== id) }))
    }
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  // A call the person must allow: the line says so until it runs or is refused.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      const id = e.tool_use_id
      await change($, s => ({ ...s, asking: [...new Set([...s.asking, id])] }))
    }
    return verdict
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'focus' }, async $ => ({ text: detailOf(await read($, hud), await $.clock.now()) }))
}
