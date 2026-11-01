import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Doc, Server } from '../types'
import {
  candidatePorts,
  commandArgv,
  iconOf,
  isNotFound,
  cwdSpelledRoot,
  isPreviewable,
  judgeInfo,
  lineOf,
  previewUrl,
  relativeTo,
  serveArgs,
  statusOf,
  tailOf,
  withChange,
} from './docview'

type Api = EngineInterface

const PANE = 'doc-preview'
const PANE_TITLE = 'docview'
const NPX = ['npx', '-y', 'github:simota/docview']
const PROBE_TIMEOUT_MS = 1_500
const READY_POLL_MS = 250
const READY_TIMEOUT_MS = 20_000
// npx clones and installs docview on its first run.
const NPX_READY_TIMEOUT_MS = 180_000

const root = atom({ plugin: 'doc-preview', key: 'root' } as const, null as string | null)
const docs = atom({ plugin: 'doc-preview', key: 'docs' } as const, [] as Doc[])
const server = atom({ plugin: 'doc-preview', key: 'server' } as const, { kind: 'off' } as Server)
const opened = atom({ plugin: 'doc-preview', key: 'opened' } as const, [] as string[])
const pending = atom({ plugin: 'doc-preview', key: 'pending' } as const, [] as string[])

// Set by register from the options; module-local, as a reload runs register again.
let command = 'docview'
let allowNpx = false
let basePort = 4100
let autoOpen = false
// The session's cwd, and the root as git spelled it before symlinks were resolved.
let cwd = ''
let aliases: string[] = []
// The child this module started; it dies with the module.
let child: { port: number; life: Life; stop: () => void } | undefined
let ensuring: Promise<string | undefined> | undefined
let opener: string | undefined
// Documents autoOpen already tried: a failure is not retried every turn.
const autoTried = new Set<string>()

const failed = (error: string, tail: string[] = []): Server => ({ kind: 'failed', error, tail })

async function setServer($: Api, next: Server) {
  await update($, server, () => next)
  $.ui.status(statusOf(next))
}

async function findRoot($: Api, dir: string) {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir }).catch(() => undefined)
  const named = top?.exitCode === 0 && top.stdout.trim() !== '' ? top.stdout.trim() : dir
  // docview compares and reports its root with symlinks resolved (realpath).
  const real = await $.process.run(['pwd', '-P'], { cwd: named }).catch(() => undefined)
  const resolved = real?.exitCode === 0 && real.stdout.trim() !== '' ? real.stdout.trim() : named
  const realCwd = await $.process.run(['pwd', '-P'], { cwd: dir }).catch(() => undefined)
  const spelled = realCwd?.exitCode === 0 ? cwdSpelledRoot(dir, realCwd.stdout.trim(), resolved) : undefined
  return { resolved, aliases: [...new Set([named, ...(spelled === undefined ? [] : [spelled])])].filter(one => one !== resolved) }
}

/** Whether docview serves our root on the port, something else answers there, or nothing does. */
async function probe($: Api, port: number, dir: string): Promise<'same' | 'other' | 'free'> {
  const timeout = $.clock.sleep(PROBE_TIMEOUT_MS).then(() => 'timeout' as const)
  try {
    const answer = await Promise.race([$.http.fetch(`http://127.0.0.1:${port}/api/info`), timeout])
    // A port that holds the connection without answering is taken.
    if (answer === 'timeout') return 'other'
    return answer.ok ? judgeInfo(answer.text, dir) : 'other'
  } catch (err) {
    return /ECONNREFUSED|ECONNRESET|connect/i.test(String(err)) ? 'free' : 'other'
  }
}

/** `isStopped`: ended by /docview stop or 停止, not by itself. */
type Life = { isDone: boolean; isStopped: boolean; error?: string; code?: number | null; out: string }

function spawnChild($: Api, argv: string[], dir: string, port: number): Life {
  const life: Life = { isDone: false, isStopped: false, out: '' }
  const stream = $.process.spawn({ argv, cwd: dir })
  const me = { port, life, stop: () => void stream.return(undefined as never) }
  child = me
  // The loop is the child's life: it ends with the child, a stop, or the module.
  void (async () => {
    try {
      for await (const chunk of stream) life.out = (life.out + chunk.text).slice(-8_000)
      life.code = (await stream.result).code
    } catch (err) {
      life.error = String(err)
    }
    life.isDone = true
    if (child !== me) return
    child = undefined
    const now = await read($, server)
    if (now.kind === 'up' && now.isOwned && now.port === port) {
      await setServer($, failed(`docview が終了しました（code ${String(life.code ?? '?')}）`, tailOf(life.out, 12)))
      $.ui.toast('📄 docview が終了しました')
    }
  })().catch(() => undefined) // the module may be gone by the time the child ends
  return life
}

/** Starts docview on a free port and waits until it serves our root. */
async function launch($: Api, dir: string, port: number): Promise<string | undefined> {
  await setServer($, { kind: 'starting', port })
  const tries = [commandArgv(command), ...(allowNpx ? [NPX] : [])]
  for (const [index, base] of tries.entries()) {
    const isNpx = base === NPX
    const life = spawnChild($, [...base, ...serveArgs(dir, port)], dir, port)
    const startedAt = await $.clock.now()
    const limit = isNpx ? NPX_READY_TIMEOUT_MS : READY_TIMEOUT_MS
    while (!life.isDone && !life.isStopped && (await $.clock.now()) - startedAt < limit) {
      if ((await probe($, port, dir)) === 'same' && !life.isStopped) {
        const url = `http://127.0.0.1:${port}/`
        await setServer($, { kind: 'up', port, url, isOwned: true })
        return url
      }
      await $.clock.sleep(READY_POLL_MS)
    }
    // Stopped while starting: off, written here too so no caller reads 'starting' before the stop's own write.
    if (life.isStopped) {
      await setServer($, { kind: 'off' })
      return undefined
    }
    if (!life.isDone) {
      const stopping = child
      child = undefined
      stopping?.stop()
      await setServer($, failed('docview の起動を確認できませんでした', tailOf(life.out, 12)))
      return undefined
    }
    const isMissing = life.error !== undefined && isNotFound(life.error)
    if (isMissing && index < tries.length - 1) continue
    const error = isMissing
      ? `${base[0]} が見つかりません（npm install -g github:simota/docview、または allowNpx を on）`
      : (tailOf(life.error ?? life.out, 1)[0] ?? `docview が終了しました（code ${String(life.code ?? '?')}）`)
    await setServer($, failed(error.slice(0, 200), tailOf(life.out, 12)))
    return undefined
  }
  return undefined
}

async function startOrAttach($: Api): Promise<string | undefined> {
  const dir = await read($, root)
  if (dir === null) return undefined
  const now = await read($, server)
  if (now.kind === 'up') {
    if (now.isOwned && child?.port === now.port) return now.url
    if ((await probe($, now.port, dir)) === 'same') return now.url
  }
  for (const port of candidatePorts(basePort)) {
    const found = await probe($, port, dir)
    if (found === 'other') continue
    if (found === 'same') {
      // Someone's docview already serves this root: use it, never stop it.
      const url = `http://127.0.0.1:${port}/`
      await setServer($, { kind: 'up', port, url, isOwned: false })
      return url
    }
    return launch($, dir, port)
  }
  await setServer($, failed(`ポート ${basePort} から ${candidatePorts(basePort).length} 個がすべて使用中です`))
  return undefined
}

/** One start at a time: two presses before it is up share it. */
function ensureServer($: Api): Promise<string | undefined> {
  ensuring ??= startOrAttach($).finally(() => {
    ensuring = undefined
  })
  return ensuring
}

async function stopServer($: Api): Promise<string> {
  const now = await read($, server)
  if (now.kind === 'up' && !now.isOwned) {
    await setServer($, { kind: 'off' })
    return `:${now.port} の docview はこの mod が起動したものではないので、止めずに使うのをやめました。`
  }
  if (child === undefined) {
    await setServer($, { kind: 'off' })
    return 'docview は動いていません。'
  }
  // Cleared first, so the child's loop takes its end for a stop, not a crash.
  const stopping = child
  child = undefined
  stopping.life.isStopped = true
  stopping.stop()
  await setServer($, { kind: 'off' })
  return 'docview を止めました。'
}

async function openInBrowser($: Api, url: string): Promise<boolean> {
  if (opener === undefined) {
    const uname = await $.process.run(['uname', '-s']).catch(() => undefined)
    opener = uname?.stdout.trim() === 'Darwin' ? 'open' : 'xdg-open'
  }
  const ran = await $.process.run([opener, url], { timeoutMs: 10_000 }).catch(() => undefined)
  if (ran?.exitCode === 0) return true
  $.ui.toast(`📄 ブラウザを開けませんでした: ${url}`)
  return false
}

/** Opens a document (or the root) in docview, starting it when needed. */
async function preview($: Api, doc?: Doc): Promise<string> {
  if (doc !== undefined && doc.rel === null) return `${doc.path} は docview のルートの外にあるため開けません。`
  const base = await ensureServer($)
  if (base === undefined) {
    const now = await read($, server)
    if (now.kind === 'off') return 'docview を止めました。'
    const text = now.kind === 'failed' ? `docview を起動できませんでした: ${now.error}` : 'docview を起動できませんでした。'
    $.ui.toast(`📄 ${text}`)
    return text
  }
  const url = previewUrl(base, doc?.rel ?? null, doc?.line)
  if (!(await openInBrowser($, url))) return `ブラウザを開けませんでした: ${url}`
  if (doc !== undefined) {
    await update($, opened, list => (list.includes(doc.path) ? list : [...list, doc.path]))
    await update($, pending, list => list.filter(path => path !== doc.path))
  }
  return `開きました: ${url}`
}

async function openPane($: Api) {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

const absolute = (path: string) => (path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`)

function relOf(dir: string, path: string): string | null {
  for (const base of [dir, ...aliases]) {
    const rel = relativeTo(base, path)
    if (rel !== null) return rel
  }
  return null
}

/** The document a `/docview <path>` names: one recorded, else any previewable file under the root. */
async function docNamed($: Api, arg: string): Promise<Doc | string> {
  const dir = (await read($, root)) ?? cwd
  const path = absolute(arg)
  const known = (await read($, docs)).find(doc => doc.path === path || doc.rel === arg)
  if (known !== undefined) return known
  if (!(await $.fs.exists(path))) return `${arg} が見つかりません。`
  return { path, rel: relOf(dir, path), edits: 0, at: await $.clock.now() }
}

const age = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}秒` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}分` : `${Math.round(ms / 3_600_000)}時間`)

export const register: Register = (on, options) => {
  command = typeof options.command === 'string' && options.command.trim() !== '' ? options.command : 'docview'
  allowNpx = options.allowNpx === true
  basePort = typeof options.basePort === 'number' ? options.basePort : 4100
  autoOpen = options.autoOpen === 'first'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd
    await $.command.register({ name: 'docview', description: '書いたドキュメントの一覧をペインで開く。/docview <path> でプレビュー、root でルート、stop で停止' })
    const found = await findRoot($, e.cwd)
    aliases = found.aliases
    await update($, root, () => found.resolved)
    // A reload killed the child this module had; a docview it did not start is probed again when needed.
    await setServer($, { kind: 'off' })
    return started
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const input = e as unknown as { file_path?: unknown; old_string?: unknown }
    if (typeof input.file_path !== 'string' || !isPreviewable(input.file_path)) return next(e)
    const path = absolute(input.file_path)
    // Where old_string stands before the edit is where the edit starts after it: the text above is
    // unchanged. new_string searched afterwards could match an earlier, untouched copy.
    const before = typeof input.old_string === 'string' ? await $.fs.read(path).catch(() => undefined) : undefined
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const dir = (await read($, root)) ?? cwd
    const rel = relOf(dir, path)
    const line = before === undefined || typeof input.old_string !== 'string' ? undefined : lineOf(before, input.old_string)
    const at = await $.clock.now()
    await update($, docs, list => withChange(list, { path, rel, at, ...(line === undefined ? {} : { line }) }))
    // An opened tab follows edits by itself (docview's live reload): the band only offers new ones.
    if (rel !== null && !(await read($, opened)).includes(path)) {
      await update($, pending, list => [...list.filter(one => one !== path), path])
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!autoOpen || e.agentId !== undefined) return done
    const waiting = await read($, pending)
    const latest = waiting.at(-1)
    if (latest === undefined || autoTried.has(latest) || (await read($, server)).kind === 'failed') return done
    autoTried.add(latest)
    const doc = (await read($, docs)).find(one => one.path === latest)
    if (doc !== undefined) void preview($, doc).catch(() => undefined)
    return done
  })

  on('command.run', { command: 'docview' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') {
      await openPane($)
      return { text: 'docview のペインを開きました。' }
    }
    if (arg === 'stop') return { text: await stopServer($) }
    if (arg === 'root') return { text: await preview($) }
    const doc = await docNamed($, arg)
    if (typeof doc === 'string') return { text: doc }
    if (!isPreviewable(doc.path)) return { text: `${arg} は docview がプレビューできる形式ではありません。` }
    return { text: await preview($, doc) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const waiting = await read($, pending)
    const all = await read($, docs)
    const list = waiting.map(path => all.find(doc => doc.path === path)).filter((doc): doc is Doc => doc !== undefined)
    const below = await next(e)
    const latest = list.at(-1)
    if (latest === undefined) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const row: RenderChildren = (
      <Box>
        <Text wrap="truncate-end">
          {iconOf(latest.path)} {latest.rel}
          {list.length > 1 ? ` ほか${list.length - 1}件` : ''} を更新{' '}
        </Text>
        <Button key="preview" label="プレビュー" variant="primary" onPress={() => preview($, latest)} />
        {list.length > 1 && <Button key="list" label="一覧" onPress={() => openPane($)} />}
        <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, pending, () => [])} />
      </Box>
    )
    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, server)
    const dir = (await read($, root)) ?? ''
    const list = [...(await read($, docs))].reverse()
    const seen = await read($, opened)
    const now = await $.clock.now()
    const head =
      s.kind === 'up'
        ? `● ${s.url}${s.isOwned ? '' : '（既存の docview を利用中）'}`
        : s.kind === 'starting'
          ? `… 起動中 :${s.port}`
          : s.kind === 'failed'
            ? `✗ ${s.error}`
            : '○ 停止中'
    const color = s.kind === 'up' ? 'green' : s.kind === 'failed' ? 'red' : s.kind === 'starting' ? 'yellow' : undefined
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color={color} wrap="truncate-end">
            {head}{' '}
          </Text>
          {s.kind === 'up' && <Button key="copy" plain label="[コピー] " onPress={press => $.ui.copy({ text: s.url, surface: press.surface })} />}
          {s.kind !== 'starting' && <Button key="root" label={s.kind === 'up' ? 'ルートを開く' : '起動して開く'} variant="primary" onPress={() => preview($)} />}
          {s.kind === 'up' && <Button key="stop" label={s.isOwned ? '停止' : '切り離す'} onPress={() => stopServer($)} />}
        </Box>
        <Text dimColor wrap="truncate-end">
          ルート: {dir}
        </Text>
        {s.kind === 'failed' &&
          s.tail.map((line, i) => (
            <Text key={`f-${i}`} dimColor wrap="truncate-end">
              {'  │ '}
              {line}
            </Text>
          ))}
        {list.length === 0 && <Text dimColor>このセッションで書いたドキュメントはまだありません。</Text>}
        {list.map(doc => (
          <Box key={doc.path}>
            <Text color={seen.includes(doc.path) ? 'green' : undefined}>{seen.includes(doc.path) ? '● ' : '  '}</Text>
            <Text bold={doc.rel !== null} dimColor={doc.rel === null} wrap="truncate-end">
              {iconOf(doc.path)} {doc.rel ?? doc.path}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {doc.rel === null ? 'ルート外 · ' : ''}×{doc.edits}
              {doc.line === undefined ? '' : ` · L${doc.line}`} · {age(now - doc.at)}前{' '}
            </Text>
            {doc.rel !== null && <Button key={`open-${doc.path}`} label="開く" onPress={() => preview($, doc)} />}
          </Box>
        ))}
      </Box>
    )
  })
}
