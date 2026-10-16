import { db, today, addDays } from '../db.js'
import { getTask, moveTask } from '../tasks.js'
import {
  parseTime, parseDuration, parseTimeSpec, applySchedule, readSlot,
  daySlots, sortDay, overlaps, overlapWarning, gaps,
  nextSlot, formatTime, formatDuration, hhmm, currentTime, DEFAULT_DURATION
} from '../schedule.js'

/**
 * The agent's time tools.
 *
 * Same shape as server/agent/tools.js: a `defs` array of triplets
 * [name, description, properties], a `handlers` object, and the two annexes
 * `labels` (what shows in the chat while the tool runs) and `writers` (the tools
 * after which the interface refreshes). The aggregation with the general tools
 * happens in tools.js, not here.
 *
 * NOTE: everything written in the descriptions and in the answers goes to the
 * model, and is written in careful, idiomatic English. A model mimics the style
 * of its prompt, so the prompt sets the tone of the answer it gives back.
 *
 * A time slot stays an ORDINARY task: these tools create nothing, they set a
 * time on a line that already exists and that keeps its group, its state, its
 * checkbox and its trash.
 */

const num = v => (v === '' || v == null ? null : Number(v))
const stripHashes = s => String(s || '').replace(/^\s*#+\s*/, '')

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const dayNameOf = iso => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return WEEKDAYS[new Date(y, m - 1, d).getDay()]
}

/** "3pm-4pm", or just "3pm" when the duration was never given. */
const range = c => (c.durationMin
  ? `${formatTime(c.startAt)}-${formatTime(hhmm(c.end))}`
  : formatTime(c.startAt))

/** "in 20m", "in 1h 30m": never a raw number of minutes. */
const fromNow = min => {
  if (min <= 0) return 'now'
  if (min < 60) return `in ${min} minutes`
  return `in ${formatDuration(min)}`
}

/* ------------------------------------------------------------------ */
/* Declarations sent to the model                                      */
/* ------------------------------------------------------------------ */

export const defs = [
  ['schedule_task', "Gives a TIME to a task that already exists, or changes the one it has. Call it as soon as the user mentions a precise moment: \"I have a call with the plumber at 3pm\", \"the dentist is Tuesday 9:30\", \"block two hours for me this morning\". The task keeps its group, its state and its checkbox: a time slot stays an ordinary task, never an object of its own. Two slots that overlap are REPORTED, never refused.", {
    id: ['number', 'identifier of the task to give a time to', true],
    at: ['string', 'the time, as it is said: "3pm", "15:30", "noon", "8pm", "from 2pm to 4pm"', true],
    duration: ['string', 'how long it takes, as it is said: "an hour", "45 min", "1h30". Useless if the end time is already in at.'],
    day: ['string', 'YYYY-MM-DD, only if the slot also changes day']
  }],
  ['unschedule_task', "Removes the time from a task: it stays in its day and in its group, but it no longer occupies a slot. Use it when an appointment becomes \"some day this week\", never to cancel a task.", {
    id: ['number', '', true]
  }],
  ['day_schedule', "The day seen as a timetable: the slots in clock order, the gaps between them, the overlaps, then what has no time. Call it when the user asks what their day looks like, when there is time left, or before setting a slot to know where to put it.", {
    day: ['string', 'YYYY-MM-DD, today by default'],
    from: ['string', 'start bound of the day, "8am" by default'],
    to: ['string', 'end bound of the day, "8pm" by default']
  }],
  ['next_slot', "The next slot and how long until it starts, from the time it really is. Call it when the user asks \"what is next\", \"what do I have time to do\", \"how much time do I have left\".", {
    day: ['string', 'YYYY-MM-DD, today by default']
  }]
]

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export const handlers = {
  /**
   * Setting a time, or moving it.
   *
   * The time is understood in plain language rather than asked for in 'HH:MM'
   * format: the model copies what the user said, and the code normalizes it.
   * Asking it to convert "8pm" into "20:00" itself is exactly the operation it
   * gets wrong one time out of five, and a wrong time moves an appointment
   * without anyone noticing.
   */
  schedule_task: ({ id, at, duration, day }, ctx) => {
    const target = num(id)
    const t = getTask(target)
    if (!t) return `Task #${id} not found`

    // The whole sentence is parsed, not only the `at` field: the model often
    // copies "from 2pm to 4pm" in one block, the end time is then in the same
    // string and counts as the duration.
    const parsed = parseTimeSpec(at)
    const time = parsed.startAt || parseTime(at)
    if (!time) {
      return `NOTHING CHANGED. I did not understand "${at}" as a time. Give it again in a simple form: "3pm", "15:30", "noon", "from 2pm to 4pm".`
    }
    const length = parseDuration(duration) ?? parsed.durationMin ?? null

    // The day first, the time after: `moveTask` recomputes a position and takes
    // the descendants along, and it does not know the time columns. Setting the
    // time before the move would work too, but the move log would then tell the
    // day out of order.
    let d = t.day
    const targetDay = day || (parsed.dayOffset != null ? addDays(today(), parsed.dayOffset) : null)
    const moved = targetDay && targetDay !== t.day
    if (moved) {
      moveTask(target, targetDay, { actor: 'agent', reason: 'slot set in the chat' })
      d = targetDay
    }

    const c = applySchedule(target, { at: time, duration: length })
    if (!c) return `Task #${id} not found`
    if (!d) {
      return `#${c.id} "${c.content}" is noted at ${formatTime(time)}${length ? ` for ${formatDuration(length)}` : ''}, but it is still in the inbox, with no day. Give me the day so it shows up in the grid.`
    }
    const when = d === today() ? 'today' : `${dayNameOf(d)} ${d}`
    return `#${c.id} "${c.content}" is set ${when} from ${formatTime(c.startAt)} to ${formatTime(hhmm(c.end))}${length ? '' : ` (duration not specified, I count ${DEFAULT_DURATION} minutes)`}${overlapWarning(d, c.id)}`
  },

  unschedule_task: ({ id }, ctx) => {
    const before = readSlot(num(id))
    if (!before) return `Task #${id} not found`
    if (!before.startAt) return `#${before.id} "${before.content}" had no time already, nothing to remove.`
    applySchedule(num(id), { at: null, duration: null })
    return `#${before.id} "${before.content}" has no time any more. It stays on its day and in its group, it simply no longer occupies a slot.`
  },

  /**
   * The day as a timetable.
   *
   * The gaps count as much as the slots: it is the real question of the user
   * when they ask about their day, "where can I fit this in". We compute them
   * here rather than letting the model subtract hours, which it gets wrong just
   * about every time.
   */
  day_schedule: ({ day, from, to }) => {
    const d = day || today()
    const slots = daySlots(d)
    const alive = slots.filter(c => c.state !== 'archived')
    const out = [`${dayNameOf(d)} ${d}`]

    if (!alive.length) {
      out.push('No slot set that day, the whole day is free.')
    } else {
      for (const c of sortDay(alive)) {
        const state = c.checked ? ' [done]' : (c.state !== 'active' ? ` [${c.state}]` : '')
        out.push(`  ${range(c)} · #${c.id} ${c.content}${state}`)
      }
      const pairs = overlaps(alive)
      if (pairs.length) {
        out.push(`Overlaps (${pairs.length}), I block nothing, it is up to you to settle:`)
        for (const [a, b] of pairs) out.push(`  "${a.content}" ${range(a)} and "${b.content}" ${range(b)}`)
      }
      const free = gaps(alive, {
        start: parseTime(from) || '08:00',
        end: parseTime(to) || '20:00'
      })
      out.push(free.length
        ? `Gaps: ${free.map(g => `${formatTime(g.start)}-${formatTime(g.end)} (${formatDuration(g.minutes)})`).join(', ')}`
        : 'No usable gap between the bounds of the day.')
    }

    // What has no time never disappears from the answer: without that line, the
    // agent would believe the day empty while it carries eight tasks.
    const unscheduled = sortDay(noTime(d))
    if (unscheduled.length) {
      out.push(`No time (${unscheduled.length}): ${unscheduled.map(t => `#${t.id} ${stripHashes(t.content)}`).join(', ')}`)
    }
    return out.join('\n')
  },

  next_slot: ({ day }) => {
    const d = day || today()
    const p = nextSlot(daySlots(d), { at: currentTime() })
    if (!p) {
      const left = daySlots(d).filter(c => !c.checked).length
      return left
        ? `It is ${formatTime(currentTime())}, no slot left ahead of you ${d === today() ? 'today' : `on ${d}`}.`
        : `It is ${formatTime(currentTime())}, no slot set ${d === today() ? 'today' : `on ${d}`}.`
    }
    const c = p.slot
    if (p.ongoing) {
      return `It is ${formatTime(currentTime())}: "${c.content}" (#${c.id}) is ONGOING, ${range(c)}, ${formatDuration(p.remainingMin)} left.`
    }
    return `It is ${formatTime(currentTime())}: the next slot is "${c.content}" (#${c.id}) at ${formatTime(c.startAt)}, ${fromNow(p.inMin)}.`
  }
}

/**
 * The lines of a day that have no time and that really count.
 *
 * Group headings and lines that carry children are set aside: they are boxes,
 * not tasks, and listing them as "no time" would fill the answer with noise.
 */
function noTime (day) {
  return db.prepare(`
    SELECT id, content FROM tasks t
    WHERE t.day = ? AND t.start_at IS NULL AND t.checked = 0 AND t.state = 'active'
      AND t.content <> '' AND TRIM(t.content) NOT LIKE '#%'
      AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id)
    ORDER BY t.position ASC`).all(day)
}

/** Readable label shown live in the chat while the tool runs. */
export const labels = {
  schedule_task: 'sets a time slot',
  unschedule_task: 'removes the time',
  day_schedule: 'reads the timetable',
  next_slot: 'looks at what is next'
}

/** The tools that write: the interface refreshes only after those. */
export const writers = ['schedule_task', 'unschedule_task']
