import { today, addDays, weekStart, now, db } from '../db.js'
import {
  listDay, listWeek, listInbox, getTask, createTask, updateTask, deleteTask,
  moveTask, reorderTask, numberTasks, listRules, addRule, deleteRule,
  stalest, groupWeekdays, nextWeekday, dayGroups, usualGroups, resolveGroup,
  setState, listParked, STATE_LABEL, weekdayRule, suspendRule, groupKey,
  restoreTrash, listTrash, checkTree
} from '../tasks.js'
import { rememberFact, forgetFact, listFacts } from './memory.js'
import { listReviews, undoReview, runReview } from './review.js'
import { renameConversation } from './conversations.js'
import { promote, reject } from './rule-engine.js'
import { similar } from '../text.js'
import { undo as undoGesture, withGesture } from '../history.js'
import { parseTimeSpec, applySchedule, formatTime, overlapWarning } from '../schedule.js'
/*
 * The tools of the three parallel workstreams live in their own files and are
 * grafted here. The model sees a single list; this file stays readable without
 * having to reread four hundred lines of CRUD to find an attachment tool, and
 * three agents could write at the same time without stepping on each other.
 */
import * as files from './tools-files.js'
import * as agenda from './tools-agenda.js'
import * as kb from './tools-kb.js'

const GRAFTS = [files, agenda, kb]

/**
 * The agent's tools, in the OpenAI function-calling format (what OpenCode Go
 * understands). They hit the very same SQLite base as the application: what the
 * agent does is visible in the interface at once.
 *
 * Each tool returns short, readable TEXT, not raw JSON: the model rereads its
 * own output on the next turn, a clear sentence costs it fewer tokens and reads
 * better than a structure.
 */

const fmt = tasks => tasks.length
  ? tasks.map(t => `${'  '.repeat(t.depth || 0)}[${t.checked ? 'x' : ' '}] #${t.id} ${t.content}${t.note ? ` // ${t.note}` : ''}${t.movedFrom ? ` (postponed from ${t.movedFrom})` : ''}`).join('\n')
  : '(nothing)'

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

// A rule is written by the user, in French or in English: both spellings of a
// day name point to the same day.
const WEEKDAY_NAMES = [
  ['sunday', 'dimanche'], ['monday', 'lundi'], ['tuesday', 'mardi'],
  ['wednesday', 'mercredi'], ['thursday', 'jeudi'], ['friday', 'vendredi'], ['saturday', 'samedi']
]

const dayNameOf = iso => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return WEEKDAYS[new Date(y, m - 1, d).getDay()]
}

/** A decimal number reads the English way: 3.2 and never 3,2. */
const oneDecimal = n => Number(n).toFixed(1)

const stripHashes = s => String(s || '').replace(/^\s*#+\s*/, '')

const timestamp = ms => {
  const d = new Date(ms)
  return `${today(d)} at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Which fixed day imposes itself on this group, and which rule says so.
 *
 * weekdayRule() names the culprit, groupWeekdays() gives the day number: both
 * are needed to refuse an addition AND to say in the name of what we refuse.
 * A refusal that does not quote its rule is just a whim.
 */
function fixedDay (name) {
  const r = weekdayRule(name)
  if (r) {
    const text = r.text.toLowerCase()
    const idx = WEEKDAY_NAMES.findIndex(names => names.some(n => text.includes(n)))
    if (idx >= 0) return { idx, rule: r }
  }
  const key = groupKey(name)
  if (!key) return null
  for (const [g, idx] of groupWeekdays()) {
    if (groupKey(g) !== key) continue
    const rg = weekdayRule(g)
    if (rg) return { idx, rule: rg }
  }
  return null
}

/**
 * An unsettled decision blocks both of its options (rules kind='block').
 * The rule expires by itself: as soon as the decision task is checked or gone,
 * we disable it on the way and let things in. Returns the refusal message, or
 * null if nothing blocks.
 */
function blockRefusal (content) {
  if (!content || content.length < 6) return null
  const rules = listRules().filter(r => r.kind === 'block')
  for (const r of rules) {
    let param = {}
    try { param = JSON.parse(r.param || '{}') } catch {}
    const decisionId = Number(String(param.until || '').replace('task:', ''))
    const decision = decisionId ? getTask(decisionId) : null
    if (!decision || decision.checked) { deleteRule(r.id); continue }
    const options = Array.isArray(param.options) ? param.options : []
    const hit = options.find(o => similar(o, content, 0.4))
    if (hit) {
      return `NOTHING ADDED. The decision "${decision.content}" (task ${decision.id}) is not settled, and this task looks like the option "${hit}". As long as the decision is not checked, both paths are blocked: offer to settle it first, or call again with force = true if they accept moving forward without deciding.`
    }
  }
  return null
}

/** The truly open lines of a day: neither checked, nor headings, nor asleep. */
const openLines = day => db.prepare(`
  SELECT COUNT(*) n FROM tasks t
  WHERE t.day = ? AND t.checked = 0 AND t.state = 'active' AND t.content <> ''
    AND TRIM(t.content) NOT LIKE '#%'
    AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id)`).get(day).n

/**
 * The real throughput and the backlog of the week.
 *
 * Computed in code, never left to the model: counting lines then dividing is
 * exactly the operation a model gets wrong, and a wrong figure on the load
 * shows at once. The throughput comes from the checked tasks, the only measure
 * of what the user really does; what is planned only measures what they hope.
 */
export function weekLoad ({ from = today(), days = 7, window = 28 } = {}) {
  const since = now() - window * 86400000
  const done = db.prepare('SELECT COUNT(*) n FROM tasks WHERE checked = 1 AND done_at >= ?').get(since).n
  const rate = done / window
  const perDay = []
  let backlog = 0
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i)
    const n = openLines(day)
    perDay.push({ day, n })
    backlog += n
  }
  const worst = perDay.reduce((a, b) => (b.n > a.n ? b : a), perDay[0])
  return { rate, done, window, backlog, days, perDay, worst, daysOfLoad: rate > 0 ? backlog / rate : null }
}

/**
 * The load warning, never a block.
 *
 * An agent that refuses too much becomes an obstacle people go around: the load
 * is flagged at the end of the sentence and the user decides. The threshold is a
 * multiple of the real throughput, not an arbitrary number: ten lines are a lot
 * for someone who checks three a day and normal for someone who checks eight.
 */
function loadWarning (day) {
  if (!day) return ''
  const { rate } = weekLoad({ days: 1, from: day })
  if (rate <= 0) return ''
  const n = openLines(day)
  // A floor of three lines: on a low throughput, 1.5 times the pace falls below
  // two tasks and the warning would fire on every single addition. A signal that
  // rings all the time stops being read.
  if (n < 3 || n <= rate * 1.5) return ''
  return `. By the way, this ${dayNameOf(day)} already has ${n} open line${n > 1 ? 's' : ''} for a real pace of ${oneDecimal(rate)} per day.`
}

const SHORTCUTS = `Shortcuts of the agenda editor:
- Enter: new line at the same level
- Ctrl+Enter: set or clear the checkbox of the line
- Ctrl+Shift+Enter: new line just below
- Shift+Enter: write the note under the line
- Tab / Shift+Tab: indent / outdent the line
- Ctrl+Up / Ctrl+Down: swap the line with the previous / next one
- Shift+Up / Shift+Down: extend the selection to the line above / below
- Ctrl+Shift+C: set or clear the checkbox
- Ctrl+Shift+X: number the selected lines in order
- Ctrl+B / Ctrl+I: bold / italic (markdown, rendered directly)
- Ctrl+\`: inline code on the line
- Ctrl+Shift+H: set or clear the heading (the markdown hashes)
- Ctrl+Shift+Backspace: delete the line
- Ctrl+K: choose the day of the line (calendar, or "Undated")
- Ctrl+Shift+K: choose the time of the line
- Ctrl+C / Ctrl+X: copy / cut the selected lines (their text also goes to the
  system clipboard, one task per line)
- Ctrl+V: paste the batch into the displayed day, or under the last selected line
- Ctrl+Z: undo the last gesture (the user's or the assistant's); Ctrl+Y or Ctrl+Shift+Z: redo
- j / k: next / previous day (outside typing)
- Backspace on an empty line: deletes the line

With the mouse as with a finger: the small rectangle on the left of each line is a handle.
You grab it and carry the line wherever you want. Dropping on the upper half of another
line inserts above, on the lower half below, and past the middle of the text it files it
as a sub-task. In day view, a bar of the seven days appears at the bottom during the
move: dropping on it sends the task to that day. A simple tap on the handle, without
moving, selects the line; dropping a line on itself does not move it.
On the phone, while writing in a line, a bar of buttons at the bottom repeats these
shortcuts: outdent, indent, up, down, check, note, time, day, delete, undo, redo.`

/* ------------------------------------------------------------------ */
/* Declarations sent to the model                                      */
/* ------------------------------------------------------------------ */

const defs = [
  ['current_date', "Today's date, tomorrow's, and the day of the week.", {}],
  ['list_day', "Lists the tasks of a day. Without an argument, today.", {
    day: ['string', 'YYYY-MM-DD']
  }],
  ['list_week', 'Lists the whole week containing this day.', { day: ['string', 'YYYY-MM-DD'] }],
  ['list_inbox', "Lists the tasks without a date (the inbox where anything with no day lands).", {}],
  ['search_tasks', 'Searches tasks by word, across all days. Used to find an identifier.', {
    query: ['string', 'word or piece of a sentence', true]
  }],
  ['stale_tasks', 'The tasks postponed most often, the ones that drag on.', { limit: ['number', ''] }],

  ['add_task', "Adds a task INSIDE A GROUP. group is the name of the group where it must live (\"deep work\", \"groceries\"...): it is the important parameter, a task placed outside a group is badly filed. Without day, it goes to the inbox. If the requested day contradicts a fixed-day rule, the tool adds nothing and tells you why: pass that refusal on to the user, and call the tool again with force = true only if they insist.", {
    content: ['string', 'text of the task', true],
    group: ['string', 'name of the group to file it in, the one the rules impose', true],
    day: ['string', 'YYYY-MM-DD'],
    parentId: ['number', 'exact identifier of the parent, instead of group if you know it'],
    note: ['string', 'note under the line'],
    at: ['string', "the time of the slot, as it is spoken: \"3pm\", \"15:30\", \"noon\", \"from 2pm to 4pm\". Fill it in as soon as the user announces a precise moment."],
    duration: ['string', "how long it takes: \"one hour\", \"45 min\", \"1h30\""],
    due: ['string', "YYYY-MM-DD: the date when the user THINKS they will have done it (\"I think I'll finish it on Friday\", \"by next week\"). It is a prediction, not a commitment: the task is NOT moved to that date, but if it is not done by the deadline, you will tell them as a prediction that did not hold."],
    force: ['boolean', 'override a fixed-day rule, only if the user has confirmed']
  }],
  ['update_task', 'Changes the text, the note, or checks/unchecks a task.', {
    id: ['number', '', true], content: ['string', ''], note: ['string', ''], checked: ['boolean', '']
  }],
  ['move_task', "Moves a task to another day, its sub-tasks follow. Empty day = send back to the inbox.", {
    id: ['number', '', true], day: ['string', 'YYYY-MM-DD, or empty for the inbox']
  }],
  ['reorder_task', "Files a task in a group (group, by its name) or under a precise parent (parentId), and/or just after another one (afterId).", {
    id: ['number', '', true],
    group: ['string', 'name of the group to file it in, it is created if it is missing that day'],
    parentId: ['number', 'new parent, 0 to bring it back up to the root'],
    afterId: ['number', 'place it just after this task']
  }],
  ['number_tasks', 'Numbers tasks in the given order: 1. 2. 3. An existing numbering is replaced.', {
    ids: ['array', 'identifiers in the wanted order', true], start: ['number', 'first number, 1 by default']
  }],
  ['delete_task', "Deletes a task. If it carries sub-tasks you did not create yourself just now, the tool refuses and lists them: empty it first, or move what is inside. Nothing is ever lost, a deletion goes to the trash and is repaired with undo_last.", {
    id: ['number', '', true],
    force: ['boolean', "delete anyway with everything inside, only if the user has confirmed"]
  }],
  ['add_many', "Adds SEVERAL tasks at once in the same group, in a single call. This is the tool to use as soon as the user dictates several in a row: one single action, none forgotten on the way, and the group is created by itself if it does not exist yet that day. Never chain five add_task when this one does the job.", {
    tasks: ['array', 'the tasks, one per entry, in order', true],
    group: ['string', 'name of the group that welcomes them all, created if needed', true],
    day: ['string', 'YYYY-MM-DD, otherwise they go to the inbox'],
    force: ['boolean', 'override a fixed-day rule, only if the user has confirmed']
  }],
  ['reorganize', "REORGANIZE in a single gesture: use it as soon as the user asks to review several days, to redistribute everything, to put their week back on its feet. You describe the WHOLE plan at once in `ops` and the tool applies it as a block: either everything goes through, or nothing moves. NEVER chain fifteen move_task to do this, you forget half of them on the way and the agenda ends up half filed. The whole batch is then undone with a single undo_last.", {
    ops: ['ops', 'the list of operations, in order. Each entry is an object: {"op":"add","content":"...","day":"YYYY-MM-DD","group":"..."} to create, {"op":"move","id":12,"day":"YYYY-MM-DD","group":"..."} to move or file (group alone files without changing the day), {"op":"rename","id":12,"content":"..."} to rewrite, {"op":"check","id":12} to check, {"op":"delete","id":12} to delete (goes to the trash)', true],
    why: ['string', 'in one sentence, what this reorganization is aiming at']
  }],
  ['undo_last', "Undoes the last grouped gesture: the tasks return to their previous day and box, what had been deleted comes back out of the trash, what had just been created leaves again. It is the answer to \"undo\", \"put it back the way it was\", \"you made a mess\".", {}],
  ['list_trash', "What was deleted recently and can still be recovered, with how many lines left each time.", {
    limit: ['number', 'how many entries, 10 by default']
  }],
  ['restore_task', "Brings back from the trash one precise deletion, with all its sub-tasks and their original identifiers.", {
    id: ['number', 'the number given by list_trash', true]
  }],
  ['decompose_task', "Breaks a task that is too big into simple steps filed under it.", {
    id: ['number', '', true], steps: ['array', 'the steps, in order', true]
  }],

  ['wait_for', "Puts a task in escrow: it waits for someone or something and no longer moves on its own. Use it as soon as the user says \"I'm waiting for the plumber's answer\", \"it's blocked until the client signs\". The night review will no longer postpone it, it comes back by itself on the follow-up date, or on its own as soon as the condition becomes true in a conversation.", {
    id: ['number', '', true],
    who: ['string', "who or what we are waiting for: \"the plumber\", \"the client's signature\"", true],
    until: ['string', 'YYYY-MM-DD, follow-up date at which it becomes active again'],
    condition: ['string', "the condition, in the user's language, that releases it by itself as soon as it becomes true: \"The plumber answered\", \"the API key arrived\""]
  }],
  ['unblock', "Unblocks a task: it becomes active again and returns to the normal flow. Use it when what we were waiting for has arrived, or when a pause is lifted early.", {
    id: ['number', '', true], day: ['string', 'YYYY-MM-DD where to place it, otherwise it stays on its day']
  }],
  ['park', "Puts a line in the waiting circuit because it is not an action: \"think about X\", \"see if we do Y\". None of that can be checked, so without this state it travels from day to day forever. What is parked stays visible but no longer weighs on the day.", {
    id: ['number', '', true]
  }],
  ['pause_task', "Sets a project aside until a precise date. Neither active nor dead: it sleeps, the night review passes it by, and it wakes up by itself on the given day.", {
    id: ['number', '', true],
    until: ['string', 'YYYY-MM-DD, the wake-up day', true],
    why: ['string', 'why we are setting it aside']
  }],
  ['archive_task', "Archives a finished or abandoned project while keeping what we learned from it. The screen empties, the knowledge enters memory: that is the whole difference between archiving and throwing away.", {
    id: ['number', '', true],
    learned: ['string', 'what we retain from this project, one declarative sentence', true]
  }],
  ['list_parked', "Everything that sleeps: in escrow, parked, paused, archived, with since when and the wake-up date. Without an argument, everything.", {
    state: ['string', 'waiting, parked, paused or archived to see only one state']
  }],

  ['add_rule', "Records a lasting RULE that drives automatic filing (for example: groceries stay on Saturday). Use it as soon as the user expresses a fixed habit or a prohibition.", {
    text: ['string', 'the rule, one sentence in the user\'s language', true]
  }],
  ['forget_rule', 'Disables a rule that has become false.', { id: ['number', '', true] }],
  ['suspend_rule', "Puts a rule under observation instead of deleting it: it files nothing more until the date, but it stays known and can come back. Prefer it to forget_rule when the rule files badly without being false for all that.", {
    id: ['number', '', true],
    days: ['number', 'how many days of sleep, 14 by default'],
    why: ['string', 'why we put it under observation']
  }],
  ['rule_health', "The health of the rules: how many times each one filed, how many times the user undid behind it, and which ones sleep. Call it when they ask \"why did my task go there\" or when a rule seems to file badly.", {}],
  ['load_check', "The load of the week, in exact figures: the real pace (tasks checked per day over the last 28 days), the backlog of the next 7 days, and the busiest day. Use these numbers as they are, do not recount anything.", {}],
  ['why_moved', "Why this task is where it is: the last five moves, who made them (the night, the user, you) and in the name of which rule.", {
    id: ['number', '', true]
  }],
  ['remember', "Remembers a FACT about the user that is not a filing rule: preference, context, way of working. Use it as soon as they teach you something about themselves.", {
    text: ['string', 'the fact, one short sentence', true]
  }],
  ['forget', 'Forgets a fact that has become false.', { id: ['number', '', true] }],

  ['end_day', "Closes a day: everything not checked goes to the next day, or to the next fixed day of the group if the rules impose one. Checked tasks stay on their day, they do not follow. Call it as soon as they say \"push everything to tomorrow\", \"I won't do anything today\", \"close my day\".", {
    day: ['string', 'the day to close, YYYY-MM-DD, today by default'],
    dryRun: ['boolean', 'announce without moving anything']
  }],
  ['list_reviews', 'The recent night tidy-ups, with what each one moved and its number.', {
    limit: ['number', 'how many tidy-ups, 5 by default']
  }],
  ['undo_review', "Undoes a night tidy-up: each task returns to its original day. Without a number, undoes the last tidy-up that moved something.", {
    id: ['number', 'the number of the tidy-up, the one given by list_reviews']
  }],
  ['keyboard_help', "The list of the keyboard shortcuts of the application. Call it as soon as the user asks how to do something with the keyboard.", {}],
  ['rename_thread', 'Renames the current conversation so it can be found again.', { title: ['string', '', true] }],

  ['create_decision', "Creates a DECISION THAT BLOCKS: a task \"Decide: A or B\", and as long as it is not checked, any task addition that looks like option A or B is refused and sent back to the decision. Use it when the user hesitates between two paths and keeps stacking tasks on both sides instead of settling.", {
    optionA: ['string', 'the first path, in a few words', true],
    optionB: ['string', 'the second path', true],
    day: ['string', 'YYYY-MM-DD where to place the decision, today by default']
  }],
  ['list_candidates', "The candidate rules of the engine: what it inferred from the user's corrections, with their status (testing, proposed) and their evidence. Call it when they ask what you have learned or noticed about their filing.", {}],
  ['promote_rule', "Records a candidate rule as an active rule. ONLY when the user has just said yes to a rule proposal: never on your own initiative, it is their word that promotes.", {
    candidateId: ['number', 'the number of the proposed candidate', true]
  }],
  ['reject_rule', "Buries a candidate rule refused by the user: it will NEVER be proposed again. Call it when they say no to a rule proposal.", {
    candidateId: ['number', 'the number of the candidate', true]
  }]
]

/*
 * `ops` describes an array of heterogeneous objects: a reorganization mixes
 * creations, moves and rewrites. It is deliberately declared open
 * (additionalProperties) rather than as a strict union: an open model respects a
 * union badly and would lose a whole turn getting its call refused, whereas the
 * handler knows how to ignore what it does not understand.
 */
const JS_TYPE = {
  array: { type: 'array', items: { type: 'string' } },
  ops: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: true,
      properties: {
        op: { type: 'string', enum: ['add', 'move', 'rename', 'check', 'delete'] },
        id: { type: 'number' },
        content: { type: 'string' },
        day: { type: 'string' },
        group: { type: 'string' },
        note: { type: 'string' }
      },
      required: ['op']
    }
  }
}

// The declarations are grafted before the schemas are computed: `toolSchemas` is
// frozen at module evaluation, a later graft would be invisible to the model.
for (const g of GRAFTS) defs.push(...(g.defs || []))

export const toolSchemas = defs.map(([name, description, props]) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(props).map(([k, [t, d]]) => [
        k, { ...(JS_TYPE[t] || { type: t }), ...(d ? { description: d } : {}) }
      ])),
      required: Object.entries(props).filter(([, v]) => v[2]).map(([k]) => k)
    }
  }
}))

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

const num = v => (v === '' || v == null ? null : Number(v))

const handlers = {
  current_date: () => {
    const d = today()
    const [y, m, dd] = d.split('-').map(Number)
    return `today ${d} (${WEEKDAYS[new Date(y, m - 1, dd).getDay()]}), tomorrow ${addDays(d, 1)}`
  },
  list_day: ({ day }) => `${day || today()}\n${fmt(listDay(day || today()))}`,
  list_week: ({ day }) => Object.entries(listWeek(weekStart(day || today())))
    .map(([d, ts]) => `## ${d}\n${fmt(ts)}`).join('\n\n'),
  list_inbox: () => fmt(listInbox()),
  search_tasks: ({ query }) => {
    const rows = db.prepare("SELECT id, content, day, checked FROM tasks WHERE content LIKE ? ORDER BY day DESC LIMIT 25")
      .all(`%${String(query || '')}%`)
    return rows.length
      ? rows.map(r => `#${r.id} ${r.content} (${r.day || 'inbox'})${r.checked ? ' [done]' : ''}`).join('\n')
      : `Nothing containing "${query}"`
  },
  stale_tasks: ({ limit }) => stalest(num(limit) || 5)
    .map(s => `#${s.id} ${s.content}, ${s.move_count} postponement(s), currently on ${s.day}`).join('\n') || '(none)',

  /**
   * The filing is imposed here, not hoped for from the model.
   *
   * Without a group, the task landed at the root of the day and the day became a
   * flat list that ignored the rules. We therefore refuse the bare addition as
   * long as a group is possible, returning the list of the day's groups: the
   * model rereads that answer and calls the tool again with the right name. The
   * escape hatch group="root" exists for the cases where no group really fits,
   * otherwise a legitimate addition could never go through.
   */
  add_task: ({ content, day, group, parentId, note, force, at, duration, due }, ctx) => {
    const when = day || null
    let parent = num(parentId)
    const name = String(group || '').trim()
    const free = /^(root|none|null|racine|aucun|rien)$/i.test(name)

    /*
     * The only mechanical refusal of the tool, and it is deliberately narrow.
     *
     * An agent that accepts everything, including what contradicts a rule the
     * user taught it themselves, has no word: the rule only served to decorate
     * the prompt. We therefore block before resolving the group, otherwise a
     * refusal would leave behind an empty box created on the wrong day.
     * `force` exists because it is the user who settles, not us.
     */
    if (when && name && !free && !force) {
      const fixed = fixedDay(name)
      const target = dayNameOf(when)
      if (fixed?.rule && target !== WEEKDAYS[fixed.idx]) {
        const next = nextWeekday(fixed.idx, today())
        return `NOTHING ADDED. Rule ${fixed.rule.id} says: "${fixed.rule.text}", so "${name}" is on ${WEEKDAYS[fixed.idx]}, and you are asking me to place "${content}" on a ${target} (${when}). The next ${WEEKDAYS[fixed.idx]} is ${next}. If the user confirms they really want this ${target}, call add_task again with force = true.`
      }
    }

    /*
     * The ghost decision: an unsettled decision blocks both of its options.
     * We check here, after the fixed-day refusal and before resolveGroup, for the
     * same reasons. The rule disables itself as soon as the decision task is
     * checked or gone: lazy check, no hook.
     */
    if (!force) {
      const refusal = blockRefusal(String(content || ''))
      if (refusal) return refusal
    }

    if (!parent && when && !free) {
      if (name) parent = resolveGroup(when, name)
      else {
        // A still empty day has no group: we then offer those of the previous
        // days, otherwise nothing would stop the day from starting flat again.
        const available = dayGroups(when)
        const names = (available.length ? available : usualGroups({ from: when }))
          .map(g => `"${g.content.replace(/^#+\s*/, '')}"`)
        if (names.length) {
          return `NOTHING ADDED. The group is missing. Groups ${available.length ? `of ${when}` : 'usually used'}: ${names.join(', ')}. Call add_task again with group = the one the rules impose, a new group name if none fits, or group="root" if this task really goes in no group.`
        }
      }
    }

    // All the tasks born from the same turn carry the same session mark: a
    // sentence dictated while walking sometimes produces nine at once, which
    // counts as nine victories whereas it is often an unload. The mark blocks
    // nothing, it just makes the burst recognizable later.
    const t = createTask({ content, day: when, parentId: parent, note: note || '', sessionId: ctx?.sessionId || null })
    const under = t.parentId ? ` under "${getTask(t.parentId)?.content.replace(/^#+\s*/, '')}"` : ''
    // The time is set in the same turn as the addition. In two separate calls, it
    // is one more turn for every appointment, and one forgotten out of three.
    let time = ''
    if (at) {
      const parsed = parseTimeSpec(at)
      if (parsed.startAt) {
        applySchedule(t.id, { at: parsed.startAt, duration: duration ?? parsed.durationMin })
        time = ` at ${formatTime(parsed.startAt)}`
      }
    }
    // The prediction: the date when they THINK they will have done it. It drives
    // no move, it only arms the truth appointment at the deadline.
    let expected = ''
    if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) {
      db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(due, t.id)
      expected = `, prediction noted for ${due}`
    }
    return `Added #${t.id} "${t.content}"${under}${t.day ? ` on ${t.day}` : ' to the inbox'}${time}${expected}${loadWarning(t.day)}${time ? overlapWarning(t.day, t.id) : ''}`
  },
  update_task: ({ id, ...patch }, ctx) => {
    const clean = {}
    for (const k of ['content', 'note', 'checked']) if (patch[k] !== undefined) clean[k] = patch[k]
    const t = updateTask(num(id), clean)
    return t ? `Updated #${t.id} "${t.content}"${t.checked ? ' (checked)' : ''}` : `Task #${id} not found`
  },
  move_task: ({ id, day }) => {
    // actor 'agent' and not 'user': the gesture does come from them, but it went
    // through speech. The log must be able to tell WHO moved the line, otherwise
    // "why is it there" always answers the same thing.
    // The day BEFORE is read before the move: that is the one the Google
    // synchronization will restore, and announcing it after the fact would give
    // the new date, hence a message that contradicts itself.
    const originalDay = getTask(num(id))?.day
    const t = moveTask(num(id), day || null, { actor: 'agent', reason: 'asked in the chat' })
    if (!t) return `Task #${id} not found`
    // A Google Calendar appointment lets itself be moved when the user asks, but
    // the synchronization will put it back in place within the quarter hour: it
    // must be SAID, otherwise the agent announces a success that will be undone
    // before their eyes and loses its credibility on the only subject it handles.
    if (t.source === 'gcal') {
      return `#${t.id} "${t.content}" moved to ${t.day || 'the inbox'}, BUT it is a Google Calendar appointment: ` +
        `the synchronization will put it back on ${originalDay} within fifteen minutes. To change it for real, move it in Google Calendar.`
    }
    return `#${t.id} "${t.content}" moved to ${t.day || 'the inbox'}`
  },
  reorder_task: ({ id, group, parentId, afterId }, ctx) => {
    const cur = getTask(num(id))
    if (!cur) return `Task #${id} not found`
    let p = parentId === undefined ? undefined : (Number(parentId) === 0 ? null : num(parentId))
    // The group name wins: it is what the agent handles best, and it creates the
    // box if it is still missing that day.
    if (p === undefined && group) p = resolveGroup(cur.day, String(group))
    const t = reorderTask(num(id), {
      parentId: p === undefined ? cur.parentId ?? null : p,
      afterId: num(afterId),
      actor: 'agent',
      reason: 'filed from the chat'
    })
    const name = t?.parentId ? getTask(t.parentId)?.content.replace(/^#+\s*/, '') : null
    return t ? `#${t.id} "${t.content}" filed${name ? ` under "${name}"` : ' at the root'}` : `Task #${id} not found`
  },
  number_tasks: ({ ids, start }, ctx) => {
    const list = (Array.isArray(ids) ? ids : String(ids || '').split(/[,\s]+/)).map(Number).filter(Boolean)
    const before = list.map(i => { const t = getTask(i); return t ? { id: t.id, fields: { content: t.content }, label: t.content } : null }).filter(Boolean)
    const out = numberTasks(list, { start: num(start) || 1 })
    return out.length ? `Numbered: ${out.map(t => t.content).join(' | ')}` : 'No task to number'
  },
  /**
   * The guard rail that was missing, and it cost fourteen tasks.
   *
   * The agent had moved lines without detaching their parent, so the Thursday
   * group looked empty, it deleted it, and the cascade carried away everything
   * that lived elsewhere but still belonged to it. The root cause is fixed in
   * moveTask, but we no longer let a model decide alone to empty a box it did not
   * fill: what it did not create in THIS turn, it does not delete without the
   * user having said yes.
   */
  delete_task: ({ id, force }, ctx) => {
    const t = getTask(num(id))
    if (!t) return `Task #${id} not found`
    // A calendar appointment is deleted like the rest: the thrown key is kept, it
    // does not come back, and Google is never touched (the link is read-only).
    // The refusal that lived here dated from before that mechanism.
    if (t.source === 'gcal') {
      const n = deleteTask(num(id), { actor: 'agent', reason: 'thrown away from the chat', batchId: ctx?.sessionId || null })
      return `Deleted "${stripHashes(t.content)}"${n > 1 ? ` and the ${n - 1} other day(s) of the same event` : ''}. ` +
        `It will not come back on the next synchronizations, and your Google Calendar was not touched. "undo" is enough to give it all back.`
    }
    const children = db.prepare('SELECT id, content, session_id FROM tasks WHERE parent_id = ?').all(num(id))
    const notMine = children.filter(k => !ctx?.sessionId || k.session_id !== ctx.sessionId)
    if (notMine.length && !force) {
      const list = notMine.slice(0, 8).map(k => `#${k.id} ${stripHashes(k.content)}`).join(', ')
      return `NOTHING DELETED. "${stripHashes(t.content)}" carries ${notMine.length} line(s) that I did not create just now: ${list}${notMine.length > 8 ? '…' : ''}. Deleting them would carry all that away. Move them elsewhere first, or ask the user whether they really want to throw everything away and call delete_task again with force = true.`
    }
    const n = deleteTask(num(id), { actor: 'agent', reason: 'deleted from the chat', batchId: ctx?.sessionId || null })
    return `Deleted #${id} "${stripHashes(t.content)}"${n > 1 ? ` and the ${n - 1} line(s) below` : ''}. It is in the trash, "undo" is enough to give it all back.`
  },

  /**
   * A dictated burst is placed in ONE call.
   *
   * The user often dictates six things in a row. In six add_task, the agent
   * forgot half of them on the way ("you didn't finish writing everything I
   * wanted"), and each call started again from a state that had already changed.
   * Here everything lands as one block, in a group created if needed: it is also
   * what they were asking for when they said a group heading must appear by
   * itself when they give several things.
   */
  add_many: ({ tasks, group, day, force }, ctx) => {
    const list = (Array.isArray(tasks) ? tasks : String(tasks || '').split('\n'))
      .map(s => String(s || '').trim()).filter(Boolean)
    if (!list.length) return 'NOTHING ADDED. The list is empty.'
    const when = day || null
    const name = String(group || '').trim()
    const free = /^(root|none|null|racine|aucun|rien)$/i.test(name)

    if (when && name && !free && !force) {
      const fixed = fixedDay(name)
      const target = dayNameOf(when)
      if (fixed?.rule && target !== WEEKDAYS[fixed.idx]) {
        const next = nextWeekday(fixed.idx, today())
        return `NOTHING ADDED. Rule ${fixed.rule.id} says: "${fixed.rule.text}", so "${name}" is on ${WEEKDAYS[fixed.idx]}, and you are asking me to place ${list.length} line(s) on a ${target} (${when}). The next ${WEEKDAYS[fixed.idx]} is ${next}. If the user confirms, call again with force = true.`
      }
    }

    const parent = when && !free && name ? resolveGroup(when, name) : null
    const made = []
    const tx = db.transaction(() => {
      for (const c of list) {
        made.push(createTask({ content: c, day: when, parentId: parent, sessionId: ctx?.sessionId || null }))
      }
    })
    tx()
    const where = parent ? ` under "${stripHashes(getTask(parent)?.content || name)}"` : ''
    // The session receipt: six lines or more at once is a mental unload, not a
    // plan (the session detector in night.js measures it on the session_id
    // already set). We say it at the very moment, so that the user knows the
    // burst will be reread in a few days instead of counting as a plan.
    const receipt = made.length >= 6
      ? `\n\nThat is ${made.length} at once: I note that it is an unload, not a plan. We will look at what is left of it in a few days.`
      : ''
    return `${made.length} task(s) added${where}${when ? ` on ${when}` : ' to the inbox'}: ${made.map(t => `#${t.id} ${t.content}`).join(' | ')}${loadWarning(when)}${receipt}`
  },

  /**
   * Reorganize as a block, or not at all.
   *
   * A week reorganization used to go out as fifteen independent tool calls. By
   * the ninth, the agent was reasoning on an agenda that no longer existed: it
   * created duplicates, forgot some, and there was no way to undo the whole
   * thing. Everything goes through here in a single SQLite transaction, and the
   * whole batch carries the same batch_id: a single undo_last undoes it entirely.
   *
   * The operations are a FLAT list, deliberately. A nested schema (days, then
   * groups, then tasks) reads better for a human, but an open model produces it
   * badly, and a structure error loses a whole turn.
   */
  reorganize: ({ ops, why }, ctx) => {
    const list = Array.isArray(ops) ? ops : []
    if (!list.length) return 'NOTHING DONE. Describe the operations in `ops`, one per line to change.'

    /*
     * We check the WHOLE plan before applying a single line of it.
     *
     * Without this pass, a `rename` whose content arrived as an object quietly
     * wrote "[object Object]" into the task: the transaction did not fail, so
     * nothing protected us. A half-sensible plan must be refused entirely and
     * handed back to the model, not executed halfway.
     */
    const isText = v => v === undefined || v === null || typeof v === 'string' || typeof v === 'number'
    const NEEDS_ID = new Set(['move', 'rename', 'check', 'delete'])
    const problems = []
    list.forEach((o, i) => {
      const op = String(o?.op || '').toLowerCase()
      const at = `operation ${i + 1}`
      if (!['add', 'move', 'rename', 'check', 'delete'].includes(op)) { problems.push(`${at}: "${o?.op}" does not exist, use add, move, rename, check or delete`); return }
      if (NEEDS_ID.has(op) && !Number.isFinite(Number(o?.id))) { problems.push(`${at} (${op}): the task identifier is missing`); return }
      for (const k of ['content', 'day', 'group', 'note']) {
        if (!isText(o?.[k])) problems.push(`${at} (${op}): ${k} must be text, not ${typeof o[k]}`)
      }
      if ((op === 'add' || op === 'rename') && !String(o?.content ?? '').trim()) problems.push(`${at} (${op}): the task text is empty`)
      if (o?.day && !/^\d{4}-\d{2}-\d{2}$/.test(String(o.day))) problems.push(`${at}: "${o.day}" is not a YYYY-MM-DD date`)
    })
    if (problems.length) {
      return `NOTHING CHANGED, the plan was refused entirely before being applied:\n${problems.join('\n')}\nThe agenda is exactly as before. Fix these points and call reorganize again with the complete plan.`
    }

    const batch = ctx?.sessionId || `r${Date.now()}`
    const log = []
    const failed = []

    const tx = db.transaction(() => {
      for (const o of list) {
        const op = String(o?.op || '').toLowerCase()
        const id = num(o?.id)
        if (op === 'add') {
          const when = o.day || null
          const parent = when && o.group && !/^(root|none|racine|aucun)$/i.test(o.group) ? resolveGroup(when, String(o.group)) : null
          const t = createTask({ content: String(o.content || '').trim(), day: when, parentId: parent, note: o.note || '', sessionId: batch })
          log.push(`+ #${t.id} ${t.content}${when ? ` on ${when}` : ' to the inbox'}`)
          continue
        }
        const cur = id ? getTask(id) : null
        if (!cur) { failed.push(`#${o?.id} not found (${op})`); continue }
        if (op === 'move') {
          const when = o.day === undefined ? cur.day : (o.day || null)
          let t = cur
          if ((when ?? null) !== (cur.day ?? null)) {
            t = moveTask(id, when, { actor: 'agent', reason: why || 'reorganization', batchId: batch })
          }
          if (o.group) {
            const p = /^(root|none|racine|aucun)$/i.test(o.group) ? null : resolveGroup(when, String(o.group))
            t = reorderTask(id, { parentId: p, day: when, actor: 'agent', reason: why || 'reorganization', batchId: batch }) || t
          }
          log.push(`→ #${id} ${stripHashes(cur.content)} ${when ? `on ${when}` : 'to the inbox'}${o.group ? ` in "${o.group}"` : ''}`)
          continue
        }
        if (op === 'rename') {
          updateTask(id, { content: String(o.content || '').trim(), ...(o.note !== undefined ? { note: o.note } : {}) })
          log.push(`✎ #${id} ${o.content}`)
          continue
        }
        if (op === 'check') {
          updateTask(id, { checked: true })
          log.push(`✓ #${id} ${stripHashes(cur.content)}`); continue
        }
        if (op === 'delete') {
          const n = deleteTask(id, { actor: 'agent', reason: why || 'reorganization', batchId: batch })
          log.push(`− #${id} ${stripHashes(cur.content)}${n > 1 ? ` (+${n - 1} below)` : ''}`)
          continue
        }
        failed.push(`unknown operation "${op}" on #${o?.id}`)
      }
      // The invariant is checked INSIDE the transaction: a reorganization that
      // leaves a child attached to another day is exactly the state that lost
      // fourteen tasks, it must not be able to be committed.
      checkTree({ repair: true })
    })

    try { tx() } catch (e) {
      return `NOTHING CHANGED, everything was cancelled: ${e.message}. The agenda is exactly as before, nothing is half done. Fix your plan and call reorganize again.`
    }
    const leftover = failed.length ? `\nNot done: ${failed.join(' ; ')}.` : ''
    return `${log.length} operation(s) applied as one block${why ? ` (${why})` : ''}:\n${log.join('\n')}${leftover}\nA single "undo" puts everything back as before.`
  },

  /**
   * "Undo", "put it back the way it was", "you made a mess".
   *
   * Goes through the shared history (server/history.js): the previous turn of the
   * agent is undone entirely, exactly like a Ctrl+Z on the screen, and redone
   * with Ctrl+Y. Never the current turn, otherwise "undo" would undo the very
   * sentence asking for it.
   */
  undo_last: (_a, ctx) => {
    const r = undoGesture({ author: 'agent', except: ctx?.sessionId ? `agent:${ctx.sessionId}` : null })
    if (!r.ok) return 'I have no recent gesture to undo.'
    const days = r.days.length ? ` Days touched: ${r.days.join(', ')}.` : ''
    return `Undone: ${r.gesture.label || 'my last turn'}.${days} Ctrl+Y on the screen redoes it if needed.`
  },

  list_trash: ({ limit }) => {
    const l = listTrash({ limit: Math.min(30, num(limit) || 10) })
    if (!l.length) return 'The trash is empty, nothing was deleted recently.'
    return l.map(r => `#${r.id} · ${stripHashes(r.root_content)} · ${r.count} line(s) · ${timestamp(r.created_at)} · by ${r.actor}${r.reason ? ` (${r.reason})` : ''}`).join('\n')
  },
  restore_task: ({ id }, ctx) => {
    const out = restoreTrash(num(id))
    if (!out.ok) return `Impossible: ${out.error}`
    return `${out.count} line(s) restored: ${out.restored.map(r => `#${r.id} ${stripHashes(r.content)}`).join(', ')}`
  },
  decompose_task: ({ id, steps }, ctx) => {
    const parent = getTask(num(id))
    if (!parent) return `Task #${id} not found`
    const list = Array.isArray(steps) ? steps : String(steps || '').split('\n').filter(Boolean)
    const born = []
    for (const s of list) born.push(createTask({ content: String(s).trim(), day: parent.day, parentId: parent.id, sessionId: ctx?.sessionId || null }))
    return `#${id} "${parent.content}" split into ${list.length}: ${list.join(', ')}`
  },

  /*
   * The states: everything that is neither done nor doable right now.
   *
   * Before, a line blocked by someone else travelled from day to day until it
   * was deleted out of weariness. Each state takes the line out of the flow
   * without killing it, and gives it a way out: a wake-up date, or the user
   * unblocking it.
   */
  wait_for: ({ id, who, until, condition }, ctx) => {
    const t = setState(num(id), 'waiting', { waitingOn: String(who || '').trim(), wakeAt: until || null })
    if (!t) return `Task #${id} not found`
    // The release condition, in the user's language: releasing a task no longer
    // necessarily waits for a date, the sentence "The plumber answered" in a
    // conversation is enough.
    let release = ''
    if (condition && String(condition).trim()) {
      db.prepare('UPDATE tasks SET escrow_condition = ? WHERE id = ?').run(String(condition).trim(), t.id)
      release = ` It will release itself as soon as "${String(condition).trim()}".`
    }
    const followUp = t.wakeAt ? ` I will bring it back out on ${t.wakeAt}.` : (release ? '' : ' It will wait as long as you do not tell me it is unblocked.')
    return `#${t.id} "${t.content}" is in escrow: it is waiting for ${t.waitingOn}. It will not move on its own any more.${followUp}${release}`
  },
  unblock: ({ id, day }, ctx) => {
    const t = setState(num(id), 'active')
    if (!t) return `Task #${id} not found`
    if (day) moveTask(num(id), day, { actor: 'agent', reason: 'unblocked' })
    const where = day ? ` on ${day}` : (t.day ? ` on ${t.day}` : ' in the inbox')
    return `#${t.id} "${t.content}" becomes active again${where}. It returns to the normal flow.`
  },
  park: ({ id }, ctx) => {
    const t = setState(num(id), 'parked')
    if (!t) return `Task #${id} not found`
    return `#${t.id} "${t.content}" goes to the waiting circuit: it is not an action, it cannot be checked, so it stops travelling from day to day. It stays visible in what sleeps.`
  },
  pause_task: ({ id, until, why }, ctx) => {
    if (!until) return 'NOTHING DONE. A pause without a wake-up date is a disguised abandonment: give me the day it resumes.'
    const t = setState(num(id), 'paused', { wakeAt: until, note: why || '' })
    if (!t) return `Task #${id} not found`
    return `#${t.id} "${t.content}" sleeps until ${until}${why ? ` (${why})` : ''}. The night review passes it by, and it wakes up by itself on that day.`
  },
  archive_task: ({ id, learned }, ctx) => {
    const knowledge = String(learned || '').trim()
    if (!knowledge) return 'NOTHING DONE. Archiving without saying what we retain from it is throwing away. Give me what this project taught you.'
    const t = setState(num(id), 'archived', { note: knowledge })
    if (!t) return `Task #${id} not found`
    // The knowledge outlives the project: it is the only difference between
    // archiving and deleting, and it rests on this single line.
    rememberFact(knowledge, 'archive')
    return `#${t.id} "${t.content}" is archived. The screen empties, the knowledge stays: I remembered "${knowledge}".`
  },
  list_parked: ({ state }) => {
    const wanted = String(state || '').trim() || null
    const rows = listParked(wanted)
    if (!rows.length) return wanted ? `Nothing in state "${wanted}".` : 'Nothing is sleeping right now, everything is active.'
    const by = new Map()
    for (const t of rows) {
      if (!by.has(t.state)) by.set(t.state, [])
      by.get(t.state).push(t)
    }
    const out = []
    for (const [s, list] of by) {
      out.push(`${STATE_LABEL[s] || s} (${list.length}):`)
      for (const t of list) {
        const bits = []
        if (t.waitingOn) bits.push(`waiting for ${t.waitingOn}`)
        if (t.stateAt) bits.push(`since ${today(new Date(t.stateAt))}`)
        if (t.wakeAt) bits.push(`wakes on ${t.wakeAt}`)
        if (t.stateNote) bits.push(t.stateNote)
        out.push(`  #${t.id} ${stripHashes(t.content)}${bits.length ? ` · ${bits.join(', ')}` : ''}`)
      }
    }
    return out.join('\n')
  },

  add_rule: ({ text }) => {
    const r = addRule(String(text), 'agent')
    if (r.merged) return `Rule already known, nothing new: ${r.text}`
    const wd = groupWeekdays()
    const extra = wd.size ? ` (known fixed days: ${[...wd.keys()].join(', ')})` : ''
    return `Rule ${r.id} recorded: ${r.text}${extra}`
  },
  forget_rule: ({ id }) => { deleteRule(num(id)); return `Rule ${id} disabled` },
  /* A rule is a medicine: we stop it for a while to see, we do not burn it.
     A deleted rule takes with it the reason that had brought it to life. */
  suspend_rule: ({ id, days, why }, ctx) => {
    const n = Math.max(1, num(days) || 14)
    const until = addDays(today(), n)
    const r = suspendRule(num(id), { until, reason: String(why || '').trim() })
    if (!r) return `Rule ${id} not found`
    // The sleep of a rule is undone too: Ctrl+Z wakes it up.
    return `Rule ${r.id} put under observation until ${until} (${n} days): "${r.text}". It files nothing more until then, but I keep it in mind${why ? `, reason: ${why}` : ''}.`
  },
  rule_health: () => {
    const rules = listRules({ all: true })
    if (!rules.length) return 'No rule recorded yet.'
    const d = today()
    return rules.map(r => {
      const asleep = r.suspended_until && r.suspended_until > d
      const record = r.applied
        ? `has filed ${r.applied} times, you have undone ${r.overridden} times behind it`
        : 'has filed nothing yet'
      const health = r.applied && r.overridden >= r.applied / 2
        ? ' It gets undone one time out of two, it is probably wrong.'
        : ''
      const sleep = asleep
        ? ` It sleeps until ${r.suspended_until}${r.suspended_reason ? ` (${r.suspended_reason})` : ''} and drives nothing any more.`
        : ''
      return `Rule ${r.id} "${r.text}": ${record}.${health}${sleep}`
    }).join('\n')
  },
  load_check: () => {
    const c = weekLoad()
    const backlog = `There are ${c.backlog} open tasks over the next ${c.days} days`
    const worst = c.worst && c.worst.n
      ? ` ${dayNameOf(c.worst.day)} ${c.worst.day} is the busiest with ${c.worst.n} lines.`
      : ''
    if (!c.rate) {
      return `You have checked no task over the last ${c.window} days, I cannot compute your real pace. ${backlog}.${worst}`
    }
    return `You check ${oneDecimal(c.rate)} task${c.rate >= 2 ? 's' : ''} per day on average. ${backlog}, i.e. ${Math.round(c.daysOfLoad)} days of load for ${c.days} days of week.${worst}`
  },
  /* The memory of the move, not only its result. Without this log, a task that
     jumped from Tuesday to Saturday had no explanation to offer. */
  why_moved: ({ id }) => {
    const t = getTask(num(id))
    const rows = db.prepare('SELECT * FROM moves WHERE task_id = ? ORDER BY id DESC LIMIT 5').all(num(id))
    if (!rows.length) return t ? `#${t.id} "${t.content}" has never moved since it was created.` : `Task #${id} not found`
    const WHO = { auto: 'the night review', user: 'the user themselves', agent: 'me' }
    const rules = new Map(listRules({ all: true }).map(r => [r.id, r.text]))
    const lines = rows.map(m => {
      const journey = (m.from_day || 'the inbox') === (m.to_day || 'the inbox')
        ? `filed it in "${m.group_key || 'the root'}"`
        : `sent it from ${m.from_day || 'inbox'} to ${m.to_day || 'inbox'}`
      const because = m.rule_id && rules.has(m.rule_id)
        ? `, in the name of rule ${m.rule_id}: "${rules.get(m.rule_id)}"`
        : (m.reason ? `, reason: ${m.reason}` : '')
      return `- ${timestamp(m.created_at)}, ${WHO[m.actor] || m.actor} ${journey}${because}.`
    })
    return `#${id} "${t ? t.content : rows[0].content}", its last ${rows.length} moves:\n${lines.join('\n')}`
  },
  remember: ({ text }) => {
    const f = rememberFact(String(text), 'agent')
    if (!f) return 'Fact too short, nothing remembered'
    return f.merged ? `Already known, memory reinforced: ${f.text}` : `Remembered: ${f.text}`
  },
  forget: ({ id }) => { forgetFact(num(id)); return `Fact ${id} forgotten` },

  /* Same engine as the night review, triggered by voice. It is the answer to
     "push everything to tomorrow": a single call files the whole day, where the
     agent used to chain ten move_task and forget half of them. */
  end_day: ({ day, dryRun }) => {
    const plan = runReview({ day: day || today(), dryRun: !!dryRun })
    const moved = plan.postponed.length + plan.weekly.length
    if (!moved) return `${plan.day}: nothing to postpone, everything is checked or empty.`
    return `${plan.summary}\nThe ${plan.done.length} checked task(s) stay on ${plan.day}.`
  },
  /* The night tidy-up no longer has a screen: this is where it becomes
     verifiable and undoable again, by simply asking the assistant. */
  list_reviews: ({ limit }) => {
    const l = listReviews(Math.min(20, num(limit) || 5))
    if (!l.length) return 'No night tidy-up so far.'
    return l.map(r => {
      const where = [...r.postponed, ...r.weekly].map(x => `${x.content} → ${x.to}`).join(', ')
      return `#${r.id} · night of ${r.day} · ${r.moved} moved${r.undone ? ' · ALREADY UNDONE' : ''}: ${where}`
    }).join('\n')
  },
  undo_review: ({ id }) => {
    let target = num(id)
    if (!target) {
      // Without a number, we undo the last tidy-up still undoable: that is what
      // "undo tonight's tidy-up" means.
      const last = listReviews(10).find(r => !r.undone)
      if (!last) return 'No tidy-up to undo.'
      target = last.id
    }
    const r = undoReview(target)
    if (!r.ok) return `Impossible: ${r.error}`
    return `Tidy-up of ${r.day} undone, ${r.restored.length} task(s) given back to their day: ${r.restored.join(', ')}`
  },
  keyboard_help: () => SHORTCUTS,
  rename_thread: ({ title }, ctx) => {
    if (!ctx?.conversationId) return 'No current conversation'
    renameConversation(ctx.conversationId, String(title).slice(0, 60))
    return `Conversation renamed: ${title}`
  },

  /* The ghost decision: a decision task + the rule that blocks both of its
     options as long as it is not checked. Checking the decision releases
     everything. */
  create_decision: ({ optionA, optionB, day }) => {
    const a = String(optionA || '').trim()
    const b = String(optionB || '').trim()
    if (!a || !b) return 'NOTHING CREATED: both options are needed.'
    const when = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : today()
    const t = createTask({ content: `Decide: ${a} or ${b}`, day: when })
    db.prepare(`INSERT INTO rules (text, source, kind, scope, param, created_at) VALUES (?,?,?,?,?,?)`)
      .run(`As long as "Decide: ${a} or ${b}" is not settled, no task from either path comes in.`,
        'engine', 'block', `${groupKey(a)}|${groupKey(b)}`,
        JSON.stringify({ until: `task:${t.id}`, options: [a, b] }), now())
    return `Decision placed on ${when}: #${t.id} "${t.content}". As long as it is not checked, I refuse additions that look like "${a}" or "${b}": the decision first.`
  },

  /* The rule engine: consult its hypotheses, and above all the promotion, which
     has a single path, the user's yes relayed by this tool. */
  list_candidates: () => {
    const rows = db.prepare(`SELECT * FROM rule_candidates WHERE status IN ('candidate','testing','proposed')
                             ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'testing' THEN 1 ELSE 2 END, id DESC LIMIT 12`).all()
    if (!rows.length) return 'No candidate rule so far: the engine has not yet seen enough repeated corrections.'
    const CANDIDATE_STATE = { candidate: 'observed', testing: 'on trial in silence', proposed: 'PROPOSED, waiting for their answer' }
    return rows.map(c => {
      const sim = c.sim ? JSON.parse(c.sim) : null
      const proof = sim && sim.matches != null ? `${sim.matches} confirmation(s), ${sim.mismatches} contradiction(s) over ${sim.days} days` : `support ${c.support}`
      return `#${c.id} · ${CANDIDATE_STATE[c.status] || c.status} · "${c.text}" (${proof})`
    }).join('\n')
  },
  promote_rule: ({ candidateId }) => {
    const r = promote(num(candidateId))
    if (r.error) return `Nothing promoted: ${r.error}`
    return `Rule recorded (number ${r.ruleId}): "${r.text}". The night tidy-up applies it from tonight.`
  },
  reject_rule: ({ candidateId }) => {
    const r = reject(num(candidateId))
    if (r.error) return `Nothing to bury: ${r.error}`
    return `Candidate buried: "${r.text}". It will never be proposed again.`
  }
}

/** Readable label shown live in the chat while the tool runs. */
const LABELS = {
  current_date: 'checks the date', list_day: 'reads the day', list_week: 'reads the week',
  list_inbox: 'opens the inbox', search_tasks: 'searches', stale_tasks: 'looks at what drags on',
  add_task: 'adds a task', update_task: 'changes a task', move_task: 'moves a task',
  reorder_task: 'files a task', number_tasks: 'numbers', delete_task: 'deletes a task',
  add_many: 'places the list', reorganize: 'reorganizes as one block', undo_last: 'undoes the last gesture',
  list_trash: 'opens the trash', restore_task: 'recovers what was deleted',
  decompose_task: 'splits the task', add_rule: 'remembers a rule', forget_rule: 'forgets a rule',
  remember: 'remembers a detail', forget: 'forgets a detail',
  end_day: 'closes the day',
  keyboard_help: 'looks up the shortcuts', rename_thread: 'renames the conversation',
  list_reviews: 'rereads the night tidy-ups', undo_review: 'undoes a night tidy-up',
  wait_for: 'puts the task in escrow', unblock: 'unblocks the task',
  park: 'parks the line', pause_task: 'puts on pause', archive_task: 'archives the project',
  list_parked: 'looks at what sleeps', suspend_rule: 'puts a rule under observation',
  rule_health: 'examines the rules', load_check: 'measures the load',
  why_moved: 'traces the move',
  list_candidates: 'rereads its rule hypotheses', promote_rule: 'records the rule',
  reject_rule: 'buries the candidate', create_decision: 'places a blocking decision'
}
export const labelFor = name => LABELS[name] || name

/** The tools that write: the interface refreshes only after those. */
const WRITERS = new Set(['add_task', 'update_task', 'move_task', 'reorder_task', 'number_tasks',
  'delete_task', 'decompose_task', 'add_rule', 'forget_rule', 'remember', 'forget',
  'undo_review', 'end_day',
  'add_many', 'reorganize', 'undo_last', 'restore_task',
  'wait_for', 'unblock', 'park', 'pause_task', 'archive_task', 'suspend_rule',
  'promote_rule', 'reject_rule', 'create_decision'])
export const isWriter = name => WRITERS.has(name)

/* The handlers, the labels and the writing tools are grafted HERE and not
   higher: `handlers`, `LABELS` and `WRITERS` are `const`, hence in the temporal
   dead zone until their declaration has been evaluated. */
for (const g of GRAFTS) {
  Object.assign(handlers, g.handlers || {})
  Object.assign(LABELS, g.labels || {})
  for (const w of g.writers || []) WRITERS.add(w)
}

export async function runTool (name, args, ctx = {}) {
  const fn = handlers[name]
  if (!fn) return { ok: false, text: `Unknown tool: ${name}` }
  // The model returned unreadable arguments (see `parseArgs` in
  // llm.js). We SAY it, with the beginning of the text received: without that,
  // the tool ran without arguments and answered an error that did not talk about
  // the real problem, and the model looked for a missing identifier instead of a
  // brace.
  if (args && args.__unreadableArguments !== undefined) {
    return { ok: false, text: `Unreadable arguments for ${name}: I could not read the JSON received ("${args.__unreadableArguments}"). Call the tool again with valid JSON arguments.` }
  }
  try {
    // Everything one turn of the agent writes forms ONE gesture of the history: a
    // single Ctrl+Z on the screen (or undo_last) undoes the whole turn.
    const gesture = ctx?.sessionId && WRITERS.has(name)
      ? { id: `agent:${ctx.sessionId}`, label: `the assistant: ${labelFor(name)}`, author: 'agent' }
      : {}
    const text = String((await withGesture(gesture, () => fn(args || {}, ctx))) ?? '')
    // Handlers report their refusals through TEXT ("NOTHING ADDED",
    // "NOTHING CHANGED", "Task #x not found") and not by throwing: without this
    // translation, a refusal counted as a success. Measured consequence on the
    // base: out of 422 steps, none had the `error` status, the green chat
    // progress lied, the anti-loop guard never fired, and a refusal reloaded the
    // screen like a write. We therefore translate the explicit refusals into
    // `ok: false`, keeping the text for the model.
    if (/^NOTHING\b/.test(text)) return { ok: false, text }
    return { ok: true, text }
  } catch (e) {
    // The error goes back to the model rather than breaking the turn: it can
    // correct its call (wrong identifier, badly formed date) on the next turn.
    return { ok: false, text: `${name} failed: ${e.message}` }
  }
}

export { SHORTCUTS }
