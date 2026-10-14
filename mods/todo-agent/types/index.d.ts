export type TodoItem = {
  id: string
  text: string
  project: string
  sessionId: string
  createdAt: number
  isDone: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'todo-agent': { open: TodoItem[] }
  }
}
