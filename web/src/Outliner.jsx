import { useEffect, useRef, useState } from 'react'
import { renderMarkdown, rawHtml, escapeHtml, noteHtml } from './markdown.js'
import { IconNote, IconClock, IconCalendar } from './Icons.jsx'

/**
 * Keyboard outliner, one line = one task in the database.
 *
 * Shortcuts (layered on Dynalist, its help centre's "Keyboard shortcut
 * reference" article):
 *   Enter            new line at the same level
 *   Ctrl+Enter       turn the line's checkbox on or off (Dynalist)
 *   Ctrl+Shift+Enter new line under this one
 *   Shift+Enter      write (or edit) the note under the line
 *   Tab / Shift+Tab  indent / outdent
 *   Ctrl+Shift+C     turn the checkbox on or off (historical shortcut here)
 *   Ctrl+Shift+X     number the selected lines
 *   Ctrl+B / Ctrl+I  bold / italic; Ctrl+` inline code
 *   Ctrl+Shift+H     turn the heading on or off (markdown hashes)
 *   Ctrl+Up/Down     swap the line with the previous / next one
 *   Ctrl+Shift+Backsp. delete the line
 *   Ctrl+K           pick the line's day (the home-made calendar)
 *   Ctrl+Shift+K     pick the line's time
 *   Ctrl+C / Ctrl+X  copy / cut the selected lines
 *   Ctrl+V           paste the batch (displayed day, or under the taken line)
 *   Ctrl+Z undoes, Ctrl+Y or Ctrl+Shift+Z redoes
 *   Backspace        on an empty line, deletes the line and moves up
 *
 * The text goes to the database when the field loses focus or Enter is pressed,
 * not on every keystroke: one request per character is avoided.
 *
 * A line shows as rendered markdown when it is not being edited, and turns back
 * into raw text as soon as it is clicked into. `editing` switches between the
 * two, and it is the only place where the field's content changes on its own.
 */
export default function Outliner ({
  tasks: all, onPatch, onCreate, onDelete, onIndent, onMoveDay,
  onToggleCollapse, onGrab, dropHint, selection, onSelect, dense = false,
  // Swapping a line with its neighbour (Ctrl+Up/Down): the server does an
  // ordinary `reorder`, App knows how to unfold it.
  onSwap,
  // Setting or changing a line's time and day: the outliner only says WHICH line
  // and WHERE it is on screen (the rectangle serves as the pop-up's anchor). It
  // is App that opens the picker and writes.
  onSetTime,
  // The agent's insights about specific lines: a taskId -> kind map.
  // The outliner only displays the word and hands back the click, it is App
  // that knows how to open the right conversation thread.
  verdicts = null, onVerdict,
  // "Pick a worker's goal" mode: each line becomes a clickable target, once.
  // It is App that decides when (the worker button), the outliner only renders
  // the gesture.
  pick = false, onPickTask
}) {
  const refs = useRef(new Map())
  const noteRefs = useRef(new Map())
  const [editing, setEditing] = useState(null)

  // A collapsed line hides all of its descendants. The list is cut here rather
  // than in the database: collapsing is a display comfort, the task still
  // exists.
  const childrenBy = new Map()
  for (const t of all) {
    const k = t.parentId ?? 0
    if (!childrenBy.has(k)) childrenBy.set(k, [])
    childrenBy.get(k).push(t)
  }
  const hidden = new Set()
  const hideUnder = id => {
    for (const c of childrenBy.get(id) || []) { hidden.add(c.id); hideUnder(c.id) }
  }
  for (const t of all) if (t.collapsed) hideUnder(t.id)
  const tasks = all.filter(t => !hidden.has(t.id))
  const childCount = id => (childrenBy.get(id) || []).length

  /**
   * Give the caret to the line that has just been born.
   *
   * The request is placed in `window.__agendaFocus` by whoever creates the
   * line, and it is the outliner actually carrying that line that consumes it.
   *
   * Trap paid for: in WEEK view, seven outliners are mounted at the same time
   * and this effect runs in ALL of them on every render. It cleared the request
   * even when it did not find the line, so the Monday column consumed into the
   * void a request meant for Sunday. As a result the line appeared but the
   * caret stayed on the old one: the first column worked, the last never did.
   * **So we only clear it if we really gave the focus.**
   *
   * Trade-off: a request nobody can satisfy (the line was filtered out, or the
   * user changed weeks in the meantime) would linger and steal the caret much
   * later. It therefore expires after two seconds, which is more than enough to
   * let a creation's renders go through.
   */
  useEffect(() => {
    const want = window.__agendaFocus
    if (!want) return
    const map = want.note ? noteRefs.current : refs.current
    const id = want.id ?? want
    const el = map.get(id)
    if (el) {
      if (!want.note) setEditing(id)
      el.focus()
      placeCaretEnd(el)
      window.__agendaFocus = null
      window.__agendaFocusAt = null
      return
    }
    const t = window.__agendaFocusAt
    if (!t) { window.__agendaFocusAt = Date.now(); return }
    if (Date.now() - t > 2000) { window.__agendaFocus = null; window.__agendaFocusAt = null }
  })

  const commit = (t, el) => {
    const v = el.innerText.replace(/\n+$/, '')
    if (v !== t.content) onPatch(t.id, { content: v })
  }

  const handleKey = (e, t, idx) => {
    const el = e.currentTarget

    // Ctrl+Enter: the checkbox, as in Dynalist. The app's most frequent gesture
    // is done from any line, without aiming at the small box with a finger. A
    // second pass unchecks it.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && t.checkbox) {
      e.preventDefault()
      onPatch(t.id, { content: el.innerText.replace(/\n+$/, ''), checked: !t.checked })
      return
    }
    // Ctrl+Shift+Enter: a new line under this one, at the same level.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault()
      commit(t, el)
      onCreate({ afterId: t.id })
      return
    }
    if (e.key === 'Enter' && e.shiftKey) {
      // Opens the note under the line, even if it is empty for now.
      e.preventDefault()
      commit(t, el)
      const focusId = t.uid ?? t.id
      window.__agendaFocus = { id: focusId, note: true }
      if (!t.note) onPatch(t.id, { note: ' ' })
      else queueMicrotask(() => noteRefs.current.get(focusId)?.focus())
      return
    }
    // Enter on an EMPTY line moves up one level instead of stacking yet another
    // empty sibling. You go down into "Deep work" to write, you reach the end of
    // what you had to put there, and Enter brings you back out: one more press
    // and you are at the root of the day. It is the gesture of every outliner,
    // and it avoids the detour through Shift+Tab, which does not exist on a
    // phone keyboard. At the root there is nothing left to move up to: Enter
    // takes back its normal meaning and creates the next line.
    if (e.key === 'Enter' && el.innerText.trim() === '' && t.parentId != null) {
      e.preventDefault()
      commit(t, el)
      onIndent(t, -1, idx)
      // Put back afterwards: `indent` aims at `t.id`, yet a line that has just
      // been born still only has a temporary identifier and is found by its
      // `uid`. Without this line the caret leaves the field and the next
      // keystroke goes into the void.
      window.__agendaFocus = t.uid ?? t.id
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(t, el)
      onCreate({ afterId: t.id })
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      commit(t, el)
      onIndent(t, e.shiftKey ? -1 : 1, idx)
      return
    }
    // Ctrl+Up / Ctrl+Down: swap the line with its neighbour above or below, at
    // the same level first (the Dynalist gesture). The target is never a child
    // of the line: swapping with it is already covered by Tab, and a parent
    // diving under its own descendants would form an impossible tree. One move
    // per press: with key repeat, the line climbs one step at a time and the
    // Ctrl+Z history reads clearly.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const dir = e.key === 'ArrowUp' ? -1 : 1
      const neighbour = tasks[idx + dir]
      if (neighbour && (neighbour.depth === t.depth || neighbour.depth < t.depth)) {
        e.preventDefault()
        commit(t, el)
        const targetId = neighbour.id
        // Same level: we land before it (upwards) or after its descendants
        // (downwards). It is one level higher: we become its first child, or we
        // go under its parent.
        const mode = neighbour.depth === t.depth
          ? (dir < 0 ? 'before' : 'after')
          : (dir < 0 ? 'child' : 'before')
        onSwap?.(t.id, targetId, mode)
        return
      }
      if (neighbour) { e.preventDefault() }
      return
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'Backspace' || e.key === 'backspace')) {
      e.preventDefault()
      onDelete(t)
      const prev = tasks[idx - 1]
      if (prev) window.__agendaFocus = prev.uid ?? prev.id
      return
    }
    if (e.key === 'Backspace' && el.innerText.trim() === '') {
      e.preventDefault()
      const prev = tasks[idx - 1]
      onDelete(t)
      if (prev) window.__agendaFocus = prev.uid ?? prev.id
      return
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault()
      commit(t, el)
      onPatch(t.id, { checkbox: !t.checkbox })
      return
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
      e.preventDefault()
      const v = el.innerText.replace(/\n+$/, '')
      const isHeading = /^(#{1,3})\s+/.test(v)
      const bare = isHeading ? v.replace(/^(#{1,3})\s+/, '') : `## ${v}`
      onPatch(t.id, { content: bare })
      return
    }
    if (e.ctrlKey && (e.key === '`' || e.key === 'Backquote')) {
      e.preventDefault()
      const v = el.innerText
      const already = /`([^`]+)`/.exec(v)
      onPatch(t.id, { content: already ? v.replace(/`([^`]*)`/g, '$1') : `${v}\`` })
      return
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'b' || e.key === 'i')) {
      e.preventDefault()
      wrapSelection(el, e.key === 'b' ? '**' : '*')
      onPatch(t.id, { content: el.innerText })
      return
    }
    // Ctrl+K: the day; Ctrl+Shift+K: the time. The same key for both "when"
    // questions.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      commit(t, el)
      const anchor = el.closest('.orow')?.getBoundingClientRect()
      if (e.shiftKey) onSetTime?.(t, anchor)
      else onMoveDay(t, anchor)
    }
  }

  const handleNoteKey = (e, t) => {
    const el = e.currentTarget
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onPatch(t.id, { note: el.innerText.trim() })
      window.__agendaFocus = t.uid ?? t.id
      return
    }
    if (e.key === 'Backspace' && el.innerText === '') {
      e.preventDefault()
      onPatch(t.id, { note: '' })
      window.__agendaFocus = t.uid ?? t.id
    }
  }

  /**
   * Keyboard selection, as in Dynalist: Shift+Up takes the line and the previous
   * one, Shift+Down extends it to the next one, all while staying in the field.
   * The text caret does not move (preventDefault): we select LINES, not letters.
   */
  const handleRangeKey = (e, t, idx) => {
    if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return false
    e.preventDefault()
    if (e.key === 'ArrowUp') {
      const prev = tasks[idx - 1]
      onSelect?.(t.id, {})
      if (prev) onSelect?.(prev.id, { range: true })
    } else {
      const next = tasks[idx + 1]
      onSelect?.(t.id, {})
      if (next) onSelect?.(next.id, { range: true })
    }
    return true
  }

  /* ---------------------------------------------------------------- */
  /* Moving by the handle                                              */
  /* ---------------------------------------------------------------- */
  /* The whole gesture lives in `dragdrop.js` and is driven by App, which */
  /* alone knows all the days: a line can therefore be carried from one  */
  /* day to another. Here we only do two things, place the handle and    */
  /* show the outline when the line is hovered.                          */

  return (
    <div className={`outliner${dense ? ' dense' : ''}${pick ? ' pick' : ''}`}>
      {tasks.map((t, idx) => {
        // Stable key: a new line changes identifier as soon as the server
        // answers. Everything that follows a line while it is being edited (its
        // React key, its DOM reference, the "being edited" state) must rely on
        // that key, otherwise the field is recreated or rewritten mid-typing and
        // the typed text disappears.
        const k = t.uid ?? t.id
        const sel = selection?.has(t.id)
        const hint = dropHint?.id === t.id ? dropHint.mode : null
        // A set-aside line stays readable but stops competing for the eye with
        // what is really to be done today.
        const state = t.state && t.state !== 'active' ? t.state : null
        // An appointment comes from the Google Calendar mirror. It is an
        // ordinary task in the database, but not a task one organises: it is
        // ENDURED. It can be checked (I went) and it does not move.
        const appt = t.source === 'gcal'
        return (
          <div
            key={k}
            data-id={t.id}
            className={`orow${t.checked ? ' done' : ''}${sel ? ' sel' : ''}${hint ? ` drop-${hint}` : ''}${state ? ` asleep ${state}` : ''}${appt ? ' appt' : ''}`}
            /* In worker mode, the whole line is the target: the click goes out
               before the text editor, so focus is not taken when choosing. */
            onClickCapture={pick
              ? e => { e.preventDefault(); e.stopPropagation(); onPickTask?.(t) }
              : undefined}
            /* `--prof` serves the indent lines: the CSS derives from it the
               number of vertical lines to draw in front of the row. */
            style={{ paddingLeft: 4 + t.depth * (dense ? 12 : 22), '--prof': t.depth }}
          >
            {/* Move handle, next to the checkbox and not on top of it: clicking
                the checkbox must check, that is the most frequent gesture. We
                grab it and carry the line wherever we want; a simple press,
                without moving, selects the line as before.

                On an appointment, the handle disappears in favour of a fixed
                marker: carrying the line elsewhere would be undone at the next
                sync, so the gesture must be impossible and not merely
                discouraged. */}
            {appt
              ? <span className="grip fixed" title="Google Calendar appointment: it does not move here" />
              : (
                <span
                  className="grip"
                  title="Grab the line to move it, or press to select it"
                  onPointerDown={e => onGrab?.(e, t)}
                />
                )}

            {/* The agent's insight badge sits on the LEFT, against the handle:
                that is the "why" column, while the tags on the right carry "what
                the line is". The click opens the conversation that explains, as
                before. */}
            {verdicts && verdicts[t.id]
              ? (
                <span
                  className="tag verdict"
                  title="The agent has an insight about this line, press to talk about it"
                  onClick={() => onVerdict?.(t.id)}
                >{verdictWord(verdicts[t.id])}</span>
                )
              : null}

            {/* The chevron only appears on a line that has sub-tasks. */}
            {childCount(t.id) > 0
              ? (
                <button
                  className={`fold${t.collapsed ? ' on' : ''}`}
                  tabIndex={-1}
                  onClick={() => onToggleCollapse?.(t)}
                  title={t.collapsed ? `Expand (${childCount(t.id)} sub-tasks)` : 'Collapse'}
                >{t.collapsed ? '▸' : '▾'}</button>
                )
              : <span className="fold empty" />}

            {t.checkbox
              ? <span className={`cb${t.checked ? ' on' : ''}`} onClick={() => onPatch(t.id, { checked: !t.checked })} />
              : <span className="bullet">•</span>}

            {/* A line with a time carries its badge, clickable: it reopens the
                time picker to change or remove it. */}
            {t.startAt
              ? (
                <button
                  className="tag time"
                  tabIndex={-1}
                  title={t.durationMin ? `${formatTime(t.startAt)}, ${t.durationMin} min: change or remove` : `${formatTime(t.startAt)}: change or remove`}
                  onClick={e => onSetTime?.(t, e.currentTarget.getBoundingClientRect())}
                >{formatTime(t.startAt)}</button>
                )
              : null}

            <div className="otext">
              <Field
                className="oedit"
                spellCheck={false}
                rest={renderMarkdown(t.content)}
                raw={rawHtml(t.content)}
                refCb={el => { el ? refs.current.set(k, el) : refs.current.delete(k) }}
                onKeyDown={e => { if (!handleRangeKey(e, t, idx)) handleKey(e, t, idx) }}
                onFocus={() => setEditing(k)}
                onBlur={e => { commit(t, e.currentTarget); setEditing(null) }}
                onMouseDown={e => {
                  // Shift+click or ctrl+click on the text selects the line instead
                  // of editing it: that is the expected gesture to take a range.
                  if (e.shiftKey || e.ctrlKey || e.metaKey) {
                    e.preventDefault()
                    onSelect?.(t.id, { range: e.shiftKey, toggle: e.ctrlKey || e.metaKey })
                    return
                  }
                  // A link stays clickable while reading: without this the field
                  // takes focus, the address turns back into raw text and the
                  // click is lost.
                  const a = e.target.closest?.('a')
                  if (a && editing !== k) { e.preventDefault(); window.open(a.href, '_blank', 'noopener') }
                  // Native text selection does not know how to cross two distinct
                  // fields: it therefore stopped at the first line. As soon as
                  // the pointer reaches ANOTHER line, the gesture becomes a
                  // selection of LINES (range anchored -> hovered line),
                  // recomputed on every line crossed so back-and-forth movement
                  // is followed. Staying inside the line changes nothing: native
                  // text selection keeps the upper hand.
                  if (e.button === 0) {
                    const anchor = t.id
                    let last = null
                    const move = ev => {
                      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.orow[data-id]')
                      const id = row ? Number(row.dataset.id) : null
                      if (id == null || id === last || id === anchor) return
                      if (last == null) {
                        window.getSelection()?.removeAllRanges()
                        document.activeElement?.blur?.()
                        document.body.classList.add('dragging')
                      }
                      last = id
                      onSelect?.(anchor, {})
                      onSelect?.(id, { range: true })
                    }
                    const up = () => {
                      window.removeEventListener('mousemove', move)
                      window.removeEventListener('mouseup', up)
                      document.body.classList.remove('dragging')
                    }
                    window.addEventListener('mousemove', move)
                    window.addEventListener('mouseup', up)
                  }
                }}
              />

              {t.note !== '' && t.note != null
                ? (
                  <Field
                    className="onote"
                    rest={noteHtml(t.note)}
                    raw={escapeHtml(t.note)}
                    refCb={el => { el ? noteRefs.current.set(k, el) : noteRefs.current.delete(k) }}
                    onKeyDown={e => handleNoteKey(e, t)}
                    onMouseDown={e => {
                      // Like on the task line: a link in the note opens on click while the note is not being edited.
                      const a = e.target.closest?.('a')
                      if (a && document.activeElement !== e.currentTarget) { e.preventDefault(); window.open(a.href, '_blank', 'noopener') }
                    }}
                    onBlur={e => {
                      const v = e.currentTarget.innerText.trim()
                      if (v !== t.note) onPatch(t.id, { note: v })
                    }}
                  />
                  )
                : null}
            </div>

            {/* The gestures of a line, on hover: the note, the time, the day.
                Three buttons of the same size and the same drawing, laid OVER
                the end of the line: they take no room from the text, in the week
                column as in the day view. On a phone, the bottom bar carries the
                same gestures (see RowBar in App.jsx). */}
            {pick || appt
              ? null
              : (
                <span className="racts">
                  <button className="btn ico sm bare" tabIndex={-1} title="Note under the line (shift + enter)"
                    onClick={() => { window.__agendaFocus = { id: t.uid ?? t.id, note: true }; if (!t.note) onPatch(t.id, { note: ' ' }) }}>
                    <IconNote size={14} />
                  </button>
                  <button className="btn ico sm bare" tabIndex={-1} title="Time (ctrl + shift + K)"
                    onClick={e => onSetTime?.(t, e.currentTarget.getBoundingClientRect())}>
                    <IconClock size={14} />
                  </button>
                  <button className="btn ico sm bare" tabIndex={-1} title="Day (ctrl + K)"
                    onClick={e => onMoveDay?.(t, e.currentTarget.getBoundingClientRect())}>
                    <IconCalendar size={14} />
                  </button>
                </span>
                )}

            {/* What the line IS reads before what happened to it: an appointment
                is not a thing to do, it is a time taken. */}
            {appt ? <span className="tag appt" title="Appointment imported from Google Calendar">appointment</span> : null}
            {t.movedFrom ? <span className="tag moved" title={`postponed from ${t.movedFrom}`}>↳ {shortDay(t.movedFrom)}</span> : null}
            {t.moveCount > 2 ? <span className="tag warn" title={`postponed ${t.moveCount} times`}>postponed ×{t.moveCount}</span> : null}

            {/* The state tag carries a sentence, not two characters. The break
                before it drops it onto its own line wherever width is counted
                (week column, phone): without it, it squeezes the text until it
                is cut letter by letter. */}
            {state
              ? (
                <>
                  <span className="tagbreak" />
                  <span className={`tag st st-${state}`} title={t.stateNote || undefined}>{stateLabel(t)}</span>
                </>
                )
              : null}
          </div>
        )
      })}
      <button className="oadd btn sm bare" onClick={() => onCreate({})}>+ add</button>
    </div>
  )
}

/**
 * An input field whose content comes from the state, but that nothing rewrites
 * while one is typing in it.
 *
 * This is the delicate point of the whole editor: the keystroke in progress
 * lives in the DOM, not in the state. With React's usual rendering, any change
 * elsewhere in the list (a neighbouring line receiving its identifier from the
 * server, for instance) rewrites this field and erases the sentence in progress.
 * Here we only write into the field when it does not have focus, and only once
 * per value.
 *
 * Two content states: `rest`, the rendered markdown that is read, and `raw`, the
 * source text that is edited. The switch from one to the other happens on focus,
 * and only if the two differ, otherwise the caret would jump to the end on every
 * click into a line without formatting.
 */
function Field ({ rest, raw, refCb, className, onFocus, ...props }) {
  const el = useRef(null)
  const posed = useRef(null)

  useEffect(() => {
    const n = el.current
    if (!n || document.activeElement === n) return
    if (posed.current === rest) return
    n.innerHTML = rest
    posed.current = rest
  })

  return (
    <div
      {...props}
      className={className}
      contentEditable
      suppressContentEditableWarning
      ref={n => { el.current = n; refCb?.(n) }}
      onFocus={e => {
        if (posed.current !== raw) {
          e.currentTarget.innerHTML = raw
          posed.current = raw
          placeCaretEnd(e.currentTarget)
        }
        onFocus?.(e)
      }}
    />
  )
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDay (isoDay) {
  const [, m, d] = isoDay.split('-')
  return `${MONTHS_SHORT[Number(m) - 1] || ''} ${Number(d)}`.trim()
}

/**
 * The verdict word, one per kind of insight. An unknown kind falls back to
 * "insight": the agent can invent a new kind without breaking the display.
 */
const VERDICT_WORD = { muda: 'verdict', stasis: 'on trial', correction: 'rule?' }
const verdictWord = kind => VERDICT_WORD[kind] || 'insight'

/** "15:30" or "9:00", without the leading zero of the stored "09:00".
    Same rule as the server, formatTime in schedule.js. */
const formatTime = hm => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''))
  if (!m) return ''
  return `${Number(m[1])}:${m[2]}`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const longDay = isoDay => {
  const [, m, d] = isoDay.split('-').map(Number)
  return `${d} ${MONTHS[m - 1] || ''}`.trim()
}

/**
 * What the line is waiting for, in one sentence.
 *
 * The detail comes before the raw state: "waiting" says nothing, "waiting for
 * the plumber" says whether someone must be chased, and a pause without a wake
 * date is a disguised abandonment, so the date is displayed as soon as it
 * exists.
 */
function stateLabel (t) {
  if (t.state === 'waiting') return t.waitingOn ? `waiting for ${t.waitingOn}` : 'waiting'
  if (t.state === 'parked') return 'to clarify'
  if (t.state === 'paused') return t.wakeAt ? `paused until ${longDay(t.wakeAt)}` : 'paused'
  if (t.state === 'archived') return 'archived'
  return t.state
}

function placeCaretEnd (el) {
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(false)
  const s = getSelection()
  s.removeAllRanges()
  s.addRange(r)
}

function wrapSelection (el, marker) {
  const sel = getSelection()
  if (!sel.rangeCount) return
  const range = sel.getRangeAt(0)
  const selected = range.toString()
  if (!selected) return
  range.deleteContents()
  range.insertNode(document.createTextNode(`${marker}${selected}${marker}`))
  el.normalize()
}
