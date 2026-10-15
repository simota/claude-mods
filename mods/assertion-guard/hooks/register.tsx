import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GuardEntry } from '../types'
import { contextOf, describe, inspect, summaryOf } from './guard'

const entries = atom({ plugin: 'assertion-guard', key: 'entries' } as const, [] as GuardEntry[])

const KEEP = 50

type Edit = { path: string; before: string; after: string }

/** The text an edit replaces and the text it leaves, as the call states it: the fallback when the file cannot be read. */
function fragmentsOf(tool: string, input: Record<string, unknown>, path: string): Edit[] {
  if (tool === 'Edit') return [{ path, before: String(input.old_string ?? ''), after: String(input.new_string ?? '') }]
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).map(one => ({ path, before: String(one.old_string ?? ''), after: String(one.new_string ?? '') }))
  }
  return []
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'assertion-guard', description: 'テストを弱めた可能性のある編集（assertion 削除・期待値の緩和・スキップ・例外の握りつぶし）を一覧' })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return next(e)
    const input = e as unknown as Record<string, unknown>
    const path = typeof input.file_path === 'string' ? input.file_path : undefined
    if (path === undefined) return next(e)
    // The whole file before and after: an assertion moved within it is no removal, and a
    // Rust test module is seen wherever in the file the edit lands.
    const before = await $.fs.read(path).then(String).catch(() => undefined)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    // A file that was not there has nothing to weaken.
    if (before === undefined) return ran
    const after = await $.fs.read(path).then(String).catch(() => undefined)
    const edits = after !== undefined ? [{ path, before, after }] : fragmentsOf(tool, input, path)
    const findings = edits.flatMap(one => inspect(one.path, one.before, one.after))
    if (findings.length === 0) return ran
    const entry: GuardEntry = { id: e.tool_use_id ?? String(await $.clock.now()), at: await $.clock.now(), path, findings, isReviewed: false }
    await update($, entries, list => [...list, entry].slice(-KEEP))
    $.ui.toast(`🛡 テストを弱めた可能性: ${path.split('/').pop()} — ${summaryOf(findings)}`)
    return { ...ran, context: [...(ran.context ?? []), contextOf(path, findings)] }
  }).catch(($, e, next) => next(e)) // an observer: a failure here leaves the call as it was

  on('command.run', { command: 'assertion-guard' }, async $ => {
    const list = await read($, entries)
    if (list.length === 0) return { text: '🛡 このセッションでテストを弱めた可能性のある編集はありません。' }
    const lines = list.flatMap(one => [
      `${one.isReviewed ? '✓' : '•'} ${new Date(one.at).toLocaleTimeString()} ${one.path}`,
      ...one.findings.map(finding => `    ${describe(finding)}`),
    ])
    await update($, entries, all => all.map(one => ({ ...one, isReviewed: true })))
    return { text: [`🛡 テストを弱めた可能性のある編集 ${list.length}件（一覧を出したので確認済みにしました）`, ...lines].join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const open = (await read($, entries)).filter(one => !one.isReviewed)
    if (e.props.hasSurvey || open.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const latest = open[open.length - 1] as GuardEntry
    const files = [...new Set(open.map(one => one.path.split('/').pop()))].join(', ')
    const ask = [
      `テストを弱めた可能性がある変更について、それぞれの理由を説明してください（/assertion-guard で一覧）:`,
      ...open.flatMap(one => one.findings.map(finding => `- ${one.path}: ${describe(finding)}`)),
    ].join('\n')

    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow" wrap="truncate-end">{`🛡 テストを弱めた可能性 ${open.length}件 (${files}) — ${summaryOf(latest.findings)} `}</Text>
          <Button key="ask" label="理由を尋ねる" onPress={() => $.prompt.fill({ text: ask, mode: 'insert' })} />
          <Button key="ok" label="確認済み" role="dismiss" onPress={() => update($, entries, all => all.map(one => ({ ...one, isReviewed: true })))} />
        </Box>
        {below}
      </Box>
    )
  })
}
