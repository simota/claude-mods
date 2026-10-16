import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Capsule, CapsuleLog, CapsuleSection } from '../types'
import {
  ago,
  capsuleOf,
  contextOf,
  emptyLog,
  filled,
  isEmpty,
  merged,
  REASON_LABEL,
  SECTION_LABEL,
  SECTIONS,
  sectionLines,
  withAnswer,
  withCommand,
  withFile,
  withPrompt,
  withTodos,
} from './capsule'
import { maskedOf } from './mask'

const PANE = 'handoff-capsule'
const TITLE = '引き継ぎカプセル'
const STORE_KEY = 'capsules'
const PER_ROOT = 5
const ROOTS = 30
const FRESH_MS = 14 * 24 * 60 * 60 * 1000

const log = atom({ plugin: 'handoff-capsule', key: 'log' } as const, emptyLog())
const offer = atom({ plugin: 'handoff-capsule', key: 'offer' } as const, null as { capsule: Capsule; sections: CapsuleSection[] } | null)
const pending = atom({ plugin: 'handoff-capsule', key: 'pending' } as const, null as string | null)
// Whether a person was seen: the REPL, a surface attaching (the desktop app connecting, a phone
// opening the session), a prompt typed or sent from a phone. A session with none (a `-p` run,
// the SDK) keeps one capsule per root, so automated runs never push a person's off the shelf.
const hasPerson = atom({ plugin: 'handoff-capsule', key: 'hasPerson' } as const, false)
// The session's capsule as this process first found it: each later save is laid on it, not on
// what this process kept since, which the log already holds.
const base = atom({ plugin: 'handoff-capsule', key: 'base' } as const, null as { sessionId: string; capsule: Capsule | null } | null)
// What a prompt may come from: typed at the terminal, the desktop app or the SDK host, a phone.
const PROMPTS = new Set(['composer', 'sdk', 'bridge'])

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type Shelf = Record<string, Capsule[]>

// $.store has no versioned write: this module's writes run one after another.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

const shelfOf = async ($: EngineInterface): Promise<Shelf> => ((await $.store.get(STORE_KEY)) as Shelf | undefined) ?? {}

async function rootOf($: EngineInterface): Promise<string> {
  return (await $.session.repo())?.root ?? (await $.session.cwd())
}

async function branchOf($: EngineInterface, root: string): Promise<string | undefined> {
  const ran = await $.process.run(['git', 'branch', '--show-current'], { cwd: root, timeoutMs: 1_000 }).catch(() => undefined)
  return ran?.exitCode === 0 && ran.stdout.trim() !== '' ? ran.stdout.trim() : undefined
}

/** Makes the capsule from what was seen (or a log taken before) and keeps it, newest first, per root. */
async function save(
  $: EngineInterface,
  reason: Capsule['reason'],
  known?: { sessionId: string; skipBranch?: boolean; seen?: CapsuleLog },
): Promise<Capsule | undefined> {
  const root = await rootOf($)
  const at = await $.clock.now()
  const sessionId = known?.sessionId ?? (await $.session.id())
  const branch = known?.skipBranch ? undefined : await branchOf($, root)
  const meta = { id: `${sessionId}:${at}`, at, sessionId, root, reason, byPerson: await read($, hasPerson), ...(branch === undefined ? {} : { branch }) }
  const capsule = capsuleOf(known?.seen ?? (await read($, log)), meta)
  if (isEmpty(capsule)) return undefined
  // One capsule per session and root, laid on the session's capsule as this process first found
  // it (a resumed session's log starts empty); one per root for sessions no person was seen in.
  const found = await read($, base)
  const under = found?.sessionId === sessionId ? found.capsule : ((await shelfOf($))[root] ?? []).find(one => one.sessionId === sessionId) ?? null
  if (found?.sessionId !== sessionId) await update($, base, () => ({ sessionId, capsule: under }))
  const kept = under === null ? capsule : merged(under, capsule)
  const withCapsule = (shelf: Shelf): Shelf => {
    const old = shelf[root] ?? []
    const others = old.filter(one => one.sessionId !== sessionId && (kept.byPerson !== false || one.byPerson !== false))
    const list = [kept, ...others].slice(0, PER_ROOT)
    return Object.fromEntries(
      Object.entries({ ...shelf, [root]: list })
        .sort(([, a], [, b]) => (b[0]?.at ?? 0) - (a[0]?.at ?? 0))
        .slice(0, ROOTS),
    )
  }
  await serial(async () => {
    await $.store.set(STORE_KEY, withCapsule(await shelfOf($)))
    // Another session may have written in between: read back, and add this capsule again on top of theirs.
    const stored = await shelfOf($)
    const again = withCapsule(stored)
    if (JSON.stringify(again) !== JSON.stringify(stored)) await $.store.set(STORE_KEY, again)
  })
  return kept
}

const offerOf = (capsule: Capsule) => ({ capsule, sections: filled(capsule) })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'handoff', description: '引き継ぎカプセル: 表示（/handoff）· 保存（save）· 前回分を取り込む（load）', argumentHint: '[save | load]' })
    if (e.isInteractive) await update($, hasPerson, () => true)
    const started = await next(e)
    if ((await read($, offer)) !== null || (await read($, pending)) !== null) return started
    const sessionId = await $.session.id()
    const now = await $.clock.now()
    const list = (await shelfOf($))[await rootOf($)] ?? []
    // A resumed session has its history and its own capsule: no other is offered.
    if (list.some(one => one.sessionId === sessionId)) return started
    const others = list.filter(one => one.sessionId !== sessionId)
    // A person's capsule before an automated run's.
    const latest = others.find(one => one.byPerson !== false) ?? others[0]
    if (latest !== undefined && now - latest.at < FRESH_MS) await update($, offer, () => offerOf(latest))
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (!PROMPTS.has(e.origin.kind) || e.command !== undefined || e.isMeta) return next(e)
    if (e.origin.kind !== 'sdk') await update($, hasPerson, () => true)
    await update($, log, old => withPrompt(old, e.text))
    const carried = e.turnId === undefined ? await read($, pending) : null
    if (carried === null) return next(e)
    const ran = await next({ ...e, context: [...(e.context ?? []), carried] })
    if (ran.drop === undefined) {
      await update($, pending, () => null)
      $.ui.toast('📦 引き継ぎカプセルを Claude に渡しました')
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A client that draws (the desktop app, a phone) is a person's.
  on('session.attach', async ($, e, next) => {
    await update($, hasPerson, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.answer !== '') await update($, log, old => withAnswer(old, e.answer))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const input = e as unknown as Record<string, unknown>
    if (tool === 'Bash' && typeof input.command === 'string') await update($, log, old => withCommand(old, maskedOf(input.command as string), ran.isError !== true))
    else if (EDIT_TOOLS.has(tool) && ran.isError !== true) {
      const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
      if (path !== undefined) await update($, log, old => withFile(old, path))
    } else if (tool === 'TodoWrite' && input.agentId === undefined) {
      // A subagent's list is its own step, not the session's.
      await update($, log, old => withTodos(old, input.todos))
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the call

  on('session.compact', async ($, e, next) => {
    // A pre-compaction installs nothing: the conversation goes on whole.
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const capsule = await save($, 'compact').catch(() => undefined)
    const done = await next(e)
    // After the compaction the conversation has only its summary: offer the capsule back.
    if (capsule !== undefined && done.skip === undefined) await update($, offer, () => offerOf(capsule))
    return done
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // A /clear or a /resume goes on in this process under another session, with no session.start:
    // the log, and what was chosen for the conversation that ends, are taken now and start afresh.
    const seen = await read($, log)
    const isGoingOn = e.reason === 'clear' || e.reason === 'resume'
    if (isGoingOn) {
      await update($, log, () => emptyLog())
      await update($, offer, () => null)
      await update($, pending, () => null)
    }
    // The end has about a second and a half in all: no git call, the store write alone.
    const capsule = await save($, 'end', { sessionId: e.sessionId, skipBranch: true, seen }).catch(() => undefined)
    // After /clear the person starts afresh in the same place: what was just kept is offered.
    if (e.reason === 'clear' && capsule !== undefined) await update($, offer, () => offerOf(capsule))
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'save') {
      const capsule = await save($, 'manual')
      return { text: capsule === undefined ? '📦 まだ残すものがありません。' : `📦 保存しました: ${filled(capsule).map(s => SECTION_LABEL[s]).join('・')}` }
    }
    if (args === 'load') {
      const sessionId = await $.session.id()
      const list = (await shelfOf($))[await rootOf($)] ?? []
      const latest = list.find(one => one.sessionId !== sessionId) ?? list[0]
      if (latest === undefined) return { text: '📦 このリポジトリのカプセルはありません。' }
      await update($, offer, () => offerOf(latest))
      return { text: `📦 ${ago((await $.clock.now()) - latest.at)}のカプセルを用意しました。プロンプト上の帯で取り込む項目を選んでください。` }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '📦 引き継ぎカプセルを開きました。' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, offer)
    if (e.props.hasSurvey || shown === null) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const has = filled(shown.capsule)
    const toggle = (section: CapsuleSection) =>
      update($, offer, old => (old === null ? null : { ...old, sections: old.sections.includes(section) ? old.sections.filter(s => s !== section) : [...old.sections, section] }))
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan">{`📦 引き継ぎ（${ago(now - shown.capsule.at)}・${REASON_LABEL[shown.capsule.reason]}） `}</Text>
          {has.map(section => (
            <Button key={`s-${section}`} plain label={`${shown.sections.includes(section) ? '☑' : '☐'}${SECTION_LABEL[section]} `} onPress={() => toggle(section)} />
          ))}
          <Button
            key="take"
            variant="primary"
            label="取り込む"
            onPress={async () => {
              const chosen = await read($, offer)
              if (chosen === null || chosen.sections.length === 0) return
              await update($, pending, () => contextOf(chosen.capsule, chosen.sections))
              await update($, offer, () => null)
              $.ui.toast('📦 次のプロンプトと一緒に Claude へ渡します')
            }}
          />
          <Button key="drop" label="破棄" role="dismiss" onPress={() => update($, offer, () => null)} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const sessionId = await $.session.id()
    const shown = (await read($, offer))?.capsule ?? capsuleOf(await read($, log), { id: 'now', at: await $.clock.now(), sessionId, root: await rootOf($), reason: 'manual' })
    const isLive = shown.id === 'now'
    const queued = await read($, pending)
    return (
      <Box flexDirection="column">
        <Text bold>{isLive ? '📦 このセッションで残る内容（保存はまだ）' : `📦 ${new Date(shown.at).toLocaleString()} · ${REASON_LABEL[shown.reason]}${shown.branch ? ` · ${shown.branch}` : ''}`}</Text>
        {queued !== null && <Text color="green">次のプロンプトと一緒に Claude へ渡す内容があります。</Text>}
        {isEmpty(shown) && <Text dimColor>まだ何もありません。</Text>}
        {SECTIONS.filter(section => shown[section].length > 0).map(section => (
          <Box key={section} flexDirection="column">
            <Text color="cyan">{SECTION_LABEL[section]}</Text>
            {sectionLines(shown, section).map((line, index) => (
              <Text key={`${section}-${index}`} wrap="truncate-end">{`  ${line}`}</Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}

