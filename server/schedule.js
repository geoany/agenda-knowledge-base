import { db, now, today } from './db.js'

/**
 * Times: a task can occupy a slot.
 *
 * A slot is NOT an object of its own. It is an ordinary task (same table, same
 * group, same state, same trash, same checkbox) to which two columns have been
 * added, `start_at` and `duration_min`. A meeting that could neither be checked,
 * nor postponed, nor filed in a group would be a foreign object in an app that
 * knows how to do nothing else.
 *
 * So this file holds only three things: understanding a time dictated in plain
 * language, storing it as a local 'HH:MM', and answering the questions one asks
 * about a day (in what order, where the gaps are, what overlaps, what comes
 * next).
 *
 * EVERYTHING is local, never UTC. The server may run in UTC while the user lives
 * in another zone (the service TZ): a slot at 15:00 must stay at 15:00, exactly
 * as `today()` in db.js reads the date from the local clock and never from
 * `toISOString()`.
 */

/* A task placed at a time without a duration still occupies something on
   screen, and still overlaps with its neighbour. Half an hour is the implicit
   duration of anything announced without thinking ("3pm, appointment with the
   plumber"): long enough to be seen, short enough not to invent a commitment. */
export const DEFAULT_DURATION = 30

/* The vague words of everyday speech. They are not guesses: they are the times
   the user means when they say "tomorrow morning", and the agent can always
   correct them afterwards. Placing nothing at all would be worse, the dictated
   sentence would be lost. The French words are kept alongside: they cost
   nothing. */
const MOMENTS = [
  [/\b(?:morning|matin(?:ee)?)\b/, '09:00'],
  [/\b(?:noon|midday|midi)\b/, '12:00'],
  [/\b(?:afternoon|apres[- ]?midi)\b/, '14:00'],
  [/\b(?:evening|tonight|soir(?:ee)?)\b/, '19:00'],
  [/\b(?:midnight|minuit)\b/, '00:00'],
  [/\b(?:night|nuit)\b/, '22:00'],
  [/\b(?:lunch|dejeuner)\b/, '12:30'],
  [/\b(?:dinner|diner)\b/, '20:00'],
  [/\b(?:breakfast|petit[- ]dejeuner)\b/, '08:00']
]

const NUMBER_WORDS = {
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, half: 0.5,
  // French, kept alongside: they cost nothing.
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8,
  neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15,
  seize: 16, 'dix-sept': 17, 'dix-huit': 18, 'dix-neuf': 19, vingt: 20,
  'vingt-et-un': 21, 'vingt-et-une': 21, 'vingt-deux': 22, 'vingt-trois': 23,
  demi: 0.5, demie: 0.5
}

/**
 * The text as it can be compared: lowercase, no accents, uniform apostrophes.
 * Speech-to-text returns "at 3pm" and "3pm" depending on the transcriber's mood,
 * and "l'apres-midi" with three different apostrophes depending on the keyboard.
 * We therefore always compare on that form, never on the raw one.
 */
const normalize = s => String(s ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[‘’‛`]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

/** Minutes since midnight for an 'HH:MM'. */
export function toMinutes (hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''))
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** The reverse: 'HH:MM' from minutes since midnight, clamped to the day. */
export function hhmm (min) {
  const v = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}

/** The local time right now, in the same format as what we store. */
export function currentTime (d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** How a time is shown: 15:30, 9:00 (no leading zero on the hour). */
export const formatTime = hm => {
  const m = toMinutes(hm)
  if (m == null) return ''
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/** A duration said the way a human says it: 60 becomes "1h", 45 "45m", 90 "1h 30m". */
export function formatDuration (min) {
  if (min == null) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/* ------------------------------------------------------------------ */
/* Understanding a dictated time                                       */
/* ------------------------------------------------------------------ */

/**
 * The time, as it comes out of a dictated sentence.
 *
 * We accept everything the user really says: "3pm", "15:30", "3 o'clock",
 * "quarter past three", "noon", "half past noon", "3 in the afternoon",
 * "8 in the evening", "tomorrow morning". Returning null rather than guessing
 * anything: a wrong time is worse than a task without one, it moves an
 * appointment without anyone noticing.
 *
 * The detail that matters: "in the evening" and "in the afternoon" add twelve
 * hours, unless the time said is already past noon. Without that, "8 in the
 * evening" set a slot at eight in the morning, and the whole day went sideways.
 */
export function parseTime (txt) {
  const r = findTime(normalize(typeof txt === 'number' && Number.isFinite(txt) ? `${txt}h` : txt))
  return r ? r.hm : null
}

/**
 * The same reading, but which ALSO says where it found the time in the sentence.
 *
 * That location is not an implementation detail: without it, "at 3pm, an hour"
 * read "3pm" back as a duration of three hours, or wiped the duration together
 * with the time. So we remove from the sentence exactly the characters that
 * carried the start time, no more and no less.
 */
function findTime (t) {
  if (!t) return null

  let h = null
  let m = 0
  let span = null

  // 'HH:MM' already normalised comes first: it is what the UI sends.
  const direct = /(\d{1,2}):(\d{2})(?!\d)/.exec(t)
  const glued = /(\d{1,2})\s*h\s*(\d{1,2})?(?!\d)/.exec(t)
  const written = /(\d{1,2})\s*(?:hours?|heures?)\b(?:\s*(\d{1,2})(?!\d))?/.exec(t)
  const oclock = /(\d{1,2})\s*o'?clock\b/.exec(t)
  const meridiem = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/.exec(t)
  const word = /\b([a-z-]+)\s+(?:hours?|heures?)\b/.exec(t)

  if (meridiem) {
    h = Number(meridiem[1]); m = meridiem[2] ? Number(meridiem[2]) : 0
    span = [meridiem.index, meridiem.index + meridiem[0].length]
    if (/^p/.test(meridiem[3]) && h < 12) h += 12
    if (/^a/.test(meridiem[3]) && h === 12) h = 0
  } else if (oclock) {
    h = Number(oclock[1]); span = [oclock.index, oclock.index + oclock[0].length]
  } else if (direct) {
    h = Number(direct[1]); m = Number(direct[2]); span = [direct.index, direct.index + direct[0].length]
  } else if (written && (!glued || written.index <= glued.index)) {
    h = Number(written[1]); m = written[2] ? Number(written[2]) : 0; span = [written.index, written.index + written[0].length]
  } else if (glued) {
    h = Number(glued[1]); m = glued[2] ? Number(glued[2]) : 0; span = [glued.index, glued.index + glued[0].length]
  } else if (word && NUMBER_WORDS[word[1]] >= 1) {
    // "fifteen hours": the number is spelled out.
    h = NUMBER_WORDS[word[1]]; span = [word.index, word.index + word[0].length]
  }

  if (h == null) {
    // No number: what is left are the moments of the day, "tomorrow morning"
    // included.
    for (const [re, val] of MOMENTS) {
      const hit = re.exec(t)
      if (!hit) continue
      const base = toMinutes(val)
      const bonus = (/\b(?:et demie?|and a half)\b/.test(t) ? 30 : 0) + (/\b(?:et quart|and a quarter)\b/.test(t) ? 15 : 0)
      return { hm: hhmm(base + bonus), span: [hit.index, hit.index + hit[0].length] }
    }
    return null
  }

  if (!m && /\b(?:et demie?|and a half)\b/.test(t)) m = 30
  if (!m && /\b(?:et quart|and a quarter)\b/.test(t)) m = 15
  if (/\b(?:moins le quart|quarter to)\b/.test(t)) { h -= 1; m = 45 }

  // The twelve-hour system is still spoken a lot, and "8 in the evening"
  // without this switch fell in the morning, twelve hours too early.
  if (/\b(?:du soir|de l'apres[- ]?midi|apres[- ]?midi|de la nuit|in the evening|in the afternoon|at night)\b/.test(t) && h < 12) h += 12
  if (/\b(?:du matin|in the morning)\b/.test(t) && h === 12) h = 0
  if (h === 24) h = 0

  if (!Number.isFinite(h) || h < 0 || h > 23 || m < 0 || m > 59) return null
  return { hm: hhmm(h * 60 + m), span }
}

/**
 * The duration, as it comes out of a dictated sentence.
 *
 * "an hour", "1h30", "1h 30m", "45 min", "45m", "half an hour", "three quarters
 * of an hour", "two hours". A bare number is understood as minutes: it is what the UI sends,
 * and it is also what the user means when they say "90".
 */
export function parseDuration (txt) {
  if (txt == null) return null
  if (typeof txt === 'number' && Number.isFinite(txt)) return txt > 0 ? Math.round(txt) : null
  const t = normalize(txt)
  if (!t) return null

  if (/\btrois[- ]quarts? d'heure\b|\bthree[- ]quarters?(?: of an?)? hour\b/.test(t)) return 45
  if (/\bdemi[- ]?heure\b|\bune demie?\b(?! heure)|\bhalf[- ]?an?[- ]?hour\b/.test(t)) return 30
  if (/\bquart d'heure\b|\ba quarter (?:of an? )?hour\b/.test(t)) return 15

  // "1h30" first: otherwise the hours-only rule would swallow the "1h" and lose
  // the thirty minutes.
  const hm = /(\d{1,2})\s*h\s*(\d{1,2})(?!\d)/.exec(t)
  if (hm) return Number(hm[1]) * 60 + Number(hm[2])

  const mn = /(\d{1,3})\s*(?:min\b|mn\b|m\b|minutes?\b)/.exec(t)
  if (mn) return Number(mn[1])

  const hr = /(\d{1,2})(?:[.,](\d))?\s*(?:h\b|hours?|heures?)/.exec(t)
  if (hr) return Math.round(Number(hr[1]) * 60 + (hr[2] ? Number(`0.${hr[2]}`) * 60 : 0))

  const word = /\b([a-z-]+)\s+(?:hours?|heures?)\b/.exec(t)
  if (word && NUMBER_WORDS[word[1]] != null) {
    return Math.round(NUMBER_WORDS[word[1]] * 60) + (/\b(?:et demie?|and a half)\b/.test(t) ? 30 : 0)
  }

  // "an hour", "a hour": a bare article in front of "hour".
  if (/\b(?:an?|one) hours?\b/.test(t)) return 60

  const bare = /^(\d{1,3})$/.exec(t)
  if (bare) return Number(bare[1])
  return null
}

/**
 * A whole sentence, from which we draw the start, the duration and the day
 * aimed at.
 *
 * The reading order is not negotiable. We look FIRST for a range ("from 2pm to
 * 4pm", "between 2pm and 4pm", "2pm-4pm"): without that, the closing "4pm" was
 * read as a second start time and the slot lasted zero minutes. Only then the
 * start time, then the duration.
 *
 * `dayOffset` is a number of days, never a date: the caller knows which day we
 * start from, and only it must do the addition with `addDays`.
 */
export function parseTimeSpec (sentence) {
  const t = normalize(sentence)
  const out = { startAt: null, durationMin: null, dayOffset: null }
  if (!t) return out

  if (/\b(?:apres[- ]?demain|day after tomorrow)\b/.test(t)) out.dayOffset = 2
  else if (/\b(?:demain|tomorrow)\b/.test(t)) out.dayOffset = 1
  else if (/\b(?:aujourd'hui|ce soir|cet apres[- ]?midi|ce matin|today|tonight|this (?:morning|afternoon|evening))\b/.test(t)) out.dayOffset = 0

  const range = /\b(?:de|des|entre|from|between)\s+(.{1,22}?)\s+(?:a|jusqu'a|et|to|until|and)\s+(.{1,22}?)(?:\s|$|[,.])/.exec(t) ||
                /(\d{1,2}\s*h(?:\s*\d{1,2})?)\s*-\s*(\d{1,2}\s*h(?:\s*\d{1,2})?)/.exec(t)
  if (range) {
    const a = parseTime(range[1])
    const b = parseTime(range[2])
    if (a && b) {
      out.startAt = a
      // A range that ends before it starts crosses midnight: we add the day
      // rather than return a negative duration, which would break the whole
      // display downstream.
      const d = toMinutes(b) - toMinutes(a)
      out.durationMin = d > 0 ? d : d + 24 * 60
      return out
    }
  }

  const found = findTime(t)
  out.startAt = found ? found.hm : null

  // The sentence with its start time cut out. It is the only way not to read
  // that same time back as a duration: "at 3pm, an hour" otherwise gave a
  // three-hour slot.
  const rest = found && found.span
    ? `${t.slice(0, found.span[0])} ${t.slice(found.span[1])}`
    : t

  const led = /\b(?:pendant|durant|pour|ca prend|ca dure|duree de|duree|for|lasting|takes|duration of|during)\s+(.{1,26})/.exec(rest)
  out.durationMin = (led && parseDuration(led[1])) || null
  if (out.durationMin == null) {
    // With no lead-in word, a duration is only recognisable by its shape:
    // "an hour", "45 min", "1h30", "half an hour".
    const alone = /\bdemi[- ]?heure\b|\bquart d'heure\b|\btrois[- ]quarts? d'heure\b|\bhalf[- ]?an?[- ]?hour\b|\ba quarter (?:of an? )?hour\b|\b[a-z-]+\s+(?:hours?|heures?)\b|\b\d{1,3}\s*(?:min\b|mn\b|minutes?\b)|\b\d{1,2}\s*h\s*\d{1,2}\b|\b\d{1,2}\s*h\b/.exec(rest)
    if (alone) out.durationMin = parseDuration(alone[0])
  }
  return out
}

/* ------------------------------------------------------------------ */
/* The day seen as slots                                               */
/* ------------------------------------------------------------------ */

const toSlot = r => ({
  id: r.id,
  content: String(r.content || '').replace(/^\s*#+\s*/, ''),
  day: r.day,
  checked: !!r.checked,
  state: r.state || 'active',
  startAt: r.start_at || null,
  durationMin: r.duration_min ?? null,
  start: r.start_at ? toMinutes(r.start_at) : null,
  end: r.start_at ? toMinutes(r.start_at) + (r.duration_min || DEFAULT_DURATION) : null
})

/** One line, with just what is needed to talk about its slot. */
export function readSlot (id) {
  const r = db.prepare('SELECT id, content, day, checked, state, start_at, duration_min FROM tasks WHERE id = ?').get(id)
  return r ? toSlot(r) : null
}

/** Every line of a day that has a time, in chronological order. */
export function daySlots (day) {
  return db.prepare(`
    SELECT id, content, day, checked, state, start_at, duration_min
    FROM tasks WHERE day = ? AND start_at IS NOT NULL
    ORDER BY start_at ASC`).all(day).map(toSlot)
}

/**
 * The display order of a day: what has a time first, in clock order, then
 * everything else in its original order.
 *
 * A pure function on a list: it is the same rule on the server and on screen,
 * and the only way they never diverge. Above all we do not sort the part without
 * a time by time, it keeps the order the user gave it by hand, which is
 * information in itself.
 */
export function sortDay (tasks) {
  const key = t => t.startAt ?? t.start_at ?? null
  const timed = []
  const untimed = []
  for (const t of tasks) (key(t) ? timed : untimed).push(t)
  timed.sort((a, b) => {
    const d = toMinutes(key(a)) - toMinutes(key(b))
    if (d) return d
    // At an equal time, the shorter one goes first: it is the one that blocks
    // the rest of the day the least.
    const durA = a.durationMin ?? a.duration_min ?? DEFAULT_DURATION
    const durB = b.durationMin ?? b.duration_min ?? DEFAULT_DURATION
    return durA - durB
  })
  return [...timed, ...untimed]
}

/**
 * The pairs of slots that step on each other.
 *
 * We NEVER block an overlap, we report it. Two appointments at the same time
 * happen, and are sometimes intended (a commute during a call): an agent that
 * refuses becomes an obstacle to work around, and the user has said so
 * explicitly. The report itself is glued to the end of the sentence.
 *
 * A checked line no longer overlaps anything: it is done, it belongs to the past
 * of the day.
 */
export function overlaps (slots) {
  const live = slots
    .filter(c => c.start != null && !c.checked && c.state !== 'archived')
    .sort((a, b) => a.start - b.start)
  const out = []
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      // The list is sorted: as soon as a neighbour starts after the current
      // one ends, all those after it start even later.
      if (live[j].start >= live[i].end) break
      out.push([live[i], live[j]])
    }
  }
  return out
}

/**
 * The overlap warning, glued to the end of a tool answer.
 *
 * Same doctrine as `loadWarning` in tools.js: a sentence at the end of the
 * answer, never a refusal. We name only the first conflict, the one about the
 * line just placed: listing the six pairs of a busy day produces a wall of text
 * nobody reads any more.
 */
export function overlapWarning (day, id = null) {
  const pairs = overlaps(daySlots(day))
  if (!pairs.length) return ''
  const relevant = (id != null && pairs.find(p => p[0].id === id || p[1].id === id)) || pairs[0]
  const [a, b] = relevant
  const others = pairs.length > 1 ? `, and ${pairs.length - 1} more overlap${pairs.length > 2 ? 's' : ''} that day` : ''
  return `. Careful, these overlap: "${a.content}" ${formatTime(a.startAt)}-${formatTime(hhmm(a.end))} and "${b.content}" ${formatTime(b.startAt)}-${formatTime(hhmm(b.end))}${others}. I blocked nothing, tell me if you want me to shift one.`
}

/**
 * The gaps of a day, between two bounds.
 *
 * We first merge the slots that touch or overlap, otherwise an overlap invented
 * a negative gap. Crumbs shorter than a quarter of an hour are not gaps: nobody
 * fits anything into ten minutes between two appointments.
 */
export function gaps (slots, { start = '08:00', end = '20:00', minimum = 15 } = {}) {
  const d0 = toMinutes(start)
  const f0 = toMinutes(end)
  const busy = slots
    .filter(c => c.start != null && !c.checked)
    .map(c => [Math.max(d0, c.start), Math.min(f0, c.end)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])

  const merged = []
  for (const [a, b] of busy) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }

  const out = []
  let cursor = d0
  for (const [a, b] of merged) {
    if (a - cursor >= minimum) out.push({ start: hhmm(cursor), end: hhmm(a), minutes: a - cursor })
    cursor = Math.max(cursor, b)
  }
  if (f0 - cursor >= minimum) out.push({ start: hhmm(cursor), end: hhmm(f0), minutes: f0 - cursor })
  return out
}

/**
 * The next slot, and how long until it.
 *
 * A slot already started and not finished wins over the one after: when one asks
 * "what is next" at 15:10 with a call from 15:00 to 16:00, the useful answer is
 * the ongoing call, not the 17:00 appointment.
 */
export function nextSlot (slots, { at = currentTime() } = {}) {
  const m = toMinutes(at)
  const live = slots
    .filter(c => c.start != null && !c.checked && c.state === 'active')
    .sort((x, y) => x.start - y.start)
  const ongoing = live.find(c => c.start <= m && c.end > m)
  if (ongoing) return { slot: ongoing, inMin: 0, ongoing: true, remainingMin: ongoing.end - m }
  const next = live.find(c => c.start > m)
  if (!next) return null
  return { slot: next, inMin: next.start - m, ongoing: false, remainingMin: null }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Sets or changes the time of an existing task.
 *
 * The write is direct and does not go through `updateTask`: the list of fields
 * it accepts is closed and does not know the two time columns. We still keep
 * `updateTask`'s promise by pushing `modified_at`, otherwise the line would look
 * like it never moved.
 *
 * `at` at null REMOVES the time: it is the same gesture as pulling a block out
 * of the grid, it must not require a second tool.
 */
export function applySchedule (id, { at, duration } = {}) {
  const t = readSlot(id)
  if (!t) return null

  let time = t.startAt
  if (at !== undefined) time = at === null || at === '' ? null : parseTime(at)
  let length = t.durationMin
  if (duration !== undefined) length = duration === null || duration === '' ? null : parseDuration(duration)
  // A duration without a start time means nothing and would make sorting
  // unpredictable: we let it go with the time.
  if (!time) length = null

  db.prepare('UPDATE tasks SET start_at = ?, duration_min = ?, modified_at = ? WHERE id = ?')
    .run(time, length, now(), id)
  return readSlot(id)
}

/** The server's day, exposed here so the tools need only one import. */
export const currentDay = today
