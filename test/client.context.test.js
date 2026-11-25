/**
 * Reading the conversation the user is currently looking at.
 *
 * The panel can attach recent messages as reference material. There is no API
 * for "what is on screen", so the rendered conversation is read from the DOM,
 * newest turn first, skipping hidden and reasoning nodes, and truncated at the
 * same 24000-character ceiling the backend enforces.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient, makeVisible } from './helpers/client.mjs'

/**
 * Build a conversation container.
 *
 * @param {object} client - harness handle.
 * @param {string} sessionId - id reported by `data-conversation-session`.
 * @param {Array<{turn:number, role:'user'|'assistant', text:string, hidden?:boolean}>} nodes
 */
function mountConversation(client, sessionId, nodes) {
  const { document } = client
  const root = document.createElement('div')
  root.setAttribute('data-conversation-content', '')
  root.setAttribute('data-conversation-session', sessionId)
  for (const node of nodes) {
    const el = document.createElement('div')
    el.setAttribute('data-chat-node-key', String(node.turn) + '-' + node.role + '-' + node.text.slice(0, 6))
    el.setAttribute('data-chat-turn', String(node.turn))
    el.setAttribute(
      'data-chat-flow-kind',
      node.role === 'assistant' ? 'assistant-step' : 'user',
    )
    if (node.hidden) el.setAttribute('hidden', '')
    const bubble = document.createElement('div')
    bubble.setAttribute(node.role === 'assistant' ? 'data-text-interaction-source' : 'data-message-bubble', '')
    bubble.innerText = node.text
    el.appendChild(bubble)
    root.appendChild(el)
    makeVisible(el)
    makeVisible(bubble)
  }
  document.body.appendChild(root)
  makeVisible(root)
  return root
}

test('returns an empty string without a session id', () => {
  const client = createClient()
  mountConversation(client, 's1', [{ turn: 1, role: 'user', text: '你好' }])
  assert.equal(client.api.readContext(''), '')
})

test('returns an empty string when the session is not on screen', () => {
  const client = createClient()
  mountConversation(client, 's1', [{ turn: 1, role: 'user', text: '你好' }])
  assert.equal(client.api.readContext('s2'), '')
})

test('labels who said what', () => {
  const client = createClient()
  mountConversation(client, 's1', [
    { turn: 1, role: 'user', text: '做爬虫' },
    { turn: 1, role: 'assistant', text: '用什么语言' },
  ])
  const context = client.api.readContext('s1')
  assert.match(context, /【我】\n做爬虫/)
  assert.match(context, /【助手】\n用什么语言/)
  // Within a turn the user's message precedes the answer.
  assert.ok(context.indexOf('做爬虫') < context.indexOf('用什么语言'))
})

test('keeps turns in chronological order', () => {
  const client = createClient()
  mountConversation(client, 's1', [
    { turn: 1, role: 'user', text: '第一轮' },
    { turn: 2, role: 'user', text: '第二轮' },
    { turn: 3, role: 'user', text: '第三轮' },
  ])
  const context = client.api.readContext('s1')
  assert.ok(context.indexOf('第一轮') < context.indexOf('第二轮'))
  assert.ok(context.indexOf('第二轮') < context.indexOf('第三轮'))
})

test('skips hidden nodes', () => {
  const client = createClient()
  mountConversation(client, 's1', [
    { turn: 1, role: 'user', text: '可见', },
    { turn: 2, role: 'user', text: '被折叠', hidden: true },
  ])
  const context = client.api.readContext('s1')
  assert.match(context, /可见/)
  assert.doesNotMatch(context, /被折叠/)
})

test('skips reasoning parts inside a node', () => {
  const client = createClient()
  const root = mountConversation(client, 's1', [{ turn: 1, role: 'assistant', text: '正文' }])
  const extra = client.document.createElement('div')
  extra.setAttribute('data-text-interaction-source', '')
  extra.setAttribute('data-variant', 'think')
  extra.innerText = '这是我的思考过程'
  const node = root.firstChild
  node.appendChild(extra)
  makeVisible(extra)
  const context = client.api.readContext('s1')
  assert.match(context, /正文/)
  assert.doesNotMatch(context, /思考过程/)
})

test('skips a node that renders no visible text', () => {
  const client = createClient()
  const root = mountConversation(client, 's1', [{ turn: 1, role: 'user', text: '有内容' }])
  const empty = client.document.createElement('div')
  empty.setAttribute('data-chat-node-key', 'k-empty')
  empty.setAttribute('data-chat-turn', '2')
  empty.setAttribute('data-chat-flow-kind', 'user')
  const bubble = client.document.createElement('div')
  bubble.setAttribute('data-message-bubble', '')
  bubble.innerText = '   '
  empty.appendChild(bubble)
  root.appendChild(empty)
  makeVisible(empty)
  makeVisible(bubble)
  const context = client.api.readContext('s1')
  // An empty bubble would otherwise produce a bare 【我】 heading.
  assert.equal(context, '【我】\n有内容')
})

test('stops after twelve turns, keeping the newest', () => {
  const client = createClient()
  const nodes = Array.from({ length: 20 }, (_, i) => ({
    turn: i + 1,
    role: 'user',
    text: '第 ' + (i + 1) + ' 轮',
  }))
  mountConversation(client, 's1', nodes)
  const context = client.api.readContext('s1')
  assert.match(context, /第 20 轮/)
  assert.doesNotMatch(context, /第 1 轮\n/)
  const turns = context.split('\n\n').filter((line) => line.startsWith('【我】'))
  assert.equal(turns.length, 12)
})

test('truncates an over-long context and says so', () => {
  const client = createClient()
  const nodes = Array.from({ length: 12 }, (_, i) => ({
    turn: i + 1,
    role: 'user',
    text: '第 ' + (i + 1) + ' 轮 ' + 'x'.repeat(3000),
  }))
  mountConversation(client, 's1', nodes)
  const context = client.api.readContext('s1')
  assert.ok(context.length <= 24000, 'must respect the backend ceiling')
  assert.match(context, /更早内容已省略/)
})

test('a single over-long turn is cut with its own marker', () => {
  const client = createClient()
  mountConversation(client, 's1', [{ turn: 1, role: 'user', text: 'y'.repeat(30000) }])
  const context = client.api.readContext('s1')
  assert.ok(context.length <= 24000)
  assert.match(context, /本轮已截断/)
  // The head is what survives: it carries the user's framing.
  assert.match(context, /^【我】\ny+/)
})

test('never cuts a surrogate pair in half', () => {
  const client = createClient()
  // Emoji are two UTF-16 units; a naive slice can leave a lone high surrogate.
  mountConversation(client, 's1', [{ turn: 1, role: 'user', text: '😀'.repeat(15000) }])
  const context = client.api.readContext('s1')
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(context)
  assert.equal(lone, false, 'the tail must not end mid-character')
})

test('ignores a container for another session when both are mounted', () => {
  const client = createClient()
  mountConversation(client, 'old', [{ turn: 1, role: 'user', text: '旧会话' }])
  mountConversation(client, 'new', [{ turn: 1, role: 'user', text: '新会话' }])
  const context = client.api.readContext('new')
  assert.match(context, /新会话/)
  assert.doesNotMatch(context, /旧会话/)
})
