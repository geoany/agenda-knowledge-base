import { useCallback, useRef, useState } from 'react'

/**
 * Moving a task by its handle, with a finger as well as a mouse.
 *
 * One single system for both: the browser's native drag and drop
 * (`draggable`, `dataTransfer`) does NOT fire under a finger on mobile. The app
 * is used on a phone, so native dragging was dead code there, and it is
 * replaced here by `pointer` events, which both the mouse and the finger emit.
 *
 * The gesture: press on the rectangle to the left of the line and move.
 *  - released without having moved -> it is a click, the line is selected;
 *  - released after having moved   -> the line lands where it was let go, ALONE
 *    (a line already selected with others carries the selection, and
 *    Shift+handle sweeps with the brush: batches are always explicit).
 * The six-pixel threshold stops a trembling finger from turning a selection
 * into a move.
 *
 * The target is read from the DOM under the pointer, not from the React state:
 * that way the week columns, the day view and the day bar are crossed without
 * those three screens needing to know about each other.
 */

const THRESHOLD = 6      // pixels before a press becomes a move
const MARGIN = 64        // distance to an edge that triggers auto-scroll
const SCROLL_STEP = 14   // pixels per auto-scroll frame

export function useTaskDrag ({ onTap, onDrop, onPaint }) {
  const [drag, setDrag] = useState(null)
  const raf = useRef(null)
  const pos = useRef({ x: 0, y: 0 })

  const stopScroll = () => {
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = null
  }

  const scrollLoop = useCallback(() => {
    raf.current = requestAnimationFrame(scrollLoop)
    autoScroll(pos.current.x, pos.current.y)
  }, [])

  const grab = useCallback((e, t) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const start = { x: e.clientX, y: e.clientY }
    const mods = { range: e.shiftKey, toggle: e.ctrlKey || e.metaKey }
    let moved = false
    const visited = new Set([t.id])
    pos.current = start

    const move = ev => {
      pos.current = { x: ev.clientX, y: ev.clientY }
      if (!moved) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < THRESHOLD) return
        moved = true
        // Prevents text selection and page scrolling while a line is being
        // carried: without it, the finger scrolls the list.
        document.body.classList.add('dragging')
        scrollLoop()
      }
      const target = targetAt(ev.clientX, ev.clientY, t.id)
      if (target?.type === 'row') visited.add(target.id)
      setDrag({
        id: t.id, text: t.content || '', x: ev.clientX, y: ev.clientY, target,
        n: visited.size
      })
    }

    const end = ev => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      document.body.classList.remove('dragging')
      stopScroll()
      setDrag(null)
      if (!moved) { onTap?.(t.id, mods); return }
      const target = targetAt(ev.clientX, ev.clientY, t.id)
      // Dropped on itself: the line does not move. Before, the carried line was
      // ignored under the pointer and the drop landed on the DAY holding it,
      // hence at the bottom of the list.
      if (target?.type === 'self') return
      // A bare drag is a PURE move of a single line: crossing lines on the way
      // no longer paints a selection and no longer carries the batch.
      // The old behaviour stole the destination (past two swept lines, the drop
      // became a selection and the line did not move).
      // Batch gestures stay available: Shift+handle sweeps with the brush
      // (or carries the sweep onto a day), and dropping an already SELECTED
      // line carries the whole selection (handled in dropTask, on the App side).
      const ontoDay = target?.type === 'day'
      if (mods.range && !ontoDay && visited.size > 2) { onPaint?.([...visited]); return }
      const also = mods.range && visited.size > 1 ? { also: [...visited] } : undefined
      if (target) onDrop?.(t.id, target, also)
    }

    const cancel = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      document.body.classList.remove('dragging')
      stopScroll()
      setDrag(null)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
  }, [scrollLoop, onDrop, onPaint, onTap])

  return { drag, grab }
}

/**
 * What is under the pointer, translated into a drop intention.
 *
 * We query the DOM rather than the state: the ghost has
 * `pointer-events:none`, so `elementFromPoint` does return what lies
 * underneath. A line wins over a day, otherwise a precise position inside a day
 * could never be aimed at.
 */
function targetAt (x, y, carriedId) {
  const el = document.elementFromPoint(x, y)
  if (!el?.closest) return null

  const row = el.closest('.orow[data-id]')
  if (row) {
    if (Number(row.dataset.id) === carriedId) return { type: 'self' }
    return { type: 'row', id: Number(row.dataset.id), mode: dropZone(x, y, row) }
  }

  // Week column, day view, or dot of the day bar: any element carrying a day is
  // a valid target.
  const day = el.closest('[data-day]')
  if (day?.dataset.day) return { type: 'day', day: day.dataset.day }
  return null
}

/**
 * Where the line falls on the one being hovered: above, below, or as a
 * sub-task.
 *
 * The switch to sub-task is measured on the width of the TEXT, never on that of
 * the line: a line fills the whole column, its middle falls well past the end of
 * the words and one would have to aim at the empty space on the right to
 * indent. A floor of 35 pixels keeps a usable insertion zone on a very short
 * word, otherwise "Test" would flip to sub-task from the second character on.
 */
function dropZone (x, y, el) {
  const r = el.getBoundingClientRect()
  const text = el.querySelector('.oedit')
  let pivot = r.left + r.width / 2
  if (text) {
    const left = text.getBoundingClientRect().left
    pivot = Math.min(left + Math.max(35, textWidth(text) / 2), r.right - 24)
  }
  if (x > pivot) return 'child'
  return (y - r.top) / r.height < 0.5 ? 'before' : 'after'
}

/**
 * Width actually taken by the words, and not by the block holding them: a text
 * field fills all the available space even when it only holds two words.
 */
function textWidth (el) {
  const r = document.createRange()
  r.selectNodeContents(el)
  const rects = [...r.getClientRects()]
  if (!rects.length) return el.getBoundingClientRect().width
  const left = Math.min(...rects.map(x => x.left))
  const right = Math.max(...rects.map(x => x.right))
  return Math.max(40, right - left)
}

/**
 * Auto-scroll when nearing an edge.
 *
 * Essential with a finger: the week scrolls horizontally and a loaded day
 * scrolls vertically, yet during a move the finger can no longer scroll
 * anything itself.
 */
function autoScroll (x, y) {
  const el = document.elementFromPoint(x, y)
  if (!el?.closest) return

  const board = el.closest('.board')
  if (board) {
    const r = board.getBoundingClientRect()
    if (x < r.left + MARGIN) board.scrollLeft -= SCROLL_STEP
    else if (x > r.right - MARGIN) board.scrollLeft += SCROLL_STEP
  }

  const pane = el.closest('.colbody, .zoom')
  if (pane) {
    const r = pane.getBoundingClientRect()
    if (y < r.top + MARGIN) pane.scrollTop -= SCROLL_STEP
    else if (y > r.bottom - MARGIN) pane.scrollTop += SCROLL_STEP
  }
}
