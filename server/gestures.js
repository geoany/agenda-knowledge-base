import { db, now } from './db.js'

/**
 * The gesture bus: every user action IN THE INTERFACE goes through here.
 *
 * Hooked to HTTP routes only, never to tasks.js: the agent and the night run
 * write straight into tasks.js, so everything arriving here is a human gesture,
 * by construction.
 *
 * `recordGesture` is called via setImmediate AFTER the route has replied: the
 * user's gesture never waits for anything.
 *
 * The agent no longer reacts to these gestures, and that decision was made on
 * the numbers: over the whole life of the app, 5 interjections were emitted and
 * 5 rejected. Four of the five fired when the user moved rows to the top of the
 * list, that is while they were TIDYING. Being interrupted while organizing your
 * day is the worst possible moment.
 *
 * What remains: the `gestures` table, raw material for the rule engine, and the
 * burst that triggers its cycle. No speaking.
 */

/* The burst: a salvo of close gestures followed by a silence. It is the
 * opportunistic trigger of the rule engine (wave 3). Only timestamps are kept
 * in memory; the consumer subscribes through onBurst(). */
const BURST_GESTURES = 8
const BURST_WINDOW_MS = 10 * 60_000
const BURST_QUIET_MS = 5 * 60_000
const recent = []
let quietTimer = null
let burstSubscriber = null

export function onBurst (cb) { burstSubscriber = cb }

function countBurst () {
  const t = now()
  recent.push(t)
  while (recent.length && recent[0] < t - BURST_WINDOW_MS) recent.shift()
  if (recent.length < BURST_GESTURES || !burstSubscriber) return
  if (quietTimer) clearTimeout(quietTimer)
  quietTimer = setTimeout(() => {
    recent.length = 0
    try { burstSubscriber() } catch (e) { console.error('burst:', e.message) }
  }, BURST_QUIET_MS)
  quietTimer.unref?.()
}

/**
 * @param type  check | uncheck | edit | delete | move | reorder | top | state | create
 * @param meta  what the gestures table must keep (fromDay, toDay, count...)
 */
export function recordGesture ({ type, taskId = null, meta = {} }) {
  setImmediate(() => {
    try {
      db.prepare('INSERT INTO gestures (type, task_id, payload, created_at) VALUES (?,?,?,?)')
        .run(type, taskId, JSON.stringify(meta), now())
      countBurst()
    } catch (e) {
      console.error('gesture:', e.message)
    }
  })
}
