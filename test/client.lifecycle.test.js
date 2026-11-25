/**
 * Plugin lifecycle: the stylesheet is a resource the plugin owns.
 *
 * `ensureCSS()` writes a `<style>` into `<head>`. It must be registered through
 * `ctx.effect` so disabling or unloading the bundle removes it — otherwise a
 * disabled plugin keeps its rules alive in the page and the next version loads
 * beside a stale copy of the old one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from './helpers/client.mjs'

/** A context just real enough for `apply`: `effect`, `inject` and a slot table. */
function fakeContext() {
  const effects = []
  const registered = []
  const ctx = {
    effect(setup, label) {
      effects.push({ dispose: setup(), label })
    },
    inject(names, callback) {
      assert.deepEqual(names, ['slots'])
      callback({
        slots: {
          inject(_name, run) { run() },
          register(_entry, _component) { registered.push(_entry) },
        },
      })
    },
  }
  return { ctx, effects, registered }
}

test('apply registers both slots under one effect-owned stylesheet', () => {
  const client = createClient()
  const { ctx, effects, registered } = fakeContext()

  client.api.apply(ctx)

  assert.deepEqual(registered.map((entry) => entry.id), ['prompt-optimize', 'prompt-optimize-panel'])
  assert.equal(effects.length, 1)
  assert.match(effects[0].label, /stylesheet/)
  assert.equal(client.document.querySelectorAll('#dpo-css').length, 1)
})

test('disposing the effect removes the stylesheet it installed', () => {
  const client = createClient()
  const { ctx, effects } = fakeContext()

  client.api.apply(ctx)
  assert.equal(client.document.querySelectorAll('#dpo-css').length, 1)

  effects[0].dispose()
  assert.equal(client.document.querySelectorAll('#dpo-css').length, 0)

  // Disposing twice is what an unload-then-error path does; it must stay quiet.
  assert.doesNotThrow(() => effects[0].dispose())
})

test('a second activation installs its own stylesheet again', () => {
  const client = createClient()

  const first = fakeContext()
  client.api.apply(first.ctx)
  first.effects[0].dispose()

  const second = fakeContext()
  client.api.apply(second.ctx)
  assert.equal(client.document.querySelectorAll('#dpo-css').length, 1)
  assert.match(client.document.querySelector('#dpo-css').textContent, /\.dpo-panel/)
})

test('a stylesheet installed by someone else is not removed on dispose', () => {
  const client = createClient()
  const foreign = client.document.createElement('style')
  foreign.id = 'dpo-css'
  foreign.textContent = '.dpo-panel{}'
  client.document.head.appendChild(foreign)

  const { ctx, effects } = fakeContext()
  client.api.apply(ctx)

  effects[0].dispose()
  assert.equal(client.document.querySelectorAll('#dpo-css').length, 1)
  assert.equal(client.document.querySelector('#dpo-css'), foreign)
})

test('apply still works on a host without ctx.effect', () => {
  const client = createClient()
  const registered = []
  client.api.apply({
    inject(_names, callback) {
      callback({
        slots: {
          inject(_name, run) { run() },
          register(entry) { registered.push(entry) },
        },
      })
    },
  })
  assert.equal(registered.length, 2)
  assert.equal(client.document.querySelectorAll('#dpo-css').length, 1)
})
