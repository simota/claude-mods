import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LanternServer } from '../types'
import { commandPorts, isServerCommand, judge, label, outputPathOf, parseLsof, statusOf, urlsOf, withOutput } from './lantern'

const PANE = 'port-lantern'
const TITLE = '開発サーバ'
const POLL_MS = 5_000
const KEEP = 10
const TAIL_BYTES = 32_768

const servers = atom({ plugin: 'port-lantern', key: 'servers' } as const, [] as LanternServer[])

/** Shown once it is a server: a command that starts one, or one whose output named a port. */
const isShown = (one: LanternServer) => isServerCommand(one.command) || one.ports.length > 0
const visible = (list: readonly LanternServer[]) => list.filter(isShown)

let isPolling = false

async function tail($: EngineInterface, path: string): Promise<string | undefined> {
  const ran = await $.process.run(['tail', '-c', String(TAIL_BYTES), '--', path], { timeoutMs: 5_000 }).catch(() => undefined)
  return ran?.exitCode === 0 ? ran.stdout : undefined
}

async function listeners($: EngineInterface) {
  const ran = await $.process.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeoutMs: 10_000 }).catch(() => undefined)
  // lsof exits 1 when nothing listens at all.
  return ran === undefined ? undefined : parseLsof(ran.stdout)
}

/** Reads each server's output and what listens now, and says what changed. */
async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const before = await read($, servers)
    if (before.length === 0) return
    const outputs = new Map<string, string>()
    for (const one of before) {
      if (one.outputPath === undefined) continue
      const text = await tail($, one.outputPath)
      if (text !== undefined) outputs.set(one.id, text)
    }
    const listening = await listeners($)
    const at = await $.clock.now()
    const after = await update($, servers, list =>
      list.map(one => {
        const read = outputs.get(one.id)
        const seen = read === undefined ? one : withOutput(one, read)
        return listening === undefined ? seen : judge(seen, listening, at)
      }),
    )
    const notes: string[] = []
    for (const now of after) {
      const was = before.find(one => one.id === now.id)
      if (was === undefined || !isShown(now)) continue
      if (was.state !== 'listening' && now.state === 'listening') notes.push(`🏮 起動: ${now.urls[0] ?? label(now)}`)
      if (was.state === 'listening' && now.state === 'down') notes.push(`🏮 停止: ${label(now)}（${now.command.slice(0, 40)}）`)
    }
    if (notes.length > 0) $.ui.toast(notes.join(' · '))
    $.ui.status(statusOf(visible(after)))
  } finally {
    isPolling = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ports', description: 'セッションが起動した開発サーバの URL・ポート・生存状態・ログを表示' })
    const started = await next(e)
    $.clock.every(POLL_MS, () => {
      void poll($).catch(err => $.ui.log(`port-lantern: ${String(err)}`, { to: 'debug' }))
    })
    $.ui.status(statusOf(visible(await read($, servers))))
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const result = (ran.result ?? {}) as { backgroundTaskId?: string }
    const text = ran.text ?? ''
    const outputPath = outputPathOf(text)
    const isBackground = result.backgroundTaskId !== undefined || outputPath !== undefined
    // A foreground command is a server only if it named a local URL before it ended.
    if (!isBackground && (!isServerCommand(e.command) || urlsOf(text).length === 0)) return ran

    const at = await $.clock.now()
    const fresh: LanternServer = withOutput(
      {
        id: result.backgroundTaskId ?? outputPath ?? e.tool_use_id ?? String(at),
        command: e.command.trim().slice(0, 300),
        startedAt: at,
        ...(outputPath === undefined ? {} : { outputPath }),
        urls: [],
        ports: commandPorts(e.command),
        state: 'unknown',
        tail: [],
        changedAt: at,
      },
      isBackground ? '' : text,
    )
    await update($, servers, list => [...list.filter(one => one.id !== fresh.id), fresh].slice(-KEEP))
    if (isShown(fresh)) $.ui.status(statusOf(visible(await read($, servers))))
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('command.run', { command: 'ports' }, async $ => {
    await poll($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: TITLE })
    const list = visible(await read($, servers))
    if (list.length === 0) return { text: '🏮 このセッションが起動した開発サーバはありません。' }
    return {
      text: list
        .map(one => `${one.state === 'listening' ? '●' : one.state === 'down' ? '○' : '…'} ${one.urls[0] ?? label(one)} — ${one.command}`)
        .join('\n'),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = visible(await read($, servers)).reverse()
    const now = await $.clock.now()
    if (list.length === 0) return <Text dimColor>このセッションが起動した開発サーバはまだありません。</Text>
    const age = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}秒` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}分` : `${Math.round(ms / 3_600_000)}時間`)
    return (
      <Box flexDirection="column">
        {list.map(one => {
          const head = one.state === 'listening' ? '● 稼働中' : one.state === 'down' ? '○ 停止' : '… ポート未検出'
          const color = one.state === 'listening' ? 'green' : one.state === 'down' ? 'red' : 'yellow'
          const url = one.urls[0]
          return (
            <Box key={one.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={color} bold>{`${head} `}</Text>
                <Text bold wrap="truncate-end">{url ?? label(one)}</Text>
                {url !== undefined && <Button key={`copy-${one.id}`} plain label=" [コピー]" onPress={press => $.ui.copy({ text: url, surface: press.surface })} />}
              </Box>
              <Text dimColor wrap="truncate-end">
                {`$ ${one.command}  ·  ${one.ports.length > 0 ? `ポート ${one.ports.join(', ')}` : 'ポート不明'}${one.pid !== undefined ? `  ·  pid ${one.pid} ${one.process ?? ''}` : ''}  ·  ${age(now - one.changedAt)}前から`}
              </Text>
              {one.urls.slice(1).map(other => (
                <Text key={`${one.id}-${other}`} dimColor wrap="truncate-end">{`  ${other}`}</Text>
              ))}
              {one.tail.map((line, index) => (
                <Text key={`${one.id}-t${index}`} wrap="truncate-end" color={/\b(?:error|failed|exception|EADDRINUSE)\b/i.test(line) ? 'red' : undefined} dimColor={!/\b(?:error|failed|exception|EADDRINUSE)\b/i.test(line)}>
                  {`  │ ${line}`}
                </Text>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
