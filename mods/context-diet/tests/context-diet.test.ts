import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { filterListing, isKept, kindsOf, mentioned, parseListing, patternsOf } from '../hooks/profile'

// The listing as the engine words it: a lead-in, one `- name: description` per skill, and a
// description that runs on to a second line.
const LISTING = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- coding-debug: Diagnosing something already broken.',
  '- design-ux: Designing how an interface behaves.',
  '- image-prompt: Writing the generation prompt.',
  '- operation-incident: Running an incident while it is happening.',
  '- persona-define: Design a reviewer before it exists.',
  '- dynamic-scan: Dynamic security testing.',
  '- claude-api: Reference for the Claude API.',
  'TRIGGER — read BEFORE opening the target file.',
  '- anthropic-skills:pdf: Use this skill whenever the user wants to do anything with PDF files.',
  '- clarify: Turning a subjective request into an instruction.',
].join('\n')

type Seen = { contexts: (readonly string[] | undefined)[] }

// The world beneath the plugin: a project at /proj holding `files`, an ios/ folder holding `inner`.
function world(on: On, files: string[], inner: string[] = []): Seen {
  const seen: Seen = { contexts: [] }
  const entry = (name: string, kind: 'file' | 'dir' = 'file') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', ($, e) => ({
    value:
      e.path === '/proj'
        ? [...files.map(name => entry(name)), ...(inner.length > 0 ? [entry('ios', 'dir')] : [])]
        : inner.map(name => entry(name)),
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { window: 200_000 } },
  }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('prompt.submit', ($, e) => {
    seen.contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  return seen
}

const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as const

const RUN = {
  command: 'context-diet',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const listingOf = ($: Engine) =>
  $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })

const names = (text: string | null) => parseListing(text ?? '').entries.map(entry => entry.name)

describe('profile', () => {
  test('reads project kinds from marker files', () => {
    expect(kindsOf(['Cargo.toml', 'README.md'])).toEqual(['rust'])
    expect(kindsOf(['App.xcodeproj', 'build.gradle.kts', 'package.json'])).toEqual(['swift', 'android', 'web'])
    expect(kindsOf(['pyproject.toml', 'go.mod'])).toEqual(['python', 'go'])
    expect(kindsOf(['notes.md'])).toEqual([])
  })

  test('parses entries, keeping continuation lines with their entry', () => {
    const listing = parseListing(LISTING)
    expect(listing.head).toEqual(['The following skills are available for use with the Skill tool:', ''])
    expect(listing.entries.map(entry => entry.name)).toContain('anthropic-skills:pdf')
    expect(listing.entries.find(entry => entry.name === 'claude-api')?.lines).toHaveLength(2)
  })

  test('drops the always-drop families and, outside UI projects, the visual ones', () => {
    const rust = filterListing(LISTING, { kinds: ['rust'], keep: [], drop: [] })
    expect(names(rust.text)).toEqual(['coding-debug', 'claude-api', 'anthropic-skills:pdf', 'clarify'])
    expect(rust.text.startsWith('The following skills are available for use with the Skill tool:\n\n')).toBe(true)
    expect(rust.text).toContain('TRIGGER — read BEFORE opening the target file.')

    const web = filterListing(LISTING, { kinds: ['web'], keep: [], drop: [] })
    expect(names(web.text)).toContain('design-ux')
    expect(names(web.text)).toContain('image-prompt')
    expect(names(web.text)).not.toContain('persona-define')
  })

  test('keep and drop options override the profile, keep winning', () => {
    const rules = { kinds: ['rust' as const], keep: patternsOf('operation-*, design-ux'), drop: patternsOf('pdf,clarify,design-ux') }
    expect(isKept('operation-incident', rules)).toBe(true)
    expect(isKept('design-ux', rules)).toBe(true)
    expect(isKept('anthropic-skills:pdf', rules)).toBe(false)
    expect(isKept('clarify', rules)).toBe(false)
    expect(isKept('persona-define', rules)).toBe(false)
  })

  test('a blank line between entries keeps the entries after it; what follows the last entry is the tail', () => {
    const text = [
      'Skills:',
      '- coding-debug: Diagnosing.',
      '',
      '- persona-define: Design a reviewer.',
      '- clarify: Turning a request.',
      '',
      'Use them well.',
    ].join('\n')
    const listing = parseListing(text)
    expect(listing.entries.map(entry => entry.name)).toEqual(['coding-debug', 'persona-define', 'clarify'])
    expect(listing.tail).toEqual(['', 'Use them well.'])

    const cut = filterListing(text, { kinds: ['rust'], keep: [], drop: [] })
    expect(cut.text).toBe(['Skills:', '- coding-debug: Diagnosing.', '', '- clarify: Turning a request.', '', 'Use them well.'].join('\n'))
  })

  test('a description line shaped like an entry makes the cut uncertain: the listing goes as it came', () => {
    const capital = ['- persona-define: Design a reviewer.', '- Note: continuation bullet', '- coding-debug: Diagnosing.'].join('\n')
    const uncertain = filterListing(capital, { kinds: ['rust'], keep: [], drop: [] })
    expect(uncertain.isUncertain).toBe(true)
    expect(uncertain.text).toBe(capital)
    expect(uncertain.dropped).toEqual([])

    // A lowercase one passes the shape; the session's own commands tell it apart.
    const lower = ['- persona-define: Design a reviewer.', '- note: continuation bullet', '- coding-debug: Diagnosing.'].join('\n')
    const known = new Set(['persona-define', 'coding-debug'])
    expect(filterListing(lower, { kinds: ['rust'], keep: [], drop: [] }, known).text).toBe(lower)
    expect(parseListing(lower).entries.map(entry => entry.name)).toEqual(['persona-define', 'note', 'coding-debug'])
  })

  test('leaves text with no entries as it came', () => {
    const odd = 'Skills: none listed today.'
    expect(filterListing(odd, { kinds: ['rust'], keep: [], drop: [] }).text).toBe(odd)
  })

  test('finds a dropped skill the prompt names, not a longer one', () => {
    const dropped = [{ name: 'persona-define', text: '- persona-define: x' }]
    expect(mentioned('use /persona-define here', dropped)).toHaveLength(1)
    expect(mentioned('persona-define で作って', dropped)).toHaveLength(1)
    expect(mentioned('persona-defined later', dropped)).toHaveLength(0)
  })
})

describe('context-diet in a session', () => {
  test('is off by default: the listing passes untouched', async ($, on) => {
    world(on, ['Cargo.toml'])
    await $.session.start(START)
    expect((await listingOf($)).text).toBe(LISTING)
  })

  test('filters only the listing when enabled, reading kinds below the root', { options: { enabled: true } }, async ($, on) => {
    world(on, ['README.md'], ['Package.swift'])
    await $.session.start(START)

    const { text } = await listingOf($)
    expect(names(text)).toContain('design-ux')
    expect(names(text)).not.toContain('dynamic-scan')

    const other = await $.prompt.attachment({ type: 'todo_reminder', text: '- persona-define: x', origin: { kind: 'engine' } })
    expect(other.text).toBe('- persona-define: x')
  })

  test('describes a named dropped skill beside the prompt', { options: { enabled: true } }, async ($, on) => {
    const seen = world(on, ['Cargo.toml'])
    await $.session.start(START)
    await listingOf($)

    await $.prompt.submit({ text: 'persona-define でレビュアーを作って', origin: { kind: 'composer' }, wait: false })
    await $.prompt.submit({ text: 'ビルドして', origin: { kind: 'composer' }, wait: false })

    expect(seen.contexts[0]?.join('\n')).toContain('- persona-define: Design a reviewer before it exists.')
    expect(seen.contexts[1]).toBeUndefined()
  })

  test('/context-diet reports, and on|off overrides the option for the session', async ($, on) => {
    world(on, ['Cargo.toml'])
    await $.session.start(START)

    const before = await $.command.run({ ...RUN, args: '' })
    expect(before.text).toContain('context-diet: OFF')

    const turnedOn = await $.command.run({ ...RUN, args: 'on' })
    expect(turnedOn.text).toContain('context-diet: ON')

    const { text } = await listingOf($)
    expect(names(text)).not.toContain('operation-incident')

    const report = (await $.command.run({ ...RUN, args: '' })).text ?? ''
    expect(report).toContain('プロジェクト種別: rust')
    expect(report).toContain('省いた: design-ux, image-prompt, operation-incident, persona-define, dynamic-scan')
    expect(report).toMatch(/削減: 約 \d+ tokens（推定: 文字数÷4）/)

    // Switched off and no listing sent since: the earlier cut is not reported as current.
    await $.command.run({ ...RUN, args: 'off' })
    const pending = (await $.command.run({ ...RUN, args: '' })).text ?? ''
    expect(pending).toContain('context-diet: OFF')
    expect(pending).toContain('次のリクエストで skill 一覧を組み直します')
    expect(pending).not.toContain('省いた: design-ux')

    expect((await listingOf($)).text).toBe(LISTING)
    const off = (await $.command.run({ ...RUN, args: '' })).text ?? ''
    expect(off).toContain('直前の skill 一覧は絞り込まずに送りました')
    expect(off).not.toContain('省いた:')
  })

  test('a listing with nothing to drop replaces the earlier report', async ($, on) => {
    world(on, ['package.json'])
    await $.session.start(START)
    await $.command.run({ ...RUN, args: 'on' })
    await listingOf($)
    expect((await $.command.run({ ...RUN, args: '' })).text).toContain('省いた: operation-incident, persona-define, dynamic-scan')

    // Every family kept: the report says so, not what the first listing dropped.
    await $.prompt.attachment({ type: 'skill_listing', text: '- coding-debug: Diagnosing.\n- clarify: Turning a request.', origin: { kind: 'engine' } })
    const report = (await $.command.run({ ...RUN, args: '' })).text ?? ''
    expect(report).toContain('残した skill: 2 件 / 省いた skill: 0 件')
    expect(report).toContain('省いた: なし')
  })

  test('an uncertain listing is sent whole and reported as such', { options: { enabled: true } }, async ($, on) => {
    world(on, ['Cargo.toml'])
    await $.session.start(START)
    const odd = '- persona-define: Design a reviewer.\n- Note: continuation bullet\n- coding-debug: Diagnosing.'
    const sent = await $.prompt.attachment({ type: 'skill_listing', text: odd, origin: { kind: 'engine' } })
    expect(sent.text).toBe(odd)
    expect((await $.command.run({ ...RUN, args: '' })).text).toContain('書式を確実に読み取れなかった')
  })
})
