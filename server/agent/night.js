import { db, now, today, addDays } from '../db.js'
import { groupKey } from '../tasks.js'

/**
 * The nightly review that LOOKS, where review.js SORTS.
 *
 * review.js decides where each task goes. This file moves nothing: it looks for
 * what is wrong in the way the agenda is kept, then has the model put it into
 * words once, on waking.
 *
 * diagnostics() is 100% deterministic, no model call: detectors that read the
 * database in SQL. That is where the truth lives, a number coming out of here
 * cannot be invented. What they find becomes a note pinned on the line concerned
 * (night-actions.js), never a text someone comes to recite.
 *
 * Each detector is deliberately CONSERVATIVE: high thresholds, capped lists,
 * ambiguous cases dropped. An agent that flags too much gets ignored within three
 * days, and at that point it is useless even when it is right.
 */

const DAY_MS = 86_400_000

/* A group title is written "# Deep work" and a numbered list "1. ...": neither
   the hash nor the number is part of the task text. */
const clean = s => String(s || '').replace(/^\s*#+\s*/, '').replace(/^\s*\d+[.)]\s+/, '').trim()
const isHeading = s => /^\s*#/.test(String(s || ''))
const wordCount = s => clean(s).split(/\s+/).filter(Boolean).length
const ageDays = ts => (ts ? Math.max(0, Math.floor((now() - ts) / DAY_MS)) : null)
const tenth = n => Math.round(n * 10) / 10

/* Bag of significant words, the same kitchen as similar() in text.js: no accents,
   no punctuation, words longer than three letters. Rewritten here because text.js
   does not export its bag(), and we want the full Set, not a boolean. */
const bag = s => new Set(
  String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3)
)

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const weekdayIndex = iso => {
  if (!iso) return null
  const [y, m, d] = String(iso).split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/* Local midnight of that day. The database timestamps are local milliseconds:
   going through UTC would shift the window by a whole day. */
const midnight = iso => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/* ------------------------------------------------------------------ */
/* The detectors                                                       */
/* ------------------------------------------------------------------ */

/**
 * 1. Muda: what has been moved four times or more without ever being done.
 *
 * At four postponements, "it drags on" is no longer an observation, it is a
 * verdict to deliver: the line is badly worded, too big, or it will never be done.
 * So we report its surroundings (parent, children, age) so the verdict can be
 * argued instead of being one more complaint.
 *
 * Exported: diagnoseMuda (night-actions.js) starts from the same list to deliver
 * its verdict, rather than redefining a second threshold that would drift.
 */
export function muda () {
  return db.prepare(`
    SELECT t.id, t.content, t.move_count, t.day, t.created_at,
           (SELECT p.content FROM tasks p WHERE p.id = t.parent_id) AS parent,
           (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children
    FROM tasks t
    WHERE t.checked = 0 AND t.state = 'active' AND t.move_count >= 4
    ORDER BY t.move_count DESC, t.created_at ASC
    LIMIT 5
  `).all().map(r => ({
    id: r.id,
    content: clean(r.content),
    moveCount: r.move_count,
    day: r.day,
    parent: r.parent ? clean(r.parent) : null,
    children: r.children,
    ageDays: ageDays(r.created_at)
  }))
}

/**
 * 2. The last mile: tomorrow, a long line with no sub-task.
 *
 * More than five words without a single step underneath is not a gesture, it is a
 * project disguised as a task. It will not be done tomorrow, it will be postponed.
 * We say so the day before, while there is still time to break it down.
 */
function lastMile (tomorrow) {
  return db.prepare(`
    SELECT t.id, t.content, t.day FROM tasks t
    WHERE t.day = ? AND t.checked = 0 AND t.state = 'active'
      AND (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) = 0
    ORDER BY t.created_at ASC
  `).all(tomorrow)
    .filter(r => !isHeading(r.content) && wordCount(r.content) > 5)
    .slice(0, 3)
    .map(r => ({ id: r.id, content: clean(r.content), day: r.day }))
}

/**
 * 4. Stalled: a project where nothing has been checked for ten days.
 *
 * At least two open sub-tasks, no box checked for ten days: we do not know whether
 * it is blocked or nobody touched it, and that is precisely the problem. A project
 * with no check has vanished from the mental model, it will never remind us of
 * itself.
 *
 * Two exclusions, without which the detector cries every evening for nothing:
 * groups that failed far in the past (history shells, not living projects) and the
 * whole day-less inbox, which is a reserve and not work in progress.
 *
 * Exported: the bootstrap serves it to the front, which marks these projects in
 * the week, where it matters.
 */
export function stalledProjects (day) {
  const threshold = now() - 10 * DAY_MS
  const floor = addDays(day, -14)
  return db.prepare(`
    WITH RECURSIVE tree(id, root) AS (
      SELECT id, id FROM tasks WHERE parent_id IS NULL
      UNION ALL
      SELECT t.id, a.root FROM tasks t JOIN tree a ON t.parent_id = a.id
    )
    SELECT r.id, r.content,
      (SELECT COUNT(*) FROM tree a JOIN tasks x ON x.id = a.id
        WHERE a.root = r.id AND a.id <> r.id AND x.checked = 0 AND x.state = 'active') AS open_count,
      (SELECT MAX(x.done_at) FROM tree a JOIN tasks x ON x.id = a.id
        WHERE a.root = r.id AND a.id <> r.id) AS last_done
    FROM tasks r
    WHERE r.parent_id IS NULL AND r.checked = 0 AND r.state = 'active'
      AND r.day IS NOT NULL AND r.day >= ?
  `).all(floor)
    .filter(r => r.open_count >= 2 && (!r.last_done || r.last_done < threshold))
    .sort((a, b) => b.open_count - a.open_count)
    .slice(0, 4)
    .map(r => ({
      id: r.id,
      content: clean(r.content),
      lastCheck: r.last_done || null,
      openChildren: r.open_count
    }))
}

/**
 * 5. Doubtful facts: entered once, never reconfirmed, never reused.
 *
 * A fact entered into memory stays true forever, even once it has stopped being
 * true. After two months without a single reconfirmation, it may be steering the
 * agent's tone on a dead habit. Two at most: memory is cleaned with a spoon, not a
 * shovel.
 */
function doubtfulFacts () {
  const threshold = now() - 60 * DAY_MS
  return db.prepare(`
    SELECT id, text, created_at FROM facts
    WHERE weight = 1 AND used_at IS NULL AND created_at < ?
    ORDER BY created_at ASC LIMIT 2
  `).all(threshold).map(f => ({ id: f.id, text: f.text, ageDays: ageDays(f.created_at) }))
}

/**
 * 6. Corrections: the rule the user applies by hand without having stated it.
 *
 * Three times the same gesture on three different tasks in a month is no longer a
 * coincidence: it is a rule that already exists in their head and is missing from
 * the base. We phrase it for them, ready for add_rule.
 *
 * Only two patterns, the two that sorting knows how to exploit: a weekday
 * (groupWeekdays reads it) and a home group. A pattern that combines both ("the
 * shopping on Saturday") gives the most useful rule, so we look for it first.
 */
function corrections () {
  const since = now() - 30 * DAY_MS
  const mv = db.prepare(`
    SELECT * FROM moves WHERE actor IN ('user','agent') AND created_at >= ? ORDER BY id ASC
  `).all(since)

  const byWeekday = new Map()
  const byGroup = new Map()
  for (const m of mv) {
    const idx = weekdayIndex(m.to_day)
    if (idx != null) {
      if (!byWeekday.has(idx)) byWeekday.set(idx, [])
      byWeekday.get(idx).push(m)
    }
    const g = (m.group_key || '').trim()
    if (g) {
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g).push(m)
    }
  }

  const distinctCount = list => new Set(list.map(m => m.task_id).filter(x => x != null)).size
  const examples = list => {
    const seen = new Map()
    for (const m of list) if (!seen.has(m.task_id)) seen.set(m.task_id, clean(m.content))
    return [...seen.values()].filter(Boolean).slice(0, 3)
  }

  const out = []
  const coveredGroups = new Set()

  for (const [idx, list] of byWeekday) {
    if (distinctCount(list) < 3) continue
    // A dominant group inside the pattern: that is what gives the rule sorting can
    // exploit, "the shopping is done on Saturday".
    const tally = new Map()
    for (const m of list) {
      const g = (m.group_key || '').trim()
      if (!g) continue
      if (!tally.has(g)) tally.set(g, new Set())
      tally.get(g).add(m.task_id)
    }
    let dominant = null
    for (const [g, s] of tally) if (s.size >= 3 && (!dominant || s.size > tally.get(dominant).size)) dominant = g
    if (dominant) coveredGroups.add(dominant)
    out.push({
      pattern: dominant
        ? `You yourself move tasks in the "${dominant}" group to ${DAYS[idx]}.`
        : `You yourself move tasks to ${DAYS[idx]}.`,
      occurrences: distinctCount(list),
      examples: examples(list),
      proposedRule: dominant
        ? `"${dominant}" tasks are done on ${DAYS[idx]}.`
        : `They push to ${DAYS[idx]} whatever they did not do: ${DAYS[idx]} is their catch-up day.`
    })
  }

  for (const [g, list] of byGroup) {
    if (coveredGroups.has(g) || distinctCount(list) < 3) continue
    out.push({
      pattern: `You yourself move tasks into the "${g}" group.`,
      occurrences: distinctCount(list),
      examples: examples(list),
      proposedRule: `This kind of task goes into the "${g}" group.`
    })
  }

  return out.sort((a, b) => b.occurrences - a.occurrences).slice(0, 3)
}

/**
 * 7. Oscillations: the tug of war between a rule and the user.
 *
 * Sorting sends the task to day J, the user brings it back to day K, sorting sends
 * it back to J. Twice in a row, it is no longer chance: someone is wrong, and the
 * only sure thing is that the task, meanwhile, is not moving forward.
 *
 * We require the automatic destination to be the SAME on both turns: otherwise we
 * confuse a stubborn rule with an agenda that is moving normally.
 */
function oscillations () {
  const since = now() - 21 * DAY_MS
  const rows = db.prepare(`
    SELECT * FROM moves WHERE created_at >= ? AND task_id IS NOT NULL
    ORDER BY task_id ASC, id ASC
  `).all(since)

  const byTask = new Map()
  for (const m of rows) {
    if (!byTask.has(m.task_id)) byTask.set(m.task_id, [])
    byTask.get(m.task_id).push(m)
  }

  const out = []
  for (const [taskId, list] of byTask) {
    let auto = null
    const cycles = []
    for (const m of list) {
      if (m.actor === 'auto' && m.to_day) { auto = m; continue }
      if (m.actor !== 'auto' && auto && m.to_day && m.to_day !== auto.to_day) {
        cycles.push({ out: auto.to_day, back: m.to_day, ruleId: auto.rule_id || null })
        auto = null
      }
    }
    if (cycles.length < 2) continue
    const outDay = cycles[0].out
    // The same "out" on every turn, otherwise it is not a tug of war but an agenda
    // living its own life.
    if (!cycles.every(c => c.out === outDay)) continue
    out.push({
      taskId,
      content: clean(list[list.length - 1].content),
      out: outDay,
      back: cycles[cycles.length - 1].back,
      times: cycles.length,
      ruleId: cycles.find(c => c.ruleId)?.ruleId || null
    })
  }
  return out.sort((a, b) => b.times - a.times).slice(0, 3)
}

/**
 * 8. Sick rules. A rule is a medicine: we measure its side effects. Undone by hand
 * one time out of two, it sorts against its owner. We flag it, we suspend nothing
 * here: suspending is a decision, it is taken elsewhere and it is said out loud.
 */
function sickRules () {
  return db.prepare(`
    SELECT id, text, applied, overridden FROM rules
    WHERE active = 1 AND applied >= 3 AND overridden * 2 >= applied
    ORDER BY overridden DESC, applied DESC LIMIT 3
  `).all()
}

/**
 * 9. Never-tested rules: more than a month old, no sorting to their name, never put
 * on trial leave. Nobody knows whether they still serve, and they take up room in
 * every prompt.
 */
function untestedRules (day) {
  const threshold = now() - 30 * DAY_MS
  return db.prepare(`
    SELECT id, text, created_at FROM rules
    WHERE active = 1 AND applied = 0 AND tested_at IS NULL AND created_at < ?
      AND (suspended_until IS NULL OR suspended_until <= ?)
    ORDER BY created_at ASC LIMIT 3
  `).all(threshold, day).map(r => ({ id: r.id, text: r.text, ageDays: ageDays(r.created_at) }))
}

/**
 * 10. Load, Little's law.
 *
 * Throughput = what actually gets checked per open day over four weeks. Backlog =
 * what is placed on the next seven days. The ratio gives a number of working days,
 * and it is the only honest way to say "your week is already full" without
 * inventing it.
 *
 * We count only leaves: a group title is not work, counting it would add the same
 * content twice.
 */
function load (day) {
  const start = addDays(day, -27)
  const doneCount = db.prepare('SELECT COUNT(*) n FROM tasks WHERE checked = 1 AND done_at IS NOT NULL AND done_at >= ?')
    .get(midnight(start)).n

  let openDays = 0
  for (let i = 0; i < 28; i++) {
    const idx = weekdayIndex(addDays(start, i))
    if (idx >= 1 && idx <= 5) openDays++
  }
  const throughput = openDays ? tenth(doneCount / openDays) : 0

  const end = addDays(day, 6)
  // Google Calendar appointments are excluded from the backlog. They are imposed
  // slots, not work to be cleared: counting them would make a week look full as
  // soon as the user has three classes, and reducing the backlog would move REAL
  // tasks to make room for appointments that will not move. Throughput, for its
  // part, is read on what is checked: an unchecked appointment already does not
  // count there.
  const rows = db.prepare(`
    SELECT t.day, COUNT(*) n FROM tasks t
    WHERE t.checked = 0 AND t.state = 'active' AND t.day BETWEEN ? AND ?
      AND t.source IS NULL
      AND (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) = 0
    GROUP BY t.day ORDER BY n DESC
  `).all(day, end)

  const backlog = rows.reduce((s, r) => s + r.n, 0)
  return {
    throughput,
    backlog,
    // Never a division by zero: with no measured throughput we know nothing, and
    // "infinity" shown on screen is one more lie.
    loadDays: throughput > 0 ? tenth(backlog / throughput) : null,
    busiestDay: rows[0] ? { day: rows[0].day, n: rows[0].n } : null
  }
}

/**
 * 11. Dictation sessions: what was born in one burst.
 *
 * Five lines dropped at once is often a mental unload rather than a plan. We look
 * at what is left of them a few days later. A session from the same day teaches
 * nothing, we wait two days before judging it.
 */
function sessions () {
  const since = now() - 14 * DAY_MS
  const wall = now() - 2 * DAY_MS
  return db.prepare(`
    SELECT session_id AS sid, COUNT(*) AS total,
           SUM(CASE WHEN checked = 0 THEN 1 ELSE 0 END) AS open_count,
           MIN(created_at) AS created
    FROM tasks
    WHERE session_id IS NOT NULL AND session_id <> '' AND created_at >= ?
    GROUP BY session_id
    HAVING total >= 5
    ORDER BY open_count DESC
  `).all(since)
    .filter(s => s.created <= wall)
    .slice(0, 3)
    .map(s => ({ sessionId: s.sid, total: s.total, open: s.open_count, ageDays: ageDays(s.created) }))
}

/**
 * 12. Missed predictions: the user's predictions that did not hold.
 *
 * A task placed with "I think I'll finish it Friday" carries a due_at: it is a
 * prediction, not a commitment, and the night never moves it. When the deadline is
 * missed, we do not push in silence: we talk about it as a failed prediction, to
 * revise or withdraw.
 *
 * Two safeguards against harassment: due_at is the user's data, we never reset it
 * to NULL to silence the signal, so beyond seven days past the deadline the signal
 * is simply dead; and a task already flagged (a live kind='prediction'
 * intervention exists) does not flag itself again every night.
 *
 * Exported: night-actions.js starts from the same list to place its intervention.
 */
export function missedPredictions () {
  const day = today()
  const floor = addDays(day, -7)
  return db.prepare(`
    SELECT t.id, t.content, t.due_at, t.move_count FROM tasks t
    WHERE t.due_at IS NOT NULL AND t.due_at <= ? AND t.due_at >= ?
      AND t.checked = 0 AND t.state = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM interventions i
        WHERE i.task_id = t.id AND i.kind = 'prediction'
          AND i.status IN ('thinking','open')
      )
    ORDER BY t.due_at ASC, t.created_at ASC
    LIMIT 5
  `).all(day, floor).map(r => ({
    id: r.id,
    content: clean(r.content),
    dueAt: r.due_at,
    moveCount: r.move_count
  }))
}

/**
 * 13. Creep: the disaster announced by an accumulation of slides.
 *
 * One task sliding is an incident; four tasks sliding fifteen times in seven days
 * is a slope. Tomorrow will collapse under the accumulation, and the right gesture
 * is not to handle everything: it is to break the slope at its fulcrum, the
 * smallest task of the lot, doable right now.
 *
 * We count only moves with actor='auto': the user's moves are decisions, only the
 * machine's measure what slides on its own.
 *
 * Exported: night-actions.js relies on the same target to intervene.
 */
export function creep () {
  const since = now() - 7 * DAY_MS
  const rows = db.prepare(`
    SELECT m.task_id AS id, t.content, COUNT(*) AS slides,
           (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children
    FROM moves m JOIN tasks t ON t.id = m.task_id
    WHERE m.actor = 'auto' AND m.created_at >= ?
      AND t.checked = 0 AND t.state = 'active'
    GROUP BY m.task_id
    ORDER BY slides DESC
  `).all(since)
  if (rows.length < 4) return null
  const total = rows.reduce((s, r) => s + r.slides, 0)
  if (total < 15) return null
  // The fulcrum: a leaf (no children, so doable as is), then the shortest content.
  // Failing a leaf, the shortest one, period.
  const leaves = rows.filter(r => r.children === 0)
  const target = (leaves.length ? leaves : rows)
    .reduce((a, b) => (clean(b.content).length < clean(a.content).length ? b : a))
  return {
    tasks: rows.slice(0, 5).map(r => ({ id: r.id, content: clean(r.content), slides: r.slides })),
    total,
    target: { id: target.id, content: clean(target.content) }
  }
}

/**
 * 14. Risky interactions: two groups that, together, end badly.
 *
 * Two groups co-planned tomorrow that, every time they shared a day, were followed
 * by an automatic postponement of one of the two: tomorrow's day repeats a
 * combination that never held. Deliberate MVP version, read from moves only:
 * co-presence is the same to_day over sixty days, and the postponement is an auto
 * move that LEAVES that day (the following night empties it).
 *
 * Fewer than three past co-presences: the data is too poor to accuse anyone, we
 * return [].
 */
export function riskyInteractions (tomorrow) {
  // Tomorrow's groups: the root headings that still carry work.
  const tomorrowGroups = [...new Set(db.prepare(`
    SELECT r.content FROM tasks r
    WHERE r.day = ? AND r.parent_id IS NULL AND r.state = 'active'
      AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = r.id AND c.checked = 0 AND c.state = 'active')
  `).all(tomorrow).filter(r => isHeading(r.content)).map(r => groupKey(r.content)).filter(Boolean))]
  if (tomorrowGroups.length < 2) return []

  const since = now() - 60 * DAY_MS
  const rows = db.prepare(`
    SELECT group_key, from_day, to_day, actor FROM moves
    WHERE created_at >= ? AND group_key <> ''
  `).all(since)

  // Which groups received something each day, and which days each group left
  // through the machine.
  const byDay = new Map()
  const postponed = new Map()
  for (const m of rows) {
    const g = m.group_key.trim()
    if (!g) continue
    if (m.to_day) {
      if (!byDay.has(m.to_day)) byDay.set(m.to_day, new Set())
      byDay.get(m.to_day).add(g)
    }
    if (m.actor === 'auto' && m.from_day) {
      if (!postponed.has(g)) postponed.set(g, new Set())
      postponed.get(g).add(m.from_day)
    }
  }

  const out = []
  for (let i = 0; i < tomorrowGroups.length; i++) {
    for (let j = i + 1; j < tomorrowGroups.length; j++) {
      const a = tomorrowGroups[i]; const b = tomorrowGroups[j]
      let coPresences = 0
      let followed = 0
      for (const [day, groups] of byDay) {
        if (day === tomorrow || !groups.has(a) || !groups.has(b)) continue
        coPresences++
        if (postponed.get(a)?.has(day) || postponed.get(b)?.has(day)) followed++
      }
      if (coPresences < 3 || followed < 3) continue
      out.push({ a, b, occurrences: followed })
    }
  }
  return out.sort((x, y) => y.occurrences - x.occurrences).slice(0, 2)
}

/* ------------------------------------------------------------------ */
/* The full diagnostic                                                 */
/* ------------------------------------------------------------------ */

// Beyond ten open days of work placed on seven days, the week is a lie. Below, we
// keep quiet: commenting on a normal load is noise.
const LOAD_THRESHOLD = 10

export function diagnostics () {
  const day = today()
  const tomorrow = addDays(day, 1)

  const d = {
    day,
    tomorrow,
    muda: muda(),
    lastMile: lastMile(tomorrow),
    stalledProjects: stalledProjects(day),
    doubtfulFacts: doubtfulFacts(),
    corrections: corrections(),
    oscillations: oscillations(),
    sickRules: sickRules(),
    untestedRules: untestedRules(day),
    load: load(day),
    sessions: sessions(),
    predictions: missedPredictions(),
    creep: creep(),
    interactions: riskyInteractions(tomorrow)
  }

  d.loadAlert = d.load.loadDays != null && d.load.loadDays > LOAD_THRESHOLD
  const lists = ['muda', 'lastMile', 'stalledProjects', 'doubtfulFacts',
    'corrections', 'oscillations', 'sickRules', 'untestedRules', 'sessions',
    'predictions', 'interactions']
  // Creep is not a list but a single verdict: present or not.
  d.total = lists.reduce((s, k) => s + d[k].length, 0) + (d.loadAlert ? 1 : 0) + (d.creep ? 1 : 0)
  d.nothing = d.total === 0
  return d
}
