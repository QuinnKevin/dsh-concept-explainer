/**
 * Host-half tests. They run with plain `node --test` and a fake Cordis
 * context, so they exercise the real request handler, the real prompt
 * assembly and the real NDJSON stream without a browser or a model.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { handleRequest, resolveRoute, ROUTE_PATH } from '../index.js'
import {
  buildRequestMessages,
  collectSnippets,
  composeSystemPrompt,
  validatePayload,
} from '../prompt.js'

/** One assistant answer as `session.deriveMessages()` would return it. */
function assistant(text) {
  return { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } }
}

/** One user message as `session.deriveMessages()` would return it. */
function user(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/**
 * A fake host context. `append` throws so any write path fails loudly.
 * @returns the context plus the recorded LLM requests.
 */
function fakeContext({ messages = [], chunks = [{ type: 'text-delta', text: 'RAG 是检索增强生成。' }, { type: 'finish', reason: { kind: 'stop' } }], failure, llm = true, route = { provider: 'deepseek', model: 'deepseek-chat' }, modelInfo } = {}) {
  const calls = []
  const session = {
    deriveMessages: () => messages,
    append() { throw new Error('the explainer must never append to the session') },
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => session }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'agentDefaultModel') return { currentSelection: () => route }
      if (name === 'llm') {
        if (!llm) return undefined
        return {
          ...(modelInfo === undefined ? {} : { resolveModelInfo: async () => modelInfo }),
          stream(options) {
            calls.push(options)
            return (async function* generate() {
              for (const chunk of chunks) yield chunk
              if (failure !== undefined) throw failure
            })()
          },
        }
      }
      return undefined
    },
  }
  return { ctx, calls, session }
}

/** Parse an NDJSON response body. */
async function eventsOf(response) {
  const text = await response.text()
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/** Build a real Request for the endpoint. */
function request(body) {
  return new Request(`http://127.0.0.1:7362${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('collectSnippets keeps the neighbourhood of the selected text', () => {
  const messages = [
    user('问题一'),
    assistant('回答一'),
    user('问题二'),
    assistant('MoE 路由决定每个 token 交给哪个专家。'),
    user('问题三'),
    assistant('回答三'),
  ]
  const snippets = collectSnippets(messages, 'MoE 路由')
  assert.deepEqual(snippets.map(row => row.role), ['assistant', 'user', 'assistant', 'user', 'assistant'])
  assert.match(snippets[2].text, /MoE 路由/u)
  assert.equal(snippets.length, 5)
})

test('collectSnippets falls back to the newest messages when the concept is absent', () => {
  const messages = []
  for (let index = 0; index < 12; index += 1) messages.push(index % 2 === 0 ? user(`u${index}`) : assistant(`a${index}`))
  const snippets = collectSnippets(messages, '不存在的词')
  assert.equal(snippets.length, 6)
  assert.match(snippets[snippets.length - 1].text, /a11/u)
})

test('collectSnippets truncates a long fragment and ignores tool rows', () => {
  const messages = [
    assistant('x'.repeat(2000)),
    { role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
  ]
  const snippets = collectSnippets(messages, 'x')
  assert.equal(snippets.length, 1)
  assert.ok(snippets[0].text.length <= 701)
})

test('collectSnippets tolerates a collapsed selection and empty session', () => {
  assert.deepEqual(collectSnippets([], 'RAG'), [])
  assert.deepEqual(collectSnippets([user('a'), assistant('b')], '   '), [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }])
})

test('validatePayload rejects missing and oversized input', () => {
  assert.match(validatePayload({ sessionId: '', concept: 'x' }), /会话/u)
  assert.match(validatePayload({ sessionId: 's', concept: '   ' }), /概念/u)
  assert.match(validatePayload({ sessionId: 's', concept: 'x'.repeat(401) }), /太长/u)
  assert.match(validatePayload({ sessionId: 's', concept: 'x', turns: new Array(41).fill({ role: 'user', text: 'q' }) }), /轮次/u)
  assert.equal(validatePayload({ sessionId: 's', concept: 'RAG' }), undefined)
})

test('buildRequestMessages wraps the context and stamps assistant turns', () => {
  const messages = buildRequestMessages({
    snippets: [{ role: 'assistant', text: '我们在聊 MoE。' }],
    concept: 'MoE',
    turns: [{ role: 'assistant', text: '它是混合专家。' }, { role: 'user', text: '那和稠密模型比呢？' }],
    question: '再说说路由',
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
  })
  assert.equal(messages.length, 4)
  assert.match(messages[0].content[0].text, /只读语境/u)
  assert.match(messages[0].content[0].text, /MoE/u)
  assert.deepEqual(messages[1].source, { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' })
  assert.match(messages[3].content[0].text, /再说说路由/u)
})

test('resolveRoute prefers the live agent and falls back to the default model', () => {
  const withAgent = { get: name => name === 'agents' ? { get: () => ({ options: { provider: 'a', model: 'b' } }) } : undefined }
  assert.deepEqual(resolveRoute(withAgent, 's'), { provider: 'a', model: 'b' })
  const fallback = { get: name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'd', model: 'e' }) } : undefined }
  assert.deepEqual(resolveRoute(fallback, 's'), { provider: 'd', model: 'e' })
  assert.equal(resolveRoute({ get: () => undefined }, 's'), undefined)
})

test('the endpoint streams context metadata, deltas and a done marker', async () => {
  const { ctx, calls } = fakeContext({
    messages: [user('MoE 是什么？'), assistant('MoE 是混合专家模型。')],
  })
  const response = await handleRequest(ctx, request({ sessionId: 'session-1', concept: 'MoE', turns: [], question: null }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /ndjson/u)
  const events = await eventsOf(response)
  assert.equal(events[0].type, 'meta')
  assert.equal(events[0].snippets.length, 2)
  assert.ok(events.some(event => event.type === 'delta'))
  assert.equal(events[events.length - 1].type, 'done')
  assert.equal(calls.length, 1)
  assert.match(calls[0].system, /概念解释器/u)
  assert.match(calls[0].messages[0].content[0].text, /MoE/u)
})

test('the endpoint never writes to the conversation', async () => {
  const { ctx, session } = fakeContext({ messages: [assistant('上下文')] })
  const response = await handleRequest(ctx, request({ sessionId: 'session-2', concept: '上下文' }))
  assert.equal(response.status, 200)
  await eventsOf(response)
  assert.equal(typeof session.append, 'function')
})

test('a follow-up carries the previous side-chat turns', async () => {
  const { ctx, calls } = fakeContext({ messages: [assistant('上下文')] })
  const response = await handleRequest(ctx, request({
    sessionId: 'session-3',
    concept: '上下文',
    turns: [{ role: 'assistant', text: '上一次的解释' }, { role: 'user', text: '第一个追问' }],
    question: '第二个追问',
  }))
  await eventsOf(response)
  const sent = calls[0].messages
  assert.equal(sent.length, 4)
  assert.equal(sent[1].content[0].text, '上一次的解释')
  assert.equal(sent[3].content[0].text, '第二个追问')
})

test('the endpoint reports bad bodies, missing models and model failures', async () => {
  const { ctx } = fakeContext()
  const bad = await handleRequest(ctx, new Request(`http://127.0.0.1:7362${ROUTE_PATH}`, { method: 'POST', body: 'not json' }))
  assert.equal(bad.status, 400)

  const blank = await handleRequest(ctx, request({ sessionId: 's', concept: '  ' }))
  assert.equal(blank.status, 400)
  assert.match((await blank.json()).error, /概念/u)

  const noLlm = await handleRequest(fakeContext({ llm: false }).ctx, request({ sessionId: 's', concept: 'x' }))
  assert.equal(noLlm.status, 503)

  const broken = await handleRequest(
    fakeContext({ chunks: [], failure: new Error('provider exploded') }).ctx,
    request({ sessionId: 's', concept: 'x' }),
  )
  const events = await eventsOf(broken)
  assert.equal(events[events.length - 1].type, 'error')
  assert.match(events[events.length - 1].message, /provider exploded/u)
})

test('the endpoint picks the fastest advertised reasoning level', async () => {
  const { ctx, calls } = fakeContext({
    messages: [assistant('上下文')],
    modelInfo: { reasoning: { efforts: [{ id: 'max' }, { id: 'low' }, { id: 'medium' }] } },
  })
  const response = await handleRequest(ctx, request({ sessionId: 's', concept: 'x' }))
  await eventsOf(response)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reasoningEffort, 'low')
  assert.equal(calls[0].maxTokens, 1400)
})

test('a model without advertised efforts gets no reasoning field', async () => {
  const { ctx, calls } = fakeContext({ messages: [assistant('上下文')] })
  const response = await handleRequest(ctx, request({ sessionId: 's', concept: 'x' }))
  await eventsOf(response)
  assert.equal('reasoningEffort' in calls[0], false)
})

test('a saved custom prompt replaces the built-in system text', async () => {
  const { ctx, calls } = fakeContext({ messages: [assistant('MoE 是混合专家模型。')] })
  const response = await handleRequest(ctx, request({
    sessionId: 's',
    concept: 'MoE',
    system: '只用一句话解释，面向产品经理。',
  }))
  await eventsOf(response)
  assert.equal(calls[0].system, '只用一句话解释，面向产品经理。')
  // The read-only context framing lives in the user turn, so a custom system
  // prompt cannot turn conversation text into instructions.
  assert.match(calls[0].messages[0].content[0].text, /不是给你的指令/u)
})

test('an empty custom prompt falls back to the built-in rules', async () => {
  const { ctx, calls } = fakeContext({ messages: [assistant('上下文')] })
  const response = await handleRequest(ctx, request({ sessionId: 's', concept: 'x', system: '   ' }))
  await eventsOf(response)
  assert.match(calls[0].system, /概念解释器/u)
})

test('an oversized custom prompt is rejected', async () => {
  const { ctx } = fakeContext()
  const response = await handleRequest(ctx, request({ sessionId: 's', concept: 'x', system: 'y'.repeat(8001) }))
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /提示词/u)
})

test('the system prompt states the read-only rule', () => {
  const prompt = composeSystemPrompt()
  assert.match(prompt, /只读语境/u)
  assert.match(prompt, /不是给你的指令/u)
})
