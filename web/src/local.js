/**
 * Local mutations of the state, applied BEFORE the server answers.
 *
 * Every gesture (checking, moving, indenting, deleting) used to show up only
 * after a full round trip: the write call, then a reload of the whole week. A
 * one-second wait on a gesture repeated fifty times a day is what made the app
 * unpleasant.
 *
 * The same computation therefore happens here, right away, on the local copy;
 * the server call goes out behind it and the silent reload is only there to
 * confirm. These functions must stay **faithful to the server**: they replay
 * what `reorderTask` does in `server/tasks.js`, tree order included (each child
 * follows its parent immediately). A divergence would show as a flicker on
 * reload.
 *
 * They all take a state and return a new one, never mutating the one they are
 * given: React only re-renders what changes identity.
 */

const clone = s => ({
  ...s,
  week: Object.fromEntries(Object.entries(s.week).map(([d, l]) => [d, l.map(t => ({ ...t }))])),
  inbox: (s.inbox || []).map(t => ({ ...t }))
})

const listFor = (s, day) => (day ? (s.week[day] ||= []) : s.inbox)

/** The task and everything below it, in display order. */
function subtree (list, i) {
  const base = list[i].depth
  let end = i + 1
  while (end < list.length && list[end].depth > base) end++
  return list.slice(i, end)
}

function locate (s, id) {
  for (const [day, list] of Object.entries(s.week)) {
    const i = list.findIndex(t => t.id === id)
    if (i >= 0) return { list, i, day }
  }
  const i = (s.inbox || []).findIndex(t => t.id === id)
  return i >= 0 ? { list: s.inbox, i, day: null } : null
}

/** Changes the fields of one line (checkbox, text, note, fold). */
export function patchLocal (s, id, fields) {
  const n = clone(s)
  const hit = locate(n, id)
  if (!hit) return s
  Object.assign(hit.list[hit.i], fields)
  return n
}

/**
 * Rewires the children of a line whose temporary identifier has just been
 * replaced by the real one.
 *
 * A new line exists before the server does, with a negative identifier. If it
 * receives descendants in the meantime (a pasted batch), its children still
 * point at that temporary number: the tree breaks on screen (the children climb
 * back to the root) and a second copy of the line loses its descendants.
 */
export function rewireChildren (s, oldId, newId) {
  const n = clone(s)
  for (const list of [...Object.values(n.week), n.inbox]) {
    for (const t of list) if (t.parentId === oldId) t.parentId = newId
  }
  return n
}

/** Removes a line and all of its descendants. */
export function deleteLocal (s, id) {
  const n = clone(s)
  const hit = locate(n, id)
  if (!hit) return s
  const block = subtree(hit.list, hit.i)
  hit.list.splice(hit.i, block.length)
  return n
}

/**
 * Inserts a new line, before the server has even given it an identifier.
 *
 * It carries a negative temporary identifier and a `uid` that will never
 * change: that `uid` is what React uses as its key. Without it, replacing the
 * temporary identifier with the real one would recreate the input field, and
 * the caret would jump to the start of another line in the middle of a
 * sentence.
 *
 * Faithful to `createTask`: with `afterId`, the line becomes a SIBLING of that
 * one (same day, same parent), placed right after it and all its descendants.
 */
export function insertLocal (s, { uid, day, afterId = null, parentId = null }) {
  const n = clone(s)
  const fresh = {
    id: uid, uid, day, parentId: parentId ?? null, depth: 0,
    content: '', note: null, checkbox: true, checked: false, collapsed: false,
    movedFrom: null, moveCount: 0
  }
  const after = afterId == null ? null : locate(n, afterId)
  if (after) {
    const ref = after.list[after.i]
    fresh.day = ref.day
    fresh.parentId = ref.parentId ?? null
    fresh.depth = ref.depth
    after.list.splice(after.i + subtree(after.list, after.i).length, 0, fresh)
    return n
  }
  const target = listFor(n, fresh.day)
  const parent = parentId == null ? null : target.find(t => t.id === parentId)
  if (parent) {
    fresh.depth = parent.depth + 1
    target.splice(target.indexOf(parent) + subtree(target, target.indexOf(parent)).length, 0, fresh)
    return n
  }
  target.push(fresh)
  return n
}

/**
 * Moves a line, with its descendants, to a day, a parent and a position. This
 * is the exact translation of `reorderTask`: a null `afterId` means "at the
 * head of the siblings", and a parent without `afterId` means "right after the
 * parent".
 */
export function moveLocal (s, id, { day, parentId = null, afterId = null }) {
  const n = clone(s)
  const hit = locate(n, id)
  if (!hit) return s
  const block = subtree(hit.list, hit.i)

  // A line is never filed inside its own descendants: the server refuses, and
  // locally the branch would detach from the tree.
  if (parentId != null && block.some(t => t.id === parentId)) return s

  hit.list.splice(hit.i, block.length)

  const targetDay = day === undefined ? hit.day : day
  const target = listFor(n, targetDay)
  const parent = parentId == null ? null : target.find(t => t.id === parentId)
  const depth = parent ? parent.depth + 1 : 0
  const delta = depth - block[0].depth

  for (const t of block) {
    t.day = targetDay
    t.depth += delta
  }
  block[0].parentId = parentId ?? null

  let insertion
  if (afterId != null) {
    const j = target.findIndex(t => t.id === afterId)
    insertion = j < 0 ? target.length : j + subtree(target, j).length
  } else if (parent) {
    insertion = target.indexOf(parent) + 1
  } else {
    // At the head of the day, after nothing: this is the first root line.
    insertion = 0
  }

  target.splice(insertion, 0, ...block)
  return n
}
