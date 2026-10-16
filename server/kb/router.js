/**
 * The document router: an LLM chooses WHICH notes to read.
 *
 * The problem it solves, measured on the real corpus: word search puts the right
 * note at rank 1 in 3 cases out of 16, when it is present in the top 25 in 13
 * cases out of 16. BM25 ranking cannot read a question, it counts words. A
 * model, on the other hand, reads "how to negotiate with a supplier who digs in
 * on its price" and recognizes the note that talks about negotiation, even when
 * not a single word matches.
 *
 * The model is the one of the calendar (KB_ROUTER_MODEL), reasoning off
 * (`reasoning_effort: 'none'`): about 3 s for 25 candidates. With its reasoning,
 * it returns the same ranking in 17 s after thousands of characters of
 * deliberation; on this task, thinking is useless.
 *
 * Three hard rules, each learned from a failure mode:
 *
 *   - **It only sees CANDIDATES.** It is given the result of the full-text
 *     search, never the 124 notes. Sending it the whole index would cost 10 598
 *     tokens per question, against 678 for 25 candidates.
 *   - **Its answer is VERIFIED.** A path it invents and that was not in the list
 *     is thrown away. A model that fabricates a path would have an inexistent
 *     note opened, or worse, an off-topic note presented as certain.
 *   - **It writes nothing and reads nothing itself.** It returns a choice, that
 *     is all. The caller then opens the chosen notes.
 *
 * When the model is unreachable or returns gibberish, we return `null` and the
 * caller falls back on word search. A broken router must never prevent finding a
 * document.
 *
 * Each call leaves a line in `data/kb/router-log.jsonl`: the question, the
 * number of notes returned, the number of candidates, the paths and the reason.
 * It is this log that later allows looking at how the router behaves, without
 * re-running a benchmark every time.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { LLM_URL, llmHeaders } from '../agent/llm.js'
import { KB_ROOT } from './store.js'

const LOG = process.env.KB_ROUTER_LOG || resolve(KB_ROOT, 'router-log.jsonl')
try { mkdirSync(dirname(LOG), { recursive: true }) } catch {}

const BASE = process.env.KB_ROUTER_URL || LLM_URL
const MODEL = process.env.KB_ROUTER_MODEL || process.env.AGENDA_MODEL || 'deepseek-v4.1-flash'

/*
 * 4 times the nominal duration (3 s): the ceiling only exists so a hung request
 * does not block a tool call. Beyond it we give up and fall back on word search,
 * which waits for nobody.
 */
const TIMEOUT_MS = Number(process.env.KB_ROUTER_TIMEOUT || 12_000)

/** The number of candidates submitted to the model: measured at 678 input tokens. */
const CANDIDATES = Number(process.env.KB_ROUTER_CANDIDATES || 25)

const SYSTEM = `You are a document router. You are given a question and a list of candidate notes, each with its path, what it claims and when to use it. You RANK them by proximity to the question, from the closest to the farthest.

You do NOT decide what to read: the person asking the question will decide, based on their need and their time. Your job is to tell them in which order to open, so they can stop as soon as their question is covered.

Answer ONLY with a JSON object, with no text before or after:
{"levels": [{"level": 1, "read": ["path1", "path2"], "why": "one short sentence"}, {"level": 2, "read": ["path3"], "why": "..."}], "why": "one sentence about the ranking"}

The four levels, and their exact meaning:
- **1. answers directly**: the note deals with the subject of the question. It is the first to open.
- **2. completes or sheds light**: it brings an angle needed to answer well (the principle when 1 gives the mechanics, the counter when 1 gives the pro).
- **3. useful context**: it helps to situate, it does not answer directly.
- **4. to set aside**: the link is too vague to justify a read. Put here everything that remains rather than omitting it: the reader must know what you saw and set aside.

Rules:
- Only copy paths present in the list. An absent path will be rejected.
- **Rank ALL the candidate notes** in one of the four levels. An empty level is written with an empty list.
- Level 1 may contain several notes: two notes that each answer half of the question are both level 1.
- Rank on what the note CLAIMS and on when it is useful, not on the resemblance of the words of the question. A note about negotiation can answer a question about a supplier who is blocking, even if the words differ.
- The "why" field of a level says what ITS notes bring, not why you chose them.`

/**
 * Asks the model to choose among already established candidates.
 *
 * `candidates` is a list of `{ path, title, thesis, counter, use_for }`: the
 * orientation fields, never the body. The model does not need the content to
 * decide, it needs to know what each note talks about.
 *
 * Returns `{ levels, why, model, first }` or `null`. Never throws: a router that
 * fails is not an error, it is a fallback.
 */
export async function router (question, candidates) {
  const q = String(question || '').trim()
  if (!q || !Array.isArray(candidates) || !candidates.length) return null
  const list = candidates.slice(0, CANDIDATES)
  const byPath = new Set(list.map(c => c.path))

  const body = {
    model: MODEL,
    temperature: 0,
    reasoning_effort: 'none',
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Question: ${q}\n\nCandidate notes:\n` +
          list.map(c => {
            const says = c.thesis || c.title || ''
            const when = c.use_for ? ` (use it for: ${c.use_for.slice(0, 110)})` : ''
            return `- ${c.path} :: ${says.slice(0, 150)}${when}`
          }).join('\n')
      }
    ]
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let res
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: llmHeaders('agenda-kb-router'),
      signal: ctrl.signal,
      body: JSON.stringify(body)
    })
  } catch {
    clearTimeout(timer)
    return null
  }
  clearTimeout(timer)

  if (!res.ok) return null
  let data
  try { data = await res.json() } catch { return null }
  const text = data?.choices?.[0]?.message?.content
  if (!text) return null

  /*
   * The model sometimes wraps its JSON in text or backticks. We take the first
   * balanced object rather than trusting the format: refusing a correct but
   * badly wrapped answer would lose the benefit of the router for a presentation
   * reason.
   */
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  let obj
  try { obj = JSON.parse(text.slice(first, last + 1)) } catch { return null }

  /*
   * We accept both forms. The new one is a RANKING by levels; the old one, a
   * simple `read` list, is still read in case a model returns it despite the
   * prompt (and because the log already contains entries in the old format,
   * which must remain readable). Refusing the second would lose a usable routing
   * for a matter of form.
   */
  const LEVELS = [1, 2, 3, 4]
  const levels = []
  const seen = new Set()
  if (Array.isArray(obj.levels)) {
    for (const level of LEVELS) {
      const block = obj.levels.find(c => Number(c?.level) === level) || {}
      const read = []
      for (const p of (Array.isArray(block.read) ? block.read : [])) {
        const path = String(p || '').trim()
        // An INVENTED path is thrown away: the model must not have a note opened
        // that did not exist in the list. A duplicate too.
        if (!byPath.has(path) || seen.has(path)) continue
        seen.add(path)
        read.push(path)
      }
      levels.push({ level, read, why: String(block.why || '').trim().slice(0, 200) })
    }
  } else if (Array.isArray(obj.read)) {
    const read = []
    for (const p of obj.read) {
      const path = String(p || '').trim()
      if (!byPath.has(path) || seen.has(path)) continue
      seen.add(path)
      read.push(path)
    }
    levels.push({ level: 1, read, why: String(obj.why || '').trim().slice(0, 200) })
    for (const n of [2, 3, 4]) levels.push({ level: n, read: [], why: '' })
  } else return null

  /*
   * What the model FORGOT goes to level 4, never nowhere.
   *
   * This is the point that makes the ranking usable: the reader must be able to
   * see what was seen then set aside, instead of believing the base contained
   * nothing else. A model that ranks only ten notes out of twenty-five would
   * leave fifteen notes invisible, and nobody would know whether they were
   * judged or ignored.
   */
  const missed = list.map(c => c.path).filter(p => !seen.has(p))
  if (missed.length) {
    const level4 = levels.find(c => c.level === 4)
    level4.read.push(...missed)
  }

  /*
   * Monitoring: each call leaves a line, so we can later answer "how many notes,
   * which ones, and why those" without re-running a benchmark. It is what was
   * missing to notice that the router was bridling itself at three.
   *
   * Append write, a line of about 300 bytes per call: the file runs around 50 KB
   * per month at ten calls a day, nobody has to purge it. A write failure must
   * NEVER make the routing fail.
   */
  const choice = {
    levels,
    why: String(obj.why || '').trim().slice(0, 200),
    model: MODEL,
    // the closest "direct read", for callers that want only the first lead
    first: levels[0].read[0] || levels[1].read[0] || null
  }
  try {
    appendFileSync(LOG, JSON.stringify({
      t: new Date().toISOString().slice(0, 19).replace('T', ' '),
      q,
      n: levels[0].read.length + levels[1].read.length,
      candidates: list.length,
      read: [...levels[0].read, ...levels[1].read],
      levels: levels.map(c => ({ level: c.level, n: c.read.length })),
      missed: missed.length,
      why: choice.why
    }) + '\n', 'utf8')
  } catch {}

  return choice
}

/** For tests and measurement: what the router is usually configured with. */
export const config = { BASE, MODEL, CANDIDATES, LOG }
