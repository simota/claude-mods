import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { DEFAULT_ACTIONS, parseActions, slashCommand } from '../hooks/actions'
import { editsFiles } from '../hooks/edits'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'quick-actions',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

type Calls = {
  submitted: string[]
  filled: string[]
  modes: (string | undefined)[]
  ran: string[]
  toasts: string[]
  // Every process the plugin started: it must start none (no git, whose filters run unsandboxed).
  processes: string[][]
  failCommand: boolean
}

// Stands for the engine beneath the plugin, recording what the buttons asked for.
const engine = (on: On): Calls => {
  const calls: Calls = { submitted: [], filled: [], modes: [], ran: [], toasts: [], processes: [], failCommand: false }
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', ($, e) => {
    calls.processes.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', ($, e) => {
    calls.submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    calls.filled.push(e.text)
    calls.modes.push(e.mode)
    return { isFilled: true, box: { text: e.text, cursor: e.text.length } }
  })
  on('command.run', ($, e) => {
    if (calls.failCommand) throw new Error(`unknown command /${e.command}`)
    calls.ran.push(`/${e.command} ${e.args}`.trim())
    return {}
  })
  on('ui.toast', ($, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return calls
}

let turn = 0
const runTurn = async ($: Engine, withEdit: boolean, bash: string[] = []) => {
  const turnId = `t${++turn}`
  await $.turn.start({ text: 'go', turnId })
  if (withEdit) {
    await $.tool.call({ tool: 'Edit', file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' })
  }
  for (const command of bash) await $.tool.call({ tool: 'Bash', command })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

const KEYS = ['action-t', 'action-r', 'action-m', 'action-c', 'dismiss']

const labels = async ($: Engine, surface: (typeof SURFACES)[number]) => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const found = []
  for (const key of KEYS) {
    if ((await ui.find({ key })) !== undefined) {
      found.push(key)
    }
  }
  await ui.unmount()
  return found
}

describe('parseActions', () => {
  test('empty setting uses the defaults', () => {
    expect(parseActions('')).toEqual({ actions: DEFAULT_ACTIONS })
  })

  test('bad JSON, bad shape or a clash falls back with a reason', () => {
    expect(parseActions('{').error).toBeDefined()
    expect(parseActions('[{"key":"x","label":"a","prompt":"b","mode":"submit","when":"always"}]').error).toBeDefined()
    const twice = JSON.stringify([
      { key: 'g', label: 'a', prompt: 'b', mode: 'submit', when: 'always' },
      { key: 'g', label: 'c', prompt: 'd', mode: 'fill', when: 'edits' },
    ])
    expect(parseActions(twice).actions).toEqual(DEFAULT_ACTIONS)
  })

  test('digits and the keys prompt-coach uses are refused', () => {
    for (const key of ['1', '0', 's', 'e', 'q']) {
      const raw = JSON.stringify([{ key, label: 'a', prompt: 'b', mode: 'submit', when: 'always' }])
      expect(parseActions(raw).error).toBeDefined()
    }
  })

  test('the default hotkeys are letters', () => {
    expect(DEFAULT_ACTIONS.map(a => a.key)).toEqual(['t', 'r', 'm', 'c'])
  })

  test('a valid list replaces the defaults', () => {
    const mine = [{ key: 'g', label: 'Go', prompt: 'go', mode: 'submit', when: 'always' }]
    expect(parseActions(JSON.stringify(mine))).toEqual({ actions: mine })
  })

  test('slash prompts become command runs; a prompt opening with a path does not', () => {
    expect(slashCommand('/code-review')).toEqual({ command: 'code-review', args: '' })
    expect(slashCommand('/code-review high')).toEqual({ command: 'code-review', args: 'high' })
    expect(slashCommand('続けて')).toBeUndefined()
    expect(slashCommand('/Users/me/x.png を説明して')).toBeUndefined()
  })
})

test('a turn with edits shows every button, one without only continue', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    await runTurn($, true)
    expect(await labels($, surface)).toEqual(['action-t', 'action-r', 'action-m', 'action-c', 'dismiss'])
    await runTurn($, false)
    expect(await labels($, surface)).toEqual(['action-c', 'dismiss'])
  }
})

describe('editsFiles', () => {
  test('commands that write files', () => {
    for (const command of [
      "sed -i 's/a/b/' src/a.ts",
      "sed -i '' -e 's/a/b/' src/a.ts",
      'sed --in-place s/a/b/ x',
      "perl -pi -e 's/a/b/' x",
      'echo hi > notes.md',
      'echo hi >> notes.md',
      'printf x>out.txt',
      'cat a | tee b.txt',
      'mv a b',
      'cp a b',
      'rm -f build/x',
      'mkdir -p src/new',
      'touch x',
      'patch -p1 < fix.diff',
      'git apply fix.diff',
      'git am 0001.patch',
      'git checkout -- src/a.ts',
      'git restore src/a.ts',
      'git stash pop',
      'git merge feature',
      'git rebase main',
      'git cherry-pick abc123',
      'git revert HEAD',
      'git reset --hard HEAD~1',
      'git -C repo apply x.diff',
      'npm install lodash',
      'pnpm add -D vitest',
      'yarn remove left-pad',
      'yarn',
      'cd app && sed -i s/a/b/ x',
      'bash -c "echo x > y"',
      'echo $(touch x)',
      'sudo -u bob rm x',
    ]) {
      expect([command, editsFiles(command)]).toEqual([command, true])
    }
  })

  test('commands that only read, or write nowhere in the tree', () => {
    for (const command of [
      'ls -la',
      'cat a.ts',
      'grep -rn foo src',
      'sed -n 1,20p a.ts',
      'git status',
      'git diff',
      'git log -n 3',
      'git checkout main',
      'npm test',
      'npm run build > /dev/null',
      'cmd 2>&1',
      'cmd 2>/dev/null',
      'echo "a > b"',
      'yarn test',
      'tee',
      'cat x | tee /dev/null',
    ]) {
      expect([command, editsFiles(command)]).toEqual([command, false])
    }
  })
})

test('files changed through Bash count as edits, read from the command, with no process started', async ($, on) => {
  const calls = engine(on)
  await runTurn($, false, ["sed -i 's/a/b/' src/a.ts"])
  expect(await labels($, 'terminal')).toEqual(['action-t', 'action-r', 'action-m', 'action-c', 'dismiss'])
  await runTurn($, false, ['git status', 'cat src/a.ts'])
  expect(await labels($, 'terminal')).toEqual(['action-c', 'dismiss'])
  expect(calls.processes).toEqual([])
})

test('presses submit, run the slash command, or fill the prompt without wiping a draft', async ($, on) => {
  const calls = engine(on)
  for (const surface of SURFACES) {
    for (const key of ['action-t', 'action-r', 'action-m', 'action-c']) {
      await runTurn($, true)
      const ui = await $.ui.mount({ ...BAND, surface })
      await ui.press({ key })
      await ui.unmount()
    }
  }
  expect(calls.submitted).toEqual([
    DEFAULT_ACTIONS[0]?.prompt, '続けて', DEFAULT_ACTIONS[0]?.prompt, '続けて',
  ])
  expect(calls.ran).toEqual(['/code-review', '/code-review'])
  expect(calls.filled).toEqual(['変更をコミットして', '変更をコミットして'])
  expect(calls.modes).toEqual(['insert', 'insert'])
})

test('a failed action says so and leaves the row up', async ($, on) => {
  const calls = engine(on)
  calls.failCommand = true
  await runTurn($, true)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'action-r' })
  expect(await ui.find({ key: 'action-r' })).toBeDefined()
  await ui.unmount()
  expect(calls.toasts.length).toBe(1)
  expect(calls.toasts[0]).toContain('差分レビュー')
})

test('a press hides the row', async ($, on) => {
  engine(on)
  await runTurn($, true)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'action-c' })).toBeUndefined()
  await ui.unmount()
})

test('the next prompt or turn hides the row', async ($, on) => {
  engine(on)
  await runTurn($, true)
  await $.prompt.submit({ text: 'something else', wait: false, origin: { kind: 'composer' } })
  expect(await labels($, 'terminal')).toEqual([])

  await runTurn($, false)
  await $.turn.start({ text: 'again', turnId: 'next' })
  expect(await labels($, 'terminal')).toEqual([])
})

const ONLY_EDITS = JSON.stringify([{ key: 'g', label: 'Go', prompt: 'go', mode: 'submit', when: 'edits' }])

test('a row that would hold only 閉じる is not drawn', { options: { actions: ONLY_EDITS } }, async ($, on) => {
  engine(on)
  await runTurn($, false)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
  await ui.unmount()
})

test('what the plugins beneath draw stays under the row', async ($, on) => {
  // Registered first, so it answers above the engine's empty band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="below">beneath</Text>
  })
  engine(on)
  await runTurn($, false)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'action-c' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /beneath/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a running turn or a survey keeps the row out', async ($, on) => {
  engine(on)
  await runTurn($, true)
  for (const props of [{ isWorking: true }, { hasSurvey: true }]) {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, ...props } })
    expect(await ui.find({ key: 'action-c' })).toBeUndefined()
    await ui.unmount()
  }
})
