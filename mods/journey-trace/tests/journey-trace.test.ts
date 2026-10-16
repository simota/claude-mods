import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Journey } from '../types'
import { markdownOf, maskedUrl, playwrightOf, refsOf, stepsOf } from '../hooks/journey'

const FIND = ['Found 2 matching elements:', '- ref_12: button "Add to cart"', '- ref_15: textbox "Quantity" (value: 1)'].join('\n')

describe('journey', () => {
  test('reads the elements a find describes', () => {
    expect(refsOf(FIND)).toEqual({ ref_12: { role: 'button', name: 'Add to cart' }, ref_15: { role: 'textbox', name: 'Quantity' } })
  })

  test('turns browser calls into steps, naming elements it knows', () => {
    const refs = refsOf(FIND)
    const steps = (tool: string, input: Record<string, unknown>) => stepsOf(tool, input, refs, 'http://localhost:3000/p/1', 5)
    expect(steps('navigate', { url: 'localhost:3000/p/1' })).toEqual([{ kind: 'goto', url: 'http://localhost:3000/p/1', at: 5 }])
    expect(stepsOf('navigate', { url: 'localhost:5173' }, refs, '', 5)[0]).toMatchObject({ url: 'http://localhost:5173' })
    expect(stepsOf('navigate', { url: 'example.com' }, refs, 'https://example.com/', 5)[0]).toMatchObject({ url: 'https://example.com/' })
    expect(stepsOf('navigate', { url: 'example.com' }, refs, '', 5)[0]).toMatchObject({ url: 'https://example.com' })
    expect(steps('computer', { action: 'left_click', ref: 'ref_12' })[0]).toMatchObject({ kind: 'click', target: { ref: 'ref_12', role: 'button', name: 'Add to cart' } })
    expect(steps('computer', { action: 'left_click', coordinate: [120, 300] })[0]).toMatchObject({ kind: 'click', target: { x: 120, y: 300 } })
    expect(steps('form_input', { ref: 'ref_15', value: '3' })[0]).toMatchObject({ kind: 'fill', value: '3' })
    expect(steps('computer', { action: 'screenshot' })).toEqual([])
    expect(steps('get_page_text', {})).toEqual([])
  })

  const J: Journey = {
    name: 'カートに追加できない',
    startedAt: 1,
    isRecording: true,
    viewport: { width: 1280, height: 800 },
    steps: [
      { kind: 'goto', url: 'http://localhost:3000/p/1', at: 1 },
      { kind: 'fill', target: { ref: 'ref_15', role: 'textbox', name: 'Quantity' }, value: '3', url: '', at: 2 },
      { kind: 'click', target: { ref: 'ref_12', role: 'button', name: 'Add to cart' }, button: 'left', url: '', at: 3 },
      { kind: 'click', target: { x: 10, y: 20 }, button: 'left', url: '', at: 4 },
      { kind: 'key', key: 'Return', url: '', at: 5 },
      { kind: 'expect', text: 'カートに 3 件', url: '', at: 6, by: 'claude' },
    ],
  }

  test('a secret typed or filled is never kept, and the exports say so', () => {
    const refs = { ref_1: { role: 'textbox', name: 'Password' }, ref_2: { role: 'textbox', name: 'Email' }, ref_3: { role: 'textbox', name: 'ワンタイムパスワード' } }
    const fill = stepsOf('form_input', { ref: 'ref_1', value: 'hunter2!' }, refs, 'https://a.test/login', 1)
    const email = stepsOf('form_input', { ref: 'ref_2', value: 'me@a.test' }, refs, 'https://a.test/login', 1)
    const click = stepsOf('computer', { action: 'left_click', ref: 'ref_3' }, refs, 'https://a.test/login', 2)
    const typed = stepsOf('computer', { action: 'type', text: '493021' }, refs, 'https://a.test/login', 3, click[0]?.kind === 'click' ? click[0].target : undefined)
    const token = stepsOf('computer', { action: 'type', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, refs, 'https://a.test/x', 4)
    const go = stepsOf('navigate', { url: 'https://a.test/cb?code=abc&access_token=xyz123&page=2' }, refs, '', 5)
    const j = { name: 'login', startedAt: 0, isRecording: false, steps: [...fill, ...email, ...click, ...typed, ...token, ...go] }
    const all = JSON.stringify(j) + markdownOf(j) + playwrightOf(j)
    for (const secret of ['hunter2!', '493021', 'ghp_abcdefghij', 'xyz123']) expect(all).not.toContain(secret)
    expect(all).toContain('me@a.test')
    expect(all).toContain('page=2')
    expect(playwrightOf(j)).toContain('process.env.JOURNEY_SECRET_1')
    expect(markdownOf(j)).toContain('記録していません')
  })

  test('a password typed after Tab or a click by coordinates, or under a label the list missed, is not kept', () => {
    const typed = (text: string, focus?: Parameters<typeof stepsOf>[5]) => stepsOf('computer', { action: 'type', text }, {}, 'https://a.test/login', 1, focus)
    // Focus unknown (after Tab, a coordinate click): text shaped like a password is masked, plain words are not.
    expect(typed('Tab-Passw0rd!', undefined)[0]).toMatchObject({ text: '***', isSecret: true })
    expect(typed('493021', { x: 5, y: 5 })[0]).toMatchObject({ text: '***', isSecret: true })
    expect(typed('alice', undefined)[0]).toMatchObject({ text: 'alice' })
    expect(typed('me@a.test', undefined)[0]).toMatchObject({ text: 'me@a.test' })
    expect(typed('hello world 2024', undefined)[0]).toMatchObject({ text: 'hello world 2024' })
    const fill = (name: string, role = 'textbox') => stepsOf('form_input', { ref: 'r', value: 'v4lue-X' }, { r: { role, name } }, 'https://a.test/', 1)[0]
    for (const name of ['Verification code', 'MFA code', 'Enter the 6-digit code', 'Recovery code', 'Card number', 'Contraseña', 'Kennwort', 'pwd', 'パスコード', 'Seed phrase', 'Private key'])
      expect(fill(name)).toMatchObject({ isSecret: true })
    for (const name of ['Passport number', 'Passengers', 'Token count', 'Secretary', 'Pin to top', 'Compass heading'])
      expect(fill(name)).not.toMatchObject({ isSecret: true })
    expect(fill('Remember password', 'checkbox')).not.toMatchObject({ isSecret: true })
  })

  test('a URL loses its secrets in the fragment and the path too, and keeps ordinary parameters', () => {
    expect(maskedUrl('https://x.com/#access_token=SECRET1&token_type=bearer')).not.toContain('SECRET1')
    expect(maskedUrl('https://x.com/app#/route?token=SECRET2')).not.toContain('SECRET2')
    expect(maskedUrl('https://x.com/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig')).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(maskedUrl('https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r')).not.toContain('ghp_abcdefghij')
    expect(maskedUrl('https://x.com/a?sessionId=S1&jsessionid=S2&sid=S3&jwt=S4&pwd=S5')).not.toMatch(/S[1-5]/)
    expect(maskedUrl('https://x.com/oauth/callback?code=OAUTHCODE&state=st')).not.toContain('OAUTHCODE')
    expect(maskedUrl('https://shop.test/search?q=shoes&state=CA&code=US&key=blue&page=2')).toBe('https://shop.test/search?q=shoes&state=CA&code=US&key=blue&page=2')
  })

  test('a fill into a select or a checkbox is written as Playwright takes it, and a carriage return stays a valid string', () => {
    const refs = { s: { role: 'combobox', name: 'Country' }, c: { role: 'checkbox', name: 'Agree' } }
    const steps = [
      ...stepsOf('form_input', { ref: 's', value: 'Japan' }, refs, 'https://a.test/', 1),
      ...stepsOf('form_input', { ref: 'c', value: 'true' }, refs, 'https://a.test/', 2),
      ...stepsOf('computer', { action: 'type', text: 'a\r\nb' }, refs, 'https://a.test/', 3, { ref: 'x', role: 'textbox', name: 'Note' }),
      ...stepsOf('navigate', { url: 'https://x.com/cb?token=T' }, refs, '', 4),
    ]
    const test = playwrightOf({ name: 'forms', startedAt: 0, isRecording: false, steps })
    expect(test).toContain(".selectOption('Japan')")
    expect(test).toContain('.check()')
    expect(test).not.toContain('\r')
    expect(test).toMatch(/TODO.*伏せた/)
  })

  test('writes a bug report with numbered steps and the expectations', () => {
    const md = markdownOf(J, 0)
    expect(md).toContain('1. http://localhost:3000/p/1 を開く\n2. 「Quantity」入力欄に「3」を入力\n3. 「Add to cart」ボタンをクリック\n4. 画面座標 (10, 20)をクリック\n5. Enter キーを押す')
    expect(md).toContain('### 期待される結果\n- カートに 3 件')
    expect(md).toContain('- 画面サイズ: 1280×800')
  })

  test('writes a Playwright draft, a TODO where no element is known', () => {
    const ts = playwrightOf(J)
    expect(ts).toContain("await page.goto('http://localhost:3000/p/1')")
    expect(ts).toContain("await page.getByRole('textbox', { name: 'Quantity' }).fill('3')")
    expect(ts).toContain("await page.getByRole('button', { name: 'Add to cart' }).click()")
    expect(ts).toContain('// TODO: 座標 を要素のロケーターに置き換える\n  await page.mouse.click(10, 20)')
    expect(ts).toContain("await page.keyboard.press('Enter')")
    expect(ts).toContain("await expect(page.getByText('カートに 3 件')).toBeVisible()")
  })
})

function world(on: On) {
  const w = { copied: [] as string[] }
  mock.store(on, {})
  mock.clock(on, { now: 1_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { name: 'expect' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } } as never
  })
  on('tool.call', ($, e) => {
    const tool = String(e.tool)
    if (tool.endsWith('__find')) return { result: {}, text: FIND }
    if (tool.endsWith('__navigate')) return { result: {}, text: 'URL: http://localhost:3000/p/1\nTitle: Shop' }
    return { result: {}, text: 'ok' }
  })
  return w
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const run = (args: string) => ({ command: 'journey', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

describe('journey-trace in a session', () => {
  test('records the browser journey and the expectations Claude reports', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.command.run(run('start カートのバグ'))
    await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'http://localhost:3000/p/1', tabId: 1 } as never)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__find', query: 'add button', tabId: 1 } as never)
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'left_click', ref: 'ref_12', tabId: 1 } as never)
    const told = await $.tool.call({ tool: 'mcp__journey-trace__expect', text: 'カートに 1 件と表示される' } as never)
    expect(told.text).toContain('記録しました')

    const md = (await $.command.run(run('md'))).text
    expect(md).toContain('## カートのバグ')
    expect(md).toContain('2. 「Add to cart」ボタンをクリック')
    expect(md).toContain('- カートに 1 件と表示される')
    expect(w.copied[0]).toContain('### 再現手順')

    await $.command.run(run('stop'))
    await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'left_click', coordinate: [1, 1], tabId: 1 } as never)
    expect((await $.command.run(run(''))).text).toBe('⏸ カートのバグ: 3ステップ')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'journey-trace',
        surface,
        component: 'Pane',
        requestId: 'journey-trace',
        props: { title: '操作の記録', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: /2\. 「Add to cart」ボタンをクリック/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /✓ 期待: カートに 1 件/ })).toBeDefined()
      await ui.press({ key: 'e2e' })
      expect(w.copied.at(-1)).toContain("getByRole('button', { name: 'Add to cart' }).click()")
      await ui.unmount()
    }
  })
})
