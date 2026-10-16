#!/usr/bin/env node
/**
 * Weaves the knowledge base: every note receives its thesis, what it
 * contradicts, when to use it, and its qualified links to its true neighbours.
 *
 *   node scripts/weave.mjs              # dry run, nothing is written
 *   node scripts/weave.mjs --apply      # writes into the markdown files
 *   node scripts/weave.mjs --apply --one knowledge/two-minute-rule.md
 *
 * Rerunnable at will: the woven block is delimited and replaced as a whole, it
 * never piles up. A backup of the folder is made before any write.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { KB_ROOT } from '../server/kb/store.js'
import { neighborhood, qualify, writeWeave } from '../server/kb/weaving.js'
import { rebuildIndex } from '../server/kb/index.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const one = args.includes('--one') ? args[args.indexOf('--one') + 1] : null
const PARALLEL = 4

const { notes, neighbors } = neighborhood()
const titles = new Map(notes.map(n => [n.path, n.title]))
const titleOf = p => titles.get(p) || p.split('/').pop().replace(/\.md$/, '')

const targets = one ? notes.filter(n => n.path === one) : notes
if (!targets.length) { console.error('no note targeted'); process.exit(1) }

if (apply && !one) {
  const dir = process.env.AGENDA_BACKUP_DIR || resolve(process.env.AGENDA_DATA_DIR || resolve(dirname(KB_ROOT)), 'backups')
  mkdirSync(dir, { recursive: true })
  const name = resolve(dir, `kb-before-weave-${new Date().toISOString().slice(0, 10)}.tgz`)
  // The KB may be a symbolic link: without -h, tar would archive only the link.
  execFileSync('tar', ['czhf', name, '-C', dirname(KB_ROOT), basename(KB_ROOT)])
  console.log(`backup: ${name}`)
}

console.log(`${targets.length} note(s), ${apply ? 'WRITING' : 'dry run'}, ${PARALLEL} in parallel\n`)

const report = { ok: 0, failed: 0, links: 0, withoutLink: [] }
const t0 = Date.now()

/* Batches of four: above that the provider answers 429, below it the full
   weave takes more than a quarter of an hour. The failure of one note never
   stops the others, we count it and carry on. */
for (let i = 0; i < targets.length; i += PARALLEL) {
  const batch = targets.slice(i, i + PARALLEL)
  await Promise.all(batch.map(async note => {
    const candidates = neighbors.get(note.path) || []
    let q
    try { q = await qualify(note, candidates) } catch (e) { q = null; var err = e }
    if (!q) {
      report.failed++
      console.log(`  FAIL  ${note.path}${err ? ` (${err.message})` : ''}`)
      return
    }
    report.ok++
    report.links += q.links.length
    if (!q.links.length) report.withoutLink.push(note.path)
    if (apply) writeWeave(note, q, { titleOf })
    console.log(`  ok    ${note.path}  ${q.links.length} link(s)`)
    console.log(`        thesis     : ${q.thesis}`)
    console.log(`        counter    : ${q.counter}`)
    console.log(`        use for    : ${q.use_for}`)
    console.log(`        false if   : ${q.exception || '(nothing)'}`)
    for (const l of q.links) console.log(`        -> ${l.path} : ${l.why}`)
  }))
  console.log(`  [${Math.min(i + PARALLEL, targets.length)}/${targets.length}] ${Math.round((Date.now() - t0) / 1000)}s`)
}

console.log(`\n${report.ok} qualified, ${report.failed} failed, ${report.links} links (${(report.links / (report.ok || 1)).toFixed(1)} per note)`)
if (report.withoutLink.length) console.log(`without any link: ${report.withoutLink.join(', ')}`)

if (apply) {
  const r = rebuildIndex()
  console.log(`reindexed: ${r.total} notes`)
}
