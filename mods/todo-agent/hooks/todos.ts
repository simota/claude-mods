import type { TodoItem } from '../types'

export const MAX_ITEMS = 500

// The marker opens its line, after at most a quote and a list bullet: a mention inside
// a sentence, a table cell or inline code (`#TODO(agent): …`) is talk about the format, not a TODO.
const MARKER = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?#TODO\(agent\):[ \t]*(.+?)[ \t]*$/gm
const PLACEHOLDERS = new Set(['<action>', '…', '...'])

export function extractTodos(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(MARKER)) {
    const action = match[1]?.replace(/`+$/, '').trim()
    if (action && !PLACEHOLDERS.has(action)) found.push(action)
  }
  return found
}

export function addTodos(items: readonly TodoItem[], added: readonly TodoItem[]): TodoItem[] {
  const next = [...items]
  for (const item of added) {
    const isKnown = next.some(one => one.project === item.project && one.text === item.text)
    if (!isKnown) next.push(item)
  }
  return trim(next)
}

export function markDone(items: readonly TodoItem[], id: string): TodoItem[] {
  return items.map(one => (one.id === id ? { ...one, isDone: true } : one))
}

export function openFor(items: readonly TodoItem[], project: string): TodoItem[] {
  return items
    .filter(one => one.project === project && !one.isDone)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function formatAll(items: readonly TodoItem[]): string {
  const open = items.filter(one => !one.isDone)
  if (open.length === 0) return '未完了の TODO(agent) はありません。'
  const byProject = new Map<string, TodoItem[]>()
  for (const item of open) byProject.set(item.project, [...(byProject.get(item.project) ?? []), item])
  return [...byProject]
    .map(([project, list]) =>
      [`${project} (${list.length})`, ...openFor(list, project).map(one => `  - ${one.text}`)].join('\n'),
    )
    .join('\n\n')
}

// Past the cap, done items leave first, oldest first.
function trim(items: TodoItem[]): TodoItem[] {
  if (items.length <= MAX_ITEMS) return items
  const byPriority = [...items].sort(
    (a, b) => Number(a.isDone) - Number(b.isDone) || b.createdAt - a.createdAt,
  )
  const kept = new Set(byPriority.slice(0, MAX_ITEMS).map(one => one.id))
  return items.filter(one => kept.has(one.id))
}
