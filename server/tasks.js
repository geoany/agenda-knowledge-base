import { db, now, today, addDays, logJournal } from './db.js'
import { similar } from './text.js'

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const rowToTask = r => ({
  id: r.id,
  parentId: r.parent_id,
  day: r.day,
  content: r.content,
  note: r.note,
  checkbox: !!r.checkbox,
  checked: !!r.checked,
  collapsed: !!r.collapsed,
  position: r.position,
  movedFrom: r.moved_from,
  moveCount: r.move_count,
  createdAt: r.created_at,
  modifiedAt: r.modified_at,
  doneAt: r.done_at,
  state: r.state || 'active',
  waitingOn: r.waiting_on,
  wakeAt: r.wake_at,
  stateAt: r.state_at,
  stateNote: r.state_note,
  sessionId: r.session_id,
  ripened: !!r.ripened,
  // Times travel with the task through EVERY existing endpoint: without that,
  // the time grid would need one query per displayed day while bootstrap has
  // already loaded everything.
  startAt: r.start_at || null,
  durationMin: r.duration_min ?? null,
  // 'gcal' = mirror row of the Google calendar. The field travels to the front,
  // which must render it differently (no handle: carrying it elsewhere would be
  // undone by the next sync).
  source: r.source || null
})

/** Every task of one day, flat, sorted by (tree depth, position). */
export function listDay (day) {
  const rows = db.prepare('SELECT * FROM tasks WHERE day = ? ORDER BY position ASC').all(day)
  return sortTree(rows.map(rowToTask))
}

/** Tasks with no day assigned: the inbox where we drop whatever has no date. */
export function listInbox () {
  const rows = db.prepare('SELECT * FROM tasks WHERE day IS NULL ORDER BY position ASC').all()
  return sortTree(rows.map(rowToTask))
}

/**
 * Puts the flat list back into tree order: each child follows its parent
 * immediately. The front then only has to display them in sequence with an
 * indent per level.
 */
function sortTree (tasks) {
  const byParent = new Map()
  for (const t of tasks) {
    const k = t.parentId ?? 0
    if (!byParent.has(k)) byParent.set(k, [])
    byParent.get(k).push(t)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position)
  const out = []
  const walk = (parentKey, depth) => {
    for (const t of byParent.get(parentKey) || []) {
      out.push({ ...t, depth })
      walk(t.id, depth + 1)
    }
  }
  // A child whose parent lives on another day is treated as a root here.
  const ids = new Set(tasks.map(t => t.id))
  for (const t of tasks) if (t.parentId && !ids.has(t.parentId)) t.parentId = null
  byParent.clear()
  for (const t of tasks) {
    const k = t.parentId ?? 0
    if (!byParent.has(k)) byParent.set(k, [])
    byParent.get(k).push(t)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position)
  walk(0, 0)
  return out
}

export function listWeek (mondayIso) {
  const days = {}
  for (let i = 0; i < 7; i++) {
    const d = addDays(mondayIso, i)
    days[d] = listDay(d)
  }
  return days
}

export function getTask (id) {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  return r ? rowToTask(r) : null
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

function nextPosition (day, parentId) {
  const r = db.prepare(
    'SELECT COALESCE(MAX(position), 0) AS p FROM tasks WHERE day IS ? AND parent_id IS ?'
  ).get(day, parentId ?? null)
  return (r?.p ?? 0) + 1000
}

export function createTask ({ day = null, parentId = null, content = '', note = '', checkbox = true, position = null, afterId = null, sessionId = null }) {
  let pos = position
  if (pos == null && afterId != null) {
    const after = getTask(afterId)
    if (after) {
      const nextRow = db.prepare(
        'SELECT MIN(position) AS p FROM tasks WHERE day IS ? AND parent_id IS ? AND position > ?'
      ).get(after.day, after.parentId ?? null, after.position)
      pos = nextRow?.p != null ? (after.position + nextRow.p) / 2 : after.position + 1000
      day = after.day
      parentId = after.parentId
    }
  }
  if (pos == null) pos = nextPosition(day, parentId)
  const t = now()
  // sessionId marks the tasks born from the same burst of dictation. Nine lines
  // at once look like a win in the statistics while it is often an offload: we
  // want to be able to look later at whether those sessions end up checked or
  // abandoned. It blocks nothing, it just makes the signal readable.
  const info = db.prepare(`
    INSERT INTO tasks (parent_id, day, content, note, checkbox, position, session_id, created_at, modified_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(parentId ?? null, day, content, note, checkbox ? 1 : 0, pos, sessionId, t, t)
  return getTask(info.lastInsertRowid)
}

const FIELDS = {
  content: 'content', note: 'note', day: 'day', parentId: 'parent_id',
  checkbox: 'checkbox', checked: 'checked', collapsed: 'collapsed', position: 'position'
}

export function updateTask (id, patch) {
  const cur = getTask(id)
  if (!cur) return null
  const sets = []
  const vals = []
  for (const [k, col] of Object.entries(FIELDS)) {
    if (!(k in patch)) continue
    let v = patch[k]
    if (typeof v === 'boolean') v = v ? 1 : 0
    sets.push(`${col} = ?`)
    vals.push(v)
  }
  if ('checked' in patch) {
    sets.push('done_at = ?')
    vals.push(patch.checked ? now() : null)
  }
  if (!sets.length) return cur
  sets.push('modified_at = ?')
  vals.push(now())
  vals.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return getTask(id)
}

/**
 * Deletes the task and all its descendants, AFTER putting it in the trash.
 *
 * A four-message conversation destroyed fourteen tasks: two calls in this
 * place, and nothing to catch them. The root cause is fixed
 * (`parentAfterMove`), but a deletion must never again be the point of no
 * return of a model's reasoning. So we serialize the row AND everything
 * hanging below it before letting `ON DELETE CASCADE` do its work.
 *
 * `trash: false` is for deletions known to hold nothing (the empty group shell
 * left after a merge): trashing them would add nothing and would drown the real
 * losses in noise.
 */
export function deleteTask (id, { trash = true, actor = 'user', reason = '', batchId = null, series = true } = {}) {
  // A calendar event lasting several days occupies one row PER DAY ("seaside
  // vacation" from the 8th to the 16th is in fact nine). Nobody wants to drop
  // one and keep the other eight: deleting one row takes the whole series with
  // it, that is the occurrences born from the same event with the same start.
  // Two different weeks of a repeating appointment stay independent, each has
  // its own start.
  //
  // `series: false` on the cascade calls, without which each day would want to
  // delete the others which would want to delete it back: stack overflow.
  if (series) {
    for (const other of seriesSiblings(id)) {
      deleteTask(other, { trash, actor, reason, batchId, series: false })
    }
  }

  const subtree = trash ? subtreeRows(id) : []
  if (subtree.length) {
    db.prepare(`INSERT INTO trash (root_id, root_content, snapshot, count, actor, reason, batch_id, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, String(subtree[0].content || '').slice(0, 200), JSON.stringify(subtree), subtree.length,
        actor, reason, batchId, now())
  }
  // What comes from the Google calendar would put itself back at the next
  // quarter hour: the link to Google is read-only, so the deletion is purely
  // local and the sync is only too happy to recreate what is missing. We
  // remember the dropped keys so the mirror skips them. A deletion that does
  // not hold is worse than a refused one: the user believes the work is done,
  // and it comes back without a word.
  for (const r of subtree) {
    if (r.source === 'gcal' && r.external_id) {
      db.prepare('INSERT OR REPLACE INTO gcal_hidden (external_id, content, created_at) VALUES (?,?,?)')
        .run(r.external_id, String(r.content || '').slice(0, 120), now())
    }
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  return subtree.length
}

/**
 * The OTHER days of the same calendar event, if any.
 *
 * An external key is written `gcal:<event>::<start>` for the first day and
 * `gcal:<event>::<start>#<day>` for each following day. The series is therefore
 * everything sharing the part before the hash. An appointment repeating every
 * week has a different start each week: its weeks do not delete one another,
 * which is exactly what we want.
 */
function seriesSiblings (id) {
  const t = db.prepare('SELECT source, external_id FROM tasks WHERE id = ?').get(id)
  if (!t || t.source !== 'gcal' || !t.external_id) return []
  const base = String(t.external_id).split('#')[0]
  return db.prepare(
    "SELECT id FROM tasks WHERE source = 'gcal' AND id <> ? AND (external_id = ? OR external_id LIKE ?)"
  ).all(id, base, `${base}#%`).map(r => r.id)
}

/** The row and all its descendants, as raw rows, parent first. */
function subtreeRows (id) {
  const out = []
  const seen = new Set()
  const queue = [id]
  while (queue.length) {
    const cur = queue.shift()
    if (seen.has(cur)) continue
    seen.add(cur)
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(cur)
    if (!r) continue
    out.push(r)
    for (const k of db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(cur)) queue.push(k.id)
  }
  return out
}

/**
 * Brings a row and all its descendants back from the trash, with their ids.
 *
 * We rewrite the original ids rather than create new ones: everything else in
 * the product refers to them (the move log, undoable reviews, attachments), and
 * a restore that renumbered would break those links silently. An id taken over
 * in the meantime by another row is the only case where we renumber, carrying
 * the correction over to the children.
 */
export function restoreTrash (trashId) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(trashId)
  if (!row) return { ok: false, error: 'Nothing under that number in the trash.' }
  if (row.restored_at) return { ok: false, error: 'Already restored.' }

  const subtree = JSON.parse(row.snapshot)
  const remap = new Map()
  const restored = []
  const cols = Object.keys(subtree[0])

  const tx = db.transaction(() => {
    for (const t of subtree) {
      const taken = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(t.id)
      const vals = cols.map(c => {
        if (c === 'id') return taken ? null : t.id
        if (c === 'parent_id') return t.parent_id == null ? null : (remap.get(t.parent_id) ?? t.parent_id)
        return t[c]
      })
      const info = db.prepare(`INSERT INTO tasks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals)
      remap.set(t.id, Number(info.lastInsertRowid))
      restored.push({ id: Number(info.lastInsertRowid), content: t.content, day: t.day })
      // Restoring a calendar row means reversing the decision to drop it: the
      // hidden mark goes, otherwise the sync would pick it up again within the
      // quarter hour and the restore would serve no purpose.
      if (t.source === 'gcal' && t.external_id) {
        db.prepare('DELETE FROM gcal_hidden WHERE external_id = ?').run(t.external_id)
      }
    }
    db.prepare('UPDATE trash SET restored_at = ? WHERE id = ?').run(now(), trashId)
  })
  tx()
  // A parent restored while its day changed in the meantime would again leave a
  // row hanging in the void: we run the tree check right after.
  checkTree({ repair: true })
  return { ok: true, restored, count: restored.length }
}

/** What fell into the trash and has not been brought back yet. */
export function listTrash ({ limit = 20, all = false } = {}) {
  return db.prepare(`SELECT id, root_id, root_content, count, actor, reason, batch_id, created_at, restored_at
                     FROM trash ${all ? '' : 'WHERE restored_at IS NULL'} ORDER BY id DESC LIMIT ?`).all(limit)
}

/** Past a month, a deletion is no longer a fresh mistake to catch up on. */
export function purgeTrash ({ days = 30 } = {}) {
  return db.prepare('DELETE FROM trash WHERE created_at < ?').run(now() - days * 86400000).changes
}

/**
 * The tree invariant: no child lives on another day than its parent.
 *
 * This was not checked, and it is the exact state the agenda was in before
 * losing fourteen tasks. A tree inconsistency is a bug, not a possible state:
 * we detect it at server startup and repair it, rather than discovering it on
 * the day a cascade deletion makes use of it.
 */
export function checkTree ({ repair = false } = {}) {
  const broken = db.prepare(`
    SELECT c.id, c.day AS child_day, c.content, p.id AS parent, p.day AS parent_day
    FROM tasks c JOIN tasks p ON p.id = c.parent_id
    WHERE (c.day IS NULL) <> (p.day IS NULL) OR c.day <> p.day`).all()
  if (!repair || !broken.length) return broken

  for (const c of broken) {
    const t = getTask(c.id)
    if (!t) continue
    const target = parentAfterMove({ ...t, day: c.parent_day }, t.day)
    updateTask(c.id, { parentId: target, position: nextPosition(t.day, target) })
  }
  logJournal('tree', `${broken.length} line(s) reattached to the right day`,
    broken.map(c => `#${c.id} ${c.content} (${c.child_day}) under #${c.parent} (${c.parent_day})`).join('\n'))
  return broken
}

/**
 * Moves a task to another day, with its children.
 * `auto` marks the move as made by the machine (night review, wake-up,
 * capillarity) and increments the postponement counter: that counter is what
 * lets us say "you have been pushing this back for 4 days".
 */
export function moveTask (id, day, { auto = false, parentId = undefined, actor, reason = '', ruleId = null, batchId = null } = {}) {
  const t = getTask(id)
  if (!t) return null
  // An appointment imported from the Google calendar is not postponed: its date
  // is decided at Google, and a missed appointment does not exist tomorrow. The
  // guard is here to cover at once ALL automatic callers, today's and those we
  // will write later.
  // Same for a call booked by an appointment service (`source = 'call'`): the
  // slot was taken by someone else, the machine has nothing to say about it.
  if ((t.source === 'gcal' || t.source === 'call') && (auto || actor === 'auto')) return t
  const target = parentId === undefined ? parentAfterMove(t, day) : parentId
  logMove(t, { toDay: day, toParent: target, actor: actor || (auto ? 'auto' : 'user'), reason, ruleId, batchId })
  const merged = mergeGroup(t, day, parentId)
  if (merged) return merged
  updateTask(id, { day, parentId: target, position: nextPosition(day, target) })
  if (auto) {
    db.prepare('UPDATE tasks SET moved_from = ?, move_count = move_count + 1 WHERE id = ?')
      .run(t.day, id)
  } else {
    db.prepare('UPDATE tasks SET moved_from = NULL WHERE id = ?').run(id)
  }
  moveDescendants(id, day, t.day)
  resetInboxMoveCount(id, day, t.day)
  return getTask(id)
}

/**
 * Where a line lands when it changes day without its parent following it.
 *
 * This is THE bug that destroyed fourteen tasks in one conversation. `moveTask`
 * changed the day and kept the `parent_id`: the line left for Saturday while
 * remaining, in the database, a child of a group left on Thursday. The display
 * saw nothing wrong (`sortTree` treats a parent missing from the day as a
 * root), but the Thursday group now looked empty. The agent did what anyone
 * would have done in front of an empty box: it deleted it. `ON DELETE CASCADE`
 * took away every row that lived elsewhere but still belonged to it.
 *
 * A line that changes day therefore ALWAYS changes parent. If the arrival day
 * already has a box with the same name as its old parent, it goes into it: that
 * is the meaning of "push this to Friday" when a "Groceries" group already
 * exists on Friday. Otherwise it becomes a root of its new day. We never create
 * the box along the way: moving three lines would create three empty groups
 * nobody asked for.
 */
function parentAfterMove (t, day) {
  if (t.parentId == null) return null
  if ((t.day ?? null) === (day ?? null)) return t.parentId
  const parent = getTask(t.parentId)
  if (!parent) return null
  if ((parent.day ?? null) === (day ?? null)) return parent.id
  if (!day) return null
  const key = groupKey(parent.content)
  if (!key) return null
  const here = dayGroups(day)
  const twin = here.find(g => g.key === key) || here.find(g => similar(g.key, key))
  return twin ? twin.id : null
}

/**
 * The same group twice on the same day is a bug visible right away.
 *
 * It happens as soon as the arrival day already has its own box with the same
 * name: we reopen "Deep work" in the morning, in the evening the close-out
 * pushes yesterday's on top of it, and the user ends up with two identical
 * titles. So we pour the content into the box that already exists instead of
 * stacking a second one.
 *
 * The original shell is deleted only if it has become empty: when it keeps
 * checked tasks, it stays on its day and serves as their title. Without that
 * precaution, the cascade deletion would take the finished work away.
 */
function mergeGroup (t, day, parentId) {
  if (!day || t.day === day) return null
  if (t.parentId != null || (parentId !== undefined && parentId != null)) return null
  const key = groupKey(t.content)
  if (!key) return null
  const twin = dayGroups(day).find(g => g.id !== t.id && g.key === key)
  if (!twin) return null

  for (const k of db.prepare('SELECT id FROM tasks WHERE parent_id = ? AND checked = 0').all(t.id)) {
    updateTask(k.id, { parentId: twin.id, day, position: nextPosition(day, twin.id) })
    moveDescendants(k.id, day, t.day)
  }
  const left = db.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_id = ?').get(t.id).n
  // Empty shell by construction: trashing it would drown the real losses under
  // dozens of content-free titles.
  if (!left) deleteTask(t.id, { trash: false })
  return getTask(twin.id)
}

/**
 * Takes the children along with their parent, EXCEPT what is already checked.
 *
 * A finished task belongs to the day it was finished on: dragging it from day
 * to day behind its group cluttered the next day with finished work, and that
 * was complaint number one. So it stays put, its parent leaves without it. We
 * do not go down into its own children either: under a checked line, the whole
 * subtree is considered finished with it.
 *
 * When a parent leaves while dropping finished work behind, we copy its title
 * onto the original day and reattach those lines there: without that shelter,
 * the past day became a flat list where you could no longer tell what each
 * checked box referred to.
 */
function moveDescendants (id, day, origin = null) {
  const kids = db.prepare('SELECT id, checked FROM tasks WHERE parent_id = ?').all(id)
  for (const k of kids) {
    if (k.checked) continue
    db.prepare('UPDATE tasks SET day = ?, modified_at = ? WHERE id = ?').run(day, now(), k.id)
    moveDescendants(k.id, day, origin)
  }

  const left = kids.filter(k => k.checked)
  if (!left.length || !origin || origin === day) return
  const t = getTask(id)
  const shelter = createTask({ day: origin, content: t.content, note: t.note, checkbox: t.checkbox })
  const reattach = db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?')
  for (const k of left) reattach.run(shelter.id, k.id)
}

/**
 * Is there anything left to do in there?
 *
 * A group where everything is checked has nothing left to postpone: without
 * this question, the evening close-out would push content-free titles back from
 * one day to the next forever, and every shelter left behind would start over
 * the next morning.
 */
export function hasRemainingWork (id) {
  const t = getTask(id)
  if (!t) return false
  const kids = db.prepare('SELECT id, checked FROM tasks WHERE parent_id = ?').all(id)
  if (!kids.length) return !t.checked
  return kids.some(k => !k.checked && hasRemainingWork(k.id))
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/**
 * The rules that really drive the tidying up.
 *
 * A suspended rule stays in the database and stays visible, but it no longer
 * sorts anything: that is the difference between suspending and deleting. A
 * rule learned badly moved tasks for weeks without anyone being able to say
 * which one; we put it under observation, we do not burn it.
 */
export function listRules ({ all = false } = {}) {
  const rows = db.prepare('SELECT * FROM rules WHERE active = 1 ORDER BY id ASC').all()
  if (all) return rows
  const d = today()
  return rows.filter(r => !r.suspended_until || r.suspended_until <= d)
}

/** The sleeping rules, with the reason and the date they come back. */
export function suspendedRules () {
  const d = today()
  return db.prepare('SELECT * FROM rules WHERE active = 1 AND suspended_until > ? ORDER BY id ASC').all(d)
}

/**
 * Puts a rule under observation until a date. Two uses: pharmacovigilance (it
 * sorts badly, we stop it for a while to see), and the trial pause (we cut it
 * for one night to know whether it is still useful: if the user redoes the
 * tidying up by hand, it was useful).
 */
export function suspendRule (id, { until, reason = '', trial = false } = {}) {
  db.prepare('UPDATE rules SET suspended_until = ?, suspended_reason = ?, tested_at = ? WHERE id = ?')
    .run(until, reason, trial ? now() : null, id)
  logJournal('rule', `Rule ${id} suspended until ${until}`, reason)
  return db.prepare('SELECT * FROM rules WHERE id = ?').get(id)
}

export function resumeRule (id) {
  db.prepare('UPDATE rules SET suspended_until = NULL, suspended_reason = NULL WHERE id = ?').run(id)
  return db.prepare('SELECT * FROM rules WHERE id = ?').get(id)
}

/**
 * A rule already known is not rewritten: its counter is incremented.
 * Without that, the agent re-registers the same habit in every conversation
 * where it comes up, and the prompt fills up with ten phrasings of the same
 * sentence.
 */
export function addRule (text, source = 'chat') {
  const clean = String(text).trim()
  // We deduplicate against ALL rules, suspended ones included: otherwise a rule
  // put under observation would be recreated identically as soon as it comes
  // up, and the observation would serve no purpose.
  const existing = listRules({ all: true }).find(r => similar(r.text, clean))
  if (existing) {
    db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(existing.id)
    return { ...existing, hits: existing.hits + 1, merged: true }
  }
  const info = db.prepare('INSERT INTO rules (text, source, created_at) VALUES (?,?,?)')
    .run(clean, source, now())
  return db.prepare('SELECT * FROM rules WHERE id = ?').get(info.lastInsertRowid)
}

export function deleteRule (id) {
  db.prepare('UPDATE rules SET active = 0 WHERE id = ?').run(id)
}

/**
 * A rule "freezes" a group when its text names that group and contains an
 * intention not to move it. Deliberately simple and readable: rules are written
 * by the agent, we do not want a mini-language to learn.
 */
/*
 * Structured rules first, regexes after. A rule promoted by the engine carries
 * kind/scope/param: no parsing ambiguity left. The scope is a groupKey (no
 * accents, no hash); consumers compare various forms of the group name, so we
 * put ALL known forms of the real group in the output, not just the scope.
 */
function groupNameForms (scope) {
  const forms = new Set([scope])
  for (const g of db.prepare('SELECT DISTINCT content FROM tasks WHERE parent_id IS NULL').all()) {
    if (groupKey(g.content) !== scope) continue
    const low = (g.content || '').toLowerCase().trim()
    forms.add(low)
    forms.add(low.replace(/^#+\s*/, '').trim())
  }
  return forms
}

function structuredRules (kind) {
  return listRules().filter(r => r.kind === kind && r.scope)
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
// French day names kept as aliases: rules already written in French keep working.
const WEEKDAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']

/** Index of the weekday named in a lower-cased text (0 = Sunday), or -1. */
function weekdayIndex (text) {
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (text.includes(WEEKDAYS[i]) || text.includes(WEEKDAYS_FR[i])) return i
  }
  return -1
}

// Free-text rules are written in the user's language: the group name sits after
// the word "tasks" in French, before it in English.
const GROUP_IN_RULE_FR = /t[\u00e2a]ches?\s+([a-z\u00e0-\u00ff0-9 +/'-]{2,30}?)\s+(?:rest|ne|se font|sont|c'est)/
const GROUP_IN_RULE_EN = /(?:the\s+)?([a-z0-9 +/'-]{2,30}?)\s+tasks?\s+(?:are|stay|stays|remain|remains|go|goes|is)\b/

/** The group name named by a free-text rule, or null. */
function groupNamedInRule (text) {
  const m = text.match(GROUP_IN_RULE_FR) || text.match(GROUP_IN_RULE_EN)
  return m ? m[1].trim() : null
}

/**
 * Groups that have a fixed day in the week: "groceries are on Saturday".
 * Returns a Map group name -> day number (0 = Sunday).
 *
 * This is what avoids the pure-freeze trap: an undone grocery task on Saturday
 * must not stay stuck on the past Saturday, it must jump to the next Saturday.
 */
export function groupWeekdays () {
  const out = new Map()
  for (const r of structuredRules('weekday_group')) {
    const wd = safeParam(r).weekday
    if (wd == null) continue
    for (const f of groupNameForms(r.scope)) out.set(f, wd)
  }
  const groups = db.prepare('SELECT DISTINCT content FROM tasks WHERE parent_id IS NULL').all()
    .map(g => (g.content || '').toLowerCase().trim())
    .filter(n => n.length > 2)
  for (const r of listRules()) {
    if (r.kind) continue
    const t = r.text.toLowerCase()
    const dayIdx = weekdayIndex(t)
    if (dayIdx < 0) continue
    for (const name of groups) if (t.includes(name)) out.set(name, dayIdx)
    const named = groupNamedInRule(t)
    if (named) out.set(named, dayIdx)
  }
  return out
}

/**
 * Which rule gives this group its fixed day.
 *
 * groupWeekdays() only returns the day number, which was enough as long as
 * nobody held the rule to account. Now that we measure what a rule sorts and
 * what the user undoes behind it, we must be able to name the culprit: it is
 * its id that goes into the move log.
 */
function safeParam (r) { try { return JSON.parse(r.param || '{}') } catch { return {} } }

export function weekdayRule (groupName) {
  const nom = String(groupName || '').toLowerCase().trim()
  if (nom.length < 3) return null
  const key = groupKey(nom)
  for (const r of structuredRules('weekday_group')) {
    if (r.scope === key || groupNameForms(r.scope).has(nom)) return r
  }
  for (const r of listRules()) {
    if (r.kind) continue
    const t = r.text.toLowerCase()
    if (weekdayIndex(t) < 0) continue
    if (t.includes(nom)) return r
    const named = groupNamedInRule(t)
    if (named && named === nom) return r
  }
  return null
}

/** Next occurrence of that weekday, starting from `from` excluded. */
export function nextWeekday (weekdayIdx, from = today()) {
  const [y, m, d] = from.split('-').map(Number)
  const cur = new Date(y, m - 1, d).getDay()
  const delta = ((weekdayIdx - cur) + 7) % 7 || 7
  return addDays(from, delta)
}

/* ------------------------------------------------------------------ */
/* Groups: the big boxes of a day                                      */
/* ------------------------------------------------------------------ */

/** Comparable name of a group: without the "# " of the title, without accents or punctuation. */
export function groupKey (content) {
  return String(content || '').replace(/^\s*#+\s*/, '').replace(/\*/g, '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, ' ')
}

/**
 * The groups of a day: the root lines that serve as boxes.
 *
 * A root is a group if it carries children or if it is written as a title
 * ("# Deep work"). A plain task placed at the root is not one, so we will never
 * offer to file something under it.
 */
export function dayGroups (day = today()) {
  return db.prepare(`
    SELECT t.id, t.content, (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS kids
    FROM tasks t WHERE t.day IS ? AND t.parent_id IS NULL AND t.content <> ''
    ORDER BY t.position ASC`).all(day)
    .filter(r => r.kids > 0 || /^\s*#/.test(r.content))
    .map(r => ({ id: r.id, content: r.content, key: groupKey(r.content) }))
}

/**
 * The usual groups of the agenda, even when the requested day is still empty.
 *
 * A fresh day has no group: that is precisely where the tidying up fell back
 * into a flat list, since there was nothing to offer. So we look at recent days
 * and already-prepared days, deduplicate by name and sort by frequency: these
 * are the boxes the user reopens every day.
 */
export function usualGroups ({ from = today(), days = 21, limit = 6 } = {}) {
  const start = addDays(from, -days)
  const end = addDays(from, 14)
  const rows = db.prepare(`
    SELECT t.content, t.day, (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS kids
    FROM tasks t WHERE t.parent_id IS NULL AND t.content <> '' AND t.day BETWEEN ? AND ?`).all(start, end)
  const seen = new Map()
  for (const r of rows) {
    if (!r.kids && !/^\s*#/.test(r.content)) continue
    const key = groupKey(r.content)
    if (!key) continue
    const e = seen.get(key) || { key, content: r.content, days: new Set() }
    e.days.add(r.day)
    // We keep the richest spelling: "# Deep work" rather than "deep work".
    if (r.content.length > e.content.length) e.content = r.content
    seen.set(key, e)
  }
  return [...seen.values()]
    .sort((a, b) => b.days.size - a.days.size)
    .slice(0, limit)
    .map(e => ({ content: e.content, key: e.key, days: e.days.size }))
}

/**
 * Finds a day's group from its NAME, and creates it if missing.
 *
 * The agent knows the names ("deep work") but never the ids, which change every
 * day since a group is recreated for each day. So we resolve by name, first
 * exactly, then tolerating a variant. If the group does not exist yet on that
 * day but exists elsewhere in the agenda, we recreate it with exactly its
 * original spelling ("# Deep work" stays a title): without that, every day
 * would end up with two spellings of the same group.
 */
export function resolveGroup (day, name) {
  const key = groupKey(name)
  if (!key) return null
  const here = dayGroups(day)
  const hit = here.find(g => g.key === key) || here.find(g => similar(g.key, key))
  if (hit) return hit.id

  const elsewhere = db.prepare(`
    SELECT content FROM tasks WHERE parent_id IS NULL AND content <> ''
    ORDER BY modified_at DESC LIMIT 300`).all()
  const model = elsewhere.find(r => groupKey(r.content) === key) ||
                elsewhere.find(r => similar(groupKey(r.content), key))
  return createTask({ day, content: model ? model.content : `# ${String(name).trim()}` }).id
}

/* ------------------------------------------------------------------ */
/* Tidying up: reorder, re-parent, number                              */
/* ------------------------------------------------------------------ */

/**
 * Places `id` right after `afterId` (or first if afterId is null) in the list
 * of children of `parentId`, on day `day`.
 *
 * We compute a fractional position between the two neighbours rather than
 * renumbering the whole list: a single UPDATE, and the order stays stable even
 * if two moves cross.
 */
export function reorderTask (id, { parentId = null, afterId = null, day, actor = 'user', reason = '', batchId = null } = {}) {
  const t = getTask(id)
  if (!t) return null
  if (afterId === id) return t
  // Forbidden to file itself under its own descendant, otherwise the branch
  // detaches.
  if (parentId != null && isDescendant(parentId, id)) return t

  const targetDay = day !== undefined ? day : (parentId != null ? getTask(parentId)?.day ?? t.day : t.day)
  const siblings = db.prepare(
    'SELECT id, position FROM tasks WHERE day IS ? AND parent_id IS ? AND id != ? ORDER BY position ASC'
  ).all(targetDay, parentId ?? null, id)

  let pos
  if (!siblings.length) pos = 1000
  else if (afterId == null) pos = siblings[0].position - 1000
  else {
    const i = siblings.findIndex(s => s.id === afterId)
    if (i < 0) pos = siblings[siblings.length - 1].position + 1000
    else if (i === siblings.length - 1) pos = siblings[i].position + 1000
    else pos = (siblings[i].position + siblings[i + 1].position) / 2
  }

  // A manual tidying up is the richest correction in the product: it is the
  // user undoing what the night or the agent had decided. We keep it only if it
  // really changes day or box; a plain reordering inside the same list teaches
  // nothing.
  if (targetDay !== t.day || (parentId ?? null) !== (t.parentId ?? null)) {
    logMove(t, { toDay: targetDay, toParent: parentId ?? null, actor, reason, batchId })
  }
  updateTask(id, { parentId: parentId ?? null, position: pos, day: targetDay })
  moveDescendants(id, targetDay, t.day)
  resetInboxMoveCount(id, targetDay, t.day)
  return getTask(id)
}

/**
 * Dropping a line into the inbox wipes its postponement past.
 *
 * A task that has dragged for three weeks arrives there with "postponed x7" on
 * its back. Yet putting it there without a date is a DECISION, not one more
 * suffered postponement: coming back out of it must be clean, as if it had
 * always been on the day we give it. Nothing is lost though, the `moves` table
 * keeps the full history of the moves; only the displayed counter starts over.
 */
function resetInboxMoveCount (id, dayAfter, dayBefore) {
  if (dayAfter != null || dayBefore == null) return
  db.prepare('UPDATE tasks SET move_count = 0, moved_from = NULL WHERE id = ?').run(id)
}

function isDescendant (id, ancestorId) {
  let cur = getTask(id)
  let guard = 0
  while (cur?.parentId && guard++ < 50) {
    if (cur.parentId === ancestorId) return true
    cur = getTask(cur.parentId)
  }
  return false
}

/**
 * Numbers tasks in the given order: "1. ", "2. "... at the start of the text.
 * A numbering already present is replaced, not stacked, so renumbering an
 * already numbered list stays clean.
 */
export function numberTasks (ids, { start = 1, strip = false } = {}) {
  const out = []
  let n = start
  for (const id of ids) {
    const t = getTask(id)
    if (!t) continue
    const bare = t.content.replace(/^\s*\d+[.)]\s+/, '')
    const content = strip ? bare : `${n}. ${bare}`
    out.push(updateTask(id, { content }))
    n++
  }
  return out
}

/** The tasks that drag: the ones postponed most often. */
export function stalest (limit = 5) {
  return db.prepare(`
    SELECT id, content, day, move_count, moved_from FROM tasks
    WHERE checked = 0 AND move_count > 0 AND state = 'active'
    ORDER BY move_count DESC, modified_at ASC LIMIT ?
  `).all(limit)
}

/* ------------------------------------------------------------------ */
/* States: what is neither done nor to do right now                    */
/* ------------------------------------------------------------------ */

export const STATES = ['active', 'waiting', 'parked', 'paused', 'archived']

/** Short label, as displayed on the line and as the agent speaks of it. */
export const STATE_LABEL = {
  active: '',
  waiting: 'waiting',
  parked: 'to clarify',
  paused: 'paused',
  archived: 'archived'
}

/**
 * Changes the state of a task.
 *
 * `wakeAt` is the date on which it becomes active again on its own. That is
 * what separates a pause from an abandonment: without a wake-up date,
 * everything we set aside disappears for good, and that is exactly what used to
 * happen.
 *
 * The content of `note` is never overwritten: the reason lives in state_note,
 * apart, so that archiving a project does not erase what the user had written
 * under it.
 */
export function setState (id, state, { waitingOn = null, wakeAt = null, note = '', cascade = true } = {}) {
  const t = getTask(id)
  if (!t) return null
  if (!STATES.includes(state)) return t
  db.prepare(`UPDATE tasks SET state = ?, waiting_on = ?, wake_at = ?, state_at = ?, state_note = ?, modified_at = ?
              WHERE id = ?`)
    .run(state, waitingOn, wakeAt, now(), note || null, now(), id)
  // A project put on hold takes its sub-tasks with it: without that, the night
  // would keep moving around the children of a parent that sleeps.
  if (cascade) for (const k of db.prepare('SELECT id FROM tasks WHERE parent_id = ? AND checked = 0').all(id)) {
    setState(k.id, state, { waitingOn, wakeAt, note, cascade: true })
  }
  logJournal('state', `${STATE_LABEL[state] || state}: ${String(t.content).slice(0, 80)}`, JSON.stringify({ id, state, waitingOn, wakeAt, note }))
  return getTask(id)
}

/** Every task that is not in the normal flow, by state. */
export function listParked (state = null) {
  const rows = state
    ? db.prepare("SELECT * FROM tasks WHERE state = ? AND checked = 0 ORDER BY state_at DESC").all(state)
    : db.prepare("SELECT * FROM tasks WHERE state <> 'active' AND checked = 0 ORDER BY state_at DESC").all()
  return rows.map(rowToTask)
}

/**
 * Wakes up whatever has reached its date: the task becomes active again and
 * lands on the requested day. Called at startup and by the night review, never
 * by hand: a pause that has to be lifted by hand is just one more thing
 * forgotten.
 */
export function wakeDue ({ on = today() } = {}) {
  const due = db.prepare("SELECT * FROM tasks WHERE state IN ('paused','waiting','parked') AND wake_at IS NOT NULL AND wake_at <= ? AND checked = 0")
    .all(on).map(rowToTask)
  const woken = []
  for (const t of due) {
    setState(t.id, 'active', { cascade: true })
    if (t.parentId == null) moveTask(t.id, on, { actor: 'auto', reason: 'wake' })
    woken.push({ id: t.id, content: t.content, from: t.state })
  }
  return woken
}

/* ------------------------------------------------------------------ */
/* Move log                                                            */
/* ------------------------------------------------------------------ */

/**
 * Records who moved what, from where to where, and why.
 *
 * This is the raw material of everything the agent learns without being told:
 * the same correction coming back every week becomes a proposed rule, a
 * back-and-forth becomes a contested rule, and a project always pushed to the
 * front becomes an observed priority.
 */
export function logMove (task, { toDay = null, toParent = null, actor = 'user', reason = '', ruleId = null, batchId = null } = {}) {
  if (!task) return
  const sameDay = (task.day ?? null) === (toDay ?? null)
  const sameParent = (task.parentId ?? null) === (toParent ?? null)
  if (sameDay && sameParent) return
  const group = toParent ? groupKey(getTask(toParent)?.content || '') : ''
  db.prepare(`INSERT INTO moves (task_id, content, group_key, from_day, to_day, from_parent, to_parent, actor, reason, rule_id, batch_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(task.id, String(task.content || '').slice(0, 200), group, task.day ?? null, toDay ?? null,
      task.parentId ?? null, toParent ?? null, actor, reason, ruleId, batchId, now())
}

/** The recent moves, from the freshest to the oldest. */
export function recentMoves ({ days = 30, actor = null, limit = 400 } = {}) {
  const since = now() - days * 86400000
  return actor
    ? db.prepare('SELECT * FROM moves WHERE created_at >= ? AND actor = ? ORDER BY id DESC LIMIT ?').all(since, actor, limit)
    : db.prepare('SELECT * FROM moves WHERE created_at >= ? ORDER BY id DESC LIMIT ?').all(since, limit)
}

/**
 * A task the user himself brought back by hand, recently.
 *
 * This is the dead zone: the night has just sent it to tomorrow, he brings it
 * back in the morning, and without this memory it left again the same evening.
 * So we do not move again what he has just re-placed, for two days.
 */
export function recentlyPlacedByUser (taskId, { hours = 40 } = {}) {
  const since = now() - hours * 3600000
  // 'agent' counts as much as 'user': a task placed by the assistant was placed
  // because the user asked for it out loud. Only 'auto' is a machine decision,
  // and it is the only one that must not be protected from itself.
  return db.prepare("SELECT * FROM moves WHERE task_id = ? AND actor IN ('user','agent') AND created_at >= ? ORDER BY id DESC LIMIT 1")
    .get(taskId, since) || null
}

/* ------------------------------------------------------------------ */
/* Capillary pull: checking a line lifts what follows it               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Conditional escrow: release by meaning, not by date                 */
/* ------------------------------------------------------------------ */

/**
 * Compares recent texts (user message, agent reply, learned fact) against the
 * release conditions of the tasks under escrow. "The plumber answered", said in
 * a conversation, releases the task that was waiting for exactly that, without
 * anyone thinking of unblocking it.
 *
 * The similarity threshold is higher than the memory one (0.5 against 0.3):
 * releasing wrongly clutters the day again and discredits the escrow, while
 * missing a release can be caught up at the follow-up date.
 */
export function releaseEscrow (texts = []) {
  const waiting = db.prepare(
    "SELECT id, content, escrow_condition FROM tasks WHERE state = 'waiting' AND escrow_condition IS NOT NULL").all()
  if (!waiting.length) return []
  const released = []
  for (const t of waiting) {
    const trigger = texts.find(x => x && similar(t.escrow_condition, String(x), 0.5))
    if (!trigger) continue
    db.prepare('UPDATE tasks SET escrow_condition = NULL WHERE id = ?').run(t.id)
    setState(t.id, 'active')
    if (!getTask(t.id).day) moveTask(t.id, today(), { actor: 'auto', reason: 'condition met' })
    logJournal('escrow', `"${String(t.content).slice(0, 60)}" released: its condition "${t.escrow_condition}" is met.`)
    released.push(getTask(t.id))
  }
  return released
}
