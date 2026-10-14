import type { On, SessionAppendInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { TodoItem } from '../types'
import {
  addTodos,
  extractTodos,
  isOverwritten,
  MAX_ITEMS,
  MAX_STORE_CHARS,
  MAX_TEXT,
  STORED_TEXT_NOTE,
  unclosedSpan,
  unionItems,
} from '../hooks/todos'

const PROJECT = '/repo/app'
const SURFACES = ['terminal', 'desktop'] as const

function world(on: On, entries: Record<string, unknown> = {}, { store = true } = {}): void {
  if (store) mock.store(on, entries)
  mock.clock(on, { now: 1_000 })
  on('session.repo', () => ({ value: { root: PROJECT, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: `${PROJECT}/src` }))
  on('session.id', () => ({ value: 'session-1' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

function reply(uuid: string, text: string): SessionAppendInput {
  return {
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'test-model' },
    uuid,
  }
}

function todos($: Engine, args: string) {
  return $.command.run({
    command: 'todos',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

function item(id: string, isDone: boolean, createdAt: number): TodoItem {
  return { id, text: id, project: PROJECT, sessionId: 's', createdAt, isDone }
}

describe('extractTodos', () => {
  test('finds each marker line and skips the placeholder', () => {
    const text = [
      'Done.',
      '#TODO(agent): add a regression test for the parser',
      '- `#TODO(agent): <action>`',
      '  #TODO(agent): wire the retry flag`',
    ].join('\n')
    expect(extractTodos(text)).toEqual(['add a regression test for the parser', 'wire the retry flag'])
  })

  test('ignores mentions of the format inside a sentence, table cell or inline code', () => {
    const text = [
      '| **todo-agent** | Claude の返答に出てきた `#TODO(agent): …` を記録 | `/todos` |',
      'Mark follow-ups as `#TODO(agent): <action>` in reports.',
      'See #TODO(agent): not a line start',
      '> - #TODO(agent): quoted bullet counts',
      '1. #TODO(agent): numbered counts',
      '#TODO(agent): …',
    ].join('\n')
    expect(extractTodos(text)).toEqual(['quoted bullet counts', 'numbered counts'])
  })

  test('keeps balanced backticks, strips an unbalanced closing one, and skips the quoted placeholder', () => {
    const text = [
      '#TODO(agent): rename `foo` to `bar`',
      '#TODO(agent): `<action>`',
      '#TODO(agent): wire `retry`',
      '#TODO(agent): drop the flag`',
    ].join('\n')
    expect(extractTodos(text)).toEqual(['rename `foo` to `bar`', 'wire `retry`', 'drop the flag'])
  })

  test(`cuts a long action to ${MAX_TEXT} characters`, () => {
    const [action = ''] = extractTodos(`#TODO(agent): ${'x'.repeat(1000)}`)
    expect(action.length).toBe(MAX_TEXT)
    expect(action.endsWith('…')).toBe(true)
  })

  test('a cut that would split a code span drops the span instead', () => {
    // 290 x, a space, then a 52-character span: the cut at 299 lands inside it.
    const [action = ''] = extractTodos(`#TODO(agent): ${'x'.repeat(290)} \`${'y'.repeat(50)}\``)
    expect(action).toBe(`${'x'.repeat(290)}…`)
  })

  test('a double-backtick span holding a single backtick is kept whole', () => {
    expect(extractTodos('#TODO(agent): use ``code with ` tick``')).toEqual(['use ``code with ` tick``'])
    expect(unclosedSpan('use ``code with ` tick``')).toBe(-1)
    expect(unclosedSpan('drop the flag`')).toBe(13)
  })

  test('skips marker lines inside fenced code blocks', () => {
    const text = [
      '#TODO(agent): before the fence',
      '```markdown',
      '#TODO(agent): an example in a fence',
      '```',
      '~~~~',
      '#TODO(agent): in a tilde fence',
      '```',
      '#TODO(agent): still inside, a backtick line does not close tildes',
      '~~~~',
      '#TODO(agent): after the fences',
    ].join('\n')
    expect(extractTodos(text)).toEqual(['before the fence', 'after the fences'])
  })

  test('union keeps both lists, done winning, and spots a list written over', () => {
    const mine = [item('a', true, 1), item('b', false, 2)]
    const theirs = [item('a', false, 1), item('c', false, 3)]
    const both = unionItems(theirs, mine)
    expect(both.map(one => [one.id, one.isDone])).toEqual([
      ['a', true],
      ['c', false],
      ['b', false],
    ])
    expect(isOverwritten(mine, theirs)).toBe(true)
    expect(isOverwritten(mine, both)).toBe(false)
  })

  test('a done item does not block the same TODO coming back', () => {
    const done = { ...item('old', true, 1), text: 'bump deps' }
    const again = { ...item('new', false, 2), text: 'bump deps' }
    expect(addTodos([done], [again]).map(one => one.id)).toEqual(['old', 'new'])
    const stillOpen = { ...done, isDone: false }
    expect(addTodos([stillOpen], [again]).map(one => one.id)).toEqual(['old'])
  })

  test('keeps the store under its size bound, newest first', () => {
    // 400 items of 3,000 characters is about 1.2M characters, past the 1M bound.
    const items = Array.from({ length: 400 }, (_, i) => ({ ...item(`big-${i}`, false, i), text: `${i} ${'y'.repeat(3000)}` }))
    const kept = addTodos([], items)
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(MAX_STORE_CHARS)
    expect(kept.length).toBeLessThan(400)
    expect(kept.some(one => one.id === 'big-399')).toBe(true)
    expect(kept.some(one => one.id === 'big-0')).toBe(false)
  })

  test('drops done items first past the cap', () => {
    const items = Array.from({ length: MAX_ITEMS }, (_, i) => item(`open-${i}`, i === 0, i))
    const trimmed = addTodos(items, [item('new', false, MAX_ITEMS)])
    expect(trimmed.length).toBe(MAX_ITEMS)
    expect(trimmed.some(one => one.id === 'open-0')).toBe(false)
    expect(trimmed.some(one => one.id === 'new')).toBe(true)
  })
})

describe('todo-agent', () => {
  test('records markers from replies once per project and text', async ($, on) => {
    world(on)
    await $.session.append(reply('u1', '#TODO(agent): rotate the API key\n#TODO(agent): rotate the API key'))
    await $.session.append(reply('u2', 'again\n#TODO(agent): rotate the API key\n#TODO(agent): bump deps'))

    const ran = await todos($, 'all')
    expect(ran.text).toBe(`${STORED_TEXT_NOTE}\n\n${PROJECT} (2)\n  - rotate the API key\n  - bump deps`)
  })

  test("skips a subagent's reply", async ($, on) => {
    world(on)
    await $.session.append({ ...reply('u1', '#TODO(agent): from the subagent'), agentId: 'agent-1' })
    expect((await todos($, 'all')).text).toBe('未完了の TODO(agent) はありません。')
  })

  test('replies appended at once never undo each other', async ($, on) => {
    world(on, { items: [item('first', false, 1)] })
    await Promise.all([
      $.session.append(reply('u1', '#TODO(agent): one')),
      $.session.append(reply('u2', '#TODO(agent): two')),
      $.session.append(reply('u3', '#TODO(agent): three')),
    ])
    const lines = ((await todos($, 'all')).text ?? '').split('\n')
    expect(lines).toContain(`${PROJECT} (4)`)
    for (const text of ['one', 'two', 'three', 'first']) expect(lines).toContain(`  - ${text}`)
  })

  test("another session's write in between is merged, not lost", async ($, on) => {
    world(on, {}, { store: false })
    // Right after this module's first write, another session lands its own list over it.
    const theirs = [{ ...item('theirs', false, 5), text: 'from the other session' }]
    let value: unknown = theirs
    let writes = 0
    on('store.get', () => ({ value }))
    on('store.set', ($, e) => {
      writes += 1
      value = writes === 1 ? theirs : e.value
      return { value: undefined }
    })
    await $.session.append(reply('u1', '#TODO(agent): mine'))

    expect(writes).toBe(2)
    expect((value as TodoItem[]).map(one => one.text).sort()).toEqual(['from the other session', 'mine'])
  })

  test('leaves the row as it came', async ($, on) => {
    world(on)
    const session = mock.session(on)
    await $.session.append(reply('u1', '#TODO(agent): keep me'))
    expect(session.appended()[0]?.message.content).toEqual([{ type: 'text', text: '#TODO(agent): keep me' }])
  })

  test('/todos all lists every project', async ($, on) => {
    world(on, {
      items: [
        { ...item('a', false, 1), text: 'first', project: '/p/one' },
        { ...item('b', true, 2), text: 'finished', project: '/p/one' },
        { ...item('c', false, 3), text: 'second', project: '/p/two' },
      ],
    })
    const ran = await todos($, 'all')
    expect(ran.text).toBe(`${STORED_TEXT_NOTE}\n\n/p/one (1)\n  - first\n\n/p/two (1)\n  - second`)
  })

  for (const surface of SURFACES) {
    test(`the ${surface} pane lists open items and 完了 marks one done`, async ($, on) => {
      world(on, { items: [item('older', false, 1), item('newer', false, 2)] })
      const opened = await todos($, '')
      expect(opened.text).toBe('TODO(agent) ペインを開きました（2 件）。')

      const ui = await $.ui.mount({
        plugin: 'todo-agent',
        surface,
        component: 'Pane',
        requestId: 'todo-agent',
        props: {
          title: 'TODO(agent)',
          isFocused: true,
          bodyColumns: 80,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 20 },
          view: {},
        },
      })
      expect(await ui.find({ type: 'Text', text: /newer/ })).toBeDefined()
      await ui.press({ key: 'done:newer' })

      expect(await ui.find({ type: 'Text', text: /newer/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /older/ })).toBeDefined()
      expect((await todos($, 'all')).text).toBe(`${STORED_TEXT_NOTE}\n\n${PROJECT} (1)\n  - older`)
      await ui.unmount()
    })
  }
})
