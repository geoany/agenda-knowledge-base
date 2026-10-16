import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listNotes, readNote, extractLinks, slug } from './store.js'

/**
 * The index of the knowledge base: a VIEW, never the source of truth.
 *
 * Three things justify having a database here, when files are enough for
 * everything else: full-text search (FTS5, which no folder walk replaces), the
 * link graph (which requires crossing all the notes), and the list of notes
 * without re-reading five hundred files at every display.
 *
 * It has ITS OWN database, data/kb.db, and not the one of the tasks. The
 * knowledge base is a separate brick: we must be able to delete it, rebuild it
 * or copy it elsewhere without ever getting near the database that holds the
 * calendar.
 *
 * `rebuildIndex()` erases everything and starts again from the files. It is the
 * way out of any disagreement: the disk is always right, and nothing that lives
 * here exists anywhere else than in a .md.
 */

const here = dirname(fileURLToPath(import.meta.url))
export const KB_DB_PATH = process.env.AGENDA_KB_DB || resolve(process.env.AGENDA_DATA_DIR || resolve(here, '../../data'), 'kb.db')
mkdirSync(dirname(KB_DB_PATH), { recursive: true })

export const kb = new Database(KB_DB_PATH)
kb.pragma('journal_mode = WAL')

kb.exec(`
CREATE TABLE IF NOT EXISTS kb_notes (
  path     TEXT PRIMARY KEY,      -- relative path in data/kb, the key of the note
  title    TEXT NOT NULL DEFAULT '',
  folder   TEXT NOT NULL DEFAULT '',  -- first-level folder, serves as the graph community
  tags     TEXT NOT NULL DEFAULT '',  -- comma-separated, enough to filter
  source   TEXT NOT NULL DEFAULT '',
  created  TEXT NOT NULL DEFAULT '',
  updated  TEXT NOT NULL DEFAULT '',
  mtime    INTEGER NOT NULL DEFAULT 0,
  size     INTEGER NOT NULL DEFAULT 0,
  body     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_kb_folder ON kb_notes(folder);


-- An outgoing link. The target column stays NULL as long as the aimed note does
-- not exist: a broken link is information, not an error, and it must be visible.
CREATE TABLE IF NOT EXISTS kb_links (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  src    TEXT NOT NULL,
  raw    TEXT NOT NULL DEFAULT '',   -- what was written between the brackets
  target TEXT,                       -- the resolved path, NULL if the link points nowhere
  kind   TEXT NOT NULL DEFAULT 'wiki' -- wiki | http
);
CREATE INDEX IF NOT EXISTS idx_kb_links_src    ON kb_links(src);
CREATE INDEX IF NOT EXISTS idx_kb_links_target ON kb_links(target);
`)

/*
 * FTS5 with `remove_diacritics 2`: without it, a search typed without accents
 * does not find notes written with them, which is exactly what the user types
 * when dictating or typing fast. Mode 2 is the only one that handles composed
 * characters correctly. The table is self-contained (it carries its own text)
 * rather than attached to the content of kb_notes: it rebuilds in one command
 * and cannot silently desynchronize an external table.
 */
kb.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  path UNINDEXED, title, body,
  tokenize = "unicode61 remove_diacritics 2"
);
`)

/*
 * The three weaving columns, added after the fact on a database that already
 * existed. Same pattern as the rest of the project: we attempt the addition, a
 * column already present throws and the error is harmless. They carry what an
 * LLM reads BEFORE deciding to open a note (see server/kb/weaving.js).
 */
for (const col of ['thesis TEXT NOT NULL DEFAULT \'\'', 'counter TEXT NOT NULL DEFAULT \'\'', 'use_for TEXT NOT NULL DEFAULT \'\'']) {
  try { kb.exec(`ALTER TABLE kb_notes ADD COLUMN ${col}`) } catch {}
}

const folderOf = path => (path.includes('/') ? path.split('/')[0] : '')

/* ------------------------------------------------------------------ */
/* Indexing                                                            */
/* ------------------------------------------------------------------ */

const forget = kb.transaction(path => {
  kb.prepare('DELETE FROM kb_notes WHERE path = ?').run(path)
  kb.prepare('DELETE FROM kb_fts   WHERE path = ?').run(path)
  kb.prepare('DELETE FROM kb_links WHERE src  = ?').run(path)
})

const put = kb.transaction((n) => {
  kb.prepare(`INSERT INTO kb_notes (path, title, folder, tags, source, created, updated, mtime, size, body, thesis, counter, use_for)
              VALUES (@path, @title, @folder, @tags, @source, @created, @updated, @mtime, @size, @body, @thesis, @counter, @use_for)`)
    .run({
      path: n.path,
      title: n.title,
      folder: folderOf(n.path),
      tags: n.tags.join(', '),
      source: n.source,
      created: n.created,
      updated: n.updated,
      mtime: n.mtime,
      size: n.size,
      body: n.body,
      thesis: n.thesis || '',
      counter: n.counter || '',
      use_for: n.use_for || ''
    })
  kb.prepare('INSERT INTO kb_fts (path, title, body) VALUES (?,?,?)').run(n.path, n.title, n.body)

  const { wiki, http } = extractLinks(n.body)
  const ins = kb.prepare('INSERT INTO kb_links (src, raw, target, kind) VALUES (?,?,?,?)')
  for (const l of wiki) ins.run(n.path, l.raw, null, 'wiki')
  for (const url of http) ins.run(n.path, url, null, 'http')
})

/** Indexes (or reindexes) a single note from the disk. */
export function indexNote (path) {
  const n = readNote(path)
  forget(path)
  if (!n) return null
  put(n)
  resolveLinks()
  return n
}

/**
 * The resolution of the [[wiki]] links, done AFTER everyone has been indexed.
 *
 * A link cannot be resolved at the moment the note carrying it is read: the
 * aimed note may not have gone through the index yet. So we do a separate pass
 * over the whole set.
 *
 * Three ways to aim at the same note, in this order: the full path, the file
 * name, then the title. It is indispensable here because the vault import puts
 * the paths in slug while links written by hand quote the full title: without
 * the third pass, [[Actionable Summary]] would never find
 * projects/example/actionable-summary.md and the graph would have almost no
 * edges.
 */
export function resolveLinks () {
  const notes = kb.prepare('SELECT path, title FROM kb_notes').all()
  const byPath = new Map()
  const byName = new Map()
  const byTitle = new Map()
  for (const n of notes) {
    byPath.set(slug(n.path.replace(/\.md$/, '').replace(/\//g, ' ')), n.path)
    const name = slug(basename(n.path, '.md'))
    // An ambiguous file name (two "readme") must designate nobody: linking at
    // random would build a false edge that nothing signals.
    byName.set(name, byName.has(name) ? null : n.path)
    const t = slug(n.title)
    byTitle.set(t, byTitle.has(t) ? null : n.path)
  }
  const targetOf = raw => {
    const bare = String(raw).replace(/\.md$/i, '')
    const pathSlug = slug(bare.replace(/\//g, ' '))
    if (byPath.has(pathSlug)) return byPath.get(pathSlug)
    const last = slug(bare.split('/').pop())
    return byName.get(last) || byTitle.get(last) || null
  }
  const update = kb.prepare('UPDATE kb_links SET target = ? WHERE id = ?')
  kb.transaction(() => {
    for (const l of kb.prepare("SELECT id, raw FROM kb_links WHERE kind = 'wiki'").all()) {
      update.run(targetOf(l.raw), l.id)
    }
  })()
}

/**
 * Incremental reindexing: we only re-read what has moved.
 *
 * The comparison covers the modification date AND the size. The date alone is
 * not enough when a file is rewritten in the same millisecond by an import
 * script, which really happens on an import of two hundred notes.
 */
export function reindex () {
  const onDisk = listNotes()
  const known = new Map(kb.prepare('SELECT path, mtime, size FROM kb_notes').all().map(r => [r.path, r]))
  let added = 0
  let modified = 0
  let deleted = 0

  for (const f of onDisk) {
    const c = known.get(f.path)
    known.delete(f.path)
    if (c && c.mtime === f.mtime && c.size === f.size) continue
    const n = readNote(f.path)
    if (!n) continue
    forget(f.path)
    put(n)
    if (c) modified++; else added++
  }
  // What remains in `known` is no longer on disk: the note was deleted or moved
  // by hand, the index must follow without being asked.
  for (const path of known.keys()) { forget(path); deleted++ }

  if (added || modified || deleted) resolveLinks()
  return { total: onDisk.length, added, modified, deleted }
}

/** Erases the index and rebuilds it entirely from the files. */
export function rebuildIndex () {
  kb.exec('DELETE FROM kb_notes; DELETE FROM kb_fts; DELETE FROM kb_links;')
  const r = reindex()
  return { ...r, added: r.total, modified: 0, deleted: 0 }
}

/* ------------------------------------------------------------------ */
/* Reading the index                                                   */
/* ------------------------------------------------------------------ */

export const countNotes = () => kb.prepare('SELECT COUNT(*) n FROM kb_notes').get().n

export const listIndex = () => kb.prepare(
  'SELECT path, title, folder, tags, updated, size FROM kb_notes ORDER BY path'
).all()

/**
 * The words a question carries without saying anything about the subject.
 *
 * They are dropped from the query for two reasons that multiply. In AND they
 * are present in almost every note, so they filter nothing and make the query
 * longer; in OR they bring back every note that contains them, which drowns the
 * result. "how", "is", "in", "for" never designate a document.
 */
const STOP_WORDS = new Set(`comment pourquoi quand quel quelle quels quelles est sont etait etaient
dans pour avec sans sur sous vers chez entre les des une uns mon ma mes ton ta tes son sa ses
notre nos votre vos leur leurs que qui quoi dont donc alors aussi plus moins tres bien tout
tous toute toutes faire fait faut peux peut dois doit veux veut suis cela ceci cet cette
lui elle ils elles nous vous moi toi mais ou car afin ainsi deja encore meme seulement
the a an and or of to in on for with without at by from is are was were be been being do does
did this that these those it its his her their our your my me you we they he she them him us
what which who whom when where why how not no but if then than as so too very can could should
would will shall may might must have has had here there about into over under between`.split(/\s+/))

/**
 * The folders that are NOT candidates for search and routing
 * (KB_EXCLUDED_DIRS, comma-separated prefixes).
 *
 * The intended use: a folder of raw transcriptions (podcasts, videos), which can
 * weigh more than a third of the corpus. They are RAW MATERIAL, not digested
 * knowledge: the knowledge has already been extracted from them into the other
 * notes. Keeping them among the candidates has two measured costs: the search
 * brings up a transcription when the question is about a working rule, and the
 * router dilutes itself in that material.
 *
 * They stay on disk, readable by `kb_read` and visible in the tree: we change
 * what is SEARCHED, never what is KEPT. An answer that relies on a precise
 * source remains possible, it just requires opening it by its path.
 *
 * The list is here, in a single place: copied into each caller, it would end up
 * diverging at the first omission.
 */
const EXCLUDED_DIRS = (process.env.KB_EXCLUDED_DIRS ?? 'knowledge/sources/')
  .split(',').map(s => s.trim()).filter(Boolean).map(p => (p.endsWith('/') ? p : `${p}/`))
const excludedLike = EXCLUDED_DIRS.map(p => `${p.replace(/[\\%_]/g, c => `\\${c}`)}%`)
const excludedSql = col => excludedLike.map(() => `AND ${col} NOT LIKE ? ESCAPE '\\'`).join(' ')

export const isCandidate = path =>
  !EXCLUDED_DIRS.some(prefix => String(path).startsWith(prefix))

/**
 * An FTS5 query built from a human sentence.
 *
 * The text comes from a search field or from a model, so with apostrophes,
 * quotes and sometimes a misplaced OR: passed as is to MATCH, it raises a SQLite
 * syntax error instead of a result. So we split into words and quote them one by
 * one.
 *
 * **The words are joined by OR, never by a space.** A space, in FTS5, means an
 * AND: a ten-word question searches for a note that contains all ten. Measured
 * on real questions: two words absent from the corpus were enough to bring the
 * result down to ZERO in more than half the cases, when the relevant note
 * existed. The OR brings back every note carrying at least one word of the
 * question, and it is the BM25 ranking that puts the best ones back at the top.
 *
 * Each word gets its star (prefix): the search must start from the first letters
 * typed, otherwise "negoci" does not find "negociation".
 */
function ftsQuery (q) {
  const raw = String(q ?? '').split(/[^\p{L}\p{N}_]+/u).filter(m => m.length > 1)
  if (!raw.length) return null
  const meaningful = raw.filter(m => !STOP_WORDS.has(m.toLowerCase()))
  // A question made only of stop words ("how is it that") keeps its words rather
  // than returning an empty query: a broad result is better than no result.
  const words = meaningful.length ? meaningful : raw
  return words.map(m => `"${m}"*`).join(' OR ')
}

/**
 * Full-text search. It returns EXCERPTS with their path.
 *
 * The excerpt is what matters: a model that receives a list of paths has to open
 * each note to know which one to read, that is six tool calls instead of one.
 * With the excerpt, it decides at the first try.
 */
export function search (q, { limit = 12, folder = null, all = false } = {}) {
  const match = ftsQuery(q)
  if (!match) return []
  /*
   * The raw-material filter, unless explicitly requested (`all: true`). It
   * applies ALSO to search, not only to the router: it is the same default, a
   * transcription coming out instead of a knowledge note.
   */
  const excludedSources = all ? '' : excludedSql('n.path')
  const excluded = all ? [] : excludedLike
  const folderFilter = folder ? 'AND n.folder = ?' : ''
  const args = folder ? [match, folder, ...excluded, limit] : [match, ...excluded, limit]
  try {
    return kb.prepare(`
      SELECT f.path, n.title, n.folder, n.tags, n.thesis, n.use_for,
             snippet(kb_fts, 2, '', '', ' … ', 14) AS excerpt,
             bm25(kb_fts, 6.0, 1.0) AS score
      FROM kb_fts f JOIN kb_notes n ON n.path = f.path
      WHERE kb_fts MATCH ? ${folderFilter} ${excludedSources}
      ORDER BY score LIMIT ?`).all(...args)
  } catch {
    // A refused FTS syntax must not break the call: we fall back to a LIKE, less
    // good but always answering something.
    const like = `%${String(q).trim()}%`
    return kb.prepare(`
      SELECT path, title, folder, tags, thesis, use_for, substr(body, 1, 160) AS excerpt, 0 AS score
      FROM kb_notes WHERE (body LIKE ? OR title LIKE ?) ${all ? '' : excludedSql('path')}
      ORDER BY path LIMIT ?`)
      .all(like, like, ...(all ? [] : excludedLike), limit)
  }
}

/** The outgoing and incoming links of a note. */
export function linksOf (path) {
  return {
    outgoing: kb.prepare("SELECT raw, target, kind FROM kb_links WHERE src = ? ORDER BY kind, raw").all(path),
    incoming: kb.prepare(`
      SELECT l.src AS path, n.title FROM kb_links l LEFT JOIN kb_notes n ON n.path = l.src
      WHERE l.target = ? ORDER BY l.src`).all(path)
  }
}

/** Reindexing at startup, silent if nothing has moved. */
export function startIndex () {
  const r = reindex()
  if (r.added || r.modified || r.deleted) {
    console.log(`kb: ${r.total} note(s), ${r.added} added, ${r.modified} modified, ${r.deleted} gone`)
  }
  return r
}
