/**
 * `/providers` — what the panel is allowed to offer.
 *
 * The catalog that DSH exposes is not the catalog this plugin can use: image
 * and embedding models are reachable there but useless for rewriting a prompt,
 * and a default entry may itself be one of them. These tests pin the filtering,
 * the pass-through of the fields the picker shows, and the fallback that keeps
 * the panel from opening with no model selected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, sampleCatalog } from './helpers/host.mjs'

test('keeps the HTTP surface the client expects', async () => {
  const host = await createHost()
  assert.deepEqual([...host.routes.keys()].sort(), [
    '/prompt-optimize-button-api/cancel',
    '/prompt-optimize-button-api/optimize',
    '/prompt-optimize-button-api/providers',
  ])
})

test('filters non-text models and reports how many were hidden', async () => {
  const host = await createHost()
  const res = await host.call('/providers', undefined, { method: 'GET' })
  assert.equal(res.status, 200)
  const body = res.payload
  const ids = body.providers.flatMap((group) => group.models.map((m) => group.id + '/' + m.id))
  assert.deepEqual(ids, ['p1/m1'])
  // p1's image model and p2's embedding model both disappeared; p2 then had no
  // models left, so the whole group is gone rather than rendered empty.
  assert.equal(body.hiddenModels, 2)
  assert.deepEqual(body.providers.map((g) => g.id), ['p1'])
})

test('passes through the fields the picker renders', async () => {
  const host = await createHost({
    catalog: () => ({
      default: { provider: 'p9', model: 'rich' },
      groups: [{
        id: 'p9',
        name: 'Rich provider',
        models: [{
          id: 'rich',
          name: 'Rich model',
          description: 'A fast model',
          badge: 'new',
          reasoning: { efforts: ['low', 'medium', 'high'] },
        }],
      }],
      failures: [],
    }),
  })
  const body = (await host.call('/providers', undefined, { method: 'GET' })).payload
  const model = body.providers[0].models[0]
  assert.equal(model.description, 'A fast model')
  assert.equal(model.badge, 'new')
  // Only the count matters to the UI; the effort ids are not rendered.
  assert.deepEqual(model.reasoning, { efforts: 3 })
})

test('normalises missing optional fields to empty strings', async () => {
  const host = await createHost({
    catalog: () => ({
      default: { provider: 'p', model: 'bare' },
      groups: [{ id: 'p', name: 'P', models: [{ id: 'bare', name: 'Bare' }] }],
      failures: [],
    }),
  })
  const model = (await host.call('/providers', undefined, { method: 'GET' })).payload.providers[0].models[0]
  assert.equal(model.description, '')
  assert.equal(model.badge, '')
  assert.equal(model.reasoning, null)
})

test('surfaces provider failures with their message', async () => {
  const host = await createHost({
    catalog: () => ({
      ...sampleCatalog(),
      failures: [
        { id: 'p3', name: 'Broken', message: 'connection timed out' },
        { id: 'p4', name: 'Also broken' },
      ],
    }),
  })
  const body = (await host.call('/providers', undefined, { method: 'GET' })).payload
  assert.deepEqual(body.failedProviders, [
    { id: 'p3', name: 'Broken', message: 'connection timed out' },
    // A non-string message must not leak a non-string into the UI.
    { id: 'p4', name: 'Also broken', message: '' },
  ])
})

test('falls back to the first usable model when the default is filtered out', async () => {
  const host = await createHost({
    catalog: () => ({
      // The user's default model is an image model, so it never reaches the list.
      default: { provider: 'p2', model: 'gpt-image-2.6-flare' },
      groups: [
        { id: 'p1', name: 'One', models: [{ id: 'm1', name: 'Model one' }] },
        { id: 'p2', name: 'Two', models: [{ id: 'gpt-image-2.6-flare', name: 'Image' }] },
      ],
      failures: [],
    }),
  })
  const body = (await host.call('/providers', undefined, { method: 'GET' })).payload
  assert.deepEqual(body.default, { provider: 'p1', model: 'm1' })
  assert.equal(body.defaultAdjusted, true)
})

test('keeps the default when it survives filtering', async () => {
  const host = await createHost()
  const body = (await host.call('/providers', undefined, { method: 'GET' })).payload
  assert.deepEqual(body.default, { provider: 'p1', model: 'm1' })
  assert.equal(body.defaultAdjusted, false)
})

test('reports an empty list without a default when nothing is usable', async () => {
  const host = await createHost({
    catalog: () => ({
      default: { provider: 'p2', model: 'text-embedding-3-large' },
      groups: [{ id: 'p2', name: 'Two', models: [{ id: 'text-embedding-3-large', name: 'Embedding' }] }],
      failures: [],
    }),
  })
  const body = (await host.call('/providers', undefined, { method: 'GET' })).payload
  assert.deepEqual(body.providers, [])
  assert.equal(body.hiddenModels, 1)
  assert.deepEqual(body.default, { provider: '', model: '' })
  assert.equal(body.defaultAdjusted, false)
})

test('a failing catalog is an error, not an empty success', async () => {
  const host = await createHost({
    catalog: () => {
      throw new Error('catalog unavailable')
    },
  })
  const res = await host.call('/providers', undefined, { method: 'GET' })
  assert.notEqual(res.status, 200)
  assert.equal(res.payload.ok, false)
})
