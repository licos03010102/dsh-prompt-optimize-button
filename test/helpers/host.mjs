/**
 * Fake host harness for the bundle's host half.
 *
 * `lib/index.js` talks to four services (`webServer`, `connection`,
 * `sessionController`, `llm`) and never to the network itself, so the whole
 * backend can be driven without booting DSH. This file builds the smallest
 * host that satisfies those four and hands back the route table, so each test
 * can invoke a route exactly like the HTTP layer does.
 *
 * The `llm.stream` default is a scripted stream: tests that care about the
 * prompt or the response handling override it. Nothing here reaches the
 * network, which is what keeps `npm test` runnable offline.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** Absolute path to the host-half module under test. */
export const ENTRY = join(here, '..', '..', 'lib', 'index.js')

/** Prefix every route of this bundle is registered under. */
export const PREFIX = '/prompt-optimize-button-api'

/**
 * Load the host half.
 *
 * The package is ESM, so the module is imported rather than required; the
 * `require` above is only used for the JSON fixtures.
 */
let generation = 0

export async function loadPlugin(options = {}) {
  // A unique query string forces Node to re-evaluate the module, so every host
  // gets its own `modelCache` / `summaryCache` / `running` maps. Test isolation
  // beats the tiny re-compile cost, and it removes ordering coupling between
  // tests that change what `listModels` answers.
  if (options.fresh === false) return await import(ENTRY)
  generation += 1
  return await import(`${ENTRY}?v=${generation}`)
}

/** A catalog with text models, image models, an embedding model and a failure. */
export function sampleCatalog() {
  return {
    default: { provider: 'p1', model: 'm1' },
    groups: [
      {
        id: 'p1',
        name: 'Provider one',
        models: [
          { id: 'm1', name: 'Model one' },
          { id: 'gpt-image-2.6-flare', name: 'GPT Image 2.6 Flare' },
        ],
      },
      {
        id: 'p2',
        name: 'Provider two',
        models: [{ id: 'text-embedding-3-large', name: 'Embedding 3 Large' }],
      },
    ],
    failures: [],
  }
}

/** Minimal `IncomingMessage` stand-in: content-type plus a byte iterator. */
export function fakeRequest(body, options = {}) {
  const raw = options.raw !== undefined ? options.raw : body === undefined ? undefined : JSON.stringify(body)
  const chunks = raw === undefined ? [] : [Buffer.from(raw)]
  return {
    method: options.method || 'POST',
    headers: { 'content-type': options.contentType || 'application/json' },
    resume() {},
    async *iterator() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Minimal `ServerResponse` stand-in: records status and the JSON payload. */
export function fakeResponse() {
  const res = {
    destroyed: false,
    writableEnded: false,
    status: 0,
    payload: null,
    writeHead(status) {
      res.status = status
    },
    end(text) {
      res.writableEnded = true
      try {
        res.payload = JSON.parse(text)
      } catch {
        res.payload = text
      }
    },
    on() {},
    off() {},
  }
  return res
}

/**
 * Build a fake host context and apply the plugin to it.
 *
 * @param {object} [options]
 * @param {() => object} [options.catalog] - model catalog source.
 * @param {() => AsyncIterable} [options.stream] - replaces `llm.stream`.
 * @param {() => number|undefined} [options.rejection] - `connection.requestRejection` result.
 * @returns {Promise<{routes: Map<string, Function>, ctx: object, calls: object[], llm: object,
 *   sessionController: object, call: Function}>} the mounted host.
 */
export async function createHost(options = {}) {
  const plugin = await loadPlugin({ fresh: options.fresh })
  const routes = new Map()
  const calls = []
  const state = {
    rejection: options.rejection || (() => undefined),
    catalog: options.catalog || sampleCatalog,
    modality: options.modality || (() => ['text']),
    listModels: options.listModels || null,
    stream: options.stream || null,
  }

  const llm = {
    listProviders: () => [{ id: 'p1', name: 'Provider one' }, { id: 'p2', name: 'Provider two' }],
    listModels: async (provider) =>
      state.listModels
        ? state.listModels(provider)
        : provider === 'p1'
          ? [{ id: 'm1', name: 'Model one' }, { id: 'gpt-image-2.6-flare', name: 'GPT Image 2.6 Flare' }]
          : [{ id: 'm2', name: 'Model two' }],
    resolveModelInfo: async (provider, model) => ({
      id: model,
      provider,
      inputModalities: state.modality(model),
    }),
    async *stream(request) {
      calls.push(request)
      if (state.stream) {
        yield* state.stream(request)
        return
      }
      yield { type: 'text-delta', index: 0, text: 'rewritten prompt' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'rewritten prompt' } }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const sessionController = { modelCatalog: async () => state.catalog() }

  const ctx = {
    llm,
    sessionController,
    connection: { requestRejection: () => state.rejection() },
    webServer: {
      register(definition) {
        routes.set(definition.path, definition.handler)
        return () => routes.delete(definition.path)
      },
    },
    effect: (fn) => fn(),
    inject: (_deps, fn) => fn(ctx),
  }

  plugin.apply(ctx)

  /** Invoke one route the way the HTTP layer would. */
  async function call(path, body, extra) {
    const handler = routes.get(PREFIX + path)
    if (!handler) throw new Error('route missing: ' + path)
    const req = fakeRequest(body, extra || {})
    const res = fakeResponse()
    await handler(req, res)
    return res
  }

  return { routes, ctx, calls, llm, sessionController, state, call }
}

export { require }
