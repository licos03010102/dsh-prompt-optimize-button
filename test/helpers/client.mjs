/**
 * Browser-half harness.
 *
 * `lib/client.js` is not a module: it registers itself with
 * `window.__ModuleLoader__.load({ id, factory })` and pulls React out of the
 * loader's `require`. To exercise it without a browser we build a jsdom
 * window, stub the three modules it asks for, and then run the file with
 * `new Function` so its top-level `window`, `document`, `fetch` references
 * resolve to our sandbox.
 *
 * Everything runs offline: `fetch` defaults to a function that throws, and a
 * test that needs HTTP passes its own via `setFetch`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, '..', '..', 'lib', 'client.js')

/**
 * Props tree walker for the stub renderer's output.
 *
 * Components are functions here, never invoked by the stub (that is what makes
 * the stub cheap), so the walker calls them itself and walks the result. Without
 * this step `textOf` would silently miss everything rendered by `Section`,
 * `ModelPicker` and `Icon` — the bulk of the panel.
 */
export function walk(node, visit, depth = 0) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ type: '#text', props: { children: String(node) } })
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  // A component that renders itself would recurse forever; the depth cap turns
  // that mistake into a missing subtree instead of a hung test run.
  if (typeof node.type === 'function' && depth < 12) {
    walk(node.type(node.props || {}), visit, depth + 1)
    return
  }
  const children = node.props && node.props.children
  if (children !== undefined) walk(children, visit, depth)
}

/** Concatenated visible text of a stub props tree. */
/**
 * Concatenated visible text of a stub props tree.
 *
 * `Section` keeps its heading in a prop, so the walker expands components before
 * this runs and the heading arrives as a normal text node. No prop sniffing here:
 * doing both would print every heading twice.
 */
export function textOf(node) {
  let out = ''
  walk(node, (n) => {
    if (n.type === '#text') out += n.props.children
  })
  return out
}

/** Every node whose `type` matches (string tag or component function). */
export function findAll(node, predicate) {
  const hits = []
  walk(node, (n) => {
    if (predicate(n)) hits.push(n)
  })
  return hits
}

/** Make a jsdom element look laid out, since jsdom reports no boxes. */
export function makeVisible(el) {
  Object.defineProperty(el, 'offsetParent', { value: el.parentNode || el, configurable: true })
  el.getClientRects = () => [{ width: 100, height: 20, top: 0, left: 0 }]
  return el
}

/**
 * Load `lib/client.js` into a fresh jsdom.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - initial `fetch`.
 * @param {"named"|"default"} [options.reactDomShape] - how `react-dom` exposes
 *   `createPortal`; the host seed table ships an ESM namespace, so both shapes
 *   have to work.
 */
export function createClient(options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://127.0.0.1:3080/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  const { document } = window

  let currentFetch = options.fetchImpl || (async () => {
    throw new Error('network disabled in tests')
  })
  const fetchProxy = (...args) => currentFetch(...args)

  const react = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect() {},
    useRef: (init) => ({ current: init }),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  }
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props: props || {} }),
    jsxs: (type, props) => ({ type, props: props || {} }),
    Fragment: Symbol('Fragment'),
  }

  const portalCalls = []
  const makePortal = (node, target) => {
    portalCalls.push({ node, target })
    // `children` points at the portalled node so `walk()` still reaches it.
    return { type: '__portal__', props: { node, target, children: node }, children: [] }
  }
  const reactDom = options.reactDomShape === 'default'
    ? { __esModule: true, default: { createPortal: makePortal } }
    : { createPortal: makePortal }

  const stubs = { react, 'react/jsx-runtime': jsxRuntime, 'react-dom': reactDom }

  let loaded = null
  window.__ModuleLoader__ = {
    load({ factory }) {
      loaded = factory((id) => {
        if (stubs[id]) return stubs[id]
        throw new Error('unexpected require: ' + id)
      })
    },
  }

  // `writeDraft` tries a paste event between the Lexical route and execCommand,
  // and that route needs three browser globals. jsdom ships `Event` but not the
  // clipboard pair, so fill the gaps; a real browser has all three.
  const DataTransferShim = class DataTransfer {
    constructor() {
      this._data = new Map()
    }
    setData(type, value) {
      this._data.set(type, String(value))
    }
    getData(type) {
      return this._data.get(type) ?? ''
    }
  }
  const ClipboardEventShim = class ClipboardEvent extends window.Event {
    constructor(type, init = {}) {
      super(type, init)
      this.clipboardData = init.clipboardData ?? null
    }
  }

  // The file references these as bare globals (they exist in a browser), so
  // they must be injected as parameters; assigning `global.window` would not
  // be enough because `document` is captured by value at call time otherwise.
  const code = readFileSync(SOURCE, 'utf8')
  const factory = new Function(
    'window', 'document', 'navigator', 'sessionStorage', 'fetch',
    'AbortController', 'AbortSignal', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'requestAnimationFrame',
    'cancelAnimationFrame', 'ResizeObserver', 'DataTransfer',
    'ClipboardEvent', 'Event', 'console', code,
  )
  factory(
    window, document, window.navigator, window.sessionStorage, fetchProxy,
    window.AbortController, window.AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval,
    (fn) => window.requestAnimationFrame(fn),
    (id) => window.cancelAnimationFrame(id),
    window.ResizeObserver || class { observe() {} disconnect() {} },
    window.DataTransfer || DataTransferShim,
    window.ClipboardEvent || ClipboardEventShim,
    window.Event,
    console,
  )
  if (!loaded) throw new Error('lib/client.js did not register with the module loader')

  const api = loaded.__test
  if (!api) throw new Error('lib/client.js did not expose __test')

  return {
    window,
    document,
    api,
    portalCalls,
    setFetch(fn) {
      currentFetch = fn
    },
    /** Reset the shared store between tests. */
    reset() {
      api.store.set({
        open: false, mode: 'user', src: '', req: '', out: '', meta: null, debug: null,
        showDebug: false, busy: false, err: '', note: '', requestId: '', elapsed: 0,
        stale: false, providers: null, hiddenModels: 0, modelsLoading: false,
        modelsError: '', modelsNotice: '', failedProviders: [], pickerOpen: false,
        pickQuery: '', contextSession: null, ctxLen: 0, boundSession: null,
        prov: '', model: '', modelSelected: false,
      })
      window.sessionStorage.clear()
      document.body.innerHTML = ''
    },
  }
}
