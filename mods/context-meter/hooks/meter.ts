import type { Sample } from '../types'

export const MAX_SAMPLES = 40

// Gruvbox Dark, as ~/.claude/statusline.sh draws it.
export const GREEN = 0xb8bb26
export const YELLOW = 0xfabd2f
export const RED = 0xfb4934
export const FG4 = 0xa89984
const DEFAULT_BG = 0x01000000

// ▁▂▃▄▅▆▇█
const BARS = [0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588]

export const colorFor = (percent: number) => (percent >= 80 ? RED : percent >= 50 ? YELLOW : GREEN)

export const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

// The unit is chosen after rounding, so 999,999 reads 1M rather than 1000k. Millions round in
// whole tenths: 1,950,000 / 100,000 is exactly 19.5 and rounds up, where 1.95.toFixed(1) is "1.9".
export const compact = (n: number) => {
  if (Math.round(n / 1_000) >= 1_000) {
    const tenths = Math.round(n / 100_000)
    const rest = tenths % 10
    return `${Math.floor(tenths / 10)}${rest === 0 ? '' : `.${rest}`}M`
  }
  return n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n)
}

export const barFor = (percent: number) => {
  const clamped = Math.min(100, Math.max(0, percent))
  return BARS[Math.min(BARS.length - 1, Math.floor((clamped / 100) * BARS.length))] ?? BARS[0]!
}

export type Parts = { percent: string; delta: string; rest: string }

export const describe = (list: readonly Sample[]): Parts | undefined => {
  const last = list.at(-1)
  if (last === undefined) {
    return undefined
  }

  const prev = list.at(-2)
  const delta = prev === undefined ? 0 : last.percent - prev.percent
  const cost = last.costUsd === undefined ? '' : ` · $${last.costUsd.toFixed(2)}`
  // Two quantities, labelled apart: the context the last request carried, and what the
  // whole turn sent and received over all its requests (only when the turn reported it).
  const turn =
    last.input === undefined || last.output === undefined
      ? ''
      : ` · turn in ${compact(last.input)} / out ${compact(last.output)}`

  return {
    percent: `${last.percent}%`,
    delta: delta > 0 ? ` ▲${delta}` : delta < 0 ? ` ▼${-delta}` : '',
    rest: ` · ${compact(last.tokens)}${turn}${cost}`,
  }
}

export const lineText = (parts: Parts) => `ctx ${parts.percent}${parts.delta}${parts.rest}`

// Raster cells: little-endian u32 triplets [codePoint, foreground, background], base64.
export const sparkCells = (list: readonly Sample[]) => {
  const view = new DataView(new ArrayBuffer(list.length * 12))
  list.forEach((sample, i) => {
    view.setUint32(i * 12, barFor(sample.percent), true)
    view.setUint32(i * 12 + 4, colorFor(sample.percent), true)
    view.setUint32(i * 12 + 8, DEFAULT_BG, true)
  })

  const bytes = new Uint8Array(view.buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
