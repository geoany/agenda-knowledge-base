import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, renameSync, existsSync
} from 'node:fs'
import { dirname, resolve, join, sep, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The file layer of the knowledge base.
 *
 * The source of truth is a FOLDER OF REAL MARKDOWN FILES, never the SQLite
 * database. This is the point that decides the whole architecture: an LLM knows
 * how to open a folder, read a .md and write one; it does not know how to query
 * a database it does not have at hand. The index (kb/index.js) is a VIEW that
 * can be rebuilt at any time from those files, and if the two ever diverge, the
 * disk is right.
 *
 * The relative path is the key of a note, not a numeric id. A path can be read,
 * guessed, quoted in a conversation and survives an index rebuild.
 */

const here = dirname(fileURLToPath(import.meta.url))
export const KB_ROOT = process.env.AGENDA_KB || resolve(process.env.AGENDA_DATA_DIR || resolve(here, '../../data'), 'kb')
mkdirSync(KB_ROOT, { recursive: true })

/*
 * The notes BUILT by the code, to be told apart from the ones the user writes:
 * the compass of each project (projects/<name>/compass.md, see projects.js).
 *
 * They are derived from the others, so they take part in nothing that is
 * computed ON the corpus: neither weaving (a derived note has no thesis of its
 * own), nor automatic recall, nor sorting. Every computation asks `isGenerated`.
 */
export const isGenerated = p => /^projects\/[^/]+\/compass\.md$/.test(p)

/**
 * The directory traversal lock.
 *
 * A write to the knowledge base may come from a model, hence from a path it
 * built itself out of a dictated sentence. Without this guard, a `../../.env`
 * or an absolute path would leave data/kb and overwrite a server file. We
 * resolve first, we compare to the real prefix AFTERWARDS: checking for the
 * presence of ".." in the string is not enough, a symbolic link or an exotic
 * encoding would slip through.
 */
export function resolvePath (rel) {
  const raw = String(rel ?? '').trim()
  if (!raw) throw new Error('empty path')
  if (raw.includes('\0')) throw new Error('invalid path')
  const abs = resolve(KB_ROOT, raw)
  if (abs !== KB_ROOT && !abs.startsWith(KB_ROOT + sep)) {
    throw new Error(`path outside the knowledge base: ${raw}`)
  }
  return abs
}

/** The relative path of a file, always with forward slashes, even on Windows. */
export const relativePath = abs => abs.slice(KB_ROOT.length + 1).split(sep).join('/')

/**
 * A file name readable by a machine AND by a human.
 *
 * Accents and spaces disappear from the PATH, never from the title: a path
 * without accents can be typed without error, quoted in a shell command and
 * compared without surprise, whereas the title keeps the full text in the
 * frontmatter. It is also what makes a link [[Actionable Summary]] resolvable
 * to actionable-summary.md.
 */
export function slug (s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'note'
}

/**
 * The path of a note, normalized: folders and name in slug, .md extension
 * imposed.
 *
 * A ".." segment is REFUSED and not silently cleaned. The difference matters:
 * cleaning would turn "../../secrets.md" into a note filed in an absurd folder,
 * which the model would believe it had written in the right place and would
 * never find again. An explicit error, on the other hand, tells it to fix its
 * path, and that is also what a human wants to read.
 */
export function notePath (rel) {
  const raw = String(rel ?? '').trim()
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error(`absolute path refused: ${raw}`)
  const parts = raw.split('/').filter(p => p && p !== '.')
  if (!parts.length) throw new Error('empty path')
  if (parts.some(p => p === '..')) throw new Error(`path outside the knowledge base: ${raw}`)
  const name = parts.pop().replace(/\.md$/i, '')
  return [...parts.map(slug), `${slug(name)}.md`].join('/')
}

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */
/*
 * A minimal hand-written YAML rather than a dependency.
 *
 * We only store six keys, all flat except `tags` which is a list of words. A
 * real YAML parser would bring anchors, multi-line blocks and typed dates, that
 * is, three more ways to make the reading of a note hand-written by a model
 * fail. What we do not understand is ignored, never an error: a malformed note
 * must stay readable.
 */

const KEYS = ['title', 'tags', 'created', 'updated', 'source']

/*
 * The fields that WEAVING writes, and that any rewrite must preserve.
 *
 * They are distinct from the five above because they do not come from the
 * caller but from the computation: `thesis`, `counter` and `use_for` say what
 * the note claims, `exception` says when it is false, `woven` dates the
 * passage.
 *
 * The write order follows the reading order: identify, then orient, then date
 * the work.
 */
const WEAVE_KEYS = ['thesis', 'counter', 'use_for', 'exception', 'woven']

function parseList (v) {
  const s = String(v || '').trim()
  if (!s) return []
  const inner = s.match(/^\[(.*)\]$/)
  return (inner ? inner[1] : s).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

export function parseFrontmatter (text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n')
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: src.replace(/^\uFEFF/, '') }

  const meta = {}
  let currentList = null
  for (const line of m[1].split('\n')) {
    // A YAML list on several lines: "tags:" then "- business".
    const bullet = line.match(/^\s*-\s+(.*)$/)
    if (bullet && currentList) { meta[currentList].push(bullet[1].trim().replace(/^["']|["']$/g, '')); continue }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const [, key, val] = kv
    if (key === 'tags') {
      meta.tags = parseList(val)
      currentList = val.trim() ? null : 'tags'
      continue
    }
    currentList = null
    meta[key] = val.trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: src.slice(m[0].length) }
}

/** A value containing a colon would break re-reading: we quote it. */
const quote = v => (/[:#\n]/.test(String(v)) ? `"${String(v).replace(/"/g, "'")}"` : String(v))

export function serializeFrontmatter (meta) {
  const lines = []
  for (const key of [...KEYS, ...WEAVE_KEYS]) {
    const v = meta[key]
    if (v == null || v === '') continue
    if (key === 'tags') {
      if (!v.length) continue
      lines.push(`tags: [${v.map(t => quote(t)).join(', ')}]`)
      continue
    }
    lines.push(`${key}: ${quote(v)}`)
  }
  return `---\n${lines.join('\n')}\n---\n`
}

const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** Every .md of the base, with relative path, modification date and size. */
export function listNotes (subfolder = '') {
  const start = subfolder ? resolvePath(subfolder) : KB_ROOT
  const out = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      // Technical folders are not knowledge: indexing them would fill the graph
      // with noise nobody will ever read.
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      if (extname(e.name).toLowerCase() !== '.md') continue
      const st = statSync(abs)
      out.push({ path: relativePath(abs), mtime: Math.floor(st.mtimeMs), size: st.size })
    }
  }
  walk(start)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export const noteExists = rel => { try { return existsSync(resolvePath(rel)) } catch { return false } }

/** A complete note, as it is ON DISK. Nothing goes through the index. */
export function readNote (rel) {
  const abs = resolvePath(rel)
  if (!existsSync(abs) || !statSync(abs).isFile()) return null
  const raw = readFileSync(abs, 'utf8')
  const { meta, body } = parseFrontmatter(raw)
  const st = statSync(abs)
  const path = relativePath(abs)
  return {
    path,
    // A note without a title still keeps a readable name: the file name.
    // Without that, the graph would show empty, unreadable nodes.
    title: meta.title || basename(path, '.md').replace(/-/g, ' '),
    tags: Array.isArray(meta.tags) ? meta.tags : parseList(meta.tags),
    created: meta.created || '',
    updated: meta.updated || '',
    source: meta.source || '',
    // The three fields set by weaving (server/kb/weaving.js): what the note
    // claims, the ordinary reflex it contradicts, and when to open it. They are
    // what lets an LLM choose what to read without having to read.
    thesis: meta.thesis || '',
    counter: meta.counter || '',
    use_for: meta.use_for || '',
    // The case where the note is FALSE. A rule that carries its own flaw can no
    // longer be applied mechanically: whoever reads it must first check that
    // they are not in the exception, hence look at the real situation.
    exception: meta.exception || '',
    woven: meta.woven || '',
    body,
    raw,
    mtime: Math.floor(st.mtimeMs),
    size: st.size
  }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Writes a note, keeping its birth date.
 *
 * `created` is read back from the existing file before writing: a rewrite by a
 * model must not make a two-year-old note young again, otherwise every sort by
 * age becomes wrong at the agent's first pass.
 */
export function writeNote (rel, { title, body = '', tags, source, created, thesis, counter, use_for, exception } = {}) {
  const path = notePath(rel)
  const abs = resolvePath(path)
  const previous = existsSync(abs) ? readNote(path) : null
  const meta = {
    title: title ?? previous?.title ?? basename(path, '.md').replace(/-/g, ' '),
    tags: tags ?? previous?.tags ?? [],
    // `created` is only accepted at birth, and never on a note that already
    // exists: it is what lets an import give a vault note back its real date,
    // without a rewrite being able to falsify it afterwards.
    created: previous?.created || created || nowStamp(),
    updated: nowStamp(),
    source: source ?? previous?.source ?? '',
    /*
     * The weaving fields SURVIVE the rewrite, and that is the whole point of
     * these five lines.
     *
     * They used to go up in smoke at every kb_write: `serializeFrontmatter` only
     * knew the five keys above, so rewriting a note made it lose its
     * orientation. The model reading it back then found it mute, and the note
     * disappeared from routing. The damage was invisible, nobody re-reads a note
     * every day.
     *
     * A caller can SET them by passing them (a new note used to be born without
     * `thesis`, which made it mute from birth), otherwise we carry over the ones
     * from the previous version. `woven` follows the same rule: a rewrite must
     * not make a weave older than it young again.
     */
    thesis: thesis ?? previous?.thesis ?? '',
    counter: counter ?? previous?.counter ?? '',
    use_for: use_for ?? previous?.use_for ?? '',
    exception: exception ?? previous?.exception ?? '',
    woven: previous?.woven || ''
  }
  mkdirSync(dirname(abs), { recursive: true })
  const text = String(body ?? '')
  writeFileSync(abs, serializeFrontmatter(meta) + (text.startsWith('\n') ? text : `\n${text}`), 'utf8')
  return readNote(path)
}

/** Moves or renames a note. Missing folders are created along the way. */
export function moveNote (from, to) {
  const src = resolvePath(from)
  const target = notePath(to)
  const dst = resolvePath(target)
  if (!existsSync(src)) return null
  if (existsSync(dst)) throw new Error(`"${target}" already exists`)
  mkdirSync(dirname(dst), { recursive: true })
  renameSync(src, dst)
  return readNote(target)
}

export function deleteNote (rel) {
  const abs = resolvePath(rel)
  if (!existsSync(abs)) return false
  rmSync(abs)
  return true
}

export function createFolder (rel) {
  const abs = resolvePath(String(rel).split('/').filter(Boolean).map(slug).join('/'))
  mkdirSync(abs, { recursive: true })
  return relativePath(abs)
}

/* ------------------------------------------------------------------ */
/* Tree                                                                */
/* ------------------------------------------------------------------ */

/**
 * The full tree, folders nested.
 *
 * It is built from the flat list of notes rather than by re-reading the disk a
 * second time: a folder with no note has nothing to show, and displaying it
 * would give a column of empty branches.
 */
export function buildTree (notes = listNotes()) {
  const root = { name: '', path: '', folders: [], notes: [] }
  const index = new Map([['', root]])
  const folderFor = path => {
    if (index.has(path)) return index.get(path)
    const cut = path.lastIndexOf('/')
    const parent = folderFor(cut < 0 ? '' : path.slice(0, cut))
    const node = { name: path.slice(cut + 1), path, folders: [], notes: [] }
    parent.folders.push(node)
    index.set(path, node)
    return node
  }
  for (const n of notes) {
    const cut = n.path.lastIndexOf('/')
    folderFor(cut < 0 ? '' : n.path.slice(0, cut)).notes.push(n)
  }
  const sort = d => {
    d.folders.sort((a, b) => a.name.localeCompare(b.name))
    d.notes.sort((a, b) => a.path.localeCompare(b.path))
    d.folders.forEach(sort)
    return d
  }
  return sort(root)
}

/* ------------------------------------------------------------------ */
/* The links of a note                                                 */
/* ------------------------------------------------------------------ */

/**
 * The outgoing links of a text: the [[wiki]] ones and the http addresses.
 *
 * The wiki format accepts three forms that Obsidian really produces: [[note]],
 * [[folder/note|label]] and [[note#section]]. We keep the RAW target here,
 * without trying to figure out which file it matches: resolution needs to know
 * every note, so it belongs to the index. Links inside a code block are
 * discarded, otherwise a syntax example would become an edge of the graph.
 */
export function extractLinks (text) {
  const clean = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
  const wiki = []
  const seen = new Set()
  for (const m of clean.matchAll(/\[\[([^\][|#]+)(?:#[^\][|]*)?(?:\|([^\][]*))?\]\]/g)) {
    const target = m[1].trim()
    if (!target || seen.has(target.toLowerCase())) continue
    seen.add(target.toLowerCase())
    wiki.push({ raw: target, label: (m[2] || '').trim() })
  }
  const http = []
  const seenUrls = new Set()
  for (const m of clean.matchAll(/https?:\/\/[^\s<>)"'\]]+/g)) {
    const url = m[0].replace(/[.,;:]+$/, '')
    if (seenUrls.has(url)) continue
    seenUrls.add(url)
    http.push(url)
  }
  return { wiki, http }
}
