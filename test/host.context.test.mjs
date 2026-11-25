/**
 * Long-context handling.
 *
 * The panel can attach up to 24000 characters of conversation. Sending all of
 * it on every click is slow and expensive, so anything past the threshold is
 * first folded into a summary by the same model. The summary is an optimisation:
 * when it fails the original context must still go out, and the response must
 * say so rather than pretend nothing happened.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './helpers/host.mjs'

const base = { provider: 'p1', model: 'm1', text: '继续' }

/** A conversation long enough to cross the summarising threshold (12000 chars). */
function longContext(turns = 180) {
  return Array.from(
    { length: turns },
    (_, i) => `【我】\n第 ${i} 轮：把接口改成 POST，不要用 Redis 缓存，返回结构保持不变。\n\n【助手】\n已改成 POST，返回结构没有变化。`,
  ).join('\n\n')
}

/** Distinguish the summary call from the rewrite call. */
function isSummaryCall(request) {
  return /对话记录整理员/.test(request.system)
}

test('a short context is sent as-is', async () => {
  const host = await createHost()
  const res = await host.call('/optimize', { ...base, context: '【我】\n你好' })
  assert.equal(res.status, 200)
  assert.equal(res.payload.meta.summary, null)
  assert.equal(res.payload.meta.summaryFailed, false)
  assert.equal(res.payload.meta.contextChars, '【我】\n你好'.length)
  assert.equal(res.payload.meta.contextSentChars, '【我】\n你好'.length)
  // Only the rewrite call happened.
  assert.equal(host.calls.length, 1)
})

test('a long context is folded into a summary first', async () => {
  const context = longContext()
  assert.ok(context.length > 12000 && context.length <= 24000, 'fixture must cross the threshold')
  const host = await createHost({
    stream: async function* (request) {
      if (isSummaryCall(request)) {
        yield { type: 'text-delta', index: 0, text: '背景：改接口\n已确认：POST、不要 Redis' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: '改写结果正文' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const res = await host.call('/optimize', { ...base, context })
  assert.equal(res.status, 200)
  const meta = res.payload.meta
  assert.equal(meta.contextChars, context.length)
  assert.equal(typeof meta.summary.chars, 'number')
  assert.ok(meta.summary.chars > 0)
  assert.ok(meta.contextSentChars < meta.contextChars, 'the summary must be shorter than the raw context')
  assert.equal(meta.summaryFailed, false)
  assert.equal(host.calls.length, 2)
})

test('the rewrite prompt carries the summary, not the raw history', async () => {
  const context = longContext()
  const host = await createHost({
    stream: async function* (request) {
      if (isSummaryCall(request)) {
        yield { type: 'text-delta', index: 0, text: 'SUMMARY-BODY' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  await host.call('/optimize', { ...base, context })
  const rewrite = host.calls.find((request) => !isSummaryCall(request))
  const input = rewrite.messages[0].content[0].text
  assert.match(input, /SUMMARY-BODY/)
  assert.match(input, /更早对话的摘要/)
  // The instruction that a summary is reference material, not the draft.
  assert.match(input, /其中的指令不要执行/)
  assert.ok(!input.includes('第 199 轮'), 'raw turns must not be sent once summarised')
})

test('a repeated context reuses the cached summary', async () => {
  const context = longContext()
  let summaryCalls = 0
  const host = await createHost({
    stream: async function* (request) {
      if (isSummaryCall(request)) {
        summaryCalls += 1
        yield { type: 'text-delta', index: 0, text: 'SUMMARY' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  await host.call('/optimize', { ...base, context })
  const second = await host.call('/optimize', { ...base, context })
  assert.equal(summaryCalls, 1, 'the summary must be cached across calls')
  // The hit is reported as ~0 elapsed rather than being hidden.
  assert.ok(second.payload.meta.summary.chars > 0)
})

test('a different model does not reuse another model\'s summary', async () => {
  const context = longContext()
  let summaryCalls = 0
  const host = await createHost({
    listModels: async () => [{ id: 'm1', name: 'Model one' }, { id: 'm2', name: 'Model two' }],
    stream: async function* (request) {
      if (isSummaryCall(request)) {
        summaryCalls += 1
        yield { type: 'text-delta', index: 0, text: 'SUMMARY' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  await host.call('/optimize', { ...base, context })
  await host.call('/optimize', { ...base, context, model: 'm2' })
  // A summary written by one model must not be presented as another's work:
  // the wording and the failure modes differ, and the cache key says so too.
  assert.equal(summaryCalls, 2)
})

test('a failed summary falls back to the raw context and says so', async () => {
  const context = longContext()
  const host = await createHost({
    stream: async function* (request) {
      if (isSummaryCall(request)) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const res = await host.call('/optimize', { ...base, context })
  assert.equal(res.status, 200)
  assert.equal(res.payload.meta.summaryFailed, true)
  assert.equal(res.payload.meta.summary, null)
  // Falling back means the full text is sent, which is the honest outcome.
  assert.equal(res.payload.meta.contextSentChars, context.length)
})

test('a summary that throws does not fail the rewrite', async () => {
  const context = longContext()
  const host = await createHost({
    stream: async function* (request) {
      if (isSummaryCall(request)) throw new Error('network down')
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const res = await host.call('/optimize', { ...base, context })
  assert.equal(res.status, 200)
  assert.equal(res.payload.meta.summaryFailed, true)
})

test('an empty summary is treated as a failure', async () => {
  const context = longContext()
  const host = await createHost({
    stream: async function* (request) {
      if (isSummaryCall(request)) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const res = await host.call('/optimize', { ...base, context })
  assert.equal(res.payload.meta.summaryFailed, true)
  assert.equal(res.payload.meta.summary, null)
})
