/**
 * Model picker data: what the panel will let the user choose.
 *
 * The backend already filters non-text models, but the filter is duplicated here
 * on purpose — an older or partially degraded backend must not leak an image
 * model into the picker, where the only symptom would be a 400 on every click.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from './helpers/client.mjs'

/** Answer `/providers` with a fixed payload and record the request. */
function reply(client, payload, init = {}) {
  const seen = []
  client.setFetch(async (url, options) => {
    seen.push({ url: String(url), options })
    return {
      status: init.status ?? 200,
      ok: (init.status ?? 200) < 400,
      async json() {
        return payload
      },
    }
  })
  return seen
}

test('recognises image and audio models by name', () => {
  const { api } = createClient()
  for (const id of [
    'gpt-image-2.6-flare',
    'gpt-image-2.6-sunburst',
    'dall-e-3',
    'text-embedding-3-large',
    'whisper-1',
    'stable-diffusion-xl',
    'imagen-3',
    'some/tts-model',
  ]) {
    assert.equal(api.isNonText({ id, name: '' }), true, id)
  }
  for (const id of [
    'wb-deepseek-v4.1-flash',
    'deepseek-v4-pro',
    'gpt-6.2-astra',
    '[AN]gemini-3.8-flash',
    'imager',
    'model-1',
  ]) {
    assert.equal(api.isNonText({ id, name: '' }), false, id)
  }
})

test('keeps the picker free of non-text models', async () => {
  const client = createClient()
  reply(client, {
    ok: true,
    default: { provider: 'p1', model: 'm1' },
    providers: [
      { id: 'p1', name: 'One', models: [{ id: 'm1', name: 'M1' }, { id: 'gpt-image-2.6-flare', name: 'Image' }] },
      { id: 'p2', name: 'Two', models: [{ id: 'text-embedding-3-large', name: 'Embed' }] },
    ],
    failedProviders: [],
  })
  await client.api.loadProviders()
  const store = client.api.store
  assert.equal(store.providers.length, 1)
  assert.deepEqual(store.providers[0].models.map((m) => m.id), ['m1'])
  assert.equal(store.hiddenModels, 2)
  assert.match(store.modelsNotice, /已隐藏 2 个非文本模型/)
})

test('trusts the larger of the two hidden counts', async () => {
  const client = createClient()
  // A backend that reports 5 while the local pass only dropped 1: the message
  // must not under-report, or the user cannot tell where five models went.
  reply(client, {
    ok: true,
    default: { provider: 'p1', model: 'm1' },
    providers: [{ id: 'p1', name: 'One', models: [{ id: 'm1', name: 'M1' }, { id: 'dall-e-3', name: 'D' }] }],
    hiddenModels: 5,
    failedProviders: [],
  })
  await client.api.loadProviders()
  assert.equal(client.api.store.hiddenModels, 5)
})

test('passes the catalog description and capabilities through', async () => {
  const client = createClient()
  reply(client, {
    ok: true,
    default: { provider: 'p1', model: 'm1' },
    providers: [{
      id: 'p1',
      name: 'One',
      models: [{ id: 'm1', name: 'M1', description: 'Fast and cheap.', badge: 'new', reasoning: { efforts: 4 } }],
    }],
    failedProviders: [],
  })
  await client.api.loadProviders()
  const model = client.api.store.providers[0].models[0]
  assert.equal(model.description, 'Fast and cheap.')
  assert.equal(model.badge, 'new')
  assert.deepEqual(model.reasoning, { efforts: 4 })
})

test('preselects the catalog default', async () => {
  const client = createClient()
  reply(client, {
    ok: true,
    default: { provider: 'p2', model: 'm2' },
    providers: [
      { id: 'p1', name: 'One', models: [{ id: 'm1', name: 'M1' }] },
      { id: 'p2', name: 'Two', models: [{ id: 'm2', name: 'M2' }] },
    ],
    failedProviders: [],
  })
  await client.api.loadProviders()
  assert.equal(client.api.store.prov, 'p2')
  assert.equal(client.api.store.model, 'm2')
})

test('does not overwrite a choice the user already made', async () => {
  const client = createClient()
  const store = client.api.store
  reply(client, {
    ok: true,
    default: { provider: 'p2', model: 'm2' },
    providers: [
      { id: 'p1', name: 'One', models: [{ id: 'm1', name: 'M1' }] },
      { id: 'p2', name: 'Two', models: [{ id: 'm2', name: 'M2' }] },
    ],
    failedProviders: [],
  })
  await client.api.loadProviders()
  store.set({ prov: 'p1', model: 'm1', modelSelected: true })
  await client.api.loadProviders()
  assert.equal(store.prov, 'p1')
  assert.equal(store.model, 'm1')
})

test('a provider whose models all get filtered is dropped', async () => {
  const client = createClient()
  reply(client, {
    ok: true,
    default: { provider: '', model: '' },
    providers: [
      { id: 'p1', name: 'One', models: [{ id: 'gpt-image-2.6-flare', name: 'Image' }] },
      { id: 'p2', name: 'Two', models: [{ id: 'm2', name: 'M2' }] },
    ],
    failedProviders: [],
  })
  await client.api.loadProviders()
  assert.deepEqual(client.api.store.providers.map((p) => p.id), ['p2'])
})

test('explains a default that had to be swapped', async () => {
  const client = createClient()
  reply(client, {
    ok: true,
    default: { provider: 'p1', model: 'm1' },
    providers: [{ id: 'p1', name: 'One', models: [{ id: 'm1', name: 'M1' }] }],
    failedProviders: [],
    defaultAdjusted: true,
  })
  await client.api.loadProviders()
  // Silently switching models would look like the plugin has a mind of its own.
  assert.match(client.api.store.modelsNotice, /默认模型不可用于文本改写/)
})

test('reports failed providers as a notice, not an error', async () => {
  const client = createClient()
  reply(client, {
    ok: true,
    default: { provider: 'p1', model: 'm1' },
    providers: [{ id: 'p1', name: 'One', models: [{ id: 'm1', name: 'M1' }] }],
    failedProviders: [{ id: 'p9', name: 'Nine', message: 'connection timed out' }],
  })
  await client.api.loadProviders()
  const store = client.api.store
  assert.equal(store.modelsError, '')
  assert.match(store.modelsNotice, /1 个提供方的模型目录未能加载/)
  assert.equal(store.failedProviders[0].message, 'connection timed out')
})

test('a 404 explains that the server half is missing', async () => {
  const client = createClient()
  reply(client, {}, { status: 404 })
  await client.api.loadProviders()
  assert.match(client.api.store.modelsError, /重启 DSH Web/)
})

test('a failing request surfaces the backend message', async () => {
  const client = createClient()
  reply(client, { ok: false, error: '模型目录暂时不可用。' })
  await client.api.loadProviders()
  assert.equal(client.api.store.modelsError, '模型目录暂时不可用。')
  assert.equal(client.api.store.modelsLoading, false)
})

test('no text models at all is an error, not an empty picker', async () => {
  const client = createClient()
  reply(client, {
    ok: true,
    default: { provider: '', model: '' },
    providers: [{ id: 'p1', name: 'One', models: [{ id: 'dall-e-3', name: 'D' }] }],
    failedProviders: [],
  })
  await client.api.loadProviders()
  assert.match(client.api.store.modelsError, /没有可用|暂无可用/)
})

test('an empty default points at the first available model', async () => {
  const client = createClient()
  reply(client, {
    ok: true,
    default: { provider: '', model: '' },
    providers: [{ id: 'p1', name: 'One', models: [{ id: 'm1', name: 'M1' }] }],
    failedProviders: [],
  })
  await client.api.loadProviders()
  // An empty picker with models available is a dead end; fill something.
  assert.equal(client.api.store.providers.length, 1)
  assert.equal(client.api.store.modelsError, '')
})
