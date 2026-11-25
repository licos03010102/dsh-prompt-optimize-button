/**
 * The click-to-rewrite flow, from the browser half.
 *
 * These tests pin the contract with the server half: what is sent, what a
 * failure does to the result already on screen, and that a cancellation is
 * reported as a cancellation rather than as an error.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient, makeVisible } from './helpers/client.mjs'

/** Put text in the composer and select a model, as the panel would. */
function ready(text = '帮我写个爬虫') {
  const client = createClient()
  const { document } = client
  const input = document.createElement('div')
  input.setAttribute('contenteditable', 'true')
  input.innerText = text
  document.body.appendChild(input)
  makeVisible(input)
  client.api.store.set({
    prov: 'p1',
    model: 'm1',
    modelSelected: true,
    providers: [{ id: 'p1', name: 'One', models: [{ id: 'm1', name: 'Model One' }] }],
  })
  return client
}

/** Answer every request with `payload`; collect what was sent. */
function serve(client, payload, init = {}) {
  const sent = []
  client.setFetch(async (url, options) => {
    sent.push({
      url: String(url),
      method: options?.method || 'GET',
      body: options?.body ? JSON.parse(options.body) : null,
      signal: options?.signal,
    })
    return {
      status: init.status ?? 200,
      ok: (init.status ?? 200) < 400,
      async json() {
        return payload
      },
    }
  })
  return sent
}

test('posts the draft, the mode and the chosen model', async () => {
  const client = ready('帮我写个爬虫')
  const sent = serve(client, { ok: true, text: '改写后的正文', meta: { elapsedMs: 1200 } })
  await client.api.optimize('s1')
  assert.equal(sent.length, 1)
  assert.match(sent[0].url, /\/optimize$/)
  assert.equal(sent[0].method, 'POST')
  const body = sent[0].body
  assert.equal(body.text, '帮我写个爬虫')
  assert.equal(body.mode, 'user')
  assert.equal(body.provider, 'p1')
  assert.equal(body.model, 'm1')
  assert.equal(body.modelName, 'Model One')
  assert.match(body.requestId, /^r[a-z0-9]+$/)
  // Detail is always requested: it costs nothing extra and the panel shows it
  // on demand, so asking per-click would only make the first click expensive.
  assert.equal(body.debug, true)
})

test('never sends the context unless the user attached it', async () => {
  const client = ready()
  const sent = serve(client, { ok: true, text: 'x', meta: {} })
  await client.api.optimize('s1')
  assert.equal(sent[0].body.context, undefined)
})

test('stores the result and the metadata', async () => {
  const client = ready()
  serve(client, {
    ok: true,
    text: '改写后的正文',
    meta: { elapsedMs: 1200, outputTokens: 88, reasoningChars: 12, finish: 'stop' },
  })
  await client.api.optimize('s1')
  const store = client.api.store
  assert.equal(store.out, '改写后的正文')
  assert.equal(store.meta.elapsedMs, 1200)
  assert.equal(store.busy, false)
  assert.equal(store.err, '')
  assert.equal(store.stale, false)
})

test('uses whatever is in the panel when the textarea has content', async () => {
  const client = ready('输入框里的旧文字')
  client.api.store.set({ src: '面板里改过的文字' })
  const sent = serve(client, { ok: true, text: 'x', meta: {} })
  await client.api.optimize('s1')
  assert.equal(sent[0].body.text, '面板里改过的文字')
})

test('refuses to send an empty draft', async () => {
  const client = createClient()
  client.api.store.set({ prov: 'p1', model: 'm1', providers: [{ id: 'p1', name: 'One', models: [{ id: 'm1', name: 'M1' }] }] })
  const sent = serve(client, { ok: true, text: 'x', meta: {} })
  await client.api.optimize('s1')
  assert.equal(sent.length, 0)
  assert.match(client.api.store.err, /先写点东西/)
  assert.equal(client.api.store.busy, false)
})

test('does nothing while another request is running', async () => {
  const client = ready()
  client.api.store.set({ busy: true })
  const sent = serve(client, { ok: true, text: 'x', meta: {} })
  await client.api.optimize('s1')
  assert.equal(sent.length, 0)
})

test('surfaces the backend error text', async () => {
  const client = ready()
  serve(client, { ok: false, error: '「gpt-image」不是文本模型。', code: 'non_text_model' }, { status: 400 })
  await client.api.optimize('s1')
  assert.match(client.api.store.err, /不是文本模型/)
  assert.equal(client.api.store.busy, false)
})

test('a failed run gives the previous result back', async () => {
  const client = ready()
  client.api.store.set({ out: '上一次的结果', meta: { elapsedMs: 900 } })
  serve(client, { ok: false, error: '模型的调用失败了。' }, { status: 502 })
  await client.api.optimize('s1')
  const store = client.api.store
  // Losing a good result because a retry failed is the worst outcome here.
  assert.equal(store.out, '上一次的结果')
  assert.equal(store.stale, true)
  assert.match(store.err, /调用失败/)
})

test('a successful run clears the stale flag', async () => {
  const client = ready()
  client.api.store.set({ out: '旧结果', stale: true })
  serve(client, { ok: true, text: '新结果', meta: {} })
  await client.api.optimize('s1')
  assert.equal(client.api.store.out, '新结果')
  assert.equal(client.api.store.stale, false)
})

test('cancelling aborts the request and tells the server', async () => {
  const client = ready()
  const sent = []
  let abortSignal = null
  client.setFetch(async (url, options) => {
    sent.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null })
    if (String(url).endsWith('/optimize')) {
      abortSignal = options.signal
      // Never resolves: the cancel path is what ends it.
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }
    return { status: 200, ok: true, async json() { return { ok: true, cancelled: true } } }
  })
  const running = client.api.optimize('s1')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(client.api.store.busy, true)
  await client.api.cancel()
  await running
  assert.equal(abortSignal.aborted, true)
  const cancelCall = sent.find((call) => call.url.endsWith('/cancel'))
  assert.ok(cancelCall, 'the server must be told, or the model keeps burning tokens')
  assert.match(cancelCall.body.requestId, /^r/)
  assert.equal(client.api.store.busy, false)
  assert.match(client.api.store.err, /已取消/)
})

test('a 499 from the server counts as a cancellation', async () => {
  const client = ready()
  serve(client, { ok: false, error: '已取消这次优化。', code: 'cancelled' }, { status: 499 })
  await client.api.optimize('s1')
  assert.match(client.api.store.err, /已取消/)
})

test('a truncation warning reaches the panel metadata', async () => {
  const client = ready()
  serve(client, { ok: true, text: '半截正文', meta: { finish: 'max-tokens', truncated: true } })
  await client.api.optimize('s1')
  assert.equal(client.api.store.meta.truncated, true)
  assert.equal(client.api.store.meta.finish, 'max-tokens')
})

test('saves the result so a reload does not lose it', async () => {
  const client = ready()
  serve(client, { ok: true, text: '要留住的结果', meta: { elapsedMs: 10 } })
  await client.api.optimize('s1')
  const saved = client.api.readLast()
  assert.equal(saved.out, '要留住的结果')
  assert.equal(saved.sessionId, 's1')
})

test('reading back a missing record answers null instead of throwing', () => {
  const client = createClient()
  assert.equal(client.api.readLast(), null)
  client.window.sessionStorage.setItem('dpo:last', '{not json')
  assert.equal(client.api.readLast(), null)
})

test('a failed run does not overwrite the saved result', async () => {
  const client = ready()
  client.api.store.set({ out: '保住的结果' })
  serve(client, { ok: false, error: '失败了' }, { status: 502 })
  await client.api.optimize('s1')
  assert.equal(client.api.readLast(), null, 'nothing new was produced, so nothing was saved')
})
