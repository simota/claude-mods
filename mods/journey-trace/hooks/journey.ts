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

// A field that takes a secret, by the name the page gave it: whole words, so a passport, a token
// count or a secretary is no secret.
const SECRET_FIELD = new RegExp(
  [
    String.raw`\bpass(?:word|code|phrase|wort)?s?\b`, 'mot de passe', 'contraseña', 'kennwort', String.raw`\bpwd\b`,
    'パスワード', 'パスコード', '暗証', String.raw`\bsecret\b`, String.raw`\b(?:api|access|private|secret)[ _-]?keys?\b`,
    String.raw`\btokens?\b(?!\s*(?:count|per|usage|limit))`, String.raw`\botp\b`, String.raw`\btotp\b`, String.raw`\bmfa\b`, String.raw`\b2fa\b`,
    'one[- ]?time', 'ワンタイム', String.raw`\bpin\b(?!\s+to\b)`, String.raw`\bcv[vc]\b`, 'security (?:code|answer)', 'セキュリティコード',
    String.raw`\b(?:verification|authentication|auth|sms|recovery|backup|confirmation|access|login)\s+codes?\b`, String.raw`\b\d-digit code\b`,
    '(?:seed|recovery) phrase', 'card number', 'カード番号', '認証コード', '確認コード', '確認番号',
  ].join('|'),
  'i',
)
// Text shaped like a credential wherever it is typed.
const SHAPES = String.raw`(?:sk-(?:ant-)?[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_\w{10,}|xox[abprs]-[\w-]{8,}|AKIA[0-9A-Z]{16}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|AIza[\w-]{35}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*)`
const SECRET_SHAPE = new RegExp(String.raw`(?<![\w-])${SHAPES}`)
const SECRET_SHAPES = new RegExp(String.raw`(?<![\w-])${SHAPES}`, 'g')
// Query and fragment parameters that carry a secret. `code` only on a page that receives one
// (an OAuth callback); `state` and `key` are ordinary words there.
const SECRET_PARAM = /^(?:.*(?:token|secret|password|passwd|signature|api[_-]?key|otp|jwt)|.*session(?:[_-]?id)?|jsessionid|sid|pwd|pass|auth|authorization|sig|auth[_-]?code|code[_-]?verifier)$/i
const CALLBACK = /callback|oauth|\/auth\b|login|signin|sign-in|redirect/i

export const SECRET = '***'

function maskedParams(params: string, isCallback: boolean): string {
  return params
    .split('&')
    .map(pair => {
      const at = pair.indexOf('=')
      if (at <= 0) return pair
      const name = decodeURIComponentSafe(pair.slice(0, at))
      return SECRET_PARAM.test(name) || (isCallback && /^code$/i.test(name)) ? `${pair.slice(0, at)}=${SECRET}` : pair
    })
    .join('&')
}

/** A URL as kept: its user part, secret parameters (query and fragment), and key-shaped text in its path masked. */
export function maskedUrl(url: string): string {
  const hashAt = url.indexOf('#')
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt)
  const hash = hashAt === -1 ? undefined : url.slice(hashAt + 1)
  const [head = '', ...rest] = beforeHash.split('?')
  const isCallback = CALLBACK.test(head)
  const base = head
    .replace(/^(\w[\w+.-]*:\/\/)([^/@\s:]+):[^/\s]+@/, `$1$2:${SECRET}@`)
    .replace(/^(\w[\w+.-]*:\/\/)([^/@\s:]+)@/, (whole, scheme: string, user: string) => (SECRET_SHAPE.test(user) || user.length > 24 ? `${scheme}${SECRET}@` : whole))
    .replace(SECRET_SHAPES, SECRET)
  const query = rest.length === 0 ? '' : `?${maskedParams(rest.join('?'), isCallback)}`
  // A fragment carries parameters too: an implicit OAuth flow's `#access_token=…`, a hash route's `#/x?token=…`.
  let fragment = ''
  if (hash !== undefined) {
    const inner = hash.indexOf('?')
    fragment = `#${inner === -1 ? (hash.includes('=') ? maskedParams(hash, true) : hash) : `${hash.slice(0, inner)}?${maskedParams(hash.slice(inner + 1), isCallback)}`}`
  }
  return `${base}${query}${fragment}`
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

// Roles a secret is typed into: a checkbox named "Remember password" holds none.
const TEXT_ROLES = new Set(['textbox', 'input', 'textarea', 'searchbox', 'combobox'])

/**
 * Text typed where the field is not known (after Tab or Enter, a click by coordinates, a new
 * page) that reads as a password or a one-time code: no spaces, not an address, and either
 * three kinds of character or four to eight digits.
 */
export function isPasswordLike(text: string): boolean {
  if (/\s/.test(text) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) || /^\w+:\/\//.test(text)) return false
  if (/^\d{4,8}$/.test(text)) return true
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(kind => kind.test(text)).length
  return text.length >= 6 && text.length <= 128 && kinds >= 3
}

const isSecretTarget = (t: JourneyTarget | undefined) =>
  t?.name !== undefined && (t.role === undefined || TEXT_ROLES.has(t.role)) && SECRET_FIELD.test(t.name)

/**
 * The steps one browser call makes, read from its input. A value filled into a field named as a
 * secret, text typed while one has the focus (`focus`: the element last clicked or filled, absent
 * when it is not known: after Tab or Enter, a click by coordinates, a new page) or, focus unknown,
 * text that reads as a password, and text shaped like a credential are kept as `***`: the journey
 * is copied out as a report or a test.
 */
export function stepsOf(
  tool: string,
  input: Record<string, unknown>,
  refs: Readonly<Record<string, { role?: string; name?: string }>>,
  url: string,
  at: number,
  focus?: JourneyTarget,
): JourneyStep[] {
  url = maskedUrl(url)
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
    return [{ kind: 'goto', url: maskedUrl(/^https?:\/\//.test(to) ? to : (landed ?? `${isLocal ? 'http' : 'https'}://${to}`)), at }]
  }
  if (tool === 'form_input') {
    const value = String(input.value ?? '')
    const where = target()
    return isSecretTarget(where) || SECRET_SHAPE.test(value)
      ? [{ kind: 'fill', target: where, value: SECRET, url, at, isSecret: true }]
      : [{ kind: 'fill', target: where, value, url, at }]
  }
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
      if (str('text') === undefined) return []
      const isKnown = focus?.name !== undefined
      return isSecretTarget(focus) || SECRET_SHAPE.test(str('text') as string) || (!isKnown && isPasswordLike(str('text') as string))
        ? [{ kind: 'type', text: SECRET, url, at, isSecret: true }]
        : [{ kind: 'type', text: str('text') as string, url, at }]
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
      return step.isSecret === true ? '秘密の値を入力（記録していません）' : `「${step.text}」と入力`
    case 'key':
      return `${KEY_JA[step.key] ?? step.key} キーを押す`
    case 'fill':
      return step.isSecret === true ? `${describeTarget(step.target)}に秘密の値を入力（記録していません）` : `${describeTarget(step.target)}に「${step.value}」を入力`
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

const q = (text: string) =>
  `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`
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
  // A secret was never kept: the test reads each from the environment.
  let secrets = 0
  const secret = () => `process.env.JOURNEY_SECRET_${(secrets += 1)} ?? ''`
  if (j.viewport !== undefined) lines.push(`  await page.setViewportSize({ width: ${j.viewport.width}, height: ${j.viewport.height} })`)
  for (const step of j.steps) {
    switch (step.kind) {
      case 'goto':
        if (step.url.includes(SECRET)) lines.push(`  // TODO: 伏せた値（${SECRET}）を実際の値に置き換える`)
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
        lines.push(step.isSecret === true ? `  await page.keyboard.type(${secret()}) // 秘密の値: 環境変数で渡す` : `  await page.keyboard.type(${q(step.text)})`)
        break
      case 'key':
        lines.push(`  await page.keyboard.press(${q(pwKey(step.key))})`)
        break
      case 'fill': {
        const where = locator(step.target)
        const value = step.isSecret === true ? secret() : q(step.value)
        const role = step.target.role ?? ''
        // A select takes an option, a checkbox a check: Playwright refuses fill() on either.
        const action = ['combobox', 'select', 'listbox'].includes(role)
          ? `selectOption(${value})`
          : ['checkbox', 'radio', 'switch'].includes(role)
            ? /^(?:true|on|checked|1|yes)$/i.test(step.value) ? 'check()' : 'uncheck()'
            : `fill(${value})`
        lines.push(where === undefined ? `  // TODO: ${step.target.ref ?? '入力欄'} に ${value} を入れる` : `  await ${where}.${action}${step.isSecret === true ? ' // 秘密の値: 環境変数で渡す' : ''}`)
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
