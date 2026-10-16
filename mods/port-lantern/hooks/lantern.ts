// The lantern, pure: which commands start servers, the URLs and ports their output names,
// and what lsof says is listening.

import type { LanternServer } from '../types'

/** Commands that start something meant to keep running and serve. */
const SERVER =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|storybook)\b|vite(?:\s|$)|next\s+(?:dev|start)|nuxt\s+dev|astro\s+dev|remix\s+dev|webpack(?:-dev-server|\s+serve)|http-server|live-server|python3?\s+-m\s+http\.server|manage\.py\s+runserver|flask\s+run|uvicorn|gunicorn|hypercorn|fastapi\s+(?:dev|run)|rails\s+s(?:erver)?\b|bundle\s+exec\s+rails\s+s|php\s+-S|php\s+artisan\s+serve|hugo\s+server|jekyll\s+serve|mkdocs\s+serve|docker[- ]compose\s+up|docker\s+compose\s+up|wrangler\s+dev|vercel\s+dev|netlify\s+dev|firebase\s+emulators|supabase\s+start|expo\s+start|ng\s+serve|vue-cli-service\s+serve|deno\s+task\s+dev|cargo\s+(?:run|watch)|go\s+run|dotnet\s+(?:run|watch)|mix\s+phx\.server|trunk\s+serve|caddy\s+run)/

export const isServerCommand = (command: string): boolean => SERVER.test(command)

// An OSC sequence (a hyperlink, a title) ends at BEL or at ST (`ESC \`). It is read up to the
// next ESC or line break at most, so one never ended does not make each later one scan to the
// end of the output, and is left as it stands rather than taking the lines after it.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)/g
export const stripAnsi = (text: string): string => text.replace(ANSI, '')

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost|[\w.-]+\.local)(?::\d{2,5})?(?:\/[^\s'"<>)\]`]*)?/g

// A trailing dot, comma, semicolon or colon off, by a loop: /[.,;:]+$/ tries from each one of a run.
function trimPunctuation(url: string): string {
  let end = url.length
  while (end > 0 && '.,;:'.includes(url.charAt(end - 1))) end -= 1
  return url.slice(0, end)
}

/** Local URLs a text names, in order, `0.0.0.0` read as localhost, a trailing dot or comma off. */
export function urlsOf(text: string): string[] {
  const found = new Set<string>()
  for (const m of stripAnsi(text).matchAll(LOCAL_URL)) found.add(trimPunctuation(m[0]).replace('://0.0.0.0', '://localhost'))
  return [...found]
}

const portOfUrl = (url: string): number | undefined => {
  const m = url.match(/^https?:\/\/[^/]*:(\d{2,5})/)
  if (m?.[1] !== undefined) return Number(m[1])
  return url.startsWith('https://') ? 443 : url.startsWith('http://') ? 80 : undefined
}

const valid = (n: number) => Number.isInteger(n) && n > 0 && n < 65536

/** Ports a command sets (`--port 3000`, `-p 3000`, `PORT=3000`, `:8000` for runserver). */
export function commandPorts(command: string): number[] {
  const out = new Set<number>()
  for (const m of command.matchAll(/(?:--port[= ]|-p\s+|\bPORT=|--listen[= ](?:[\w.]+:)?|runserver\s+(?:[\w.]+:)?|-S\s+[\w.]+:|http\.server\s+)(\d{2,5})\b/g)) out.add(Number(m[1]))
  return [...out].filter(valid)
}

/** Ports an output names: its URLs' ports and `listening on port 3000`-like lines. */
export function outputPorts(text: string): number[] {
  const out = new Set<number>()
  for (const url of urlsOf(text)) {
    const port = portOfUrl(url)
    if (port !== undefined) out.add(port)
  }
  for (const m of stripAnsi(text).matchAll(/\b(?:listening|running|started|serving|available)\b[^\n]{0,40}?\bport\s*:?\s*(\d{2,5})\b/gi)) out.add(Number(m[1]))
  return [...out].filter(valid)
}

/** The background task's output file, as the Bash result names it. */
export function outputPathOf(text: string): string | undefined {
  return text.match(/Output is being written to: (\S+?\.output)\b/)?.[1]
}

/** The last `n` non-empty lines of an output, colours taken out. */
export function tailOf(text: string, n = 6): string[] {
  return stripAnsi(text)
    .split(/\r?\n|\r/)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .slice(-n)
    .map(line => (line.length > 200 ? `${line.slice(0, 199)}…` : line))
}

export type Listener = { port: number; pid: number; process: string }

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` read as port → process. */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = []
  let pid = 0
  let name = ''
  for (const line of text.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') pid = Number(value)
    else if (tag === 'c') name = value
    else if (tag === 'n') {
      const port = Number(value.slice(value.lastIndexOf(':') + 1))
      if (valid(port) && !out.some(one => one.port === port && one.pid === pid)) out.push({ port, pid, process: name })
    }
  }
  return out
}

/** A server's state against what listens now; its ports learnt from its output first. */
export function judge(server: LanternServer, listening: readonly Listener[], at: number): LanternServer {
  if (server.ports.length === 0) return server
  const hit = listening.find(one => server.ports.includes(one.port))
  const state = hit === undefined ? 'down' : 'listening'
  return {
    ...server,
    state,
    ...(hit === undefined ? {} : { pid: hit.pid, process: hit.process }),
    changedAt: state === server.state ? server.changedAt : at,
  }
}

/** What a newer look at its output adds: URLs and ports seen, and the latest lines. */
export function withOutput(server: LanternServer, text: string): LanternServer {
  const urls = [...server.urls, ...urlsOf(text).filter(url => !server.urls.includes(url))].slice(0, 6)
  const ports = [...new Set([...server.ports, ...outputPorts(text)])].slice(0, 6)
  const tail = tailOf(text)
  return { ...server, urls, ports, tail: tail.length > 0 ? tail : server.tail }
}

export const label = (server: LanternServer): string => (server.ports.length > 0 ? server.ports.map(port => `:${port}`).join(' ') : server.command.split(/\s+/).slice(0, 2).join(' '))

export function statusOf(servers: readonly LanternServer[]): string | undefined {
  if (servers.length === 0) return undefined
  const mark = (one: LanternServer) => (one.state === 'listening' ? '●' : one.state === 'down' ? '○' : '…')
  return `🏮 ${servers.map(one => `${label(one)}${mark(one)}`).join(' ')}`
}
