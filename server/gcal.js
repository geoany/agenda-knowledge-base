import https from 'node:https'
import { createHash } from 'node:crypto'
import ICAL from 'ical.js'
import { db, now, logJournal } from './db.js'
import { getTask } from './tasks.js'
import { similar } from './text.js'

/**
 * Google Calendar, mirrored into the agenda.
 *
 * What this file does: it fetches the user's calendar from Google as an .ics
 * file (the standard format for calendars), expands the appointments that
 * repeat (a weekly class is written ONCE in the file, with its recurrence
 * rule), and places each appointment of the current window as a line of the
 * agenda.
 *
 * Three choices that are not negotiable:
 *
 * 1. A Google appointment is a TASK, not a new type of object. The whole app
 *    knows only one data model, and the time grid, the outliner and the agent
 *    already know how to do everything with it. Adding an events table would
 *    have forced every display to be doubled.
 * 2. These tasks are CHECKED like the others (the sync never touches the
 *    `checked` column), but their DATE is a mirror: the truth lives in Google.
 *    The machine has no right to move them (a guard in `moveTask`), and the next
 *    sync puts back the time Google announces. To cancel an appointment, you
 *    cancel it in Google.
 * 3. We NEVER touch a task outside the synced window. Without that rule, the
 *    first sync of an empty calendar would erase the whole history of past
 *    appointments.
 *
 * Two traps already paid for, not to be rediscovered:
 *
 * - Google can answer 429 ("automated queries") on the IPv6 of a hosted server
 *   and 200 on its IPv4. Hence the forced `family: 4` below. Without it, the
 *   sync fails with an HTML error page instead of a calendar, permanently.
 * - An "all day" date has no time. Converting it through a timezone shifts it by
 *   a day (an appointment on the 22nd becomes the 21st). So we read its raw
 *   fields, without going through the timezone.
 */

/* The agenda's timezone: the process one (TZ), like `today()` in db.js. */
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const MAX_DURATION = 8 * 60          // beyond that, it does not occupy the grid: it is context, not a slot
const OCCURRENCE_CAP = 2000          // a net against a malformed infinite recurrence rule

/** The .ics URLs to follow, comma-separated in the environment. */
export function sources () {
  return String(process.env.AGENDA_GCAL_ICS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

export const gcalEnabled = () => sources().length > 0

/**
 * The short fingerprint of an .ics source: it files a line of the mirror under
 * the calendar that provided it. We hash the whole URL (secret calendar URLs are
 * tokens, we do not want to copy them in clear into the database) into twelve
 * hex characters, largely enough to tell two or three sources apart.
 */
export function sourceFingerprint (url) {
  return createHash('sha1').update(String(url)).digest('hex').slice(0, 12)
}

/**
 * Downloads a URL forcing IPv4 (see the Google trap above).
 * No `fetch` here: it does not allow choosing the address family without
 * embedding a dispatcher, and that is precisely the only setting we need.
 */
function download (url, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      family: 4,
      headers: { 'user-agent': 'agenda/1.0', accept: 'text/calendar' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return download(res.headers.location, { timeoutMs }).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => { buf += c })
      res.on('end', () => resolve(buf))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
  })
}

/* The day and the time in the agenda's timezone, computed explicitly by Intl:
   we never trust the server's raw clock to say "which day". */
const fmtLocal = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
})
function toLocal (dateJs) {
  const p = Object.fromEntries(fmtLocal.formatToParts(dateJs).map(x => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` }
}

/**
 * The real instant of a calendar time written in a given timezone.
 *
 * We look for the inverse of what `Intl` knows how to do: "14:00 on October 27
 * in Paris, which instant is that?". We start from a first guess in UTC, look at
 * what that zone would display at that instant, and correct by the gap. Two
 * passes are enough, the second only serving for times right inside the jump of
 * a daylight-saving change.
 */
function instantInZone (y, mo, d, h, mi, tz) {
  const target = Date.UTC(y, mo - 1, d, h, mi)
  let t = target
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23'
      }).formatToParts(new Date(t)).map(x => [x.type, x.value])
    )
    const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
    const delta = target - seen
    if (!delta) break
    t += delta
  }
  return t
}

/**
 * The time of an appointment, brought back to the agenda's timezone, WITHOUT
 * depending on the VTIMEZONE block.
 *
 * Trap paid for in testing: when the file does not declare the timezone it uses
 * (which Google always does, but other emitters do not), the library treats the
 * time as UTC and the whole calendar shifts by two hours in summer, one in
 * winter. So we do NOT read the computed instant: we read the digits written in
 * the file ("14:00") and the name of the timezone next to it, and do the
 * conversion ourselves. The by far most frequent case, a calendar already
 * written in the agenda's timezone, then needs no conversion at all, so no
 * chance of getting it wrong.
 */
function localTime (t) {
  const zone = t.zone?.tzid || (t.zone === ICAL.Timezone.utcTimezone ? 'UTC' : null)
  const day = rawDay(t)
  const hm = `${pad(t.hour)}:${pad(t.minute)}`

  // Already in the agenda's timezone, or a "floating" time (without a timezone,
  // so local by definition): the digits of the file are already the right ones.
  if (!zone || zone === TZ || zone === 'floating') return { day, hm, epoch: instantInZone(t.year, t.month, t.day, t.hour, t.minute, TZ) }

  const tz = zone === 'Z' ? 'UTC' : zone
  let epoch
  try {
    epoch = instantInZone(t.year, t.month, t.day, t.hour, t.minute, tz)
  } catch {
    // Timezone unknown to Intl (a homemade TZID from old software): we would
    // rather show the written time than shift it at random.
    return { day, hm, epoch: instantInZone(t.year, t.month, t.day, t.hour, t.minute, TZ) }
  }
  return { ...toLocal(new Date(epoch)), epoch }
}
const pad = n => String(n).padStart(2, '0')
const rawDay = t => `${t.year}-${pad(t.month)}-${pad(t.day)}`
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/**
 * Expands an .ics calendar into dated occurrences, over a closed window.
 *
 * We bound the window BEFORE expanding the recurrences: a weekly class with no
 * end date would otherwise produce an infinite series.
 */
export function occurrences (raw, { start, end }) {
  const comp = new ICAL.Component(ICAL.parse(raw))
  const calName = comp.getFirstPropertyValue('x-wr-calname') || null
  const startBound = ICAL.Time.fromJSDate(new Date(`${start}T00:00:00Z`), true)
  const endBound = ICAL.Time.fromJSDate(new Date(`${end}T23:59:59Z`), true)
  const events = []

  for (const ve of comp.getAllSubcomponents('vevent')) {
    let ev
    try { ev = new ICAL.Event(ve) } catch { continue }
    // A recurrence exception ("the September 1st class moves to 16:00") is
    // carried by the master event's iterator: handling it here as well would
    // make it appear twice.
    if (ev.isRecurrenceException()) continue

    if (ev.isRecurring()) {
      let it
      try { it = ev.iterator() } catch { continue }
      let next, guard = 0
      while ((next = it.next()) && guard++ < OCCURRENCE_CAP) {
        if (next.compare(endBound) > 0) break
        if (next.compare(startBound) < 0) continue
        let det
        try { det = ev.getOccurrenceDetails(next) } catch { continue }
        pushEvent(events, ev, det.item, det.startDate, det.endDate, next)
      }
    } else {
      if (!ev.startDate) continue
      if (ev.endDate && ev.endDate.compare(startBound) < 0) continue
      if (ev.startDate.compare(endBound) > 0) continue
      pushEvent(events, ev, ev, ev.startDate, ev.endDate, null)
    }
  }
  return { calName, events }
}

function pushEvent (acc, ev, item, start, end, occId) {
  // A cancelled appointment stays in the file with that status: without this
  // test, it would keep occupying the slot after its cancellation.
  const status = item.component?.getFirstPropertyValue('status')
  if (String(status || '').toUpperCase() === 'CANCELLED') return

  const title = String(item.summary || '').trim() || '(no title)'
  const location = String(item.location || '').trim()
  const allDay = start.isDate

  if (allDay) {
    // An all-day event spanning three days must show on all three days,
    // otherwise the user believes their Saturday is free. The end date of an
    // .ics is exclusive.
    const d0 = rawDay(start)
    const d1 = end ? rawDay(end) : d0
    let j = d0, guard = 0
    do {
      acc.push({ uid: ev.uid, occId: j, day: j, startAt: null, durationMin: null, title, location, allDay: true })
      j = addDays(j, 1)
    } while (j < d1 && guard++ < 30)
    return
  }

  const l = localTime(start)
  const f = end ? localTime(end) : null
  let length = f ? Math.round((f.epoch - l.epoch) / 60_000) : null
  if (!(length > 0)) length = null
  if (length > MAX_DURATION) length = null
  const base = occId ? occId.toICALString() : `${l.day}T${l.hm}`

  acc.push({
    uid: ev.uid,
    occId: base,
    day: l.day,
    startAt: l.hm,
    durationMin: length,
    title,
    location,
    allDay: false
  })

  // An appointment with a time can last SEVERAL DAYS: "seaside holiday, from the
  // 8th to the 16th" is written as a single event that starts at 8:00 on the 8th
  // and ends at 18:00 on the 16th. Placed on the departure day alone, it
  // disappeared from the whole following week, and it is yet the most important
  // piece of information of that week. So we spread it over the days it crosses,
  // as all-day: past the first day, the start time no longer means anything.
  if (!f || f.day <= l.day) return
  // An end at midnight exactly belongs to the previous day: an appointment from
  // 22:00 to midnight does not spill over into the next day.
  const last = f.hm === '00:00' ? addDays(f.day, -1) : f.day
  let j = addDays(l.day, 1), guard = 0
  while (j <= last && guard++ < 60) {
    acc.push({
      uid: ev.uid,
      occId: `${base}#${j}`,
      day: j,
      startAt: null,
      durationMin: null,
      title,
      location,
      allDay: true,
      continued: true
    })
    j = addDays(j, 1)
  }
}

/** The stable identity of an occurrence: it survives a daylight-saving change. */
const externalKey = o => `gcal:${o.uid}::${o.occId}`

/** The text shown in the agenda. The location fits on the same line, in grey. */
const contentOf = o => (o.location ? `${o.title} · ${o.location}` : o.title)

/**
 * Syncs the calendars configured in the requested window.
 *
 * The principle is a reconciliation, not a wipe followed by a fill: we compare
 * what exists with what Google says and touch only what differs. Without that,
 * every pass would change the identifier of every appointment and the whole grid
 * would flicker every fifteen minutes.
 */
export async function syncGcal ({ before = 7, after = 28, dryRun = false, refDay = null } = {}) {
  const urls = sources()
  const t0 = Date.now()
  if (!urls.length) return { ok: false, reason: 'no source configured (AGENDA_GCAL_ICS)' }

  const anchor = refDay || toLocal(new Date()).day
  const start = addDays(anchor, -Math.abs(before))
  const end = addDays(anchor, Math.abs(after))

  const batch = []
  const errors = []
  let calName = null
  // The sources that ANSWERED. This is what bounds deletion: a failing source
  // must not erase the appointments of the other, and without this list we would
  // not know who owns a line missing from the batch.
  const okSources = new Set()
  for (const url of urls) {
    const src = sourceFingerprint(url)
    try {
      const raw = await download(url)
      if (!/BEGIN:VCALENDAR/.test(raw)) throw new Error('response without a calendar (Google may have refused the request)')
      const r = occurrences(raw, { start, end })
      calName = calName || r.calName
      batch.push(...r.events.map(o => ({ ...o, src })))
      okSources.add(src)
    } catch (e) {
      errors.push(`${url.slice(0, 60)}… : ${e.message}`)
    }
  }
  // A download failure must NEVER turn into an erasure: "Google did not answer"
  // and "the user has no appointments left" are two opposite things, and only
  // the second allows deleting.
  if (errors.length && !batch.length) {
    return { ok: false, reason: errors.join(' | '), durationMs: Date.now() - t0 }
  }

  // Two appointments can share a key if the calendar is inconsistent: the last
  // one read wins, rather than a uniqueness violation that breaks the pass.
  const byKey = new Map()
  for (const o of batch) byKey.set(externalKey(o), o)

  // The reconciliation is done on the WHOLE mirror, without a day bound: the
  // external key is unique in the whole table, and a line pushed outside the
  // window (by a user gesture, or by an appointment postponed by a month in
  // Google) must be found again and corrected, not recreated as a duplicate.
  const existing = db.prepare(
    "SELECT id, external_id, day, content, start_at, duration_min, gcal_src FROM tasks WHERE source = 'gcal'"
  ).all()
  const byExistingKey = new Map(existing.map(r => [r.external_id, r]))

  /**
   * The user's calendar does not contain only appointments: they also put in it
   * reminders that ARE tasks ("Oil change", while the day already carries "Car
   * oil change"). When the task already exists in the day, importing it a second
   * time gives two lines for a single job, and only one of the two can be
   * checked. So we set the occurrence aside, without ever writing anything on
   * THEIR line: the mirror must not modify what the user typed, it just has to
   * not double it.
   *
   * The matching is textual and deterministic (`similar`, the same brick that
   * already deduplicates rules and facts), not a model call: it runs every
   * fifteen minutes, it must be instant and give the same result twice. Measured
   * on real data: the reminder finds its task again, and the dozens of other
   * pairs of the same day are left alone.
   */
  // What the user threw away from the mirror does not come back. The link to
  // Google being read-only, the deletion can only be local: without this list,
  // it would be undone on the next quarter hour.
  const hidden = new Set(db.prepare('SELECT external_id FROM gcal_hidden').all().map(r => r.external_id))

  const alreadyInDay = (day, content) => {
    const lines = db.prepare(
      "SELECT content FROM tasks WHERE day = ? AND source IS NULL AND content <> ''"
    ).all(day)
    return lines.some(l => similar(content, l.content))
  }

  const tally = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 }
  const detail = { created: [], updated: [], deleted: [], skipped: [] }

  const insert = db.prepare(`
    INSERT INTO tasks (parent_id, day, content, note, checkbox, position, source, external_id, start_at, duration_min, gcal_src, created_at, modified_at)
    VALUES (NULL, ?, ?, '', 1, ?, 'gcal', ?, ?, ?, ?, ?, ?)
  `)
  const update = db.prepare(
    'UPDATE tasks SET day = ?, content = ?, start_at = ?, duration_min = ?, gcal_src = ?, modified_at = ? WHERE id = ?'
  )
  const del = db.prepare("DELETE FROM tasks WHERE id = ? AND source = 'gcal'")

  const apply = db.transaction(() => {
    const t = now()
    for (const [key, o] of byKey) {
      const content = contentOf(o)
      const old = byExistingKey.get(key)
      // The task already exists in that day: we do not make a second one. The
      // test runs BEFORE creation as before update, so that the already placed
      // duplicate disappears too (it will not be in the kept keys, so the
      // deletion loop below wins).
      if (hidden.has(key) || alreadyInDay(o.day, content)) {
        byKey.delete(key)
        tally.skipped++
        detail.skipped.push(`${o.day} ${o.title}`)
        continue
      }
      if (!old) {
        // Position: above everything already placed that day. A fixed
        // appointment is read first, the rest of the day arranges itself around
        // it.
        const min = db.prepare('SELECT MIN(position) p FROM tasks WHERE day = ? AND parent_id IS NULL').get(o.day)?.p
        const pos = min == null ? 0 : min - 1000
        insert.run(o.day, content, pos, key, o.startAt, o.durationMin, o.src, t, t)
        tally.created++
        detail.created.push(`${o.day} ${o.startAt || 'day'} ${o.title}`)
        continue
      }
      const changed = old.day !== o.day || old.content !== content ||
        (old.start_at || null) !== (o.startAt || null) ||
        (old.duration_min ?? null) !== (o.durationMin ?? null) ||
        (old.gcal_src || null) !== (o.src || null)
      if (changed) {
        update.run(o.day, content, o.startAt, o.durationMin, o.src, t, old.id)
        tally.updated++
        detail.updated.push(`${o.day} ${o.startAt || 'day'} ${o.title}`)
      } else tally.unchanged++
    }
    // The deletion, though, stays bounded to the window: outside the window we
    // asked Google nothing, so the absence of an appointment proves nothing.
    // Without that bound, the first sync would erase the whole history of past
    // appointments.
    //
    // And it touches ONLY the sources that answered this round: a failing source
    // said nothing about its appointments, so its silence does not prove they are
    // gone. Without that bound, a single source going down erased in cascade
    // (without trash) all the appointments of the other over −7/+28 days, then
    // recreated them unchecked with new identifiers. A line whose source is not
    // in `okSources` (an unknown source from before the field, included) is
    // therefore left as is.
    for (const [key, old] of byExistingKey) {
      if (byKey.has(key)) continue
      if (!old.gcal_src || !okSources.has(old.gcal_src)) continue
      if (!old.day || old.day < start || old.day > end) continue
      del.run(old.id)
      tally.deleted++
      detail.deleted.push(`${old.day} ${old.start_at || 'day'} ${old.content}`)
    }
  })

  if (!dryRun) apply()

  const summary = `${tally.created} created, ${tally.updated} updated, ${tally.deleted} removed, ${tally.unchanged} unchanged` +
    (tally.skipped ? `, ${tally.skipped} skipped as already in the day` : '')
  if (!dryRun && (tally.created || tally.updated || tally.deleted || tally.skipped)) {
    logJournal('gcal', `Calendar synced: ${summary}`, JSON.stringify(detail))
  }
  return {
    ok: true,
    calendar: calName,
    window: { start, end },
    occurrences: byKey.size,
    ...tally,
    detail,
    errors,
    summary,
    durationMs: Date.now() - t0
  }
}

/** True if this task comes from Google Calendar (so untouchable). */
export function isGcal (idOrTask) {
  const t = typeof idOrTask === 'object' ? idOrTask : getTask(idOrTask)
  return !!t && t.source === 'gcal'
}

/** The readable state of the mirror, for the API and for the agent. */
export function gcalStatus () {
  const urls = sources()
  const n = db.prepare("SELECT COUNT(*) n FROM tasks WHERE source = 'gcal'").get().n
  const last = db.prepare("SELECT summary, created_at FROM journal WHERE kind = 'gcal' ORDER BY id DESC LIMIT 1").get()
  return {
    enabled: urls.length > 0,
    sources: urls.length,
    appointments: n,
    lastSync: last ? { summary: last.summary, at: last.created_at } : null
  }
}
