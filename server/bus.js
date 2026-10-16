/**
 * The server-to-front channel: a persistent SSE stream on GET /api/events.
 *
 * This is what lets the agent reach the user WHILE they are using the app,
 * instead of waiting for them to open the chat. EventSource on the front: auth
 * goes through the session cookie, reconnection is built in, and the project
 * already speaks SSE with /api/chat. No WebSocket: a dependency for a
 * bidirectional channel whose front-to-server direction already exists as REST.
 *
 * Emitted events:
 *   intervention : the agent just spoke about a gesture (open the drawer)
 *   message      : a message appeared in a thread outside a chat reply
 *   refresh      : rows changed on the server, reload if possible
 */

const clients = new Set()

// An SSE comment every 25 seconds: Cloudflare and Traefik drop silent
// connections, and a frozen iOS PWA must notice the drop to reopen.
const HEARTBEAT_MS = 25_000
let heartbeat = null

export function connectClient (req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive'
  })
  res.write(': open\n\n')
  clients.add(res)
  // res.on('close'), never req.on('close'): req emits close as soon as its body
  // has been read, which would close the stream before the first event.
  res.on('close', () => {
    clients.delete(res)
    if (!clients.size && heartbeat) { clearInterval(heartbeat); heartbeat = null }
  })
  if (!heartbeat) {
    heartbeat = setInterval(() => {
      for (const c of clients) { try { c.write(': ping\n\n') } catch { clients.delete(c) } }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
  }
}

export function publish (type, payload = {}) {
  if (!clients.size) return 0
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
  let n = 0
  for (const c of clients) {
    try { c.write(frame); n++ } catch { clients.delete(c) }
  }
  return n
}

export function clientCount () { return clients.size }
