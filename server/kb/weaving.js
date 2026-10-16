import { readFileSync, writeFileSync } from 'node:fs'
import { readNote, listNotes, resolvePath, isGenerated } from './store.js'
import { ask } from '../agent/llm.js'

/**
 * Weaving: what turns a pile of notes into a base where an LLM arrives cold,
 * reads four notes, and knows how to think like the user.
 *
 * The problem we solve is NOT storage, nor the size of the context. A model has
 * a million tokens of context and never uses them: what it lacks is knowing
 * where it is and what to open. Left to itself it converges towards the most
 * average answer possible, because it talks to billions of people at once. A
 * useful knowledge base is therefore the one that makes it DEVIATE from that
 * average, fast.
 *
 * Three things are engraved into each note for that, and the order matters:
 *
 *   - `thesis`: the sharp assertion of the note, in one sentence. What the
 *     document claims, not what it is about.
 *   - `counter`: the banal reflex this thesis contradicts. It is THE field that
 *     breaks convergence: a model that reads "the consensus says X, this note
 *     says not-X" can no longer answer X without knowing it.
 *   - `use_for`: when to open this note. An LLM decides to read or to skip
 *     without having to read, which is the whole difference between four notes
 *     read and twenty minutes of digging.
 *
 * And between the notes, QUALIFIED links: a link carries its reason, so it is
 * followed or ignored without opening the target.
 *
 * 90% of the work is deterministic (the neighbourhood is computed in TF-IDF,
 * with no model call and no dependency), 10% is the model (it writes the three
 * sentences and picks the links worth the trouble among the candidates).
 */

/* ------------------------------------------------------------------ */
/* 1. The neighbourhood, in pure TF-IDF                                */
/* ------------------------------------------------------------------ */

/* The words too frequent to distinguish two notes. A short list is enough: the
   IDF already removes everything that appears everywhere, the stopwords are only
   there to avoid wasting vocabulary. The French entries are kept: the base still
   accepts French notes and sentences, and they cost nothing here. */
const STOPWORDS = new Set(`alors aussi autre autres avec avoir bien cela celle celles ceux chaque chose comme
comment dans deja depuis donc dont elle elles encore entre etre faire fait faut ils jamais leur leurs
mais meme mieux moins nous parce pas peut peuvent plus pour pourquoi quand que quel quelle quelque
qui sans ses seul seulement soit sont sous sur tous tout toute toutes tres trop vers votre vous
etait etaient sera seront ete avait avaient aura auront cette ceci cet ainsi afin apres avant
the and for you your with that this from have will not are was but they what when who how
tu te ton ta tes il elle on je me ma mon mes nos notre lui eux y en un une des les del la le`
  .split(/\s+/).filter(Boolean))

/* Without accents, without punctuation, words of 4 letters and more. Short words
   rarely carry the topic and bloat the vocabulary for nothing. */
function wordsOf (text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(m => m.length >= 4 && m.length <= 24 && !STOPWORDS.has(m) && !/^\d+$/.test(m))
}

/**
 * The vector of a note: its most discriminating terms, weighted.
 *
 * The title counts THREE times. A note is rarely called by chance, and without
 * that weight two notes on the same topic, with explicit titles, only come
 * closer through the body of the text, where everybody talks about money and
 * business.
 */
function vectors (notes) {
  const df = new Map()
  const bags = notes.map(n => {
    const words = [...wordsOf(n.title), ...wordsOf(n.title), ...wordsOf(n.title), ...wordsOf(n.body)]
    const tf = new Map()
    for (const m of words) tf.set(m, (tf.get(m) || 0) + 1)
    for (const m of tf.keys()) df.set(m, (df.get(m) || 0) + 1)
    return tf
  })

  const N = notes.length
  return bags.map(tf => {
    const v = new Map()
    let norm = 0
    for (const [m, f] of tf) {
      const d = df.get(m) || 1
      // A term present in more than half of the corpus distinguishes nothing
      // here: all these notes talk about business, "client" brings nobody closer.
      if (d > N * 0.5) continue
      const p = (1 + Math.log(f)) * Math.log(1 + N / d)
      v.set(m, p)
      norm += p * p
    }
    norm = Math.sqrt(norm) || 1
    for (const [m, p] of v) v.set(m, p / norm)
    return v
  })
}

const cosine = (a, b) => {
  // We walk the smaller of the two: the cost is that of the shortest sparse
  // vector, not that of the vocabulary.
  const [small, big] = a.size < b.size ? [a, b] : [b, a]
  let s = 0
  for (const [m, x] of small) { const y = big.get(m); if (y) s += x * y }
  return s
}

/* All the other notes ranked by closeness to the i-th one, with no threshold. */
function rank (vs, notes, i) {
  const out = []
  for (let j = 0; j < notes.length; j++) {
    if (i === j) continue
    out.push({ path: notes[j].path, title: notes[j].title, score: cosine(vs[i], vs[j]) })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * The neighbours of each note, by decreasing similarity.
 * Returned raw, with no threshold: the caller cuts, and the model decides.
 */
export function neighborhood ({ k = 8, threshold = 0.06 } = {}) {
  const notes = listNotes()
    .map(f => readNote(f.path))
    .filter(n => n && !isGenerated(n.path))

  const vs = vectors(notes)
  const out = new Map()
  for (let i = 0; i < notes.length; i++) {
    const near = []
    for (let j = 0; j < notes.length; j++) {
      if (i === j) continue
      const s = cosine(vs[i], vs[j])
      if (s >= threshold) near.push({ path: notes[j].path, title: notes[j].title, score: s })
    }
    near.sort((a, b) => b.score - a.score)
    // An isolated note has NO candidate above the threshold, and it is precisely
    // the one that needs hooking up: we give it its best neighbours even weak
    // ones, even if the model rejects them all. A hard threshold would leave the
    // seven notes that need it most orphaned forever.
    const kept = near.length >= 4 ? near : rank(vs, notes, i).slice(0, 4)
    out.set(notes[i].path, kept.slice(0, k))
  }
  return { notes, neighbors: out }
}

/* ------------------------------------------------------------------ */
/* 2. Qualification, one model call per note                           */
/* ------------------------------------------------------------------ */

const SYSTEM = `You prepare a knowledge base so that another model, arriving cold, immediately knows what to do with it.

That model has a known flaw: left to itself, it answers the most average thing possible, the one everybody already knows. Your job is to give it what it takes to get out of that. So you write what this note CLAIMS, and above all which banal reflex it goes against.

You answer ONLY with a JSON object, with no text around it, no code block, with exactly these keys:

{
  "thesis": "the central claim of the note, one sentence, sharp, in the affirmative form. Not 'the note talks about X' but 'X works, Y does not work, and here is why'.",
  "counter": "the ordinary reflex, the received idea, the generic advice that this note contradicts. One sentence. State the consensus first, then what the note opposes to it.",
  "use_for": "when to open this note. One sentence that starts with a verb in the infinitive, and that describes a concrete work situation.",
  "exception": "the case where this note is FALSE. One sentence describing the concrete situation in which applying its thesis would be a mistake. You do not invent it: either the note says so, or its thesis has an obvious limit that someone in the trade would see. Empty string if the thesis really holds everywhere.",
  "keywords": [ "4 to 8 words or acronyms by which someone NAMES this topic while talking. Not the words of the title, not vague synonyms: the terms really used when the question comes up ('pricing', 'ICP', 'warranty', 'objection', 'churn'). One word per entry, singular, without article." ],
  "links": [ { "path": "exact path of a candidate note", "why": "what reading the two together teaches, and that neither one says alone. A short sentence." } ]
}

Firm rules:
- Write in the language of the note, with proper accents. No informal address, no politeness formulas.
- Never an em dash, neither "—" nor "–". Commas, periods, parentheses.
- Between 2 and 5 links, chosen from the candidates provided and THOSE ONLY, copying the path exactly. Zero links is allowed if no candidate holds.
- A link is never justified by "both talk about business". If that is what has to be written, there is no link.
- You invent nothing that is not in the note.`

function parseJson (text) {
  const t = String(text || '').trim()
  // An open model willingly wraps its JSON in a code block, or precedes it with
  // a sentence. We take the first complete object and ignore the rest.
  const withoutFence = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(withoutFence.slice(start, end + 1)) } catch { return null }
}

const stripEmDash = s => String(s || '').replace(/[—–]/g, ',').replace(/\s*,\s*,/g, ',').trim()

/** Qualifies ONE note: its three sentences and its qualified outgoing links. */
export async function qualify (note, candidates) {
  const list = candidates.map(c => {
    const n = readNote(c.path)
    const preview = (n?.body || '').replace(/\s+/g, ' ').trim().slice(0, 220)
    return `- ${c.path}: "${c.title}", ${preview}`
  }).join('\n')

  const prompt = [
    `NOTE TO QUALIFY: ${note.path}`,
    `Title: ${note.title}`,
    '',
    'Full content:',
    note.body,
    '',
    'CANDIDATE NOTES for the links (you may only choose from this list):',
    list || '(none)',
    '',
    'Return the JSON.'
  ].join('\n')

  const r = await ask(prompt, { system: SYSTEM, temperature: 0.3 })
  const o = parseJson(r)
  if (!o) return null

  const known = new Set(candidates.map(c => c.path))
  return {
    // The keywords become the TAGS of the note, and tags are strong triggers for
    // automatic recall (server/kb/triggers.js). That is what lets recall follow
    // the base without anyone setting a word by hand: a new note arrives with
    // its own handles.
    keywords: (Array.isArray(o.keywords) ? o.keywords : [])
      .map(t => String(t).trim().toLowerCase().replace(/^[«"']|[»"',.]$/g, '').trim())
      .filter(t => t && t.length >= 3 && t.length <= 28 && !/\s{2,}/.test(t))
      .slice(0, 8),
    thesis: stripEmDash(o.thesis).slice(0, 400),
    counter: stripEmDash(o.counter).slice(0, 400),
    use_for: stripEmDash(o.use_for).slice(0, 400),
    // The case where the note is false. Optional by construction: forcing an
    // exception on a thesis that has none would produce an invented sentence,
    // which is exactly the opposite of what we want.
    exception: stripEmDash(o.exception).slice(0, 400),
    links: (Array.isArray(o.links) ? o.links : [])
      // An invented path would be a dead link engraved into a file: we keep only
      // what was in the list we provided ourselves.
      .filter(l => l && known.has(String(l.path || '').trim()))
      .slice(0, 5)
      .map(l => ({ path: String(l.path).trim(), why: stripEmDash(l.why).slice(0, 240) }))
  }
}

/* ------------------------------------------------------------------ */
/* 3. Engraving into the file                                          */
/* ------------------------------------------------------------------ */

const OPEN = '<!-- woven -->'
const CLOSE = '<!-- /woven -->'

/**
 * Writes the three sentences into the frontmatter and the "See also" block at
 * the end of the note, between two markers.
 *
 * The block is DELIMITED and replaced entirely at each pass: a weave is
 * therefore never cumulative, it can be re-run every day without the note
 * swelling. Everything outside the markers belongs to the user and is never
 * touched.
 *
 * The write goes through the disk directly rather than through `writeNote`, for
 * one precise reason: that function reserialises the frontmatter from a fixed
 * list of keys, and would lose any key it does not know.
 */
export function writeWeave (note, q, { titleOf }) {
  const path = resolvePath(note.path)
  const raw = readFileSync(path, 'utf8')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  const head = m ? m[1] : ''
  const body = m ? raw.slice(m[0].length) : raw

  // We rewrite the three keys in place if they already exist, we add them
  // otherwise: the order of the other frontmatter keys is preserved as is.
  const lines = head.split('\n').filter(l => !/^(thesis|counter|use_for|exception|woven)\s*:/.test(l))
  /* The keywords merge with the tags already set, they do not replace them: a
     tag written by hand by the user is a choice, and an automatic pass has no
     business erasing it. */
  if (q.keywords?.length) {
    const i = lines.findIndex(l => /^tags\s*:/.test(l))
    const old = i >= 0
      ? (lines[i].match(/\[(.*)\]/)?.[1] || lines[i].replace(/^tags\s*:/, ''))
        .split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : []
    const merged = [...new Set([...old, ...q.keywords])].slice(0, 12)
    const line = `tags: [${merged.join(', ')}]`
    if (i >= 0) lines[i] = line; else lines.push(line)
  }
  const quote = v => `"${String(v).replace(/"/g, "'")}"`
  if (q.thesis) lines.push(`thesis: ${quote(q.thesis)}`)
  if (q.counter) lines.push(`counter: ${quote(q.counter)}`)
  if (q.use_for) lines.push(`use_for: ${quote(q.use_for)}`)
  if (q.exception) lines.push(`exception: ${quote(q.exception)}`)
  // The weave date tells what is stale: a note rewritten after that date carries
  // a thesis that may no longer talk about its content.
  lines.push(`woven: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`)

  const withoutBlock = body.replace(new RegExp(`\\n*${OPEN}[\\s\\S]*?${CLOSE}\\n*`), '\n')
  const block = q.links.length
    ? [
        '',
        OPEN,
        '## See also',
        '',
        ...q.links.map(l => `- [[${l.path.replace(/\.md$/, '')}|${titleOf(l.path)}]]: ${l.why}`),
        CLOSE,
        ''
      ].join('\n')
    : ''

  writeFileSync(path, `---\n${lines.join('\n')}\n---\n${withoutBlock.replace(/\s+$/, '')}\n${block}`, 'utf8')
}

/* ------------------------------------------------------------------ */
/* 4. The automatic pass, at night                                     */
/* ------------------------------------------------------------------ */

/**
 * Weaves what is not woven yet, or no longer is.
 *
 * Two cases, and only two: a note that has never been woven (no thesis), and a
 * note rewritten AFTER its last weave (its thesis may then talk about a text
 * that no longer exists). The rest is left alone: a full weave every night would
 * cost fifty model calls to rewrite the same sentences.
 *
 * The ceiling is low on purpose. A base that receives twenty notes at once is
 * woven in three nights, which does not matter, whereas a ceiling reached in the
 * middle of the night would make the night tidy-up fail, which does matter.
 */
export async function weaveNewNotes ({ max = 8 } = {}) {
  const { notes, neighbors } = neighborhood()
  const titles = new Map(notes.map(n => [n.path, n.title]))
  const titleOf = p => titles.get(p) || p.split('/').pop().replace(/\.md$/, '')

  const todo = notes.filter(n => {
    if (!n.thesis) return true
    const woven = readNote(n.path)?.woven
    if (!woven) return true
    return n.mtime > Date.parse(`${woven.replace(' ', 'T')}Z`) + 60_000
  }).slice(0, max)

  const done = []
  const failed = []
  for (const note of todo) {
    try {
      const q = await qualify(note, neighbors.get(note.path) || [])
      // A model that returns off-format output is not a silent error: the note
      // will present itself again the next night, but we want to know that it
      // failed, otherwise a note that always fails stays a candidate for ever
      // without anyone seeing it.
      if (!q) { failed.push({ path: note.path, cause: 'off-format answer' }); continue }
      writeWeave(note, q, { titleOf })
      done.push({ path: note.path, links: q.links.length })
    } catch (e) {
      failed.push({ path: note.path, cause: String(e.message || e) })
    }
  }
  return { candidates: todo.length, woven: done, failed }
}
