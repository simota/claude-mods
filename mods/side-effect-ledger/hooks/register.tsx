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

// The store holds 4,194,304 characters of JSON in all, every repository's ledger together. Before
// each write the ledgers are held to MAX_LEDGERS and their JSON to BUDGET together, the current
// one cut to its newest entries past CURRENT_BUDGET, so a write is never refused for room.
const MAX_LEDGERS = 12
const BUDGET = 3_500_000
const CURRENT_BUDGET = 1_500_000
// What each ledger weighs, kept beside them so a write need not read every other ledger.
const INDEX_KEY = 'ledger-index'

type Meta = { size: number; at: number; isOpen: boolean }
const metaOf = (list: readonly LedgerEntry[]): Meta => ({
  size: JSON.stringify(list).length,
  at: Math.max(0, ...list.map(one => one.at)),
  // Open: an undo not yet looked at, of a call that did something (as the status line counts).
  isOpen: list.some(one => one.isOk && one.undoState === 'unchecked'),
})

/** The newest entries of a ledger whose JSON fits in `room` characters. */
function fitting(list: readonly LedgerEntry[], room: number): LedgerEntry[] {
  const kept: LedgerEntry[] = []
  let size = 2
  for (const one of list) {
    const next = JSON.stringify(one).length + 1
    if (size + next > room) break
    size += next
    kept.push(one)
  }
  return kept
}

/**
 * Makes room for `next` under `key`: other ledgers leave, those with nothing open first, each time
 * the one least recently written, until there are fewer than MAX_LEDGERS and all fit in BUDGET.
 * Answers `next`, cut to its newest entries when it alone would pass CURRENT_BUDGET.
 */
async function makeRoom($: EngineInterface, key: string, next: LedgerEntry[]): Promise<{ mine: LedgerEntry[]; index: Record<string, Meta> }> {
  const stored = (await $.store.get(INDEX_KEY)) as Record<string, Meta> | undefined
  const index: Record<string, Meta> = typeof stored === 'object' && stored !== null ? { ...stored } : {}
  const keys = ((await $.store.keys()) as string[]).filter(one => one.startsWith('ledger:') && one !== key)
  for (const name of Object.keys(index)) if (name === key || !keys.includes(name)) delete index[name]
  // A ledger the index does not know yet (an earlier version's, another session's): read once.
  for (const name of keys) if (index[name] === undefined) index[name] = metaOf(((await $.store.get(name)) as LedgerEntry[] | undefined) ?? [])
  const mine = JSON.stringify(next).length > CURRENT_BUDGET ? fitting(next, CURRENT_BUDGET) : next
  const order = Object.entries(index).sort(([, a], [, b]) => Number(a.isOpen) - Number(b.isOpen) || a.at - b.at)
  let total = JSON.stringify(mine).length + order.reduce((sum, [name, one]) => sum + one.size + name.length + 6, 0)
  let count = order.length
  for (const [name, one] of order) {
    if (count < MAX_LEDGERS && total <= BUDGET) break
    await $.store.delete(name)
    delete index[name]
    total -= one.size + name.length + 6
    count -= 1
  }
  return { mine, index: { ...index, [key]: metaOf(mine) } }
}

/** A store key is held to 256 characters: a longer path keeps its tail, told apart by a hash of the whole. */
function keyFor(root: string): string {
  const key = `ledger:${root}`
  if (key.length <= 256) return key
  let hash = 5381
  for (const ch of root) hash = ((hash * 33) ^ ch.charCodeAt(0)) >>> 0
  return `ledger:${hash.toString(36)}:…${root.slice(-200)}`
}

// A field as kept: control characters (colour codes) out, as they weigh up to six characters in
// JSON each, and held to `max`, so one entry stays small whatever a command printed.
const field = (text: string, max: number): string => {
  const plain = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

const storeKey = async ($: EngineInterface) => keyFor((await $.session.repo())?.root ?? (await $.session.cwd()))

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
    // The ledger first, then what it weighs: a write cut short leaves an index the next one mends.
    let room = await makeRoom($, key, fn(await get()).slice(0, KEEP))
    let next = room.mine
    // Refused for room, the index under-reported (a ledger another version grew): it is built
    // again from every ledger, room made by it, and the write tried once more.
    await $.store.set(key, next).catch(async () => {
      await $.store.delete(INDEX_KEY)
      room = await makeRoom($, key, next)
      next = room.mine
      await $.store.set(key, next)
    })
    const stored = await get()
    const again = fn(stored).slice(0, KEEP)
    if (JSON.stringify(again) !== JSON.stringify(stored)) {
      room = await makeRoom($, key, again)
      next = room.mine
      await $.store.set(key, next)
    }
    await $.store.set(INDEX_KEY, room.index)
    await update($, entries, () => next)
    return next
  })
}

// The status line holds only what needs a look: this session's succeeded calls whose undo is not
// easy and nobody has checked. An easy undo (a plain push) and the full count stay in /ledger.
const statusOf = (list: readonly LedgerEntry[], sessionId: string): string | undefined => {
  const open = list.filter(one => one.sessionId === sessionId && one.isOk && one.undoState === 'unchecked' && one.reversibility !== 'easy').length
  return open === 0 ? undefined : `📒 取消未確認 ${open}`
}

async function setState($: EngineInterface, id: string, undoState: LedgerEntry['undoState']): Promise<void> {
  const list = await write($, all => all.map(one => (one.id === id ? { ...one, undoState } : one)))
  $.ui.status(statusOf(list, await $.session.id()))
}

/**
 * The undo of a call that failed. What it names may be what was there before (a PR that already
 * existed, a release whose name was in use), so a failed call is given no command to undo it. A
 * push names only the refs it printed as moved. Infrastructure may have applied a part: it says
 * so, and to look before undoing anything.
 */
function failedUndo(one: Classified, isOk: boolean): string {
  if (isOk || one.kind === 'push') return one.undo
  if (one.kind === 'infra') return '失敗したが途中まで反映された可能性あり: 取り消す前に今の状態を確認（helm status / kubectl get / terraform plan など）'
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
      label: field(maskedOf(one.label), 200),
      undo: field(maskedOf(failedUndo(one, isOk)), 600),
      id: `${e.tool_use_id ?? at}:${i}`,
      at,
      source: field(source.replace(/\s+/g, ' '), 300),
      isOk,
      outcome: field(maskedOf(outcomeOf(text, isOk)), 160),
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
