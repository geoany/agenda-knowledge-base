import { db, now } from './db.js'
import { checkTree } from './tasks.js'
import { writeNote, deleteNote, readNote, noteExists } from './kb/store.js'

/**
 * The history: ONE undo mechanism for everything that writes.
 *
 * Three mechanisms used to live side by side: a stack in memory in the page
 * (every gesture pushed ITS own reverse function, written by hand, and half of
 * them were wrong or missing), a per-tool trace for the agent (`undo.js`), and
 * the `undo_last` batches. A gesture forgotten by one of them existed for
 * neither of the other two, and "restore" replayed the undo instead of the
 * gesture.
 *
 * From now on the DATABASE records what changes, through SQLite triggers on
 * `tasks`: every insert, update or delete writes the row before and the row
 * after into `history`, tied to the gesture currently open. Nobody has to write
 * a reverse operation any more: checking, moving, pasting, deleting a whole
 * branch (the cascade fires the children's triggers), setting a time, all of it
 * is undone the same way, and redone the same way.
 *
 * A gesture is:
 *  - for the screen, an identifier the browser sends in the `x-gesture` header
 *    of every write call (pasting ten rows = one gesture);
 *  - for the agent, a whole chat turn (`agent:<session>`);
 *  - nothing at all for what the machine does alone (Google mirror, night):
 *    with no gesture open, the triggers record nothing.
 *
 * Ctrl+Z undoes the most recent gesture, Ctrl+Y redoes the last undone one. A
 * new gesture after an undo makes the previous undos final, as in any editor.
 *
 * KB notes are not SQLite rows: their writes go through `recordNoteChange`,
 * which files the before and the after in the same table. One history, two
 * kinds of target.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS history (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  gesture TEXT NOT NULL,
  target  TEXT NOT NULL DEFAULT 'task',   -- task | note
  key     TEXT NOT NULL,                  -- task id or note path
  op      TEXT NOT NULL,                  -- I (created) | U (updated) | D (deleted)
  before  TEXT,
  after   TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_gesture ON history(gesture, seq);
CREATE TABLE IF NOT EXISTS gesture_log (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT 'user',   -- user | agent
  status     TEXT NOT NULL DEFAULT 'done',   -- done | undone | expired
  created_at INTEGER NOT NULL,
  undone_seq INTEGER
);
CREATE TABLE IF NOT EXISTS current_gesture (
  k  INTEGER PRIMARY KEY CHECK (k = 1),
  id TEXT
);
INSERT OR IGNORE INTO current_gesture (k, id) VALUES (1, NULL);
UPDATE current_gesture SET id = NULL;
`)

/* The triggers are rebuilt at every startup from the REAL list of columns: a
   column added tomorrow by a migration lands in the history by itself, without
   anyone thinking of updating this file. */
const COLUMNS = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name)
const jsonOf = alias => `json_object(${COLUMNS.map(c => `'${c}', ${alias}.${c}`).join(', ')})`
const CURRENT = '(SELECT id FROM current_gesture WHERE k = 1)'
db.exec(`
DROP TRIGGER IF EXISTS hist_tasks_i;
DROP TRIGGER IF EXISTS hist_tasks_u;
DROP TRIGGER IF EXISTS hist_tasks_d;
CREATE TRIGGER hist_tasks_i AFTER INSERT ON tasks WHEN ${CURRENT} IS NOT NULL
BEGIN
  INSERT INTO history (gesture, target, key, op, before, after) VALUES (${CURRENT}, 'task', NEW.id, 'I', NULL, ${jsonOf('NEW')});
END;
CREATE TRIGGER hist_tasks_u AFTER UPDATE ON tasks WHEN ${CURRENT} IS NOT NULL
BEGIN
  INSERT INTO history (gesture, target, key, op, before, after) VALUES (${CURRENT}, 'task', NEW.id, 'U', ${jsonOf('OLD')}, ${jsonOf('NEW')});
END;
CREATE TRIGGER hist_tasks_d AFTER DELETE ON tasks WHEN ${CURRENT} IS NOT NULL
BEGIN
  INSERT INTO history (gesture, target, key, op, before, after) VALUES (${CURRENT}, 'task', OLD.id, 'D', ${jsonOf('OLD')}, NULL);
END;
`)

const readCurrent = db.prepare('SELECT id FROM current_gesture WHERE k = 1')
const setCurrent = db.prepare('UPDATE current_gesture SET id = ? WHERE k = 1')

/** A change that alters nothing but the timestamp is not a gesture: keeping it
    would give a Ctrl+Z with no visible effect. */
const same = (a, b) => {
  if (!a || !b) return false
  const x = JSON.parse(a)
  const y = JSON.parse(b)
  delete x.modified_at; delete y.modified_at
  return JSON.stringify(x) === JSON.stringify(y)
}

function closeGesture (id) {
  for (const r of db.prepare("SELECT seq, before, after FROM history WHERE gesture = ? AND op = 'U'").all(id)) {
    if (same(r.before, r.after)) db.prepare('DELETE FROM history WHERE seq = ?').run(r.seq)
  }
  const n = db.prepare('SELECT COUNT(*) n FROM history WHERE gesture = ?').get(id).n
  if (!n) { db.prepare('DELETE FROM gesture_log WHERE id = ?').run(id); return }
  // A new gesture that really changed something makes the previous undos final:
  // we do not redo a gesture on top of another one.
  db.prepare("UPDATE gesture_log SET status = 'expired' WHERE status = 'undone' AND id <> ?").run(id)
  // The last 400 gestures are more than enough for a Ctrl+Z.
  const old = db.prepare('SELECT id FROM gesture_log ORDER BY rowid DESC LIMIT -1 OFFSET 400').all()
  for (const v of old) {
    db.prepare('DELETE FROM history WHERE gesture = ?').run(v.id)
    db.prepare('DELETE FROM gesture_log WHERE id = ?').run(v.id)
  }
}

/**
 * Runs `fn` inside a gesture: everything it writes into `tasks` (and into the KB
 * through `recordNoteChange`) will be undone as one block.
 *
 * `fn` is synchronous in the common case (the HTTP routes, the agent's tools).
 * If it returns a promise, the gesture stays open until it settles.
 */
export function withGesture ({ id, label = '', author = 'user' }, fn) {
  if (!id) return fn()
  db.prepare('INSERT OR IGNORE INTO gesture_log (id, label, author, status, created_at) VALUES (?,?,?,?,?)')
    .run(String(id).slice(0, 80), String(label).slice(0, 120), author, 'done', now())
  const previous = readCurrent.get()?.id ?? null
  setCurrent.run(String(id).slice(0, 80))
  const finish = () => {
    setCurrent.run(previous)
    try { closeGesture(String(id).slice(0, 80)) } catch (e) { console.error('history:', e.message) }
  }
  let r
  try { r = fn() } catch (e) { finish(); throw e }
  if (r && typeof r.then === 'function') return r.finally(finish)
  finish()
  return r
}

/** A KB note write, recorded in the gesture currently open if there is one. */
export function recordNoteChange (path, before, after) {
  const g = readCurrent.get()?.id
  if (!g) return
  const op = !before ? 'I' : !after ? 'D' : 'U'
  db.prepare("INSERT INTO history (gesture, target, key, op, before, after) VALUES (?, 'note', ?, ?, ?, ?)")
    .run(g, path, op, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null)
}

/** The state of a note as it is handed back to `writeNote`. */
export const noteSnapshot = path => {
  if (!noteExists(path)) return null
  const n = readNote(path)
  if (!n) return null
  const { title, body, tags, source, created, thesis, counter, use_for, exception } = n
  return { title, body, tags, source, created, thesis, counter, use_for, exception }
}

/* ------------------------------------------------------------------ */
/* Undo and redo                                                       */
/* ------------------------------------------------------------------ */

const writeRow = row => {
  const cols = COLUMNS.filter(c => c in row)
  db.prepare(`INSERT OR REPLACE INTO tasks (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(row)
}
const updateRow = row => {
  const cols = COLUMNS.filter(c => c in row && c !== 'id')
  db.prepare(`UPDATE tasks SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(row)
}
/** Removes a row without taking away a subtree that is not part of the gesture:
    its remaining children move up one level instead of disappearing. */
const removeRow = id => {
  const t = db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(id)
  if (!t) return
  db.prepare('UPDATE tasks SET parent_id = ? WHERE parent_id = ?').run(t.parent_id, id)
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
}

function applyNote (path, state) {
  if (state) writeNote(path, state)
  else deleteNote(path)
}

/**
 * Replays a gesture one way or the other. `direction = 'before'` undoes (we walk
 * the entries from the most recent to the oldest and put the before back),
 * `direction = 'after'` redoes (in order, we put the after back).
 */
function replay (g, direction) {
  const rows = db.prepare(`SELECT * FROM history WHERE gesture = ? ORDER BY seq ${direction === 'before' ? 'DESC' : 'ASC'}`).all(g.id)
  const days = new Set()
  const notes = []
  const previous = readCurrent.get()?.id ?? null
  setCurrent.run(null)
  try {
    db.transaction(() => {
      // Parents and children come back in any order: the links are only checked
      // at the end of the transaction.
      db.pragma('defer_foreign_keys = ON')
      for (const l of rows) {
        const state = l[direction] ? JSON.parse(l[direction]) : null
        if (l.target === 'note') { notes.push([l.key, state]); continue }
        const id = Number(l.key)
        const current = db.prepare('SELECT day FROM tasks WHERE id = ?').get(id)
        if (current) days.add(current.day)
        if (state) {
          days.add(state.day)
          if (current) updateRow(state)
          else writeRow(state)
          // A row that comes back is no longer in the trash, nor hidden from the mirror.
          db.prepare('UPDATE trash SET restored_at = ? WHERE root_id = ? AND restored_at IS NULL').run(now(), id)
          if (state.external_id) db.prepare('DELETE FROM gcal_hidden WHERE external_id = ?').run(state.external_id)
        } else if (current) {
          removeRow(id)
        }
      }
      checkTree({ repair: true })
    })()
  } finally {
    setCurrent.run(previous)
  }
  // Notes live on disk, outside the SQLite transaction: we apply them afterwards,
  // in the same order.
  for (const [path, state] of notes) {
    try { applyNote(path, state) } catch (e) { console.error('history note:', e.message) }
  }
  return { days: [...days].filter(Boolean), notes: notes.map(n => n[0]), inbox: [...days].includes(null) }
}

/** The gesture to undo: the one whose last write is the most recent. */
const lastDone = () => db.prepare(`
  SELECT g.*, MAX(h.seq) m FROM gesture_log g JOIN history h ON h.gesture = g.id
  WHERE g.status = 'done' GROUP BY g.id ORDER BY m DESC LIMIT 1`).get()

const lastUndone = () => db.prepare(
  "SELECT * FROM gesture_log WHERE status = 'undone' ORDER BY undone_seq DESC LIMIT 1").get()

export function historyPreview () {
  const a = lastDone()
  const r = lastUndone()
  return {
    undo: a ? { id: a.id, label: a.label, author: a.author } : null,
    redo: r ? { id: r.id, label: r.label, author: r.author } : null
  }
}

/** Ctrl+Z. `author` narrows the search (the agent's undo_last tool only undoes
    the agent's gestures, and never the turn in progress). */
export function undo ({ author = null, except = null } = {}) {
  let g = lastDone()
  if (author || except) {
    g = db.prepare(`
      SELECT g.*, MAX(h.seq) m FROM gesture_log g JOIN history h ON h.gesture = g.id
      WHERE g.status = 'done' ${author ? 'AND g.author = @author' : ''} ${except ? 'AND g.id <> @except' : ''}
      GROUP BY g.id ORDER BY m DESC LIMIT 1`).get({ author, except })
  }
  if (!g) return { ok: false, reason: 'Nothing to undo' }
  const effect = replay(g, 'before')
  const n = (db.prepare('SELECT MAX(undone_seq) n FROM gesture_log').get().n || 0) + 1
  db.prepare("UPDATE gesture_log SET status = 'undone', undone_seq = ? WHERE id = ?").run(n, g.id)
  return { ok: true, gesture: { id: g.id, label: g.label, author: g.author }, ...effect }
}

/** Ctrl+Y: redoes the last undone gesture. */
export function redo () {
  const g = lastUndone()
  if (!g) return { ok: false, reason: 'Nothing to redo' }
  const effect = replay(g, 'after')
  db.prepare("UPDATE gesture_log SET status = 'done', undone_seq = NULL WHERE id = ?").run(g.id)
  return { ok: true, gesture: { id: g.id, label: g.label, author: g.author }, ...effect }
}
