import { db, now, today } from '../db.js'

/**
 * Conversation threads. One thread = one conversation that keeps its history,
 * like the tabs of a messenger. We open one per topic ("groceries", "moving")
 * so that the context of one topic does not pollute the other.
 *
 * The evening review thread has `kind = 'review'`: it is generated automatically
 * and the interface displays it apart.
 */

export function listConversations ({ limit = 50 } = {}) {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
    FROM conversations c
    WHERE c.archived = 0 AND c.kind = 'chat'
    ORDER BY c.modified_at DESC
    LIMIT ?`).all(limit)
}

export function getConversation (id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null
}

export function createConversation ({ title = 'New conversation', kind = 'chat' } = {}) {
  const t = now()
  const id = db.prepare('INSERT INTO conversations (title, kind, created_at, modified_at) VALUES (?,?,?,?)')
    .run(title, kind, t, t).lastInsertRowid
  return getConversation(id)
}

/** The current thread: the last one touched, otherwise we open one. */
export function currentConversation () {
  const row = db.prepare("SELECT * FROM conversations WHERE archived = 0 AND kind = 'chat' ORDER BY modified_at DESC LIMIT 1").get()
  return row || createConversation()
}

/**
 * The thread of an insight, opened the day the user asks for it.
 *
 * The agent no longer keeps any thread on its own initiative. What it noticed
 * sleeps in the `interventions` table, shows up on the line concerned, and only
 * becomes a conversation when one clicks on it: the first message is its
 * observation, the answer is written below.
 *
 * The thread is of kind 'chat': `currentConversation` returns the last chat
 * thread touched, so the one just opened stays in sight.
 */
export function threadForInsight (title) {
  return createConversation({ title: title.slice(0, 60), kind: 'chat' })
}

export function renameConversation (id, title) {
  db.prepare('UPDATE conversations SET title = ?, modified_at = ? WHERE id = ?').run(title, now(), id)
  return getConversation(id)
}

/** Archiving rather than deleting: the history stays readable by the agent. */
export function archiveConversation (id) {
  db.prepare('UPDATE conversations SET archived = 1, modified_at = ? WHERE id = ?').run(now(), id)
  return { ok: true }
}

export function touchConversation (id) {
  db.prepare('UPDATE conversations SET modified_at = ? WHERE id = ?').run(now(), id)
}

export function listMessages (conversationId, limit = 200) {
  const rows = conversationId
    ? db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(conversationId, limit)
    : db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(limit)
  return rows.reverse().map(m => ({
    id: m.id,
    role: m.role,
    content: m.content,
    steps: m.steps ? safeParse(m.steps) : [],
    createdAt: m.created_at
  }))
}

export function saveMessage (conversationId, role, content, steps = []) {
  const id = db.prepare('INSERT INTO messages (conversation_id, role, content, steps, created_at) VALUES (?,?,?,?,?)')
    .run(conversationId, role, content, steps.length ? JSON.stringify(steps) : '', now()).lastInsertRowid
  touchConversation(conversationId)
  return id
}

/**
 * Thread title: the first six words of the first message, cleaned up. We do not
 * spend a model call on that, the first message already describes the topic.
 * The agent can rename it later with its `rename_thread` tool.
 */
export function autoTitle (conversationId, firstMessage) {
  const c = getConversation(conversationId)
  if (!c || c.title !== 'New conversation') return c
  const words = String(firstMessage).replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
  const title = words.length > 48 ? words.slice(0, 45) + '…' : (words || `Conversation of ${today()}`)
  return renameConversation(conversationId, title)
}

function safeParse (s) { try { return JSON.parse(s) } catch { return [] } }
