/**
 * Request validation, cancellation and model eligibility.
 *
 * These are the paths a user hits by accident — a stale panel, a model that was
 * removed from the catalog, a draft that grew past the limit — so each one must
 * answer with a stable `code` the client can branch on and a message a human can
 * act on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './helpers/host.mjs'

const ok = { provider: 'p1', model: 'm1', text: 'draft' }

test('rejects an unauthenticated request before anything else', async () => {
  const host = await createHost({ rejection: () => 401 })
  const res = await host.call('/optimize', ok)
  assert.equal(res.status, 401)
  assert.equal(res.payload.code, 'auth')
})

test('auth is checked even for a GET on a POST route', async () => {
  const host = await createHost({ rejection: () => 401 })
  const res = await host.call('/optimize', undefined, { method: 'GET' })
  assert.equal(res.status, 401)
  assert.equal(res.payload.code, 'auth')
})

test('rejects the wrong method', async () => {
  const host = await createHost()
  const res = await host.call('/optimize', undefined, { method: 'GET' })
  assert.equal(res.status, 405)
  assert.equal(res.payload.code, 'method')
})

test('requires a JSON content type', async () => {
  const host = await createHost()
  const res = await host.call('/optimize', ok, { contentType: 'text/plain' })
  assert.equal(res.status, 415)
  assert.equal(res.payload.code, 'bad_content_type')
})

test('rejects a body that is not JSON', async () => {
  const host = await createHost()
  const res = await host.call('/optimize', undefined, { raw: 'not json' })
  assert.equal(res.status, 400)
  assert.equal(res.payload.code, 'bad_json')
})

test('rejects a JSON body that is not an object', async () => {
  for (const raw of ['[1,2]', 'null', '"text"', '3']) {
    const host = await createHost()
    const res = await host.call('/optimize', undefined, { raw })
    assert.equal(res.status, 400, raw)
    assert.equal(res.payload.code, 'bad_json', raw)
  }
})

test('rejects an oversized body', async () => {
  const host = await createHost()
  const res = await host.call('/optimize', ok, { raw: 'x'.repeat(257 * 1024) })
  assert.equal(res.status, 413)
  assert.equal(res.payload.code, 'too_large')
})

test('rejects a non-string or oversized field', async () => {
  const cases = [
    { text: 123 },
    { text: 'x'.repeat(20001) },
    { requirements: 'x'.repeat(20001) },
    { context: 'x'.repeat(24001) },
    { mode: 'x'.repeat(21) },
  ]
  for (const patch of cases) {
    const host = await createHost()
    const res = await host.call('/optimize', { ...ok, ...patch })
    assert.equal(res.status, 400, JSON.stringify(Object.keys(patch)))
    assert.equal(res.payload.code, 'field_invalid', JSON.stringify(Object.keys(patch)))
  }
})

test('an empty draft is reported before the provider is validated', async () => {
  // The panel can send an empty draft when the composer is empty; telling the
  // user "pick a model" first would send them to the wrong control.
  const host = await createHost()
  const res = await host.call('/optimize', { provider: 'nope', model: 'nope', text: '   ' })
  assert.equal(res.status, 400)
  assert.equal(res.payload.code, 'empty_text')
  assert.match(res.payload.error, /先输入/)
})

test('rejects a provider DSH does not list', async () => {
  const host = await createHost()
  const res = await host.call('/optimize', { ...ok, provider: 'ghost' })
  assert.equal(res.status, 400)
  assert.equal(res.payload.code, 'bad_provider')
})

test('rejects a model that is not in the catalog', async () => {
  const host = await createHost()
  const res = await host.call('/optimize', { ...ok, model: 'ghost' })
  assert.equal(res.status, 409)
  assert.equal(res.payload.code, 'model_missing')
})

test('rejects an image model by name', async () => {
  const host = await createHost()
  const res = await host.call('/optimize', { ...ok, model: 'gpt-image-2.6-flare' })
  assert.equal(res.status, 400)
  assert.equal(res.payload.code, 'non_text_model')
  assert.match(res.payload.error, /不是文本模型/)
})

test('rejects a model that declares no text modality', async () => {
  const host = await createHost({ modality: () => ['image'] })
  const res = await host.call('/optimize', ok)
  assert.equal(res.status, 400)
  assert.equal(res.payload.code, 'non_text_model')
  assert.match(res.payload.error, /不接受文本输入/)
})

test('accepts a model that declares text among other modalities', async () => {
  const host = await createHost({ modality: () => ['text', 'image'] })
  const res = await host.call('/optimize', ok)
  assert.equal(res.status, 200)
})

test('accepts a model with unknown modalities', async () => {
  // `inputModalities` absent means unknown, not "no text"; rejecting would
  // break every adapter that does not publish capabilities yet.
  const host = await createHost({ modality: () => undefined })
  const res = await host.call('/optimize', ok)
  assert.equal(res.status, 200)
})

test('a failing listModels is a 503, not a silent empty list', async () => {
  const host = await createHost({
    listModels: async () => {
      throw new Error('boom')
    },
  })
  const res = await host.call('/optimize', ok)
  assert.equal(res.status, 503)
  assert.equal(res.payload.code, 'models_unavailable')
})

test('a model list is cached per provider', async () => {
  let calls = 0
  const host = await createHost({
    listModels: async () => {
      calls += 1
      return [{ id: 'm1', name: 'Model one' }]
    },
  })
  await host.call('/optimize', ok)
  await host.call('/optimize', ok)
  // The panel calls /providers once; the plan is one listModels per provider
  // per minute, not one per rewrite.
  assert.equal(calls, 1)
})

test('cancel aborts the running request', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let sawAbort = false
  const host = await createHost({
    stream: async function* (request) {
      request.signal.addEventListener('abort', () => {
        sawAbort = true
        release()
      })
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await gate
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    },
  })

  const running = host.call('/optimize', { ...ok, requestId: 'r1' })
  // Let the handler reach the stream before cancelling.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const cancelled = await host.call('/cancel', { requestId: 'r1' })
  assert.deepEqual(cancelled.payload, { ok: true, cancelled: true })

  const res = await running
  assert.equal(sawAbort, true)
  assert.equal(res.status, 499)
  assert.equal(res.payload.code, 'cancelled')
})

test('cancel with an unknown id is a no-op', async () => {
  const host = await createHost()
  for (const body of [{ requestId: 'nope' }, {}, { requestId: 42 }]) {
    const res = await host.call('/cancel', body)
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.deepEqual(res.payload, { ok: true, cancelled: false }, JSON.stringify(body))
  }
})

test('cancel without a body is a bad request, like every other route', async () => {
  // The client always posts JSON; an empty body is a malformed call rather than
  // a valid "cancel nothing", and silently accepting it would hide a broken client.
  const host = await createHost()
  const res = await host.call('/cancel', undefined)
  assert.equal(res.status, 400)
  assert.equal(res.payload.code, 'bad_json')
})

test('cancel only affects the request it names', async () => {
  const releases = {}
  const host = await createHost({
    stream: async function* (request) {
      const id = request.messages[0].content[0].text.includes('第一') ? 'a' : 'b'
      await new Promise((resolve) => {
        releases[id] = resolve
      })
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ABORT' } } }
    },
  })

  const a = host.call('/optimize', { ...ok, text: '第一', requestId: 'ra' })
  const b = host.call('/optimize', { ...ok, text: '第二', requestId: 'rb' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  await host.call('/cancel', { requestId: 'ra' })
  releases.a()
  releases.b()

  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.payload.code, 'cancelled')
  // The other request finished on its own terms and was not marked cancelled.
  assert.equal(rb.payload.code, 'model_failed')
})

test('a requestId is echoed back but never required', async () => {
  const host = await createHost()
  const res = await host.call('/optimize', { ...ok, requestId: 'with space' })
  // An invalid id is dropped rather than rejected: it is only a cancel handle.
  assert.equal(res.status, 200)
})

test('a request that finishes is deregistered from the cancel map', async () => {
  const host = await createHost()
  await host.call('/optimize', { ...ok, requestId: 'done' })
  const res = await host.call('/cancel', { requestId: 'done' })
  assert.deepEqual(res.payload, { ok: true, cancelled: false })
})
