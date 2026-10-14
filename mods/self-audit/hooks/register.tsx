import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SelfAuditLatest, SelfAuditUsage, SelfAuditViolation } from '../types'
import { buildPrompt, clip, compact, parseViolations, ruleName } from './audit'

const violations = atom({ plugin: 'self-audit', key: 'violations' } as const, [] as SelfAuditViolation[])
const isShown = atom({ plugin: 'self-audit', key: 'isShown' } as const, false)
const usage = atom({ plugin: 'self-audit', key: 'usage' } as const, null as SelfAuditUsage | null)
const latest = atom({ plugin: 'self-audit', key: 'latest' } as const, { status: 'none' } as SelfAuditLatest)

const PANE = 'self-audit'
const TITLE = '自己監査'
const RED = '#fb4934'
const BAND_ROWS = 2

// Each audit carries the round it started in; a prompt or turn started since makes its answer stale.
let round = 0

/** Forgets the previous reply's result, so nothing older is shown as the latest's. */
async function forget($: EngineInterface): Promise<void> {
  round += 1
  await update($, isShown, () => false)
  await update($, violations, () => [])
  await update($, usage, () => null)
  await update($, latest, () => ({ status: 'none' }) as SelfAuditLatest)
}

async function skip($: EngineInterface, turnId: string, reason: string): Promise<void> {
  await update($, latest, () => ({ status: 'skipped', turnId, reason }) as SelfAuditLatest)
}

async function audit($: EngineInterface, mine: number, turnId: string, answer: string): Promise<void> {
  const reply = await $.model.fork({ prompt: buildPrompt(answer) })
  if (mine !== round) return
  if (!reply.isAnswered) {
    $.ui.log(`self-audit: no audit (${reply.reason})`, { to: 'debug' })
    await skip($, turnId, `監査の fork が応答しませんでした（${reply.reason}）`)
    return
  }
  const found = parseViolations(reply.text)
  if (found === undefined) {
    $.ui.log('self-audit: the audit reply was not the asked JSON', { to: 'debug' })
    await skip($, turnId, '監査の返答が JSON ではありませんでした')
    return
  }

  await update($, usage, () => ({
    input: reply.usage.input_tokens,
    output: reply.usage.output_tokens,
    cacheRead: reply.usage.cache_read_input_tokens,
    cacheWrite: reply.usage.cache_creation_input_tokens,
  }))
  await update($, violations, () => found)
  await update($, latest, () => ({ status: 'audited', turnId }) as SelfAuditLatest)
  await update($, isShown, () => found.length > 0)
}

/** Why a main-loop turn's reply is not audited, or undefined when it is. */
function skipReason(
  e: { isAborted: boolean; reason: string; answer: string },
  isEnabled: boolean,
  minChars: number,
): string | undefined {
  if (!isEnabled) return '自己監査は無効です'
  if (e.isAborted || e.reason === 'aborted') return 'ターンが中断されました'
  if (e.reason !== 'answer') return `ターンが返答以外で終わりました（${e.reason}）`
  const length = e.answer.trim().length
  if (length < minChars) return `返答が短いため（${length} 文字 < ${minChars}）`
  return undefined
}

export const register: Register = (on, options) => {
  const isEnabled = options.enabled !== false
  const minChars = typeof options.minChars === 'number' ? options.minChars : 200

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'self-audit', description: '直前の返答の自己監査結果をペインに表示する' })
    return next(e)
  })

  on('command.run', { command: 'self-audit' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '自己監査ペインを開きました。' }
  })

  on('prompt.submit', async ($, e, next) => {
    // A slash command (`/self-audit` itself) or a hidden prompt is no new request: the
    // result of the last reply still stands. A command that asks the model clears it at turn.start.
    if (e.command === undefined && !e.isMeta) await forget($)
    return next(e)
  }).catch(($, e, next) => next(e)) // Hiding a band is never worth holding a prompt back.

  on('turn.start', async ($, e, next) => {
    // A turn no prompt started (a plugin's, a continuation) also makes the last result stale.
    if (e.agentId === undefined) await forget($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const reason = skipReason(e, isEnabled, minChars)
    if (reason !== undefined) {
      await skip($, e.turnId, reason)
      return done
    }

    const mine = round
    const { turnId, answer } = e
    await update($, latest, () => ({ status: 'pending', turnId }) as SelfAuditLatest)
    // Audit from a timer so the fork never holds the turn's end.
    $.clock.after(0, () => {
      audit($, mine, turnId, answer).catch(err => $.ui.log(`self-audit: ${String(err)}`, { to: 'debug' }))
    })
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, violations)
    if (e.props.hasSurvey || !(await read($, isShown)) || list.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const room = Math.max(20, e.props.bodyColumns - 2)
    const rest = list.length - BAND_ROWS

    // Stack these rows above what the plugins beneath and the engine draw, rather than in their place.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {list.slice(0, BAND_ROWS).map((one, i) => (
          <Text key={`v${i}`} color={RED}>
            {clip(`⚠ self-audit: ${ruleName(one.rule)} — ${one.why}`, room)}
          </Text>
        ))}
        <Box>
          {rest > 0 && <Text color={RED}>他{rest}件 </Text>}
          <Button key="details" label="詳細" onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />
          <Text> </Text>
          <Button key="dismiss" label="閉じる" role="dismiss" onPress={() => update($, isShown, () => false)} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = await read($, latest)
    const list = await read($, violations)
    const cost = await read($, usage)

    if (state.status === 'none') return <Text dimColor>まだ監査した返答はありません。</Text>
    if (state.status === 'pending') return <Text dimColor>直前の返答を監査中です…</Text>
    if (state.status === 'skipped') return <Text dimColor>直前の返答は監査されていません: {state.reason}</Text>

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>直前の返答に違反は見つかっていません。</Text>}
        {list.map((one, i) => (
          <Box key={`v${i}`} flexDirection="column">
            <Text color={RED}>
              ⚠ {ruleName(one.rule)}（{one.rule}）
            </Text>
            {one.quote !== '' && <Text dimColor>「{one.quote}」</Text>}
            <Text>{one.why}</Text>
          </Box>
        ))}
        {cost !== null && (
          <Text dimColor>
            fork: cache_read {compact(cost.cacheRead)} · in {compact(cost.input)} · out {compact(cost.output)}
          </Text>
        )}
      </Box>
    )
  })
}
