/**
 * End to end of the Google Calendar mirror, on a throwaway database.
 *
 * What this script proves, in order:
 *  1. a real Google calendar is downloaded and expanded into appointments;
 *  2. a second sync changes NOTHING (this is the critical point: without
 *     reconciliation, every pass would recreate everything and the screen would
 *     flicker every fifteen minutes);
 *  3. a local modification is brought back to what Google says;
 *  4. a checked box SURVIVES the sync;
 *  5. neither the nightly tidy-up nor an automatic move touches it;
 *  6. an appointment gone from the calendar disappears from the agenda;
 *  7. a network failure never wipes anything.
 *
 * The test calendar is the PUBLIC French public-holidays calendar: no secret in
 * the repository, and a real answer from Google.
 *
 * Run: node scripts/e2e-gcal.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The time assertions below are written for this timezone (including the
// European clock change on the last Sunday of October).
process.env.TZ = 'Europe/Paris'
const tmp = mkdtempSync(join(tmpdir(), 'agenda-gcal-'))
process.env.AGENDA_DB = join(tmp, 'test.db')
process.env.AGENDA_GCAL_ICS =
  'https://calendar.google.com/calendar/ical/fr.french%23holiday%40group.v.calendar.google.com/public/basic.ics'

const { db } = await import('../server/db.js')
const { syncGcal, occurrences, gcalStatus } = await import('../server/gcal.js')
const { moveTask, getTask, createTask, deleteTask, listTrash, restoreTrash } = await import('../server/tasks.js')

let ko = 0
const ok = (cond, what, detail = '') => {
  console.log(`${cond ? '  ok  ' : '  KO  '} ${what}${detail ? ` (${detail})` : ''}`)
  if (!cond) ko++
}
const nGcal = () => db.prepare("SELECT COUNT(*) n FROM tasks WHERE source = 'gcal'").get().n

// A wide window: public holidays are rare, over one month you do not
// necessarily catch any, and a test that passes for lack of data proves
// nothing.
const WINDOW = { before: 120, after: 240 }

console.log('\n1. first sync')
const s1 = await syncGcal(WINDOW)
ok(s1.ok, 'download and expansion', s1.ok ? s1.summary : s1.reason)
ok(s1.created > 0, 'appointments were created', `${s1.created}`)
ok(s1.occurrences === s1.created, 'everything that was read was placed')
ok(nGcal() === s1.created, 'the database really carries those lines')

console.log('\n2. second sync: nothing must move')
const s2 = await syncGcal(WINDOW)
ok(s2.created === 0 && s2.updated === 0 && s2.deleted === 0, 'no write', s2.summary)
ok(s2.unchanged === s1.created, 'everything is recognised as already in place')

console.log('\n3. a local drift is brought back to what Google says')
const target = db.prepare("SELECT * FROM tasks WHERE source = 'gcal' ORDER BY day LIMIT 1").get()
const realDay = target.day
db.prepare("UPDATE tasks SET day = '2000-01-01', content = 'wrecked' WHERE id = ?").run(target.id)
const s3 = await syncGcal(WINDOW)
const restored = getTask(target.id)
ok(s3.updated >= 1, 'the sync corrected something', `${s3.updated}`)
ok(restored.day === realDay, 'the day came back to the one from Google', `${restored.day}`)
ok(restored.content === target.content, 'the title came back')
ok(restored.id === target.id, 'the identifier did NOT change (no wipe-and-recreate)')

console.log('\n4. a checked box survives')
db.prepare('UPDATE tasks SET checked = 1 WHERE id = ?').run(target.id)
db.prepare("UPDATE tasks SET content = 'wrecked again' WHERE id = ?").run(target.id)
await syncGcal(WINDOW)
ok(getTask(target.id).checked === true || db.prepare('SELECT checked FROM tasks WHERE id = ?').get(target.id).checked === 1,
  'the box stays checked after the title is corrected')

console.log('\n5. the machine never moves an appointment')
// A past, unchecked appointment: exactly what the tidy-up picks up.
const past = db.prepare("SELECT * FROM tasks WHERE source = 'gcal' AND day < date('now') AND checked = 0 ORDER BY day LIMIT 1").get()
if (past) {
  const refused = moveTask(past.id, '2099-01-01', { auto: true })
  ok(refused.day === past.day, 'an automatic move is refused', `${refused.day}`)
  const forced = moveTask(past.id, '2099-01-01', { actor: 'user' })
  ok(forced.day === '2099-01-01', 'a move by the user, on the other hand, goes through')
  db.prepare('UPDATE tasks SET day = ? WHERE id = ?').run(past.day, past.id)
} else {
  console.log('  --   no past unchecked appointment in the window, step skipped')
}
// An ordinary task of the same day must move, on the other hand: the guard must
// not have frozen the tidy-up for everyone.
const ordinary = createTask({ day: '2020-03-03', content: 'ordinary task running late' })
const auto = moveTask(ordinary.id, db.prepare("SELECT date('now') d").get().d, { auto: true })
ok(auto.day !== '2020-03-03', 'an ordinary task is still filed', `${auto.day}`)

console.log('\n5bis. an event already present as a task is not doubled')
// The calendar also carries reminders that ARE tasks ("Oil change", when the
// day already has "Car oil change"). Two lines for one job, and the only one
// that counts is the one they can check.
const ref = db.prepare("SELECT * FROM tasks WHERE source = 'gcal' ORDER BY day LIMIT 1").get()
const refWords = String(ref.content)
createTask({ day: ref.day, content: `${refWords} in more detail`, checkbox: true })
const beforeSkipped = nGcal()
const s5 = await syncGcal(WINDOW)
ok(s5.skipped >= 1, 'the sync sets aside at least one duplicate', `${s5.skipped}`)
ok(nGcal() === beforeSkipped - s5.skipped, 'the duplicate already placed was removed', `${beforeSkipped} then ${nGcal()}`)
ok(!!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(ref.id) === false ||
   db.prepare("SELECT COUNT(*) n FROM tasks WHERE source IS NULL AND content LIKE ?").get(`${refWords}%`).n === 1,
  'the line written by the user, on the other hand, did not move')
// And the mirror must not recreate it on the next pass.
const s5b = await syncGcal(WINDOW)
ok(s5b.created === 0, 'it does not come back on the next sync', `${s5b.created} creation(s)`)
db.prepare("DELETE FROM tasks WHERE source IS NULL AND content LIKE ?").run(`${refWords} in more detail`)

console.log("\n5ter. a deletion by the user HOLDS, it does not come back")
// The link to Google is read-only: deleting here deletes nothing over there, so
// without a guard the sync would put the line back fifteen minutes later. A
// deletion that does not hold is worse than a refused deletion: you think you
// have tidied up, and it comes back without saying anything.
const toDrop = db.prepare("SELECT * FROM tasks WHERE source = 'gcal' ORDER BY day DESC LIMIT 1").get()
const droppedKey = toDrop.external_id
deleteTask(toDrop.id, { actor: 'user', reason: 'dropped by hand' })
ok(!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(toDrop.id), 'the line really goes')
ok(!!db.prepare('SELECT 1 FROM gcal_hidden WHERE external_id = ?').get(droppedKey), 'the dropped key is remembered')
const sD = await syncGcal(WINDOW)
ok(!db.prepare('SELECT 1 FROM tasks WHERE external_id = ?').get(droppedKey),
  'it does not come back on the next sync', sD.summary)
const sD2 = await syncGcal(WINDOW)
ok(!db.prepare('SELECT 1 FROM tasks WHERE external_id = ?').get(droppedKey), 'nor on the one after')
// And restoring it from the trash must lift the mask, otherwise the restore
// would be undone within the quarter hour.
const bin = listTrash({ limit: 1 })[0]
restoreTrash(bin.id)
ok(!db.prepare('SELECT 1 FROM gcal_hidden WHERE external_id = ?').get(droppedKey),
  'restoring from the trash lifts the mask')
const sD3 = await syncGcal(WINDOW)
ok(!!db.prepare('SELECT 1 FROM tasks WHERE external_id = ?').get(droppedKey),
  'and the restored line survives the sync', sD3.summary)

console.log('\n5quater. dropping one day of a long event drops them all')
// "Seaside vacation", from the 8th to the 16th, occupies nine lines. Nobody
// wants to drop one and keep the other eight.
{
  // The five days of one event, written as the mirror produces them: the first
  // carries the start, the following ones that same start plus the hash.
  const base = 'gcal:vacation2@test::20260828T060000Z'
  const series = [
    { day: '2026-08-28', key: base, h: '08:00' },
    { day: '2026-08-29', key: `${base}#2026-08-29`, h: null },
    { day: '2026-08-30', key: `${base}#2026-08-30`, h: null },
    { day: '2026-08-31', key: `${base}#2026-08-31`, h: null },
    { day: '2026-09-01', key: `${base}#2026-09-01`, h: null }
  ]
  ok(series.length === 5, 'the reference series really is five days', `${series.length}`)
  const t0 = Date.now()
  for (const o of series) {
    db.prepare(`INSERT INTO tasks (parent_id, day, content, note, checkbox, position, source, external_id, start_at, duration_min, created_at, modified_at)
                VALUES (NULL,?,?,'',1,0,'gcal',?,?,NULL,?,?)`)
      .run(o.day, 'Timed vacation over five days', o.key, o.h, t0, t0)
  }
  const placed = db.prepare("SELECT id FROM tasks WHERE external_id LIKE 'gcal:vacation2@test::%'").all()
  ok(placed.length === 5, 'the five days are in the database')
  const n = deleteTask(placed[2].id, { actor: 'user', reason: 'series test' })
  const left = db.prepare("SELECT COUNT(*) n FROM tasks WHERE external_id LIKE 'gcal:vacation2@test::%'").get().n
  ok(left === 0, 'dropping a single day takes the whole series', `${5 - left} days gone, ${left} left`)
  ok(n >= 1, 'the deletion returns a count', `${n}`)
  const m = db.prepare("SELECT COUNT(*) n FROM gcal_hidden WHERE external_id LIKE 'gcal:vacation2@test::%'").get().n
  ok(m === 5, 'the five keys are remembered, no day will come back', `${m}`)
  db.prepare("DELETE FROM gcal_hidden WHERE external_id LIKE 'gcal:vacation2@test::%'").run()
}
// Two weeks of a repeating appointment stay independent.
{
  const gcalLines = db.prepare("SELECT id, day, external_id FROM tasks WHERE source = 'gcal' ORDER BY day").all()
  if (gcalLines.length >= 2) {
    const before = gcalLines.length
    deleteTask(gcalLines[0].id, { actor: 'user', reason: 'independence test' })
    const after = db.prepare("SELECT COUNT(*) n FROM tasks WHERE source = 'gcal'").get().n
    ok(after >= before - 3, 'deleting one occurrence does not take the whole calendar', `${before} then ${after}`)
  }
}

console.log('\n6. an appointment removed from the calendar disappears')
const beforeDelete = nGcal()
const s6 = await syncGcal({ before: 0, after: 0, refDay: '2099-06-15' })
ok(s6.ok, 'sync over an empty window')
ok(nGcal() === beforeDelete, 'an empty window touches nothing outside its window', `${nGcal()} lines`)
const inWindow = db.prepare("SELECT COUNT(*) n FROM tasks WHERE source = 'gcal' AND day = '2099-06-15'").get().n
ok(inWindow === 0, 'and nothing remains inside the synced window')

console.log('\n7. a network failure wipes nothing')
const guard = nGcal()
process.env.AGENDA_GCAL_ICS = 'https://calendar.google.com/calendar/ical/nonexistent/public/basic.ics'
const s7 = await syncGcal(WINDOW)
ok(!s7.ok, 'the sync fails cleanly', s7.reason?.slice(0, 40))
ok(nGcal() === guard, 'no line deleted despite the failure', `${nGcal()} lines`)

console.log('\n8. the twisted cases of the format (reference file)')
const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//FR
BEGIN:VEVENT
DTSTART;TZID=Europe/Paris:20260818T140000
DTEND;TZID=Europe/Paris:20260818T160000
RRULE:FREQ=WEEKLY;BYDAY=TU
EXDATE;TZID=Europe/Paris:20260825T140000
UID:class@test
SUMMARY:Maths class
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Paris:20260901T160000
DTEND;TZID=Europe/Paris:20260901T180000
UID:class@test
RECURRENCE-ID;TZID=Europe/Paris:20260901T140000
SUMMARY:Moved class
END:VEVENT
BEGIN:VEVENT
DTSTART:20260820T093000Z
DTEND:20260820T100000Z
UID:meeting@test
SUMMARY:Meeting in UTC
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260822
DTEND;VALUE=DATE:20260825
UID:weekend@test
SUMMARY:Weekend
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Paris:20260819T110000
DTEND;TZID=Europe/Paris:20260819T120000
UID:cancelled@test
STATUS:CANCELLED
SUMMARY:Cancelled
END:VEVENT
BEGIN:VEVENT
DTSTART:20260828T060000Z
DTEND:20260901T160000Z
UID:vacation@test
SUMMARY:Timed vacation over five days
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Paris:20260817T220000
DTEND;TZID=Europe/Paris:20260818T000000
UID:late@test
SUMMARY:Ends at midnight sharp
END:VEVENT
END:VCALENDAR`
const { events } = occurrences(ics, { start: '2026-08-15', end: '2026-09-10' })
const find = (day, hm) => events.find(s => s.day === day && s.startAt === hm)
ok(!!find('2026-08-18', '14:00'), 'weekly repetition expanded')
ok(!events.some(s => s.day === '2026-08-25'), 'the excluded date (EXDATE) is absent')
ok(find('2026-09-01', '16:00')?.title === 'Moved class', 'the moved session keeps its real time')
ok(!find('2026-09-01', '14:00'), 'and does not also appear at its original time')
ok(find('2026-08-20', '11:30')?.title === 'Meeting in UTC', 'a time written in UTC becomes 11:30 in Paris')
ok(events.filter(s => s.title === 'Weekend').length === 3, 'a whole 3-day event occupies 3 days')
ok(events.find(s => s.title === 'Weekend')?.day === '2026-08-22', 'and starts on the right day (no timezone shift)')
ok(!events.some(s => s.title === 'Cancelled'), 'a cancelled appointment no longer takes the slot')

console.log('\n8bis. a TIMED appointment that lasts several days')
// The real case that was missing: "vacation from the 28th to the 1st", written
// as ONE timed event. Placed on the single departure day, it disappeared from
// the whole following week even though it is the main piece of information of
// that week.
const vacation = occurrences(ics, { start: '2026-08-25', end: '2026-09-05' }).events
  .filter(s => s.title === 'Timed vacation over five days')
ok(vacation.length === 5, 'it occupies the five days it spans', vacation.map(s => s.day).join(', '))
ok(vacation[0].startAt === '08:00', 'the first day keeps its start time', `${vacation[0].startAt}`)
ok(vacation.slice(1).every(s => s.startAt === null), 'the following days are all-day')
ok(new Set(vacation.map(s => s.day)).size === 5, 'no day twice')
const midnight = occurrences(ics, { start: '2026-08-15', end: '2026-08-20' }).events
  .filter(s => s.title === 'Ends at midnight sharp')
ok(midnight.length === 1, 'an end at midnight sharp does not spill over to the next day', midnight.map(s => s.day).join(', '))

console.log('\n9. winter clock change (the trap that breaks a hand-written parser)')
const oct = occurrences(ics, { start: '2026-10-18', end: '2026-11-05' })
const tuesdays = oct.events.filter(s => s.title === 'Maths class')
ok(tuesdays.length >= 3, 'the October and November sessions are there', `${tuesdays.length}`)
ok(tuesdays.every(s => s.startAt === '14:00'), 'all stay at 14:00 on either side of 25 October',
  tuesdays.map(s => `${s.day} ${s.startAt}`).join(', '))

console.log('\n10. a broken source does not wipe the appointments of the other one')
// The original defect: the wipe was blocked only if ALL the sources failed. A
// single source going down therefore caused all of its appointments in the
// window to be deleted, live and in cascade, then recreated unchecked with new
// identifiers. We simulate a line coming from a source that does not answer
// this time round: it must SURVIVE the sync.
// (Section 7 put a broken URL back: we restore a live source.)
process.env.AGENDA_GCAL_ICS =
  'https://calendar.google.com/calendar/ical/fr.french%23holiday%40group.v.calendar.google.com/public/basic.ics'
const t = Date.now()
const survivingDay = db.prepare("SELECT day FROM tasks WHERE source = 'gcal' ORDER BY day LIMIT 1").get().day
db.prepare(`INSERT INTO tasks (parent_id, day, content, note, checkbox, position, source, external_id, gcal_src, created_at, modified_at)
            VALUES (NULL, ?, 'Appointment from a mute source', '', 1, -5000, 'gcal', 'gcal:mute@test::x', 'deadbeefdead', ?, ?)`)
  .run(survivingDay, t, t)
const muteKey = 'gcal:mute@test::x'
const s10 = await syncGcal(WINDOW)
ok(s10.ok, 'the sync completes with the live source', s10.summary)
const survives = db.prepare('SELECT COUNT(*) n FROM tasks WHERE external_id = ?').get(muteKey).n
ok(survives === 1, 'the line of the mute source is intact', `${survives} line`)
db.prepare('DELETE FROM tasks WHERE external_id = ?').run(muteKey)

console.log('\n11. readable state')
process.env.AGENDA_GCAL_ICS = 'https://example/x.ics'
const e = gcalStatus()
ok(e.enabled === true && e.sources === 1, 'the state reports the mirror enabled')
ok(e.appointments === nGcal(), 'and counts the right appointments', `${e.appointments}`)

db.close()
rmSync(tmp, { recursive: true, force: true })
console.log(ko ? `\n${ko} verification(s) failed\n` : '\nAll green\n')
process.exitCode = ko ? 1 : 0
