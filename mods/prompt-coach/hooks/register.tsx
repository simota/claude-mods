import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PromptCoachHeld } from '../types'
import {
  FOLLOW_UP,
  SYSTEM,
  carriesMore,
  clampTimeout,
  heldFrom,
  isFollowUp,
  isJudgeable,
  parseVerdict,
  promptFor,
  remember,
  shouldRestore,
} from './judge'

const held = atom({ plugin: 'prompt-coach', key: 'held' } as const, null as PromptCoachHeld | null)
const judged = atom({ plugin: 'prompt-coach', key: 'judged' } as const, [] as string[])
const followUps = atom({ plugin: 'prompt-coach', key: 'followUps' } as const, [] as string[])

export const DEFAULT_MODEL = 'claude-haiku-5-5'

/** One per guess, in order: letters (a bare digit fires on an empty box), none taken by s/e/q or quick-actions. */
export const OPTION_HOTKEYS = ['a', 'b', 'd'] as const

const DROP_REASON = 'prompt-coach: 依頼が曖昧なため送信を保留しました（入力欄の上の案内を参照）'

/** Takes the held prompt down and hands back its text. */
const release = async ($: EngineInterface): Promise<string | undefined> => {
  const prompt = await read($, held)
  await update($, held, () => null)
  return prompt?.text
}

export const register: Register = (on, options) => {
  const isEnabled = options.enabled === true
  const model = typeof options.model === 'string' && options.model !== '' ? options.model : DEFAULT_MODEL
  const timeoutMs = clampTimeout(options.timeoutMs)

  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed at an idle prompt: never a command, a hidden prompt,
    // a prompt typed over a running turn, or one a plugin sent (this one's "send as is" included).
    if (!isEnabled || e.origin.kind !== 'composer' || e.command !== undefined || e.isMeta || e.turnId !== undefined || e.wait) {
      return next(e)
    }

    // A new prompt while one is held: send the new one, and put the held words back in
    // the box rather than drop them (the drop had emptied the box).
    // What was sent may be the held text itself, recalled from history: then nothing goes back.
    const before = await release($)
    if (before !== undefined) {
      const ran = await next(e)
      if (shouldRestore(e.text, before)) {
        const filled = await $.prompt.fill({ text: before, mode: 'insert' })
        if (!filled.isFilled) await $.ui.toast(`保留していた依頼: ${before}`)
      }
      return ran
    }

    // Pasted items and @mentions are expanded only for what the person typed; a resend
    // from here would lose them, so such a prompt is never held.
    if (carriesMore(e.text, e.attachments)) return next(e)
    if (isFollowUp(e.text, await read($, followUps))) return next(e)
    if (!isJudgeable(e.text) || (await read($, judged)).includes(e.text)) return next(e)
    await update($, judged, list => remember(list, e.text))

    const reply = await $.model.complete(
      { model, system: SYSTEM, prompt: promptFor(e.text), maxTokens: 600, effort: 'low', timeoutMs },
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
      if (text === undefined) return
      // What comes back completed is the person's answer to the coach: never held again.
      await update($, followUps, list => remember(list, text))
      await $.prompt.fill({ text: `${text}${FOLLOW_UP}`, mode: 'replace' })
    }
    // A guess goes into the box to edit and send, and is not held again once sent.
    const choose = (option: string) => async () => {
      if ((await release($)) === undefined) return
      await update($, followUps, list => remember(list, option))
      await $.prompt.fill({ text: option, mode: 'replace' })
    }
    const dismiss = async () => {
      const text = await release($)
      if (text !== undefined) await $.prompt.fill({ text, mode: 'replace' })
    }

    const mine = (
      <Box key="prompt-coach" flexDirection="column">
        <Text color="yellow">⚠ 送信を保留しました。足りない点: {prompt.missing.join(' / ')}</Text>
        {prompt.options.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>もしかして:</Text>
            {prompt.options.map((option, index) => (
              <Button key={`option-${index}`} hotkey={OPTION_HOTKEYS[index]} plain onPress={choose(option.prompt)}>
                {option.label}: {option.prompt}
              </Button>
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={2}>
          {/* Letters only: a bare digit in an empty box presses a band Button, and the
              box is empty right after the hold. None shared with quick-actions. */}
          <Button key="send" hotkey="s" plain onPress={sendAsIs}>
            このまま送る
          </Button>
          <Button key="add" hotkey="e" plain onPress={addCondition}>
            補足して送る
          </Button>
          <Button key="coach-dismiss" hotkey="q" plain dimColor role="dismiss" onPress={dismiss}>
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
