import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.AGENDA_DATA_DIR || resolve(here, '../data')
export const DB_PATH = process.env.AGENDA_DB || resolve(DATA_DIR, 'todo.db')
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  day         TEXT,                  -- 'YYYY-MM-DD', NULL = no day (the inbox)
  content     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  checkbox    INTEGER NOT NULL DEFAULT 1,
  checked     INTEGER NOT NULL DEFAULT 0,
  collapsed   INTEGER NOT NULL DEFAULT 0,
  position    REAL    NOT NULL DEFAULT 0,
  moved_from  TEXT,                  -- original day if moved automatically
  move_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_day    ON tasks(day);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  source     TEXT NOT NULL DEFAULT 'chat',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,          -- nature of the entry: review | chat | mcp | night | gcal | human gesture
  summary    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL,          -- user | assistant
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT 'New conversation',
  kind        TEXT NOT NULL DEFAULT 'chat',   -- chat | review
  created_at  INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  archived    INTEGER NOT NULL DEFAULT 0
);

-- What the agent understood about the user and that does not fit a strict rule:
-- preferences, habits, turns of phrase. Read again on every message, like the rules.
CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 1,  -- goes up when the fact is confirmed again
  source     TEXT NOT NULL DEFAULT 'agent',
  created_at INTEGER NOT NULL,
  used_at    INTEGER
);
`)

/* ---------------------------------------------------------------- */
/* Migrations: columns added after the fact                          */
/* ---------------------------------------------------------------- */
/* Messages existed before conversations. We attach them to a first            */
/* conversation rather than lose them: the chat history is part of the agent's */
/* memory.                                                                     */

const cols = t => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name))
const addCol = (t, name, decl) => { if (!cols(t).has(name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${decl}`) }

addCol('messages', 'conversation_id', 'INTEGER')
// steps = JSON of the agent steps (tools called, results) to replay the run
// when an old conversation is reopened.
addCol('messages', 'steps', "TEXT NOT NULL DEFAULT ''")
addCol('rules', 'hits', 'INTEGER NOT NULL DEFAULT 0')

/* ---------------------------------------------------------------- */
/* The state of a task, beyond checked / not checked                 */
/* ---------------------------------------------------------------- */
/* A line could only be in two states, and that is what made everything that is  */
/* neither done nor doable travel from day to day: what waits for someone else,  */
/* what is not an action ("think about X"), what was set aside for a month. Each */
/* of those cases now has its own state, and the nightly tidy-up moves on instead */
/* of pushing them back.                                                         */
/*                                                                              */
/*   active   : the normal case, the night moves it                               */
/*   waiting  : in escrow, it waits for someone or something                      */
/*   parked   : in the waiting loop, it is not an action yet                      */
/*   paused   : deliberately paused, with a wake-up date                          */
/*   archived : the project is dead, what was learned from it stays in state_note */

addCol('tasks', 'state', "TEXT NOT NULL DEFAULT 'active'")
addCol('tasks', 'waiting_on', 'TEXT')          // who or what we are waiting for
addCol('tasks', 'wake_at', 'TEXT')             // YYYY-MM-DD: it becomes active again that day
addCol('tasks', 'state_at', 'INTEGER')         // since when it has been in this state
addCol('tasks', 'state_note', 'TEXT')          // the reason, or what was learned while archiving
addCol('tasks', 'session_id', 'TEXT')          // dictation: tasks born from the same burst
addCol('tasks', 'ripened', 'INTEGER NOT NULL DEFAULT 0') // 1 = already rewritten after ripening
db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state) WHERE state <> 'active'")

/* A rule is a medicine: it acts, and it can have side effects. So we count what   */
/* it moved (applied) and how many times the user undid that move by hand           */
/* (overridden). Beyond a rate, it is suspended and not deleted: a rule that is     */
/* wrong today may become right again, and above all we want to be able to say      */
/* why it sleeps.                                                                   */
addCol('rules', 'applied', 'INTEGER NOT NULL DEFAULT 0')
addCol('rules', 'overridden', 'INTEGER NOT NULL DEFAULT 0')
addCol('rules', 'suspended_until', 'TEXT')     // YYYY-MM-DD, it drives nothing until then
addCol('rules', 'suspended_reason', 'TEXT')
addCol('rules', 'tested_at', 'INTEGER')        // last trial leave

/* The log of moves. Without it, a move left no trace of its reason: we saw the  */
/* result, never the friction. It is what we read again at night to spot that the */
/* same correction comes back every week, that a task goes back and forth, or that */
/* a project always comes first.                                                  */
db.exec(`
CREATE TABLE IF NOT EXISTS moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER,
  content     TEXT NOT NULL DEFAULT '',
  group_key   TEXT NOT NULL DEFAULT '',   -- normalized name of the host group
  from_day    TEXT,
  to_day      TEXT,
  from_parent INTEGER,
  to_parent   INTEGER,
  actor       TEXT NOT NULL DEFAULT 'user',  -- user | auto | agent
  reason      TEXT NOT NULL DEFAULT '',
  rule_id     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_task ON moves(task_id);
CREATE INDEX IF NOT EXISTS idx_moves_time ON moves(created_at);
`)

/* A batch of moves made in a single gesture carries the same batch_id: that is what */
/* makes a whole reorganization undoable in one word, instead of having to undo      */
/* eighteen movements one by one and forget half of them.                            */
addCol('moves', 'batch_id', 'TEXT')
db.exec('CREATE INDEX IF NOT EXISTS idx_moves_batch ON moves(batch_id)')

/* ---------------------------------------------------------------- */
/* The trash: no deletion is final any more                          */
/* ---------------------------------------------------------------- */
/* A four-message conversation destroyed fourteen tasks: the agent had moved lines   */
/* without detaching their parent, they had become invisible on both days, it       */
/* believed the group empty and deleted it. ON DELETE CASCADE took the rest. The    */
/* cause is fixed elsewhere (moveTask detaches), but a deletion must never AGAIN be */
/* the point of no return of a model's reasoning.                                   */
/*                                                                                  */
/* We keep a separate table rather than a deleted_at on tasks: the soft-delete      */
/* would force us to filter the fifteen queries of tasks.js and stats.js, and the   */
/* slightest forgotten one would make a dead line reappear. The trash, for its      */
/* part, touches no existing query.                                                 */
db.exec(`
CREATE TABLE IF NOT EXISTS trash (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id      INTEGER NOT NULL,            -- id of the deleted line
  root_content TEXT NOT NULL DEFAULT '',
  snapshot     TEXT NOT NULL,               -- JSON: the line AND all its descendants
  count        INTEGER NOT NULL DEFAULT 1,  -- how many lines fell with it
  actor        TEXT NOT NULL DEFAULT 'user',
  reason       TEXT NOT NULL DEFAULT '',
  batch_id     TEXT,
  created_at   INTEGER NOT NULL,
  restored_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trash_time  ON trash(created_at);
CREATE INDEX IF NOT EXISTS idx_trash_batch ON trash(batch_id);
`)

/* ---------------------------------------------------------------- */
/* Time slots: a task can occupy a slot                              */
/* ---------------------------------------------------------------- */
/* A slot stays an ordinary task, with its group, its state and its trash. No       */
/* parallel data model: a meeting that cannot be checked, moved or filed into a     */
/* group would be a foreign object in an agenda that knows how to do nothing else.  */
addCol('tasks', 'start_at', 'TEXT')                 // 'HH:MM' local, NULL = no time
addCol('tasks', 'duration_min', 'INTEGER')          // duration in minutes, NULL = unspecified
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_start ON tasks(day, start_at) WHERE start_at IS NOT NULL')

/* ---------------------------------------------------------------- */
/* Attachments: images, files and links                              */
/* ---------------------------------------------------------------- */
/* An attachment hangs either off a task or off a chat message. The binaries live    */
/* on disk (data/files/<hash>), deduplicated: pasting the same screenshot twice       */
/* stores only one file.                                                              */
/*                                                                                    */
/* `description` is what the vision model read in the image, written ONCE at upload.  */
/* It is what goes into the prompt: the agent's model cannot see, so it reads the     */
/* description instead of the image.                                                  */
db.exec(`
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  message_id  INTEGER,
  kind        TEXT NOT NULL DEFAULT 'file',  -- image | file | link
  url         TEXT,                          -- for a link
  path        TEXT,                          -- relative path inside data/files
  hash        TEXT,                          -- content fingerprint, for deduplication
  name        TEXT NOT NULL DEFAULT '',      -- original name of the file
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  width       INTEGER,
  height      INTEGER,
  title       TEXT NOT NULL DEFAULT '',      -- page title, for a link
  description TEXT NOT NULL DEFAULT '',      -- what vision read, or the meta description
  meta        TEXT NOT NULL DEFAULT '',      -- free JSON: favicon, og:image, model used
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_task ON attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_att_msg  ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_att_hash ON attachments(hash);
`)

/* ---------------------------------------------------------------- */
/* The active agent: gestures, interventions                         */
/* ---------------------------------------------------------------- */
/* `gestures` logs what the user does INSIDE THE INTERFACE, where `moves` only sees */
/* day or box changes: check, uncheck, delete, move to first position. That is the  */
/* raw material of the judge.                                                       */
/*                                                                                  */
/* `interventions` is the table of verdicts: every time the agent decides to speak   */
/* (on a gesture, during the night, in chat), a line says why (payload = the         */
/* quantified evidence), where (conversation, message) and what the user did with it */
/* (followed, ignored...). Without that measurement, there is no way to know whether */
/* the agent helps or nags.                                                          */
db.exec(`
CREATE TABLE IF NOT EXISTS gestures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,           -- check | uncheck | edit | delete | move | reorder | top | state | create
  task_id    INTEGER,
  payload    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gestures_time ON gestures(created_at);

CREATE TABLE IF NOT EXISTS interventions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,      -- correction | stasis | deletion | top | adversary | muda | ...
  task_id         INTEGER,
  rule_id         INTEGER,
  candidate_id    INTEGER,
  trigger         TEXT NOT NULL,      -- gesture | night | chat
  payload         TEXT NOT NULL DEFAULT '',
  conversation_id INTEGER,
  message_id      INTEGER,
  status          TEXT NOT NULL DEFAULT 'open',
                  -- thinking : budget reserved, LLM call under way
                  -- silent : the model preferred to say nothing
                  -- open : the message is posted, we wait for what follows
                  -- heard | followed | ignored : measured after 48 h
                  -- rejected : the user said no explicitly
  outcome         TEXT,
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_interv_task ON interventions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_interv_time ON interventions(created_at);
`)

/* ---------------------------------------------------------------- */
/* The rule engine: candidates and runs                              */
/* ---------------------------------------------------------------- */
/* A rule no longer goes straight into service: it is born a candidate (mined from  */
/* the user's corrections), is shadow-tested (replayed on their real gestures        */
/* without touching anything), is proposed with its evidence, and is only promoted   */
/* by a word from them. `dedup_key` is the memory of the refusal: a rejected         */
/* candidate will NEVER be proposed again, and that is what separates a useful engine */
/* from an engine that nags.                                                          */
/*                                                                                   */
/* `rule_runs` traces every pass of the engine and acts as a lock: one run per        */
/* window, never two concurrent cycles on the same candidates.                        */
db.exec(`
CREATE TABLE IF NOT EXISTS rule_candidates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,       -- weekday_group | group_route | freeze | pair | block
  scope          TEXT NOT NULL DEFAULT '',   -- normalized group_key
  param          TEXT NOT NULL DEFAULT '{}', -- JSON: { "weekday": 6 } ...
  text           TEXT NOT NULL,       -- the wording, ready for rules.text
  dedup_key      TEXT NOT NULL,       -- canonical kind|scope|param, the memory of the refusal
  source         TEXT NOT NULL DEFAULT 'miner',  -- miner | correction | llm | chat
  status         TEXT NOT NULL DEFAULT 'candidate',
                 -- candidate -> testing -> proposed -> active | dead
  score          REAL NOT NULL DEFAULT 0,
  support        INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0,
  sim            TEXT NOT NULL DEFAULT '',   -- JSON of the last shadow test
  rule_id        INTEGER,             -- rules.id once promoted
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cand_dedup ON rule_candidates(dedup_key);

CREATE TABLE IF NOT EXISTS rule_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_source TEXT NOT NULL,       -- night | burst | manual
  summary    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`)

/* The structured form of a rule, next to the historical free text. NULL = a text   */
/* rule parsed by the existing regexes (groupWeekdays), which remain the fallback:  */
/* no migration of the rules in place.                                              */
addCol('rules', 'kind', 'TEXT')
addCol('rules', 'scope', 'TEXT')
addCol('rules', 'param', 'TEXT')

/* A task can carry a prediction date, distinct from `day`: "I think I'll do it      */
/* Friday" is a hypothesis, not a commitment. The night never moves it; at the due    */
/* date, if nothing is done, the agent says "that prediction did not hold" instead of */
/* pushing silently. The failure becomes a calibration datum, not a guilt.            */
addCol('tasks', 'due_at', 'TEXT')              // YYYY-MM-DD, the predicted due date
addCol('tasks', 'due_kind', "TEXT DEFAULT 'prediction'")

/* Conditional escrow: next to waiting_on (who we are waiting for), the plain-language */
/* condition that will release the task on its own ("the client replied"). Compared by */
/* similarity against the learned facts and the messages: when the condition becomes   */
/* true in a conversation, the task comes back.                                         */
addCol('tasks', 'escrow_condition', 'TEXT')

/* The Google Calendar mirror (server/gcal.js). `source` is 'gcal' for an imported  */
/* appointment and NULL for everything else: the field isolates the mirror in a     */
/* single test, rather than recognizing an appointment by its text.                 */
/* `external_id` carries the identity of the occurrence at Google (event id plus its */
/* recurrence date), and that is what makes it possible to match instead of wiping   */
/* and recreating: without it, every sync would change the number of every           */
/* appointment and the screen would flicker.                                         */
addCol('tasks', 'source', 'TEXT')
addCol('tasks', 'external_id', 'TEXT')
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external ON tasks(external_id) WHERE external_id IS NOT NULL')

/* WHICH .ics source a mirror line comes from (short fingerprint of the URL, see
   gcal.js). Without it, one failing source erased the appointments of the other:
   the sync did not know who an absent line belonged to, so it believed Google had
   deleted it. This field is what allows deleting only the keys of the sources that
   answered. */
addCol('tasks', 'gcal_src', 'TEXT')

/* What the user THREW AWAY from the mirror, and that must not come back.            */
/* The link to Google is read-only: deleting an appointment here does not delete it  */
/* there, so the next sync put it back fifteen minutes later. A deletion that does   */
/* not hold is worse than a refused deletion: you think you have tidied up, and it   */
/* comes back without a word. The thrown-away key is therefore kept here, and the    */
/* mirror skips it.                                                                  */
db.exec(`
CREATE TABLE IF NOT EXISTS gcal_hidden (
  external_id TEXT PRIMARY KEY,
  content     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);`)

{
  const orphans = db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id IS NULL').get().n
  if (orphans > 0) {
    const t = Date.now()
    const id = db.prepare('INSERT INTO conversations (title, kind, created_at, modified_at) VALUES (?,?,?,?)')
      .run('Discussion', 'chat', t, t).lastInsertRowid
    db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id IS NULL').run(id)
  }
}

db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)')

/* The agent's old undo log: replaced by the shared history
   (server/history.js), which also covers the screen gestures. */
db.exec('DROP TABLE IF EXISTS undo_log')

/* The health of the machine, to make it VISIBLE.
 *
 * The day the agent's model is retired at the provider, the night and the rule
 * engine return a 410, written to a plain `console.error` that nobody reads,
 * while the crons send their output to /dev/null. The failure then exists only
 * in a log.
 *
 * This table carries the LAST known failure per kind (`night`, `model`,
 * `chat`). The screen shows it as a badge in the header, and the badge clears
 * itself on the first success: a badge that stays lit after a repair says
 * nothing any more. One row per kind, overwritten every time.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS health (
  kind       TEXT PRIMARY KEY,        -- night | model | chat
  ok         INTEGER NOT NULL DEFAULT 1,
  summary    TEXT NOT NULL DEFAULT '',
  at         INTEGER NOT NULL
);
`)

export const now = () => Date.now()

/** Local date as YYYY-MM-DD (never UTC: a move at 00:30 must stay on the right day). */
export function today (d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function addDays (isoDay, n) {
  const [y, m, d] = isoDay.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  return today(dt)
}

/** Monday of the week containing isoDay. */
export function weekStart (isoDay) {
  const [y, m, d] = isoDay.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const shift = (dt.getDay() + 6) % 7 // 0 = Monday
  return addDays(isoDay, -shift)
}

export function logJournal (kind, summary, detail = '') {
  db.prepare('INSERT INTO journal (kind, summary, detail, created_at) VALUES (?,?,?,?)')
    .run(kind, summary, detail, now())
}

/**
 * Records the health of a component (`night`, `model`, `chat`) and makes it VISIBLE.
 *
 * A single row per kind, overwritten: what matters is the last state, not the
 * history (the journal keeps the detail). A success clears the failure, otherwise
 * the badge would stay lit after a repair and say nothing any more.
 */
export function recordHealth (kind, ok, summary = '') {
  try {
    db.prepare('INSERT INTO health (kind, ok, summary, at) VALUES (?,?,?,?) ON CONFLICT(kind) DO UPDATE SET ok = excluded.ok, summary = excluded.summary, at = excluded.at')
      .run(kind, ok ? 1 : 0, String(summary).slice(0, 300), now())
  } catch (e) { console.error('health:', e.message) }
}

/** What is wrong, for the header. Empty when everything is fine. */
export function failures () {
  return db.prepare('SELECT kind, summary, at FROM health WHERE ok = 0 ORDER BY at DESC').all()
}
