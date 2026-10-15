import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LensElement, LensReport, LensToken } from '../types'
import { check, cssTokens, jsonTokens, parseProbe, probeScript, PROPERTIES, resolveTokens } from './lens'

const PANE = 'token-lens'
const TITLE = 'トークン照合'
const BROWSER_TOOL = /^mcp__(?:remote-devices__)?claude-in-chrome__/
const JS_TOOL = 'mcp__claude-in-chrome__javascript_tool'
const MAX_FILES = 200

const tokens = atom({ plugin: 'token-lens', key: 'tokens' } as const, [] as LensToken[])
const report = atom({ plugin: 'token-lens', key: 'report' } as const, null as LensReport | null)
const tabId = atom({ plugin: 'token-lens', key: 'tabId' } as const, null as number | null)

async function git($: EngineInterface, root: string, argv: string[]): Promise<string | undefined> {
  const ran = await $.process.run(['git', ...argv], { cwd: root, timeoutMs: 15_000 }).catch(() => undefined)
  return ran?.exitCode === 0 ? ran.stdout : undefined
}

/** The repository's tokens: custom properties and SCSS variables of its stylesheets, and tokens JSON. */
async function loadTokens($: EngineInterface): Promise<LensToken[]> {
  const root = (await $.session.repo())?.root ?? (await $.session.cwd())
  const listed = await git($, root, ['ls-files', '--', '*.css', '*.scss', '*.sass', '*.less', '*tokens*.json', '*.tokens'])
  const files = (listed ?? '').split('\n').filter(path => path !== '' && !path.includes('node_modules/') && !/\.min\.css$/.test(path)).slice(0, MAX_FILES)
  const raw: { name: string; value: string; source: string }[] = []
  for (const path of files) {
    const text = await $.fs.read(`${root}/${path}`).then(String).catch(() => undefined)
    if (text === undefined || text.length > 2_000_000) continue
    if (path.endsWith('.json') || path.endsWith('.tokens')) {
      try {
        raw.push(...jsonTokens(JSON.parse(text), path))
      } catch {
        // Not JSON after all: nothing to read from it.
      }
    } else raw.push(...cssTokens(text, path))
  }
  const list = resolveTokens(raw)
  await update($, tokens, () => list)
  return list
}

function elementsOf(probe: NonNullable<ReturnType<typeof parseProbe>>, list: readonly LensToken[]): LensElement[] {
  return probe.elements.map(el => ({
    label: `${el.label}${el.text ? ` 「${el.text}」` : ''}`,
    checks: PROPERTIES.map(property => check(property, el.style[property] ?? '', list)).filter(one => one.status !== 'skip'),
  }))
}

const offCount = (r: LensReport) => r.elements.reduce((n, el) => n + el.checks.filter(c => c.status === 'off').length, 0)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-lens',
      description: 'ブラウザの要素の色・余白・字体を登録済みデザイントークンと照合（/token-lens <セレクタ> · 引数なしでページ上の選択範囲 · tokens · reload）',
      argumentHint: '[セレクタ | tokens | reload]',
    })
    return next(e)
  })

  // The tab Claude drives: a probe goes to the same one.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const id = (e as unknown as { tabId?: unknown }).tabId
    if (BROWSER_TOOL.test(String(e.tool)) && typeof id === 'number' && ran.deny === undefined) await update($, tabId, () => id)
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'token-lens' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'reload' || args === 'tokens') {
      const list = args === 'reload' || (await read($, tokens)).length === 0 ? await loadTokens($) : await read($, tokens)
      const by = (kind: string) => list.filter(t => t.kind === kind).length
      return { text: `🎨 トークン ${list.length}件（色 ${by('color')} · 長さ ${by('length')} · 字体 ${by('font')}）${list.length === 0 ? ' — CSS 変数・SCSS 変数・tokens JSON が見つかりません' : ''}` }
    }
    const list = (await read($, tokens)).length > 0 ? await read($, tokens) : await loadTokens($)
    const tab = await read($, tabId)
    const at = await $.clock.now()
    await $.ui.open({ id: PANE, title: TITLE })
    if (tab === null) {
      await update($, report, () => ({ at, query: args, elements: [], note: 'Claude in Chrome で操作中のタブがありません。先に Claude にページを開かせてください。' }))
      return { text: '🎨 照合するタブがありません（Claude in Chrome でページを開いてから実行してください）。' }
    }
    const ran = await $.tool.call({ tool: JS_TOOL, action: 'javascript_exec', text: probeScript(args), tabId: tab } as never).catch(err => ({ deny: String(err) }))
    if (ran.deny !== undefined || ran.isError === true) {
      const why = ran.deny ?? ran.text ?? ''
      await update($, report, () => ({ at, query: args, elements: [], note: `ページのスタイルを読めませんでした: ${why.slice(0, 200)}` }))
      return { text: '🎨 ページのスタイルを読めませんでした。' }
    }
    const probe = parseProbe(ran.text ?? '')
    if (probe === undefined || probe.elements.length === 0) {
      const note = args === '' ? 'ページ上でテキストを選択してから実行するか、セレクタを指定してください。' : `「${args}」に合う要素がありません。`
      await update($, report, () => ({ at, query: args, elements: [], note }))
      return { text: `🎨 ${note}` }
    }
    const result: LensReport = { at, query: args, ...(probe.url === undefined ? {} : { url: probe.url }), elements: elementsOf(probe, list), ...(list.length === 0 ? { note: 'トークンが見つからないため、すべて独自値として出ます（/token-lens tokens）。' } : {}) }
    await update($, report, () => result)
    const lines = result.elements.flatMap(el => [
      `${el.label}`,
      ...el.checks.filter(c => c.status === 'off').map(c => `  ✗ ${c.property}: ${c.value}${c.nearest ? `（最寄り ${c.nearest.name} = ${c.nearest.value}、差 ${c.nearest.distance}）` : ''}`),
    ])
    return { text: [`🎨 ${result.elements.length}要素 · 独自値 ${offCount(result)}件`, ...lines].join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const shown = await read($, report)
    if (shown === null) return <Text dimColor>/token-lens &lt;セレクタ&gt; で要素をトークンと照合します。</Text>
    const room = Math.max(4, (e.props.scroll.bodyRows ?? 24) - 3)
    const rows = shown.elements.flatMap(el => [
      { key: `h-${el.label}`, text: el.label, color: undefined as string | undefined, bold: true },
      ...el.checks.map(c => ({
        key: `${el.label}-${c.property}`,
        text: c.status === 'token' ? `  ✓ ${c.property}: ${c.value} = ${c.tokens.slice(0, 2).join(', ')}` : `  ✗ ${c.property}: ${c.value}${c.nearest ? `  → 最寄り ${c.nearest.name} (${c.nearest.value}, 差 ${c.nearest.distance})` : ''}`,
        color: c.status === 'token' ? 'green' : 'yellow',
        bold: false,
      })),
    ])
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">{`🎨 ${shown.query || '選択範囲'}${shown.url ? ` · ${shown.url}` : ''} · 独自値 ${offCount(shown)}件`}</Text>
        {shown.note !== undefined && <Text color="yellow">{shown.note}</Text>}
        {rows.slice(0, room).map(row => (
          <Text key={row.key} wrap="truncate-end" color={row.color} bold={row.bold}>
            {row.text}
          </Text>
        ))}
        {rows.length > room && <Text dimColor>{`…ほか ${rows.length - room} 行`}</Text>}
      </Box>
    )
  })
}
