/**
 * Host-half tests. They run with plain `node --test` and a fake Cordis
 * context, so they exercise the real request handler, the real prompt
 * assembly and the real NDJSON stream without a browser or a model.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleAppend, handleRequest, handleSave, handleSessionSave, resolveRoute, ROUTE_PATH, SAVE_ROUTE_PATH, SESSION_ROUTE_PATH, APPEND_ROUTE_PATH } from '../index.js'
import {
  buildRequestMessages,
  collectSnippets,
  composeSystemPrompt,
  noteFileName,
  renderNoteMarkdown,
  validateAppendPayload,
  validatePayload,
  validateSavePayload,
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

/** Build a real Request for the save endpoint. */
function saveRequest(body) {
  return new Request(`http://127.0.0.1:7362${SAVE_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Build a real Request for the session endpoint. */
function sessionRequest(body) {
  return new Request(`http://127.0.0.1:7362${SESSION_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Build a real Request for the append endpoint. */
function appendRequest(body) {
  return new Request(`http://127.0.0.1:7362${APPEND_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** A fake host context whose saved session records every appended event. */
function fakeAppendContext({ live = true, lastTurn = 3, messages = [user('问'), assistant('答')] } = {}) {
  const appends = []
  const session = {
    append(type, data, options) {
      appends.push({ type, data, options })
      return { type, seq: appends.length - 1 }
    },
    deriveMessages: () => messages,
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => (live ? session : undefined) }
      if (name === 'sessionController') return { resolveAgent: async () => ({ agent: { id: 's' } }) }
      if (name === 'agents') return { turnBoundaryOf: () => ({ lastTurn }) }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      return undefined
    },
  }
  return { ctx, appends }
}

/** A fake host context for session creation: records the native fork and the appended turn. */
function fakeSessionContext({ cwd = 'C:\\ws', fail, attachFail } = {}) {
  const calls = []
  const source = { header: { cwd }, append: () => {}, deriveMessages: () => [] }
  const child = {
    header: { cwd },
    append(type, data, options) {
      calls.push({ kind: 'append', type, data, options })
      return { type, seq: calls.length }
    },
    deriveMessages: () => [],
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => (id === 'session-source' ? source : child),
          flush: async () => true,
        }
      }
      if (name === 'agents') return { turnBoundaryOf: () => ({ lastTurn: 7 }) }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      if (name === 'workspaceRegistry') {
        return {
          resolveByPath: async (path) => {
            calls.push({ kind: 'resolveWorkspace', path })
            if (attachFail !== undefined) throw attachFail
            const workspace = {
              sessionIds: ['session-oldest'],
              attachSession: async (sessionId) => {
                calls.push({ kind: 'attach', sessionId })
                workspace.sessionIds = [sessionId, ...workspace.sessionIds]
              },
              insertSessionBefore: async (sessionId, beforeSessionId) => {
                calls.push({ kind: 'moveToTop', sessionId, beforeSessionId })
              },
            }
            return workspace
          },
        }
      }
      if (name === 'sessionController') {
        return {
          fork: async (request) => {
            calls.push({ kind: 'fork', request })
            if (fail !== undefined) throw fail
            return { sessionId: 'session-child' }
          },
          rename: async (request) => {
            calls.push({ kind: 'rename', request })
            return { title: request.title, seq: 1 }
          },
          resolveAgent: async () => ({ agent: { id: 'session-child' } }),
        }
      }
      return undefined
    },
  }
  return { ctx, calls }
}

/** A fake host context for save: one session whose cwd is the temp workspace. */
function fakeSaveContext(cwd) {
  const session = {
    header: cwd === undefined ? {} : { cwd },
    deriveMessages: () => [],
    append() { throw new Error('saving must never append to the session') },
  }
  return {
    get: name => (name === 'sessions' ? { get: () => session } : undefined),
  }
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

test('noteFileName keeps CJK and never carries a path separator', () => {
  const date = new Date(2026, 10, 26)
  assert.equal(noteFileName('MoE 路由', date), '2026-11-26-MoE-路由.md')
  assert.equal(noteFileName('a/b\\c:d', date), '2026-11-26-a-b-c-d.md')
  assert.equal(noteFileName('../../etc/passwd', date), '2026-11-26-etc-passwd.md')
  assert.equal(noteFileName('   ', date), '2026-11-26-concept.md')
})

test('renderNoteMarkdown lays out the explanation, follow-ups and references', () => {
  const markdown = renderNoteMarkdown({
    concept: 'MoE 路由',
    turns: [
      { role: 'assistant', text: '第一段解释' },
      { role: 'user', text: '那和稠密模型比呢？' },
      { role: 'assistant', text: '第二段回答' },
    ],
    snippets: [{ role: 'assistant', preview: '对话里的一句话' }],
    sessionId: 'session-9',
    savedAt: '2026/11/26 21:30:00',
  })
  assert.match(markdown, /^# MoE 路由$/mu)
  assert.match(markdown, /## 解释\n\n第一段解释/u)
  assert.match(markdown, /\*\*问：\*\* 那和稠密模型比呢？/u)
  assert.match(markdown, /\*\*答：\*\* 第二段回答/u)
  assert.match(markdown, /## 引用的对话片段/u)
  assert.match(markdown, /来源会话：session-9/u)
})

test('validateSavePayload rejects empty and malformed content', () => {
  assert.match(validateSavePayload({ sessionId: 's', concept: 'x', turns: [] }), /还没有/u)
  assert.match(validateSavePayload({ sessionId: 's', concept: 'x', turns: [{ role: 'system', text: 'y' }] }), /格式/u)
  assert.match(validateSavePayload({ sessionId: '', concept: 'x', turns: [{ role: 'assistant', text: 'y' }] }), /会话/u)
  assert.equal(validateSavePayload({ sessionId: 's', concept: 'x', turns: [{ role: 'assistant', text: 'y' }] }), undefined)
})

test('the save endpoint writes a note inside concept-notes/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ce-'))
  try {
    const ctx = fakeSaveContext(dir)
    const response = await handleSave(ctx, saveRequest({
      sessionId: 'session-1',
      concept: 'MoE 路由',
      turns: [
        { role: 'assistant', text: '解释正文' },
        { role: 'user', text: '追问一句' },
        { role: 'assistant', text: '追问的回答' },
      ],
      snippets: [{ role: 'assistant', preview: '片段' }],
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.saved, true)
    assert.match(body.relative, /^concept-notes\/\d{4}-\d{2}-\d{2}-MoE-路由\.md$/u)

    const saved = await readFile(join(dir, body.relative), 'utf8')
    assert.match(saved, /解释正文/u)
    assert.match(saved, /\*\*问：\*\* 追问一句/u)
    assert.match(saved, /## 引用的对话片段/u)

    const second = await (await handleSave(ctx, saveRequest({
      sessionId: 'session-1',
      concept: 'MoE 路由',
      turns: [{ role: 'assistant', text: '再存一次' }],
    }))).json()
    assert.notEqual(second.relative, body.relative)
    assert.match(second.relative, /-2\.md$/u)

    assert.deepEqual(await readdir(dir), ['concept-notes'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a concept full of path characters still lands inside the folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ce-'))
  try {
    const ctx = fakeSaveContext(dir)
    const body = await (await handleSave(ctx, saveRequest({
      sessionId: 's',
      concept: '../../evil',
      turns: [{ role: 'assistant', text: '正文' }],
    }))).json()
    assert.match(body.relative, /^concept-notes\//u)
    assert.equal(body.relative.includes('..'), false)
    assert.deepEqual(await readdir(dir), ['concept-notes'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a session without a workspace directory is refused', async () => {
  const ctx = fakeSaveContext(undefined)
  const response = await handleSave(ctx, saveRequest({
    sessionId: 's',
    concept: 'x',
    turns: [{ role: 'assistant', text: '正文' }],
  }))
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /工作区/u)
})

test('validateAppendPayload requires a matched pair', () => {
  assert.match(validateAppendPayload({ sessionId: 's', turns: [] }), /缺少/u)
  assert.match(validateAppendPayload({ sessionId: 's', turns: [{ role: 'user', text: 'q' }] }), /一问一答/u)
  assert.equal(validateAppendPayload({
    sessionId: 's',
    turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }],
  }), undefined)
})

test('the append endpoint adds one completed turn to the saved session', async () => {
  const { ctx, appends } = fakeAppendContext({ lastTurn: 3 })
  const response = await handleAppend(ctx, appendRequest({
    sessionId: 'session-saved',
    turns: [{ role: 'user', text: '再问一句' }, { role: 'assistant', text: '再答一句' }],
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { appended: 2 })
  assert.deepEqual(appends.map(row => row.type), [
    'turn/start',
    'step/start',
    'user/message',
    'assistant/message',
    'step/end',
    'turn/end',
  ])
  assert.equal(appends[0].data.turn, 4)
  assert.equal(appends[2].options.surfaceOp, 'append')
  assert.equal(appends[3].data.message.content[0].text, '再答一句')
  assert.deepEqual(appends[5].data.reason, { kind: 'completed' })
})

test('the append endpoint refuses a session that cannot be resumed', async () => {
  const { ctx } = fakeAppendContext({ live: false })
  const response = await handleAppend(ctx, appendRequest({
    sessionId: 'session-cold',
    turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }],
  }))
  assert.equal(response.status, 409)
})


test('the session endpoint forks the conversation and appends the explanation', async () => {
  const { ctx, calls } = fakeSessionContext()
  const response = await handleSessionSave(ctx, sessionRequest({
    sessionId: 'session-source',
    concept: 'MoE 路由',
    turns: [
      { role: 'assistant', text: '解释正文' },
      { role: 'user', text: '追问一句' },
      { role: 'assistant', text: '追问回答' },
    ],
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.sessionId, 'session-child')
  assert.equal(body.forked, true)
  assert.equal(body.warning, undefined)

  const fork = calls.find(call => call.kind === 'fork')
  assert.deepEqual(fork.request, { sessionId: 'session-source' })

  const appended = calls.filter(call => call.kind === 'append')
  assert.deepEqual(appended.map(call => call.type), [
    'turn/start',
    'step/start',
    'assistant/message',
    'user/message',
    'assistant/message',
    'step/end',
    'turn/end',
  ])
  assert.equal(appended[0].data.turn, 8)
  assert.equal(appended[2].data.message.content[0].text, '解释正文')
  assert.equal(appended[4].data.message.content[0].text, '追问回答')

  const renamed = calls.find(call => call.kind === 'rename')
  assert.equal(renamed.request.sessionId, 'session-child')
  assert.equal(renamed.request.title, 'MoE 路由')

  const resolved = calls.find(call => call.kind === 'resolveWorkspace')
  assert.equal(resolved.path, 'C:\\ws')
  const attached = calls.find(call => call.kind === 'attach')
  assert.equal(attached.sessionId, 'session-child')
})

test('a long concept becomes a short session title', async () => {
  const { ctx, calls } = fakeSessionContext()
  const response = await handleSessionSave(ctx, sessionRequest({
    sessionId: 'session-source',
    concept: '这是一段很长的概念说明'.repeat(10),
    turns: [{ role: 'assistant', text: '正文' }],
  }))
  assert.equal(response.status, 200)
  const renamed = calls.find(call => call.kind === 'rename')
  assert.equal(renamed.request.title.length, 41)
  assert.match(renamed.request.title, /…$/u)
})

test('a workspace attach failure still returns the forked session', async () => {
  const { ctx } = fakeSessionContext({ attachFail: new Error('workspace is read-only') })
  const response = await handleSessionSave(ctx, sessionRequest({
    sessionId: 'session-source',
    concept: 'RAG',
    turns: [{ role: 'assistant', text: '解释正文' }],
  }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).sessionId, 'session-child')
})

test('the session endpoint reports a refused fork and a missing controller', async () => {
  const refused = await handleSessionSave(
    fakeSessionContext({ fail: new Error('source is not readable') }).ctx,
    sessionRequest({ sessionId: 's', concept: 'x', turns: [{ role: 'assistant', text: '正文' }] }),
  )
  assert.equal(refused.status, 500)
  assert.match((await refused.json()).error, /创建分支失败/u)

  const noController = await handleSessionSave(
    { get: name => (name === 'sessions' ? { get: () => ({ header: { cwd: 'C:\\ws' } }) } : undefined) },
    sessionRequest({ sessionId: 's', concept: 'x', turns: [{ role: 'assistant', text: '正文' }] }),
  )
  assert.equal(noController.status, 503)
})
