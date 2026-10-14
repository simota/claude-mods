import type { EngineInterface, Register } from 'claude-code'

import type { TodoItem } from '../types'
import { addTodos, extractTodos, formatAll, markDone, openFor } from './todos'

const PANE = 'todo-agent'
const STORE_KEY = 'items'
const open = { plugin: 'todo-agent', key: 'open' } as const

async function loadItems($: EngineInterface): Promise<TodoItem[]> {
  return ((await $.store.get(STORE_KEY)) as TodoItem[] | undefined) ?? []
}

async function currentProject($: EngineInterface): Promise<string> {
  return (await $.session.repo())?.root ?? (await $.session.cwd())
}

// Mirrors the current project's open items into $.state and the status line;
// answers how many there are.
async function refresh($: EngineInterface, items: readonly TodoItem[]): Promise<number> {
  const list = openFor(items, await currentProject($))
  await $.state.set(open, list)
  $.ui.status(list.length > 0 ? `TODO(agent): ${list.length}` : undefined)
  return list.length
}

async function save($: EngineInterface, items: TodoItem[]): Promise<void> {
  await $.store.set(STORE_KEY, items)
  await refresh($, items)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todos',
      description: 'TODO(agent) の一覧をペインで開く（all で全プロジェクトを表示）',
      argumentHint: '[all]',
    })
    await refresh($, await loadItems($))

    return next(e)
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.message.type !== 'assistant') return stored

    const texts = e.message.content.flatMap(block =>
      block.type === 'text' && typeof block.text === 'string' ? extractTodos(block.text) : [],
    )
    if (texts.length === 0) return stored

    const [project, sessionId, createdAt] = await Promise.all([
      currentProject($),
      $.session.id(),
      $.clock.now(),
    ])
    const added = texts.map((text, i) => ({
      id: `${e.uuid}:${i}`,
      text,
      project,
      sessionId,
      createdAt,
      isDone: false,
    }))
    await save($, addTodos(await loadItems($), added))

    return stored
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'todos' }, async ($, e) => {
    const items = await loadItems($)
    if (e.args.trim() === 'all') return { text: formatAll(items) }

    const count = await refresh($, items)
    await $.ui.open({ id: PANE, title: 'TODO(agent)' })

    return { text: `TODO(agent) ペインを開きました（${count} 件）。` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value: list = [] } = await $.state.get(open)

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>未完了の TODO(agent) はありません。</Text>}
        {list.map(item => (
          <Box key={item.id} flexDirection="row">
            <Button
              key={`done:${item.id}`}
              label="完了"
              onPress={async () => save($, markDone(await loadItems($), item.id))}
            />
            <Text> {item.text}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
