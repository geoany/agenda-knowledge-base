import { useEffect, useRef, useState } from 'react'
import Chat from './Chat.jsx'
import { IconClose } from './Icons.jsx'

/**
 * The chat as an OS window.
 *
 * Three places, and the memory of the last one:
 *  - docked right or left: a column of the window, the content squeezes to one
 *    side as in VS Code;
 *  - docked at the bottom: a strip above the navigation bar;
 *  - free: a real floating window, grabbed by its header, dropped wherever you
 *    release it, resizable by its bottom-right corner.
 *
 * Dragging from a dock towards the middle makes it float where you release it;
 * dragging a free window against an edge (within 24 pixels) re-docks it.
 * Everything is replayed on opening: last dock, last position, last size. On a
 * phone (< 861px), none of that exists: the chat stays a full screen.
 *
 * The drag is driven here and not in `dragdrop.js`: that one carries agenda
 * targets (days, lines) in the DOM, a UI widget has none. `touch-action:none`
 * on the handle, as everywhere: the finger must take the window, never scroll
 * the list behind it.
 */
export default function ChatWidget ({ state, reload, target, onClose, dock, setDock, windowBox, setWindowBox }) {
  // The drag in progress: one pointer, one offset, and the kind of gesture
  // (moving the window or resizing it).
  const [drag, setDrag] = useState(null)
  const ref = useRef(null)

  /* The bounds of the free window: it never leaves the screen, and its size
     stays between a conversation card and three quarters of the screen. */
  const bounds = f => {
    const W = window.innerWidth
    const H = window.innerHeight
    const w = Math.min(Math.max(f.w, 300), Math.min(560, W - 40))
    const h = Math.min(Math.max(f.h, 320), H - 120)
    const x = Math.min(Math.max(f.x, 4), W - w - 4)
    const y = Math.min(Math.max(f.y, 52), H - h - 70)
    return { x, y, w, h }
  }

  const placement = dock === 'free' && windowBox ? bounds(windowBox) : null

  /**
   * An edge under the pointer: the place it offers. The 24 pixels of the edge
   * trigger the dock, the middle leaves it free.
   */
  const edgeUnder = (x, y) => {
    const W = window.innerWidth
    const H = window.innerHeight
    if (x <= 24) return 'left'
    if (x >= W - 24) return 'right'
    if (y >= H - 24) return 'bottom'
    return null
  }

  /** The dock cursor aimed at during the drag: the ghost window says where it will go. */
  const [aim, setAim] = useState(null)

  const onGrab = e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // The handle is the chat's header: the buttons it carries (threads, new,
    // close) keep their own click.
    if (e.target.closest('button')) return
    e.preventDefault()
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const origin = { x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, h: r.height, fx: r.left, fy: r.top }
    let moved = false

    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 5) return
      moved = true
      document.body.classList.add('dragging')
      const edge = edgeUnder(ev.clientX, ev.clientY)
      setAim(edge)
      if (edge && edge !== dock) return    // the ghost follows, the dock changes on release
      if (edge) return
      setWindowBox(f => bounds({
        x: ev.clientX - origin.ox,
        y: ev.clientY - origin.oy,
        w: origin.w,
        h: origin.h
      }))
      setDock('free')
    }
    const up = ev => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      document.body.classList.remove('dragging')
      setDrag(null)
      if (!moved) return
      const edge = edgeUnder(ev.clientX, ev.clientY)
      if (edge) setDock(edge)
      else if (dock !== 'free') {
        // From dock to free: the window is born where you release it, at the
        // size of the dock.
        setWindowBox(f => bounds({ x: ev.clientX - origin.ox, y: Math.min(ev.clientY - origin.oy, window.innerHeight - 400), w: origin.w || 380, h: origin.h || 480 }))
        setDock('free')
      }
      setAim(null)
    }
    const cancel = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      document.body.classList.remove('dragging')
      setDrag(null)
      setAim(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    setDrag(origin)
  }

  /** The bottom-right corner when free: you pull, the window follows, always bounded. */
  const onResize = e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const origin = { x: e.clientX, y: e.clientY, f: { ...windowBox } }
    const move = ev => {
      document.body.classList.add('dragging')
      setWindowBox(f => bounds({
        x: origin.f.x,
        y: origin.f.y,
        w: origin.f.w + (ev.clientX - origin.x),
        h: origin.f.h + (ev.clientY - origin.y)
      }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.classList.remove('dragging')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /* The bounds follow the window: resizing the browser must not leave the chat
     window off screen. */
  useEffect(() => {
    if (dock !== 'free' || !windowBox) return
    const reclamp = () => setWindowBox(f => f ? bounds(f) : f)
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [dock, windowBox])

  if (dock === 'bottom') {
    return (
      <div className="chatw chatw-bottom" ref={ref}>
        <Handle onGrab={onGrab} onClose={onClose} />
        <Chat state={state} reload={reload} target={target} onClose={onClose} />
      </div>
    )
  }
  if (dock === 'left' || dock === 'right') {
    return (
      <aside className={`chatw chatw-dock chatw-${dock}`} ref={ref}>
        <Handle onGrab={onGrab} onClose={onClose} />
        <Chat state={state} reload={reload} target={target} onClose={onClose} />
      </aside>
    )
  }
  // Free: positioned by the style, the header grabs, the corner pulls. The
  // `aim-*` classes outline the edge the window is about to dock to.
  return (
    <div
      className={`chatw chatw-free${aim ? ` aim-${aim}` : ''}`}
      ref={ref}
      style={placement ? { left: placement.x, top: placement.y, width: placement.w, height: placement.h } : undefined}
    >
      <Handle onGrab={onGrab} onClose={onClose} />
      <Chat state={state} reload={reload} target={target} onClose={onClose} />
      <span className="chatw-resize" onPointerDown={onResize} title="Resize" />
    </div>
  )
}

/**
 * The widget's top bar: it carries the drag, the close, and the current place.
 * The real thread buttons stay in the Chat, here we only add what makes the
 * window.
 */
function Handle ({ onGrab, onClose }) {
  return (
    <div className="chatw-bar" onPointerDown={onGrab}>
      <span className="chatw-grip" title="Move, release against an edge to dock">
        <i /><i /><i /><i /><i /><i />
      </span>
      <button className="btn ico sm bare chatw-close" onClick={onClose} title="Close"><IconClose size={14} /></button>
    </div>
  )
}
