#!/usr/bin/env node
/**
 * Regenerates the trigger index by hand.
 *
 *   node scripts/triggers.mjs
 *
 * It already runs on its own after every write to the base and at the end of
 * the night; this script only exists to run it again after changing the rules
 * of `server/kb/triggers.js`, or to see what it produces.
 */
import { generateTriggers } from '../server/kb/triggers.js'

const r = generateTriggers()
console.log(`${r.notes} note(s) indexed out of ${r.total}, rarity cap ${r.cap} notes`)
console.log(`anti-corpus: ${r.antiCorpus} word(s) disqualified, ${r.removed.length} trigger(s) removed in ${r.rounds} round(s)`)
if (r.removed.length) console.log(`   removed: ${r.removed.slice(0, 25).join(', ')}${r.removed.length > 25 ? ' …' : ''}`)
console.log(`recall: ${r.watched - r.missed.length}/${r.watched} watched phrase(s) find their note`)
for (const m of r.missed) console.log(`   MISSED "${m.phrase}" no longer finds "${m.target}"`)
console.log(`written: ${r.file}`)
if (r.missed.length) process.exitCode = 1
