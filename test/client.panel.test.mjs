/**
 * Panel layout and interactions.
 *
 * The panel is portalled to `document.body` on purpose: it renders inside the
 * composer's dock slot, whose ancestor (`.wSkVaW_composerSeat`) sets both
 * `z-index` and `will-change: transform`, so no z-index inside that subtree can
 * rise above a floating avatar. These tests pin the portal and the ordering that
 * keeps the primary action on the first screen.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient, walk, textOf, findAll } from './helpers/client.mjs'

/** Render the panel with the store in whatever state the test set up. */
function render(client, session = { sessionId: 's1' }) {
  return client.api.OptimizePanel({ session })
}

/** Every button in the tree, with its visible label. */
function buttons(tree) {
  return findAll(tree, (node) => node.type === 'button').map((node) => ({
    node,
    label: textOf(node.props?.children ?? null).trim(),
    style: node.props?.style || {},
    disabled: node.props?.disabled === true,
  }))
}

/** Depth-first position of the first node matching `predicate`. */
function indexOf(tree, predicate) {
  let index = -1
  let at = 0
  walk(tree, (node) => {
    if (index >= 0) return
    if (predicate(node)) index = at
    at += 1
  })
  return index
}

/** A client with one text model selected and the panel open. */
function openPanel(overrides = {}) {
  const client = createClient()
  client.api.store.set({
    open: true,
    prov: 'p1',
    model: 'm1',
    modelSelected: true,
    providers: [
      { id: 'p1', name: 'Provider one', models: [{ id: 'm1', name: 'Model one', description: 'Fast.' }] },
    ],
    ...overrides,
  })
  return client
}

test('renders nothing while closed', () => {
  const client = createClient()
  client.api.store.set({ open: false })
  assert.equal(render(client), null)
})

test('portals the panel to document.body', () => {
  const client = openPanel()
  render(client)
  assert.equal(client.portalCalls.length, 1)
  assert.equal(client.portalCalls[0].target, client.document.body)
})

test('positions the panel as a fixed overlay above floating widgets', () => {
  const client = openPanel()
  render(client)
  const panel = client.portalCalls[0].node
  assert.equal(panel.props.style.position, 'fixed')
  // Above the avatar (9999) and its help popup (26080), below its confirm masks
  // (32000) which belong to dialogs the user has to answer.
  assert.ok(panel.props.style.zIndex > 26080)
  assert.ok(panel.props.style.zIndex < 32000)
  assert.equal(typeof panel.props.style.maxHeight, 'number')
})

test('states the mode in the header', () => {
  const client = openPanel({ mode: 'system' })
  const text = textOf(render(client))
  assert.match(text, /提示词优化/)
  assert.match(text, /系统提示词/)
})

test('puts the primary action right under the draft, before anything else', () => {
  const client = openPanel()
  const tree = render(client)
  const draft = indexOf(tree, (node) => node.type === 'textarea')
  const primary = indexOf(tree, (node) => node.type === 'button' && /开始优化/.test(textOf(node.props?.children)))
  const modes = indexOf(tree, (node) => node.type === 'button' && /在现有稿上改/.test(textOf(node.props?.children)))
  assert.ok(draft >= 0 && primary > draft, 'the action belongs under the draft')
  assert.ok(primary < modes, 'the action must not be pushed below the settings')
})

test('disables the primary action without a model', () => {
  const client = openPanel({ model: '', prov: '' })
  const tree = render(client)
  const primary = buttons(tree).find((button) => /开始优化/.test(button.label))
  assert.equal(primary.disabled, true)
})

test('offers cancel only while a request is running', () => {
  const idle = openPanel()
  assert.equal(buttons(render(idle)).some((button) => button.label === '取消'), false)

  const busy = openPanel({ busy: true })
  const labels = buttons(render(busy)).map((button) => button.label)
  assert.ok(labels.includes('取消'))
  assert.equal(labels.some((label) => /开始优化/.test(label)), false)
})

test('shows a skeleton instead of the result while busy', () => {
  const client = openPanel({ busy: true, out: '上一次的结果' })
  const text = textOf(render(client))
  assert.match(text, /优化结果/)
  assert.doesNotMatch(text, /上一次的结果/, 'a stale result next to a spinner looks like this run produced it')
})

test('marks a result left over from a failed retry', () => {
  const client = openPanel({ out: '旧结果', stale: true })
  const text = textOf(render(client))
  assert.match(text, /上一次的结果，本次没有成功/)
})

test('surfaces the error above the result', () => {
  const client = openPanel({ err: '优化失败：模型的调用失败了。', out: '旧结果' })
  const tree = render(client)
  const error = indexOf(tree, (node) => typeof node.props?.children === 'string' && /优化失败/.test(node.props.children))
  const result = indexOf(tree, (node) => typeof node.props?.children === 'string' && node.props.children === '旧结果')
  assert.ok(error >= 0 && error < result)
})

test('summarises cost and length under the result', () => {
  const client = openPanel({
    out: '结果正文',
    meta: { elapsedMs: 3200, ttftMs: 800, usage: { outputTokens: 120 }, finish: 'stop' },
  })
  const text = textOf(render(client))
  assert.match(text, /3\.2 秒/)
  assert.match(text, /输出 120 tok/)
  assert.match(text, /首字 0\.8 秒/)
})

test('warns that a truncated result is short', () => {
  const client = openPanel({ out: '半截', meta: { finish: 'max-tokens', truncated: true } })
  assert.match(textOf(render(client)), /截断/)
})

test('reports a context that had to be summarised', () => {
  const client = openPanel({
    out: '结果',
    meta: { contextChars: 18000, summary: { chars: 700, elapsedMs: 4200 } },
  })
  const text = textOf(render(client))
  assert.match(text, /18000 字已摘要为 700 字/)
  assert.match(text, /4\.2 秒/)
})

test('says when the summary was reused instead of rerun', () => {
  const client = openPanel({
    out: '结果',
    meta: { contextChars: 18000, summary: { chars: 700, elapsedMs: 3 } },
  })
  assert.match(textOf(render(client)), /复用上次摘要/)
})

test('reports a failed summary honestly', () => {
  const client = openPanel({ out: '结果', meta: { contextChars: 18000, summaryFailed: true } })
  assert.match(textOf(render(client)), /压缩失败，已按原文发送/)
})

test('renders the model picker with the current name and provider', () => {
  const client = openPanel()
  const text = textOf(render(client))
  assert.match(text, /Model one/)
  assert.match(text, /Provider one/)
  assert.match(text, /1 个提供方/)
})

test('warns about hidden models without offering a retry button', () => {
  const client = openPanel({ hiddenModels: 2, modelsNotice: '已隐藏 2 个非文本模型。' })
  const tree = render(client)
  assert.match(textOf(tree), /已隐藏 2 个非文本模型/)
  // Nothing is wrong, so a reload button next to it would invent a problem.
  assert.equal(buttons(tree).some((button) => /重新加载/.test(button.label)), false)
})

test('offers a reload when the catalog actually failed', () => {
  const client = openPanel({ modelsError: '读取 DSH 模型目录超时。', providers: [] })
  const tree = render(client)
  assert.match(textOf(tree), /超时/)
  assert.ok(buttons(tree).some((button) => /重新加载|重试/.test(button.label)))
})

test('shows the context toggle with its size', () => {
  const client = openPanel({ contextSession: 's1', ctxLen: 1234 })
  const text = textOf(render(client))
  assert.match(text, /对话上下文/)
  assert.match(text, /1234 字/)
})

test('disables the context toggle when there is no session', () => {
  const client = openPanel()
  const tree = render(client, {})
  const box = findAll(tree, (node) => node.type === 'input' && node.props?.type === 'checkbox')[0]
  assert.equal(box.props.disabled, true)
})

test('shows the requested mode description, not a generic one', () => {
  const client = openPanel({ mode: 'iterate' })
  assert.match(textOf(render(client)), /只动你要求的部分/)
})

test('offers quick phrases that feed the requirement field, not the draft', () => {
  const client = openPanel({ mode: 'iterate' })
  const chips = buttons(render(client)).filter((button) => button.label.startsWith('+ '))
  assert.ok(chips.length > 0)
  chipClick(chips[0].node)
  const store = client.api.store
  assert.ok(store.req.length > 0, 'the phrase belongs in the requirement field')
  assert.equal(store.src, '', 'appending it to the draft would rewrite the user\'s own text')
})

/**
 * Invoke a stub-rendered button's click handler.
 *
 * The stub renderer never attaches listeners to a real DOM, so a click is a
 * direct call with a fake event.
 */
function chipClick(node) {
  const handler = node.props.onClick
  assert.equal(typeof handler, 'function')
  handler({ preventDefault() {} })
}

test('the close button closes without clearing work', () => {
  const client = openPanel({ out: '结果', src: '草稿' })
  const close = buttons(render(client)).find((button) => button.label === '×')
  assert.ok(close)
  chipClick(close.node)
  assert.equal(client.api.store.open, false)
  assert.equal(client.api.store.out, '结果')
  assert.equal(client.api.store.src, '草稿')
})

test('the debug toggle reveals what was actually sent', () => {
  const client = openPanel({
    out: '结果',
    debug: { system: 'ROLE TEXT', input: 'INPUT TEXT', reasoning: 'THOUGHTS' },
  })
  chipClick(buttons(render(client)).find((button) => /查看详情/.test(button.label)).node)
  const text = textOf(render(client))
  assert.match(text, /实际发给模型的内容/)
  assert.match(text, /ROLE TEXT/)
  assert.match(text, /INPUT TEXT/)
  assert.match(text, /THOUGHTS/)
})

test('the debug panel explains an empty detail instead of showing a blank box', () => {
  const client = openPanel({ out: '结果', showDebug: true, debug: null })
  assert.match(textOf(render(client)), /没有附带详情/)
})

test('the composer button reflects the open state', () => {
  const client = createClient()
  client.api.store.set({ open: true })
  const open = client.api.OptimizeButton()
  assert.equal(open.props['aria-pressed'], 'true')
  client.api.store.set({ open: false })
  assert.equal(client.api.OptimizeButton().props['aria-pressed'], 'false')
})

test('reopening the button keeps the previous result', () => {
  const client = createClient()
  client.api.store.set({ out: '上一次的结果', src: '我的草稿', err: '旧错误' })
  client.setFetch(async () => ({ status: 200, ok: true, async json() { return { ok: true, providers: [] } } }))
  chipClick(client.api.OptimizeButton())
  const store = client.api.store
  assert.equal(store.open, true)
  // Closing and reopening is an ordinary thing to do; it must not throw work away.
  assert.equal(store.out, '上一次的结果')
  assert.equal(store.src, '我的草稿')
  assert.equal(store.err, '旧错误')
})
