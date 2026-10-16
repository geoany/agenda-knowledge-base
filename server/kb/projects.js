/**
 * Filing by project: a note that talks about a project goes into its folder.
 *
 * Each project lives in `projects/<name>/` with the same shape:
 *
 *   - `memory/`     : the facts and decisions of the project;
 *   - `data/`       : the figures, lists, tables;
 *   - `compass.md`  : derived, never written by hand. It lists the notes of the
 *                     project and points to the reference sheets (knowledge,
 *                     engineering...) that these notes cite or that cite them.
 *
 * Filing happens AT BIRTH of a note, never on a rewrite: moving an existing note
 * under the feet of whoever is completing it would make them write in the wrong
 * place on the next turn.
 *
 * A model (the one of the calendar by default, reasoning off) reads the title,
 * the thesis and the start of the text, and returns a project or nothing. Its
 * answer is VERIFIED: a project absent from the list is thrown away. The list of
 * projects is the one of the folders of `projects/`: creating the folder is
 * enough to add a project.
 *
 * Model failure or gibberish: the note stays at the requested path. A failed
 * filing costs a manual move, a refused write would lose the note.
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { LLM_URL, llmHeaders } from '../agent/llm.js'
import { listNotes, readNote, writeNote, resolvePath } from './store.js'
import { linksOf, indexNote } from './index.js'

const MODEL = process.env.KB_PROJECTS_MODEL || process.env.AGENDA_MODEL || 'deepseek-v4.1-flash'
const TIMEOUT_MS = Number(process.env.KB_PROJECTS_TIMEOUT || 12_000)
const SUBFOLDERS = ['memory', 'data']

export const compassPath = name => `projects/${name}/compass.md`

/** The known projects: the folders of `projects/`, with their thesis if the compass has one. */
export function knownProjects () {
  let names = []
  try {
    names = readdirSync(resolvePath('projects'), { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name)
  } catch { return [] }
  return names.sort().map(name => {
    const notes = listNotes(`projects/${name}`).filter(n => n.path !== compassPath(name))
    const titles = notes.slice(0, 8).map(n => readNote(n.path)?.title).filter(Boolean)
    return { name, titles }
  })
}

const SYSTEM = `You file the notes of a knowledge base. You are given a note that is about to be born and the list of projects.

A note belongs to a project when it talks about THAT project in particular: its facts, its decisions, its figures, its clients, its state. A note of general knowledge, reusable elsewhere (a method, a principle, an engineering lesson), belongs to no project, even if it was born during a project.

If it belongs to a project, also say its nature:
- "memory": a fact, a decision, a context, a rule of the project;
- "data": figures, a list, a table, a reading.

Answer ONLY in JSON: {"project": "<exact name from the list>" or null, "type": "memory" or "data"}.`

/** Asks the model which project the note belongs to. Returns { project, type } or null. */
async function classify ({ title, thesis, body }, projects) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: llmHeaders('agenda-kb-projects'),
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: 'Projects:\n' + projects.map(p => `- ${p.name}${p.titles.length ? ` (notes: ${p.titles.join(' ; ')})` : ''}`).join('\n') +
              `\n\nNote:\ntitle: ${title || ''}\n${thesis ? `thesis: ${thesis}\n` : ''}text: ${String(body || '').slice(0, 1500)}`
          }
        ]
      })
    })
    if (!res.ok) return null
    const text = (await res.json())?.choices?.[0]?.message?.content || ''
    const a = text.indexOf('{'); const b = text.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    const obj = JSON.parse(text.slice(a, b + 1))
    const project = projects.find(p => p.name === obj?.project)?.name
    if (!project) return null
    return { project, type: SUBFOLDERS.includes(obj?.type) ? obj.type : 'memory' }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The path where a NEW note must be born. Returns the requested path as is when
 * the note already exists, when it is already under `projects/`, or when the
 * model attaches it to no project.
 */
export async function filedPath (path, note) {
  if (path.startsWith('projects/') || existsSync(resolvePath(path))) return path
  const projects = knownProjects()
  if (!projects.length) return path
  const r = await classify(note, projects)
  if (!r) return path
  const target = `projects/${r.project}/${r.type}/${basename(path)}`
  return existsSync(resolvePath(target)) ? path : target
}

/*
 * The two kinds of notes. The GENERAL TRUTHS (the folders of KB_TIMELESS_DIRS,
 * `knowledge/` by default) must stay true in six months: they never talk about
 * the user, their current projects, their state or their decisions. What moves
 * lives in projects/<name>/ and memory/. A write that mixes the two is refused,
 * not cut apart: a cut made by a model would cut in the wrong place.
 */
export const TIMELESS_DIRS = (process.env.KB_TIMELESS_DIRS ?? 'knowledge')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
export const isTimeless = path => TIMELESS_DIRS.some(d => String(path).startsWith(`${d}/`))

const BUSINESS_SYSTEM = `You re-read a note of a knowledge base. It must be a general truth: a method, a principle, figures from studies, the summary of a book or a video, valid for anyone and still true in six months.

Say whether it talks about the owner of the base or their current projects: their state, their clients, their decisions, their figures, their campaigns, or a section that applies the content to their situation ("for you", "in my case", "what applies to"). An example taken from a third-party company does not count.

Answer ONLY in JSON: {"talks_about_business": true or false, "passage": "<the start of the passage in question, or empty>"}.`

/**
 * The passage of a general truth that talks about the user's projects, or null.
 * Model failure: null, the write goes through (an omission costs a re-read, a
 * wrongful refusal would block a correct note).
 */
export async function projectPassage ({ title, body }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: llmHeaders('agenda-kb-projects'),
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: BUSINESS_SYSTEM },
          { role: 'user', content: `title: ${title || ''}\n\n${String(body || '').slice(0, 12000)}` }
        ]
      })
    })
    if (!res.ok) return null
    const text = (await res.json())?.choices?.[0]?.message?.content || ''
    const a = text.indexOf('{'); const b = text.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    const obj = JSON.parse(text.slice(a, b + 1))
    return obj?.talks_about_business === true ? (String(obj.passage || '').trim() || 'a passage') : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The project of a path, or null. */
export const projectOf = path => /^projects\/([^/]+)\//.exec(path)?.[1] || null

/** Rebuilds `projects/<name>/compass.md`: the project notes, then the linked reference sheets. */
export function updateProjectCompass (name) {
  if (!name) return null
  const path = compassPath(name)
  const notes = listNotes(`projects/${name}`).filter(n => n.path !== path)
    .map(n => readNote(n.path)).filter(Boolean)
  const line = n => `- [[${n.path.replace(/\.md$/, '')}|${n.title}]]${n.thesis ? ` : ${n.thesis}` : ''}`
  const bySubfolder = s => notes.filter(n => n.path.startsWith(`projects/${name}/${s}/`))
  const others = notes.filter(n => !SUBFOLDERS.some(s => n.path.startsWith(`projects/${name}/${s}/`)))

  // The reference sheets: what the project notes cite, and what cites them,
  // outside the project. Sorted by the number of project notes leading to them.
  const weights = new Map()
  for (const n of notes) {
    const { outgoing, incoming } = linksOf(n.path)
    const neighbors = [...outgoing.map(l => l.target), ...incoming.map(l => l.path)]
    for (const p of new Set(neighbors.filter(Boolean))) {
      if (p.startsWith(`projects/${name}/`)) continue
      weights.set(p, (weights.get(p) || 0) + 1)
    }
  }
  const sheets = [...weights.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => readNote(p)).filter(Boolean)

  const blocks = [
    `Entry point of project ${name}. This page rebuilds itself at every note that enters the project: do not write it by hand.`,
    `## Memory\n\n${bySubfolder('memory').map(line).join('\n') || '_No note._'}`,
    `## Data\n\n${bySubfolder('data').map(line).join('\n') || '_No note._'}`
  ]
  if (others.length) blocks.push(`## Other notes of the project\n\n${others.map(line).join('\n')}`)
  blocks.push(`## Reference sheets\n\n${sheets.map(line).join('\n') || '_No linked sheet yet._'}`)

  const n = writeNote(path, {
    title: `Compass of project ${name}`,
    body: `\n${blocks.join('\n\n')}\n`,
    tags: ['index', 'project', name],
    source: 'auto'
  })
  indexNote(n.path)
  return n
}
