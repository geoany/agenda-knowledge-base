/**
 * Describe an image, once, when it is sent.
 *
 * The agenda's model never receives an image: we hand the reading to a second
 * model, which writes a description in English kept in
 * `attachments.description`. An image pasted into a task or into the chat would
 * otherwise be invisible to it. It is that description the agent reads
 * afterwards, in place of the image. It is computed ONCE, at send time:
 * recomputing it on every chat turn would cost several seconds per message for
 * an identical result.
 *
 * The default model is `deepseek-v4-flash-vision-exp`, the image door of
 * OpenCode Go, called directly with the agenda key (OpenAI `image_url` format):
 * it copies exactly
 * the text present (the number, amount and date of an invoice, verbatim) in a
 * few seconds. Interchangeable through AGENDA_VISION_MODEL.
 *
 * No output token bound: a description cut in the middle of an invoice number is
 * worse than a slow description.
 */

import { LLM_URL, llmHeaders, llmReady } from './llm.js'

const BASE = process.env.AGENDA_VISION_URL || LLM_URL

export const VISION_MODEL = process.env.AGENDA_VISION_MODEL || 'deepseek-v4-flash-vision-exp'

/* Three minutes, for a nominal duration of six seconds. Far above the eight      */
/* times required: a ten-megabyte image on a slow link already takes several      */
/* seconds just to upload, before the model even starts.                          */
const TIMEOUT_MS = Number(process.env.AGENDA_VISION_TIMEOUT || 180_000)

/**
 * The instruction, in fully spelled-out English.
 *
 * A model mimics the style of its prompt: fed unaccented prose, it answers in
 * unaccented prose, and this description ends up as is in the agent's prompt and
 * then in front of the user.
 *
 * Copying the text is asked for explicitly: without that sentence, models
 * summarize ("a screenshot of a billing table") where what matters is the
 * amount, the date or the address written inside.
 */
const INSTRUCTION = `Describe this image in English, precisely and without chatter.
Copy IN FULL every readable piece of text in the image, figures, amounts, dates and addresses included.
If the image contains no text, describe the scene, the objects, the people and the colours.
No introduction, no title, no comment on the quality of the image: the description alone.`

export const visionReady = llmReady

/**
 * Describes an image and returns the description, the model used and the duration.
 *
 * Never throws: a network failure or an exhausted quota must not prevent the
 * attachment from existing. We then return an empty description and the reason,
 * the attachment is stored anyway and stays visible on screen.
 */
export async function describeImage (buffer, mime = 'image/png', { signal } = {}) {
  const t0 = Date.now()
  if (!buffer?.length) return { description: '', model: VISION_MODEL, ms: 0, error: 'empty image' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: llmHeaders('agenda-vision'),
      signal: ctrl.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0.2,
        messages: [{
          role: 'user',
          // The image travels as a data URL inside the message content: that is
          // the form the OpenAI-compatible API accepts.
          content: [
            { type: 'text', text: INSTRUCTION },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } }
          ]
        }]
      })
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 402 or 429 = model cap reached, not a passing spike.
      const reason = res.status === 402 || res.status === 429
        ? 'Provider cap reached for vision.'
        : `Vision ${res.status}: ${body.slice(0, 200)}`
      return { description: '', model: VISION_MODEL, ms: Date.now() - t0, error: reason }
    }

    const data = await res.json()
    return {
      description: cleanUp(data.choices?.[0]?.message?.content),
      model: VISION_MODEL,
      ms: Date.now() - t0
    }
  } catch (e) {
    return { description: '', model: VISION_MODEL, ms: Date.now() - t0, error: String(e.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The description is text, not a document.
 *
 * Models gladly open with "Image description:" in bold, and that sentence goes
 * as is into the agent's prompt and then in front of the user. We remove the
 * wrapping, we keep the content.
 */
function cleanUp (txt) {
  return String(txt || '')
    .replace(/^\s*\*{0,2}(description|here is|analysis)[^\n:]{0,40}:\*{0,2}\s*/i, '')
    .replace(/\*\*/g, '')
    .trim()
}
