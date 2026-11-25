/**
 * The browser half's draft plumbing: reading what the user typed and writing a
 * result back into the same editor.
 *
 * Writing back is the fragile part. The composer is a Lexical editor, and
 * assigning `innerText` gets overwritten by the next Lexical render, so the code
 * tries three routes in order of reliability and verifies each by reading the
 * field again. These tests pin that order and the verification.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient, makeVisible } from './helpers/client.mjs'

/** Put a contenteditable composer in the document and return it. */
function mountComposer(client, text = '') {
  const { document } = client
  const mark = document.createElement('div')
  mark.setAttribute('data-composer-input', '')
  const input = document.createElement('div')
  input.setAttribute('contenteditable', 'true')
  input.innerText = text
  mark.appendChild(input)
  document.body.appendChild(mark)
  return makeVisible(input)
}

test('reads the draft from the marked composer', () => {
  const client = createClient()
  mountComposer(client, '帮我写个爬虫')
  assert.equal(client.api.readDraft(), '帮我写个爬虫')
})

test('trims trailing blank lines and normalises non-breaking spaces', () => {
  const client = createClient()
  mountComposer(client, '第一行\u00a0带空格\n\n\n')
  // A trailing newline would make the model think there is more material.
  assert.equal(client.api.readDraft(), '第一行 带空格')
})

test('returns an empty string when there is no composer', () => {
  const client = createClient()
  assert.equal(client.api.readDraft(), '')
})

test('falls back to the last visible contenteditable', () => {
  const client = createClient()
  const { document } = client
  const hidden = document.createElement('div')
  hidden.setAttribute('contenteditable', 'true')
  hidden.innerText = 'hidden'
  document.body.appendChild(hidden)
  const visible = document.createElement('div')
  visible.setAttribute('contenteditable', 'true')
  visible.innerText = 'visible'
  document.body.appendChild(visible)
  makeVisible(visible)
  assert.equal(client.api.readDraft(), 'visible')
})

test('builds a Lexical state with one paragraph per line', () => {
  const state = createClient().api.lexicalState('第一行\n\n第三行')
  assert.equal(state.root.type, 'root')
  assert.equal(state.root.children.length, 3)
  assert.deepEqual(
    state.root.children.map((p) => p.children.map((t) => t.text)),
    [['第一行'], [], ['第三行']],
  )
  assert.equal(state.root.children[0].children[0].type, 'text')
  assert.equal(state.root.children[0].type, 'paragraph')
})

test('prefers the Lexical editor and verifies the result', () => {
  const client = createClient()
  const el = mountComposer(client, 'old')
  // A real Lexical instance re-renders the DOM; here the stub writes innerText
  // and the code reads it back, which is the same contract the real one keeps.
  el.__lexicalEditor = {
    parseEditorState: (state) => state,
    setEditorState: (state) => {
      el.innerText = state.root.children.map((p) => p.children.map((t) => t.text).join('')).join('\n')
    },
  }
  const result = client.api.writeDraft('新内容\n第二行')
  assert.equal(result.ok, true)
  assert.equal(result.how, 'lexical')
  assert.equal(client.api.readDraft(), '新内容\n第二行')
})

test('falls back to a paste event when the editor is not reachable', () => {
  const client = createClient()
  const el = mountComposer(client, 'old')
  el.addEventListener('paste', (event) => {
    el.innerText = event.clipboardData.getData('text/plain')
    event.preventDefault()
  })
  const result = client.api.writeDraft('paste 内容')
  assert.equal(result.ok, true)
  assert.equal(result.how, 'paste')
  assert.equal(client.api.readDraft(), 'paste 内容')
})

test('falls back to execCommand when nothing else works', () => {
  const client = createClient()
  const el = mountComposer(client, 'old')
  client.document.execCommand = (command, _ui, value) => {
    if (command === 'insertText') el.innerText = value
    return true
  }
  const result = client.api.writeDraft('exec 内容')
  assert.equal(result.ok, true)
  assert.equal(result.how, 'execCommand')
  assert.equal(client.api.readDraft(), 'exec 内容')
})

test('reports failure honestly instead of claiming success', () => {
  const client = createClient()
  mountComposer(client, 'old')
  // No Lexical editor, no paste handling, execCommand returns true but changes
  // nothing — exactly the case where a naive implementation would lie.
  client.document.execCommand = () => true
  const result = client.api.writeDraft('新内容')
  assert.equal(result.ok, false)
  assert.equal(result.actual, 'old')
  assert.match(result.how, /没写进去/)
})

test('reports failure when there is no composer at all', () => {
  const client = createClient()
  const result = client.api.writeDraft('新内容')
  assert.equal(result.ok, false)
  assert.match(result.how, /找不到输入框/)
})

test('a Lexical editor that throws falls through to the next route', () => {
  const client = createClient()
  const el = mountComposer(client, 'old')
  el.__lexicalEditor = {
    parseEditorState() {
      throw new Error('lexical is mid-transition')
    },
    setEditorState() {},
  }
  client.document.execCommand = (command, _ui, value) => {
    if (command === 'insertText') el.innerText = value
    return true
  }
  const result = client.api.writeDraft('退到 exec')
  assert.equal(result.ok, true)
  assert.equal(result.how, 'execCommand')
})

test('injects the stylesheet once', () => {
  const client = createClient()
  client.api.ensureCSS()
  client.api.ensureCSS()
  const styles = client.document.querySelectorAll('#dpo-css')
  assert.equal(styles.length, 1)
  assert.match(styles[0].textContent, /\.dpo-panel/)
})
