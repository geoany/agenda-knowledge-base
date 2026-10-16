import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { renderNote } from './note-md.js'
import { IconClose } from './Icons.jsx'
// The component carries its own stylesheet: that way the screen cannot arrive
// in the application without its rules, and main.jsx has nothing to know about.
import './kb.css'

/**
 * The knowledge base screen.
 *
 * It is a building block apart from the to-do list: you come here to CONSULT,
 * not to check things off. Two things only: the tree (I know where it is filed)
 * and the search (I know what it says), on the left; the note, on the right.
 *
 * Writing is not here: it goes through the agent's tools and through the files.
 * One more editor would be a second write path to maintain for a use the user
 * already makes by dictating.
 */

/* Local icons: the common set has no folder, and putting them here avoids
   touching a shared file for three strokes. */
const S = ({ children, size = 16, ...rest }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" {...rest}>{children}</svg>
)
const IconFolder = p => (<S {...p}><path d="M3 7.5a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></S>)
/* The same folder, flap lifted: it is what replaces the chevron when the branch
   is open. Two drawings rather than a rotation, because a folder does not open
   by turning and the gesture must read at once. */
const IconFolderOpen = p => (<S {...p}><path d="M3 9.2 4.6 7.6h4.2l1.6 1.9H21l-2 9.9H5Z" /><path d="M3 9.2 4.2 20.5H19" /></S>)
const IconNote = p => (<S {...p}><path d="M6 3.5h8l4.5 4.5v12.5H6Z" /><path d="M14 3.5V8h4.5M9 12.5h6M9 16h4" /></S>)
const IconSearch = p => (<S {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.6-3.6" /></S>)
const IconBack = p => (<S {...p}><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></S>)

/**
 * One colour family per top-level folder, one shade per floor.
 *
 * **The hue is ASSIGNED**, never hashed: a hash changed colour as soon as you
 * renamed something, and glued two neighbouring families onto too-close
 * oranges. The hues are frank primaries, far enough apart to read at a glance
 * in the tree.
 *
 * **The shade comes from the depth.** The root folder is vivid (saturated,
 * medium lightness). Its files and sub-folders keep ITS hue and lighten at
 * every floor. You read the belonging without reading the path.
 */
const FOLDER_HUE = {
  knowledge: 28,
  projects: 145,
  memory: 0,
  archives: 220,
  '(root)': 210
}
const SPARE_HUES = [48, 190, 288, 330, 12, 260]
function hue (name) {
  const key = String(name || '').toLowerCase()
  if (key in FOLDER_HUE) return FOLDER_HUE[key]
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return SPARE_HUES[h % SPARE_HUES.length]
}
function color (name, depth = 0) {
  const p = Math.min(Math.max(depth, 0), 4)
  return `hsl(${hue(name)} ${92 - p * 8}% ${48 + p * 8}%)`
}

/* The top-level folder of a path: it carries the hue of the whole family,
   including for a note laid ten floors below. */
const rootOf = path => String(path || '').split('/')[0] || '(root)'
/* The depth of a folder path: "knowledge" is 0, "knowledge/sources" is 1. A
   note path counts its folders, not the file. */
const depthOf = path => Math.max(0, String(path || '').split('/').length - 1)
/* The colour of a NOTE: the one of the folder holding it, so one floor less
   than its own path, without which a note would look deeper than the folder it
   is filed in. */
const noteColor = path => color(rootOf(path), depthOf(path) - 1)

const readableName = s => String(s || '').replace(/-/g, ' ')


/* The same little localStorage reader as in App.jsx: a screen state that does
   not survive closing the tab is not a preference. */
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
}

/* ------------------------------------------------------------------ */
/* The tree                                                            */
/* ------------------------------------------------------------------ */

function Branch ({ node, openFolders, toggle, current, open, level = 0 }) {
  const total = countNotes(node)
  const isOpen = openFolders.has(node.path)
  // The hue of the family, the shade of the floor. The notes of the node take
  // it again: they belong to the same folder, they have the same colour.
  const tint = color(rootOf(node.path), depthOf(node.path))
  return (
    <div className="kbbranch">
      {node.path !== '' && (
        // The folder icon replaces the chevron: it says at once the family (its
        // hue), the floor (its shade) and the state (flap closed or lifted).
        // Three pieces of information for one mark, where two were needed.
        <button className={`kbfolder${isOpen ? ' on' : ''}`} style={{ paddingLeft: 6 + level * 11 }}
          onClick={() => toggle(node.path)}>
          <span className="kbico" style={{ color: tint }}>
            {isOpen ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}
          </span>
          <span className="kbname">{readableName(node.name)}</span>
          <span className="kbn">{total}</span>
        </button>
      )}
      {(isOpen || node.path === '') && (
        <>
          {node.folders.map(d => (
            <Branch key={d.path} node={d} openFolders={openFolders} toggle={toggle}
              current={current} open={open} level={node.path === '' ? level : level + 1} />
          ))}
          {node.notes.map(n => (
            // The note carries the colour of its folder, held back: you see
            // which family it belongs to without the list becoming a tree of
            // lights.
            <button key={n.path} className={`kbfile${current === n.path ? ' on' : ''}`}
              style={{ paddingLeft: 20 + (node.path === '' ? level : level + 1) * 11 }}
              onClick={() => open(n.path)} title={n.path}>
              <span className="kbico note" style={{ color: tint }}><IconNote size={12} /></span>
              <span className="kbname">{n.title || readableName(n.path.split('/').pop().replace(/\.md$/, ''))}</span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}

const countNotes = n => n.notes.length + n.folders.reduce((s, d) => s + countNotes(d), 0)

/* ------------------------------------------------------------------ */
/* The screen                                                          */
/* ------------------------------------------------------------------ */

export default function Kb ({ visible = true, onToast }) {
  const [tree, setTree] = useState(null)
  // Folders are CLOSED by default and the open state survives the session: a
  // column tidied yesterday must reopen as it was.
  const [openFolders, setOpenFolders] = useState(() => new Set(store.get('kb-open', [])))
  const [current, setCurrent] = useState(() => store.get('kb-current', null))
  const [note, setNote] = useState(null)
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)
  // On a phone, the centre stays hidden until a note is opened.
  const [narrow, setNarrow] = useState(false)
  const body = useRef(null)

  // We start NO call until the screen has been visible once. The component is
  // mounted at all times (hiding it would lose the unfolded tree and the open
  // note), so its effects used to fire at application start, for a screen
  // nobody opens. We note the visit, once.
  const [seen, setSeen] = useState(visible)
  useEffect(() => { if (visible) setSeen(true) }, [visible])

  useEffect(() => {
    if (!seen || tree) return
    api.kbTree().then(setTree).catch(() => {})
    // Landing: the last note read, if it still exists.
    const path = store.get('kb-current', null)
    if (path) api.kbNote(path).then(setNote).catch(() => {})
  }, [seen, tree])

  /**
   * The base refreshes on its own, like the agenda.
   *
   * The knowledge base moves without this screen knowing: the night weaves, the
   * agent writes a note in conversation, Claude Code lays one down from the MCP
   * server. Without this reminder, you had to close and reopen the application
   * to see anything, which is exactly the flaw the rest of the project forbids
   * itself (see "The screen never shows a wait").
   *
   * Two moments, and two only: arriving on the screen, and coming back to the
   * foreground when already on it. No regular polling, there is nothing that
   * moves on its own while you read a note.
   */
  const refresh = useRef(() => {})
  refresh.current = () => {
    api.kbTree().then(setTree).catch(() => {})
    if (current) api.kbNote(current).then(setNote).catch(() => {})
  }

  useEffect(() => {
    if (!visible) return
    refresh.current()
    const onReturn = () => { if (document.visibilityState === 'visible') refresh.current() }
    document.addEventListener('visibilitychange', onReturn)
    return () => document.removeEventListener('visibilitychange', onReturn)
  }, [visible])

  const open = path => {
    setCurrent(path)
    store.set('kb-current', path)
    setNarrow(true)
    api.kbNote(path).then(setNote).catch(() => setNote(null))
    if (body.current) body.current.scrollTop = 0
  }

  const root = tree ? tree.tree : null

  /* The search leaves after a typing pause: one query per letter would make six
     calls for a six-letter word, and only the last one counts. */
  useEffect(() => {
    const word = q.trim()
    if (word.length < 2) { setFound(null); return }
    const t = setTimeout(() => { api.kbSearch(word).then(setFound).catch(() => {}) }, 180)
    return () => clearTimeout(t)
  }, [q])

  const toggle = path => setOpenFolders(o => {
    const n = new Set(o)
    if (n.has(path)) n.delete(path); else n.add(path)
    store.set('kb-open', [...n])
    return n
  })

  /* The body of the note, without what only serves the model (see note-md.js).
     The wiki-links [[path|Title]] in the text stay clickable. */
  const html = useMemo(() => note ? renderNote(note.body, note.title) : '', [note])

  /* Mounted at all times, hidden when you are looking at another screen: same
     pattern as .calwrap in App.jsx, so that the tree / note state survives. */
  return (
    <div className={`kb${narrow ? ' read' : ''}`} style={visible ? undefined : { display: 'none' }}>
      <aside className="kbcol">
        <div className="kbfind">
          <IconSearch size={14} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="search the notes"
            onKeyDown={e => { if (e.key === 'Escape') setQ('') }} />
          {q ? <button className="btn ico sm bare" onClick={() => setQ('')} title="Clear"><IconClose size={14} /></button> : null}
        </div>

        <div className="kblist">
          {found
            ? (
              <div className="kbres">
                <div className="kbrestitle">
                  {found.results.length
                    ? `${found.results.length} note${found.results.length > 1 ? 's' : ''}`
                    : 'nothing found'}
                </div>
                {found.results.map(r => (
                  <button key={r.path} className={`kbresult${current === r.path ? ' on' : ''}`} onClick={() => open(r.path)}>
                    <span className="kbrt">
                      <span className="kbdot" style={{ background: noteColor(r.path) }} />
                      <span>{r.title}</span>
                    </span>
                    <span className="kbrx">{r.excerpt}</span>
                    <span className="kbrp">{r.path}</span>
                  </button>
                ))}
              </div>
              )
            : root
                ? (
                  <Branch node={root} openFolders={openFolders} toggle={toggle} current={current} open={open} />
                  )
                : null}
        </div>

        {tree ? <div className="kbfoot">{tree.total} notes · {tree.folders} folders</div> : null}
      </aside>

      <div className="kbmain">
        <div className="kbtabs">
          <button className="btn ico bare kbback" onClick={() => setNarrow(false)} title="Back to the tree">
            <IconBack size={16} />
          </button>
          <span className="kbtitle">{note?.title || 'Note'}</span>
          <div className="kbsp" />
          {note ? <span className="kbpath">{note.path}</span> : null}
        </div>

        <div className="kbbody" ref={body}>
          {note
              ? (
                /* The note reads from top to bottom: the title, the TL;DR (its
                   thesis, what it claims in one sentence), then the text. The
                   other fields (counter, exception, use_for) and the weaving
                   stay in the file for the model, they do not show. */
                <article className="kbnote">
                  <header className="kbn-head">
                    <h1>{note.title}</h1>
                    <div className="kbmeta">
                      <span className="kbdot" style={{ background: noteColor(note.path) }} />
                      <span>{note.path.split('/').slice(0, -1).map(readableName).join(' / ') || 'root'}</span>
                      {note.updated ? <span>· {note.updated.slice(0, 10)}</span> : null}
                    </div>
                  </header>

                  {note.thesis ? <p className="kbtldr"><span>TL;DR</span>{note.thesis}</p> : null}

                  <div className="kbmd" dangerouslySetInnerHTML={{ __html: html }}
                    onClick={e => {
                      const a = e.target.closest && e.target.closest('a.kbwiki')
                      if (!a) return
                      const p = a.dataset.note
                      open(p.endsWith('.md') ? p : `${p}.md`)
                    }} />
                </article>
                )
              : (
                <div className="kbempty">
                  <IconFolder size={28} />
                  <p>Your knowledge base, separate from the agenda.</p>
                  <p className="kbsub">Pick a note on the left, or search for a word.</p>
                </div>
                )}
        </div>
      </div>
    </div>
  )
}
