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

export const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}k`
      : String(n)

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

  return {
    percent: `${last.percent}%`,
    delta: delta > 0 ? ` ▲${delta}` : delta < 0 ? ` ▼${-delta}` : '',
    rest: ` · in ${compact(last.input)} / out ${compact(last.output)}${cost}`,
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
