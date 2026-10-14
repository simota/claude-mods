import type { On, SessionAppendInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { TodoItem } from '../types'
import { addTodos, extractTodos, MAX_ITEMS } from '../hooks/todos'

const PROJECT = '/repo/app'
const SURFACES = ['terminal', 'desktop'] as const

function world(on: On, entries: Record<string, unknown> = {}): void {
  mock.store(on, entries)
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
    expect(ran.text).toBe(`${PROJECT} (2)\n  - rotate the API key\n  - bump deps`)
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
    expect(ran.text).toBe('/p/one (1)\n  - first\n\n/p/two (1)\n  - second')
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
      expect((await todos($, 'all')).text).toBe(`${PROJECT} (1)\n  - older`)
      await ui.unmount()
    })
  }
})
