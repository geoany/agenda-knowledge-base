import { db, today, addDays, logJournal } from '../db.js'
import {
  listDay, moveTask, groupWeekdays, nextWeekday, getTask, hasRemainingWork,
  weekdayRule, wakeDue, recentlyPlacedByUser, STATE_LABEL
} from '../tasks.js'
import { createConversation, listConversations } from './conversations.js'
import { weekdayName } from './prompt.js'

/**
 * The end-of-day review.
 *
 * At the end of the day, we go over everything that is not checked and decide
 * where it goes. The important point is that a task does not fall back stupidly
 * to tomorrow: if it belongs to a group that has a fixed day (groceries, on
 * Saturday), it jumps to the next occurrence of that day. That is exactly the
 * case of the lid we could not find: it goes back to the next Saturday, not to
 * tomorrow when no shop trip is planned.
 *
 * Three things hold it back, and they are what makes the difference between a
 * filing and a sweep:
 *   - the wake-up comes before everything, a task that reached its date becomes
 *     a task of the day again instead of being filed as asleep;
 *   - what is not active never moves, a line waiting for someone else is not
 *     postponed, it is reminded;
 *   - what the user has just put back by hand is left in place, otherwise the
 *     calendar flickers (the night sends it to tomorrow, they bring it back in
 *     the morning, it leaves again the next evening).
 *
 * No model call here: filing must be predictable and free. The model steps in
 * only if one asks it to comment on the review.
 */

/**
 * What reached its wake-up date, read-only.
 *
 * Used by the preview (`dryRun`, /review/preview): showing a plan that lies about
 * wake-ups would be worse than showing nothing, but a preview has no right to
 * change the state of a task.
 */
function pendingWakeups (on = today()) {
  return db.prepare(`SELECT id, content, state FROM tasks
                     WHERE state IN ('paused','waiting','parked')
                       AND wake_at IS NOT NULL AND wake_at <= ? AND checked = 0`)
    .all(on)
    .map(r => ({ id: r.id, content: r.content, from: r.state }))
}

export function planReview ({ day = today(), to = null, woken = null } = {}) {
  const tomorrow = to || addDays(day, 1)
  const wd = groupWeekdays()
  const tasks = listDay(day)
  const wakeups = woken || pendingWakeups()
  // A task just woken up is not filed straight away: it asked to come back today,
  // pushing it to tomorrow would cancel the only thing it had been promised.
  const wokenIds = new Set(wakeups.map(r => r.id))

  const groupOf = id => {
    // The fixed day is read on the task itself or on the group containing it.
    let cur = getTask(id)
    let guard = 0
    while (cur && guard++ < 20) {
      const name = (cur.content || '').toLowerCase().trim()
      // The name without the hash is the one a rule written by hand may contain.
      if (wd.has(name)) return { idx: wd.get(name), name: bare(name).toLowerCase().trim() }
      if (!cur.parentId) return null
      cur = getTask(cur.parentId)
    }
    return null
  }

  const plan = {
    day,
    done: [],
    postponed: [],
    weekly: [],
    lagging: [],
    left: [],
    woken: wakeups,
    sleeping: [],
    respected: []
  }

  for (const t of tasks) {
    if (t.parentId) continue // sub-tasks follow their parent
    if (t.checked) { plan.done.push({ id: t.id, content: t.content }); continue }

    // A state other than active is an answer to the question "why is it still
    // there": it waits for the plumber, it is not an action yet, it sleeps until
    // the 20th. Moving it would erase that answer and make it look like a task
    // being postponed.
    if (t.state && t.state !== 'active') {
      plan.sleeping.push({ id: t.id, content: t.content, state: t.state, waitingOn: t.waitingOn, wakeAt: t.wakeAt })
      continue
    }
    if (wokenIds.has(t.id)) continue

    // A fully checked group stays on its day: it serves as a title for the work
    // done, and postponing it would only move an empty shell. It does not count
    // as a done task, so it does not enter the report.
    if (!hasRemainingWork(t.id)) { plan.left.push({ id: t.id, content: t.content }); continue }

    // The dead zone: two thresholds instead of one. As long as the user's gesture
    // is fresh, the night has nothing to say, and the round trip stops.
    const gesture = recentlyPlacedByUser(t.id)
    if (gesture) {
      plan.respected.push({ id: t.id, content: t.content, when: today(new Date(gesture.created_at)) })
      continue
    }

    const g = groupOf(t.id)
    if (g != null) {
      const target = nextWeekday(g.idx, day)
      // We name the rule that decides: without its identifier in the journal, one
      // knows a task moved but never because of what, and a rule learned the wrong
      // way stays impossible to find.
      const rule = weekdayRule(g.name)
      plan.weekly.push({
        id: t.id,
        content: t.content,
        to: target,
        weekday: weekdayName(target),
        ruleId: rule?.id || null,
        ruleText: rule?.text || null
      })
    } else {
      plan.postponed.push({ id: t.id, content: t.content, to: tomorrow })
    }
    if (t.moveCount >= 3) plan.lagging.push({ id: t.id, content: t.content, reports: t.moveCount })
  }

  plan.summary = summary(plan)
  return plan
}

export function applyReview (plan, { dryRun = false } = {}) {
  if (dryRun) return plan
  for (const m of plan.postponed) moveTask(m.id, m.to, { auto: true, reason: 'review' })
  for (const h of plan.weekly) {
    moveTask(h.id, h.to, { auto: true, reason: 'fixed day', ruleId: h.ruleId || null })
    // The counter only rises here, never at plan time: a preview that counted
    // would give a rule a record it has not earned.
    if (h.ruleId) db.prepare('UPDATE rules SET applied = applied + 1 WHERE id = ?').run(h.ruleId)
  }
  logJournal('review', plan.summary, JSON.stringify(plan))
  return plan
}

/**
 * Runs the review and drops its report into a dedicated thread, so that the
 * history of previous evenings can be found again instead of being seen once.
 */
export function runReview ({ day = today(), dryRun = false } = {}) {
  const woken = dryRun ? pendingWakeups() : wakeDue()
  const plan = applyReview(planReview({ day, woken }), { dryRun })
  if (dryRun) return plan

  const title = `Review of ${day}`
  const existing = listConversations(80).find(c => c.kind === 'review' && c.title === title)
  const conv = existing || createConversation({ title, kind: 'review' })
  logJournal('review', plan.summary, JSON.stringify({ ...plan, conversationId: conv.id }))
  plan.conversationId = conv.id
  return plan
}

/* A group title is written "# Deep work" in the agenda: the hash has no business
   being in a report sentence. */
const bare = s => String(s || '').replace(/^\s*#+\s*/, '')

/* Beyond a few names, an enumeration no longer reads: we cut and say how many are
   left. A thirty-line report is no longer read at all. */
function shortList (items, max = 6) {
  const v = items.map(s => String(s || '').trim()).filter(Boolean)
  if (v.length <= max) return v.join(', ')
  return `${v.slice(0, max).join(', ')} and ${v.length - max} more`
}

/* The state one comes out of is phrased differently depending on the state: "comes
   out of waiting" is not how one writes it. */
const WAKE_WORDS = {
  paused: 'comes out of pause',
  waiting: 'no longer waits for anything',
  parked: 'comes out of the waiting lot'
}

function whenText (iso, day) {
  if (!iso) return 'recently'
  if (iso === day) return 'today'
  if (iso === addDays(day, -1)) return 'yesterday'
  return `on ${iso}`
}

/* What sleeps fits in one grouped line: thirty motionless lines detailed one by one
   would drown the three lines that really moved. */
function sleepingLine (sleeping) {
  const parts = []
  for (const st of ['waiting', 'parked', 'paused', 'archived']) {
    const g = sleeping.filter(d => d.state === st)
    if (!g.length) continue
    if (st === 'waiting') {
      const who = g.map(d => d.waitingOn || bare(d.content))
      parts.push(`${g.length} waiting (${shortList(who, 3)})`)
    } else if (st === 'paused') {
      const dates = [...new Set(g.map(d => d.wakeAt).filter(Boolean))]
      parts.push(dates.length === 1 ? `${g.length} paused until ${dates[0]}` : `${g.length} paused`)
    } else {
      parts.push(`${g.length} ${STATE_LABEL[st] || st}`)
    }
  }
  return `${sleeping.length} line(s) do not move: ${parts.join(', ')}.`
}

/**
 * The report.
 *
 * It is not a database log, it is what an actor says about its night: what it
 * did, and why when there is a why (a named rule, a respected user gesture, a
 * wake-up). It fits in about ten lines, otherwise it is no longer read, and what
 * is not read corrects nothing.
 */
function summary (plan) {
  const l = []
  l.push(`Review of ${plan.day} (${weekdayName(plan.day)}).`)

  const rev = plan.woken || []
  if (rev.length === 1) {
    l.push(`"${bare(rev[0].content)}" ${WAKE_WORDS[rev[0].from] || 'wakes up'}, it comes back today.`)
  } else if (rev.length > 1) {
    l.push(`${rev.length} lines wake up and come back today: ${shortList(rev.map(r => bare(r.content)))}.`)
  }

  l.push(plan.done.length
    ? `You checked: ${shortList(plan.done.map(f => bare(f.content)))}.`
    : 'Nothing checked today.')

  if (plan.postponed.length) {
    l.push(`I pushed to tomorrow (${plan.postponed[0].to}): ${shortList(plan.postponed.map(r => bare(r.content)))}.`)
  }

  // The tasks of a same rule are said in one sentence: the rule is the
  // information, not the repetition of the same pattern on five lines.
  const byRule = new Map()
  for (const h of plan.weekly) {
    const key = h.ruleId ? `r${h.ruleId}` : `d${h.to}`
    const e = byRule.get(key) || { ruleText: h.ruleText, weekday: h.weekday, to: h.to, items: [] }
    e.items.push(bare(h.content))
    byRule.set(key, e)
  }
  let n = 0
  for (const e of byRule.values()) {
    if (n >= 3) { l.push(`And ${byRule.size - 3} other(s) sent back to their fixed day.`); break }
    n++
    const why = e.ruleText ? ` (your rule: "${e.ruleText}")` : ''
    const its = e.items.length > 1 ? 'their day' : 'its day'
    l.push(`I sent ${shortList(e.items)} back to ${e.weekday} ${e.to}, that is ${its}${why}.`)
  }

  const res = plan.respected || []
  if (res.length === 1) {
    l.push(`I am not touching "${bare(res[0].content)}", you put it back there yourself ${whenText(res[0].when, plan.day)}.`)
  } else if (res.length > 1) {
    l.push(`I am not touching ${res.length} lines you put back yourself: ${shortList(res.map(r => bare(r.content)))}.`)
  }

  if (plan.sleeping?.length) l.push(sleepingLine(plan.sleeping))

  if (plan.lagging.length) {
    l.push(`It has been dragging for a long time: ${shortList(plan.lagging.map(t => `${bare(t.content)} (${t.reports} postponements)`))}. Either we split it, or we throw it away.`)
  }
  return l.join('\n')
}

/** Last recorded review, so as not to run it twice the same evening. */
export function lastReviewDay () {
  const r = db.prepare("SELECT summary, created_at FROM journal WHERE kind = 'review' ORDER BY id DESC LIMIT 1").get()
  if (!r) return null
  const m = r.summary.match(/Review of (\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/**
 * The history of the reviews, with enough detail to understand and to undo.
 * We only keep those that really moved something: an empty review teaches
 * nothing and would clutter the list.
 */
export function listReviews (limit = 30) {
  return db.prepare("SELECT id, summary, detail, created_at FROM journal WHERE kind = 'review' ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map(r => {
      let plan = {}
      try { plan = JSON.parse(r.detail) } catch {}
      const moved = (plan.postponed?.length || 0) + (plan.weekly?.length || 0)
      return {
        id: r.id,
        day: plan.day,
        createdAt: r.created_at,
        summary: r.summary,
        moved,
        done: plan.done || [],
        postponed: plan.postponed || [],
        weekly: plan.weekly || [],
        lagging: plan.lagging || [],
        woken: plan.woken || [],
        sleeping: plan.sleeping || [],
        respected: plan.respected || [],
        undone: !!plan.undone
      }
    })
    // A review that moved nothing teaches nothing: it would clutter the list
    // without anything one could do with it.
    .filter(r => r.moved > 0)
}

/**
 * Undoes a review: every moved task comes back to its original day.
 * Essential, because a review launched by mistake empties the current day, and
 * finding by hand what was where is unbearable.
 */
export function undoReview (journalId) {
  const row = db.prepare("SELECT detail FROM journal WHERE id = ? AND kind = 'review'").get(journalId)
  if (!row) return { ok: false, error: 'review not found' }
  let plan
  try { plan = JSON.parse(row.detail) } catch { return { ok: false, error: 'unreadable review' } }
  if (plan.undone) return { ok: false, error: 'review already undone' }

  const restored = []
  for (const m of [...(plan.postponed || []), ...(plan.weekly || [])]) {
    const t = getTask(m.id)
    if (!t) continue
    moveTask(m.id, plan.day)
    // The postponement is erased: this task never really dragged one more day.
    db.prepare('UPDATE tasks SET moved_from = NULL, move_count = CASE WHEN move_count > 0 THEN move_count - 1 ELSE 0 END WHERE id = ?')
      .run(m.id)
    // A rule one undoes by hand is the only honest measure of its accuracy: it is
    // this counter that will put it under observation rather than delete it.
    if (m.ruleId) db.prepare('UPDATE rules SET overridden = overridden + 1 WHERE id = ?').run(m.ruleId)
    restored.push(m.content)
  }
  db.prepare('UPDATE journal SET detail = ? WHERE id = ?')
    .run(JSON.stringify({ ...plan, undone: true }), journalId)
  logJournal('review-undone', `Review of ${plan.day} undone, ${restored.length} task(s) given back to their day.`)
  return { ok: true, day: plan.day, restored }
}

/**
 * The day that must be reviewed when nobody specifies one.
 * Before noon, we review the previous day: the review runs at dawn so as not to
 * empty the current day while the user is still working in the evening.
 */
export function dayToReview (now = new Date()) {
  return now.getHours() < 12 ? addDays(today(), -1) : today()
}
