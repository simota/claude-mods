import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Failure } from '../types'

const isPending = atom({ plugin: 'done-gate', key: 'isPending' } as const, false)
const hasEditedThisTurn = atom({ plugin: 'done-gate', key: 'hasEditedThisTurn' } as const, false)
const isFlagged = atom({ plugin: 'done-gate', key: 'isFlagged' } as const, false)
const failures = atom({ plugin: 'done-gate', key: 'failures' } as const, {} as Record<string, Failure>)
const nudged = atom({ plugin: 'done-gate', key: 'nudged' } as const, [] as string[])

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

const VERIFY =
  /\b(test|lint|typecheck|tsc|build|check|vitest|jest|pytest|xcodebuild|gradlew|pnpm|make)\b|\bcargo\s+(test|check|clippy|build)\b|\bgo\s+(test|vet|build)\b|\bswift\s+(build|test)\b|\b(bun|npm)\s+run\b/

// git commit/push/merge with --no-verify, or `git commit -n` (its short form).
const NO_VERIFY =
  /\bgit\b[^;&|\n]*\b(commit|push|merge)\b[^;&|\n]*\s--no-verify\b|\bgit\b[^;&|\n]*\bcommit\b[^;&|\n]*\s-n(\s|$)/

export const BAND_TEXT = '未検証の変更があります（テスト/lint/型チェック未実行）'

export const normalizeCommand = (command: string) => command.trim().replace(/\s+/g, ' ')

// Digits and whitespace vary between otherwise identical failures (times, pids, line counts).
export const errorTail = (text: string) =>
  text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(-300)

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) =>
    NO_VERIFY.test(e.command)
      ? {
          deny: `${$.plugin.name}: --no-verify はこの環境では禁止です。フックやチェックを通る形で根本原因を直してください。`,
        }
      : next(e),
  ).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: --no-verify ガードが失敗したため拒否しました。` },
  )

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, hasEditedThisTurn, () => false)
    }

    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, isPending, () => true)
      await update($, hasEditedThisTurn, () => true)
    }

    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) {
      return ran
    }

    if (VERIFY.test(e.command)) {
      await update($, isPending, () => false)
      await update($, isFlagged, () => false)
    }

    const command = normalizeCommand(e.command)
    if (ran.isError !== true) {
      await update($, failures, all => {
        const { [command]: _, ...rest } = all
        return rest
      })
      return ran
    }

    const tail = errorTail(ran.text ?? '')
    const all = await update($, failures, all => {
      const seen = all[command]
      const count = seen !== undefined && seen.tail === tail ? seen.count + 1 : 1
      return { ...all, [command]: { tail, count } }
    })
    const isRepeated = (all[command]?.count ?? 0) >= 2
    const done = await read($, nudged)

    if (isRepeated && !done.includes(command)) {
      await update($, nudged, list => [...list, command])
      await $.session.append({
        message: {
          type: 'user',
          content: [
            {
              type: 'text',
              text: `[${$.plugin.name}] 同じコマンドが同じエラーで2回失敗しました: \`${command.slice(0, 200)}\`。再試行やパラメータの微調整をやめ、エラー出力を読んで根本原因を診断してから次の手を決めてください。`,
            },
          ],
        },
        ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
      })
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (!(await read($, hasEditedThisTurn))) {
        await update($, isFlagged, () => false)
      } else if (await read($, isPending)) {
        await update($, isFlagged, () => true)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isFlagged))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="yellow">{BAND_TEXT} </Text>
        <Button key="dismiss" label="閉じる" role="dismiss" onPress={() => update($, isFlagged, () => false)} />
      </Box>
    )
  })
}
