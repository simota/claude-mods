// The lens, pure: tokens read from CSS, SCSS and tokens JSON, values normalised, and an
// element's computed style checked against them.

import type { LensCheck, LensToken, LensTokenKind } from '../types'

export type Rgba = [number, number, number, number]

const NAMED: Record<string, Rgba> = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0], red: [255, 0, 0, 1], blue: [0, 0, 255, 1], green: [0, 128, 0, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1] }

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

/** A CSS colour as RGBA: hex, rgb()/rgba() (commas or spaces), hsl()/hsla(), a few names. */
export function parseColor(text: string): Rgba | undefined {
  const value = text.trim().toLowerCase()
  if (NAMED[value] !== undefined) return NAMED[value]
  const hex = value.match(/^#([0-9a-f]{3,8})$/)?.[1]
  if (hex !== undefined) {
    const full = hex.length <= 4 ? [...hex].map(ch => ch + ch).join('') : hex
    if (full.length !== 6 && full.length !== 8) return undefined
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), full.length === 8 ? Math.round((n(6) / 255) * 100) / 100 : 1]
  }
  const fn = value.match(/^(rgba?|hsla?)\(([^)]*)\)$/)
  if (fn === null) return undefined
  const parts = (fn[2] as string).split(/[\s,/]+/).filter(Boolean)
  const num = (part: string | undefined, scale: number) => (part === undefined ? undefined : part.endsWith('%') ? (parseFloat(part) / 100) * scale : parseFloat(part))
  const alpha = parts[3] === undefined ? 1 : (num(parts[3], 1) as number)
  if ((fn[1] as string).startsWith('rgb')) {
    const [r, g, b] = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)]
    if (r === undefined || g === undefined || b === undefined || [r, g, b].some(Number.isNaN)) return undefined
    return [Math.round(r), Math.round(g), Math.round(b), alpha]
  }
  const [h, s, l] = [parseFloat(parts[0] ?? ''), (num(parts[1], 1) ?? NaN) as number, (num(parts[2], 1) ?? NaN) as number]
  if ([h, s, l].some(Number.isNaN)) return undefined
  return [...hsl(h, s, l), alpha]
}

/** A length in px: px, rem and em at 16px, unitless 0. */
export function parseLength(text: string, rootPx = 16): number | undefined {
  const m = text.trim().toLowerCase().match(/^(-?\d*\.?\d+)(px|rem|em)?$/)
  if (m === null) return undefined
  const n = parseFloat(m[1] as string)
  if (m[2] === undefined) return n === 0 ? 0 : undefined
  return m[2] === 'px' ? n : n * rootPx
}

const firstFamily = (text: string) => text.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '').toLowerCase() ?? ''

export function kindOf(value: string): LensTokenKind {
  if (parseColor(value) !== undefined) return 'color'
  if (parseLength(value) !== undefined) return 'length'
  if (/^['"]?[A-Za-z][\w -]*['"]?\s*(?:,\s*['"]?[\w -]+['"]?\s*)+$/.test(value.trim()) || /\b(?:serif|sans-serif|monospace|system-ui)\b/.test(value)) return 'font'
  return 'other'
}

/** `--name: value;` and `$name: value;` declarations of a stylesheet's lines. */
export function cssTokens(text: string, source: string): { name: string; value: string; source: string }[] {
  const out: { name: string; value: string; source: string }[] = []
  for (const m of text.matchAll(/(?:^|[\s;{])(--[A-Za-z0-9_-]+|\$[A-Za-z][\w-]*)\s*:\s*([^;{}\n]+?)\s*(?:!default\s*)?(?:;|$)/gm)) {
    out.push({ name: m[1] as string, value: (m[2] as string).trim(), source })
  }
  return out
}

/** Tokens of a design-tokens JSON (`{ color: { primary: { $value: "#..." } } }`, `value` too). */
export function jsonTokens(json: unknown, source: string, path: string[] = []): { name: string; value: string; source: string }[] {
  if (typeof json !== 'object' || json === null) return []
  const node = json as Record<string, unknown>
  const leaf = node.$value ?? node.value
  if (typeof leaf === 'string' || typeof leaf === 'number') return [{ name: path.join('.'), value: String(leaf), source }]
  return Object.entries(node).flatMap(([key, child]) => (key.startsWith('$') ? [] : jsonTokens(child, source, [...path, key])))
}

/** Tokens with `var(--x)`, `$x` and `{x.y}` references resolved, and their kind. */
export function resolveTokens(raw: readonly { name: string; value: string; source: string }[]): LensToken[] {
  const byName = new Map<string, string>()
  for (const one of raw) if (!byName.has(one.name)) byName.set(one.name, one.value)
  const resolve = (value: string, depth: number): string => {
    if (depth > 6) return value
    return value
      .replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/g, (all, name: string, fallback?: string) => {
        const found = byName.get(name)
        return found !== undefined ? resolve(found, depth + 1) : (fallback?.trim() ?? all)
      })
      .replace(/^\$([\w-]+)$/, (all, name: string) => {
        const found = byName.get(`$${name}`)
        return found !== undefined ? resolve(found, depth + 1) : all
      })
      .replace(/^\{([\w.-]+)\}$/, (all, name: string) => {
        const found = byName.get(name)
        return found !== undefined ? resolve(found, depth + 1) : all
      })
  }
  const seen = new Set<string>()
  const out: LensToken[] = []
  for (const one of raw) {
    if (seen.has(one.name)) continue
    seen.add(one.name)
    const value = resolve(one.value, 0)
    out.push({ name: one.name, value, kind: kindOf(value), source: one.source })
  }
  return out
}

export const PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'outline-color',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'row-gap',
  'column-gap',
  'border-top-left-radius',
  'border-top-width',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
] as const

const COLOR_PROPS = new Set(['color', 'background-color', 'border-top-color', 'outline-color'])
const distance = (a: Rgba, b: Rgba) => Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) + Math.abs(a[3] - b[3]) * 100)

/** One property's computed value against the tokens. */
export function check(property: string, value: string, tokens: readonly LensToken[]): LensCheck {
  const skip: LensCheck = { property, value, status: 'skip', tokens: [] }
  const v = value.trim()
  if (v === '' || v === 'normal' || v === 'none' || v === 'auto') return skip
  if (COLOR_PROPS.has(property)) {
    const color = parseColor(v)
    if (color === undefined || color[3] === 0) return skip
    const scored = tokens.flatMap(t => {
      const c = t.kind === 'color' ? parseColor(t.value) : undefined
      return c === undefined ? [] : [{ t, d: distance(color, c) }]
    })
    const equal = scored.filter(one => one.d <= 1).map(one => one.t.name)
    if (equal.length > 0) return { property, value: v, status: 'token', tokens: equal }
    const best = scored.sort((a, b) => a.d - b.d)[0]
    return { property, value: v, status: 'off', tokens: [], ...(best === undefined ? {} : { nearest: { name: best.t.name, value: best.t.value, distance: best.d } }) }
  }
  if (property === 'font-family') {
    const family = firstFamily(v)
    const equal = tokens.filter(t => (t.kind === 'font' || t.kind === 'other') && firstFamily(t.value) === family).map(t => t.name)
    return equal.length > 0 ? { property, value: v, status: 'token', tokens: equal } : { property, value: v, status: 'off', tokens: [] }
  }
  if (property === 'font-weight') {
    const equal = tokens.filter(t => /weight/i.test(t.name) && t.value.trim() === v).map(t => t.name)
    return equal.length > 0 ? { property, value: v, status: 'token', tokens: equal } : tokens.some(t => /weight/i.test(t.name)) ? { property, value: v, status: 'off', tokens: [] } : skip
  }
  const px = parseLength(v)
  if (px === undefined || px === 0) return skip
  const scored = tokens.flatMap(t => {
    const n = t.kind === 'length' ? parseLength(t.value) : undefined
    return n === undefined ? [] : [{ t, d: Math.abs(n - px) }]
  })
  const equal = scored.filter(one => one.d < 0.5).map(one => one.t.name)
  if (equal.length > 0) return { property, value: v, status: 'token', tokens: equal }
  const best = scored.sort((a, b) => a.d - b.d)[0]
  return { property, value: v, status: 'off', tokens: [], ...(best === undefined ? {} : { nearest: { name: best.t.name, value: best.t.value, distance: Math.round(best.d * 10) / 10 } }) }
}

/** The script run in the page: the computed style of the elements a selector picks, or of the selected text. */
export function probeScript(selector: string): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  let els = [];
  if (selector) { els = Array.from(document.querySelectorAll(selector)).slice(0, 5); }
  else {
    const s = window.getSelection();
    const n = s && s.rangeCount > 0 ? s.getRangeAt(0).commonAncestorContainer : null;
    const el = n ? (n.nodeType === 1 ? n : n.parentElement) : null;
    if (el && el !== document.body && el !== document.documentElement) els = [el];
  }
  const props = ${JSON.stringify(PROPERTIES)};
  return JSON.stringify({ url: location.href, elements: els.map(el => {
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of props) style[p] = cs.getPropertyValue(p);
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    return { label: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : ''), text: (el.textContent || '').trim().slice(0, 30), style };
  }) });
})()`
}

export type Probe = { url?: string; elements: { label: string; text?: string; style: Record<string, string> }[] }

/**
 * The probe's answer, out of whatever text the tool wrapped it in: the object as it is, or as a
 * JSON string literal (quotes inside its values escaped), each read by the JSON parser itself.
 */
export function parseProbe(text: string): Probe | undefined {
  const read = (body: string): unknown => {
    try {
      const value: unknown = JSON.parse(body)
      return typeof value === 'string' ? read(value) : value
    } catch {
      return undefined
    }
  }
  const raw = text.indexOf('{"url"')
  const quoted = text.indexOf('"{\\"url\\"')
  const candidates = [
    text.trim(),
    raw >= 0 ? text.slice(raw, text.lastIndexOf('}') + 1) : '',
    quoted >= 0 ? text.slice(quoted, text.lastIndexOf('}"') + 2) : '',
  ]
  for (const body of candidates) {
    const value = body === '' ? undefined : read(body)
    if (typeof value === 'object' && value !== null && Array.isArray((value as Probe).elements)) return value as Probe
  }
  return undefined
}
