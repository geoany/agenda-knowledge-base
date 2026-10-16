/**
 * Voice dictation: the browser's audio goes to Mistral, the text comes back.
 *
 * This is the main input path on the phone, where the user never types on a
 * keyboard. The browser records, sends the raw file, and we hand it to
 * voxtral-mini-latest (OpenAI-compatible API, JSON reply with a text field).
 *
 * The key never leaves the server: the browser talks to our API, not to
 * Mistral's.
 */

const MODEL = process.env.AGENDA_STT_MODEL || 'voxtral-mini-latest'
const URL = process.env.AGENDA_STT_URL || 'https://api.mistral.ai/v1/audio/transcriptions'
// The language forced on the transcription (ISO 639-1 code). Empty: auto-detect.
const LANGUAGE = process.env.AGENDA_STT_LANGUAGE ?? 'fr'
// The context steers the spelling of proper nouns that come up every day and
// that the model would otherwise write phonetically: first names, brands,
// jargon. Empty by default.
const CONTEXT = String(process.env.AGENDA_STT_PROMPT || '').trim()

// The extensions Mistral accepts. The file name matters: it announces the
// format, and Safari on iPhone records in mp4, not webm.
const EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'video/mp4': 'mp4'
}

export function sttReady () {
  return Boolean(process.env.MISTRAL_API_KEY)
}

export async function transcribe (buffer, mime = 'audio/webm', { signal } = {}) {
  const key = process.env.MISTRAL_API_KEY
  if (!key) throw new Error('MISTRAL_API_KEY missing')
  if (!buffer?.length) throw new Error('empty audio')

  const base = String(mime).split(';')[0].trim()
  const ext = EXT[base] || 'webm'

  const form = new FormData()
  form.append('file', new Blob([buffer], { type: base }), `dictation.${ext}`)
  form.append('model', MODEL)
  // Without a forced language, a short noisy sentence sometimes comes back in
  // a language other than the user's.
  if (LANGUAGE) form.append('language', LANGUAGE)
  form.append('response_format', 'json')
  if (CONTEXT) form.append('prompt', CONTEXT)

  const res = await fetch(URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Mistral ${res.status}: ${txt.slice(0, 200)}`)
  }
  const data = await res.json()
  return String(data.text || '').trim()
}
