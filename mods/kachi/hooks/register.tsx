import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Band, CheckRecord, Edits, Locale, Tier } from '../types'

import type { Classified } from './win'
import type { BashOutcome, Globs } from './win'
import { FRAME_MS, aliveText, classifyOrIgnore, compileGlobs, credit, editsOf, framesFor, isTestPath, localeOf, orNone, resolvePath, scanCommand, stampText, step, sweepFrame, withReceipt } from './win'

// Long enough ago that every cooldown has passed; plain JSON, as -Infinity is not.
const NEVER = -1e15

const checks = atom({ plugin: 'kachi', key: 'checks' } as const, {} as Record<string, CheckRecord>)
const edits = atom({ plugin: 'kachi', key: 'edits' } as const, { seq: 0, codeSeq: 0 } as Edits)
const verifiedSeq = atom({ plugin: 'kachi', key: 'verifiedSeq' } as const, -1)
const commitTick = atom({ plugin: 'kachi', key: 'commitTick' } as const, { at: NEVER, seq: 0 })
const lastClipAt = atom({ plugin: 'kachi', key: 'lastClipAt' } as const, NEVER)
const band = atom({ plugin: 'kachi', key: 'band' } as const, null as Band | null)
const wins = atom({ plugin: 'kachi', key: 'wins' } as const, {} as Record<string, string>)
const nextId = atom({ plugin: 'kachi', key: 'nextId' } as const, 0)
const announced = atom({ plugin: 'kachi', key: 'announced' } as const, [] as string[])
const MAX_ANNOUNCED = 64

const IGNORED: Classified = { kind: 'ignore' }

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
const TIERS = { tick: 1, click: 2, chime: 3, bell: 4 } as const
const GAIN: Record<Tier, number> = { 1: 0.2, 2: 0.35, 3: 0.4, 4: 0.45 }
// A second clip within this long of the last one plays nothing.
const REARM_MS = 20_000
const COMMIT_COOLDOWN_MS = 10 * 60_000
// The stamp stays this long after the turn ends, unless a prompt takes it down first.
const LINGER_MS = 60_000
const NARROW_COLUMNS = 40
// The most of a persisted output read back for its counts: what one $.fs.read copies at most.
const MAX_PERSISTED = 4 * 1024 * 1024
const MAX_RASTER_COLUMNS = 512

const COLOR: Record<Tier, string> = { 1: '#6fae80', 2: '#8fd69a', 3: '#a8efb6', 4: '#c9ffd4' }
const RECEIPT_COLOR = '#6fae80'

type Win = { tier: Tier; kind: Band['kind']; key: string; label: string; where: string; receipt?: string | undefined }

// Motion and timers are the module's own: a reload drops them, and the band then draws its stamp.
let sweep: { id: number; frame: number; timer?: Timer } | undefined
let site: { requestId: string; columns: number } | undefined
let linger: Timer | undefined

function stopSweep(): void {
  sweep?.timer?.cancel()
  sweep = undefined
}

type Config = {
  sound: 'on' | 'quiet' | 'off'
  hasMotion: boolean
  minTier: Tier
  hasCommits: boolean
  /** Read at the first green that could be a win, and kept until the module reloads. */
  locale?: Locale
}

async function localeFor($: EngineInterface, config: Config): Promise<Locale> {
  if (config.locale === undefined) {
    const { language } = await $.settings.read()
    config.locale = localeOf([typeof language === 'string' ? language : undefined, await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')])
  }
  return config.locale
}

/** Takes the band down, and stops its motion, when it still shows the win `id`. */
async function takeDown($: EngineInterface, id: number): Promise<void> {
  if (sweep?.id === id) stopSweep()
  await update($, band, shown => (shown?.id === id ? null : shown))
}

function startSweep($: EngineInterface, id: number, tier: Tier): void {
  stopSweep()
  const total = framesFor(tier)
  const run: { id: number; frame: number; timer?: Timer } = { id, frame: 0 }
  sweep = run
  run.timer = $.clock.every(FRAME_MS, () => {
    if (sweep !== run) return
    run.frame += 1
    if (run.frame >= total) {
      stopSweep()
      void update($, band, shown => (shown?.id === id ? { ...shown, phase: 'stamp' as const } : shown))
      return
    }
    if (site !== undefined) void $.ui.blit({ requestId: site.requestId, key: 'sweep', cells: sweepFrame(site.columns, tier, run.frame) })
  })
}

// The clip goes out on a dispatch of its own, so the Bash result never waits for it.
function play($: EngineInterface, config: Config, tier: Tier): void {
  if (config.sound === 'off' || (config.sound === 'quiet' && tier === 1)) return
  const gain = GAIN[tier] * (config.sound === 'quiet' ? 0.5 : 1)
  $.clock.after(0, () => {
    $.audio.play({ asset: `fx/kachi-${tier - 1}.wav` }, { gain }).catch((error: unknown) => {
      $.ui.log(`kachi: the clip did not play: ${String(error)}`, { to: 'debug' })
    })
  })
}

async function celebrate($: EngineInterface, config: Config, win: Win, toolUseId: string, now: number, locale: Locale): Promise<void> {
  if (win.tier < config.minTier) return
  const receipt = win.receipt
  if (receipt !== undefined) await update($, wins, all => withReceipt(all, toolUseId, receipt))
  // A second win while the stamp shows only upgrades it, and only to a higher tier.
  const shown = await read($, band)
  if (shown !== null && win.tier <= shown.tier) return
  const id = await update($, nextId, n => n + 1)
  const isSweep = config.hasMotion && win.tier >= 2
  await update($, band, () => ({ id, tier: win.tier, kind: win.kind, key: win.key, label: win.label, where: win.where, phase: isSweep ? 'sweep' : 'stamp', locale }))
  if (isSweep) startSweep($, id, win.tier)
  let isRearmed = false
  await update($, lastClipAt, last => {
    isRearmed = now - last >= REARM_MS
    return isRearmed ? now : last
  })
  if (isRearmed) play($, config, win.tier)
}

/** Counts an edit to `paths` (absolute); one outside test files is a code edit, credited to the checks it can fix. */
async function countEdit($: EngineInterface, paths: readonly string[], extraTests: Globs | undefined): Promise<void> {
  if (paths.length === 0) return
  const code = paths.filter(path => !isTestPath(path, extraTests))
  await update($, edits, made => ({ seq: made.seq + 1, codeSeq: code.length > 0 ? made.seq + 1 : made.codeSeq }))
  if (code.length > 0) await update($, checks, all => code.reduce(credit, all) as Record<string, CheckRecord>)
}

async function settle($: EngineInterface, config: Config, classified: Classified, toolUseId: string): Promise<void> {
  if (classified.kind === 'ignore') return
  const now = await $.clock.now()
  const made = await read($, edits)
  if (classified.kind === 'commit') {
    // A clean commit: edits made, a check passed after the last of them, none failed since.
    if (!config.hasCommits || made.seq === 0 || (await read($, verifiedSeq)) !== made.seq) return
    let isTick = false
    await update($, commitTick, last => {
      isTick = last.seq < made.seq && now - last.at >= COMMIT_COOLDOWN_MS
      return isTick ? { at: now, seq: made.seq } : last
    })
    if (isTick) await celebrate($, config, { tier: 1, kind: 'commit', key: '', label: classified.sha, where: '' }, toolUseId, now, await localeFor($, config))
    return
  }
  const locale = classified.kind === 'unread' ? 'en' : await localeFor($, config)
  // Decided inside the write, so two results settling together are judged one after the other.
  let outcome: ReturnType<typeof step> | undefined
  await update($, checks, all => {
    outcome = step(all, classified, made, now, locale)
    return outcome.checks
  })
  if (outcome === undefined) return
  const isGreen = outcome.isGreen
  await update($, verifiedSeq, seq => (isGreen ? made.seq : classified.kind === 'fail' ? -1 : seq))
  if (classified.kind === 'fail') {
    // A green the band still names is no longer true: nor is a commit stamp's "still verified".
    const shown = await read($, band)
    if (shown !== null && (shown.kind === 'commit' || shown.key === classified.check.key)) await takeDown($, shown.id)
    // The first red of a check this session gets one dim line: kachi is here, and what will make it speak.
    if (outcome.isFirstRed === true) {
      const key = classified.check.key
      let isNew = false
      await update($, announced, list => {
        isNew = !list.includes(key)
        return isNew ? [...list, key].slice(-MAX_ANNOUNCED) : list
      })
      if (isNew) await update($, wins, all => withReceipt(all, toolUseId, aliveText(classified.check, locale)))
    }
    return
  }
  if (outcome.win !== undefined) await celebrate($, config, outcome.win, toolUseId, now, locale)
}

export const register: Register = (on, options) => {
  const config: Config = {
    sound: options.sound === 'quiet' || options.sound === 'off' ? options.sound : 'on',
    hasMotion: options.motion !== 'none',
    minTier: TIERS[String(options.minTier) as keyof typeof TIERS] ?? 2,
    hasCommits: options.commits !== false,
  }
  const extraTests = compileGlobs(typeof options.testPaths === 'string' ? options.testPaths : '')

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || e.run_in_background === true) return ran
    const record = ran.isError === true ? undefined : ran.result
    const text = ran.text ?? ''
    const outcome: BashOutcome = {
      command: e.command,
      cwd: await $.session.cwd(),
      isError: ran.isError === true,
      text,
      stdout: record?.stdout ?? '',
      stderr: record?.stderr ?? '',
      // A long failure reaches the model cut short; the stored error text may still hold its summary.
      full: typeof ran.result === 'string' && ran.result.length > text.length ? ran.result : undefined,
      isInterrupted: record?.interrupted === true,
      isBackground: record?.backgroundTaskId !== undefined || record?.timedOutAfterMs !== undefined,
      commit: record?.gitOperation?.commit,
    }
    const scanned = orNone(() => scanCommand(e.command, outcome.cwd), undefined)
    let classified = scanned === undefined ? IGNORED : classifyOrIgnore(outcome, scanned)
    // An output too large to inline keeps its summary in the file the host persisted: read it back
    // only when what came inline gave no count.
    const persisted = record?.persistedOutputPath
    if (persisted !== undefined && (record?.persistedOutputSize ?? MAX_PERSISTED + 1) <= MAX_PERSISTED && (classified.kind === 'unread' || (classified.kind === 'fail' && classified.failCount === undefined))) {
      const full = await $.fs.read(persisted).catch(() => undefined)
      if (typeof full === 'string' && scanned !== undefined) classified = classifyOrIgnore({ ...outcome, full }, scanned)
    }
    const checkIndex = classified.kind === 'pass' || classified.kind === 'fail' || classified.kind === 'unread' ? classified.index : -1
    // Files the command wrote are edits: those before its check come before its verdict.
    const written = outcome.isError || scanned === undefined ? { before: [], after: [] } : editsOf(e.command, scanned, checkIndex)
    await countEdit($, written.before, extraTests)
    await settle($, config, classified, e.tool_use_id)
    await countEdit($, written.after, extraTests)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await countEdit($, [resolvePath(await $.session.cwd(), e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path)], extraTests)
    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta !== true && (await read($, band)) !== null) {
      stopSweep()
      linger?.cancel()
      linger = undefined
      await update($, band, () => null)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const shown = e.agentId === undefined ? await read($, band) : null
    if (shown !== null) {
      linger?.cancel()
      const id = shown.id
      linger = $.clock.after(LINGER_MS, () => {
        linger = undefined
        void update($, band, now => (now?.id === id ? null : now))
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = await read($, band)
    if (shown === null) return next(e)

    // Stack this row above what the plugins beneath and the engine draw, rather than in its place.
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const run = sweep
    if (e.surface === 'terminal' && shown.phase === 'sweep' && columns >= NARROW_COLUMNS && run?.id === shown.id) {
      const { Raster } = $.ui.resolve(e)
      const width = Math.min(columns, MAX_RASTER_COLUMNS)
      site = { requestId: e.requestId, columns: width }
      return (
        <Box flexDirection="column">
          <Raster key="sweep" columns={width} rows={1} cells={sweepFrame(width, shown.tier, run.frame)} />
          {below}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text key="stamp" color={COLOR[shown.tier]} bold={shown.tier === 4} wrap="truncate-end">
          {stampText(shown, columns)}
        </Text>
        {below}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult', props: { tool: 'Bash' } }, async ($, e, next) => {
    const line = (await read($, wins))[e.props.tool_use_id]
    if (line === undefined) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        {/* A receipt is green; the first red's line is plain dim text. */}
        <Text key="receipt" color={line.startsWith('✔') ? RECEIPT_COLOR : undefined} dimColor>
          {line}
        </Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
