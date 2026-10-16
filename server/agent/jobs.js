/**
 * The agent's work no longer depends on the user's connection.
 *
 * Before, `POST /api/chat` ran the loop WHILE REPLYING: the HTTP response
 * carried the stream, and `res.on('close')` cut the turn. Locking one's phone,
 * switching apps or closing the tab therefore killed the work in progress, and
 * the reply was never written to the database (it is only saved at the end of
 * the turn, in loop.js). One had to stay in front of the screen waiting, which is
 * exactly the opposite of what one asks of an assistant.
 *
 * Here the turn runs in the process, for itself. It pushes what it does onto the
 * SSE bus (whether anyone listens or not), and it writes its reply to the
 * database at the end, as before. The browser is now only a spectator: present it
 * sees the steps live, absent it finds the reply written when it comes back.
 *
 * One queue per conversation, one turn at a time: two messages sent back to back
 * go one after the other, and the second sees what the first did. In parallel
 * they would each reason on a stale agenda.
 *
 * The queue lives in memory, deliberately. Persisting it would require a table,
 * a recovery at startup and a handling of half-done turns; what it would protect
 * is the case where the service restarts in the seconds following a send.
 * `chatState` can tell that a turn was interrupted, which is enough not to leave
 * a message without an answer in silence.
 */
import { runAgent } from './loop.js'
import { publish } from '../bus.js'

/** conversationId -> { queue, running, steps, since } */
const work = new Map()

function stateOf (conversationId) {
  let e = work.get(conversationId)
  if (!e) {
    e = { queue: [], running: null, steps: [], since: null }
    work.set(conversationId, e)
  }
  return e
}

/**
 * Puts a message in the queue and hands control back right away.
 *
 * The return says where the turn stands, not what the agent will answer: the
 * reply comes through the bus, or through the database for whoever comes back
 * later.
 */
export function enqueue (conversationId, message) {
  const e = stateOf(conversationId)
  e.queue.push(message)
  publish('chat', { conversationId, ev: { type: 'file', size: e.queue.length } })
  // Starts the turn without waiting for it: that is the whole point of the file.
  // The `catch` is a belt, `drain` already swallows its errors turn by turn.
  if (!e.running) drain(conversationId).catch(err => console.error('[chat] drain', err))
  return { queued: e.queue.length, running: !!e.running }
}

/**
 * What one needs to know on arriving (opening the app, coming back to the
 * foreground, switching thread): is a turn running for this thread, with which
 * steps already done, and what is waiting behind.
 *
 * This is what replaces the lost stream: a client coming back in the middle of a
 * turn picks the display up where it stands instead of seeing a blank.
 */
export function chatState (conversationId) {
  const e = work.get(conversationId)
  if (!e) return { running: null, steps: [], queue: [], since: null }
  return { running: e.running, steps: e.steps, queue: [...e.queue], since: e.since }
}

/** True if the agent is working somewhere, for the home screen. */
export function busyThreads () {
  const ids = []
  for (const [id, e] of work) if (e.running || e.queue.length) ids.push(id)
  return ids
}

async function drain (conversationId) {
  const e = stateOf(conversationId)
  while (e.queue.length) {
    const message = e.queue.shift()
    e.running = message
    e.steps = []
    e.since = Date.now()
    emit(conversationId, { type: 'start', message })
    try {
      for await (const ev of runAgent({ conversationId, message })) {
        // Tokens do not go out on the bus: they would leave for every connected
        // client, several per second, for a display the chat does not do. The
        // steps, on the other hand, are exactly what one watches.
        if (ev.type === 'token') continue
        if (ev.type === 'step') {
          const i = e.steps.findIndex(s => s.id === ev.id)
          if (i < 0) e.steps.push(ev)
          else e.steps[i] = ev
        }
        emit(conversationId, ev)
      }
    } catch (err) {
      console.error('[chat]', err)
      emit(conversationId, { type: 'error', message: String(err?.message || err) })
    } finally {
      e.running = null
      e.steps = []
      e.since = null
    }
  }
  emit(conversationId, { type: 'idle' })
}

function emit (conversationId, ev) {
  try { publish('chat', { conversationId, ev }) } catch {}
}
