/**
 * Host half of the Concept Explainer bundle.
 *
 * One authenticated `/api` endpoint: it reads the session's own messages as
 * read-only context, asks the harness LLM service for an explanation, and
 * streams the answer back as newline-delimited JSON. Nothing here appends an
 * event to the session, so the main conversation cannot change.
 */
import {
  buildRequestMessages,
  collectSnippets,
  composeSystemPrompt,
  validatePayload,
} from './prompt.js'

/** The exact Fetch route this bundle owns. */
export const ROUTE_PATH = '/api/concept-explainer/stream'

/** Largest request body accepted (the panel's own transcript is small). */
const MAX_BODY_BYTES = 256 * 1024

/** Output budget of one explanation: enough for a few hundred words. */
const MAX_ANSWER_TOKENS = 1400

/** Effort ranking used to pick the fastest advertised level. */
const REASONING_ORDER = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh']

/** The request needs the connection service that owns `/api` admission. */
export const inject = ['connection']

/**
 * Read the provider/model route of one conversation: the live agent's own
 * options first, then the deployment default.
 * @param ctx - host context.
 * @param sessionId - the conversation the panel is attached to.
 * @returns a route, or undefined when the deployment has no model.
 */
export function resolveRoute(ctx, sessionId) {
  try {
    const options = ctx.get('agents')?.get(sessionId)?.options
    if (typeof options?.provider === 'string' && options.provider !== ''
      && typeof options?.model === 'string' && options.model !== '') {
      return { provider: options.provider, model: options.model }
    }
  } catch {
    // A context without the agent registry falls through to the default.
  }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    if (typeof selection?.provider === 'string' && selection.provider !== ''
      && typeof selection?.model === 'string' && selection.model !== '') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    // No default model configured.
  }
  return undefined
}

/**
 * Collect the read-only conversation fragments around the selected text.
 * @param ctx - host context.
 * @param sessionId - the conversation the selection came from.
 * @param concept - the selected text.
 * @returns fragments, or an empty list for an unknown session.
 */
export function readContextSnippets(ctx, sessionId, concept) {
  try {
    const session = ctx.get('sessions')?.get(sessionId)
    if (session === undefined) return []
    return collectSnippets(session.deriveMessages(), concept)
  } catch (error) {
    console.warn('[concept-explainer] could not read session context:', error)
    return []
  }
}

/** One JSON response with a stable shape. */
function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Turn an LLM failure into a short sentence the panel can show.
 * @param error - anything thrown while streaming.
 * @returns a user-facing message.
 */
function describeError(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error)
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'ABORTED' || error?.name === 'AbortError') return '已停止'
  if (code === 'RATE_LIMIT' || /rate.?limit/iu.test(message)) return '模型额度或频率受限，请稍后再试'
  if (code === 'AUTH' || /api.?key|unauthorized|401/iu.test(message)) return '模型凭据不可用，请检查 DSH 的模型设置'
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

/** Reject a body that is clearly larger than any legitimate payload. */
function tooLarge(request) {
  const length = Number(request.headers.get('content-length') ?? '0')
  return Number.isFinite(length) && length > MAX_BODY_BYTES
}

/**
 * The lowest reasoning effort the model advertises.
 *
 * A concept explanation is a short answer: asking for the deployment's
 * default effort (often `max`) would spend most of the wait thinking. Models
 * that advertise no efforts get the field omitted, because requesting an
 * unsupported level is rejected by the harness.
 * @param llm - the LLM service face.
 * @param route - the resolved provider/model route.
 * @returns an effort id, or undefined to omit the field.
 */
export async function reasoningEffortFor(llm, route) {
  try {
    const info = await (typeof llm.resolveModelInfo === 'function'
      ? llm.resolveModelInfo(route.provider, route.model)
      : undefined)
    const efforts = info?.reasoning?.efforts
    if (!Array.isArray(efforts)) return undefined
    const ids = efforts
      .map(entry => (entry !== null && typeof entry === 'object' && typeof entry.id === 'string' ? entry.id : undefined))
      .filter(id => typeof id === 'string' && id !== '')
    if (ids.length === 0) return undefined
    let best = ids[0]
    let bestRank = Number.POSITIVE_INFINITY
    for (const id of ids) {
      const rank = REASONING_ORDER.indexOf(id)
      if (rank >= 0 && rank < bestRank) {
        best = id
        bestRank = rank
      }
    }
    return best
  } catch {
    return undefined
  }
}

/**
 * Serve one explanation request.
 * @param ctx - host context.
 * @param request - the buffered Fetch request.
 * @returns an NDJSON stream, or a JSON error response.
 */
export async function handleRequest(ctx, request) {
  if (tooLarge(request)) return jsonResponse(413, { error: '请求内容过大' })
  let payload
  try {
    payload = JSON.parse(await request.text())
  } catch {
    return jsonResponse(400, { error: '请求内容不是合法 JSON' })
  }
  const invalid = validatePayload(payload)
  if (invalid !== undefined) return jsonResponse(400, { error: invalid })

  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    return jsonResponse(503, { error: '当前部署没有可用的模型服务' })
  }
  const route = resolveRoute(ctx, payload.sessionId)
  if (route === undefined) {
    return jsonResponse(503, { error: '还没有选择模型，先在主对话里发一条消息再试' })
  }

  const concept = payload.concept.trim()
  const snippets = readContextSnippets(ctx, payload.sessionId, concept)
  // The user's own instruction, when they saved one, replaces the built-in
  // text; an empty value keeps the shipped rules.
  const system = typeof payload.system === 'string' && payload.system.trim() !== ''
    ? payload.system
    : composeSystemPrompt()
  let messages
  try {
    messages = buildRequestMessages({
      snippets,
      concept,
      turns: payload.turns,
      question: payload.question,
      source: { kind: 'model', provider: route.provider, model: route.model },
    })
  } catch (error) {
    return jsonResponse(400, { error: `无法组装这次解释：${describeError(error)}` })
  }

  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      let closed = false
      const write = (event) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          closed = true
        }
      }
      write({
        type: 'meta',
        snippets: snippets.map(row => ({
          role: row.role,
          preview: row.text.length > 90 ? `${row.text.slice(0, 90)}…` : row.text,
        })),
      })
      let deltas = 0
      try {
        const effort = await reasoningEffortFor(llm, route)
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          system,
          messages,
          maxTokens: MAX_ANSWER_TOKENS,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          signal: request.signal,
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
            deltas += 1
            write({ type: 'delta', text: chunk.text })
            continue
          }
          if (chunk?.type !== 'finish') continue
          const kind = chunk.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            write({ type: 'error', message: kind === 'aborted' ? '已停止' : describeError(chunk.reason?.failure) })
          } else if (kind === 'max-tokens') {
            write({ type: 'notice', message: '回答达到长度上限，已截断。' })
          }
        }
        if (deltas === 0) write({ type: 'error', message: '模型这次没有给出正文，请重试或换个问法' })
        else write({ type: 'done' })
      } catch (error) {
        write({ type: 'error', message: describeError(error) })
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          // The browser went away first; nothing left to flush.
        }
      }
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * Host plugin body: own one exact `/api` route for the panel's lifetime.
 * @param ctx - host context.
 */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined) {
    console.warn('[concept-explainer] no connection service; the panel endpoint stays unregistered')
    return
  }
  const registered = connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleRequest(ctx, request),
  })
  ctx.effect(() => () => {
    void Promise.resolve(registered)
      .then(dispose => dispose())
      .catch((error) => { console.warn('[concept-explainer] endpoint release failed:', error) })
  }, 'concept-explainer: /api endpoint')
}
