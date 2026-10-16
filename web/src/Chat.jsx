import { useEffect, useRef, useState } from 'react'
import { api, subscribe } from './api.js'
import { renderBlock } from './markdown.js'
import { IconSend, IconLogo, IconPlus, IconChat, IconMic, IconClose } from './Icons.jsx'
import { AttachmentList, useDropUpload } from './Attachments.jsx'

/**
 * The agent's chat.
 *
 * Three things set it apart from a plain message area:
 *
 *  1. You see what it does while it does it. The server pushes one step per
 *     tool (which tool, on what, in how long) and they show up as they come.
 *     An action on the agenda is no longer a black box.
 *  2. Several threads. One topic per thread, you switch from one to the other
 *     without one's context polluting the other.
 *  3. **You can walk away.** Sending puts the message in a server-side queue and
 *     hands control back; the turn runs over there, not in this page. Locking
 *     your phone right after talking no longer cuts anything, the answer is in
 *     the database when you come back. This screen only WATCHES work that
 *     happens elsewhere: live through the event stream when it is open, by
 *     re-reading the thread when it comes back later.
 */
export default function Chat ({ state, reload, full, onClose, target }) {
  const [convs, setConvs] = useState(state.conversations || [])
  const [convId, setConvId] = useState(state.conversationId)
  const [msgs, setMsgs] = useState(state.messages || [])
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [waiting, setWaiting] = useState(0) // messages waiting their turn, server side
  const counter = useRef(0)
  const lastSent = useRef('')               // what we just wrote, to recognize our own turn
  const [live, setLive] = useState([])      // steps of the message in progress
  const [learned, setLearned] = useState([])
  const [picker, setPicker] = useState(false)
  const [err, setErr] = useState('')
  const box = useRef(null)
  const area = useRef(null)

  /* Pasting a screenshot, dropping it, or picking it with the clip: the three
     gestures of the same deposit. A pasted image shows up BEFORE being sent,
     the upload follows behind, faithful to the project rule: the screen never
     shows a wait. */
  const drop = useDropUpload({ onError: m => setErr(m) })

  /** Dictation is appended to what is already written, it never overwrites it. */
  const appendDictation = t => {
    setErr('')
    setText(x => (x.trim() ? `${x.trim()} ${t}` : t))
    area.current?.focus()
  }

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [msgs, live, pending, waiting])

  /* The agent just called out on a gesture: we switch to its thread and reload
     the messages, even if we were already there (its own thread is brand new).
     The key is the timestamp: the same target does not replay twice. */
  useEffect(() => {
    if (!target?.conversationId) return
    ;(async () => {
      try {
        const c = await api.conversation(target.conversationId)
        setConvId(target.conversationId)
        setMsgs(c.messages)
        setLive([])
      } catch {}
    })()
  }, [target?.ts])

  /**
   * Getting back in agreement with the server: the messages of the thread, and
   * where the agent stands on it.
   *
   * This is the counterpart of detached work. While this screen was closed, a
   * turn may have started, finished, or still be on its way; the truth is on
   * the server. We re-read it when arriving on a thread and when coming back to
   * the foreground, and we then find the steps already done instead of a blank.
   */
  const resync = async id => {
    if (!id) return
    try {
      const [c, st] = await Promise.all([api.conversation(id), api.chatState(id)])
      setMsgs(c.messages)
      setLive(st.steps || [])
      setPending(!!st.running)
      setWaiting(st.queue?.length || 0)
    } catch {}
  }

  useEffect(() => { resync(convId) }, [convId])

  useEffect(() => {
    const onReturn = () => { if (!document.hidden) resync(convId) }
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('focus', onReturn)
    return () => {
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('focus', onReturn)
    }
  }, [convId])

  /**
   * The live feed. The turn no longer travels through the response of the
   * send: its steps arrive through the app's shared event stream, and we keep
   * only what concerns the thread being watched.
   *
   * A `start` coming from elsewhere (the other device, another tab) triggers a
   * re-read: without it we would see the answer arrive without the question.
   */
  useEffect(() => {
    return subscribe((type, data) => {
      if (type !== 'chat' || data.conversationId !== convId) return
      const ev = data.ev || {}
      if (ev.type === 'start') {
        setPending(true)
        setLive([])
        setLearned([])
        setWaiting(n => Math.max(0, n - 1))
        if (ev.message && ev.message !== lastSent.current) resync(convId)
        return
      }
      if (ev.type === 'file') { setWaiting(Math.max(0, (data.ev.size || 1) - (pending ? 1 : 0))); return }
      if (ev.type === 'step') {
        setLive(s => {
          const i = s.findIndex(x => x.id === ev.id)
          if (i < 0) return [...s, ev]
          const copy = s.slice(); copy[i] = ev; return copy
        })
        return
      }
      if (ev.type === 'memory') { setLearned(l => [...l, ev]); return }
      if (ev.type === 'done') {
        setMsgs(x => [...x, { id: `a-${Date.now()}`, role: 'assistant', content: ev.content, steps: ev.steps }])
        setLive([])
        setPending(false)
        api.conversations().then(setConvs).catch(() => {})
        if (ev.wrote) reload()
        return
      }
      if (ev.type === 'error') {
        setMsgs(x => [...x, { id: `e-${Date.now()}`, role: 'assistant', content: `Error: ${ev.message}` }])
        setLive([])
        setPending(false)
        return
      }
      if (ev.type === 'idle') { setPending(false); setWaiting(0) }
    })
  }, [convId, pending])

  /**
   * The input area grows with the text, up to a limit, then scrolls inside its
   * own frame. We set it back to `auto` before measuring: without that its
   * height never comes back down when you erase, `scrollHeight` staying stuck
   * on the largest content it ever carried.
   */
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    const cap = Math.max(96, Math.round(window.innerHeight * 0.32))
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden'
  }, [text])

  /* Switching thread only moves the cursor: it is `resync`, on the change of
     `convId`, that fetches the messages and the turn state. One read path, so
     one place to get it wrong. */
  const switchTo = id => {
    setPicker(false)
    if (id === convId) return
    setMsgs([])
    setLive([])
    setPending(false)
    setWaiting(0)
    setConvId(id)
  }

  const newThread = async () => {
    const c = await api.newConversation()
    setConvs(await api.conversations())
    setMsgs([])
    setLive([])
    setPending(false)
    setWaiting(0)
    setConvId(c.id)
    setPicker(false)
  }

  const removeThread = async (e, id) => {
    e.stopPropagation()
    await api.delConversation(id)
    const rest = await api.conversations()
    setConvs(rest)
    if (id === convId) {
      const next = rest[0]
      if (next) switchTo(next.id)
      else newThread()
    }
  }

  /**
   * Send, then leave if you want.
   *
   * The message shows up at once and goes into the server's queue, which will
   * process it whether we stay or not. Two consequences:
   *
   *  - you can talk while it works: the second message waits its turn OVER
   *    THERE, one turn at a time and in order, each answer seeing what the
   *    previous one did;
   *  - you can close the app right away: the turn goes on, the answer is
   *    written into the thread, and you find it when you come back.
   *
   * The field is never disabled, this is precisely the moment when you want to
   * add a sentence.
   */
  const send = async () => {
    const m = text.trim()
    const attached = drop.attachments.filter(a => a.id > 0)
    if (!m && !attached.length) return
    // The model does not SEE images: it reads the description a vision model
    // wrote for them at upload time. So we give it the number of each
    // attachment, and it calls read_image if it needs one. Without this line, a
    // pasted screenshot would be purely invisible to it.
    const withAttachments = attached.length
      ? `${m}\n\n[Attachments of this message: ${attached.map(a => `#${a.id} ${a.kind === 'image' ? 'image' : a.kind === 'link' ? 'link' : 'file'} "${a.name || a.title}"`).join(', ')}]`
      : m
    setText('')
    drop.setAttachments([])
    setMsgs(x => [...x, { id: `u-${++counter.current}`, role: 'user', content: withAttachments }])
    lastSent.current = withAttachments
    // Optimistic: if a turn is already running, this one waits behind. The
    // server will confirm the count with its `file` event.
    if (pending) setWaiting(n => n + 1)
    try {
      const r = await api.chat(withAttachments, { conversationId: convId })
      // A brand new thread only has an id after this first send: the server
      // answers with the one it chose, otherwise the turn's events would be
      // filtered on `undefined` and nothing would show up.
      if (r?.conversationId && r.conversationId !== convId) setConvId(r.conversationId)
      setPending(true)
    } catch (e) {
      setMsgs(x => [...x, { id: `e-${Date.now()}`, role: 'assistant', content: `Error: ${e.message}` }])
      setWaiting(0)
    }
  }

  const title = convs.find(c => c.id === convId)?.title || 'Conversation'

  return (
    /* `attdrop` and `dropover` are the drop-outline classes of attachments.css. */
    <div className={`chat${full ? ' full' : ''} attdrop${drop.dragging ? ' dropover' : ''}`} {...drop.zoneProps}>
      <div className="chead">
        <span className="av"><IconLogo size={17} /></span>
        <button className="cthread" onClick={() => setPicker(p => !p)} title="Switch conversation">
          {title}<span className="caret" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m7 10 5 5 5-5" /></svg></span>
        </button>
        <button className="btn ico sm bare" onClick={newThread} title="New conversation"><IconPlus size={14} /></button>
        {onClose ? <button className="btn ico sm bare" onClick={onClose} title="Hide"><IconClose size={14} /></button> : null}

        {picker && (
          <div className="threads">
            {convs.length === 0 ? <div className="tempty">no conversation</div> : null}
            {convs.map(c => (
              <button key={c.id} className={`thread${c.id === convId ? ' on' : ''}`} onClick={() => switchTo(c.id)}>
                <span className="ti"><IconChat size={13} /></span>
                <span className="tt">{c.title}</span>
                <span className="tn">{c.message_count}</span>
                <span className="tx" onClick={e => removeThread(e, c.id)} title="Archive"><IconClose size={13} /></span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="msgs" ref={box}>
        {msgs.length === 0 && !pending
          ? <div className="chint">Tell it what you have to do, it files it on the right day. It learns your habits as you go.</div>
          : null}

        {msgs.map(m => (
          <div key={m.id} className={`mwrap ${m.role === 'user' ? 'me' : 'ai'}`}>
            {m.steps?.length ? <Steps list={m.steps} /> : null}
            {/* The agent answers in markdown: lists, bold, code blocks. Rendered
                as is we read the stars and the dashes. The user's messages stay
                raw, they do not write in markdown. */}
            {m.role === 'user'
              ? <div className="m me">{m.content}</div>
              : <div className="m ai md" dangerouslySetInnerHTML={{ __html: renderBlock(m.content) }} />}
          </div>
        ))}

        {live.length ? <Steps list={live} live /> : null}
        {pending && !live.length ? <div className="m ai pending">…</div> : null}

        {/* What is waiting its turn has already left for the server: we say it
            in one line rather than showing the sentences again, they are just
            above in the thread, in their place. */}
        {waiting > 0
          ? <div className="learned" title="The server will process them one after the other">
              {waiting === 1 ? 'one message waiting its turn' : `${waiting} messages waiting their turn`}
            </div>
          : null}
        {learned.map((l, i) => (
          <div key={i} className="learned" title="It will remember that next time">
            {l.kind === 'rule' ? 'new rule' : 'remembered'} · {l.text.replace(/^Rule \d+ recorded: |^Remembered: /, '')}
          </div>
        ))}
      </div>

      {/* Attachments come out of the horizontal flex of `.cin`: put inside, they
          would crush the field as soon as there is more than one. */}
      {drop.attachments.length
        ? <div className="cattach"><AttachmentList list={drop.attachments} dense onRemove={drop.remove} /></div>
        : null}

      <div className="cin">
        <textarea ref={area} rows={1} value={text} placeholder="Say something…"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        {drop.clipButton}
        {state.stt !== false
          ? <MicButton onText={appendDictation} onError={m => setErr(m)} />
          : null}
        {/* Never disabled while it answers: this is precisely the moment when
            you want to be able to add a sentence, it will wait its turn. */}
        <button className="btn ico prim round" onClick={send} title={pending ? 'Queue it' : 'Send'}><IconSend size={16} /></button>
      </div>
      {err ? <div className="cerr" onClick={() => setErr('')}>{err}</div> : null}
    </div>
  )
}

/**
 * The dictation button.
 *
 * It is the main way in on a phone: the user never types there. One press
 * starts, a second stops and sends; no press-and-hold, which releases on the
 * slightest scroll and loses the sentence.
 *
 * The recording format is not chosen at random: Safari on iPhone cannot
 * produce webm, you have to let it have its mp4. So we ask for the first format
 * the browser declares it can write.
 *
 * Exported: other places dictate with the same button, and duplicating the
 * MediaRecorder mechanics would give two places to fix at Safari's next whim.
 */
export function MicButton ({ onText, onError }) {
  const [phase, setPhase] = useState('ready')   // ready | listening | sending, also the class of the button
  const [sec, setSec] = useState(0)
  const recorder = useRef(null)
  const stream = useRef(null)

  useEffect(() => {
    if (phase !== 'listening') return
    const t = setInterval(() => setSec(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  // Safety net: two minutes of recording forgotten in a pocket is plenty,
  // beyond that we would pay for a transcription nobody asked for.
  useEffect(() => { if (sec >= 120) stop() }, [sec])

  const pickFormat = () => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    return candidates.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || ''
  }

  const start = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      })
      stream.current = s
      const mimeType = pickFormat()
      const r = new MediaRecorder(s, mimeType ? { mimeType } : undefined)
      const chunks = []
      r.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      r.onstop = async () => {
        stream.current?.getTracks().forEach(p => p.stop())
        stream.current = null
        const blob = new Blob(chunks, { type: r.mimeType || mimeType || 'audio/webm' })
        // Less than a tenth of a second: a missed press, nothing to transcribe.
        if (blob.size < 1200) { setPhase('ready'); return }
        setPhase('sending')
        try {
          const t = await api.transcribe(blob)
          if (t) onText(t)
          else onError('Heard nothing.')
        } catch (e) {
          onError(`Dictation: ${e.message}`)
        } finally { setPhase('ready') }
      }
      r.start()
      recorder.current = r
      setSec(0)
      setPhase('listening')
    } catch (e) {
      // Microphone denied, or page served without HTTPS: the browser cuts
      // access to the microphone outside a secure origin, including on a local
      // IP.
      onError(e.name === 'NotAllowedError'
        ? 'Microphone denied. Allow it in your browser settings.'
        : `Microphone unavailable: ${e.message}`)
      setPhase('ready')
    }
  }

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
    recorder.current = null
  }

  const toggle = () => (phase === 'listening' ? stop() : phase === 'ready' ? start() : null)
  const clock = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

  return (
    <button className={`btn ico mic ${phase}`} onClick={toggle} disabled={phase === 'sending'}
      title={phase === 'listening' ? 'Stop and transcribe' : 'Dictate'}>
      <IconMic size={16} />
      {phase === 'listening' ? <span className="mtime">{clock}</span> : null}
      {phase === 'sending' ? <span className="mtime">…</span> : null}
    </button>
  )
}

/** The run of tools: one line per action, with its state and its duration. */
function Steps ({ list, live }) {
  return (
    <div className={`steps${live ? ' live' : ''}`}>
      {list.map((s, i) => (
        <div key={`${s.id}-${i}`} className={`step ${s.status}`}>
          <span className="dot" />
          <span className="lb">{s.label}</span>
          {s.args && Object.keys(s.args).length
            ? <span className="ar">{summarize(s.args)}</span>
            : null}
          {s.ms > 5 ? <span className="ms">{s.ms} ms</span> : null}
        </div>
      ))}
    </div>
  )
}

/** The arguments in one short line: we want to recognize the action, not re-read it. */
function summarize (args) {
  const v = args.content ?? args.text ?? args.query ?? args.title ?? args.day ?? args.id ?? ''
  const s = String(v)
  return s.length > 42 ? s.slice(0, 42) + '…' : s
}
