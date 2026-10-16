import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { MicButton } from './Chat.jsx'
import { IconClaude, IconTerminal, IconWrench, IconLeft, IconClose } from './Icons.jsx'

/**
 * "Send to a worker": an instruction leaves in a headless, detached session,
 * inside Claude Code (on its usual model, or on a cheaper one). It is the
 * phone gesture: the user dictates a task they do not want to do themselves and
 * hands it to the server.
 *
 * The goal is chosen BEFORE, in the agenda itself: you press the wrench key,
 * the lines of the day become clickable, and the one you touch becomes the
 * goal. The pop-up then opens straight on the instruction, with the goal
 * already recalled. "Without a goal" stays possible: the same pop-up opens
 * without a goal, to dictate an instruction alone.
 *
 * Sending a goal changes the nature of the task: the server names the task in
 * the prompt and asks the worker to UPDATE it once the work is done and
 * checked. That is what makes the to-do line exist on the worker's side.
 *
 * After sending, the pop-up becomes the tracking: running or done, read from
 * `GET /worker/:id`, plus the end of the task log.
 */
export default function WorkerSend ({ stt = true, goal = null, onRepick, onClose }) {
  const [instruction, setInstruction] = useState('')
  const [worker, setWorker] = useState('claude')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [tracking, setTracking] = useState(null)   // {id, label, status}
  const [log, setLog] = useState('')
  const area = useRef(null)

  // The workers the server offers (GET /worker/options): Claude Code, and the
  // same Claude Code on a cheaper model.
  const [options, setOptions] = useState([{ id: 'claude', label: 'Claude Code' }])
  useEffect(() => {
    let alive = true
    api.workerOptions().then(r => { if (alive && r?.workers?.length) setOptions(r.workers) }).catch(() => {})
    return () => { alive = false }
  }, [])
  const choices = options.map(o => ({ ...o, Icon: o.id === 'claude' ? IconClaude : IconTerminal }))

  // Escape closes, and so does a click outside the card: it is a pop-up, not a
  // screen.
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  // The tracking: while the worker runs, we re-read its state and the end of
  // its log.
  useEffect(() => {
    if (!tracking || tracking.status !== 'running') return
    let alive = true
    const tick = async () => {
      try {
        const r = await api.workerStatus(tracking.id)
        if (!alive) return
        setLog(r.log || '')
        setTracking(s => (s ? { ...s, status: r.status, code: r.code, error: r.error } : s))
      } catch {}
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [tracking?.id, tracking?.status])

  const send = async () => {
    const text = instruction.trim()
    if ((!text && !goal) || sending) return
    setSending(true)
    setErr('')
    try {
      const r = await api.sendToWorker(text, worker, goal?.id)
      setTracking({ id: r.id, label: r.label, status: 'running', goalId: r.goalId, goal: r.goal, instruction: text })
    } catch (e) {
      setErr(e.message || 'could not send')
    } finally {
      setSending(false)
    }
  }

  const dictate = t => {
    setInstruction(c => (c.trim() ? `${c.trim()} ${t}` : t))
    setErr('')
    area.current?.focus()
  }

  const finished = tracking && tracking.status && tracking.status !== 'running'
  const statusLabel = !tracking ? '' : tracking.status === 'running'
    ? 'running'
    : tracking.status === 'abandoned'
      ? 'abandoned, timed out'
      : 'done'

  return (
    <div className="woverlay" onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="wpop" role="dialog" aria-label="Send to a worker">
        <div className="whead">
          <span className="wtitle"><IconWrench size={16} />Send to a worker</span>
          <button className="btn ico sm bare" onClick={onClose} title="Close"><IconClose size={14} /></button>
        </div>

        {tracking
          ? (
            <div className="wtrack">
              <div className={`wstat${finished ? ' finished' : ''}`}>
                <span className="wdot" />
                {tracking.label} · {statusLabel}
              </div>
              {tracking.goalId
                ? <div className="winstr-static">Goal #{tracking.goalId} · {tracking.goal}</div>
                : null}
              {tracking.instruction ? <div className="winstr-static">Instruction · {tracking.instruction}</div> : null}
              <pre className="wlog">{log ? log.slice(-4000) : 'nothing output yet'}</pre>
              <div className="wfoot">
                <button className="btn" onClick={onRepick}>New instruction</button>
                <button className="btn prim wsend" onClick={onClose}>Close</button>
              </div>
            </div>
            )
          : (
            <>
              {goal
                ? (
                  <div className="wgoal">
                    <span className="wgoal-t">Goal #{goal.id}</span>
                    <span className="wgoal-c">{goal.content}</span>
                    <button className="btn ico sm bare" onClick={onRepick} title="Change goal"><IconClose size={14} /></button>
                  </div>
                  )
                : (
                  <div className="wgoal empty">
                    <span className="wgoal-t">No goal</span>
                    <button className="btn sm bare wgoal-link" onClick={onRepick}>pick a task</button>
                  </div>
                  )}

              <textarea
                ref={area} className="field winstr" rows={3} value={instruction} autoFocus
                placeholder={goal
                  ? 'Anything to add? Optional, the task already says what to do.'
                  : 'What it must do, and where. E.g.: file this week’s screenshots into folder X.'}
                onChange={e => setInstruction(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              />

              <div className="wdictation">
                {stt ? <MicButton onText={dictate} onError={setErr} /> : null}
                <span className="whint">
                  {stt
                    ? (goal ? 'Dictate a precision if needed, the text stays editable.' : 'Dictate, the text lands in the field and stays editable.')
                    : 'Dictation unavailable on this server.'}
                </span>
              </div>

              <div className="wlab">The worker</div>
              <div className="wchoices">
                {choices.map(({ id, label, Icon }) => (
                  <button key={id} className={`btn wcard${worker === id ? ' on' : ''}`}
                    onClick={() => setWorker(id)} title={`Send to ${label}`}>
                    <Icon size={18} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              {err ? <div className="werr" onClick={() => setErr('')}>{err}</div> : null}

              <div className="wfoot">
                <button className="btn" onClick={onRepick}><IconLeft size={14} />Goal</button>
                <span className="wnote">Detached session: it keeps running if you close the app.</span>
                <button className="btn prim wsend" onClick={send} disabled={sending || (!instruction.trim() && !goal)}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </>
            )}
      </div>
    </div>
  )
}
