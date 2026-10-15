import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TrustSource } from '../types'
import { KIND_LABEL, labelOf, signalsOf, sourceOf } from './trust'

const PANE = 'trust-label'
const TITLE = '外部由来の内容'
const KEEP = 100

const sources = atom({ plugin: 'trust-label', key: 'sources' } as const, [] as TrustSource[])

function statusOf(list: readonly TrustSource[]): string | undefined {
  if (list.length === 0) return undefined
  const flagged = list.filter(one => one.signals.length > 0).length
  return `🏷 外部 ${list.length}${flagged > 0 ? ` · ⚠ ${flagged}` : ''}`
}

async function rootOf($: EngineInterface): Promise<string> {
  return (await $.session.repo())?.root ?? (await $.session.cwd())
}

export const register: Register = (on, options) => {
  const labelAll = options.labelAll !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'trust', description: 'このセッションで読み込んだ外部由来の内容（Web・issue・ログ・外部サービス）と、不審な指示の候補を一覧' })
    const started = await next(e)
    $.ui.status(statusOf(await read($, sources)))
    return started
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const source = sourceOf(tool, input, await rootOf($))
    if (source === undefined) return next(e)

    const ran = await next(e)
    // A failed call's output reaches Claude too (a fetch that exited non-zero still printed the page).
    if (ran.deny !== undefined) return ran
    const signals = signalsOf(ran.text ?? '')
    const entry: TrustSource = { id: e.tool_use_id ?? String(await $.clock.now()), at: await $.clock.now(), kind: source.kind, origin: source.origin, tool, signals }
    const list = await update($, sources, all => [...all, entry].slice(-KEEP))
    $.ui.status(statusOf(list))
    if (signals.length > 0) $.ui.toast(`🏷 ⚠ ${KIND_LABEL[source.kind]}に不審な指示の候補: ${signals.map(one => one.rule).join('・')}`)
    if (!labelAll && signals.length === 0) return ran
    return { ...ran, context: [...(ran.context ?? []), labelOf(source.kind, source.origin, signals)] }
  }).catch(($, e, next) => next(e)) // a labeller: a failure here leaves the result unlabelled, never withheld

  on('command.run', { command: 'trust' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    const list = await read($, sources)
    if (list.length === 0) return { text: '🏷 このセッションで読み込んだ外部由来の内容はまだありません。' }
    const flagged = list.filter(one => one.signals.length > 0)
    return {
      text: [
        `🏷 外部由来 ${list.length}件、不審な指示の候補を含むもの ${flagged.length}件（自動検出で、安全の判定ではありません）`,
        ...flagged.slice(-10).flatMap(one => [`- [${KIND_LABEL[one.kind]}] ${one.origin}`, ...one.signals.map(s => `    ⚠ ${s.rule}: ${s.excerpt}`)]),
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = [...(await read($, sources))].reverse()
    if (list.length === 0) return <Text dimColor>外部由来の内容はまだありません。</Text>
    const room = Math.max(3, (e.props.scroll.bodyRows ?? 24) - 2)
    const rows = list.flatMap(one => [
      { key: one.id, text: `${one.signals.length > 0 ? '⚠' : '·'} [${KIND_LABEL[one.kind]}] ${one.origin}`, color: one.signals.length > 0 ? 'yellow' : undefined, dim: one.signals.length === 0 },
      ...one.signals.map((s, i) => ({ key: `${one.id}-${i}`, text: `    ${s.rule}: ${s.excerpt}`, color: 'yellow', dim: false })),
    ])
    return (
      <Box flexDirection="column">
        <Text dimColor>候補は自動検出です。何も出ないことは安全の保証ではありません。</Text>
        {rows.slice(0, room).map(row => (
          <Text key={row.key} wrap="truncate-end" color={row.color} dimColor={row.dim}>
            {row.text}
          </Text>
        ))}
        {rows.length > room && <Text dimColor>{`…ほか ${rows.length - room} 行`}</Text>}
      </Box>
    )
  })
}
