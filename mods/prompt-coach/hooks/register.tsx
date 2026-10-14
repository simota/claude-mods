import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PromptCoachHeld } from '../types'
import { SYSTEM, clampTimeout, heldFrom, isJudgeable, parseVerdict, promptFor, remember } from './judge'

const held = atom({ plugin: 'prompt-coach', key: 'held' } as const, null as PromptCoachHeld | null)
const judged = atom({ plugin: 'prompt-coach', key: 'judged' } as const, [] as string[])

const DROP_REASON = 'prompt-coach: 依頼が曖昧なため送信を保留しました（入力欄の上の案内を参照）'

/** Takes the held prompt down and hands back its text. */
const release = async ($: EngineInterface): Promise<string | undefined> => {
  const prompt = await read($, held)
  await update($, held, () => null)
  return prompt?.text
}

export const register: Register = (on, options) => {
  const isEnabled = options.enabled === true
  const model = typeof options.model === 'string' && options.model !== '' ? options.model : 'claude-haiku-5-5'
  const timeoutMs = clampTimeout(options.timeoutMs)

  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed at an idle prompt: never a command, a hidden prompt,
    // a prompt typed over a running turn, or one a plugin sent (this one's "send as is" included).
    if (!isEnabled || e.origin.kind !== 'composer' || e.command !== undefined || e.isMeta || e.turnId !== undefined || e.wait) {
      return next(e)
    }

    // A new prompt from the person replaces whatever was held.
    if ((await read($, held)) !== null) await update($, held, () => null)

    if (!isJudgeable(e.text) || (await read($, judged)).includes(e.text)) return next(e)
    await update($, judged, list => remember(list, e.text))

    const reply = await $.model.complete(
      { model, system: SYSTEM, prompt: promptFor(e.text), maxTokens: 300, effort: 'low', timeoutMs },
      { signal: next.signal },
    )
    const verdict = reply.isAnswered ? parseVerdict(reply.text) : undefined
    if (verdict === undefined || !verdict.isAmbiguous) return next(e)

    await update($, held, () => heldFrom(e.text, verdict))
    return { drop: DROP_REASON }
  }).catch(($, e, next) => next(e)) // Fail open: a coach never loses a prompt.

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const prompt = await read($, held)
    if (e.props.hasSurvey || prompt === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const sendAsIs = async () => {
      const text = await release($)
      if (text !== undefined) await $.prompt.submit({ text, asUser: true })
    }
    const addCondition = async () => {
      const text = await release($)
      if (text !== undefined) await $.prompt.fill({ text: `${text}\n完了条件: `, mode: 'replace' })
    }
    const dismiss = async () => {
      const text = await release($)
      if (text !== undefined) await $.prompt.fill({ text, mode: 'replace' })
    }

    const mine = (
      <Box key="prompt-coach" flexDirection="column">
        <Text color="yellow">⚠ 送信を保留しました。足りない点: {prompt.missing.join(' / ')}</Text>
        {prompt.rewrite !== undefined && <Text dimColor>案: {prompt.rewrite}</Text>}
        <Box flexDirection="row" gap={2}>
          <Button key="send" hotkey="1" plain onPress={sendAsIs}>
            このまま送る
          </Button>
          <Button key="add" hotkey="2" plain onPress={addCondition}>
            補足して送る
          </Button>
          <Button key="dismiss" hotkey="x" plain dimColor role="dismiss" onPress={dismiss}>
            閉じる
          </Button>
        </Box>
      </Box>
    )

    // Stack this row above what the plugins beneath and the engine draw, rather than in its place.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })
}
