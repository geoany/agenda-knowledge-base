#!/usr/bin/env node
/**
 * What the router chose, over the requested period.
 *
 *   node scripts/router-report.mjs [days]
 *
 * Why this script exists: the router had throttled ITSELF down to three notes
 * for two days, and nothing would have shown it without running a benchmark by
 * hand. Every call now leaves a line in `data/kb/router-log.jsonl`; this script
 * reads it and gives back the real behaviour: how many notes per question,
 * which ones come back, and on which questions it could not choose.
 *
 * It re-runs NO model: it reads what has already happened. That is the
 * difference between measuring and replaying.
 *
 * What to look at when you open it:
 *   - the average number of notes per question: too low (close to 1), the
 *     router is throttling itself; too high, it is diluting;
 *   - the notes that come out the most: the pillars of the base, and what the
 *     router believes to be useful;
 *   - the questions where it returned ZERO notes: the holes in the base, or a
 *     missing candidate;
 *   - the questions where it returned the MAXIMUM: either a broad topic, or a
 *     choice that is too broad.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { KB_ROOT } from '../server/kb/store.js'

const LOG = process.env.KB_ROUTER_LOG || resolve(KB_ROOT, 'router-log.jsonl')
const days = Number(process.argv[2] || 30)

if (!existsSync(LOG)) {
  console.log(`No log yet (${LOG}).`)
  console.log('It fills up on its own: every kb_route leaves a line in it.')
  process.exit(0)
}

const since = Date.now() - days * 86400_000
const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l) } catch { return null } })
  .filter(Boolean)
  .filter(e => new Date(e.t.replace(' ', 'T')).getTime() >= since)

if (!lines.length) {
  console.log(`Nothing in the log over the last ${days} days.`)
  process.exit(0)
}

const total = lines.length
const notes = lines.reduce((s, e) => s + (e.n || 0), 0)
const zero = lines.filter(e => !e.n)
const byCount = {}
for (const e of lines) byCount[e.n] = (byCount[e.n] || 0) + 1

/*
 * The breakdown BY LEVEL, which is the real measure since the router started
 * ranking: how many notes answer directly, how many complete, how many are set
 * aside. Level 1 is what decides whether the routing is any use: an empty level
 * 1 on many calls means the base does not cover the questions asked of it.
 *
 * CAREFUL: we look ONLY at entries in the ranked format. The log also contains
 * calls in the old format (a flat list, no levels); counting them as "empty
 * level 1" would make the report say the base covers nothing when it is the
 * measure that is missing. That is exactly the kind of false figure that leads
 * to a bad decision.
 */
const withLevels = lines.filter(e => Array.isArray(e.levels))
const perLevel = [1, 2, 3, 4].map(n => {
  const calls = withLevels.filter(e => (e.levels || []).some(c => c.level === n && c.n > 0))
  const notes = withLevels.reduce((s, e) => s + ((e.levels || []).find(c => c.level === n)?.n || 0), 0)
  return { level: n, calls: calls.length, notes }
})

/* the notes that come out the most, and those that come out only once */
const hits = new Map()
for (const e of lines) for (const p of e.read || []) hits.set(p, (hits.get(p) || 0) + 1)
const ranking = [...hits.entries()].sort((a, b) => b[1] - a[1])

const pad = n => String(n).padStart(4)
console.log(`=== the router over ${days} days ===\n`)
console.log(`  calls                  : ${total}`)
console.log(`  notes returned in total: ${notes}`)
console.log(`  average per question   : ${(notes / total).toFixed(1)}`)
console.log(`  candidates (average)   : ${Math.round(lines.reduce((s, e) => s + (e.candidates || 0), 0) / total)}`)
console.log()

console.log('  how many notes per question')
for (const n of Object.keys(byCount).map(Number).sort((a, b) => a - b)) {
  const bar = '#'.repeat(Math.max(1, Math.round(byCount[n] / total * 40)))
  console.log(`   ${String(n).padStart(2)} note(s) ${pad(byCount[n])} calls  ${bar}`)
}
console.log()

if (withLevels.length) {
  /* The ranking by level: what says whether the routing puts the right note at
     the very top, and what share of the corpus is set aside rightly. */
  console.log(`  where the notes land, by level (over ${withLevels.length} ranked calls)`)
  const LABEL = { 1: 'answer directly', 2: 'complete or shed light', 3: 'useful context', 4: 'set aside' }
  const totalLevels = perLevel.reduce((s, n) => s + n.notes, 0) || 1
  for (const n of perLevel) {
    const avg = (n.notes / withLevels.length).toFixed(1)
    const bar = '#'.repeat(Math.max(1, Math.round(n.notes / totalLevels * 30)))
    console.log(`   ${n.level}. ${LABEL[n.level].padEnd(24)} ${String(n.notes).padStart(4)} notes (${avg}/call)  ${bar}`)
  }
  const withoutL1 = withLevels.filter(e => !(e.levels || []).some(c => c.level === 1 && c.n > 0)).length
  console.log()
  console.log(`  calls WITHOUT a level 1 note: ${withoutL1}/${withLevels.length}` +
    (withoutL1 > withLevels.length * 0.2 ? '  <- the base does not cover these questions, or the candidates are bad' : ''))
  console.log()
}

if (zero.length) {
  console.log(`  questions WITHOUT any note (${zero.length}): the base had nothing, or the candidates were missing`)
  zero.slice(0, 12).forEach(e => console.log(`   ${e.t}  ${e.q.slice(0, 68)}`))
  console.log()
}

console.log(`  the notes that come out the most (${ranking.length} different in total)`)
ranking.slice(0, 15).forEach(([p, n]) => console.log(`   ${pad(n)} times  ${p}`))
console.log()

const single = ranking.filter(([, n]) => n === 1).length
console.log(`  notes that came out only once: ${single}`)
console.log('  (many notes seen once = the router is sweeping wide;')
console.log('   few notes seen often = the same pillars carry everything)')
