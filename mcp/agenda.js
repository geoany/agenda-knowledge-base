#!/usr/bin/env node
/**
 * MCP server "agenda": the user's task base, read-only, plus ONE gateway to the
 * application's agent (`agenda_message`).
 *
 * No direct write tool exists in this file, and it is not a configuration flag:
 * the write code is simply not there. An LLM plugged in here can look at the
 * week, search, understand why a task is where it is; to CHANGE something it
 * talks to the in-house agent through `agenda_message`, and the agent decides
 * (check what already exists, file, refuse). The agenda logic lives in one
 * place, never two.
 *
 * Two transports, deliberately distinct: the reads talk to the SAME SQLite
 * database as the web application (fast, no port), the gateway goes over HTTP
 * to the live service (`POST /api/chat`, the same path as the interface's chat,
 * hence the same turn queue, the same bus, the same memory).
 */
import '../server/env.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { db, today, weekStart } from '../server/db.js'
import { listDay, listWeek, getTask, listRules } from '../server/tasks.js'

const server = new McpServer({ name: 'agenda', version: '1.1.0' }, {
  instructions: "The user's agenda (a week to-do list): look, search, understand by reading directly. For any write, one single path: say what you want in plain language to agenda_message, the application's agent takes care of it."
})

const text = s => ({ content: [{ type: 'text', text: String(s) }] })

const fmt = tasks => tasks.length
  ? tasks.map(t => `${'  '.repeat(t.depth)}[${t.checked ? 'x' : ' '}] #${t.id} ${t.content}${t.note ? ` // ${t.note}` : ''}${t.state !== 'active' ? ` (${t.state})` : ''}${t.startAt ? ` (at ${t.startAt})` : ''}`).join('\n')
  : '(nothing)'

const timestamp = ms => {
  const d = new Date(ms)
  return `${today(d)} at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/* ------------------------------- the days ------------------------- */

server.registerTool('list_day', {
  description: "The tasks of a given day, in tree order. With no argument, today.",
  inputSchema: { day: z.string().optional().describe('YYYY-MM-DD') }
}, async ({ day }) => text(`${day || today()}\n${fmt(listDay(day || today()))}`))

server.registerTool('list_week', {
  description: "The tasks of the whole week containing the given day, today by default.",
  inputSchema: { day: z.string().optional().describe('YYYY-MM-DD') }
}, async ({ day }) => {
  const week = listWeek(weekStart(day || today()))
  return text(Object.entries(week).map(([d, ts]) => `## ${d}\n${fmt(ts)}`).join('\n\n'))
})

/* ------------------------------- searching ------------------------ */

server.registerTool('search_tasks', {
  description: "Searches tasks by word, across every day. Use it to find an identifier before task_detail or why_moved.",
  inputSchema: { query: z.string().describe('a word or a piece of a sentence') }
}, async ({ query }) => {
  const rows = db.prepare('SELECT id, content, day, checked FROM tasks WHERE content LIKE ? ORDER BY day DESC LIMIT 25')
    .all(`%${String(query || '')}%`)
  return text(rows.length
    ? rows.map(r => `#${r.id} ${r.content} (${r.day || 'inbox'})${r.checked ? ' [done]' : ''}`).join('\n')
    : `Nothing containing "${query}"`)
})

server.registerTool('task_detail', {
  description: "One task in detail: its day, its state, its note, its time slot, and its whole subtree.",
  inputSchema: { id: z.number().describe('the task identifier, the one search_tasks gives') }
}, async ({ id }) => {
  const t = getTask(Number(id))
  if (!t) return text(`Task #${id} not found`)
  const parent = t.parentId ? getTask(t.parentId) : null
  const header = [
    `#${t.id} ${t.content}`,
    `day: ${t.day || 'the inbox'}${t.startAt ? `, slot at ${t.startAt}${t.durationMin ? ` (${t.durationMin} min)` : ''}` : ''}`,
    `state: ${t.checked ? 'checked' : t.state}${t.waitingOn ? `, waiting on ${t.waitingOn}` : ''}${t.wakeAt ? `, wakes on ${t.wakeAt}` : ''}`,
    parent ? `inside: #${parent.id} ${parent.content}` : '',
    t.note ? `note: ${t.note}` : '',
    t.moveCount ? `${t.moveCount} move(s)${t.movedFrom ? `, came from ${t.movedFrom}` : ''}` : ''
  ].filter(Boolean).join('\n')
  // The subtree is read back from the task's own day: listDay already returns
  // the tree order with the depth, we only keep the descendants of the line.
  const day = t.day ? listDay(t.day) : []
  const start = day.findIndex(x => x.id === t.id)
  const below = []
  if (start >= 0) {
    // The depth becomes relative to the requested task again, otherwise the
    // subtree arrives shifted by the whole depth the line has in its day.
    for (let i = start + 1; i < day.length && day[i].depth > day[start].depth; i++) {
      below.push({ ...day[i], depth: day[i].depth - day[start].depth - 1 })
    }
  }
  return text(below.length ? `${header}\n\nsubtree:\n${fmt(below)}` : `${header}\n\n(no sub-task)`)
})

/* ------------------------------- understanding -------------------- */

server.registerTool('stats', {
  description: "The agenda's short counters: what is left today, what is done, what is late, what is sleeping.",
  inputSchema: {}
}, async () => {
  const day = today()
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const left = db.prepare("SELECT COUNT(*) n FROM tasks WHERE day = ? AND checked = 0 AND checkbox = 1 AND state = 'active'").get(day).n
  const done = db.prepare('SELECT COUNT(*) n FROM tasks WHERE checked = 1 AND done_at >= ?').get(midnight.getTime()).n
  const late = db.prepare("SELECT COUNT(*) n FROM tasks WHERE day < ? AND checked = 0 AND checkbox = 1 AND state = 'active'").get(day).n
  const inbox = db.prepare("SELECT COUNT(*) n FROM tasks WHERE day IS NULL AND checked = 0 AND state = 'active'").get().n
  const sleeping = db.prepare("SELECT state, COUNT(*) n FROM tasks WHERE state <> 'active' GROUP BY state").all()
  const STATES = { waiting: 'waiting on someone', parked: 'parked', paused: 'paused', archived: 'archived' }
  return text([
    `Today (${day}): ${left} task(s) left, ${done} done.`,
    `Late (past days, unchecked): ${late}.`,
    `In the inbox without a date: ${inbox}.`,
    sleeping.length ? `Out of the flow: ${sleeping.map(d => `${d.n} ${STATES[d.state] || d.state}`).join(', ')}.` : 'Nothing is sleeping.'
  ].join('\n'))
})

server.registerTool('why_moved', {
  description: "Why a task is where it is: its last five moves, who made them and under which rule.",
  inputSchema: { id: z.number().describe('the task identifier') }
}, async ({ id }) => {
  const t = getTask(Number(id))
  const rows = db.prepare('SELECT * FROM moves WHERE task_id = ? ORDER BY id DESC LIMIT 5').all(Number(id))
  if (!rows.length) return text(t ? `#${t.id} "${t.content}" has never moved since it was created.` : `Task #${id} not found`)
  const WHO = { auto: 'the nightly review', user: 'the user themselves', agent: 'the assistant' }
  const rules = new Map(listRules({ all: true }).map(r => [r.id, r.text]))
  const lines = rows.map(m => {
    const route = (m.from_day || 'the inbox') === (m.to_day || 'the inbox')
      ? `filed it in "${m.group_key || 'the root'}"`
      : `sent it from ${m.from_day || 'inbox'} to ${m.to_day || 'inbox'}`
    const why = m.rule_id && rules.has(m.rule_id)
      ? `, under rule ${m.rule_id}: "${rules.get(m.rule_id)}"`
      : (m.reason ? `, reason: ${m.reason}` : '')
    return `- ${timestamp(m.created_at)}, ${WHO[m.actor] || m.actor} ${route}${why}.`
  })
  return text(`#${id} "${t ? t.content : rows[0].content}", its last ${rows.length} moves:\n${lines.join('\n')}`)
})

/* --------------------- the gateway to the agent -------------------- */
/*
 * The message leaves by the SAME path as the interface's chat:
 * `POST /api/chat` queues the turn in the service process (jobs.js) and returns
 * 202 straight away; the answer only exists at the end of the turn, written to
 * the database as an `assistant` message. So we watch the database through the
 * API until it shows up. We replay NOTHING of the loop here: a second pipeline
 * would reason about a state the service does not know.
 */

// The address of the live service. By default the one it listens on (HOST and
// PORT of the same .env); AGENDA_URL replaces it when it runs elsewhere.
const API = process.env.AGENDA_URL ||
  `http://${process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : '127.0.0.1'}:${process.env.PORT || 8137}`

// The service token. The MCP client does not start this server with the
// service's environment: server/env.js has already loaded it from the project's
// .env (or AGENDA_ENV_FILE).
const token = () => process.env.AGENDA_TOKEN || null

async function api (method, path, body) {
  const r = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}`)
  return r.json()
}

/*
 * One single dedicated thread, "MCP bridge", found by its title and created on
 * the first pass. One thread per call would clutter the application's list of
 * conversations; the user's current thread would mix two contexts. And a stable
 * thread gives the agent the history of what has already gone through here.
 *
 * The thread carries kind = 'mcp': the interface only lists chat threads, so
 * what goes through here does not come looking for the user's eye in the
 * application. The conversation stays whole in the database (the agent reads
 * its history back from it), it is only invisible to the picker.
 */
const BRIDGE_TITLE = 'MCP bridge'

async function bridgeThread () {
  const threads = await api('GET', '/conversations?kind=mcp')
  const found = threads.find(c => c.title === BRIDGE_TITLE)
  if (found) return found
  // The thread may have existed before the kind: we recognise it by its title
  // in the full list (archived included), mark it, and it disappears from the
  // interface.
  try {
    const all = await api('GET', '/conversations?kind=all')
    const older = all.find(c => c.title === BRIDGE_TITLE)
    if (older) {
      await api('PATCH', `/conversations/${older.id}/kind`, { kind: 'mcp' })
      return older
    }
  } catch {}
  return api('POST', '/conversations', { title: BRIDGE_TITLE, kind: 'mcp' })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

server.registerTool('agenda_message', {
  description: "Say something to the agenda's agent, in plain language (\"dentist appointment Tuesday 2pm\", \"cancel tonight's tidy-up\"). It handles the logic on its own (it sees what exists, files, creates, moves, refuses) and its answer comes back as is. A turn can take several minutes.",
  inputSchema: { message: z.string().describe('the message, as you would dictate it in the application chat') }
}, async ({ message }) => {
  const said = String(message || '').trim()
  if (!said) return text('Empty message, nothing sent.')
  const thread = await bridgeThread()
  // The "before" marker: any assistant message beyond this id is the answer.
  const before = await api('GET', `/messages?conversationId=${thread.id}`)
  const lastId = before.length ? before[before.length - 1].id : 0
  await api('POST', '/chat', { conversationId: thread.id, message: said })
  // 600 s: never less than 8x the nominal duration of a turn (a reorganisation
  // easily eats up a minute).
  const TIMEOUT = 600_000
  const started = Date.now()
  while (Date.now() - started < TIMEOUT) {
    await sleep(2000)
    const messages = await api('GET', `/messages?conversationId=${thread.id}`)
    const answer = messages.find(m => m.id > lastId && m.role === 'assistant')
    if (answer) return text(answer.content)
    // Nothing is running any more and nothing is written: the turn fell over
    // (loop.js saves no message in that case). The 10 s give the drain time to
    // start, it is asynchronous behind the 202.
    if (Date.now() - started > 10_000) {
      const state = await api('GET', `/chat/state?conversationId=${thread.id}`)
      if (!state.running && !state.queue.length) {
        return text('The agent finished without writing an answer: the turn probably fell over. Look at the service logs.')
      }
    }
  }
  return text(`No answer after ${TIMEOUT / 1000} s. The turn may still be running: the answer will be in the "${BRIDGE_TITLE}" thread of the application.`)
})

await server.connect(new StdioServerTransport())
