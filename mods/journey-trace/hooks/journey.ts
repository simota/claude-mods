// The journey, pure: browser calls read as steps, and steps written out as a bug report or a
// Playwright test.

import type { Journey, JourneyStep, JourneyTarget } from '../types'

export const BROWSER_TOOL = /^mcp__(?:remote-devices__)?(?:claude-in-chrome|Claude_Browser)__/

const ROLES = 'button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem|tab|switch|slider|heading|img|image|cell|row|listitem|dialog|textarea|input|select'
const REF_LINE = new RegExp(`\\b(ref_\\d+)\\b`)

/** Elements a find or read_page answer describes: each ref with the role and the quoted name on its line. */
export function refsOf(text: string): Record<string, { role?: string; name?: string }> {
  const out: Record<string, { role?: string; name?: string }> = {}
  for (const line of text.split('\n')) {
    const ref = line.match(REF_LINE)?.[1]
    if (ref === undefined) continue
    const role = line.match(new RegExp(`\\b(${ROLES})\\b`, 'i'))?.[1]?.toLowerCase()
    const name = line.match(/"([^"]{1,80})"/)?.[1] ?? line.match(/'([^']{1,80})'/)?.[1]
    out[ref] = { ...(role === undefined ? {} : { role }), ...(name === undefined ? {} : { name }) }
  }
  return out
}

/** The steps one browser call makes, read from its input. */
export function stepsOf(tool: string, input: Record<string, unknown>, refs: Readonly<Record<string, { role?: string; name?: string }>>, url: string, at: number): JourneyStep[] {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  const target = (): JourneyTarget => {
    const ref = str('ref')
    const coordinate = Array.isArray(input.coordinate) ? (input.coordinate as unknown[]) : undefined
    const known = ref === undefined ? undefined : refs[ref]
    return {
      ...(ref === undefined ? {} : { ref }),
      ...(known ?? {}),
      ...(coordinate !== undefined && typeof coordinate[0] === 'number' && typeof coordinate[1] === 'number' ? { x: coordinate[0], y: coordinate[1] } : {}),
    }
  }
  if (tool === 'navigate') {
    const to = str('url')
    if (to === undefined) return []
    if (to === 'back' || to === 'forward') return [{ kind: 'key', key: to === 'back' ? 'Alt+ArrowLeft' : 'Alt+ArrowRight', url, at }]
    // Typed without a scheme, the address the browser landed on says which (`url`, from the
    // navigation's answer); failing that, a local host is http and anything else https.
    const isLocal = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.(?:localhost|local|test))(?::\d+)?(?:\/|$)/.test(to)
    const landed = /^https?:\/\//.test(url) && url.replace(/^https?:\/\//, '').startsWith(to.replace(/\/+$/, '')) ? url : undefined
    return [{ kind: 'goto', url: /^https?:\/\//.test(to) ? to : (landed ?? `${isLocal ? 'http' : 'https'}://${to}`), at }]
  }
  if (tool === 'form_input') return [{ kind: 'fill', target: target(), value: String(input.value ?? ''), url, at }]
  if (tool !== 'computer') return []
  switch (str('action')) {
    case 'left_click':
      return [{ kind: 'click', target: target(), button: 'left', url, at }]
    case 'right_click':
      return [{ kind: 'click', target: target(), button: 'right', url, at }]
    case 'double_click':
    case 'triple_click':
      return [{ kind: 'click', target: target(), button: 'double', url, at }]
    case 'type':
      return str('text') === undefined ? [] : [{ kind: 'type', text: str('text') as string, url, at }]
    case 'key':
      return str('text') === undefined ? [] : [{ kind: 'key', key: str('text') as string, url, at }]
    case 'scroll':
      return [{ kind: 'scroll', direction: str('scroll_direction') ?? 'down', url, at }]
    default:
      return []
  }
}

const describeTarget = (t: JourneyTarget): string => {
  const roleJa: Record<string, string> = { button: 'ボタン', link: 'リンク', textbox: '入力欄', searchbox: '検索欄', checkbox: 'チェックボックス', radio: 'ラジオボタン', combobox: '選択欄', tab: 'タブ', menuitem: 'メニュー項目', option: '選択肢' }
  if (t.name !== undefined) return `「${t.name}」${t.role === undefined ? '' : roleJa[t.role] ?? t.role}`
  if (t.ref !== undefined) return `要素 ${t.ref}`
  if (t.x !== undefined) return `画面座標 (${t.x}, ${t.y})`
  return '要素'
}

const KEY_JA: Record<string, string> = { Return: 'Enter', Enter: 'Enter', Tab: 'Tab', Escape: 'Esc' }

export function stepText(step: JourneyStep): string {
  switch (step.kind) {
    case 'goto':
      return `${step.url} を開く`
    case 'click':
      return `${describeTarget(step.target)}を${step.button === 'right' ? '右クリック' : step.button === 'double' ? 'ダブルクリック' : 'クリック'}`
    case 'type':
      return `「${step.text}」と入力`
    case 'key':
      return `${KEY_JA[step.key] ?? step.key} キーを押す`
    case 'fill':
      return `${describeTarget(step.target)}に「${step.value}」を入力`
    case 'scroll':
      return `${step.direction === 'up' ? '上' : step.direction === 'left' ? '左' : step.direction === 'right' ? '右' : '下'}へスクロール`
    case 'expect':
      return `期待: ${step.text}`
  }
}

/** The journey as a bug report's body. */
export function markdownOf(j: Journey, now: number): string {
  const actions = j.steps.filter(step => step.kind !== 'expect')
  const expects = j.steps.filter((step): step is Extract<JourneyStep, { kind: 'expect' }> => step.kind === 'expect')
  const first = j.steps.find((step): step is Extract<JourneyStep, { kind: 'goto' }> => step.kind === 'goto')
  return [
    `## ${j.name}`,
    '',
    '### 再現手順',
    ...(actions.length === 0 ? ['（記録された操作はありません）'] : actions.map((step, i) => `${i + 1}. ${stepText(step)}`)),
    '',
    '### 期待される結果',
    ...(expects.length === 0 ? ['- （記入してください）'] : expects.map(step => `- ${step.text}`)),
    '',
    '### 実際の結果',
    '- （記入してください）',
    '',
    '### 環境',
    `- URL: ${first?.url ?? '—'}`,
    ...(j.viewport === undefined ? [] : [`- 画面サイズ: ${j.viewport.width}×${j.viewport.height}`]),
    `- 記録日時: ${new Date(now).toLocaleString()}`,
  ].join('\n')
}

const q = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
const PW_ROLE: Record<string, string> = { textbox: 'textbox', input: 'textbox', textarea: 'textbox', searchbox: 'searchbox', button: 'button', link: 'link', checkbox: 'checkbox', radio: 'radio', combobox: 'combobox', select: 'combobox', tab: 'tab', menuitem: 'menuitem', option: 'option', heading: 'heading', img: 'img', image: 'img', switch: 'switch', slider: 'slider' }

function locator(t: JourneyTarget): string | undefined {
  if (t.name !== undefined && t.role !== undefined && PW_ROLE[t.role] !== undefined) return `page.getByRole(${q(PW_ROLE[t.role] as string)}, { name: ${q(t.name)} })`
  if (t.name !== undefined) return `page.getByText(${q(t.name)})`
  return undefined
}

const PW_KEY: Record<string, string> = { Return: 'Enter', enter: 'Enter', Escape: 'Escape', esc: 'Escape', space: 'Space', tab: 'Tab', cmd: 'Meta', ctrl: 'Control', alt: 'Alt', shift: 'Shift', super: 'Meta' }
const pwKey = (key: string) => key.split('+').map(part => PW_KEY[part] ?? PW_KEY[part.toLowerCase()] ?? (part.length === 1 ? part : part[0]?.toUpperCase() + part.slice(1))).join('+')

/** The journey as a Playwright test: what it could not pin to an element is a TODO. */
export function playwrightOf(j: Journey): string {
  const lines: string[] = []
  if (j.viewport !== undefined) lines.push(`  await page.setViewportSize({ width: ${j.viewport.width}, height: ${j.viewport.height} })`)
  for (const step of j.steps) {
    switch (step.kind) {
      case 'goto':
        lines.push(`  await page.goto(${q(step.url)})`)
        break
      case 'click': {
        const where = locator(step.target)
        const options = step.button === 'right' ? "{ button: 'right' }" : ''
        if (where !== undefined) lines.push(`  await ${where}.${step.button === 'double' ? 'dblclick' : 'click'}(${options})`)
        else if (step.target.x !== undefined) {
          lines.push(`  // TODO: ${step.target.ref ?? '座標'} を要素のロケーターに置き換える`)
          lines.push(`  await page.mouse.${step.button === 'double' ? 'dblclick' : 'click'}(${step.target.x}, ${step.target.y}${options === '' ? '' : `, ${options}`})`)
        } else lines.push(`  // TODO: クリック対象 ${step.target.ref ?? ''} のロケーターを書く`)
        break
      }
      case 'type':
        lines.push(`  await page.keyboard.type(${q(step.text)})`)
        break
      case 'key':
        lines.push(`  await page.keyboard.press(${q(pwKey(step.key))})`)
        break
      case 'fill': {
        const where = locator(step.target)
        lines.push(where === undefined ? `  // TODO: ${step.target.ref ?? '入力欄'} に ${q(step.value)} を入れる` : `  await ${where}.fill(${q(step.value)})`)
        break
      }
      case 'scroll':
        lines.push(`  await page.mouse.wheel(0, ${step.direction === 'up' ? -600 : 600})`)
        break
      case 'expect':
        lines.push(`  await expect(page.getByText(${q(step.text)})).toBeVisible() // 期待: 文言は画面に合わせて調整`)
        break
    }
  }
  return [`import { test, expect } from '@playwright/test'`, '', `test(${q(j.name)}, async ({ page }) => {`, ...lines, '})', ''].join('\n')
}
