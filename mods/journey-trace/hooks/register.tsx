import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Journey, JourneyStep, JourneyTarget } from '../types'
import { BROWSER_TOOL, markdownOf, maskedUrl, playwrightOf, refsOf, stepsOf, stepText } from './journey'

const PANE = 'journey-trace'
const TITLE = '操作の記録'
const EXPECT_TOOL = 'mcp__journey-trace__expect'
const KEEP_STEPS = 200
const KEEP_REFS = 500

const fresh = (name: string, at: number): Journey => ({ name, startedAt: at, isRecording: true, steps: [] })

const journey = atom({ plugin: 'journey-trace', key: 'journey' } as const, fresh('ブラウザ操作の記録', 0))
const refs = atom({ plugin: 'journey-trace', key: 'refs' } as const, {} as Record<string, { role?: string; name?: string }>)
const url = atom({ plugin: 'journey-trace', key: 'url' } as const, '')

async function expectStep($: EngineInterface, text: string, by: 'person' | 'claude'): Promise<void> {
  const at = await $.clock.now()
  const page = await read($, url)
  await update($, journey, j => ({ ...j, steps: [...j.steps, { kind: 'expect' as const, text, url: page, at, by }].slice(-KEEP_STEPS) }))
}

async function exportText($: EngineInterface, format: 'md' | 'e2e'): Promise<string> {
  const j = await read($, journey)
  return format === 'md' ? markdownOf(j, await $.clock.now()) : playwrightOf(j)
}

/**
 * The element text typed next goes into: the one last clicked or filled by name. Not known after
 * a Tab or an Enter (the focus moved), a new page, or a click by coordinates.
 */
function focusOf(steps: readonly JourneyStep[]): JourneyTarget | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const one = steps[i] as JourneyStep
    if (one.kind === 'goto') return undefined
    if (one.kind === 'key' && /tab|enter|return/i.test(one.key)) return undefined
    if (one.kind === 'click' || one.kind === 'fill') return one.target.name === undefined ? undefined : one.target
  }
  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'journey',
      description: 'ブラウザ操作を再現レシピに: 表示 · start [名前] · stop · resume · expect <期待> · md（バグ報告）· e2e（Playwright）· clear',
      argumentHint: '[start 名前 | stop | resume | expect 期待 | md | e2e | clear]',
    })
    await $.tool.register({
      name: 'expect',
      description:
        'Record the state the page is expected to be in at this point of the browser journey that journey-trace is recording (a line of a bug report\'s expected result, an assertion of the E2E draft). Call it after checking the page, with the visible text or state that should hold, e.g. "カートに 1 件と表示される".',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The expected visible state, one short sentence' } }, required: ['text'] },
    })
    const started = await next(e)
    const j = await read($, journey)
    if (j.startedAt === 0) await update($, journey, () => fresh('ブラウザ操作の記録', 1))
    return started
  })

  on('tool.call', { tool: EXPECT_TOOL }, async ($, e) => {
    const text = String((e as unknown as { text?: unknown }).text ?? '').trim()
    if (text === '') return { result: { isRecorded: false }, text: 'text が空です。' }
    await expectStep($, text, 'claude')
    return { result: { isRecorded: true }, text: `期待状態を記録しました: ${text}` }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!BROWSER_TOOL.test(tool)) return next(e)
    const name = tool.replace(BROWSER_TOOL, '')
    const input = e as unknown as Record<string, unknown>
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const text = ran.text ?? ''

    if (name === 'find' || name === 'read_page') {
      const found = refsOf(text)
      if (Object.keys(found).length > 0) await update($, refs, all => Object.fromEntries(Object.entries({ ...all, ...found }).slice(-KEEP_REFS)))
    }
    if (name === 'navigate') {
      const shown = text.split('\n').slice(0, 3).map(line => line.match(/^URL: (https?:\/\/\S+)$/)?.[1]).find(Boolean)
      const to = typeof input.url === 'string' && /^https?:\/\//.test(input.url) ? input.url : undefined
      if (shown ?? to) await update($, url, () => maskedUrl((shown ?? to) as string))
    }
    if (name === 'resize_window' && typeof input.width === 'number' && typeof input.height === 'number') {
      const viewport = { width: input.width, height: input.height }
      await update($, journey, j => ({ ...j, viewport }))
    }

    const j = await read($, journey)
    if (!j.isRecording) return ran
    const at = await $.clock.now()
    const page = await read($, url)
    const steps = stepsOf(name, input, await read($, refs), page, at, focusOf(j.steps))
    if (steps.length > 0) await update($, journey, old => ({ ...old, steps: [...old.steps, ...steps].slice(-KEEP_STEPS) }))
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('command.run', { command: 'journey' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    switch (verb) {
      case 'start': {
        const at = await $.clock.now()
        const name = arg || `ブラウザ操作の記録 ${new Date(at).toLocaleString()}`
        await update($, journey, () => fresh(name, at))
        return { text: `⏺ 記録を始めました: ${name}` }
      }
      case 'stop':
        await update($, journey, j => ({ ...j, isRecording: false }))
        return { text: '⏸ 記録を止めました（/journey resume で再開）。' }
      case 'resume':
        await update($, journey, j => ({ ...j, isRecording: true }))
        return { text: '⏺ 記録を再開しました。' }
      case 'clear':
        await update($, journey, j => ({ ...j, steps: [] }))
        return { text: '記録を消しました。' }
      case 'expect':
        if (arg === '') return { text: '期待する状態を書いてください: /journey expect <文>' }
        await expectStep($, arg, 'person')
        return { text: `期待状態を記録しました: ${arg}` }
      case 'md':
      case 'e2e': {
        const text = await exportText($, verb)
        const copied = await $.ui.copy({ text }).catch(() => undefined)
        return { text: `${copied?.isCopied ? '（クリップボードにコピーしました）\n' : ''}${verb === 'e2e' ? '```ts\n' : ''}${text}${verb === 'e2e' ? '\n```' : ''}` }
      }
      default: {
        await $.ui.open({ id: PANE, title: TITLE })
        const j = await read($, journey)
        return { text: `${j.isRecording ? '⏺' : '⏸'} ${j.name}: ${j.steps.length}ステップ` }
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const j = await read($, journey)
    const room = Math.max(3, (e.props.scroll.bodyRows ?? 24) - 4)
    let n = 0
    const rows = j.steps.map(step => (step.kind === 'expect' ? { text: `   ✓ ${stepText(step)}`, isExpect: true } : { text: `${String(++n).padStart(2)}. ${stepText(step)}`, isExpect: false }))
    const copy = (format: 'md' | 'e2e', surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) => async () => {
      await $.ui.copy({ text: await exportText($, format), ...(surface === undefined ? {} : { surface }) })
      $.ui.toast(format === 'md' ? '📋 再現手順（Markdown）をコピーしました' : '📋 Playwright の下書きをコピーしました')
    }
    return (
      <Box flexDirection="column">
        <Text bold>{`${j.isRecording ? '⏺ 記録中' : '⏸ 停止中'} · ${j.name} · ${n}操作`}</Text>
        {rows.length === 0 && <Text dimColor>まだ操作はありません。Claude がブラウザを操作すると、ここに手順が並びます。</Text>}
        {rows.slice(-room).map((row, index) => (
          <Text key={`s-${index}`} wrap="truncate-end" color={row.isExpect ? 'green' : undefined}>
            {row.text}
          </Text>
        ))}
        <Box>
          <Button key="md" label="再現手順をコピー" onPress={press => copy('md', press.surface)()} />
          <Button key="e2e" label="Playwright をコピー" onPress={press => copy('e2e', press.surface)()} />
          <Button key="fill" label="プロンプトへ" onPress={async () => $.prompt.fill({ text: await exportText($, 'md'), mode: 'insert' })} />
        </Box>
      </Box>
    )
  })
}
