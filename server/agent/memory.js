import { db, now } from '../db.js'
import { similar } from '../text.js'
import { listRules, addRule, deleteRule } from '../tasks.js'

/**
 * The agent's memory. Two shelves, deliberately kept apart:
 *
 *   RULES : firm constraints that drive the automatic filing.
 *           "Groceries are on Saturday." The night review reads them and obeys.
 *   FACTS : everything else it understands about the user, with no mechanical effect.
 *           "They work better in the morning." Used for tone and decisions.
 *
 * Both go ENTIRELY into the prompt on every message. At this scale (a few dozen
 * lines) that is more reliable than a vector search, and a memory is never
 * missed by the retrieval.
 */

export function listFacts (limit = 60) {
  return db.prepare('SELECT * FROM facts ORDER BY weight DESC, id DESC LIMIT ?').all(limit)
}

/**
 * Records a fact. If a very close fact already exists, we do not create a
 * duplicate: we raise its weight. Confirming a habit again strengthens it
 * instead of filling the memory with ten phrasings of the same thing.
 */
export function rememberFact (text, source = 'agent') {
  const clean = String(text).trim()
  if (clean.length < 4) return null
  const existing = listFacts(200).find(f => similar(f.text, clean))
  if (existing) {
    db.prepare('UPDATE facts SET weight = weight + 1, used_at = ? WHERE id = ?').run(now(), existing.id)
    return { ...existing, weight: existing.weight + 1, merged: true }
  }
  const id = db.prepare('INSERT INTO facts (text, source, created_at) VALUES (?,?,?)')
    .run(clean, source, now()).lastInsertRowid
  return db.prepare('SELECT * FROM facts WHERE id = ?').get(id)
}

export function forgetFact (id) {
  db.prepare('DELETE FROM facts WHERE id = ?').run(id)
  return { ok: true }
}

/**
 * The hidden side of facts: used_at only moved on a reconfirmation, never on a
 * read, so doubtfulFacts (night.js) accused the liveliest facts of being dead,
 * the ones every conversation brushes against without ever restating them.
 *
 * After each chat turn, we mark as used the facts whose text resonates with what
 * has just been said. Low threshold (0.35): it is not about proving the fact was
 * restated, only that it still lives in the same universe. The work is bounded
 * by listFacts (60 facts at most) and a few texts.
 */
export function touchFacts (texts) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map(t => String(t || '').trim()).filter(Boolean)
  if (!list.length) return 0
  let touched = 0
  const mark = db.prepare('UPDATE facts SET used_at = ? WHERE id = ?')
  for (const f of listFacts()) {
    if (list.some(t => similar(f.text, t, 0.35))) {
      mark.run(now(), f.id)
      touched++
    }
  }
  return touched
}

/** A contradicted rule is deactivated, we never let two opposite rules live together. */
export function replaceRule (oldId, text) {
  if (oldId) deleteRule(oldId)
  return addRule(text, 'agent')
}

export function memoryBlock () {
  const rules = listRules()
  const facts = listFacts()
  const out = []
  if (rules.length) {
    out.push('Rules to respect absolutely (they drive the automatic filing):')
    for (const r of rules) out.push(`  [rule ${r.id}] ${r.text}`)
  }
  if (facts.length) {
    out.push('')
    out.push('What you know about the user:')
    for (const f of facts) out.push(`  [fact ${f.id}] ${f.text}`)
  }
  return out.join('\n')
}
