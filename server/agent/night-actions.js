import { db, today, addDays, now, logJournal } from '../db.js'
import {
  getTask, createTask, updateTask, listDay, setState,
  listRules, suspendRule, resumeRule, suspendedRules, recentMoves, weekdayRule, groupWeekdays,
  moveTask, recentlyPlacedByUser
} from '../tasks.js'
import { isOpenThought, stripEmDash } from '../text.js'
import { streamChat, ask } from './llm.js'
import { muda, stalledProjects, missedPredictions, creep } from './night.js'
import { rememberFact } from './memory.js'

/**
 * What the agent DOES during the night, on top of sorting and talking.
 *
 * Night sorting (review.js) is deterministic and only touches the day of the tasks.
 * The detectors (night.js) only look. Between the two, the only floor that really
 * matters to the user was missing: the one where the agent decides something and
 * you see the result when you open the app.
 *
 * The night gestures, with one common principle: each one is visible and
 * reversible. Nothing disappears, nothing is overwritten, the original text is
 * always kept and each gesture leaves a line in the journal.
 */

const MAX_FIRST_STEPS = 3
const MAX_MUDA_DIAGNOSES = 3
const DAY_MS = 86_400_000

/* ------------------------------------------------------------------ */
/* 1. What is not an action leaves the flow                            */
/* ------------------------------------------------------------------ */

/**
 * "Think about the rewrite" cannot be checked: nothing says when it is finished. So
 * it travelled from day to day forever, and every morning it cost a second of
 * reading for nothing.
 *
 * We do not move it on the first pass: a thought written this morning deserves its
 * day. It is having already postponed it twice that proves it was not a gesture,
 * and that is when it leaves the flow.
 */
export function parkThoughts ({ dryRun = false } = {}) {
  const rows = db.prepare(`SELECT * FROM tasks
    WHERE checked = 0 AND state = 'active' AND day IS NOT NULL AND move_count >= 2 AND content <> ''`).all()
  const parked = []
  for (const r of rows) {
    if (!isOpenThought(r.content)) continue
    if (!dryRun) {
      setState(r.id, 'parked', { note: 'this is not an action, it is waiting to be decided', cascade: false })
    }
    parked.push({ id: r.id, content: r.content, postponements: r.move_count })
  }
  if (parked.length && !dryRun) {
    logJournal('night', `${parked.length} line(s) taken out of the flow: they are not actions.`,
      JSON.stringify(parked))
  }
  return parked
}

/* ------------------------------------------------------------------ */
/* 2. The trial leave of a rule                                        */
/* ------------------------------------------------------------------ */

/**
 * An old rule keeps acting and nobody knows whether it still serves.
 *
 * We cut it for two days and watch. If the user redoes the sorting by hand during
 * that time, the rule was right and it comes back stronger. If nobody notices
 * anything, it was no longer serving, and we tell it so.
 *
 * It is the boldest gesture of the lot, so the most fenced in: only one rule on
 * trial at a time, never a rule that has just acted, and the trial stops by itself
 * after two days even if nobody comes back.
 */
export function ruleTrialPause ({ dryRun = false, days = 2 } = {}) {
  const day = today()

  // First we collect the trials that have come due: a trial you forget to collect
  // only breaks the sorting for two days for nothing.
  const verdicts = []
  for (const r of db.prepare('SELECT * FROM rules WHERE active = 1 AND tested_at IS NOT NULL AND suspended_until IS NOT NULL').all()) {
    if (r.suspended_until > day) continue
    const since = r.tested_at
    const name = [...groupWeekdays().keys()].find(n => r.text.toLowerCase().includes(n))
    // Did they redo by hand what the rule was doing for them?
    const taken = recentMoves({ days: days + 1, actor: 'user' })
      .filter(m => m.created_at >= since)
      .filter(m => !name || (m.content || '').toLowerCase().includes(name) || (m.group_key || '').includes(name))
    const useful = taken.length > 0
    if (!dryRun) {
      resumeRule(r.id)
      db.prepare('UPDATE rules SET tested_at = NULL WHERE id = ?').run(r.id)
      if (useful) db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(r.id)
    }
    verdicts.push({ id: r.id, text: r.text, useful, gestures: taken.length })
    logJournal('rule', useful
      ? `Rule ${r.id} confirmed: cut for ${days} days, the user redid the sorting by hand.`
      : `Rule ${r.id} with no visible effect: cut for ${days} days, nobody noticed anything.`)
  }

  // Then, a single new trial, and only if none is in progress.
  let trial = null
  const running = suspendedRules().some(r => r.tested_at)
  if (!running) {
    const candidates = listRules().filter(r =>
      !r.tested_at && r.applied === 0 && r.created_at < now() - 30 * DAY_MS)
    const chosen = candidates[0] || null
    if (chosen) {
      if (!dryRun) suspendRule(chosen.id, { until: addDays(day, days), reason: 'trial leave: we are checking whether it still serves', trial: true })
      trial = { id: chosen.id, text: chosen.text, until: addDays(day, days) }
    }
  }

  return { verdicts, trial }
}

/* ------------------------------------------------------------------ */
/* 3. (removed) The fermentation of ideas                              */
/* ------------------------------------------------------------------ */
/* The night used to rewrite the sentences of the "To define" inbox with    */
/* the context of the agenda. Removed: a line                                */
/* keeps the text it was given. No automatic gesture changes the text of a   */
/* line any more.                                                            */

/* ------------------------------------------------------------------ */
/* 4. The last mile                                                    */
/* ------------------------------------------------------------------ */

const PROMPT_FIRST_STEP = `Here are lines from the user's agenda for tomorrow. Each one names a piece of work, not a gesture: "backend rewrite", "health insurance paperwork", "follow up with clients".

In the morning, they open their agenda in front of a project and do not know where to start, so they do not start.

Your job: for each line, the VERY FIRST physical gesture, the one that takes less than five minutes and requires no decision. Open this file, find this number, write the first sentence, take the box out of the cupboard. Never "plan", never "think about", never "start": a gesture you could film.

What makes a gesture BAD, and these three mistakes come back all the time:
1. The line is ALREADY a simple gesture ("buy popcorn", "give the IBAN to mum", "connect the accounts"). It does not need to be broken down: you answer NOTHING for it. You only break down a real piece of work, one that would take several hours.
2. You name an app, a screen or a button the task text does not mention. "Open LinkedIn and click Start a post" is an invention: you do not know what their screen looks like. Stick to what is written.
3. You repeat the identifier in the gesture. This number is internal plumbing, it exists nowhere in their world: "click on event 149" means nothing to them.

You invent no fact and you assume no tool you do not see in the agenda.

Answer ONLY with lines of the form:
identifier | the first step

One line per task, no other text. Silence is the right answer when in doubt: better to propose nothing than to add a line they will have to delete.`

/**
 * Each of tomorrow's tasks that looks like a piece of work gets a child that is an
 * immediate gesture. In the morning, you no longer open in front of a project but
 * in front of a movement, which is the only thing that gets you started.
 *
 * The gesture is added as a sub-task, never as a replacement: the work line stays,
 * it is simply given a doorway.
 */
export async function firstStep ({ dryRun = false } = {}) {
  const tomorrow = addDays(today(), 1)
  const candidates = listDay(tomorrow)
    .filter(t => !t.checked && t.state === 'active' && !/^\s*#/.test(t.content))
    // At least six words: below that threshold the line is already a gesture ("buy
    // popcorn", "give the IBAN to mum") and breaking it down produces noise the
    // user has to delete. Observed in the field, the three-word threshold gave
    // absurd sub-tasks on half the lines.
    .filter(t => String(t.content).trim().split(/\s+/).length >= 6)
    .filter(t => db.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_id = ?').get(t.id).n === 0)
    .slice(0, MAX_FIRST_STEPS)
  if (!candidates.length) return []

  const r = await streamChat({
    temperature: 0.3,
    messages: [
      { role: 'system', content: PROMPT_FIRST_STEP },
      { role: 'user', content: candidates.map(t => `${t.id} | ${t.content}`).join('\n') }
    ]
  })

  const done = []
  for (const line of String(r.content || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(.+?)\s*$/)
    if (!m) continue
    const parent = candidates.find(x => x.id === Number(m[1]))
    const gesture = m[2].replace(/^["«\s]+|["»\s]+$/g, '')
    if (!parent || gesture.length < 4) continue
    // The session marks the lines born from the night, like a burst of dictation:
    // the front can tell them apart from a user creation, and the agent's deletion
    // guard (comparing on session_id) knows it did not create them in ITS turn.
    if (!dryRun) createTask({ day: tomorrow, parentId: parent.id, content: gesture, sessionId: 'night-' + today() })
    done.push({ parentId: parent.id, parent: parent.content, gesture })
  }
  if (done.length && !dryRun) {
    logJournal('night', `${done.length} first step(s) added under tomorrow's work lines.`, JSON.stringify(done))
  }
  return done
}

/* ------------------------------------------------------------------ */
/* 5. The muda diagnostic                                              */
/* ------------------------------------------------------------------ */

const PROMPT_MUDA = `You are looking at ONE task from the user's agenda, postponed four times or more without ever being done. At this point, "it drags on" is no longer an observation: it is a verdict to deliver on the STRUCTURE of the line, because carrying it one more day will change nothing.

You deliver ONE single verdict, in a single sentence, among exactly these four forms:
- split: it is too big, and you propose the very first split ("split: start by ...")
- merge with "X": it duplicates another line in its surroundings, which you name
- turn into a fact or a note: it is not an action, it is information to keep
- drop: it will never be done, and saying so is better than carrying it

You invent NO fact: you rely only on what you are given. Answer with the verdict sentence and nothing else: no title, no drawn-out justification, in the user's language, properly accented, never an em dash.`

/**
 * The muda detector (night.js) notices that it drags on; here the agent rules. For
 * each task postponed four times or more, a model call returns a structural
 * verdict: split, merge, turn into, drop. The verdict is written into
 * `interventions` with open status, with no chat message: it is the front that
 * pins the badge on the line concerned.
 *
 * A task whose previous verdict is not yet decided does not pay for another call:
 * the same diagnostic would be re-posted every night and the interventions would
 * pile up on the same line.
 */
export async function diagnoseMuda ({ dryRun = false } = {}) {
  const dragging = muda().slice(0, MAX_MUDA_DIAGNOSES)
  const verdicts = []
  for (const t of dragging) {
    const already = db.prepare(`SELECT COUNT(*) n FROM interventions
                             WHERE kind = 'muda' AND task_id = ? AND resolved_at IS NULL`).get(t.id).n
    if (already) continue
    // Each call in its own try: a model failure on one task stops neither the
    // following ones nor the rest of the night.
    try {
      const line = getTask(t.id)
      const children = db.prepare('SELECT content, checked FROM tasks WHERE parent_id = ? ORDER BY position').all(t.id)
      const context = [
        `The task: "${t.content}", postponed ${t.moveCount} times, created ${t.ageDays} day(s) ago.`,
        t.parent ? `Its parent: "${t.parent}".` : 'It is at the root, with no parent.',
        children.length
          ? `Its sub-tasks:\n${children.map(c => `- ${c.checked ? '[done]' : '[not done]'} ${c.content}`).join('\n')}`
          : 'No sub-task.',
        line?.note ? `Its note: "${line.note}"` : ''
      ].filter(Boolean).join('\n')

      const verdict = stripEmDash(String(await ask(context, { system: PROMPT_MUDA, temperature: 0.3 }) || '').trim())
      if (verdict.length < 4) continue
      if (!dryRun) {
        db.prepare(`INSERT INTO interventions (kind, task_id, trigger, payload, status, created_at)
                    VALUES ('muda', ?, 'night', ?, 'open', ?)`)
          .run(t.id, JSON.stringify({ verdict, reports: t.moveCount, content: t.content }), now())
      }
      verdicts.push({ taskId: t.id, content: t.content, reports: t.moveCount, verdict })
    } catch (e) {
      console.error('muda diagnostic:', e.message)
    }
  }
  if (verdicts.length && !dryRun) {
    logJournal('night', `${verdicts.length} verdict(s) posted on what has been dragging for four postponements or more.`,
      JSON.stringify(verdicts))
  }
  return verdicts
}

/* ------------------------------------------------------------------ */
/* 6. Reduce the backlog: Little's law put into action                 */
/* ------------------------------------------------------------------ */

// Same threshold as night.js: beyond ten open days of work placed on seven days,
// the week is a lie. The constant is copied and not imported: night.js belongs to
// a parallel workstream and does not export it.
const LOAD_ACTION_THRESHOLD = 10
const MAX_LOAD_MOVES = 5

/* Local midnight of an ISO day and weekday index: local copies of night.js's
   private helpers, ten lines we cannot import without touching the other
   workstream's file. */
const localMidnight = iso => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}
const dayIndex = iso => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/**
 * Load (detector 10 of night.js) observed; here we act. When the backlog of the
 * next seven days exceeds the threshold, we take pressure off: at most five root
 * leaf tasks leave the busiest days for the SAME weekday of the following week.
 * The same weekday and not tomorrow: tomorrow is already the problem, and a task
 * placed on a Tuesday had a reason to be on a Tuesday.
 *
 * The whole batch carries a common batch_id: one word in the chat undoes it
 * entirely, like a reorganization. And the dead zone applies: what the user touched
 * themselves in the last 40 hours does not move, otherwise the night starts
 * contradicting their morning gestures again.
 *
 * The load computation is copied from load() in night.js (same SQL, same 28-day
 * window, same leaves only): the function is not exported there and the file
 * belongs to the other workstream, duplicating ten lines costs less than diverging
 * on a signature.
 */
export function reduceBacklog () {
  const day = today()

  // Real throughput: what gets checked per open day over four weeks.
  const start = addDays(day, -27)
  const doneCount = db.prepare('SELECT COUNT(*) n FROM tasks WHERE checked = 1 AND done_at IS NOT NULL AND done_at >= ?')
    .get(localMidnight(start)).n
  let openDays = 0
  for (let i = 0; i < 28; i++) {
    const idx = dayIndex(addDays(start, i))
    if (idx >= 1 && idx <= 5) openDays++
  }
  const throughput = openDays ? doneCount / openDays : 0

  // Backlog: active leaves placed on the next seven days, from the busiest day to
  // the least busy, which is the order in which we relieve.
  const end = addDays(day, 6)
  const byDay = db.prepare(`
    SELECT t.day, COUNT(*) n FROM tasks t
    WHERE t.checked = 0 AND t.state = 'active' AND t.day BETWEEN ? AND ?
      AND (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) = 0
    GROUP BY t.day ORDER BY n DESC
  `).all(day, end)
  const backlog = byDay.reduce((s, r) => s + r.n, 0)
  const loadDays = throughput > 0 ? backlog / throughput : null

  if (loadDays == null || loadDays <= LOAD_ACTION_THRESHOLD) {
    return { moved: [], batchId: null, backlog, loadDays }
  }

  const batchId = `load-${day}`
  const moved = []
  for (const j of byDay) {
    if (moved.length >= MAX_LOAD_MOVES) break
    // Root leaves only: moving a child would dismember its group, and moving a
    // parent with open children would take a whole piece of work with it.
    const candidates = db.prepare(`
      SELECT t.id, t.content, t.day, t.start_at FROM tasks t
      WHERE t.day = ? AND t.checked = 0 AND t.state = 'active' AND t.parent_id IS NULL
        AND (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id
             AND c.checked = 0 AND c.state = 'active') = 0
      ORDER BY t.position ASC
    `).all(j.day)
    for (const t of candidates) {
      if (moved.length >= MAX_LOAD_MOVES) break
      // A group title is not work, and a fixed-time slot is a commitment made with
      // someone: neither moves on its own.
      if (/^\s*#/.test(t.content)) continue
      if (t.start_at) continue
      // The dead zone: what the user re-placed themselves under 40 h stays put.
      if (recentlyPlacedByUser(t.id)) continue
      const to = addDays(t.day, 7)
      moveTask(t.id, to, { auto: true, reason: 'load', batchId })
      moved.push({ id: t.id, content: t.content, from: t.day, to })
    }
  }

  if (moved.length) {
    logJournal('night', `${moved.length} task(s) moved by one week: the load of the next seven days exceeded the real throughput.`,
      JSON.stringify({ batchId, backlog, loadDays: Math.round(loadDays * 10) / 10, moved }))
  }
  return { moved, batchId: moved.length ? batchId : null, backlog, loadDays }
}

/* ------------------------------------------------------------------ */
/* 7. The cold chain: propose archiving without ever archiving         */
/* ------------------------------------------------------------------ */

const COLD_DAYS = 12

const PROMPT_COLD = `You are looking at ONE project from the user's agenda that is no longer moving: no box checked for days, nobody talks about it.

Your job: write IN A SINGLE SENTENCE what the user learned or decided about this project, which must be kept if the project stops here. Not a summary of the project, not a list, not advice: the only thing worth keeping.

You invent NO fact: you rely only on what you are given. If there is really nothing to keep, answer exactly "nothing". In the user's language, properly accented, never an em dash.`

/**
 * A stalled project (night.js) for twelve days is no longer paused, it is cold. We
 * do NOT archive it: archiving is a user gesture, through the chat. We prepare the
 * gesture so it costs one word: a 'cold' intervention proposing the archive with,
 * already written, the knowledge to keep if the project stops there.
 *
 * One project per night, so one model call, and the same deduplication as muda: an
 * undecided proposal is not re-posted every night.
 */
export async function coldProjects () {
  const day = today()
  const threshold = now() - COLD_DAYS * DAY_MS

  let target = null
  let landmark = null
  for (const p of stalledProjects(day)) {
    const t = getTask(p.id)
    if (!t) continue
    // Twelve days without a check, or never checked AND created more than twelve
    // days ago.
    const lastGesture = p.lastCheck || t.createdAt
    if (!lastGesture || lastGesture >= threshold) continue
    const already = db.prepare(`SELECT COUNT(*) n FROM interventions
                             WHERE kind = 'cold' AND task_id = ? AND resolved_at IS NULL`).get(p.id).n
    if (already) continue
    target = { ...p, note: t.note }
    landmark = lastGesture
    break
  }
  if (!target) return null

  const children = db.prepare('SELECT content, checked FROM tasks WHERE parent_id = ? ORDER BY position').all(target.id)
  const days = Math.floor((now() - landmark) / DAY_MS)
  const context = [
    `The project: "${target.content}", ${target.openChildren} sub-task(s) still open, ${target.lastCheck ? `last box checked ${days} day(s) ago` : `no box ever checked since its creation ${days} day(s) ago`}.`,
    children.length
      ? `Its sub-tasks:\n${children.map(c => `- ${c.checked ? '[done]' : '[not done]'} ${c.content}`).join('\n')}`
      : 'No sub-task.',
    target.note ? `Its note: "${target.note}"` : ''
  ].filter(Boolean).join('\n')

  const raw = stripEmDash(String(await ask(context, { system: PROMPT_COLD, temperature: 0.3 }) || '').trim())
  // "nothing" is an honest answer from the model: the archive proposal keeps its
  // meaning, it just goes without knowing what to keep.
  const keep = (raw.length < 4 || /^["«]?\s*(rien|nothing)\s*["»]?\.?$/i.test(raw)) ? null : raw

  db.prepare(`INSERT INTO interventions (kind, task_id, trigger, payload, status, created_at)
              VALUES ('cold', ?, 'night', ?, 'open', ?)`)
    .run(target.id, JSON.stringify({ content: target.content, keep, days }), now())
  logJournal('night', `Cold chain: archiving proposed for "${target.content}" (${days} days without a gesture).`,
    JSON.stringify({ taskId: target.id, keep, days }))
  return { taskId: target.id, content: target.content, keep, days }
}

/* ------------------------------------------------------------------ */
/* 8. Signals become measurable interventions                          */
/* ------------------------------------------------------------------ */

/**
 * missedPredictions() and creep() (night.js) are observations; to be measured by
 * measureInterventions (followed, heard, ignored), they must exist in the
 * interventions table. No chat message here: nothing is written anywhere until the
 * user clicks the badge on the line.
 *
 * The injection of `predictions` and `creepSignal` exists only for tests: in
 * production both come from night.js.
 */
export function interventionsFromSignals ({ predictions, creepSignal } = {}) {
  const pred = predictions ?? missedPredictions()
  const cre = creepSignal !== undefined ? creepSignal : creep()
  const out = { predictions: [], creep: null }

  for (const h of pred) {
    // missedPredictions already filters open interventions; we look a second time
    // because a test call or a manual trigger can arrive with an unfiltered list.
    const already = db.prepare(`SELECT COUNT(*) n FROM interventions
                             WHERE kind = 'prediction' AND task_id = ? AND resolved_at IS NULL`).get(h.id).n
    if (already) continue
    db.prepare(`INSERT INTO interventions (kind, task_id, trigger, payload, status, created_at)
                VALUES ('prediction', ?, 'night', ?, 'open', ?)`)
      .run(h.id, JSON.stringify({ content: h.content, dueAt: h.dueAt }), now())
    out.predictions.push({ taskId: h.id, content: h.content, dueAt: h.dueAt })
  }

  if (cre && cre.target) {
    // A single live creep intervention per 72 h window: the slope does not change
    // in a day, re-flagging it every night would be harassment.
    const recent = db.prepare(`SELECT COUNT(*) n FROM interventions
                                WHERE kind = 'creep' AND resolved_at IS NULL AND created_at >= ?`)
      .get(now() - 72 * 3600000).n
    if (!recent) {
      db.prepare(`INSERT INTO interventions (kind, task_id, trigger, payload, status, created_at)
                  VALUES ('creep', ?, 'night', ?, 'open', ?)`)
        .run(cre.target.id, JSON.stringify({
          target: cre.target.content,
          total: cre.total,
          tasks: cre.tasks
        }), now())
      out.creep = { taskId: cre.target.id, target: cre.target.content, total: cre.total }
    }
  }

  if (out.predictions.length || out.creep) {
    logJournal('night', `${out.predictions.length} missed prediction(s)${out.creep ? ' and a creep' : ''} posted as interventions.`,
      JSON.stringify(out))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 9. Wobble: the implicit weight becomes a fact                       */
/* ------------------------------------------------------------------ */

const WOBBLE_WINDOW_MS = 30 * 60_000
const WOBBLE_THRESHOLD = 3

/**
 * When a task of a group arrives, everything else moves back within the half hour:
 * that group goes ahead without the user ever having said so. Three occurrences in
 * thirty days, and this implicit priority becomes a fact in memory, hence something
 * the agent knows and can name.
 *
 * Only human gestures count (user and agent): the night places dozens of moves in
 * the same minute, every group would look like it goes ahead of everyone. And a
 * move back is a real move back: a move to a LATER day, not a simple box tidy-up.
 */
export function wobble () {
  const since = now() - 30 * DAY_MS
  const mv = db.prepare(`
    SELECT id, task_id, group_key, from_day, to_day, created_at FROM moves
    WHERE created_at >= ? AND actor IN ('user','agent')
    ORDER BY created_at ASC, id ASC
  `).all(since)

  const occurrences = new Map()
  for (let i = 0; i < mv.length; i++) {
    // group_key is the HOME group: this move is an arrival into G.
    const g = (mv[i].group_key || '').trim()
    if (!g) continue
    let pushedBack = false
    for (let j = i + 1; j < mv.length && mv[j].created_at <= mv[i].created_at + WOBBLE_WINDOW_MS; j++) {
      const other = (mv[j].group_key || '').trim()
      if (mv[j].task_id === mv[i].task_id || other === g) continue
      if (mv[j].from_day && mv[j].to_day && mv[j].to_day > mv[j].from_day) { pushedBack = true; break }
    }
    if (pushedBack) occurrences.set(g, (occurrences.get(g) || 0) + 1)
  }

  // One fact per night: the clearest group, the others will wait until they are
  // true again tomorrow.
  let top = null
  for (const [g, n] of occurrences) {
    if (n >= WOBBLE_THRESHOLD && (!top || n > top.n)) top = { g, n }
  }
  if (!top) return null

  const text = `When a "${top.g}" task arrives, the rest moves back: "${top.g}" goes ahead without them saying so.`
  // rememberFact deduplicates by similarity: the same night replayed increases the
  // fact's weight instead of creating a second one.
  const fact = rememberFact(text, 'wobble')
  const isNew = !!fact && !fact.merged
  if (isNew) {
    logJournal('night', `An implicit priority put into words: "${top.g}" goes ahead.`,
      JSON.stringify({ group: top.g, occurrences: top.n }))
  }
  return { group: top.g, occurrences: top.n, text, isNew }
}

/* ------------------------------------------------------------------ */
/* The morning lines for the gestures of waves 4 and 5                 */
/* ------------------------------------------------------------------ */

/**
 * actionsText() lives in night.js, which belongs to a parallel workstream: the
 * lines for the new gestures are therefore built here, and go to the return of
 * runNight in actions.extraText, nothing
 * breaks while waiting for the reconciliation that will fold the extra text into
 * the main text.
 *
 * Missed predictions and creep have no line here: they are signals, not actions,
 * and diagnostics() already carries them.
 */
export function extraActionsText (a) {
  if (!a) return ''
  const l = []
  if (a.backlog?.moved?.length) {
    const n = a.backlog.moved.length
    l.push(`- I moved ${n} task(s) to the same weekday next week (${a.backlog.moved.map(d => `"${d.content}"`).join(', ')}): the load of the next seven days exceeded your real pace. It can be undone with one word.`)
  }
  if (a.cold) {
    l.push(`- "${a.cold.content}" has not moved for ${a.cold.days} day(s). I propose archiving it${a.cold.keep ? `, keeping this: "${a.cold.keep}"` : ''}. Nothing leaves without your agreement.`)
  }
  if (a.wobbleFact?.isNew) {
    l.push(`- I noted that "${a.wobbleFact.group}" goes ahead: when a task of this group arrives, the rest moves back without you ever having said so.`)
  }
  return l.length ? '\n' + l.join('\n') : ''
}

/* ------------------------------------------------------------------ */
/* The chain                                                           */
/* ------------------------------------------------------------------ */

/**
 * The five night gestures, in order. Each one is isolated: a model call that fails
 * must not take down the deterministic gestures that precede it, otherwise a
 * network outage cancels the whole night.
 */
export async function nightActions ({ dryRun = false } = {}) {
  return runActions({ dryRun })
}

async function runActions ({ dryRun }) {
  const out = {
    thoughts: [],
    trial: null,
    verdicts: [],
    steps: [],
    muda: [],
    backlog: null,
    cold: null,
    predictionsFlagged: [],
    creepFlagged: null,
    wobbleFact: null,
    errors: []
  }
  try { out.thoughts = parkThoughts({ dryRun }) } catch (e) { out.errors.push(`thoughts: ${e.message}`) }
  try {
    const c = ruleTrialPause({ dryRun })
    out.trial = c.trial
    out.verdicts = c.verdicts
  } catch (e) { out.errors.push(`rules: ${e.message}`) }
  try { out.steps = await firstStep({ dryRun }) } catch (e) { out.errors.push(`first step: ${e.message}`) }
  try { out.muda = await diagnoseMuda({ dryRun }) } catch (e) { out.errors.push(`muda: ${e.message}`) }
  // The gestures of waves 4 and 5 all write (moves, interventions, facts): a dry run
  // skips them entirely rather than simulating halfway, a dry run that writes anyway
  // is a lie worse than an absence.
  if (!dryRun) {
    try { out.backlog = reduceBacklog() } catch (e) { out.errors.push(`load: ${e.message}`) }
    try { out.cold = await coldProjects() } catch (e) { out.errors.push(`cold: ${e.message}`) }
    try { out.wobbleFact = wobble() } catch (e) { out.errors.push(`wobble: ${e.message}`) }
  }
  // The interventions coming from signals (predictions, creep) are NOT written here:
  // missedPredictions() filters itself on open interventions, so runNight writes them
  // after the night's gestures, so that a piece of advice does not bear on a line the
  // night itself just handled.
  out.total = out.thoughts.length + out.steps.length + (out.trial ? 1 : 0) +
    out.verdicts.length + out.muda.length +
    (out.backlog?.moved?.length || 0) + (out.cold ? 1 : 0) + (out.wobbleFact ? 1 : 0)
  return out
}

/**
 * The whole night, in the only order that makes sense.
 *
 * 1. SORT (review.js): deterministic, free, it is the original contract.
 * 2. ACT (this file): the gestures that change something in the agenda.
 * 3. MEASURE: the fate of the advice already posted, then the new signals that
 *    became silent advice. The agent tells nothing: what it saw waits on the line
 *    concerned for the user to come and find it.
 */
export async function runNight ({ day = null, dryRun = false, force = false } = {}) {
  const { runReview, dayToReview } = await import('./review.js')
  const { measureInterventions } = await import('./interventions.js')

  // The 1 a.m. cron and a manual trigger can cross on the same day: without this
  // guard, each POST replayed every gesture and the user found two morning points.
  // The journal is the only reliable trace, same pattern as lastReviewDay in
  // review.js. We match only the closing entry "Night of ...": the intermediate
  // gestures also write kind='night', and a night interrupted before its closing
  // must be able to be restarted. The date is read on created_at (local day) and not
  // in the text: the day being sorted is the previous day before noon, not the day
  // of the trigger.
  const currentDay = today()
  if (!force) {
    const last = db.prepare(`SELECT created_at FROM journal
                                 WHERE kind = 'night' AND summary LIKE 'Night of %'
                                 ORDER BY id DESC LIMIT 1`).get()
    if (last && today(new Date(last.created_at)) === currentDay) return { already: true, day: currentDay }
  }

  const out = { errors: [] }
  try { out.plan = runReview({ day: day || dayToReview(), dryRun }) } catch (e) { out.errors.push(`sorting: ${e.message}`) }
  try { out.actions = await runActions({ dryRun }) } catch (e) { out.errors.push(`actions: ${e.message}`) }
  // The rule engine no longer runs (deliberately cut): rules are born from what the
  // user says to the assistant, no longer from repeated corrections.
  // The conditional escrow re-checks itself against facts learned recently: a
  // condition met during the day without a linked conversation is caught up here.
  try {
    if (!dryRun) {
      const { releaseEscrow } = await import('../tasks.js')
      const facts = db.prepare('SELECT text FROM facts WHERE created_at >= ?').all(now() - 48 * 3600000).map(f => f.text)
      out.escrow = releaseEscrow(facts).map(t => t.content)
    }
  } catch (e) { out.errors.push(`escrow: ${e.message}`) }
  // The measurement: advice open for more than 48 h receives its fate when something
  // came to decide it. Never on a dry run: the measurement writes to the database,
  // which a dry run promises not to do.
  try { out.measures = dryRun ? null : measureInterventions() } catch (e) { out.errors.push(`measures: ${e.message}`) }
  // The gestures of waves 4 and 5 are put into words for the return of runNight and
  // the journal: it is the only readable trace of what the night did, now that nobody
  // tells it on waking.
  try {
    if (out.actions) {
      out.actions.extraText = extraActionsText(out.actions)
      out.extraText = out.actions.extraText
    }
  } catch (e) { out.errors.push(`extra text: ${e.message}`) }
  // The signals become advice: a badge on the line concerned, and nothing else. No
  // text is written anywhere until the user clicks on it.
  try {
    if (!dryRun) {
      const s = interventionsFromSignals()
      out.signals = { predictions: s.predictions, creep: s.creep }
    }
  } catch (e) { out.errors.push(`signals: ${e.message}`) }
  // The weaving of the knowledge base, at the very end: it is the only floor that
  // does not concern the agenda, and the only one whose failure has no consequence on
  // the morning. It only touches notes that are new or rewritten since their last
  // thesis, eight per night at most (see server/kb/weaving.js).
  try {
    if (!dryRun) {
      const { weaveNewNotes } = await import('../kb/weaving.js')
      const t = await weaveNewNotes()
      if (t.woven.length) {
        const { rebuildIndex } = await import('../kb/index.js')
        const { generateTriggers } = await import('../kb/triggers.js')
        rebuildIndex()
        // The theses have just changed: the trigger index follows them, otherwise the
        // hook would recall notes with their old sentence.
        generateTriggers()
      }
      out.weaving = t
    }
  } catch (e) { out.errors.push(`weaving: ${e.message}`) }
  if (!dryRun) {
    logJournal('night', `Night of ${out.plan?.day || today()} : ${out.actions?.total || 0} gesture(s).`,
      JSON.stringify({ actions: out.actions, errors: out.errors }))
  }
  return out
}
