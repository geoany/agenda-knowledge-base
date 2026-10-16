import { db, now } from './db.js'
import { gcalEnabled, syncGcal } from './gcal.js'
import { publish } from './bus.js'

/**
 * The internal clock: the process's small scheduler, for what does not deserve
 * a system cron. The external cron still triggers the night run (it survives a
 * process crash); the clock only handles the Google mirror and light cleanup.
 * The rule engine run after a burst of gestures is switched off.
 */

let lastPurge = 0
let lastGcal = 0

/* Every fifteen minutes. An appointment booked on the phone must show up in the
   day without anyone doing anything, but Google has no notification to push to
   us: so we go and look. Fifteen minutes is the chosen compromise; below that we
   query Google for nothing most of the time. */
const GCAL_PERIOD = 15 * 60_000

export function startClock () {
  const tick = setInterval(async () => {
    if (gcalEnabled() && now() - lastGcal > GCAL_PERIOD) {
      lastGcal = now()
      try {
        const r = await syncGcal()
        // Only ask the screen to refresh if something really changed: a refresh
        // every fifteen minutes for nothing would make the week flicker before
        // the user's eyes.
        if (r.ok && (r.created || r.updated || r.deleted)) publish('refresh', { reason: 'gcal' })
      } catch (e) { console.error('gcal:', e.message) }
    }
    if (now() - lastPurge > 86_400_000) {
      lastPurge = now()
      try {
        db.prepare('DELETE FROM gestures WHERE created_at < ?').run(now() - 90 * 86_400_000)
      } catch (e) { console.error('gesture purge:', e.message) }
    }
  }, 60_000)
  tick.unref?.()
}
