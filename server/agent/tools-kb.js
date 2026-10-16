import {
  readNote, writeNote, listNotes, buildTree, notePath, resolvePath, noteExists
} from '../kb/store.js'
import { indexNote, search, linksOf, countNotes, reindex } from '../kb/index.js'
import { neighbors } from '../kb/graph.js'
import { router } from '../kb/router.js'
import { recordNoteChange, noteSnapshot } from '../history.js'
import { filedPath, projectOf, updateProjectCompass, isTimeless, projectPassage } from '../kb/projects.js'

/**
 * The knowledge base tools, in the same format as server/agent/tools.js.
 *
 * This file exports `defs`, `handlers`, `labels` and `writers`; the aggregation
 * in tools.js happens elsewhere. The knowledge base is a block of its own, apart
 * from the to-do list, and so are its tools: one must be able to remove them as
 * a whole without touching a single agenda tool.
 *
 * Every description sent to the model is written in careful, idiomatic English.
 * A model mimics the style of its prompt, so the prompt sets the tone of the
 * answer it gives back.
 */

/* ------------------------------------------------------------------ */
/* Declarations sent to the model                                      */
/* ------------------------------------------------------------------ */

export const defs = [
  ['kb_search', "Searches the knowledge base (the user's markdown notes: book summaries, project sheets, references). Returns excerpts with the exact path of each note. Call it BEFORE kb_read: this is what tells you which note to open.", {
    query: ['string', 'the words to search for', true],
    folder: ['string', 'only search in this top-level folder, for example "knowledge" or "projects"'],
    limit: ['number', 'how many results, 8 by default']
  }],
  ['kb_route', "Ranks the notes of a topic, from the closest to the farthest, so you know in which order to open them. Call it when you do not know which words to type, or when the question is a whole sentence (kb_search can count words, it cannot read a question). Returns four levels: 1 answer directly, 2 complete or shed light, 3 useful context, 4 seen then set aside. You start with level 1 and stop there if the answer is in it; you go down to level 2 only if the question needs a mechanism, a counter-argument or a figure that level 1 does not carry. Level 4 is not to be opened, it says what was swept. Slower than a search (about a second), so keep it for questions of substance: prefer kb_search when you already have a precise word in mind.", {
    question: ['string', 'the question in plain language, as you would ask it', true],
    limit: ['number', 'how many notes to keep in levels 1 and 2, 12 by default']
  }],
  ['kb_read', "Reads a whole note of the knowledge base, by its path. The path is the one kb_search or kb_tree gives, for example \"knowledge/gardening.md\".", {
    path: ['string', 'the path of the note in the knowledge base', true]
  }],
  ['kb_write', "Writes or rewrites a note of the knowledge base. The path decides where it lives: file it in a folder that already exists rather than inventing one. The content is markdown. Writing on an existing path REPLACES the note, so read it first with kb_read if you want to complete it. Pass `thesis`, `counter` and `use_for` when you write a new note: without them it is mute for search and routing, nobody will know what it claims. A note in knowledge/ or outreach/ is a general truth: it never talks about the user or their business, what concerns them goes to projects/<name>/.", {
    path: ['string', 'path of the note, for example "knowledge/gardening.md"', true],
    content: ['string', 'the content of the note, in markdown', true],
    title: ['string', 'the readable title of the note, with its accents'],
    tags: ['array', 'a few labels, one word each'],
    thesis: ['string', 'what the note claims, in one sharp sentence'],
    counter: ['string', 'the ordinary reflex it contradicts'],
    use_for: ['string', 'in which work situation to open it'],
    exception: ['string', 'the case where the note is false (optional)']
  }],
  ['kb_link', "Links two notes: adds a [[wiki]] link at the end of the starting note. This is what builds the graph of the knowledge base. A note linked to nothing is invisible, hence dead.", {
    from: ['string', 'path of the note that receives the link', true],
    to: ['string', 'path of the note to point at', true],
    why: ['string', 'a short sentence saying why the two look alike']
  }],
  ['kb_tree', "The tree of the knowledge base: the folders, how many notes in each, and the notes of the requested folder. Call it when you do not yet know where something is filed.", {
    folder: ['string', 'one precise folder, otherwise the whole tree'],
    depth: ['number', 'displayed depth, 2 by default']
  }],
  ['kb_related', "The neighbouring notes of a note in the graph: the ones it cites, the ones that cite it, and its folder siblings. Useful to bounce from one note to another without going back through search.", {
    path: ['string', 'the path of the note', true],
    limit: ['number', 'how many neighbours per category, 6 by default']
  }]
]

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

const num = v => (v === '' || v == null ? null : Number(v))

/** An excerpt fits on one line: beyond that, the model pays for filler. */
const oneLine = (s, n = 170) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const folderCounts = () => {
  const by = new Map()
  for (const n of listNotes()) {
    const d = n.path.includes('/') ? n.path.split('/')[0] : '(root)'
    by.set(d, (by.get(d) || 0) + 1)
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1])
}

function renderTree (node, depth, level = 0) {
  const out = []
  const indent = '  '.repeat(level)
  for (const d of node.folders) {
    const total = (function count (x) { return x.notes.length + x.folders.reduce((s, y) => s + count(y), 0) })(d)
    out.push(`${indent}${d.name}/ (${total})`)
    if (level + 1 < depth) out.push(...renderTree(d, depth, level + 1))
  }
  // Notes are shown only at the last requested level: otherwise the complete
  // tree of a two-hundred-note base fills the model's whole context while it
  // only wanted to know which folders exist.
  if (level + 1 >= depth || !node.folders.length) {
    for (const n of node.notes) out.push(`${indent}${n.path}`)
  }
  return out
}

export const handlers = {
  kb_search: ({ query, folder, limit }) => {
    const q = String(query || '').trim()
    if (!q) return 'NOTHING FOUND. Give me words to search for.'
    const rows = search(q, { limit: Math.min(25, num(limit) || 8), folder: String(folder || '').trim() || null })
    if (!rows.length) {
      const total = countNotes()
      if (!total) return 'The knowledge base is empty for now, there is no note to search.'
      return `Nothing about "${q}" in the ${total} notes. Try other words, or look at the tree with kb_tree.`
    }
    // The thesis comes before the excerpt: a passage cut in the middle of a
    // sentence does not say whether the note is worth opening, the note's claim
    // does.
    return rows.map(r => `${r.path} · ${r.title}\n   ${oneLine(r.thesis || r.excerpt)}`).join('\n')
  },

  /**
   * The router: a model RANKS the notes by proximity, the agent reads what it wants.
   *
   * It does not replace kb_search, it follows it. Word search puts the right
   * note in rank 1 in 3 cases out of 16; the router, 10 out of 16. But the
   * router needs candidates to rank, so it is given the widened search result,
   * never the 124 notes (10,598 tokens against 678).
   *
   * The rendering is a RANKING in four levels, not a closed selection. That is
   * the point: the model proposes an order of reading, the agent decides where
   * it stops according to its need and its time. A tool that returns a closed
   * list forces you to trust it; a ranking is browsed, and it also says what it
   * SAW then set aside, so that one does not believe the base empty.
   *
   * When the model is unreachable, we fall back on word search and we SAY so: a
   * model that believes it routed while it is reading a fallback would take the
   * fallback for an answer.
   */
  kb_route: async ({ question, limit }) => {
    const q = String(question || '').trim()
    if (!q) return 'NOTHING ROUTED. Give me the whole question, for example "how do I justify a price increase".'
    /*
     * The limit only bridles levels 1 and 2, the ones we really read: levels 3
     * and 4 are the map of what was seen, and truncating them would make the
     * only piece of information saying the base was swept disappear.
     */
    const max = Math.max(1, Math.min(25, num(limit) || 12))

    // The candidates come from word search: it is what reduces the corpus to
    // 25 leads before paying for a model call.
    const raw = search(q, { limit: 30 })
    if (!raw.length) {
      return `No note is about "${q}", even widened: the router has nothing to rank. Look at the tree with kb_tree.`
    }
    const candidates = raw.map(r => {
      const n = readNote(r.path)
      return {
        path: r.path,
        title: r.title,
        thesis: n?.thesis || r.thesis || '',
        counter: n?.counter || '',
        use_for: n?.use_for || ''
      }
    })

    const choice = await router(q, candidates)
    if (!choice) {
      const first = candidates.slice(0, 3).map(c => c.path)
      return `The router did not answer (model unreachable). Fallback on word search, the first 3 leads:\n${first.join('\n')}\nOpen them with kb_read to settle it.`
    }

    const titleOf = p => {
      const c = candidates.find(x => x.path === p)
      return c ? ` · ${c.title}` : ''
    }
    const claimOf = p => {
      const c = candidates.find(x => x.path === p)
      return oneLine(c?.thesis || '', 130)
    }

    const LABEL = {
      1: 'ANSWER DIRECTLY',
      2: 'COMPLETE OR SHED LIGHT',
      3: 'USEFUL CONTEXT',
      4: 'TO SET ASIDE'
    }
    const blocks = []
    let read = 0
    for (const group of choice.levels) {
      if (!group.read.length) continue
      const kept = group.level <= 2 ? group.read.slice(0, Math.max(0, max - read)) : group.read
      if (!kept.length) continue
      if (group.level <= 2) read += kept.length
      const header = `--- ${group.level}. ${LABEL[group.level]} (${kept.length})` +
        (group.why ? ` — ${group.why}` : '')
      const lines = group.level === 4
        // at level 4 we give the paths only: it is a map of what was seen then
        // set aside, not an invitation to read
        ? [kept.map(p => `    ${p}`).join('\n')]
        : kept.map(p => `  ${p}${titleOf(p)}\n     ${claimOf(p)}`)
      blocks.push(header + '\n' + lines.join('\n'))
    }

    const first = choice.levels[0].read
    return `The router ranked ${candidates.length} leads, from the closest to the farthest.\n\n` +
      blocks.join('\n\n') + '\n\n' +
      (first.length
        ? `Start with ${first.map(p => `"${p}"`).join(' and ')} using kb_read, and stop there if the answer is in it. ` +
          `Go down to level 2 only if the question needs a mechanism, a counter-argument or a figure that level 1 does not carry.`
        : 'No note answers directly. Open a lead from level 2, or tell me the base does not cover this topic.') +
      (choice.levels[3].read.length
        ? `\nLevel 4 (${choice.levels[3].read.length} notes) is there so you know what was seen then set aside: do not open it.`
        : '')
  },

  kb_read: ({ path }) => {
    const n = readNote(String(path || '').trim())
    if (!n) return `No note at "${path}". Look for it with kb_search, or look at kb_tree.`
    const { incoming } = linksOf(n.path)
    // The three weaving lines come BEFORE the body, and "counter" is announced
    // as a warning: a model that reads the ordinary reflex just before the text
    // can no longer serve it back without noticing.
    const header = [
      `# ${n.title}`,
      `path: ${n.path}`,
      n.thesis ? `what it claims: ${n.thesis}` : '',
      n.counter ? `WARNING, it contradicts this: ${n.counter}` : '',
      n.use_for ? `when to use it: ${n.use_for}` : '',
      // The exception comes AFTER the thesis, never before: it is worth only to
      // someone who has already read what the note claims, and its role is to
      // prevent applying it without looking at the situation.
      n.exception ? `but it is FALSE in this case: ${n.exception}` : '',
      n.tags.length ? `tags: ${n.tags.join(', ')}` : '',
      n.source ? `source: ${n.source}` : '',
      incoming.length ? `cited by: ${incoming.map(e => e.path).join(', ')}` : ''
    ].filter(Boolean).join('\n')
    return `${header}\n\n${n.body.trim()}`
  },

  /**
   * Writing is deliberately simple: one path, one content.
   *
   * No automatic merge with what exists. A model that believes it is completing
   * a note while it is replacing it destroys knowledge silently, and it is
   * beyond repair since nobody rereads a note of the base every day. The tool
   * description therefore says explicitly to read first, and the answer recalls
   * what it has just overwritten.
   */
  kb_write: async ({ path, content, title, tags, thesis, counter, use_for, exception }, ctx) => {
    const raw = String(path || '').trim()
    if (!raw) return 'NOTHING WRITTEN. I need a path, for example "knowledge/gardening.md".'
    let target
    try { target = notePath(raw); resolvePath(target) } catch (e) { return `NOTHING WRITTEN. ${e.message}` }

    const body = String(content ?? '').trim()
    if (!body) return 'NOTHING WRITTEN. An empty note teaches nobody anything.'

    // A NEW note that talks about a project is born in projects/<name>/memory or /data.
    const requested = target
    target = await filedPath(target, { title, thesis, body })

    // A general truth never talks about the current projects.
    if (isTimeless(target)) {
      const passage = await projectPassage({ title, body })
      if (passage) return `NOTHING WRITTEN. ${target} is a general truth: it never talks about the user or their current projects, because it must stay true in six months. Passage in question: "${passage.slice(0, 160)}". Remove it, and put what concerns a project in projects/<name>/memory/ or projects/<name>/data/.`
    }

    const before = readNote(target)
    const beforeState = noteSnapshot(target)

    const labels = Array.isArray(tags)
      ? tags.map(t => String(t).trim()).filter(Boolean)
      : String(tags || '').split(/[,\s]+/).filter(Boolean)

    const n = writeNote(target, {
      title: String(title || '').trim() || undefined,
      body,
      tags: labels.length ? labels : undefined,
      // The orientation fields go through the write. Without them, a note was
      // born mute for search and routing, and had to be woven after the fact to
      // really exist in the base.
      thesis: String(thesis || '').trim() || undefined,
      counter: String(counter || '').trim() || undefined,
      use_for: String(use_for || '').trim() || undefined,
      exception: String(exception || '').trim() || undefined,
      source: 'agent'
    })
    indexNote(n.path)
    // The shared history: the old note comes back on Ctrl+Z, or the new one disappears.
    recordNoteChange(n.path, beforeState, noteSnapshot(n.path))
    const project = projectOf(n.path)
    if (project) { try { updateProjectCompass(project) } catch {} }
    const filed = target !== requested ? ` Filed in project ${project} (requested: ${requested}).` : ''
    return (before
      ? `Note "${n.title}" rewritten in ${n.path}. The old version of ${before.body.trim().length} characters is replaced.`
      : `Note "${n.title}" created in ${n.path}, ${body.length} characters. Remember to link it to a neighbouring note with kb_link, otherwise nobody will find it again.`) + filed
  },

  kb_link: ({ from, to, why }, ctx) => {
    const source = String(from || '').trim()
    const target = String(to || '').trim()
    const a = readNote(source)
    if (!a) return `No note at "${source}", nothing linked.`
    const b = readNote(target)
    if (!b) return `No note at "${target}", nothing linked.`
    if (a.path === b.path) return 'A note does not link to itself.'

    // We cite the TITLE and not the path: that is what is read in the text of
    // the note, and the index knows how to resolve a link written with the full
    // accented title.
    const mark = `[[${b.title}]]`
    if (a.body.includes(mark) || a.body.includes(`[[${b.path.replace(/\.md$/, '')}]]`)) {
      return `"${a.title}" already pointed at "${b.title}", nothing to add.`
    }
    const line = `\n\nSee also ${mark}${why ? `: ${String(why).trim()}` : ''}\n`
    const beforeState = noteSnapshot(a.path)
    const n = writeNote(a.path, { body: `${a.body.trimEnd()}${line}` })
    indexNote(n.path)
    recordNoteChange(n.path, beforeState, noteSnapshot(n.path))
    for (const p of new Set([projectOf(a.path), projectOf(b.path)])) { if (p) { try { updateProjectCompass(p) } catch {} } }
    return `"${a.title}" now points at "${b.title}"${why ? ` (${String(why).trim()})` : ''}.`
  },

  kb_tree: ({ folder, depth }) => {
    const total = countNotes()
    if (!total) return 'The knowledge base is empty: no note for now.'
    const dir = String(folder || '').trim()
    if (dir && !noteExists(dir)) {
      return `No folder "${dir}". Existing folders: ${folderCounts().map(([d, n]) => `${d} (${n})`).join(', ')}`
    }
    const notes = listNotes(dir || '')
    const tree = buildTree(notes.map(n => ({ ...n })))
    const lines = renderTree(tree, Math.max(1, Math.min(5, num(depth) || 2)))
    return `${total} note(s) in the base${dir ? `, ${notes.length} under ${dir}` : ''}:\n${lines.join('\n')}`
  },

  kb_related: ({ path, limit }) => {
    const target = String(path || '').trim()
    const n = readNote(target)
    if (!n) return `No note at "${target}".`
    const max = Math.max(1, Math.min(20, num(limit) || 6))
    const v = neighbors(n.path, { limit: max })
    const block = (title, list) => (list.length
      ? `${title}:\n${list.slice(0, max).map(x => `  ${x.path} · ${x.title}`).join('\n')}`
      : null)
    const out = [
      block('It cites', v.outgoing),
      block('It is cited by', v.incoming),
      block('In the same folder', v.folder)
    ].filter(Boolean)
    if (!out.length) return `"${n.title}" has no neighbour: it is alone in its folder and nobody cites it. It is an orphan, link it with kb_link.`
    return `Around "${n.title}" (${n.path}):\n${out.join('\n')}`
  }
}

/** Readable label shown live in the chat while the tool runs. */
export const labels = {
  kb_route: 'has the base read by the router',
  kb_search: 'digs through the knowledge base',
  kb_read: 'reads a note',
  kb_write: 'writes a note',
  kb_link: 'links two notes',
  kb_tree: 'walks the knowledge base',
  kb_related: 'looks at the neighbouring notes'
}

/** The tools that write: the interface refreshes only after those. */
export const writers = ['kb_write', 'kb_link']

/* The routes need to reindex without going through an agent tool. */
export { reindex }
