import { useCallback, useEffect, useRef, useState } from 'react'
import { api, bootToken, setToken, openEvents, newGesture, writesSettled } from './api.js'
import Outliner from './Outliner.jsx'
import Chat from './Chat.jsx'
import ChatWidget from './ChatWidget.jsx'
import WorkerSend from './WorkerSend.jsx'
import Kb from './Kb.jsx'
import { Pop, Calendar, DayPicker, TimePicker } from './Pickers.jsx'
import { useTaskDrag } from './dragdrop.js'
import { patchLocal, deleteLocal, moveLocal, insertLocal, rewireChildren } from './local.js'
import {
  IconWeek, IconToday, IconChat, IconCalendar, IconLeft, IconRight,
  IconPanelLeft, IconLogo, IconUndo, IconRedo, IconSun, IconMoon, IconReport,
  IconWrench, IconOutdent, IconIndent, IconUp, IconDown, IconCheckbox, IconNote,
  IconClock, IconTrash, IconGraph, IconClose
} from './Icons.jsx'

const DAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const STATE_TOAST = { waiting: 'put on hold', paused: 'paused', parked: 'to clarify' }

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d) }
const weekStart = s => addDays(s, -((parse(s).getDay() + 6) % 7))
const longDate = s => { const d = parse(s); return `${FULL[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]}` }
const dayNum = s => parse(s).getDate()
const brief = t => String(t?.content || '').replace(/[*_`#~]/g, '').trim().slice(0, 32) || 'empty line'

/**
 * The seven days offered to drop a line on, in Monday -> Sunday order.
 * A day's POSITION never moves, its number follows: a day already past points
 * to its next occurrence. The anchor is the week of the day being looked at,
 * not today's week.
 */
const rollingDays = (shownDay, today) => {
  const base = weekStart(shownDay || today)
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(base, i)
    return d < today ? addDays(d, 7) : d
  })
}

/** Is text selected with the keyboard? A Ctrl+C must then copy that text. */
const hasTextSelected = () => {
  const s = window.getSelection?.()
  return !!s && String(s.toString()).trim() !== ''
}

/** A form field (the chat, search) keeps its own Ctrl+Z. */
const isNativeField = el => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')

const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
}

/**
 * Reload when the server serves a newer build than the one running in this
 * tab. Never while typing, and only once.
 */
let reloadDone = false
async function freshVersion () {
  if (reloadDone) return
  if (document.activeElement?.isContentEditable) return
  try {
    const r = await fetch('/health', { cache: 'no-store' })
    const { build } = await r.json()
    if (!build) return
    const script = document.querySelector('script[src*="/assets/"]')?.getAttribute('src') || ''
    if (script && !script.includes(build.replace(/^assets\//, ''))) {
      reloadDone = true
      location.reload()
    }
  } catch {}
}

export default function App () {
  const [token, setTok] = useState(() => bootToken())
  // The opening screen is today's day.
  const [view, setView] = useState('day')            // week | day | inbox | chat | kb
  const [state, setState] = useState(null)
  /**
   * THE day being looked at, the single source of truth for navigation. The
   * displayed week follows from it (`weekStart(cursor)`); it is no longer a
   * second piece of state that had to be kept in sync with the first: that
   * disagreement is what used to show an empty day after a week change.
   */
  const [cursor, setCursor] = useState(null)
  const [sideOpen, setSideOpen] = useState(() => store.get('agenda.side', true))
  const [chatOpen, setChatOpen] = useState(() => store.get('agenda.chat', window.innerWidth >= 1280))
  const [chatDock, setChatDock] = useState(() => store.get('agenda.chatDock', 'right'))
  const [chatWindow, setChatWindow] = useState(() => store.get('agenda.chatWindow', null))
  const [theme, setTheme] = useState(() => store.get('agenda.theme', 'dark'))
  const [selection, setSelection] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')
  const [chatTarget, setChatTarget] = useState(null)
  const [workerOpen, setWorkerOpen] = useState(false)
  const [workerPick, setWorkerPick] = useState(false)
  const [workerTarget, setWorkerTarget] = useState(null)   // {id, content}
  // The open choice pop-up: { type: 'day' | 'time' | 'go', task, anchor }.
  const [picker, setPicker] = useState(null)
  // A line is being edited: on the phone, the gesture bar shows up.
  const [rowActive, setRowActive] = useState(false)
  const boardRef = useRef(null)
  const tmpId = useRef(0)
  const realIds = useRef(new Map())
  const queue = useRef(Promise.resolve())
  const lastSelected = useRef(null)
  const actions = useRef({})
  const copied = useRef(null)

  useEffect(() => store.set('agenda.side', sideOpen), [sideOpen])
  useEffect(() => store.set('agenda.chat', chatOpen), [chatOpen])
  useEffect(() => store.set('agenda.chatDock', chatDock), [chatDock])
  useEffect(() => store.set('agenda.chatWindow', chatWindow), [chatWindow])
  useEffect(() => {
    store.set('agenda.theme', theme)
    document.documentElement.dataset.theme = theme
  }, [theme])

  const reload = useCallback(async (day) => {
    try {
      const s = await api.bootstrap(day)
      setState(s)
      setCursor(c => c || s.today)
      setErr('')
    } catch (e) {
      setErr(e.message === 'unauthorized' ? 'unauthorized' : e.message)
    }
  }, [])

  useEffect(() => { reload() }, [token, reload])

  const evRef = useRef(null)
  const cursorRef = useRef(null)
  useEffect(() => { cursorRef.current = cursor }, [cursor])

  // Coming back to the foreground reloads: the assistant or another device may
  // have written meanwhile.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return
      evRef.current?.wake()
      if (!document.activeElement?.isContentEditable) reload(cursorRef.current)
      freshVersion()
    }
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('focus', onReturn)
    return () => {
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('focus', onReturn)
    }
  }, [reload])

  // The event stream: `refresh` when the database changed without the screen
  // knowing (agent, Google mirror, night, Ctrl+Z done on another device).
  const ready = !!state
  useEffect(() => {
    if (!ready || evRef.current) return
    const ev = openEvents((type) => {
      if (type === 'refresh' && !document.activeElement?.isContentEditable) reload(cursorRef.current)
    })
    evRef.current = ev
    return () => { ev.close(); evRef.current = null }
  }, [ready, reload])

  /* The week being looked at follows from the cursor. As soon as it is no
     longer the one the screen has in memory, it is loaded; a response arriving
     after another week change is thrown away, otherwise two quick clicks would
     show the wrong week. The server always sends the CURRENT week as well:
     today stays right, whatever week is displayed. */
  const shownWeek = cursor ? weekStart(cursor) : null
  useEffect(() => {
    if (!state || !shownWeek || shownWeek === state.weekStart) return
    let alive = true
    api.week(shownWeek)
      .then(w => { if (alive) setState(s => ({ ...s, week: w.week, weekStart: w.weekStart, today: w.today || s.today })) })
      .catch(e => { if (alive) setToast(`Week not loaded: ${e.message}`) })
    return () => { alive = false }
  }, [shownWeek, state?.weekStart])

  const goToday = useCallback(() => {
    setCursor(state.today)
    setView('day')
  }, [state?.today])

  // The week opens on today, never on an empty Monday.
  useEffect(() => {
    if (view !== 'week' || !boardRef.current) return
    const el = boardRef.current.querySelector('.col.today')
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [view, state?.today, shownWeek])

  // The line being edited, for the phone's gesture bar. We read the DOM: a new
  // line changes identifier while one writes in it.
  useEffect(() => {
    const update = () => {
      const el = document.activeElement
      setRowActive(!!el?.isContentEditable && !!el.closest?.('.orow[data-id]'))
    }
    const onFocusOut = () => setTimeout(update, 0)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', onFocusOut)
    return () => { document.removeEventListener('focusin', update); document.removeEventListener('focusout', onFocusOut) }
  }, [])

  /* ------------------------------------------------------------------ */
  /* Undo, redo                                                          */
  /* ------------------------------------------------------------------ */
  /* Ctrl+Z and Ctrl+Y no longer replay inverses written by hand in the page:  */
  /* every gesture leaves for the server with its identifier, the database     */
  /* records what it changed, and the history (server/history.js) undoes or    */
  /* redoes it in one block. Hand gestures and agent turns alike.              */
  const historyStep = useCallback(async sense => {
    // The typing in progress goes first: it is the most recent gesture.
    if (document.activeElement?.isContentEditable) document.activeElement.blur()
    setBusy(true)
    try {
      await new Promise(r => setTimeout(r, 0))
      await queue.current
      await writesSettled()
      const r = sense === 'undo' ? await api.undo() : await api.redo()
      if (!r.ok) { setToast(r.reason || 'Nothing to do'); return }
      setToast(`${sense === 'undo' ? 'Undone' : 'Redone'}: ${r.gesture.label || 'the last gesture'}`)
      await reload(cursorRef.current)
    } catch (e) {
      setToast(`${sense === 'undo' ? 'Undo' : 'Redo'} failed: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [reload])

  useEffect(() => {
    const onKey = e => {
      // An open pop-up keeps the keyboard for itself (Enter, Escape).
      if (document.querySelector('.pop')) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && !e.shiftKey && k === 'z' && !isNativeField(e.target)) {
        e.preventDefault()
        historyStep('undo')
        return
      }
      if (mod && (k === 'y' || (e.shiftKey && k === 'z')) && !isNativeField(e.target)) {
        e.preventDefault()
        historyStep('redo')
        return
      }
      if (mod && e.shiftKey && k === 'x') {
        e.preventDefault()
        actions.current.number?.()
      }
      if (e.key === 'Escape') actions.current.clearSelection?.()
      if (mod && !e.shiftKey && !e.altKey && (k === 'c' || k === 'x') && selection.size && !hasTextSelected()) {
        e.preventDefault()
        if (k === 'c') actions.current.copy?.()
        else actions.current.cut?.()
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target?.isContentEditable && !isNativeField(e.target)) {
        if (actions.current.deleteSelection?.()) e.preventDefault()
      }
      // j / k: next day, previous day (outside typing).
      if ((k === 'j' || k === 'k') && !mod && !e.altKey &&
          !e.target?.isContentEditable && !isNativeField(e.target) && (view === 'day' || view === 'week')) {
        e.preventDefault()
        setCursor(c => addDays(c || state.today, k === 'j' ? 1 : -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [historyStep, view, state?.today, selection])

  /* Pasting a batch goes through the `paste` event: it is the only moment when
     the system clipboard can be read. */
  useEffect(() => {
    const onPaste = e => {
      const p = copied.current
      if (!p) return
      const text = String(e.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n').trim()
      if (text && text !== p.text.trim()) return
      e.preventDefault()
      actions.current.paste?.()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(id)
  }, [toast])

  const { drag, grab } = useTaskDrag({
    onTap: useCallback((id, mods) => actions.current.select?.(id, mods), []),
    onDrop: useCallback((id, target, extra) => actions.current.dropTask?.(id, target, extra), []),
    onPaint: useCallback((ids) => actions.current.paint?.(ids), [])
  })

  if (err === 'unauthorized') return <TokenGate onSet={t => { setToken(t); setTok(t); setErr('') }} />
  if (!state && err) {
    return (
      <div className="boot err">
        <p>Could not load the agenda.</p>
        <p className="boot-detail">{err}</p>
        <button className="btn" onClick={() => { setErr(''); reload(cursor) }}>Try again</button>
      </div>
    )
  }
  if (!state || !cursor) return <div className="boot">loading…</div>

  const days = Array.from({ length: 7 }, (_, i) => addDays(shownWeek, i))
  const railDays = rollingDays(cursor, state.today)
  const dayTasks = d => state.week[d] || []
  const allTasks = () => [...Object.values(state.week).flat(), ...state.inbox]
  const find = id => allTasks().find(t => t.id === id)
  const listFor = t => (t.day ? dayTasks(t.day) : state.inbox)

  /* ------------------------------------------------------------------ */
  /* The screen never shows a wait                                       */
  /* ------------------------------------------------------------------ */
  /* The gesture is applied to the local copy, the server call goes behind it  */
  /* and nothing is reloaded on success. We only reload if the write failed    */
  /* (the screen lies) or when coming back to the foreground.                  */
  const instant = (mutation, call, what = 'Action') => {
    setState(mutation)
    ;(async () => {
      try {
        await call()
      } catch (e) {
        setToast(`${what} not saved: ${e.message}`)
        await reload(cursor)
      }
    })()
  }

  const run = async fn => { setBusy(true); try { await fn() } finally { setBusy(false); await reload(cursor) } }

  /** The real identifier of a line created just now (temporary negative number). */
  const realIdOf = async id => {
    if (id == null) return null
    if (id >= 0) return id
    await queue.current
    return realIds.current.get(id) ?? null
  }

  /**
   * Change fields of a line. Each call is one history gesture, unless the
   * caller provides one (a batch = one gesture) or passes `null` (collapsing,
   * pure display comfort, is not undone).
   */
  const patch = (id, p, g) => {
    const before = find(id)
    const what = 'checked' in p ? (p.checked ? 'checked' : 'unchecked')
      : 'note' in p ? 'note'
        : 'checkbox' in p ? 'checkbox'
          : 'startAt' in p ? 'time'
            : 'text'
    const gesture = g === undefined ? newGesture(`${what} "${brief(before)}"`) : g
    return instant(
      s => patchLocal(s, id, p),
      async () => {
        const r = await realIdOf(id)
        if (!r) return
        await api.update(r, p, gesture || undefined)
      },
      'Change'
    )
  }

  /** Deletes the line and its descendants (the server moves it to the trash). */
  const removeTask = (task, g) => {
    const t = typeof task === 'object' ? task : find(task)
    if (!t) return
    const gesture = g || newGesture(`deletion of "${brief(t)}"`)
    return instant(
      s => deleteLocal(s, t.id),
      async () => { const r = await realIdOf(t.id); if (r) await api.remove(r, gesture) },
      'Deletion'
    )
  }

  /** Deletes the roots of the selection, not each child separately. */
  const deleteSelection = () => {
    if (!selection.size) return false
    if (document.activeElement?.isContentEditable) return false
    const ids = batchRoots([...selection])
    if (!ids.length) return false
    const g = newGesture(`deletion of ${ids.length} line(s)`)
    for (const id of ids) {
      const t = find(id)
      if (t) removeTask(t, g)
    }
    setSelection(new Set())
    return true
  }
  actions.current.deleteSelection = deleteSelection

  const lastSibling = (day, parentId, except) => {
    const list = day ? dayTasks(day) : state.inbox
    const siblings = list.filter(x => (x.parentId ?? null) === (parentId ?? null) && x.id !== except)
    return siblings.length ? siblings[siblings.length - 1].id : null
  }

  const move = (id, day, parentId, g) => {
    const before = find(id)
    const gesture = g || newGesture(`move of "${brief(before)}"`)
    const target = { day, parentId: parentId ?? null, afterId: lastSibling(day, parentId, id) }
    return instant(
      // Dropping a line with no date clears its postponement history, as the server does.
      s => patchLocal(moveLocal(s, id, target), id, day == null ? { movedFrom: null, moveCount: 0 } : { movedFrom: null }),
      async () => {
        const [i, pa] = await Promise.all([realIdOf(id), realIdOf(parentId)])
        if (!i) return
        // The server may file the line into the group of the same name on the
        // arrival day, or merge a group: the screen then lines up with it.
        const r = await api.move(i, day, pa, gesture)
        if (r && (r.id !== i || (parentId === undefined && (r.parentId ?? null) !== null))) await reload(cursor)
      },
      'Move'
    )
  }

  /** New line: it exists and takes the cursor before any server call. */
  const create = ({ afterId, day, parentId }) => {
    const uid = --tmpId.current
    const theDay = day === undefined ? cursor : day
    setState(s => insertLocal(s, { uid, day: theDay, afterId, parentId }))
    window.__agendaFocus = uid
    const gesture = newGesture('adding a line')
    queue.current = queue.current.then(async () => {
      const real = x => (x == null ? null : x < 0 ? realIds.current.get(x) ?? null : x)
      const t = await api.create({ afterId: real(afterId), day: theDay, parentId: real(parentId) }, gesture)
      realIds.current.set(uid, t.id)
      setState(s => patchLocal(s, uid, { id: t.id }))
    }).catch(async e => {
      setToast(`Line not saved: ${e.message}`)
      await reload(cursor)
    })
  }

  const indent = (t, dir, idx) => {
    const list = listFor(t)
    let target
    if (dir > 0) {
      for (let i = idx - 1; i >= 0; i--) if (list[i].depth === t.depth) { target = list[i].id; break }
      if (target === undefined) return
    } else {
      const parent = list.find(x => x.id === t.parentId)
      if (!parent) return
      target = parent.parentId ?? null
    }
    window.__agendaFocus = t.id
    return move(t.id, t.day, target, newGesture(`${dir > 0 ? 'indent' : 'outdent'} of "${brief(t)}"`))
  }

  /** Swaps a line with its neighbour (Ctrl+Up/Down). */
  const swap = (id, targetId, mode) => {
    const t = find(id)
    const other = find(targetId)
    if (!t || !other) return
    const list = listFor(t)
    let parentId
    let after
    if (mode === 'child') {
      parentId = other.id
      const kids = list.filter(x => x.parentId === other.id && x.id !== id)
      after = kids.length ? kids[kids.length - 1].id : null
    } else if (mode === 'after') {
      const block = []
      const collect = pid => { for (const c of list.filter(x => x.parentId === pid)) { block.push(c.id); collect(c.id) } }
      collect(targetId)
      parentId = other.parentId ?? null
      const last = block.length ? block[block.length - 1] : targetId
      after = last === id ? lastSibling(t.day, parentId, id) : last
    } else {
      parentId = other.parentId ?? null
      after = targetId
    }
    if (after === id) after = lastSibling(t.day, parentId, id)
    return reorder(id, { parentId, afterId: after, day: t.day })
  }

  /* ------------------------------------------------------------------ */
  /* Multiple selection and numbering                                    */
  /* ------------------------------------------------------------------ */
  actions.current.clearSelection = () => setSelection(new Set())

  const select = (id, { range, toggle } = {}) => {
    const t = find(id)
    if (!t) return
    const anchor = lastSelected.current
    setSelection(prev => {
      const next = new Set(prev)
      if (range && anchor != null) {
        const list = listFor(t)
        const a = list.findIndex(x => x.id === anchor)
        const b = list.findIndex(x => x.id === id)
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(list[i].id)
          return next
        }
      }
      if (toggle) { next.has(id) ? next.delete(id) : next.add(id) } else if (next.has(id) && next.size === 1) next.clear()
      else { if (!toggle) next.clear(); next.add(id) }
      return next
    })
    lastSelected.current = id
  }
  actions.current.select = select

  const paint = ids => {
    const next = new Set(ids.filter(id => find(id)))
    if (!next.size) return
    setSelection(next)
    lastSelected.current = ids[ids.length - 1]
  }
  actions.current.paint = paint

  /** Formats every selected line at once: a single gesture. */
  const wrapSelection = marker => {
    const lines = [...selection].map(find).filter(t => t && t.content != null)
    if (!lines.length) return
    const g = newGesture(`${marker === '**' ? 'bold' : 'italic'} on ${lines.length} line(s)`)
    for (const t of lines) {
      const bare = t.content.replace(/^\s*\d+[.)]\s+/, '')
      const prefix = t.content.slice(0, t.content.length - bare.length)
      // The same marker inside is removed first, otherwise a word already in
      // bold would stay thin in the middle of a sentence turned bold.
      const cleaned = marker === '**' ? bare.replace(/\*\*/g, '') : bare.replace(/(?<!\*)\*(?!\*)/g, '')
      const already = bare.startsWith(marker) && bare.endsWith(marker)
      patch(t.id, { content: prefix + (already ? cleaned : `${marker}${cleaned}${marker}`) }, g)
    }
    setToast(`${lines.length} line(s) formatted`)
  }

  const numberSelection = async () => {
    if (!selection.size) { setToast('Select lines by pressing their handle'); return }
    const first = find([...selection][0])
    const list = first ? listFor(first) : []
    const ids = list.filter(t => selection.has(t.id)).map(t => t.id)
    await run(() => api.number(ids, 1, newGesture(`numbering ${ids.length} line(s)`)))
    setToast(`${ids.length} line(s) numbered`)
  }
  actions.current.number = numberSelection

  /**
   * Sets the selected lines aside, or puts them back in the flow. A pause
   * leaves with a wake date one week out.
   */
  const setTaskState = wanted => {
    const before = [...selection].map(find).filter(Boolean)
    if (!before.length) return
    const target = before.every(a => (a.state || 'active') === wanted) ? 'active' : wanted
    const fields = { state: target, waitingOn: null, wakeAt: target === 'paused' ? addDays(state.today, 7) : null }
    const g = newGesture(`state of ${before.length} line(s)`)
    instant(
      s => before.reduce((acc, a) => patchLocal(acc, a.id, fields), s),
      async () => {
        for (const a of before) {
          const r = await realIdOf(a.id)
          if (r) await api.update(r, fields, g)
        }
      },
      'State'
    )
    setToast(target === 'active' ? `${before.length} line(s) back in the flow` : `${before.length} line(s) ${STATE_TOAST[target]}`)
  }

  const reorder = (id, opts, g) => {
    const before = find(id)
    const gesture = g || newGesture(`move of "${brief(before)}"`)
    return instant(
      s => opts.day === null
        ? patchLocal(moveLocal(s, id, opts), id, { movedFrom: null, moveCount: 0 })
        : moveLocal(s, id, opts),
      async () => {
        const [i, pa, af] = await Promise.all([realIdOf(id), realIdOf(opts.parentId), realIdOf(opts.afterId)])
        if (i) await api.reorder(i, { ...opts, parentId: pa, afterId: af }, gesture)
      },
      'Move'
    )
  }

  /** The roots of a batch; Google appointments are left out. */
  const batchRoots = ids => {
    const set = new Set(ids)
    const out = []
    for (const t of allTasks()) {
      if (!set.has(t.id) || t.source === 'gcal') continue
      let p = t.parentId
      let below = false
      while (p) {
        if (set.has(p)) { below = true; break }
        p = find(p)?.parentId
      }
      if (!below) out.push(t.id)
    }
    return out
  }

  /** A batch of moves: one screen mutation, one gesture, the calls queued. */
  const dropLot = ops => {
    if (!ops.length) return
    // A line dropped where it already is does not move, and leaves nothing in
    // the history: a Ctrl+Z that changes nothing would be a lost gesture.
    const useful = ops.filter(op => {
      const t = find(op.id)
      if (!t) return false
      const siblings = listFor(t).filter(x => (x.parentId ?? null) === (t.parentId ?? null))
      const i = siblings.findIndex(x => x.id === op.id)
      const prev = i > 0 ? siblings[i - 1].id : null
      return !((t.day ?? null) === (op.day ?? null) && (t.parentId ?? null) === (op.parentId ?? null) && prev === (op.afterId ?? null))
    })
    if (!useful.length) return
    const g = newGesture(useful.length > 1 ? `move of ${useful.length} lines` : `move of "${brief(find(useful[0].id))}"`)
    setState(s => {
      let n = s
      for (const op of useful) {
        n = op.day === null
          ? patchLocal(moveLocal(n, op.id, op), op.id, { movedFrom: null, moveCount: 0 })
          : moveLocal(n, op.id, op)
      }
      return n
    })
    ;(async () => {
      try {
        for (const op of useful) {
          const [i, pa, af] = await Promise.all([realIdOf(op.id), realIdOf(op.parentId), realIdOf(op.afterId)])
          if (i) await api.reorder(i, { ...op, parentId: pa, afterId: af }, g)
        }
      } catch (e) {
        setToast(`Move not saved: ${e.message}`)
        await reload(cursor)
      }
    })()
  }

  /** Applies the drop of a line carried by its handle. */
  const dropTask = (id, target, extra) => {
    if (!target || target.type === 'self') return
    const raw = extra?.also?.length
      ? extra.also
      : (selection.has(id) && selection.size > 1 ? [...selection] : [id])
    const batch = batchRoots(raw.includes(id) ? raw : [id, ...raw])
    if (!batch.length) batch.push(id)

    if (target.type === 'day') {
      const day = target.day === 'none' ? null : target.day
      const list = day ? dayTasks(day) : state.inbox
      const roots = list.filter(t => (t.parentId ?? null) === null && !batch.includes(t.id))
      let after = roots.length ? roots[roots.length - 1].id : null
      const ops = []
      for (const i of batch) {
        ops.push({ id: i, parentId: null, afterId: after === i ? null : after, day })
        after = i
      }
      return dropLot(ops)
    }
    const t = find(target.id)
    if (!t || batch.includes(t.id) || batch.some(i => isDescendantOf(t.id, i))) return
    const list = listFor(t)
    let parentId
    let after
    if (target.mode === 'child') {
      const kids = list.filter(x => x.parentId === t.id && !batch.includes(x.id))
      parentId = t.id
      after = kids.length ? kids[kids.length - 1].id : null
    } else if (target.mode === 'after') {
      parentId = t.parentId ?? null
      after = t.id
    } else {
      parentId = t.parentId ?? null
      const idx = list.findIndex(x => x.id === t.id)
      after = null
      for (let i = idx - 1; i >= 0; i--) {
        if ((list[i].parentId ?? null) === parentId && !batch.includes(list[i].id)) { after = list[i].id; break }
      }
    }
    const ops = []
    for (const i of batch) {
      ops.push({ id: i, parentId, afterId: after, day: t.day })
      after = i
    }
    return dropLot(ops)
  }
  actions.current.dropTask = dropTask

  /* ------------------------------------------------------------------ */
  /* Copy, cut, paste a batch of lines                                   */
  /* ------------------------------------------------------------------ */
  /* The batch keeps its SHAPE in an internal clipboard, and its TEXT also goes
     to the system clipboard, one task per line. */

  const subtreeOf = t => {
    const list = t.day ? dayTasks(t.day) : state.inbox
    const children = list.filter(x => x.parentId === t.id).map(subtreeOf)
    return {
      content: t.content || '',
      note: t.note || '',
      checkbox: !!t.checkbox,
      checked: !!t.checked,
      startAt: t.startAt || null,
      durationMin: t.durationMin || null,
      children
    }
  }

  const batchText = batch => {
    const lines = []
    const descend = (n, depth) => {
      const bare = String(n.content || '')
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/\*\*|__|`|~~/g, '')
        .replace(/(?<!\*)\*(?!\*)/g, '')
        .trim()
      lines.push('  '.repeat(depth) + bare)
      for (const c of n.children) descend(c, depth + 1)
    }
    for (const n of batch) descend(n, 0)
    return lines.join('\n')
  }

  const copySelection = () => {
    if (!selection.size) return { n: 0, write: Promise.resolve(false) }
    const batch = batchRoots([...selection]).map(find).filter(Boolean).map(subtreeOf)
    if (!batch.length) return { n: 0, write: Promise.resolve(false) }
    const text = batchText(batch)
    copied.current = { batch, text, n: batch.length }
    const write = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(text).then(() => true, () => false)
      : Promise.resolve(false)
    return { n: batch.length, write }
  }

  const clipboardNote = ok => ok ? ', text in the clipboard' : ' (system clipboard unavailable here)'

  const copy = async () => {
    const { n, write } = copySelection()
    if (!n) { setToast('Nothing to copy: nothing selected, or only calendar appointments'); return }
    setToast(`${n} line(s) copied${clipboardNote(await write)}`)
  }

  const cut = async () => {
    const { n, write } = copySelection()
    if (!n) { setToast('Nothing to cut: nothing selected, or only calendar appointments'); return }
    deleteSelection()
    setToast(`${n} line(s) cut${clipboardNote(await write)}`)
  }

  /** Where a paste lands: under the taken line if it is in sight, otherwise
      in the displayed day. */
  const pasteTarget = () => {
    const ids = batchRoots([...selection])
    const under = ids.length ? find(ids[ids.length - 1]) : null
    const shownDay = view === 'inbox' ? null : cursor
    const inSight = !!under && (view === 'week' || under.day === shownDay)
    if (inSight) return { day: under.day, parentId: under.id, afterId: null, under }
    return { day: shownDay, parentId: null, afterId: null, under: null }
  }

  /** Pastes the batch: a single gesture, every creation queued. */
  const paste = () => {
    const p = copied.current
    if (!p || !p.batch.length) { setToast('Nothing to paste'); return false }
    const target = pasteTarget()
    const expand = !!target.under?.collapsed && target.parentId
    const g = newGesture(`paste of ${p.batch.length} line(s)`)

    const plan = []
    const walk = (nodes, parent) => {
      let prev = null
      for (const n of nodes) {
        const uid = --tmpId.current
        plan.push({ n, uid, parent, prev })
        walk(n.children, uid)
        prev = uid
      }
    }
    walk(p.batch, null)

    setState(s => {
      let out = expand ? patchLocal(s, target.parentId, { collapsed: false }) : s
      for (const e of plan) {
        out = insertLocal(out, {
          uid: e.uid,
          day: target.day,
          parentId: e.parent == null ? target.parentId : e.parent,
          afterId: e.prev == null ? (e.parent == null ? target.afterId : null) : e.prev
        })
        out = patchLocal(out, e.uid, {
          content: e.n.content,
          note: e.n.note,
          checkbox: e.n.checkbox,
          checked: e.n.checked,
          ...(e.n.startAt ? { startAt: e.n.startAt, durationMin: e.n.durationMin || 30 } : {})
        })
      }
      return out
    })

    queue.current = queue.current.then(async () => {
      const real = x => (x == null ? null : x < 0 ? realIds.current.get(x) ?? null : x)
      if (expand) await api.update(target.parentId, { collapsed: false })
      for (const e of plan) {
        const t = await api.create({
          afterId: e.prev == null ? real(target.afterId) : real(e.prev),
          day: target.day,
          parentId: e.parent == null ? target.parentId : real(e.parent)
        }, g)
        realIds.current.set(e.uid, t.id)
        const fields = {}
        if (e.n.content) fields.content = e.n.content
        if (e.n.note) fields.note = e.n.note
        if (e.n.startAt) { fields.startAt = e.n.startAt; fields.durationMin = e.n.durationMin || 30 }
        if (e.n.checked) fields.checked = true
        if (!e.n.checkbox) fields.checkbox = false
        if (Object.keys(fields).length) await api.update(t.id, fields, g)
        setState(s => rewireChildren(patchLocal(s, e.uid, { id: t.id }), e.uid, t.id))
      }
    }).catch(async e => {
      setToast(`Paste not saved: ${e.message}`)
      await reload(cursor)
    })
    setToast(`${plan.length} line(s) pasted`)
    return true
  }
  actions.current.copy = copy
  actions.current.cut = cut
  actions.current.paste = paste

  /* ------------------------------------------------------------------ */
  /* The agent's insights, the worker                                    */
  /* ------------------------------------------------------------------ */

  const openChat = conversationId => {
    if (conversationId) setChatTarget({ conversationId, ts: Date.now() })
    if (window.innerWidth >= 861) setChatOpen(true)
    else setView('chat')
  }

  const pickGoal = t => {
    setWorkerTarget({ id: t.id, content: t.content })
    setWorkerPick(false)
    setWorkerOpen(true)
  }

  const handleVerdict = async taskId => {
    const id = state.verdictIds?.[taskId]
    if (!id) return openChat(null)
    try {
      const conv = await api.openInsight(id)
      openChat(conv?.id)
    } catch { openChat(null) }
  }

  /** A line cannot fall into its own descendants. */
  const isDescendantOf = (id, ancestor) => {
    let cur = find(id)
    let guard = 0
    while (cur?.parentId && guard++ < 50) {
      if (cur.parentId === ancestor) return true
      cur = find(cur.parentId)
    }
    return false
  }

  const dropHint = drag?.target?.type === 'row' && !isDescendantOf(drag.target.id, drag.id) ? drag.target : null
  const dropDay = drag?.target?.type === 'day' ? drag.target.day : null

  /* ------------------------------------------------------------------ */
  /* A line's day and time: the home-made pop-ups                        */
  /* ------------------------------------------------------------------ */

  /** Ctrl+K, a line's calendar button, the phone bar. */
  const pickDay = (t, anchor) => setPicker({ type: 'day', task: t, anchor: anchor || null })
  /** Ctrl+Shift+K, the clock button, the time badge. */
  const pickTime = (t, anchor) => setPicker({ type: 'time', task: t, anchor: anchor || null })

  const setDay = d => {
    const t = picker?.task
    setPicker(null)
    if (!t || (t.day ?? null) === (d ?? null)) return
    move(t.id, d, undefined, newGesture(`"${brief(t)}" ${d ? `to ${dayNum(d)} ${MONTHS[parse(d).getMonth()]}` : 'to the inbox'}`))
    setToast(d ? `Sent to ${longDate(d)}` : 'Filed in the inbox')
  }

  const setTime = (start, duration) => {
    const t = picker?.task
    setPicker(null)
    if (!t) return
    patch(t.id, { startAt: start, durationMin: duration })
  }
  const clearTime = () => {
    const t = picker?.task
    setPicker(null)
    if (t?.startAt) patch(t.id, { startAt: null, durationMin: null })
  }

  /** Collapsing is not a history gesture: it is a display comfort. */
  const toggleCollapse = t => patch(t.id, { collapsed: !t.collapsed }, null)

  const outlinerProps = {
    onPatch: patch, onDelete: removeTask, onIndent: indent, onMoveDay: pickDay,
    onSwap: swap, onSetTime: pickTime,
    selection, onSelect: select, onToggleCollapse: toggleCollapse,
    onGrab: grab, dropHint,
    verdicts: state.verdicts, onVerdict: handleVerdict,
    pick: workerPick, onPickTask: pickGoal
  }

  const progress = list => `${list.filter(t => t.checked).length} done of ${list.length}`

  return (
    <div className={`app view-${view}${sideOpen ? '' : ' side-collapsed'}${chatOpen ? '' : ' chat-closed'}${rowActive ? ' editing' : ''}`}>
      <Sidebar
        view={view} setView={setView} state={state} open={sideOpen}
        onToday={goToday}
        onAssistant={() => { if (view !== 'chat') setChatOpen(o => !o) }}
        chatOpen={chatOpen}
      />

      <div className="main">
        <TopBar
          view={view} cursor={cursor} week={shownWeek}
          state={state} busy={busy}
          sideOpen={sideOpen} onToggleSide={() => setSideOpen(o => !o)}
          theme={theme} onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          onPrev={() => setCursor(c => addDays(c, view === 'week' ? -7 : -1))}
          onNext={() => setCursor(c => addDays(c, view === 'week' ? 7 : 1))}
          onGo={anchor => setPicker({ type: 'go', anchor })}
          onUndo={() => historyStep('undo')}
          onRedo={() => historyStep('redo')}
          onWorker={() => { setWorkerTarget(null); setWorkerPick(true) }}
        />

        {view === 'week' && (
          <div className="board" ref={boardRef}>
            {days.map(d => (
              <div
                key={d}
                data-day={d}
                className={`col${d === state.today ? ' today' : ''}${dropDay === d ? ' dragover' : ''}`}
              >
                <div className="colh" onClick={() => { setCursor(d); setView('day') }}>
                  <span className="d">{DAY_LABEL[(parse(d).getDay() + 6) % 7]}</span>
                  <span className="n">{dayNum(d)}</span>
                  <span className="c">{dayTasks(d).filter(t => !t.checked).length || ''}</span>
                </div>
                <div className="colbody">
                  <Outliner tasks={dayTasks(d)} dense onCreate={o => create({ ...o, day: d })} {...outlinerProps} />
                </div>
              </div>
            ))}
          </div>
        )}

        {view === 'day' && (
          <div className={`zoom${dropDay === cursor ? ' dragover' : ''}`} data-day={cursor}>
            <div className="zh">
              <h2>{longDate(cursor)}</h2>
              <span className="meta">
                {progress(dayTasks(cursor))}
                {dayTasks(cursor).some(t => t.movedFrom) ? <em> · postponed from an earlier day</em> : null}
              </span>
            </div>
            <Outliner tasks={dayTasks(cursor)} onCreate={o => create({ ...o, day: cursor })} {...outlinerProps} />
          </div>
        )}

        {view === 'inbox' && (
          <div className={`zoom${dropDay === 'none' ? ' dragover' : ''}`} data-day="none">
            <div className="zh">
              <h2>Inbox</h2>
              <span className="meta">{progress(state.inbox)}</span>
            </div>
            <Outliner tasks={state.inbox} onCreate={o => create({ ...o, day: null })} {...outlinerProps} />
          </div>
        )}

        {view === 'chat' && <Chat state={state} reload={() => reload(cursor)} target={chatTarget} full />}

        {/* The knowledge base stays mounted at all times, hidden elsewhere. */}
        <Kb visible={view === 'kb'} onToast={setToast} />

        {selection.size > 0 && view !== 'chat'
          ? (
            <div className="selbar">
              <span className="selnb">{selection.size} selected</span>
              <button className="btn sm bare" onClick={() => wrapSelection('**')}>bold</button>
              <button className="btn sm bare" onClick={() => wrapSelection('*')}>italic</button>
              <button className="btn sm bare" onClick={numberSelection}>number</button>
              <span className="sep" />
              <button className="btn sm bare" onClick={copy} title="Copy the taken lines (ctrl+C)">copy</button>
              <button className="btn sm bare" onClick={cut} title="Copy and remove the taken lines (ctrl+X)">cut</button>
              <button className="btn sm bare" onClick={paste} title="Paste under the last taken line, or in the displayed day (ctrl+V)">paste</button>
              <span className="sep" />
              <button className="btn sm bare" onClick={() => setTaskState('waiting')} title="In escrow: waiting for someone">waiting</button>
              <button className="btn sm bare" onClick={() => setTaskState('paused')} title="Paused, wakes up automatically in a week">pause</button>
              <button className="btn sm bare" onClick={() => setTaskState('parked')} title="This is not an action: to clarify">to clarify</button>
              <span className="sep" />
              <button className="btn sm bare" onClick={deleteSelection} title="Delete the selected lines">delete</button>
              <button className="btn sm bare" onClick={() => setSelection(new Set())}>cancel</button>
            </div>
            )
          : null}
      </div>

      {chatOpen && view !== 'chat'
        ? (
          <ChatWidget
            state={state} reload={() => reload(cursor)} target={chatTarget}
            onClose={() => setChatOpen(false)}
            dock={chatDock} setDock={setChatDock}
            windowBox={chatWindow} setWindowBox={setChatWindow}
          />
          )
        : null}

      {/* While carrying a line: the ghost, and the day rail in day view or
          "inbox" (the only screens with a single day). */}
      {drag
        ? (
          <>
            <div className="ghost" style={{ '--gx': `${drag.x}px`, '--gy': `${drag.y}px` }}>
              {drag.n > 1
                ? `${drag.n} lines`
                : ((drag.text || 'line').replace(/[*`#]/g, '').slice(0, 44) || 'line')}
            </div>
            {view === 'day' || view === 'inbox'
              ? (
                <div className="dayrail">
                  {railDays.map(d => (
                    <div key={d} data-day={d}
                      className={`drday${d === state.today ? ' today' : ''}${dropDay === d ? ' on' : ''}`}>
                      <span className="dl">{DAY_LABEL[(parse(d).getDay() + 6) % 7]}</span>
                      <span className="dn">{dayNum(d)}</span>
                    </div>
                  ))}
                  <div data-day="none" className={`drday undated${dropDay === 'none' ? ' on' : ''}`}>
                    <span className="dl">no</span>
                    <span className="dn">day</span>
                  </div>
                </div>
                )
              : null}
          </>
          )
        : null}

      {picker?.type === 'day'
        ? (
          <Pop anchor={picker.anchor} title={`Day of "${brief(picker.task)}"`} onClose={() => setPicker(null)}>
            <DayPicker value={picker.task.day ?? null} today={state.today} onPick={setDay} />
          </Pop>
          )
        : null}
      {picker?.type === 'time'
        ? (
          <Pop anchor={picker.anchor} title={`Time of "${brief(picker.task)}"`} onClose={() => setPicker(null)} width={300}>
            <TimePicker start={picker.task.startAt} duration={picker.task.durationMin}
              onConfirm={setTime} onRemove={clearTime} />
          </Pop>
          )
        : null}
      {picker?.type === 'go'
        ? (
          <Pop anchor={picker.anchor} title="Go to a day" onClose={() => setPicker(null)}>
            <Calendar value={cursor} today={state.today}
              onPick={d => { setCursor(d); if (view !== 'week') setView('day'); setPicker(null) }} />
            <div className="choice-foot">
              <span />
              <button className="btn" onClick={() => { goToday(); setPicker(null) }}>Today</button>
            </div>
          </Pop>
          )
        : null}

      {workerPick
        ? (
          <div className="wpick">
            <IconWrench size={16} />
            <span>Touch the task to send to a worker</span>
            <button className="btn sm" onClick={() => { setWorkerPick(false); setWorkerTarget(null); setWorkerOpen(true) }}>
              without a goal
            </button>
            <button className="btn ico sm bare" onClick={() => setWorkerPick(false)} title="Cancel"><IconClose size={14} /></button>
          </div>
          )
        : null}

      {workerOpen
        ? (
          <WorkerSend
            stt={state.stt !== false}
            goal={workerTarget}
            onRepick={() => { setWorkerOpen(false); setWorkerTarget(null); setWorkerPick(true) }}
            onClose={() => { setWorkerOpen(false); setWorkerTarget(null); setWorkerPick(false) }}
          />
          )
        : null}

      {/* The gesture bar of a line, on the phone: the PC shortcuts turned into
          buttons. Each button SENDS the key to the line being edited: a single
          code path for the keyboard and for the finger. */}
      {rowActive && view !== 'chat' ? <RowBar onUndo={() => historyStep('undo')} onRedo={() => historyStep('redo')} /> : null}

      {toast ? <div className="toast">{toast}</div> : null}

      {state && err && err !== 'unauthorized'
        ? <div className="offline" onClick={() => { setErr(''); reload(cursor) }}>{err} · press to retry</div>
        : null}

      <nav className="bottomnav">
        <button className={view === 'day' ? 'on' : ''} onClick={goToday}><IconToday />Day</button>
        <button className={view === 'week' ? 'on' : ''} onClick={() => setView('week')}><IconWeek />Week</button>
        <button className={view === 'inbox' ? 'on' : ''} onClick={() => setView('inbox')}><IconReport />Inbox</button>
        <span className="navsep" />
        <button className={view === 'kb' ? 'on' : ''} onClick={() => setView('kb')}><IconGraph />KB</button>
        <span className="navsep" />
        <button className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')}><IconChat />Chat</button>
      </nav>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * The phone bar, modelled on Dynalist: while writing in a line, the gestures
 * the PC does with the keyboard become buttons above the virtual keyboard.
 *
 * It has no logic of its own: every button builds the shortcut's key (Tab,
 * Ctrl+Up, Ctrl+K...) and sends it to the focused line, which handles it
 * exactly as if it came from the keyboard. `pointerdown` is cancelled so the
 * field keeps the focus (otherwise the keyboard would close on every press).
 * The bottom of the bar follows the virtual keyboard through `visualViewport`.
 */
function RowBar ({ onUndo, onRedo }) {
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setOffset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [])

  const press = (key, mods = {}) => {
    const el = document.activeElement
    if (!el?.isContentEditable) return
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }))
  }
  const B = ({ title, children, onClick }) => (
    <button className="btn ico bare" title={title} onPointerDown={e => e.preventDefault()} onClick={onClick}>{children}</button>
  )
  return (
    <div className="linebar" style={{ bottom: offset }}>
      <B title="Outdent (shift + tab)" onClick={() => press('Tab', { shiftKey: true })}><IconOutdent size={18} /></B>
      <B title="Indent (tab)" onClick={() => press('Tab')}><IconIndent size={18} /></B>
      <B title="Up (ctrl + up)" onClick={() => press('ArrowUp', { ctrlKey: true })}><IconUp size={18} /></B>
      <B title="Down (ctrl + down)" onClick={() => press('ArrowDown', { ctrlKey: true })}><IconDown size={18} /></B>
      <B title="Check (ctrl + enter)" onClick={() => press('Enter', { ctrlKey: true })}><IconCheckbox size={18} /></B>
      <B title="Note (shift + enter)" onClick={() => press('Enter', { shiftKey: true })}><IconNote size={18} /></B>
      <B title="Time (ctrl + shift + K)" onClick={() => press('k', { ctrlKey: true, shiftKey: true })}><IconClock size={18} /></B>
      <B title="Day (ctrl + K)" onClick={() => press('k', { ctrlKey: true })}><IconCalendar size={18} /></B>
      <B title="Delete (ctrl + shift + backspace)" onClick={() => press('Backspace', { ctrlKey: true, shiftKey: true })}><IconTrash size={18} /></B>
      <span className="sep" />
      <B title="Undo (ctrl + Z)" onClick={onUndo}><IconUndo size={18} /></B>
      <B title="Redo (ctrl + Y)" onClick={onRedo}><IconRedo size={18} /></B>
    </div>
  )
}

function Sidebar ({ view, setView, state, onToday, open, onAssistant, chatOpen }) {
  // The two counters cover the REAL week, today's, whatever week is displayed:
  // the server always sends it.
  const monday = weekStart(state.today)
  const currentWeek = Array.from({ length: 7 }, (_, i) => state.week[addDays(monday, i)] || []).flat()
  const total = currentWeek.filter(t => !t.checked).length
  const todayCount = (state.week[state.today] || []).filter(t => !t.checked).length
  return (
    <aside className="side">
      <div className="brand" onClick={onToday} title="Back to today"><IconLogo />{open ? <b>Agenda</b> : null}</div>
      <nav className="snav">
        <button className={`sitem${view === 'day' ? ' on' : ''}`} onClick={onToday} title="Today's day">
          <span className="i"><IconToday size={16} /></span><span className="lb">Today</span><span className="cnt">{todayCount || ''}</span>
        </button>
        <button className={`sitem${view === 'week' ? ' on' : ''}`} onClick={() => setView('week')} title="The week in columns">
          <span className="i"><IconWeek size={16} /></span><span className="lb">Week</span><span className="cnt">{total || ''}</span>
        </button>
        <button className={`sitem${view === 'inbox' ? ' on' : ''}`} onClick={() => setView('inbox')} title="What has no date yet">
          <span className="i"><IconReport size={16} /></span><span className="lb">Inbox</span>
          <span className="cnt">{(state.inbox || []).filter(t => !t.checked).length || ''}</span>
        </button>
        <span className="navsep" />
        <button className={`sitem${view === 'kb' ? ' on' : ''}`} onClick={() => setView('kb')} title="The knowledge base">
          <span className="i"><IconGraph size={16} /></span><span className="lb">Knowledge</span>
        </button>
        <span className="navsep" />
        <button className={`sitem${view === 'chat' || chatOpen ? ' on' : ''}`} onClick={onAssistant} title="Show or hide the assistant">
          <span className="i"><IconChat size={16} /></span><span className="lb">Assistant</span>
        </button>
      </nav>
    </aside>
  )
}

function TopBar ({
  view, cursor, week, state, onPrev, onNext, onGo, onUndo, onRedo, busy,
  sideOpen, onToggleSide, theme, onToggleTheme, onWorker
}) {
  const label = view === 'week'
    ? `${dayNum(week)} ${MONTHS[parse(week).getMonth()]} · ${dayNum(addDays(week, 6))} ${MONTHS[parse(addDays(week, 6)).getMonth()]}`
    : view === 'day' ? longDate(cursor || state.today) : view === 'inbox' ? 'Inbox' : view === 'kb' ? 'Knowledge' : ''
  // The short form, for the phone: "Sun 11 Oct".
  const dc = parse(cursor || state.today)
  const short = view === 'week'
    ? `${dayNum(week)}–${dayNum(addDays(week, 6))} ${MONTHS_SHORT[parse(addDays(week, 6)).getMonth()]}`
    : view === 'day' ? `${DAY_LABEL[(dc.getDay() + 6) % 7]} ${dc.getDate()} ${MONTHS_SHORT[dc.getMonth()]}` : label

  return (
    <div className="top">
      <button className="btn ico bare only-wide" onClick={onToggleSide} title={sideOpen ? 'Collapse the panel' : 'Expand the panel'}>
        <IconPanelLeft size={16} />
      </button>
      {view === 'day' || view === 'week'
        ? (
          <div className="nav">
            <button className="btn ico" onClick={onPrev} title={view === 'week' ? 'Previous week' : 'Previous day (k)'}><IconLeft size={16} /></button>
            <button className="btn ico" onClick={onNext} title={view === 'week' ? 'Next week' : 'Next day (j)'}><IconRight size={16} /></button>
          </div>
          )
        : null}
      <div className="wk"><span className="wk-long">{label}</span><span className="wk-short">{short}</span></div>
      {busy ? <span className="busy" /> : null}
      {state.failures && state.failures.length
        ? <span className="tag warn" title={state.failures.map(p => `${p.kind}: ${p.summary}`).join('\n')}>agent down</span>
        : null}
      <div className="sp" />
      <button className="btn ico" onClick={onWorker} title="Send to a worker"><IconWrench size={16} /></button>
      <button className="btn ico only-wide" onClick={onToggleTheme} title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
        {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
      </button>
      {view !== 'chat'
        ? (
          <>
            <button className="btn ico" onClick={onUndo} title="Undo (ctrl + Z)"><IconUndo size={16} /></button>
            <button className="btn ico only-wide" onClick={onRedo} title="Redo (ctrl + Y)"><IconRedo size={16} /></button>
          </>
          )
        : null}
      {view === 'day' || view === 'week'
        ? <button className="btn ico" onClick={e => onGo(e.currentTarget.getBoundingClientRect())} title="Go to a day"><IconCalendar size={16} /></button>
        : null}
    </div>
  )
}

function TokenGate ({ onSet }) {
  const [v, setV] = useState('')
  return (
    <div className="gate">
      <IconLogo size={40} />
      <h1>Agenda</h1>
      <p>Paste your access token to open the application on this device. It is asked only once.</p>
      <input className="field" type="password" value={v} onChange={e => setV(e.target.value)} placeholder="token"
        onKeyDown={e => e.key === 'Enter' && v && onSet(v.trim())} />
      <button className="btn prim" onClick={() => v && onSet(v.trim())}>Enter</button>
    </div>
  )
}
