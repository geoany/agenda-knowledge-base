import { db, now, today, logJournal } from '../db.js'
import { listRules, suspendRule, groupWeekdays } from '../tasks.js'
import { similar, stripEmDash } from '../text.js'
import { ask } from './llm.js'

/**
 * The rule engine: the second brain, distinct from the chat.
 *
 * It watches the user's corrections (the moves table), infers candidates from
 * them, tests them IN SHADOW (replayed on their real gestures, without ever
 * moving anything), and only proposes what survived the test, with the numerical
 * proof. Promotion is ALWAYS a word from the user: the engine never writes an
 * active rule itself, that is the write gate.
 *
 * 90% of the engine is SQL; the only model call is the free miner, and it is
 * guarded by a wake gate: not enough new gestures, no call.
 *
 * Design drawn from Hermes (curator/suggestions: latched dedup, MAX_PENDING,
 * first-run defer), from mem0 (arbitrated operations, explicit scope that keeps
 * two rules from different contexts from fighting over the same slot) and from
 * skope-rules (support/precision, never a single example).
 */

const DAY_MS = 86_400_000
const SUPPORT_MIN = 3          // below that, a pattern is a coincidence
const PRECISION_MIN = 0.7      // share of the group's gestures that follow the pattern
const SHADOW_DAYS = 7
const SHADOW_MATCHES_MIN = 3
const MAX_CONTRADICTIONS = 3
const MAX_PROPOSED = 5         // beyond that, we wait for the user to empty the bench
const MIN_RUN_INTERVAL_MS = 3600_000 // one cycle per hour at most
const WAKE_GATE_MOVES = 5      // new human moves required to pay for the LLM

const weekdayOf = iso => {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const dedupKey = (kind, scope, param) => `${kind}|${scope}|${JSON.stringify(param || {})}`

/**
 * Inserts or revises a candidate. The memory of the refusal lives here: a dead
 * candidate (rejected or contradicted) keeps its dedup_key forever and is never
 * born again. An active rule that already covers the pattern also cuts it short.
 */
function upsertCandidate ({ kind, scope, param = {}, text, source = 'miner', support = 0, score = 0 }) {
  const key = dedupKey(kind, scope, param)
  const exist = db.prepare('SELECT * FROM rule_candidates WHERE dedup_key = ?').get(key)
  if (exist) {
    if (exist.status === 'dead' || exist.status === 'active') return null
    db.prepare('UPDATE rule_candidates SET support = ?, score = ?, updated_at = ? WHERE id = ?')
      .run(support, score, now(), exist.id)
    return db.prepare('SELECT * FROM rule_candidates WHERE id = ?').get(exist.id)
  }
  // A rule already in service (structured on the same scope, or with a close
  // text) makes the candidate useless: proposing what exists would wear trust out.
  const already = listRules({ all: true }).some(r =>
    (r.kind === kind && r.scope === scope) || similar(r.text, text))
  if (already) return null
  const id = db.prepare(`INSERT INTO rule_candidates (kind, scope, param, text, dedup_key, source, status, score, support, created_at, updated_at)
                         VALUES (?,?,?,?,?,?, 'candidate', ?,?,?,?)`)
    .run(kind, scope, JSON.stringify(param), text, key, source, score, support, now(), now()).lastInsertRowid
  return db.prepare('SELECT * FROM rule_candidates WHERE id = ?').get(id)
}

/**
 * The deterministic miner: the fixed days of groups, inferred from corrections.
 * For every (group, weekday), support = how many distinct tasks the user brought
 * back to that day themselves, precision = the share of their gestures on that
 * group that go to that day. Automatic moves are excluded: the engine only learns
 * from human gestures, never from its own filings.
 */
export function mineFromMoves ({ days = 60 } = {}) {
  const since = now() - days * DAY_MS
  const rows = db.prepare(`
    SELECT task_id, group_key, to_day FROM moves
    WHERE actor IN ('user','agent') AND created_at >= ?
      AND to_day IS NOT NULL AND group_key <> ''`).all(since)

  const byGroup = new Map()
  for (const m of rows) {
    const g = m.group_key.trim()
    if (!byGroup.has(g)) byGroup.set(g, new Map())
    const wd = weekdayOf(m.to_day)
    const byDay = byGroup.get(g)
    if (!byDay.has(wd)) byDay.set(wd, new Set())
    byDay.get(wd).add(m.task_id)
  }

  const alreadyFixed = groupWeekdays()
  const out = []
  for (const [group, byDay] of byGroup) {
    const total = new Set([...byDay.values()].flatMap(s => [...s])).size
    for (const [wd, tasks] of byDay) {
      const support = tasks.size
      const precision = total ? support / total : 0
      if (support < SUPPORT_MIN || precision < PRECISION_MIN) continue
      if (alreadyFixed.get(group) === wd) continue
      const c = upsertCandidate({
        kind: 'weekday_group',
        scope: group,
        param: { weekday: wd },
        text: `The "${group}" tasks are done on ${WEEKDAYS[wd]}.`,
        source: 'miner',
        support,
        score: precision
      })
      if (c) out.push(c)
    }
  }
  return out
}

/**
 * The free miner: ONE model call on the digest of the corrections, guarded by the
 * wake gate. It looks for what SQL does not see (routing a kind of task to a
 * group). It NEVER receives the raw table: a digest of fifteen lines, the active
 * rules, and the ban on inventing.
 */
async function mineWithModel () {
  const since = now() - 30 * DAY_MS
  const moves = db.prepare(`
    SELECT content, group_key, from_day, to_day FROM moves
    WHERE actor IN ('user','agent') AND created_at >= ? AND to_day IS NOT NULL
    ORDER BY id DESC LIMIT 15`).all(since)
  if (moves.length < WAKE_GATE_MOVES) return []

  const digest = moves.map(m =>
    `- "${m.content}" moved from ${m.from_day || 'inbox'} to ${m.to_day}${m.group_key ? ` (group ${m.group_key})` : ''}`).join('\n')
  const rules = listRules().map(r => `- ${r.text}`).join('\n') || '- (none)'

  const prompt = `Here are the last ${moves.length} moves the user made THEMSELVES in their agenda:
${digest}

Rules already in service (never repeat them):
${rules}

Infer 0 to 2 candidate rules, ONLY if a pattern comes back on at least 3 of the examples above. Never a rule from an isolated case, a one-off event, or a negation ("never does X"). Answer ONLY a JSON array, with no text around it:
[{"kind":"weekday_group","scope":"group name in lower case","param":{"weekday":0-6},"text":"the rule as one plain English sentence"}]
allowed kind: weekday_group (a group has a fixed day, weekday 0=sunday) or group_route (a kind of task always goes into a group, param {}). Empty array [] if nothing is solid.`

  let raw
  try {
    raw = await ask(prompt, { system: 'You infer agenda rules from facts, never from a hunch. You answer in strict JSON.', temperature: 0.2 })
  } catch (e) {
    console.error('LLM miner:', e.message)
    return []
  }
  let list = []
  try {
    const m = String(raw).match(/\[[\s\S]*\]/)
    list = m ? JSON.parse(m[0]) : []
  } catch { list = [] }

  const out = []
  for (const c of Array.isArray(list) ? list.slice(0, 2) : []) {
    if (!['weekday_group', 'group_route'].includes(c?.kind)) continue
    if (!c.scope || !c.text) continue
    const cand = upsertCandidate({
      kind: c.kind,
      scope: String(c.scope).toLowerCase().trim(),
      param: c.param && typeof c.param === 'object' ? c.param : {},
      text: stripEmDash(String(c.text)),
      source: 'llm'
    })
    if (cand) out.push(cand)
  }
  return out
}

/**
 * The shadow test (the rule tested in secret): we replay the candidate on the
 * REAL gestures of the user over the last seven days. Each gesture that lands
 * where the rule would have filed it confirms; each opposite gesture contradicts.
 * Three contradictions and the candidate dies, without noise: the user only hears
 * about the survivors.
 */
export function shadowTest (candidate) {
  const param = JSON.parse(candidate.param || '{}')
  if (candidate.kind !== 'weekday_group' || param.weekday == null) {
    // A candidate that cannot be mechanized (group_route) is not shadow-tested:
    // it is proposed on its LLM support alone, the user decides.
    return { matches: null, mismatches: null }
  }
  const since = now() - SHADOW_DAYS * DAY_MS
  const rows = db.prepare(`
    SELECT to_day FROM moves
    WHERE actor IN ('user','agent') AND created_at >= ?
      AND to_day IS NOT NULL AND group_key = ?`).all(since, candidate.scope)
  let matches = 0
  let mismatches = 0
  for (const m of rows) {
    if (weekdayOf(m.to_day) === param.weekday) matches++
    else mismatches++
  }
  const sim = { matches, mismatches, days: SHADOW_DAYS, tested: today() }
  const contradictions = candidate.contradictions + (mismatches > 0 ? 1 : 0)
  const score = matches + mismatches ? matches / (matches + mismatches) : candidate.score
  db.prepare(`UPDATE rule_candidates SET sim = ?, score = ?, contradictions = ?,
              status = CASE WHEN ? >= ${MAX_CONTRADICTIONS} THEN 'dead' ELSE status END,
              updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(sim), score, contradictions, contradictions, now(), candidate.id)
  return sim
}

/* The proposal: a determined text (no LLM), the proof inside, filed in the insight
 * itself. Nothing is written into a thread and nothing is announced: the proposal
 * waits in the "Agent" screen, and the conversation only opens if the user clicks
 * on it. */
function propose (candidate, sim) {
  const pending = db.prepare("SELECT COUNT(*) n FROM rule_candidates WHERE status = 'proposed'").get().n
  if (pending >= MAX_PROPOSED) return false

  db.prepare("UPDATE rule_candidates SET status = 'proposed', updated_at = ? WHERE id = ?").run(now(), candidate.id)
  const proof = sim && sim.matches != null
    ? `I tested it in silence over your last ${sim.days} days: ${sim.matches} gesture(s) out of ${sim.matches + sim.mismatches} confirm it.`
    : `I saw it ${candidate.support} times in your corrections of the last month.`
  const text = `I have a rule to propose: "${candidate.text}" ${proof} Shall I activate it? Say yes and I record it, say no and I never mention it again.`

  db.prepare(`INSERT INTO interventions (kind, candidate_id, trigger, payload, status, created_at)
              VALUES ('rule', ?, 'night', ?, 'open', ?)`)
    .run(candidate.id, JSON.stringify({ text, rule: candidate.text, sim, support: candidate.support }), now())
  return true
}

/**
 * Promotion: the only path to an active rule, always triggered by a word from the
 * user (the agent's promote_rule tool). The rule is born STRUCTURED:
 * kind/scope/param drive the filing without a regex.
 */
export function promote (candidateId) {
  const c = db.prepare('SELECT * FROM rule_candidates WHERE id = ?').get(candidateId)
  if (!c) return { error: 'unknown candidate' }
  if (c.status === 'active') return { error: 'already promoted', ruleId: c.rule_id }
  const ruleId = db.prepare(`INSERT INTO rules (text, source, kind, scope, param, created_at)
                             VALUES (?, 'engine', ?, ?, ?, ?)`)
    .run(c.text, c.kind, c.scope, c.param, now()).lastInsertRowid
  db.prepare("UPDATE rule_candidates SET status = 'active', rule_id = ?, updated_at = ? WHERE id = ?")
    .run(ruleId, now(), c.id)
  db.prepare("UPDATE interventions SET status = 'followed', resolved_at = ? WHERE candidate_id = ? AND status = 'open'")
    .run(now(), c.id)
  logJournal('rule', `Rule promoted from candidate ${c.id}: ${c.text}`, '')
  return { ruleId, text: c.text }
}

/** The refusal: the candidate dies, its dedup_key stays, we never mention it again. */
export function reject (candidateId) {
  const c = db.prepare('SELECT * FROM rule_candidates WHERE id = ?').get(candidateId)
  if (!c) return { error: 'unknown candidate' }
  db.prepare("UPDATE rule_candidates SET status = 'dead', updated_at = ? WHERE id = ?").run(now(), candidateId)
  db.prepare("UPDATE interventions SET status = 'rejected', resolved_at = ? WHERE candidate_id = ? AND status = 'open'")
    .run(now(), candidateId)
  return { ok: true, text: c.text }
}

/**
 * Pharmacovigilance goes into action: a rule undone once out of two is suspended
 * for 30 days, and we SAY it. One only per cycle: two suspensions the same night
 * would drown the message.
 */
function demote () {
  const d = today()
  const sick = db.prepare(`
    SELECT * FROM rules WHERE active = 1 AND applied >= 3 AND overridden * 2 >= applied
      AND (suspended_until IS NULL OR suspended_until <= ?) LIMIT 1`).get(d)
  if (!sick) return null
  const until = today(new Date(now() + 30 * DAY_MS))
  suspendRule(sick.id, { until, reason: `defeated ${sick.overridden} times out of ${sick.applied} filings: suspended for observation` })
  const text = `I suspended the rule "${sick.text}": I applied it ${sick.applied} times, you undid ${sick.overridden} of those filings. It files against you, it sleeps for 30 days. Say so if you want it anyway.`
  db.prepare(`INSERT INTO interventions (kind, rule_id, trigger, payload, status, created_at)
              VALUES ('pharmaco', ?, 'night', ?, 'open', ?)`)
    .run(sick.id, JSON.stringify({ text, applied: sick.applied, overridden: sick.overridden }), now())
  return { ruleId: sick.id }
}

/**
 * A full cycle. Locked by rule_runs: at most one per hour, whatever the trigger
 * (night, burst of gestures, manual). Never throws: the engine is a passenger,
 * never a cause of failure.
 */
export async function runEngineCycle ({ trigger = 'night', dryRun = false } = {}) {
  const last = db.prepare('SELECT created_at FROM rule_runs ORDER BY id DESC LIMIT 1').get()
  if (last && now() - last.created_at < MIN_RUN_INTERVAL_MS) return { already: true }
  const runId = dryRun ? null : db.prepare('INSERT INTO rule_runs (trigger_source, created_at) VALUES (?,?)').run(trigger, now()).lastInsertRowid

  const summary = { mined: 0, llm: 0, tested: 0, proposed: 0, dead: 0, pharmaco: null }
  try {
    summary.mined = mineFromMoves().length
    if (!dryRun) summary.llm = (await mineWithModel()).length
    const toTest = db.prepare("SELECT * FROM rule_candidates WHERE status IN ('candidate','testing')").all()
    for (const c of toTest) {
      const sim = shadowTest(c)
      summary.tested++
      const fresh = db.prepare('SELECT * FROM rule_candidates WHERE id = ?').get(c.id)
      if (fresh.status === 'dead') { summary.dead++; continue }
      const readyByShadow = sim.matches != null && sim.matches >= SHADOW_MATCHES_MIN && sim.mismatches === 0
      const readyBySupport = sim.matches == null && fresh.support >= 3
      if ((readyByShadow || readyBySupport) && !dryRun) {
        if (propose(fresh, sim)) summary.proposed++
      } else if (fresh.status === 'candidate') {
        db.prepare("UPDATE rule_candidates SET status = 'testing', updated_at = ? WHERE id = ?").run(now(), c.id)
      }
    }
    if (!dryRun) summary.pharmaco = demote()
  } catch (e) {
    summary.error = String(e.message || e)
    console.error('engine:', e.message)
  }
  if (runId) db.prepare('UPDATE rule_runs SET summary = ? WHERE id = ?').run(JSON.stringify(summary), runId)
  return summary
}
