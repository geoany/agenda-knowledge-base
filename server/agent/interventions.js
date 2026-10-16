/**
 * The agent's insights: dropped in silence, read when one wants to.
 *
 * The agent never speaks up on its own anymore. What it notices at night is
 * written into the `interventions` table and shows up in one way only: a discreet
 * badge on the line concerned. Nothing blinks, nothing opens, no thread fills up
 * until the user clicks.
 *
 * This module holds both ends of that contract:
 *   - `openInsight` builds the conversation AT CLICK TIME, with the observation
 *     already written inside, so that one can answer it normally;
 *   - `measureInterventions` sorts the insights according to what happened next.
 */
import { db, now } from '../db.js'
import { threadForInsight, saveMessage, getConversation } from './conversations.js'

/**
 * The observation, in English, from what the night stored in `payload`.
 *
 * Each detector writes its own keys; we translate them here rather than asking a
 * model for a text: the observation is already known, having it rewritten would
 * cost a call and could distort it.
 */
function insightText (iv, task) {
  let p = {}
  try { p = JSON.parse(iv.payload || '{}') } catch {}
  const what = p.content || p.target || task?.content || 'this line'
  switch (iv.kind) {
    case 'muda':
      return p.verdict || `"${what}" was postponed ${p.reports || 'several'} times.`
    case 'cold':
      return [
        `"${what}" has not moved for ${p.days} days. I suggest archiving it.`,
        p.keep ? `What it leaves behind: ${p.keep}` : ''
      ].filter(Boolean).join('\n\n')
    case 'prediction':
      return `"${what}" was planned for ${p.dueAt || 'the day in question'}, and that day has passed. The prediction did not hold: what was missing?`
    case 'creep':
      return `This week, ${p.total || 'several'} automatic slips. "${what}" is the smallest of the lot: it spends its time sliding back.`
    case 'rule':
    case 'candidate':
      return p.text || p.verdict || 'I have a rule proposal.'
    default:
      return p.verdict || p.text || `I have an opinion about "${what}".`
  }
}

/**
 * Opens the thread of an insight and returns it. Idempotent: an insight already
 * opened returns its conversation, we do not recreate a thread on every click.
 */
export function openInsight (id) {
  const iv = db.prepare('SELECT * FROM interventions WHERE id = ?').get(id)
  if (!iv) return null
  if (iv.conversation_id) {
    const conv = getConversation(iv.conversation_id)
    if (conv) return conv
  }
  const task = iv.task_id != null ? db.prepare('SELECT content FROM tasks WHERE id = ?').get(iv.task_id) : null
  const title = task?.content ? String(task.content).replace(/[*`#]/g, '').trim() : 'An insight from the agent'
  const conv = threadForInsight(title || 'An insight from the agent')
  const msgId = saveMessage(conv.id, 'assistant', insightText(iv, task))
  db.prepare('UPDATE interventions SET conversation_id = ?, message_id = ? WHERE id = ?')
    .run(conv.id, msgId ?? null, id)
  return getConversation(conv.id)
}

/**
 * The fate of the insights, measured by the night.
 *
 * `followed` if the task moved after the insight (moved, checked, filed,
 * deleted), `heard` if the user answered in the thread.
 *
 * What changed with silence: an insight nothing came to settle is no longer
 * classed as `ignored` after two days. Nothing carries it to the screen anymore
 * apart from the badge on its line, and closing it on its own would make it
 * disappear before it had even been seen. A line that drags on therefore keeps
 * its insight as long as it drags on, which is exactly what it means to say.
 */
export function measureInterventions () {
  const threshold = now() - 48 * 3600_000
  const openRows = db.prepare("SELECT * FROM interventions WHERE status = 'open' AND created_at < ?").all(threshold)
  const summary = { followed: 0, heard: 0, open: 0 }
  for (const i of openRows) {
    let status = null
    const answered = i.conversation_id && db.prepare(
      "SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND role = 'user' AND created_at > ?")
      .get(i.conversation_id, i.created_at).n > 0
    if (answered) status = 'heard'
    if (i.task_id != null) {
      const moved = db.prepare('SELECT COUNT(*) n FROM moves WHERE task_id = ? AND created_at > ?')
        .get(i.task_id, i.created_at).n > 0
      const t = db.prepare('SELECT checked, state FROM tasks WHERE id = ?').get(i.task_id)
      const gone = !t
      if (moved || gone || (t && (t.checked || t.state !== 'active'))) status = 'followed'
    }
    if (!status) { summary.open++; continue }
    db.prepare('UPDATE interventions SET status = ?, resolved_at = ? WHERE id = ?').run(status, now(), i.id)
    summary[status]++
  }
  return summary
}
