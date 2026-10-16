import './env.js'
import express from 'express'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, today, weekStart, addDays, logJournal, recordHealth, failures } from './db.js'
import {
  listDay, listWeek, listInbox, getTask, createTask, updateTask, deleteTask,
  moveTask, reorderTask, numberTasks, listRules, addRule, deleteRule, stalest,
  setState, listParked, wakeDue,
  checkTree, listTrash, restoreTrash, purgeTrash,
  suspendRule, resumeRule, resolveGroup, dayGroups, groupKey
} from './tasks.js'
import { reject as rejectCandidate } from './agent/rule-engine.js'
import {
  listConversations, getConversation, createConversation, renameConversation,
  archiveConversation, currentConversation, listMessages
} from './agent/conversations.js'
import { MODEL } from './agent/loop.js'
import { enqueue, chatState } from './agent/jobs.js'
import { withGesture, undo as undoGesture, redo as redoGesture, historyPreview } from './history.js'
import { runReview, planReview, lastReviewDay, listReviews, undoReview, dayToReview } from './agent/review.js'
import { runNight } from './agent/night-actions.js'
import { diagnostics, stalledProjects } from './agent/night.js'
import { openInsight } from './agent/interventions.js'
import { listFacts, forgetFact } from './agent/memory.js'
import { SHORTCUTS } from './agent/tools.js'
import { transcribe, sttReady } from './voice.js'
import { startWorker, workerStatus, availableWorkers } from './worker.js'
import {
  applySchedule, daySlots, sortDay, overlaps, gaps,
  nextSlot, currentTime
} from './schedule.js'
import { mountAttachmentRoutes } from './attachments.js'
import { connectClient, publish } from './bus.js'
import { syncGcal, gcalStatus, gcalEnabled } from './gcal.js'
import { recordGesture } from './gestures.js'
import { startClock } from './clock.js'
import { describeImage } from './agent/vision.js'
import { fetchLinkPreview } from './links.js'
import { buildTree, listNotes, readNote, writeNote, deleteNote, moveNote } from './kb/store.js'
import { search as kbSearch, indexNote, rebuildIndex as kbRebuild, startIndex as kbStart } from './kb/index.js'
import { generateTriggers } from './kb/triggers.js'
import { recordNoteChange, noteSnapshot } from './history.js'

const here = dirname(fileURLToPath(import.meta.url))
const WEB_DIST = resolve(here, '../web/dist')
const PORT = Number(process.env.PORT || 8137)

/* ---------------------------------------------------------------- */
/* Auth: a single token, a single bearer                             */
/* ---------------------------------------------------------------- */
/* The token arrives ONCE in the URL (?t=...), the front stores it in           */
/* localStorage then cleans the address bar. After that every API call sends    */
/* it as a header. It therefore stays neither in the browser history nor in the */
/* server logs beyond the first opening.                                        */

const TOKEN = process.env.AGENDA_TOKEN
if (!TOKEN) {
  console.error('AGENDA_TOKEN missing. Add it to the project .env file (see .env.example) then restart.')
  process.exit(1)
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))

/* Ten years. The laptop can sleep for a month without the session falling: a    */
/* cookie set by the server (and not by JavaScript) survives the browsers'       */
/* automatic purges, unlike local storage alone.                                 */
const COOKIE = 'agenda_session'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10

function readCookie (req, name) {
  const raw = req.get('cookie') || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

function setSessionCookie (res) {
  res.append('set-cookie',
    `${COOKIE}=${encodeURIComponent(TOKEN)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`)
}

function auth (req, res, next) {
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const given = bearer || req.get('x-todo-token') || req.query.t || readCookie(req, COOKIE)
  if (given !== TOKEN) return res.status(401).json({ error: 'unauthorized' })
  // Every valid call pushes the deadline back: as long as the device serves from
  // time to time, it never asks for the token again.
  setSessionCookie(res)
  next()
}

const api = express.Router()
api.use(auth)
/* Every route goes through `wrap`. A write call coming from the screen carries
   the `x-gesture` header (one identifier per user gesture, shared by all the
   calls of the same gesture): everything it writes in between then goes into the
   history, and a Ctrl+Z undoes it as one block. See server/history.js. */
const wrap = fn => (req, res) => {
  try {
    const id = req.get('x-gesture')
    const label = (() => { try { return decodeURIComponent(req.get('x-gesture-label') || '') } catch { return '' } })()
    withGesture({ id, label, author: 'user' }, () => fn(req, res))
  } catch (e) { console.error(e); res.status(500).json({ error: String(e.message || e) }) }
}

/* ------------------------------ events ---------------------------- */

/* The persistent SSE stream. The agent no longer uses it to speak: it only
 * carries `refresh`, when the database changed without the screen knowing (a
 * calendar sync, a gesture from the night). EventSource cannot set a header,
 * auth goes through the session cookie (or ?t= as a fallback). */
api.get('/events', (req, res) => connectClient(req, res))

/* ------------------------------ reading --------------------------- */

/**
 * The days sent to the screen: the week being looked at AND the current week.
 *
 * The screen only knew the displayed week. Moving to the next week therefore
 * emptied "today": the day's row, its counter in the sidebar and the day column
 * no longer matched anything, and came back at the next reload. The current week
 * now always travels with the other one; today is therefore always up to date,
 * whichever week is being looked at.
 */
const seenDays = mon => ({ ...listWeek(weekStart(today())), ...listWeek(mon) })

api.get('/bootstrap', wrap((req, res) => {
  const d = req.query.day || today()
  const mon = weekStart(d)
  const conv = currentConversation()
  res.json({
    today: today(),
    weekStart: mon,
    days: Array.from({ length: 7 }, (_, i) => addDays(mon, i)),
    week: seenDays(mon),
    inbox: listInbox(),
    rules: listRules(),
    facts: listFacts(),
    conversations: listConversations(),
    conversationId: conv.id,
    messages: listMessages(conv.id),
    model: MODEL,
    stt: sttReady(),
    shortcuts: SHORTCUTS,
    // What is going wrong: the night that failed, the model that was withdrawn.
    // The screen lights a dot in the header when this list is not empty.
    failures: failures(),
    reviewDone: lastReviewDay() === dayToReview(),
    reviews: listReviews(15),
    stale: stalest(5),
    // What sleeps outside the flow: in escrow, to be clarified, paused. These
    // rows appear nowhere in the week as soon as they no longer have a day, and
    // without this list they would cease to exist for the screen.
    parked: listParked(),
    // The insights still open, indexed by task: it is the ONLY way the agent
    // makes itself heard. A dot on the row concerned, nothing else. An insight
    // stays as long as the row has not moved: it does not expire on its own,
    // otherwise it would disappear before having been read.
    verdicts: Object.fromEntries(
      db.prepare("SELECT task_id, kind FROM interventions WHERE status = 'open' AND task_id IS NOT NULL ORDER BY id ASC")
        .all().map(r => [r.task_id, r.kind])),
    // The same index, but by insight identifier: it is the one the click sends
    // back to the server to make the thread be born. The most RECENT one wins
    // when a row carries several, that is the one that still makes sense.
    verdictIds: Object.fromEntries(
      db.prepare("SELECT task_id, id FROM interventions WHERE status = 'open' AND task_id IS NOT NULL ORDER BY id ASC")
        .all().map(r => [r.task_id, r.id])),
    // The projects where nothing gets checked any more, to mark those rows in
    // the week.
    stalledProjects: stalledProjects(today())
  })
}))

api.get('/day/:day', wrap((req, res) => res.json({ day: req.params.day, tasks: listDay(req.params.day) })))
api.get('/week/:monday', wrap((req, res) => res.json({ weekStart: req.params.monday, today: today(), week: seenDays(req.params.monday) })))

/**
 * The day seen as a schedule: the slots in order, what overlaps, the gaps, and
 * the next slot. Everything is computed in SQL and in code: a number coming out
 * of here cannot be invented.
 */
api.get('/agenda/:day', wrap((req, res) => {
  const slots = daySlots(req.params.day)
  res.json({
    day: req.params.day,
    slots: sortDay(slots),
    overlaps: overlaps(slots).map(([a, b]) => [a.id, b.id]),
    gaps: gaps(slots),
    next: nextSlot(slots, { at: req.query.at || currentTime() })
  })
}))

/* ------------------------------ writing --------------------------- */

api.post('/tasks', wrap((req, res) => {
  const t = createTask(req.body || {})
  res.json(t)
  if (t?.id) recordGesture({ type: 'create', taskId: t.id, meta: { day: t.day, content: t.content } })
}))
/**
 * Editing a row, including its state.
 *
 * `state` does not go through `updateTask`: a state change cascades down the
 * descendants and is written to the journal, which the ordinary update of the
 * fields cannot do. The interface must be able to park a row without going
 * through the chat, otherwise the feature only half exists.
 */
api.patch('/tasks/:id', wrap((req, res) => {
  const id = Number(req.params.id)
  const patch = req.body || {}
  // The state BEFORE the gesture, for the judge: afterwards, the task has
  // already changed.
  const before = getTask(id)
  // Setting or removing a time from the grid. `updateTask` has a closed list of
  // fields that does not know the two time columns, and `startAt: null` must be
  // able to REMOVE the time: it is the same gesture as taking a block off the
  // grid, it does not deserve a second route.
  if (patch.startAt !== undefined || patch.durationMin !== undefined) {
    applySchedule(id, { at: patch.startAt, duration: patch.durationMin })
  }
  let t = updateTask(id, patch)
  if (!t) return res.status(404).json({ error: 'not found' })
  if (typeof patch.state === 'string') {
    t = setState(id, patch.state, {
      waitingOn: patch.waitingOn ?? null,
      wakeAt: patch.wakeAt ?? null,
      note: patch.stateNote ?? ''
    }) || t
  }
  res.json(t)
  // One gesture per patch, the most telling one: check > state > text.
  if (before) {
    const type = patch.checked === true ? 'check'
      : patch.checked === false ? 'uncheck'
        : typeof patch.state === 'string' ? 'state'
          : patch.content !== undefined ? 'edit' : null
    if (type) recordGesture({ type, taskId: id, meta: { state: patch.state, content: before.content } })
  }
}))
// A manual delete also goes to the trash: the front's Ctrl+Z only covers the
// current session, and closing the tab after a mistake left the row lost for
// good.
api.delete('/tasks/:id', wrap((req, res) => {
  const id = Number(req.params.id)
  // Everything is read BEFORE the delete: afterwards, the subtree no longer
  // exists.
  const before = getTask(id)
  const unchecked = before
    ? db.prepare(`WITH RECURSIVE st(x) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN st ON t.parent_id = st.x)
                  SELECT COUNT(*) n FROM tasks WHERE id IN (SELECT x FROM st) AND checked = 0 AND checkbox = 1`).get(id).n
    : 0
  const n = deleteTask(id, { actor: 'user', reason: 'deleted from the screen' })
  res.json({ ok: true, trashed: n })
  if (before) {
    const trashId = db.prepare('SELECT id FROM trash WHERE root_id = ? ORDER BY id DESC LIMIT 1').get(id)?.id || null
    recordGesture({
      type: 'delete',
      taskId: id,
      meta: {
        content: before.content,
        count: n,
        unchecked,
        moveCount: before.moveCount,
        ageDays: Math.round((Date.now() - before.createdAt) / 86400000),
        trashId
      }
    })
  }
}))
api.get('/trash', wrap((req, res) => res.json(listTrash({ limit: Number(req.query.limit) || 20 }))))
api.post('/trash/:id/restore', wrap((req, res) => res.json(restoreTrash(Number(req.params.id)))))
api.post('/tasks/:id/move', wrap((req, res) => {
  const { day, parentId } = req.body || {}
  const before = getTask(Number(req.params.id))
  const t = moveTask(Number(req.params.id), day, parentId === undefined ? {} : { parentId })
  if (!t) return res.status(404).json({ error: 'not found' })
  res.json(t)
  if (before) recordGesture({ type: 'move', taskId: before.id, meta: { fromDay: before.day, toDay: day ?? null } })
}))

/* ------------------------------ rules ----------------------------- */

/* The full state of the agent's brain, for the pilot screen: the rules with
 * their counts (applied/defeated), the engine's candidates with their evidence,
 * and the latest interventions with their outcome (followed, ignored). */
api.get('/agent/state', wrap((req, res) => {
  res.json({
    rules: db.prepare('SELECT * FROM rules WHERE active = 1 ORDER BY id DESC').all(),
    candidates: db.prepare(`SELECT * FROM rule_candidates WHERE status IN ('candidate','testing','proposed')
                            ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'testing' THEN 1 ELSE 2 END, id DESC LIMIT 20`).all(),
    interventions: db.prepare('SELECT * FROM interventions ORDER BY id DESC LIMIT 30').all(),
    runs: db.prepare('SELECT * FROM rule_runs ORDER BY id DESC LIMIT 5').all()
  })
}))

api.patch('/rules/:id', wrap((req, res) => {
  const id = Number(req.params.id)
  const action = String(req.body?.action || '')
  if (action === 'suspend') return res.json(suspendRule(id, { until: addDays(today(), Number(req.body?.days) || 30), reason: 'suspended from the screen' }))
  if (action === 'resume') return res.json(resumeRule(id))
  if (action === 'delete') { deleteRule(id); return res.json({ ok: true }) }
  res.status(400).json({ error: 'unknown action' })
}))

api.patch('/candidates/:id', wrap((req, res) => {
  if (req.body?.status !== 'dead') return res.status(400).json({ error: 'only rejection is allowed here' })
  res.json(rejectCandidate(Number(req.params.id)))
}))

api.get('/rules', wrap((req, res) => res.json(listRules())))
api.post('/rules', wrap((req, res) => res.json(addRule(String(req.body?.text || '').trim(), 'ui'))))
api.delete('/rules/:id', wrap((req, res) => { deleteRule(Number(req.params.id)); res.json({ ok: true }) }))

api.get('/journal', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT 100').all())
}))

/* ------------------------- Google calendar ------------------------ */

/* The mirror runs on its own every fifteen minutes (clock.js). These two routes
   are there to force it and to know where it stands: "my appointments this
   afternoon are not there" must have an answer in one call. */
api.get('/gcal', wrap((req, res) => res.json(gcalStatus())))
api.post('/gcal/sync', async (req, res) => {
  try {
    const r = await syncGcal({ dryRun: !!req.body?.dryRun })
    if (r.ok && (r.created || r.updated || r.deleted)) publish('refresh', { reason: 'gcal' })
    res.json(r)
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }) }
})

/* ------------------------- booked appointments -------------------- */

/* A call booked on an external appointment-booking service arrives here and
   becomes an ORDINARY task: same table, same group, same checkbox, same trash.
   Exactly the Google mirror's doctrine, for the same reason: an appointment that
   could be neither checked nor filed would be a foreign object in an application
   that only knows how to do that.

   `external_id` carries `call:<day>:<time>`, and its unique index makes the
   route IDEMPOTENT: a replay (the booking service's network retry) does not
   create a second row, it returns the one that exists. That is what lets the
   calling service retry without thinking.

   `source = 'call'` protects the row from the night tidy-up (guard in `moveTask`):
   a call is a commitment made with someone else, it does not exist tomorrow if
   it was missed. */
api.post('/hook/call', wrap((req, res) => {
  const s = v => String(v ?? '').trim().slice(0, 300)
  const day = s(req.body?.day)
  const at = s(req.body?.slot)
  const duration = Number(req.body?.duration) || 30
  const who = s(req.body?.name) || 'unknown'
  const phone = s(req.body?.phone)
  const email = s(req.body?.email)
  const msg = s(req.body?.note)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{1,2}:\d{2}$/.test(at)) {
    return res.status(400).json({ error: 'day (YYYY-MM-DD) and slot (HH:MM) are required' })
  }

  const key = `call:${day}:${at}`
  const existing = db.prepare('SELECT id FROM tasks WHERE external_id = ?').get(key)
  if (existing) return res.json({ ok: true, id: existing.id, existing: true })

  // The number first: it is the user who calls, the note must answer
  // "what do I dial" without having to open anything.
  const note = [phone, email, msg && `« ${msg} »`].filter(Boolean).join(' · ')
  const parentId = resolveGroup(day, 'Calls')
  const t = createTask({ day, parentId, content: `Call: ${who}`, note })
  db.prepare("UPDATE tasks SET source = 'call', external_id = ? WHERE id = ?").run(key, t.id)
  applySchedule(t.id, { at, duration })

  publish('refresh', { reason: 'call' })
  res.json({ ok: true, id: t.id })
}))

/* A row of the agenda kept up to date by another service (a CRM, a follow-up
   script, a weekly counter). Same table, same checkbox, same trash. Unique
   `external_id`: a replay updates the text instead of creating a second one.
   `source = 'plan'` is NOT protected from the night tidy-up: the counter follows
   the user to the next day if it is not finished. */
api.post('/hook/task', wrap((req, res) => {
  const s = v => String(v ?? '').trim().slice(0, 300)
  const externalId = s(req.body?.external_id)
  const content = s(req.body?.content)
  const day = s(req.body?.day) || today()
  const group = s(req.body?.group)
  const note = s(req.body?.note)
  if (!externalId || !content) {
    return res.status(400).json({ error: 'external_id and content are required' })
  }
  if (!/^[a-z0-9][a-z0-9:_-]{0,80}$/i.test(externalId)) {
    return res.status(400).json({ error: 'external_id' })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: 'day (YYYY-MM-DD)' })
  }

  const existing = db.prepare('SELECT id FROM tasks WHERE external_id = ?').get(externalId)
  let parentId = null
  if (group) {
    const key = groupKey(group)
    const exact = dayGroups(day).find(g => g.key === key)
    parentId = exact ? exact.id : createTask({ day, content: `# ${group}` }).id
  }
  const patch = { content, day }
  if (group) patch.parentId = parentId
  if ('note' in (req.body || {})) patch.note = note
  if ('checked' in (req.body || {})) patch.checked = !!req.body.checked

  if (existing) {
    const t = updateTask(existing.id, patch)
    publish('refresh', { reason: 'hook' })
    return res.json({ ok: true, id: t.id, existing: true })
  }

  const t = createTask({ day, parentId, content, note })
  db.prepare("UPDATE tasks SET source = 'plan', external_id = ? WHERE id = ?").run(externalId, t.id)
  if ('checked' in (req.body || {}) && req.body.checked) updateTask(t.id, { checked: true })
  publish('refresh', { reason: 'hook' })
  res.json({ ok: true, id: t.id })
}))

/* ------------------------------ tidying --------------------------- */

api.post('/tasks/:id/reorder', wrap((req, res) => {
  const { parentId, afterId, day } = req.body || {}
  const before = getTask(Number(req.params.id))
  const t = reorderTask(Number(req.params.id), {
    parentId: parentId === undefined || parentId === null ? null : Number(parentId),
    afterId: afterId == null ? null : Number(afterId),
    day
  })
  if (!t) return res.status(404).json({ error: 'not found' })
  res.json(t)
  if (before) {
    // afterId absent = inserted first: that is the "move to top" gesture, the
    // subject of idea 37, distinguished from plain reordering.
    const type = afterId == null && (day ?? before.day) === before.day ? 'top' : 'reorder'
    recordGesture({ type, taskId: before.id, meta: { fromDay: before.day, toDay: day ?? before.day } })
  }
}))

api.post('/tasks/number', wrap((req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean)
  res.json(numberTasks(ids, { start: Number(req.body?.start) || 1, strip: !!req.body?.strip }))
}))

/* ------------------------------ memory ---------------------------- */

api.get('/facts', wrap((req, res) => res.json(listFacts())))
api.delete('/facts/:id', wrap((req, res) => res.json(forgetFact(Number(req.params.id)))))

/* ------------------------------ undo ------------------------------ */

/* The screen's Ctrl+Z and Ctrl+Y: one single history for the hand's gestures and
   for the agent's turns (server/history.js). The response says what was undone
   and which days moved; the other open screens reload through the stream. */
const afterHistory = r => {
  if (!r.ok) return
  publish('refresh', { reason: 'history' })
  if (r.notes?.length) {
    try { for (const n of r.notes) indexNote(n); refreshTriggers() } catch {}
  }
}
api.get('/history', wrap((req, res) => res.json(historyPreview())))
api.post('/history/undo', wrap((req, res) => {
  const r = undoGesture()
  afterHistory(r)
  res.json({ ...r, ...historyPreview() })
}))
api.post('/history/redo', wrap((req, res) => {
  const r = redoGesture()
  afterHistory(r)
  res.json({ ...r, ...historyPreview() })
}))

/* ------------------------------ dictation ------------------------- */

/**
 * The audio arrives as a raw body rather than multipart: the browser sends a
 * single file, a complete form would bring nothing and would force one more
 * dependency to decode it.
 */
api.post('/transcribe',
  express.raw({ type: ['audio/*', 'video/*', 'application/octet-stream'], limit: '25mb' }),
  async (req, res) => {
    try {
      const ctrl = new AbortController()
      res.on('close', () => ctrl.abort())
      const text = await transcribe(req.body, req.get('content-type') || 'audio/webm', { signal: ctrl.signal })
      res.json({ text })
    } catch (e) {
      console.error('transcribe:', e.message)
      res.status(502).json({ error: String(e.message || e) })
    }
  })

/* ------------------------------ worker ---------------------------- */

/**
 * "Send to a worker": an instruction leaves as a headless, detached task, in
 * server/worker.js. It uses the same auth as the rest of the agenda (the `api`
 * router), nothing more: no conversation, no complex tracking.
 *
 * `taskId` is the goal taken from the to-do list, optional: the instruction
 * alone remains a valid send. The goal is chosen in the agenda (click on a row),
 * never in the pop-up's request: the TEXT of the task is re-read here from the
 * database, never taken from the request. It is the user's row that prevails,
 * and it is its identifier that the worker must find again to update it once the
 * work is done.
 */
api.get('/worker/options', wrap((req, res) => res.json({ workers: availableWorkers() })))
api.post('/worker', wrap((req, res) => {
  const { instruction, worker, taskId } = req.body || {}
  const text = String(instruction || '').trim()
  let goal = null
  if (taskId !== undefined && taskId !== null && taskId !== '') {
    const t = getTask(Number(taskId))
    if (!t) return res.status(400).json({ error: 'goal not found' })
    goal = { id: t.id, text: t.content }
  }
  if (!text && !goal) return res.status(400).json({ error: 'goal or instruction missing' })
  if (!availableWorkers().some(w => w.id === worker)) return res.status(400).json({ error: 'unknown worker' })
  res.json(startWorker({ instruction: text, worker, goal }))
}))
api.get('/worker/:id', wrap((req, res) => {
  const r = workerStatus(req.params.id)
  if (!r) return res.status(404).json({ error: 'not found' })
  res.json(r)
}))

/* ------------------------------ review ---------------------------- */

api.get('/review/preview', wrap((req, res) => res.json(planReview({ day: req.query.day || dayToReview() }))))
api.get('/reviews', wrap((req, res) => res.json(listReviews())))
api.post('/review', wrap((req, res) => res.json(runReview({
  day: req.body?.day || dayToReview(), dryRun: !!req.body?.dryRun
}))))
api.post('/review/:id/undo', wrap((req, res) => res.json(undoReview(Number(req.params.id)))))

/* ------------------------------ the night ------------------------- */

/**
 * The complete night: tidy up, act, then speak. It is what the 01:00 cron (local
 * time) calls, and the only place the chain starts from.
 *
 * It is not in `wrap`: the last two floors call the model, so the response is
 * asynchronous and can take half a minute. The cron does not read the body, but
 * it is returned anyway so the night can be triggered by hand and what it did
 * can be read.
 */
api.post('/night', async (req, res) => {
  try {
    // A night already played today answers { existing: true } without doing
    // anything again: force replays it anyway, for the user's hand or a test.
    const r = await runNight({ day: req.body?.day || null, dryRun: !!req.body?.dryRun, force: !!req.body?.force })
    recordHealth('night', true)
    res.json(r)
  } catch (e) {
    console.error('night:', e.message)
    // A failing night is written into `health`: the screen lights a dot in the
    // header. Without that, the failure only existed in a journal nobody reads.
    recordHealth('night', false, e.message)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/**
 * The intervention banner's button: the user settles a verdict in one click.
 * Two statuses only, `rejected` (they said no) and `followed` (they did what the
 * verdict proposed). The other statuses belong to the night's automatic
 * measurement, never to a click.
 */
api.patch('/interventions/:id', wrap((req, res) => {
  const status = String(req.body?.status || '')
  if (!['rejected', 'followed'].includes(status)) return res.status(400).json({ error: 'invalid status' })
  const r = db.prepare('UPDATE interventions SET status = ?, resolved_at = ? WHERE id = ?')
    .run(status, Date.now(), Number(req.params.id))
  if (!r.changes) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
}))

/**
 * Opening an insight: this is where the discussion thread is BORN.
 *
 * The agent no longer opens a conversation on its own. Its finding sleeps in the
 * table, shows as a dot on the row, and only becomes a thread on a click. An
 * insight already opened returns its thread: clicking twice does not build two
 * conversations.
 */
api.post('/interventions/:id/open', wrap((req, res) => {
  const conv = openInsight(Number(req.params.id))
  if (!conv) return res.status(404).json({ error: 'not found' })
  res.json({ ...conv, messages: listMessages(conv.id) })
}))

api.get('/night/diagnostics', wrap((req, res) => res.json(diagnostics())))

/* ------------------------------ discussions ----------------------- */

/* `kind` filters: the interface only lists chat threads, machine threads (night
   review, MCP bridge) stay readable here for whoever asks for them explicitly.
   `all` returns everything, archives included. */
api.get('/conversations', wrap((req, res) => {
  const kind = String(req.query.kind || '')
  if (kind === 'all') return res.json(db.prepare('SELECT * FROM conversations WHERE archived = 0 ORDER BY modified_at DESC LIMIT 50').all())
  if (kind === 'mcp') {
    return res.json(db.prepare("SELECT * FROM conversations WHERE archived = 0 AND kind = 'mcp' ORDER BY modified_at DESC LIMIT 20").all())
  }
  res.json(listConversations())
}))
api.post('/conversations', wrap((req, res) => res.json(createConversation({ title: req.body?.title, kind: req.body?.kind === 'mcp' ? 'mcp' : 'chat' }))))
api.get('/conversations/:id', wrap((req, res) => {
  const c = getConversation(Number(req.params.id))
  if (!c) return res.status(404).json({ error: 'not found' })
  res.json({ ...c, messages: listMessages(c.id) })
}))
api.patch('/conversations/:id', wrap((req, res) => res.json(renameConversation(Number(req.params.id), String(req.body?.title || '').slice(0, 60)))))
/* Changing the kind is there to mark a machine thread after the fact: the MCP
   bridge recognises its existing thread by its title and sets kind = 'mcp' on
   it, which takes it out of the chat list. */
api.patch('/conversations/:id/kind', wrap((req, res) => {
  const kind = req.body?.kind === 'mcp' ? 'mcp' : 'chat'
  const r = db.prepare('UPDATE conversations SET kind = ? WHERE id = ?').run(kind, Number(req.params.id))
  if (!r.changes) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true, kind })
}))
api.delete('/conversations/:id', wrap((req, res) => res.json(archiveConversation(Number(req.params.id)))))

/* ------------------------------ attachments ----------------------- */
/* Images, files and links, on a task or in the chat. The binary arrives as a raw
   body like the dictation, and an image gets its description from the vision
   model at send time, once and once only. */
mountAttachmentRoutes(api, express, { describeImage, fetchLinkPreview })

/* ------------------------------ knowledge base -------------------- */
/* A separate brick: these routes hit data/kb and data/kb.db, never the task
   database. The source of truth remains the markdown files on disk, the index is
   only a rebuildable view. */

/* The trigger index follows every write into the base, and its failure must
   never make the write that triggered it fail. */
const refreshTriggers = () => {
  try { generateTriggers() } catch (e) { console.error('triggers:', e.message) }
}

api.get('/kb/tree', wrap((req, res) => {
  const notes = listNotes().map(n => {
    const note = readNote(n.path)
    // mtime travels with each note: it feeds the "Recent" block of the screen,
    // without a second call.
    return { path: n.path, title: note?.title || '', size: n.size, mtime: n.mtime }
  })
  const tree = buildTree(notes)
  res.json({ tree, total: notes.length, folders: tree.folders.length })
}))

api.get('/kb/note', wrap((req, res) => {
  const path = String(req.query.path || '')
  const n = readNote(path)
  if (!n) return res.status(404).json({ error: 'not found' })
  res.json(n)
}))

api.put('/kb/note', wrap((req, res) => {
  const { path, title, content, tags } = req.body || {}
  const before = noteSnapshot(String(path || ''))
  const n = writeNote(String(path || ''), { title, body: String(content ?? ''), tags })
  recordNoteChange(n.path, before, noteSnapshot(n.path))
  indexNote(n.path)
  refreshTriggers()
  res.json(n)
}))

api.delete('/kb/note', wrap((req, res) => {
  const path = String(req.query.path || '')
  const before = noteSnapshot(path)
  const ok = deleteNote(path)
  if (ok) recordNoteChange(path, before, null)
  if (ok) { indexNote(path); refreshTriggers() }
  res.json({ ok })
}))

api.post('/kb/move', wrap((req, res) => {
  const { from, to } = req.body || {}
  const n = moveNote(String(from || ''), String(to || ''))
  if (!n) return res.status(404).json({ error: 'not found' })
  indexNote(String(from))
  indexNote(n.path)
  refreshTriggers()
  res.json(n)
}))

api.get('/kb/search', wrap((req, res) => {
  res.json({
    q: String(req.query.q || ''),
    results: kbSearch(String(req.query.q || ''), {
      limit: Math.min(40, Number(req.query.limit) || 20),
      folder: req.query.folder || null
    })
  })
}))

api.post('/kb/reindex', wrap((req, res) => {
  const r = kbRebuild()
  refreshTriggers()
  res.json(r)
}))

/* ------------------------------ chat ------------------------------ */

api.get('/messages', wrap((req, res) => res.json(listMessages(Number(req.query.conversationId) || currentConversation().id))))

/**
 * Sending a message: it is put in the queue and control is given back RIGHT
 * AWAY.
 *
 * The turn no longer travels in this HTTP response. It runs in the process
 * (`agent/jobs.js`), pushes its steps onto the shared event stream
 * (`/api/events`, event `chat`) and writes its answer to the database at the
 * end. Asking a question and then locking your phone therefore works: the answer
 * is there when you come back. It is the event stream that carries the live
 * feed, not this call.
 */
api.post('/chat', wrap((req, res) => {
  const message = String(req.body?.message || '').trim()
  if (!message) return res.status(400).json({ error: 'empty message' })
  const conversationId = Number(req.body?.conversationId) || currentConversation().id
  res.status(202).json({ conversationId, ...enqueue(conversationId, message) })
}))

/** Where the agent stands on this thread: to re-read on arrival and on return to the foreground. */
api.get('/chat/state', wrap((req, res) => {
  const conversationId = Number(req.query.conversationId) || currentConversation().id
  res.json({ conversationId, ...chatState(conversationId) })
}))

app.use('/api', api)

/* ------------------------------ static ---------------------------- */

/**
 * The name of the bundle served, re-read at every call.
 *
 * Vite signs each build with a fingerprint in the file name. A tab stays open
 * for days: without this spotting, it keeps running the code from before a fix
 * and the bug looks unfixed. The front compares this value with the script it is
 * running and reloads if it changed. Re-read at every call (not at startup) so
 * that a deployment without a service restart is seen too.
 */
function currentBuild () {
  try {
    const html = readFileSync(join(WEB_DIST, 'index.html'), 'utf8')
    return html.match(/assets\/[^"']*\.js/)?.[0] || null
  } catch { return null }
}

app.get('/health', (req, res) => res.json({ ok: true, today: today(), build: currentBuild() }))

if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }))
  const indexHtml = () => readFileSync(join(WEB_DIST, 'index.html'), 'utf8')
  // Express 5: no app.get('*'), we fall back on a final middleware.
  app.use((req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not found' })
    // Opening the invite link sets the long-lived session straight away, before
    // the page even starts: the device is recognised afterwards.
    if (req.query.t === TOKEN) setSessionCookie(res)
    res.type('html').send(indexHtml())
  })
}

// HOST defaults to 127.0.0.1: only the machine's reverse proxy reaches it, the
// port is never published on the public interface. Behind a container proxy
// (traefik in docker), set HOST to the docker gateway address of the proxy
// network.
const HOST = process.env.HOST || '127.0.0.1'

app.listen(PORT, HOST, () => {
  console.log(`agenda on http://${HOST}:${PORT}`)
  // The tree invariant runs first of all: a row hanging from a parent on another
  // day is the exact state in which the agenda lost fourteen tasks, and the
  // tidy-up that follows would lean on it.
  const broken = checkTree({ repair: true })
  if (broken.length) console.log(`tree: ${broken.length} row(s) reattached to the right day`)
  // Waking comes before everything: a task whose pause ends today must become a
  // task of the day again, not an overdue task.
  const woken = wakeDue()
  if (woken.length) console.log('wake at startup:', woken.map(r => r.content).join(', '))
  const purged = purgeTrash()
  if (purged) console.log(`trash: ${purged} deletion(s) older than 30 days forgotten`)
  // The knowledge base resynchronises at startup: its files may have been edited
  // by hand, by an LLM or by a script while the service slept, and the index must
  // always start again from what the disk says.
  try { kbStart() } catch (e) { console.error('kb:', e.message) }
  // The internal clock: the Google mirror every fifteen minutes and the light
  // housekeeping. The external cron keeps the night.
  try { startClock() } catch (e) { console.error('clock:', e.message) }
  // The calendar right away, without waiting for the first quarter of an hour: a
  // service restart must not leave the day without its appointments.
  if (gcalEnabled()) {
    syncGcal()
      .then(r => console.log('Google calendar:', r.ok ? r.summary : `failed, ${r.reason}`))
      .catch(e => console.error('Google calendar:', e.message))
  }
})
