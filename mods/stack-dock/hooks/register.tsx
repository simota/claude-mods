import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Doctor, Failure, Http, Run, Service, Stack } from '../types'

import type { Phase } from './devrouter'
import {
  bandKey,
  clockText,
  configPrompt,
  downFeed,
  downFixPrompt,
  downLabel,
  errorLine,
  hasCrashed,
  httpError,
  httpOf,
  isDown,
  isRecovered,
  isStackCommand,
  isStackFile,
  isUp,
  lineSplitter,
  logLine,
  parseComposePs,
  parseDoctor,
  phaseOf,
  stackOf,
  statusText,
  tailOf,
  upFeed,
  upFixPrompt,
} from './devrouter'

const PANE = 'stack-dock'
const PANE_TITLE = 'devrouter'
const STATUS_TOOL = 'mcp__stack-dock__status'
const HTTP_TIMEOUT_MS = 3_000
const DOWN_TAIL = 40
const UP_TAIL = 8

const root = atom({ plugin: 'stack-dock', key: 'root' } as const, null as string | null)
const doctor = atom({ plugin: 'stack-dock', key: 'doctor' } as const, null as Doctor | null)
const stack = atom({ plugin: 'stack-dock', key: 'stack' } as const, null as Stack | null)
const registryNote = atom({ plugin: 'stack-dock', key: 'registryNote' } as const, null as string | null)
const run = atom({ plugin: 'stack-dock', key: 'run' } as const, null as Run | null)
const failure = atom({ plugin: 'stack-dock', key: 'failure' } as const, null as Failure | null)
const hiddenFor = atom({ plugin: 'stack-dock', key: 'hiddenFor' } as const, null as string | null)
const feed = atom({ plugin: 'stack-dock', key: 'feed' } as const, null as string | null)

type Api = EngineInterface

// Set by register from the options; module-local, as a reload runs register again.
let isAuto = false
let stopOnExit = false
let isFeeding = true
let pollMs = 10_000
// The running child's stop and the poll's timer: they die with the module anyway.
let stop: (() => void) | undefined
let isCancelled = false
let cancelPoll: (() => void) | undefined
let isPolling = false
// A file doctor reads was edited this turn: doctor runs again when it ends.
let isDirty = false
// The first poll after a load only learns what is there: no toast for a stack already up.
let isPrimed = false

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const isMissing = (err: unknown) => /\bENOENT\b|no such file or directory|(?:command|executable) not found/i.test(String(err))

async function currentPhase($: Api): Promise<Phase> {
  return phaseOf({ doctor: await read($, doctor), stack: await read($, stack), isRunning: (await read($, run)) !== null, failure: await read($, failure), note: await read($, registryNote) })
}

async function setStatus($: Api) {
  const r = await read($, run)
  const name = basename((await read($, root)) ?? '')
  $.ui.status(r !== null ? `⛵ ${name} 起動中 ${clockText(r.elapsedS)}` : statusText(await currentPhase($), name))
}

async function findRoot($: Api, cwd: string) {
  const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined)
  const top = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  return top === '' ? cwd : top
}

async function hasAny($: Api, dir: string, names: readonly string[]) {
  for (const name of names) {
    if (await $.fs.exists(`${dir}/${name}`)) return true
  }
  return false
}

/** Runs `devrouter doctor` on the root: read-only, and the one source of what up would meet. */
async function refreshDoctor($: Api) {
  const dir = await read($, root)
  if (dir === null) return
  let missing = false
  let executionError: string | undefined
  const ran = await $.process.run(['devrouter', 'doctor', dir], { cwd: dir, timeoutMs: 30_000 }).catch(err => {
    missing = isMissing(err)
    executionError = errorLine(String(err), '')
    return undefined
  })
  const checks = ran === undefined ? [] : parseDoctor(ran.stdout)
  if (ran === undefined && !missing) {
    checks.push({ level: 'error', name: 'doctor', message: executionError ?? '診断を実行できませんでした' })
  } else if (ran !== undefined && ((ran.exitCode !== 0 && !checks.some(c => c.level === 'error')) || checks.length === 0)) {
    checks.push({ level: 'error', name: 'doctor', message: ran.exitCode !== 0 ? errorLine(ran.stderr, ran.stdout) : '診断結果の形式が想定外です（チェックが見つかりません）' })
  }
  const found: Doctor =
    missing
      ? { isInstalled: false, checks: [], hasConfig: false, hasCompose: false, hasWorkspace: false }
      : {
          isInstalled: true,
          checks,
          hasConfig: await hasAny($, dir, ['devrouter.yaml', 'devrouter.yml']),
          hasCompose: await hasAny($, dir, ['docker-compose.yaml', 'docker-compose.yml']),
          hasWorkspace: await hasAny($, dir, ['pnpm-workspace.yaml', 'package.json']),
        }
  await update($, doctor, () => found)
  await setStatus($)
}

async function fetchHttp($: Api, url: string): Promise<Http> {
  const timeout = $.clock.sleep(HTTP_TIMEOUT_MS).then(() => {
    throw new Error('timeout')
  })
  try {
    const answer = await Promise.race([$.http.fetch(url), timeout])
    return httpOf(answer.status, answer.text)
  } catch (err) {
    return httpError(err)
  }
}

async function compose($: Api, file: string, args: string[]) {
  return $.process.run(['docker', 'compose', '-f', file, ...args], { timeoutMs: 15_000 }).catch(() => undefined)
}

/** The root's stack as the registry, Docker and its URLs say it now. */
async function measure($: Api, dir: string): Promise<Stack | null> {
  const home = await $.env.get('HOME')
  let readError: string | null = null
  const text = home === undefined ? undefined : await $.fs.read(`${home}/.devrouter/registry.json`).catch(err => {
    if (!isMissing(err)) readError = `registry.json を読めません: ${errorLine(String(err), '')}`
    return undefined
  })
  if (text === undefined) {
    await update($, registryNote, () => readError)
    return null
  }
  const seen = stackOf(text, dir)
  await update($, registryNote, () => seen.note ?? null)
  if (seen.stack === undefined) return null
  const ps = await compose($, seen.stack.composeFilePath, ['ps', '--all', '--format', 'json'])
  const containers = ps?.exitCode === 0 ? parseComposePs(ps.stdout) : undefined
  if (containers === undefined) {
    await update($, registryNote, () => `docker compose ps を確認できません: ${ps === undefined ? '実行できませんでした' : ps.exitCode !== 0 ? errorLine(ps.stderr, ps.stdout) : '出力の形式が想定外です'}`)
  }
  const services: Service[] = []
  for (const one of seen.stack.services) {
    const container = containers === undefined ? { state: 'unknown' } : (containers.get(one.composeService) ?? { state: 'missing' })
    const http: Http = container.state === 'running' ? await fetchHttp($, one.url) : { kind: 'unchecked' }
    const service: Service = { ...one, ...container, http, tail: [] }
    const logs = container.state === 'missing' || containers === undefined ? undefined : await compose($, seen.stack.composeFilePath, ['logs', '--no-color', '--tail', String(isDown(service) ? DOWN_TAIL : UP_TAIL), one.composeService])
    services.push({ ...service, tail: logs?.exitCode === 0 ? tailOf(`${logs.stdout}\n${logs.stderr}`, isDown(service) ? DOWN_TAIL : UP_TAIL) : [] })
  }
  return { ...seen.stack, services }
}

async function poll($: Api) {
  const dir = await read($, root)
  if (dir === null || isPolling || (await read($, run)) !== null) return
  isPolling = true
  try {
    const before = await read($, stack)
    const wasUnavailable = (await read($, registryNote)) !== null
    const now = await measure($, dir)
    await update($, stack, () => now)
    const failed = await read($, failure)
    if (failed !== null && now !== null && isRecovered(failed, now)) {
      // Brought up since, by Claude or in a terminal: the failure and its feed are over.
      await update($, failure, () => null)
      await update($, feed, waiting => (waiting?.includes('- devrouter up ') === true ? null : waiting))
    }
    // An unavailable measurement proves neither a stop nor a previously known failure.
    if (isPrimed && (await read($, registryNote)) === null) await tell($, wasUnavailable ? null : before, now)
    isPrimed = true
    await setStatus($)
  } finally {
    isPolling = false
  }
}

/** Toasts what changed, and leaves a service going down for the next prompt. */
async function tell($: Api, before: Stack | null, now: Stack | null) {
  if (now !== null && !isUp(before) && isUp(now)) {
    const first = now.services[0]
    $.ui.toast(`⛵ ${now.name} 起動${first === undefined ? '' : ` · ${first.url}`}${now.services.length > 1 ? ` ほか${now.services.length - 1}` : ''}`)
  }
  // A clean stop is different from the last running service crashing.
  if (before !== null && isUp(before) && !isUp(now) && !hasCrashed(now)) {
    $.ui.toast(`⛵ ${before.name} 停止`)
    await update($, feed, () => null)
    return
  }
  if (now === null || (!isUp(now) && !hasCrashed(now))) return
  const wasDown = new Set((before?.services ?? []).filter(isDown).map(s => s.name))
  const down = now.services.filter(isDown)
  const fresh = down.filter(s => !wasDown.has(s.name))
  if (fresh.length > 0) {
    $.ui.toast(`⛵ ${fresh.map(downLabel).join(' · ')}`)
    if (isFeeding) await update($, feed, () => downFeed(now, down))
  }
  if (down.length === 0 && wasDown.size > 0) {
    $.ui.toast(`⛵ ${now.name} 全サービス応答`)
    await update($, feed, () => null)
  }
}

async function refresh($: Api) {
  await refreshDoctor($)
  await poll($)
}

async function tickRun($: Api) {
  const now = await $.clock.now()
  await update($, run, r => (r === null ? r : { ...r, elapsedS: Math.round((now - r.startedAt) / 1000) }))
  await setStatus($)
}

async function bringUp($: Api, isBuild: boolean) {
  const dir = await read($, root)
  if (dir === null) return
  // Decided inside the write, so two presses before the redraw start one child.
  const startedAt = await $.clock.now()
  let isFirst = false
  await update($, run, current => {
    isFirst = current === null
    return current ?? { startedAt, elapsedS: 0, line: 'devrouter up', isBuild }
  })
  if (!isFirst) return
  await update($, failure, () => null)
  await update($, hiddenFor, () => null)
  isCancelled = false

  const tick = $.clock.every(1000, () => void tickRun($))
  const stream = $.process.spawn({ argv: ['devrouter', 'up', ...(isBuild ? ['--build'] : []), dir], cwd: dir })
  stop = () => void stream.return(undefined as never)
  const split = lineSplitter()
  let stdout = ''
  let stderr = ''
  let code: number | null | undefined
  let startError: string | undefined
  try {
    for await (const chunk of stream) {
      if (chunk.stream === 'stderr') stderr = (stderr + chunk.text).slice(-16_000)
      else stdout = (stdout + chunk.text).slice(-16_000)
      const line = split(chunk.text).at(-1)
      if (line !== undefined) await update($, run, r => (r === null ? r : { ...r, line: logLine(line.trim()).slice(0, 200) }))
    }
    code = (await stream.result).code
  } catch (err) {
    startError = /ENOENT|not found|no such file/i.test(String(err)) ? 'devrouter が見つかりません（PATH）' : String(err).slice(0, 200)
  } finally {
    tick.cancel()
    stop = undefined
  }
  await update($, run, () => null)

  if (isCancelled) {
    $.ui.toast('⛵ 止めました: 途中まで起動した可能性があります')
  } else if (startError !== undefined || code !== 0) {
    await refreshDoctor($)
    const checks = (await read($, doctor))?.checks ?? []
    const failed: Failure = { at: await $.clock.now(), error: startError ?? errorLine(stderr, stdout), checks, tail: tailOf(`${stdout}\n${stderr}`, 20) }
    await update($, failure, () => failed)
    if (isFeeding) await update($, feed, () => upFeed(dir, failed))
    $.ui.toast(`⛵ devrouter up 失敗: ${failed.error}`)
  }
  await refresh($)
}

function start($: Api, isBuild = false) {
  // Outlives the press that started it: the loop is the child's life, ended by 止める or the module.
  void bringUp($, isBuild).catch(async err => {
    await update($, run, () => null)
    const at = await $.clock.now()
    await update($, failure, () => ({ at, error: String(err).slice(0, 200), checks: [], tail: [] }))
    await setStatus($)
  })
}

function cancel() {
  isCancelled = true
  stop?.()
}

async function bringDown($: Api) {
  const dir = await read($, root)
  if (dir === null) return
  const ran = await $.process.run(['devrouter', 'down', dir], { cwd: dir, timeoutMs: 120_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (ran.exitCode !== 0) $.ui.toast(`⛵ devrouter down 失敗: ${errorLine(ran.stderr, ran.stdout)}`)
  await update($, failure, () => null)
  await refresh($)
}

async function generateConfig($: Api) {
  const dir = await read($, root)
  if (dir === null) return
  // No --force: an existing devrouter.yaml is the person's.
  const ran = await $.process.run(['devrouter', 'init', dir], { cwd: dir }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  $.ui.toast(ran.exitCode === 0 ? `⛵ ${ran.stdout.trim()}` : `⛵ devrouter init 失敗: ${errorLine(ran.stderr, ran.stdout)}`)
  await refreshDoctor($)
}

async function openService($: Api, s: Stack, service: Service) {
  const ran = await $.process.run(['devrouter', 'open', `${s.id}/${service.name}`]).catch(() => undefined)
  if (ran?.exitCode !== 0) $.ui.toast(`⛵ 開けませんでした: ${service.url}`)
}

async function fillFix($: Api, p: Phase) {
  const dir = (await read($, root)) ?? ''
  const text =
    p.kind === 'failed'
      ? upFixPrompt(dir, p.failure)
      : p.kind === 'degraded'
        ? downFixPrompt(p.stack, p.down)
        : p.kind === 'broken'
          ? upFixPrompt(dir, { at: 0, error: `devrouter doctor: ${p.check.name}: ${p.check.message}`, checks: (await read($, doctor))?.checks ?? [], tail: [] })
          : undefined
  if (text !== undefined) await $.prompt.fill({ text, mode: 'insert' })
}

async function fillConfig($: Api) {
  const dir = (await read($, root)) ?? ''
  await $.prompt.fill({ text: configPrompt(dir, (await read($, doctor))?.hasCompose ?? false), mode: 'insert' })
}

async function openPane($: Api) {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

/** What the status tool answers: the URLs to use, so Claude need not guess a port. */
async function statusOf($: Api) {
  const p = await currentPhase($)
  const s = await read($, stack)
  return {
    root: await read($, root),
    phase: p.kind,
    stack: s?.name ?? null,
    services: (s?.services ?? []).map(one => ({
      name: one.name,
      url: one.url,
      container: one.state,
      http: one.http.kind === 'ok' ? one.http.status : one.http.kind === 'bad' ? one.http.text : one.http.kind,
    })),
    problem: p.kind === 'failed' ? p.failure.error : p.kind === 'broken' ? `${p.check.name}: ${p.check.message}` : p.kind === 'no-docker' || p.kind === 'unavailable' ? p.text : null,
  }
}

export const register: Register = (on, options) => {
  isAuto = options.auto === 'session-start'
  stopOnExit = options.stopOnExit === true
  isFeeding = options.feed !== false
  pollMs = typeof options.pollSec === 'number' ? Math.min(60, Math.max(5, options.pollSec)) * 1000 : 10_000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload killed any child this module had: what it was doing is over.
    await update($, run, () => null)
    isPrimed = false
    await $.command.register({ name: 'stack', description: 'devrouter のスタックをペインで開く' })
    await $.command.register({ name: 'stack-up', description: 'devrouter up でこのリポジトリのスタックを起動する' })
    await $.command.register({ name: 'stack-down', description: 'devrouter down でこのリポジトリのスタックを止める' })
    await $.tool.register({
      name: 'status',
      description:
        "The repository's devrouter stack as stack-dock sees it: each service's URL (https://<stack>-<service>.localtest.me), container state and HTTP status, or why it is not up. Call it before opening or requesting a local service, instead of guessing localhost ports.",
      inputSchema: { type: 'object', properties: {} },
    })
    const dir = await findRoot($, e.cwd)
    await update($, root, () => dir)
    await refresh($)
    cancelPoll?.()
    const timer = $.clock.every(pollMs, () => void poll($).catch(() => undefined))
    cancelPoll = () => timer.cancel()
    if (isAuto && (await currentPhase($)).kind === 'ready') start($)
    return started
  })

  on('session.end', async ($, e, next) => {
    cancelPoll?.()
    if (stopOnExit && (await read($, stack)) !== null) await bringDown($).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && isDirty) {
      isDirty = false
      await refresh($)
    }
    return done
  })

  on('tool.call', { tool: STATUS_TOOL }, async $ => {
    // A registered tool answers as an MCP tool does: text, not an object.
    return { result: JSON.stringify(await statusOf($), null, 2) }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const input = e as unknown as { command?: unknown; file_path?: unknown; notebook_path?: unknown }
    if (e.tool === 'Bash' && typeof input.command === 'string' && isStackCommand(input.command)) {
      void refresh($).catch(() => undefined)
    } else if (typeof input.file_path === 'string' && isStackFile(input.file_path)) {
      isDirty = true
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed at an idle prompt, as pr-lamp does.
    if (!isFeeding || e.origin.kind !== 'composer' || e.command !== undefined || e.isMeta || e.turnId !== undefined) return next(e)
    const waiting = await read($, feed)
    if (waiting === null) return next(e)
    const ran = await next({ ...e, context: [...(e.context ?? []), waiting] })
    // Taken off only once the prompt entered, and only if nothing newer replaced it meanwhile.
    if (ran.drop === undefined) await update($, feed, now => (now === waiting ? null : now)).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'stack' }, async $ => {
    await openPane($)
    return { text: 'devrouter のペインを開きました。' }
  })

  on('command.run', { command: 'stack-up' }, async $ => {
    if ((await read($, run)) !== null) return { text: 'devrouter up はもう走っています。' }
    start($)
    return { text: 'devrouter up を始めました。経過は入力欄の上の帯と /stack に出ます。' }
  })

  on('command.run', { command: 'stack-down' }, async $ => {
    await bringDown($)
    return { text: 'devrouter down を実行しました。' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const p = await currentPhase($)
    const running = await read($, run)
    const closedFor = await read($, hiddenFor)
    const d = await read($, doctor)
    const name = basename((await read($, root)) ?? '')
    const { Box, Button, Text } = $.ui.resolve(e)

    // Stack this row above what the plugins beneath and the engine draw, rather than in its place.
    const below = await next(e)
    if (p.kind === 'none' || p.kind === 'healthy') return below
    if (p.kind !== 'starting' && closedFor === bandKey(p)) return below
    const stack = (row: RenderChildren) => (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
    const close = <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, hiddenFor, () => bandKey(p))} />
    const recheck = <Button key="recheck" label="再確認" onPress={() => refresh($)} />
    const fix = <Button key="fix" label="Claude に頼む" variant="primary" onPress={() => fillFix($, p)} />
    const detail = <Button key="detail" label="詳細" onPress={() => openPane($)} />

    switch (p.kind) {
      case 'starting':
        return stack(
          <Box>
            <Text color="cyan" wrap="truncate-end">
              devrouter 起動中 {clockText(running?.elapsedS ?? 0)} · {running?.line ?? ''}{' '}
            </Text>
            <Button key="cancel" label="止める" onPress={cancel} />
          </Box>,
        )
      case 'no-docker':
        return stack(
          <Box>
            <Text color="yellow" wrap="truncate-end">
              devrouter · Docker が動いていません{' '}
            </Text>
            {recheck}
            {close}
          </Box>,
        )
      case 'unavailable':
        return stack(
          <Box>
            <Text color="yellow" wrap="truncate-end">
              devrouter · 状態を確認できません: {p.text}{' '}
            </Text>
            {recheck}
            {detail}
            {close}
          </Box>,
        )
      case 'unset':
        return stack(
          <Box>
            <Text dimColor wrap="truncate-end">
              devrouter · 未設定（{d?.hasCompose === true ? 'compose あり' : 'workspace あり'}）{' '}
            </Text>
            {d?.hasCompose === true && <Button key="init" label="init で生成" onPress={() => generateConfig($)} />}
            <Button key="config" label="Claude に作らせる" variant="primary" onPress={() => fillConfig($)} />
            {close}
          </Box>,
        )
      case 'broken':
        return stack(
          <Box>
            <Text color="red" wrap="truncate-end">
              devrouter ❌ doctor: {p.check.name}: {p.check.message}{' '}
            </Text>
            {fix}
            {recheck}
            {close}
          </Box>,
        )
      case 'ready':
        return stack(
          <Box>
            <Text dimColor wrap="truncate-end">
              devrouter · {name}
              {p.count === undefined ? '' : ` ${p.count} services`}{' '}
            </Text>
            <Button key="up" label="起動" variant="primary" onPress={() => start($)} />
            {close}
          </Box>,
        )
      case 'failed':
        return stack(
          <Box>
            <Text color="red" wrap="truncate-end">
              devrouter ❌ up 失敗: {p.failure.error}{' '}
            </Text>
            {fix}
            <Button key="retry" label="再試行" onPress={() => start($)} />
            {detail}
            <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, failure, () => null)} />
          </Box>,
        )
      case 'degraded': {
        const [first] = p.down
        return stack(
          <Box>
            <Text color="red" wrap="truncate-end">
              devrouter ❌ {first === undefined ? '' : downLabel(first)}
              {p.down.length > 1 ? ` · ほか${p.down.length - 1}件` : ''}{' '}
            </Text>
            {fix}
            {detail}
            {close}
          </Box>,
        )
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const p = await currentPhase($)
    const s = await read($, stack)
    const d = await read($, doctor)
    const running = await read($, run)
    const note = await read($, registryNote)
    const name = basename((await read($, root)) ?? '')
    const head =
      p.kind === 'none'
        ? d?.isInstalled === false
          ? 'devrouter が PATH にありません（https://github.com/simota/devrouter/releases）'
          : 'devrouter で起動できるものが見つかりません'
        : p.kind === 'starting'
          ? `起動中 ${clockText(running?.elapsedS ?? 0)} · ${running?.line ?? ''}`
          : p.kind === 'failed'
            ? `❌ up 失敗: ${p.failure.error}`
            : p.kind === 'unavailable'
              ? '状態を確認できません'
              : p.kind === 'no-docker'
                ? 'Docker が動いていません'
                : p.kind === 'unset'
                  ? '未設定: devrouter.yaml がありません'
                  : p.kind === 'broken'
                    ? `❌ doctor: ${p.check.name}: ${p.check.message}`
                    : p.kind === 'ready'
                      ? `停止中 · ${name}`
                      : `${p.kind === 'healthy' ? '✅' : '❌'} ${p.stack.name} ${p.stack.services.length - (p.kind === 'degraded' ? p.down.length : 0)}/${p.stack.services.length}`
    const color = (one: Service) => (isDown(one) ? 'red' : one.http.kind === 'unrouted' || one.http.kind === 'tls' ? 'yellow' : 'green')
    const httpText = (h: Http) =>
      h.kind === 'ok' ? `HTTP ${h.status}` : h.kind === 'bad' ? h.text : h.kind === 'unrouted' ? 'ルート不明 (Traefik 404)' : h.kind === 'tls' ? 'HTTP 確認不可（証明書）' : ''

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold wrap="truncate-end">
            {head}{' '}
          </Text>
          {running !== null && <Button key="cancel" label="止める" onPress={cancel} />}
          {running === null && (p.kind === 'ready' || p.kind === 'failed' || s !== null) && (
            <Button key="up" label={s === null ? '起動' : '再起動'} variant="primary" onPress={() => start($)} />
          )}
          {running === null && (p.kind === 'ready' || p.kind === 'failed' || s !== null) && (
            <Button key="build" label="再ビルドして起動" onPress={() => start($, true)} />
          )}
          {running === null && s !== null && <Button key="down" label="停止" onPress={() => bringDown($)} />}
          {running === null && <Button key="doctor" label="doctor" onPress={() => refresh($)} />}
        </Box>
        {note !== null && (
          <Text color="yellow" wrap="truncate-end">
            {note}
          </Text>
        )}
        {s?.services.map(one => (
          // Every line: the engine scrolls the pane's body over a tree taller than it.
          <Box flexDirection="column" key={`s-${one.name}`}>
            <Box>
              <Text color={color(one)} bold wrap="truncate-end">
                {isDown(one) ? '○' : '●'} {one.name}{' '}
              </Text>
              <Button key={`copy-${one.name}`} plain onPress={press => $.ui.copy({ text: one.url, surface: press.surface })}>
                {one.url}
              </Button>
              <Text dimColor wrap="truncate-end">
                {' '}
                {one.state}
                {one.exitCode === undefined ? '' : ` (${one.exitCode})`} {httpText(one.http)}{' '}
              </Text>
              <Button key={`open-${one.name}`} label="開く" onPress={() => openService($, s, one)} />
              {isDown(one) && <Button key={`fix-${one.name}`} label="直させる" onPress={() => $.prompt.fill({ text: downFixPrompt(s, [one]), mode: 'insert' })} />}
            </Box>
            {one.tail.slice(isDown(one) ? -DOWN_TAIL : -UP_TAIL).map((line, i) => (
              <Text key={`t-${one.name}-${i}`} color={/\b(?:error|fatal|panic|exception)\b/i.test(line) ? 'red' : undefined} dimColor wrap="truncate-end">
                {'  '}
                {line}
              </Text>
            ))}
          </Box>
        ))}
        {p.kind === 'failed' &&
          p.failure.tail.map((line, i) => (
            <Text key={`f-${i}`} dimColor wrap="truncate-end">
              {'  '}
              {line}
            </Text>
          ))}
        {d?.checks
          .filter(c => c.level !== 'ok')
          .map((c, i) => (
            <Text key={`c-${i}`} color={c.level === 'error' ? 'red' : 'yellow'} wrap="truncate-end">
              [{c.level.toUpperCase()}] {c.name}: {c.message}
              {c.hint === undefined ? '' : ` — ${c.hint}`}
            </Text>
          ))}
      </Box>
    )
  })
}
