import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextDietStats } from '../types'
import { estimateTokens, filterListing, kindsOf, mentioned, patternsOf } from './profile'
import type { Kind, Rules } from './profile'

const mode = atom({ plugin: 'context-diet', key: 'mode' } as const, 'config')
const last = atom({ plugin: 'context-diet', key: 'last' } as const, null)

/** Subfolders read for markers below the root (an app's ios/ or android/), at most. */
const SUBDIRS = 40
const SKIPPED = new Set(['node_modules', 'build', 'dist', 'target', 'Pods', 'DerivedData'])

async function projectKinds($: EngineInterface): Promise<Kind[]> {
  const root = await $.session.root()
  const top = await $.fs.list(root)
  const names = top.map(entry => entry.name)
  const dirs = top
    .filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.') && !SKIPPED.has(entry.name))
    .slice(0, SUBDIRS)

  for (const dir of dirs) {
    const inner = await $.fs.list(`${root}/${dir.name}`).catch(() => [])
    names.push(...inner.map(entry => entry.name))
  }
  return kindsOf(names)
}

/** On when the session says so, or when it left the choice to the `enabled` option. */
async function isActive($: EngineInterface, configured: boolean): Promise<boolean> {
  const chosen = await read($, mode)
  return chosen === 'on' || (chosen === 'config' && configured)
}

function summary(stats: ContextDietStats | null, isActive: boolean, engineTokens: number | undefined): string {
  const state = isActive ? 'ON' : 'OFF'
  if (stats === null) {
    return `context-diet: ${state}\nskill 一覧はまだ届いていません（次のリクエストで反映）。`
  }

  const saved = estimateTokens(stats.beforeChars - stats.afterChars)
  const engine = engineTokens === undefined ? '' : ` / engine の見積り 約 ${engineTokens} tokens`
  return [
    `context-diet: ${state}`,
    `プロジェクト種別: ${stats.kinds.length > 0 ? stats.kinds.join(', ') : '不明（共通ルールのみ）'}`,
    `残した skill: ${stats.kept.length} 件 / 省いた skill: ${stats.dropped.length} 件`,
    stats.dropped.length > 0 ? `省いた: ${stats.dropped.map(entry => entry.name).join(', ')}` : '省いた: なし',
    `削減: 約 ${saved} tokens（推定: 文字数÷4）${engine}`,
    '省いた skill も /名前 や名前の明記で使えます。',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const configured = options.enabled === true
  const keep = patternsOf(options.keep)
  const drop = patternsOf(options.drop)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-diet',
      description: 'skill 一覧の絞り込み状況と削減トークンを表示（on|off|reset で切替）',
      argumentHint: '[on|off|reset]',
    })
    return next(e)
  })

  // The skill listing reaches the model as this attachment; only its entries are filtered.
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    if (!(await isActive($, configured))) return next(e)

    const rules: Rules = { kinds: await projectKinds($), keep, drop }
    const filtered = filterListing(e.text, rules)
    if (filtered.dropped.length === 0) return next(e)

    await update($, last, () => ({
      kinds: [...rules.kinds],
      kept: filtered.kept,
      dropped: filtered.dropped,
      beforeChars: e.text.length,
      afterChars: filtered.text.length,
    }))
    return next({ ...e, text: filtered.text })
  }).catch(($, e, next) => next(e)) // The full listing is the safe answer.

  // A dropped skill the person names is described to the model beside that prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command !== undefined || !(await isActive($, configured))) return next(e)

    const named = mentioned(e.text, (await read($, last))?.dropped ?? [])
    if (named.length === 0) return next(e)

    const note = [
      'context-diet: 次の skill は一覧から省いていますが、利用できます。',
      ...named.map(entry => entry.text),
    ].join('\n')
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'context-diet' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'off' || arg === 'reset') {
      await update($, mode, () => (arg === 'reset' ? 'config' : arg))
      $.ui.invalidate('prompt.attachment')
      const now = (await isActive($, configured)) ? 'ON' : 'OFF'
      return { text: `context-diet: ${now}（次のリクエストで skill 一覧を組み直します。キャッシュが 1 回効きません）` }
    }

    const stats = await read($, last)
    const isOn = await isActive($, configured)
    let engineTokens: number | undefined
    if (stats !== null && stats.dropped.length > 0) {
      const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
      const listed = usage?.context.breakdown?.skills?.skillFrontmatter
      if (listed !== undefined) {
        const dropped = new Set(stats.dropped.map(entry => entry.name))
        engineTokens = listed.filter(skill => dropped.has(skill.name)).reduce((sum, skill) => sum + skill.tokens, 0)
      }
    }
    return { text: summary(stats, isOn, engineTokens) }
  })
}
