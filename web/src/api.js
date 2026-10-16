/**
 * The access token only shows up in the URL on the very first visit
 * (?t=... link). We store it in localStorage right away and clean the address
 * bar, so it stays neither in the browser history, nor in synced bookmarks,
 * nor in the server logs.
 */
const KEY = 'agenda.token'

export function bootToken () {
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('t')
  if (fromUrl) {
    localStorage.setItem(KEY, fromUrl)
    url.searchParams.delete('t')
    history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
  }
  return localStorage.getItem(KEY) || ''
}

export const getToken = () => localStorage.getItem(KEY) || ''
export const setToken = t => localStorage.setItem(KEY, t)

/**
 * A user gesture: one id shared by every write call it triggers (pasting ten
 * lines = one gesture). The server files everything those calls change under
 * this id, and Ctrl+Z undoes the whole gesture (server/history.js). The label
 * is what the "Undone: …" message will say.
 */
export const newGesture = label => ({
  id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  label: String(label || '').slice(0, 100)
})

async function req (method, path, body, gesture) {
  const res = await fetch(`/api${path}`, {
    method,
    // The long-lived session travels as a cookie: always send it, it is what
    // recognizes a device whose localStorage was cleared.
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(gesture ? { 'x-gesture': gesture.id, 'x-gesture-label': encodeURIComponent(gesture.label || '') } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (res.status === 401) throw new Error('unauthorized')
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

/**
 * Writes go out ONE at a time, in the order the screen made them. Two quick
 * gestures can no longer reach the server out of order, and Ctrl+Z waits for
 * everything already sent to land before undoing anything (`writesSettled`).
 */
let writeQueue = Promise.resolve()
function write (method, path, body, gesture) {
  const p = writeQueue.then(() => req(method, path, body, gesture))
  writeQueue = p.catch(() => {})
  return p
}
export const writesSettled = () => writeQueue

export const api = {
  bootstrap: day => req('GET', `/bootstrap${day ? `?day=${day}` : ''}`),
  week: monday => req('GET', `/week/${monday}`),
  day: d => req('GET', `/day/${d}`),
  create: (payload, g) => write('POST', '/tasks', payload, g),
  update: (id, patch, g) => write('PATCH', `/tasks/${id}`, patch, g),
  remove: (id, g) => write('DELETE', `/tasks/${id}`, undefined, g),
  move: (id, day, parentId, g) => write('POST', `/tasks/${id}/move`, { day, parentId }, g),
  reorder: (id, opts, g) => write('POST', `/tasks/${id}/reorder`, opts, g),
  number: (ids, start, g) => write('POST', '/tasks/number', { ids, start }, g),
  rules: () => req('GET', '/rules'),
  addRule: text => req('POST', '/rules', { text }),
  delRule: id => req('DELETE', `/rules/${id}`),
  facts: () => req('GET', '/facts'),
  delFact: id => req('DELETE', `/facts/${id}`),
  reviewPreview: day => req('GET', `/review/preview${day ? `?day=${day}` : ''}`),
  review: day => req('POST', '/review', { day }),
  reviews: () => req('GET', '/reviews'),
  undoReview: id => req('POST', `/review/${id}/undo`, {}),
  journal: () => req('GET', '/journal'),

  // Attachments. Uploading the binary itself lives in Attachments.jsx, which
  // sets its own headers; here only what another screen may want.
  attachments: taskId => req('GET', `/attachments?taskId=${taskId}`),
  dayAttachments: ids => req('GET', `/attachments/by-task?ids=${ids.join(',')}`),
  attachLink: (url, target) => req('POST', '/attachments/link', { url, ...target }),
  removeAttachment: id => req('DELETE', `/attachments/${id}`),

  // The knowledge base, a separate building block: its routes never touch tasks.
  kbTree: () => req('GET', '/kb/tree'),
  kbNote: path => req('GET', `/kb/note?path=${encodeURIComponent(path)}`),
  kbSaveNote: (path, { title, content, tags }, g) => write('PUT', '/kb/note', { path, title, content, tags }, g),
  kbDeleteNote: (path, g) => write('DELETE', `/kb/note?path=${encodeURIComponent(path)}`, undefined, g),
  kbMoveNote: (from, to, g) => write('POST', '/kb/move', { from, to }, g),
  kbSearch: q => req('GET', `/kb/search?q=${encodeURIComponent(q)}`),
  kbReindex: () => req('POST', '/kb/reindex', {}),

  // The trash: no deletion is final anymore.
  trash: () => req('GET', '/trash'),
  restoreTrash: (id, g) => write('POST', `/trash/${id}/restore`, {}, g),

  // Opening an insight: this click is what creates the conversation thread,
  // with the agent's finding already in it. Nothing exists until asked for.
  openInsight: id => req('POST', `/interventions/${id}/open`),
  patchIntervention: (id, patch) => req('PATCH', `/interventions/${id}`, patch),

  // Ctrl+Z / Ctrl+Y: a single history, screen gestures and agent turns
  // together (server/history.js).
  history: () => req('GET', '/history'),
  undo: () => write('POST', '/history/undo', {}),
  redo: () => write('POST', '/history/redo', {}),

  // The brain's control screen: rules, engine candidates, interventions.
  agentState: () => req('GET', '/agent/state'),
  patchRule: (id, action, days) => req('PATCH', `/rules/${id}`, { action, days }),
  rejectCandidate: id => req('PATCH', `/candidates/${id}`, { status: 'dead' }),

  transcribe: (blob, signal) => transcribeAudio(blob, signal),
  conversations: () => req('GET', '/conversations'),
  newConversation: title => req('POST', '/conversations', { title }),
  conversation: id => req('GET', `/conversations/${id}`),
  renameConversation: (id, title) => req('PATCH', `/conversations/${id}`, { title }),
  delConversation: id => req('DELETE', `/conversations/${id}`),
  messages: conversationId => req('GET', `/messages${conversationId ? `?conversationId=${conversationId}` : ''}`),

  // Sending no longer returns the answer: it puts the message in the server
  // queue and returns at once. The work is followed through the event stream,
  // and the answer lands in the database even if the app is closed meanwhile.
  chat: (message, { conversationId } = {}) => req('POST', '/chat', { message, conversationId }),
  chatState: conversationId => req('GET', `/chat/state${conversationId ? `?conversationId=${conversationId}` : ''}`),

  // "Send to a worker": a detached headless session in a Claude Code
  // compatible CLI. No conversation, just an id and a status.
  // `taskId` (optional) is the goal picked in the agenda: the server names the
  // task in the prompt and asks the worker to update it once the work is done
  // and checked.
  workerOptions: () => req('GET', '/worker/options'),
  sendToWorker: (instruction, worker, taskId) => req('POST', '/worker', { instruction, worker, taskId }),
  workerStatus: id => req('GET', `/worker/${id}`)
}

/**
 * One event stream for the whole app, and several screens that want to listen
 * to it. `App` opens the connection and rebroadcasts here; the chat subscribes.
 * Opening a second EventSource from the chat would work, but it would be a
 * second permanent connection for the same bytes.
 */
const subscribers = new Set()
export function subscribe (fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}
export function broadcast (type, data) {
  for (const fn of subscribers) { try { fn(type, data) } catch {} }
}

/**
 * The server event stream. It carries what the server decides on its own
 * (`refresh`: some lines moved) AND the agent's work in progress
 * (`chat`: a step, a finished answer, an error), since the turn no longer
 * travels in the response of `POST /api/chat`.
 *
 * Every event also goes to local subscribers (`subscribe`): that is how the
 * chat follows a turn without opening its own connection.
 *
 * EventSource carries no headers: auth goes through the session cookie, set by
 * the server on every API call. If the cookie is missing (fresh storage), we
 * fall back to `?t=` after two failures, as on the very first visit.
 * Reconnection is native; `wake()` also forces a reopen when the app comes back
 * to the foreground, because iOS freezes a PWA's connection in the background.
 */
export function openEvents (onEvent) {
  let es = null
  let failures = 0
  let closed = false

  const open = (withToken) => {
    if (closed) return
    const url = withToken && getToken() ? `/api/events?t=${getToken()}` : '/api/events'
    es = new EventSource(url)
    es.onopen = () => { failures = 0 }
    es.onerror = () => {
      // A 401 does NOT trigger EventSource's native retry: the connection is
      // "failed", readyState CLOSED, and nothing ever restarts. So we reopen
      // ourselves, with the token in the query as a fallback for the cookie,
      // and stop after five attempts so as not to hammer a server that is down
      // (wake() will retry when the app returns to the foreground).
      if (es.readyState !== EventSource.CLOSED) return
      failures++
      if (failures > 5) return
      setTimeout(() => { if (!closed && es.readyState === EventSource.CLOSED) open(!!getToken()) }, 1000 * failures)
    }
    for (const type of ['intervention', 'message', 'refresh', 'chat']) {
      es.addEventListener(type, e => {
        let data = {}
        try { data = JSON.parse(e.data) } catch {}
        onEvent(type, data)
        broadcast(type, data)
      })
    }
  }

  open(false)
  return {
    wake () {
      if (closed || (es && es.readyState !== EventSource.CLOSED)) return
      failures = 0
      open(false)
    },
    close () { closed = true; es?.close() }
  }
}

/**
 * Audio goes out as a raw body, with its real MIME type: that is what tells
 * the server which extension to announce to the speech-to-text API, and Safari
 * on iPhone records mp4 where Chrome records webm.
 */
async function transcribeAudio (blob, signal) {
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': blob.type || 'audio/webm',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {})
    },
    body: blob,
    signal
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return (await res.json()).text || ''
}
