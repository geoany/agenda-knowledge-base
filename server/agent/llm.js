/**
 * The agent's model client, for any OpenAI-compatible API
 * (`/chat/completions` in streaming, tool calls). By default OpenCode Go
 * (https://opencode.ai/zen/go/v1) and `deepseek-v4.1-flash`; AGENDA_LLM_URL,
 * AGENDA_LLM_API_KEY and AGENDA_MODEL point to any other provider (OpenRouter,
 * Mistral, a vLLM server...). A single client for everything (chat, memory,
 * night, weaving).
 *
 * Two requirements for any candidate model, to check before changing this
 * default: it must know how to call tools, and it must answer in the user's
 * language. The benchmark that decides is `scripts/bench-model.mjs`.
 *
 * No output-token bound is set on purpose: a reply cut off in the middle is
 * worse than a slow reply.
 */

export const LLM_URL = process.env.AGENDA_LLM_URL || 'https://opencode.ai/zen/go/v1'
const BASE = LLM_URL
// OPENCODE_GO_API_KEY is still accepted as an alias of the key.
const KEY = process.env.AGENDA_LLM_API_KEY || process.env.OPENCODE_GO_API_KEY
export const llmReady = () => Boolean(KEY)
export const MODEL = process.env.AGENDA_MODEL || 'deepseek-v4.1-flash'
// The fallback model. A provider withdrawing a model cuts chat, night, the rule
// engine and weaving at once: a single model serves everything, and its
// withdrawal returns a 410 that nobody reads. The fallback is named here (never
// a second model guessed): on a 404 or a 410, we replay the call once with it,
// and we SAY so in the log. That does not fix the cause, it keeps the next
// withdrawal from cutting everything instead of switching over.
export const MODEL_FALLBACK = process.env.AGENDA_MODEL_FALLBACK || ''
export const REASONING = process.env.AGENDA_REASONING ?? 'low'

// 8 minutes: far above the nominal duration (2 to 10 s). This ceiling only
// exists so a hung request does not keep an SSE connection alive forever.
const TIMEOUT_MS = Number(process.env.AGENDA_LLM_TIMEOUT || 480_000)

/**
 * The headers of every model call from the agenda (chat, vision, KB router).
 * OpenCode Go groups calls by session and caches the prompt per session
 * (`x-opencode-session`, ignored elsewhere): the name is stable per use, never
 * drawn at random. The User-Agent is explicit, some providers reject (403) a
 * call that does not carry one.
 */
export function llmHeaders (session = 'agenda') {
  if (!KEY) throw new Error('AGENDA_LLM_API_KEY missing from the project .env')
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${KEY}`,
    'x-opencode-session': session,
    'user-agent': 'agenda/1.0'
  }
}

const headers = () => llmHeaders('agenda')

/**
 * One model turn, in streaming.
 *
 * `onToken` receives the text as it comes (to show it while it is written). The
 * return value holds the complete message, including the reassembled tool
 * calls: in streaming they arrive in crumbs (the name in one piece, the
 * arguments spread over the following ones), they must be glued back together
 * by index before they can be run.
 */
export async function streamChat ({ messages, tools, temperature = 0.3, signal, onToken, reasoning }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })

  // The model named in this request's prompt, and the fallback one if it is
  // configured. We try the first, and on a 404/410 (model withdrawn) we replay
  // ONCE with the fallback: beyond that, we return the error as it is.
  const attempt = async model => fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    signal: ctrl.signal,
    body: JSON.stringify({
      model,
      stream: true,
      temperature,
      messages,
      // Models that think before answering spend dozens of seconds deliberating
      // over "add some bread". For an agenda, the decision is simple and
      // responsiveness matters more: we lower the reasoning effort. The
      // parameter is ignored by models that do not reason.
      //
      // The caller can raise this effort case by case: reorganizing a whole week
      // is not the same operation as adding a line, and that is precisely where
      // the cut-rate reasoning produced incoherent plans.
      ...((reasoning ?? REASONING) ? { reasoning_effort: reasoning ?? REASONING } : {}),
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {})
    })
  })

  let res
  try {
    res = await attempt(MODEL)
  } catch (e) {
    clearTimeout(timer)
    throw new Error(`Model provider unreachable: ${e.message}`)
  }

  // A withdrawn model returns 404 or 410. Without a configured fallback, we
  // carry on to the normal error handling (the message states the real problem);
  // with one, we replay once and note the switch in the log, so that the next
  // withdrawal leaves a trace instead of cutting everything in silence.
  if (!res.ok && (res.status === 404 || res.status === 410) && MODEL_FALLBACK && MODEL_FALLBACK !== MODEL) {
    await res.text().catch(() => '')
    console.error(`model ${MODEL} unavailable (${res.status}): switching to the fallback ${MODEL_FALLBACK}`)
    try {
      res = await attempt(MODEL_FALLBACK)
    } catch (e) {
      clearTimeout(timer)
      throw new Error(`Model provider unreachable: ${e.message}`)
    }
  }

  if (!res.ok) {
    clearTimeout(timer)
    const body = await res.text().catch(() => '')
    // 429 = quota exhausted or rate limit: retrying right away is pointless, we
    // say so clearly.
    if (res.status === 429) throw new Error('Model provider quota exhausted (429). Try again later.')
    // 404/410: the model has been withdrawn by the provider. We name it, this
    // failure must be readable at first glance.
    if (res.status === 404 || res.status === 410) {
      throw new Error(`Model ${MODEL} withdrawn or not found at the provider (${res.status}). Change AGENDA_MODEL${MODEL_FALLBACK ? ' or the fallback' : ' (or set AGENDA_MODEL_FALLBACK)'}.`)
    }
    throw new Error(`Model provider ${res.status}: ${body.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finish = null
  const calls = new Map() // index -> {id, name, args}

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let json
        try { json = JSON.parse(payload) } catch { continue }
        const choice = json.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finish = choice.finish_reason
        const delta = choice.delta || {}
        if (delta.content) {
          content += delta.content
          if (onToken) onToken(delta.content)
        }
        for (const tc of delta.tool_calls || []) {
          const i = tc.index ?? 0
          const cur = calls.get(i) || { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          calls.set(i, cur)
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, args: parseArgs(c.args) }))
    .filter(c => c.name)

  return { content: content.trim(), toolCalls, finish }
}

/** A plain round trip, without tools: used by the small internal tasks. */
export async function ask (prompt, { system, temperature = 0.2 } = {}) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })
  const r = await streamChat({ messages, temperature })
  return r.content
}

/**
 * The arguments arrive as JSON text. An open model sometimes gets the shape
 * wrong: an already decoded object, JSON wrapped in a code block, single quotes.
 * We catch those three cases rather than fail the tool call, otherwise the
 * agent loses a whole turn over a comma.
 *
 * When nothing decodes, we do NOT return `{}` in silence: the tool would run
 * without arguments and answer an error that does not mention the real problem
 * (the model would look for a missing id instead of a brace). We mark the
 * failure in the arguments, and `runTool` gives it back to the model with the
 * start of the text received.
 */
function parseArgs (raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  const clean = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(clean) } catch {}
  try { return JSON.parse(clean.replace(/'/g, '"')) } catch {}
  return { __unreadableArguments: clean.slice(0, 200) }
}
