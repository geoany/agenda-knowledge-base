import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconLeft, IconRight, IconClose } from './Icons.jsx'

/**
 * The date and time pickers of the application, drawn here and nowhere else.
 *
 * No native browser field (`prompt`, `<input type="time">`): they come with the
 * font, the size and the logic of each system, and the `prompt` window blocks
 * the whole page. One mechanism for everything:
 *
 *  - `Pop` is the shell. On a large screen it anchors under the element that
 *    opened it (above it when there is no room); on a phone it becomes a sheet
 *    laid at the bottom of the screen, where the thumb reaches. Escape or a
 *    click next to it closes it.
 *  - `Calendar` is the grid of a month. It serves the top bar (go to a day) AND
 *    the day choice of a line: a single calendar in the application.
 *  - `DayPicker` and `TimePicker` are the two contents put in it.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d) }
const isPhone = () => window.matchMedia('(max-width: 860px)').matches

/* ------------------------------------------------------------------ */
/* The shell                                                           */
/* ------------------------------------------------------------------ */

export function Pop ({ anchor, title, onClose, children, width = 280 }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  const sheet = isPhone() || !anchor

  useLayoutEffect(() => {
    if (sheet || !ref.current) return
    const r = anchor
    const h = ref.current.offsetHeight
    const margin = 8
    const left = Math.min(Math.max(margin, r.right - width), window.innerWidth - width - margin)
    const below = r.bottom + 6
    const top = below + h > window.innerHeight - margin ? Math.max(margin, r.top - h - 6) : below
    setPos({ left, top })
  }, [anchor, sheet, width])

  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    const outside = e => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    window.addEventListener('keydown', esc, true)
    // On the next turn: the click that opened the pop-up must not close it.
    const t = setTimeout(() => document.addEventListener('pointerdown', outside), 0)
    return () => {
      window.removeEventListener('keydown', esc, true)
      clearTimeout(t)
      document.removeEventListener('pointerdown', outside)
    }
  }, [onClose])

  const body = (
    <div
      ref={ref}
      className={`pop${sheet ? ' sheet' : ''}`}
      style={sheet ? undefined : { width, ...(pos || { visibility: 'hidden', left: 0, top: 0 }) }}
      role="dialog"
    >
      {title
        ? (
          <div className="pop-head">
            <span>{title}</span>
            <button className="btn ico sm bare" onClick={onClose} title="Close (Esc)"><IconClose size={14} /></button>
          </div>
          )
        : null}
      {children}
    </div>
  )
  return sheet ? <div className="overlay">{body}</div> : body
}

/* ------------------------------------------------------------------ */
/* The calendar                                                        */
/* ------------------------------------------------------------------ */

export function Calendar ({ value, today, onPick }) {
  const [month, setMonth] = useState(() => { const d = parse(value || today); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const offset = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: count }, (_, i) => iso(new Date(month.getFullYear(), month.getMonth(), i + 1)))
  ]
  return (
    <div className="cal">
      <div className="cal-head">
        <button className="btn ico sm bare" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))} title="Previous month"><IconLeft size={14} /></button>
        <span>{MONTHS[month.getMonth()]} {month.getFullYear()}</span>
        <button className="btn ico sm bare" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))} title="Next month"><IconRight size={14} /></button>
      </div>
      <div className="cal-grid">
        {DAYS.map(j => <span key={j} className="cal-dow">{j[0]}</span>)}
        {cells.map((d, i) => d
          ? (
            <button key={d} onClick={() => onPick(d)}
              className={`cal-day${d === today ? ' today' : ''}${d === value ? ' on' : ''}${d < today ? ' past' : ''}`}>
              {parse(d).getDate()}
            </button>
            )
          : <span key={`x${i}`} />)}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Picking the day of a line                                           */
/* ------------------------------------------------------------------ */

/**
 * The shortcuts first (today, tomorrow, Saturday, Monday, no day), the month
 * after: nine times out of ten the line leaves for one of the first four. "No
 * day" takes the line out of the calendar, it is the same gesture as the
 * eighth cell of the day rail.
 */
export function DayPicker ({ value, today, onPick }) {
  const dow = (parse(today).getDay() + 6) % 7
  const saturday = addDays(today, dow < 5 ? 5 - dow : 7 + 5 - dow)
  const monday = addDays(today, 7 - dow)
  const quick = [
    ['Today', today],
    ['Tomorrow', addDays(today, 1)],
    ['Saturday', saturday],
    ['Monday', monday]
  ]
  return (
    <div className="choice">
      <div className="chips">
        {quick.map(([label, d]) => (
          <button key={label} className={`btn sm${d === value ? ' on' : ''}`} onClick={() => onPick(d)}>{label}</button>
        ))}
        <button className={`btn sm${value === null ? ' on' : ''}`} onClick={() => onPick(null)}>No day</button>
      </div>
      <Calendar value={value} today={today} onPick={onPick} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Picking the time of a line                                          */
/* ------------------------------------------------------------------ */

const HOURS = Array.from({ length: 18 }, (_, i) => i + 6)   // 6am -> 11pm
const MINUTES = [0, 15, 30, 45]
const DURATIONS = [[15, '15m'], [30, '30m'], [45, '45m'], [60, '1h'], [90, '1h 30m'], [120, '2h']]
const sayTime = (h, m) => `${h}:${String(m).padStart(2, '0')}`

/**
 * Three rows you touch, not a field you type: the hour, the minutes, the
 * duration. Nothing leaves before "Confirm": you can change your mind on the
 * hour after having chosen the duration. "Remove" takes the slot away, the line
 * stays where it is.
 */
export function TimePicker ({ start, duration, onConfirm, onRemove }) {
  const parsed = /^(\d{1,2}):(\d{2})$/.exec(start || '')
  const [h, setH] = useState(parsed ? Number(parsed[1]) : null)
  const [m, setM] = useState(parsed ? Number(parsed[2]) : 0)
  const [d, setD] = useState(duration || 30)
  const confirm = () => { if (h != null) onConfirm(`${h}:${String(m).padStart(2, '0')}`, d) }

  useEffect(() => {
    const k = e => { if (e.key === 'Enter') { e.preventDefault(); confirm() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  return (
    <div className="choice">
      <div className="choice-label">Hour</div>
      <div className="grid6">
        {HOURS.map(x => (
          <button key={x} className={`btn sm${x === h ? ' on' : ''}`} onClick={() => setH(x)}>{x}:00</button>
        ))}
      </div>
      <div className="choice-label">Minutes</div>
      <div className="grid4">
        {MINUTES.map(x => (
          <button key={x} className={`btn sm${x === m ? ' on' : ''}`} onClick={() => setM(x)}>{String(x).padStart(2, '0')}</button>
        ))}
      </div>
      <div className="choice-label">Duration</div>
      <div className="grid3">
        {DURATIONS.map(([x, label]) => (
          <button key={x} className={`btn sm${x === d ? ' on' : ''}`} onClick={() => setD(x)}>{label}</button>
        ))}
      </div>
      <div className="choice-foot">
        {start ? <button className="btn" onClick={onRemove}>Remove the time</button> : <span />}
        <button className="btn prim" onClick={confirm} disabled={h == null}>
          {h == null ? 'Pick an hour' : `Confirm ${sayTime(h, m)}`}
        </button>
      </div>
    </div>
  )
}
