import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NegativeTrigger, TestDigest } from '../types'
import { candidatesOf, digestOf, isTestPath, KIND_LABEL, keyOf, requestOf, summaryOf, triggersOf, withTest } from './space'

const triggers = atom({ plugin: 'negative-space', key: 'triggers' } as const, [] as NegativeTrigger[])
const tests = atom({ plugin: 'negative-space', key: 'tests' } as const, {} as Record<string, TestDigest>)
const dismissed = atom({ plugin: 'negative-space', key: 'dismissed' } as const, [] as string[])
const isShown = atom({ plugin: 'negative-space', key: 'isShown' } as const, false)

const KEEP = 200

type Edit = { path: string; before: string; after: string }

function editsOf(tool: string, input: Record<string, unknown>, written: string | undefined): Edit[] {
  const path = typeof input.file_path === 'string' ? input.file_path : undefined
  if (path === undefined) return []
  if (tool === 'Edit') return [{ path, before: String(input.old_string ?? ''), after: String(input.new_string ?? '') }]
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).map(one => ({ path, before: String(one.old_string ?? ''), after: String(one.new_string ?? '') }))
  }
  if (tool === 'Write') return [{ path, before: written ?? '', after: String(input.content ?? '') }]
  return []
}

// Counted again only when a trigger, a test or a dismissal changed: the band reads it at every draw.
const candidates = derive([triggers, tests, dismissed], candidatesOf)
const open = ($: EngineInterface) => read($, candidates)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'negative-space', description: '認可・入力検証・エラー処理の追加に対し、拒否ケースや境界値のテスト不足候補を一覧' })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return next(e)
    const input = e as unknown as Record<string, unknown>
    const path = typeof input.file_path === 'string' ? input.file_path : undefined
    if (path === undefined) return next(e)
    // The whole file before and after, so a trigger knows the function it sits in.
    const before = await $.fs.read(path).then(String).catch(() => undefined)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const after = await $.fs.read(path).then(String).catch(() => undefined)
    const at = await $.clock.now()
    for (const one of after !== undefined ? [{ path, before: before ?? '', after }] : editsOf(tool, input, before)) {
      if (isTestPath(one.path)) {
        // What the test says now: the file as it stands, or an Edit's new text added to what was seen.
        const known = await read($, triggers)
        const isWhole = after !== undefined || tool === 'Write'
        await update($, tests, all => withTest(all, one.path, digestOf(one.after), isWhole, known))
        continue
      }
      const found = triggersOf(one.path, one.before, one.after, at)
      if (found.length === 0) continue
      await update($, triggers, list => {
        const fresh = found.filter(f => !list.some(old => keyOf(old) === keyOf(f)))
        return [...list, ...fresh].slice(-KEEP)
      })
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  // A test Claude reads counts too: what it already covers is not asked for again.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && isTestPath(e.file_path)) {
      // A read of the whole file says what it is now; one of a part adds to what was seen.
      const isWhole = e.offset === undefined && e.limit === undefined
      const known = await read($, triggers)
      const digest = digestOf(ran.text ?? '')
      await update($, tests, all => withTest(all, e.file_path, digest, isWhole, known))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && (await open($)).length > 0) await update($, isShown, () => true)
    return next(e)
  })

  on('command.run', { command: 'negative-space' }, async $ => {
    const list = await open($)
    const all = await read($, triggers)
    if (all.length === 0) return { text: '🕳 このセッションの編集に、認可・入力検証・エラー処理の追加は見つかっていません。' }
    if (list.length === 0) return { text: `🕳 契機 ${all.length}件。テスト不足の候補はありません（このセッションで触れたテストが拒否・境界の場合に触れています）。` }
    return {
      text: [
        `🕳 テスト不足の候補 ${list.length}件（契機 ${all.length}件・自動推定のため見当違いもあります）`,
        ...list.map(one => `- ${one.path}: ${KIND_LABEL[one.kind]} — ${one.ask}\n    契機: ${one.line}`),
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isShown))) return next(e)
    const list = await open($)
    if (list.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="magenta" wrap="truncate-end">{`🕳 拒否/境界のテスト不足候補 ${list.length}件: ${summaryOf(list)} `}</Text>
          <Button key="ask" label="Claude に頼む" onPress={() => $.prompt.fill({ text: requestOf(list), mode: 'insert' })} />
          <Button
            key="dismiss"
            label="不要"
            role="dismiss"
            onPress={async () => {
              // What was drawn and is still open: one closed since is not dismissed, one come since not unseen.
              const still = new Set((await open($)).map(one => one.key))
              const drawn = list.map(one => one.key).filter(key => still.has(key))
              await update($, dismissed, keys => [...new Set([...keys, ...drawn])])
              await update($, isShown, () => false)
            }}
          />
        </Box>
        {below}
      </Box>
    )
  })
}
