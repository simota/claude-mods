import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerEntry } from '../types'
import { classifyCommand, classifyTool, KIND_LABEL, outcomeOf, REVERSIBILITY_LABEL } from './ledger'
import type { Classified } from './ledger'
import { maskedOf } from './mask'

const PANE = 'side-effect-ledger'
const TITLE = '外部操作の台帳'
const KEEP = 300

const entries = atom({ plugin: 'side-effect-ledger', key: 'entries' } as const, [] as LedgerEntry[])

let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

const storeKey = async ($: EngineInterface) => `ledger:${(await $.session.repo())?.root ?? (await $.session.cwd())}`

/**
 * Changes the ledger in the store and in the session together, the store read first. The store
 * is shared with other sessions and has no versioned write: it is read back after the write, and
 * when another session's write has since replaced this one, the change is made again on top of
 * theirs (`fn` is idempotent), as loopback does.
 */
async function write($: EngineInterface, fn: (list: LedgerEntry[]) => LedgerEntry[]): Promise<LedgerEntry[]> {
  const key = await storeKey($)
  const get = async () => ((await $.store.get(key)) as LedgerEntry[] | undefined) ?? []
  return serial(async () => {
    let next = fn(await get()).slice(0, KEEP)
    await $.store.set(key, next)
    const stored = await get()
    const again = fn(stored).slice(0, KEEP)
    if (JSON.stringify(again) !== JSON.stringify(stored)) {
      next = again
      await $.store.set(key, next)
    }
    await update($, entries, () => next)
    return next
  })
}

const statusOf = (list: readonly LedgerEntry[], sessionId: string): string | undefined => {
  const mine = list.filter(one => one.sessionId === sessionId && one.isOk)
  if (mine.length === 0) return undefined
  const open = mine.filter(one => one.undoState === 'unchecked').length
  return `📒 ${mine.length}${open > 0 ? ` · 取消未確認 ${open}` : ''}`
}

async function setState($: EngineInterface, id: string, undoState: LedgerEntry['undoState']): Promise<void> {
  const list = await write($, all => all.map(one => (one.id === id ? { ...one, undoState } : one)))
  $.ui.status(statusOf(list, await $.session.id()))
}

/**
 * The undo of a call that failed. Its output may name what was there before (a PR that already
 * existed, in a chain too), so nothing is undone by default. A push names only the refs it printed
 * as moved. Infrastructure may have applied a part before failing: its undo stays, marked as such.
 */
function failedUndo(one: Classified, isOk: boolean): string {
  if (isOk || one.kind === 'push') return one.undo
  if (one.kind === 'infra') return `途中まで反映された可能性: ${one.undo}`
  return '失敗したため取り消すものはない（途中まで反映されていないかは確認）'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ledger', description: 'push・公開・デプロイ・外部 API 更新など Git 差分に出ない操作の台帳（結果と取り消し方法の確認状況）' })
    const started = await next(e)
    const list = ((await $.store.get(await storeKey($))) as LedgerEntry[] | undefined) ?? []
    await update($, entries, () => list)
    $.ui.status(statusOf(list, await $.session.id()))
    return started
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const text = ran.text ?? ''
    const found: Classified[] = tool === 'Bash' ? classifyCommand(String(input.command ?? ''), text) : [classifyTool(tool, input)].filter((one): one is Classified => one !== undefined)
    if (found.length === 0) return ran

    const at = await $.clock.now()
    const sessionId = await $.session.id()
    const isOk = ran.isError !== true
    // Kept across sessions and drawn in the pane: credentials are masked before anything is cut or kept.
    const source = maskedOf(tool === 'Bash' ? String(input.command ?? '') : `${tool} ${JSON.stringify(input)}`)
    const fresh: LedgerEntry[] = found.map((one, i) => ({
      ...one,
      label: maskedOf(one.label),
      undo: maskedOf(failedUndo(one, isOk)),
      id: `${e.tool_use_id ?? at}:${i}`,
      at,
      source: source.replace(/\s+/g, ' ').slice(0, 300),
      isOk,
      outcome: maskedOf(outcomeOf(text, isOk)),
      undoState: 'unchecked',
      sessionId,
    }))
    const ids = new Set(fresh.map(one => one.id))
    const list = await write($, old => [...[...fresh].reverse(), ...old.filter(one => !ids.has(one.id))])
    $.ui.status(statusOf(list, sessionId))
    const first = fresh[0] as LedgerEntry
    $.ui.toast(isOk ? `📒 ${first.label} — 取り消し: ${first.undo.slice(0, 80)}` : `📒 失敗を記録: ${first.label}`)
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('command.run', { command: 'ledger' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    const list = await read($, entries)
    if (list.length === 0) return { text: '📒 このリポジトリの外部操作はまだ記録されていません。' }
    const open = list.filter(one => one.isOk && one.undoState === 'unchecked')
    return {
      text: [
        `📒 記録 ${list.length}件（取り消し方法が未確認 ${open.length}件）`,
        ...list.slice(0, 10).map(one => `- ${new Date(one.at).toLocaleString()} ${one.isOk ? '✓' : '✗'} ${one.label}\n    取り消し（${REVERSIBILITY_LABEL[one.reversibility]}）: ${one.undo}`),
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, entries)
    if (list.length === 0) return <Text dimColor>まだ記録はありません。</Text>
    const room = Math.max(1, Math.floor(((e.props.scroll.bodyRows ?? 24) - 1) / 4))
    const mark = { unchecked: '□ 取消未確認', confirmed: '☑ 取消確認済み', waived: '– 確認不要' } as const
    return (
      <Box flexDirection="column">
        {list.slice(0, room).map(one => (
          <Box key={one.id} flexDirection="column" marginBottom={1}>
            <Text bold wrap="truncate-end" color={one.isOk ? undefined : 'red'}>
              {`${one.isOk ? '✓' : '✗'} [${KIND_LABEL[one.kind]}] ${one.label}`}
            </Text>
            <Text dimColor wrap="truncate-end">{`  ${new Date(one.at).toLocaleString()} · ${one.outcome}`}</Text>
            <Text wrap="truncate-end" color={one.reversibility === 'hard' ? 'yellow' : undefined}>{`  ↩ ${REVERSIBILITY_LABEL[one.reversibility]}: ${one.undo}`}</Text>
            {one.isOk && (
              <Box>
                <Text color={one.undoState === 'unchecked' ? 'yellow' : 'green'}>{`  ${mark[one.undoState]} `}</Text>
                {one.undoState !== 'confirmed' && <Button key={`ok:${one.id}`} plain label="[確認済みにする] " onPress={() => setState($, one.id, 'confirmed')} />}
                {one.undoState === 'unchecked' && <Button key={`skip:${one.id}`} plain label="[不要] " onPress={() => setState($, one.id, 'waived')} />}
                {one.undoState !== 'unchecked' && <Button key={`undo:${one.id}`} plain label="[未確認に戻す]" onPress={() => setState($, one.id, 'unchecked')} />}
              </Box>
            )}
          </Box>
        ))}
        {list.length > room && <Text dimColor>{`…ほか ${list.length - room} 件`}</Text>}
      </Box>
    )
  })
}
