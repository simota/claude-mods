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

/** One per guess, in order: letters (a bare digit fires on an empty box), none taken by s/e/q. */
export const OPTION_HOTKEYS = ['a', 'b', 'd'] as const

const DROP_REASON = 'prompt-coach: 依頼が曖昧なため送信を保留しました（入力欄の上の案内を参照）'

/**
 * Takes the held prompt down and hands it back, taken inside the write: of two takers at once
 * (two presses, a press and a new prompt), only one gets it.
 */
const take = async ($: EngineInterface): Promise<PromptCoachHeld | null> => {
  let taken: PromptCoachHeld | null = null
  await update($, held, prompt => {
    taken = prompt
    return null
  })
  // Assigned inside the callback, which narrowing does not follow.
  return taken as PromptCoachHeld | null
}

/** Holds a taken prompt again, unless another has been held since: then its words are only shown. */
const holdAgain = async ($: EngineInterface, prompt: PromptCoachHeld): Promise<void> => {
  let isHeld = false
  await update($, held, now => {
    isHeld = now === null
    return now ?? prompt
  })
  $.ui.toast(
    isHeld
      ? `prompt-coach: 入力欄へ戻せませんでした。保留中の依頼: ${prompt.text}`
      : `prompt-coach: 入力欄へ戻せなかった依頼（送信されていません）: ${prompt.text}`,
  )
}

/**
 * Puts words back in the box: into it as they are when it reads empty, else after the draft typed
 * since, on a line of their own, so they never land in the middle of it. A box that cannot be read
 * reads empty: the words are then inserted, never written over what may be there.
 */
const putBack = async ($: EngineInterface, text: string): Promise<boolean> => {
  const draft = (await $.prompt.read().catch(() => undefined))?.text ?? ''
  if (draft.trim() === '') return (await $.prompt.fill({ text, mode: 'insert' })).isFilled
  return (await $.prompt.fill({ text: `${draft.replace(/\s+$/, '')}\n${text}`, mode: 'replace' })).isFilled
}

const UNSENT_KEY = 'unsent'

/**
 * Hands the held prompt to `act` (send it, or put words in the box). The hold emptied the box, so
 * the held text is the only copy: when `act` throws, is dropped beneath, or the box could not be
 * filled, it is held again, band and all, and its words are shown, so the person never loses what
 * they typed.
 */
const handOver = async ($: EngineInterface, act: (text: string) => Promise<boolean>): Promise<void> => {
  const prompt = await take($)
  if (prompt === null) return
  const isDone = await act(prompt.text).catch(() => false)
  if (!isDone) await holdAgain($, prompt)
}

export const register: Register = (on, options) => {
  const isEnabled = options.enabled !== false
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
    const taken = await take($)
    if (taken !== null) {
      let ran: Awaited<ReturnType<typeof next>>
      try {
        ran = await next(e)
      } catch (err) {
        // The new prompt did not go: the held one stays held.
        await update($, held, now => now ?? taken)
        throw err
      }
      const before = taken.text
      if (shouldRestore(e.text, before)) {
        // The prompt has entered: nothing here may throw into the .catch below, and the held words are shown if they cannot go back.
        const isFilled = await putBack($, before).catch(() => false)
        if (!isFilled) await $.ui.toast(`保留していた依頼: ${before}`)
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

  // A prompt still held when the session ends (quit, /clear) is kept, and the next session start
  // puts it back in the box: a toast at the end of a quit would never be seen.
  on('session.end', async ($, e, next) => {
    const prompt = await take($).catch(() => null)
    if (prompt !== null) {
      await $.store.set(UNSENT_KEY, prompt.text).catch(() => undefined)
      $.ui.toast(`prompt-coach: 保留していた依頼（送信されていません）: ${prompt.text}`)
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      const unsent = await $.store.get(UNSENT_KEY)
      if (typeof unsent === 'string' && unsent !== '') {
        await $.store.delete(UNSENT_KEY)
        const isFilled = await putBack($, unsent).catch(() => false)
        $.ui.toast(isFilled ? 'prompt-coach: 前回送信されなかった依頼を入力欄に戻しました' : `prompt-coach: 前回送信されなかった依頼: ${unsent}`)
      }
    } catch {
      // No store: nothing kept to bring back.
    }
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const prompt = await read($, held)
    if (e.props.hasSurvey || prompt === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    // Sent only when it entered: a hook beneath that drops the resend leaves it held.
    const sendAsIs = () => handOver($, async text => (await $.prompt.submit({ text, asUser: true })).drop === undefined)
    const addCondition = () =>
      handOver($, async text => {
        // What comes back completed is the person's answer to the coach: never held again.
        await update($, followUps, list => remember(list, text))
        return putBack($, `${text}${FOLLOW_UP}`)
      })
    // A guess goes into the box to edit and send, and is not held again once sent.
    const choose = (option: string) => () =>
      handOver($, async () => {
        await update($, followUps, list => remember(list, option))
        return putBack($, option)
      })
    const dismiss = () => handOver($, text => putBack($, text))

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
              box is empty right after the hold. */}
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
