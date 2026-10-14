import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ZukanEntry, ZukanPending } from '../types'
import { bookLines, contextOf, errorLine, fromStore, isCheck, keyOf, programOf, sight, step, toastOf, withFix, withNote } from './book'
import { exampleOf, maskedOf } from './mask'

const PANE = 'zukan'
const STORE_KEY = 'entries'

const entries = atom({ plugin: 'zukan', key: 'entries' } as const, [] as ZukanEntry[])
const pending = atom({ plugin: 'zukan', key: 'pending' } as const, {} as Record<string, ZukanPending>)

// $.store has no versioned write: this module's read-modify-writes run one after another,
// each reading the store afresh. Two sessions writing at once can still lose one sighting.
let queue: Promise<unknown> = Promise.resolve()

function mutate($: EngineInterface, change: (list: ZukanEntry[]) => ZukanEntry[]): Promise<ZukanEntry[]> {
  const run = queue.then(async () => {
    const list = change(fromStore(await $.store.get(STORE_KEY)))
    await $.store.set(STORE_KEY, list)
    await update($, entries, () => list)
    return list
  })
  queue = run.catch(() => undefined)
  return run
}

async function repoName($: EngineInterface): Promise<string> {
  const root = (await $.session.repo())?.root ?? (await $.session.cwd())
  return root.split('/').filter(Boolean).pop() ?? root
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'zukan',
      description: 'エラー図鑑を開く（note <番号> <メモ> で解決方法を書き込み、forget <番号> で消す）',
      argumentHint: '[note <No> <text> | forget <No>]',
    })
    const list = fromStore(await $.store.get(STORE_KEY))
    await update($, entries, () => list)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // Subagents' calls count too: an error is the machine's, whoever hit it.
    if (ran.deny !== undefined) return ran

    const program = programOf(e.command)
    const isFailure = ran.isError === true
    const aged = step(await read($, pending), program, !isFailure)
    await update($, pending, () => aged.pending)

    if (aged.fixed !== undefined) {
      const fixed = aged.fixed
      const fix = { command: exampleOf(e.command), isSandboxOff: e.dangerouslyDisableSandbox === true, repo: await repoName($), at: await $.clock.now() }
      await mutate($, list => withFix(list, fixed.key, fix))
    }

    if (!isFailure || isCheck(e.command)) return ran
    // The error line is kept and shown across sessions: credentials in it are masked first.
    const found = errorLine(ran.text ?? '')
    if (found === undefined) return ran
    const line = maskedOf(found)

    const key = keyOf(program, line)
    let landed: { entry: ZukanEntry; isNew: boolean } | undefined
    const sighting = { key, program, line, repo: await repoName($), at: await $.clock.now() }
    await mutate($, list => {
      const added = sight(list, sighting)
      landed = added
      return added.entries
    })
    await update($, pending, all => ({ ...all, [program]: { key, failed: exampleOf(e.command), calls: 0 } }))
    if (landed === undefined) return ran

    $.ui.toast(toastOf(landed.entry, landed.isNew))
    const note = contextOf(landed.entry)
    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'zukan' }, async ($, e) => {
    const [verb = '', number = '', ...rest] = e.args.trim().split(/\s+/)
    const no = Number(number)
    if (verb === 'note' || verb === 'forget') {
      const list = await read($, entries)
      if (!Number.isInteger(no) || !list.some(one => one.no === no)) return { text: `zukan: No.${number} は図鑑にありません。` }
      if (verb === 'forget') {
        await mutate($, all => all.filter(one => one.no !== no))
        return { text: `zukan: No.${no} を図鑑から消しました。` }
      }
      const text = rest.join(' ').trim()
      await mutate($, all => withNote(all, no, text === '' ? undefined : text))
      return { text: text === '' ? `zukan: No.${no} のメモを消しました。` : `zukan: No.${no} にメモを書きました。` }
    }
    await $.ui.open({ id: PANE, title: 'エラー図鑑' })
    return { text: 'エラー図鑑を開きました。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [head, ...rows] = bookLines(await read($, entries))
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)

    return (
      <Box flexDirection="column">
        <Text bold>{head}</Text>
        {rows.length === 0 && <Text dimColor>まだ何も捕まえていません。Bash のエラーが出ると、ここに並びます。</Text>}
        {rows.slice(0, room).map(row => (
          <Text dimColor={row.startsWith('📙')}>{row}</Text>
        ))}
        {rows.length > room && <Text dimColor>…ほか {rows.length - room} 種</Text>}
      </Box>
    )
  })
}
