import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getToken } from './api.js'
import { IconClose as IconX } from './Icons.jsx'

/**
 * Attachments on screen: images, files, links.
 *
 * Three shapes, a single grid:
 *
 *  - an **image** becomes a thumbnail, and clicking it opens it large;
 *  - a **file** becomes a card with its extension and its size, and clicking it
 *    downloads it;
 *  - a **link** becomes a dark card: bold title, one line of description, the
 *    site favicon and its domain at the bottom. Clicking it opens the page in a
 *    tab.
 *
 * This file knows no screen: it is mounted as well under an outliner line as in
 * a chat bubble, and the `useDropUpload` hook gives any container paste,
 * drag-and-drop and the paperclip.
 *
 * **Nothing ever waits.** A pasted image shows up instantly from the local file
 * (`URL.createObjectURL`), the upload leaves behind it, and the local thumbnail
 * is replaced by the real one when the server answers. That is rule number one
 * of the project: the screen never shows a wait, and nothing is reloaded after
 * a successful write.
 */

/* ------------------------------------------------------------------ */
/* The server calls                                                    */
/* ------------------------------------------------------------------ */
/* They live here and not in api.js: the attachments module is self-   */
/* contained, we plug it in without touching the rest.                 */

const headers = (extra = {}) => ({
  ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
  ...extra
})

async function json (res) {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

export const attachmentsApi = {
  /**
   * The binary leaves as a raw body, exactly like voice dictation: a multipart
   * form would bring nothing and would impose one more dependency on the server
   * side to decode it. The original name travels in a header, encoded, because
   * an HTTP header does not carry accents.
   */
  upload: (file, { taskId, messageId, signal } = {}) => {
    const q = new URLSearchParams()
    if (taskId) q.set('taskId', String(taskId))
    if (messageId) q.set('messageId', String(messageId))
    return fetch(`/api/upload${q.toString() ? `?${q}` : ''}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers({
        // The body always announces itself as bytes and the real type travels
        // next to it: express.json is mounted globally on the server side, and a
        // .json file sent with its real type would be decoded into an object
        // before reaching the route. The server re-reads X-File-Type and checks
        // the content signature anyway.
        'Content-Type': 'application/octet-stream',
        'X-File-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name || 'file')
      }),
      body: file,
      signal
    }).then(json)
  },
  list: ({ taskId, messageId } = {}) => {
    const q = new URLSearchParams()
    if (taskId) q.set('taskId', String(taskId))
    if (messageId) q.set('messageId', String(messageId))
    return fetch(`/api/attachments?${q}`, { credentials: 'same-origin', headers: headers() }).then(json)
  },
  link: (url, { taskId, messageId, title } = {}) =>
    fetch('/api/attachments/link', {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url, taskId, messageId, title })
    }).then(json),
  remove: id =>
    fetch(`/api/attachments/${id}`, { method: 'DELETE', credentials: 'same-origin', headers: headers() }).then(json),
  /** Attaches after the fact the attachments sent before the message existed. */
  attach: (ids, target) =>
    fetch('/api/attachments/attach', {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ids, ...target })
    }).then(json)
}

/* ------------------------------------------------------------------ */
/* The drop hook                                                       */
/* ------------------------------------------------------------------ */

/**
 * Paste, drag-and-drop, paperclip: the three gestures of a single drop.
 *
 * Returns the local state of the attachments, the props to spread on the
 * container, and the paperclip button already mounted. The container has nothing
 * else to know.
 *
 * A URL pasted alone does not become text but a link card: it is the most
 * frequent gesture (you copy an address, you paste it), and letting it fall into
 * the input field would lose the title and the favicon.
 */
export function useDropUpload ({ taskId = null, messageId = null, initial = [], onLink = null, onError } = {}) {
  const [attachments, setAttachments] = useState(initial)
  const [dragging, setDragging] = useState(false)
  const input = useRef(null)
  const pending = useRef(0)
  const counter = useRef(0)

  const fail = useCallback(m => { onError ? onError(m) : console.error(m) }, [onError])

  /**
   * The optimistic upload.
   *
   * The local thumbnail exists BEFORE the first byte is sent: it carries a
   * negative identifier and the URL of the local object. When the server
   * answers, we replace the row in the same place instead of adding a second
   * one, otherwise the grid would jump under the eyes at every answer.
   */
  const upload = useCallback(async files => {
    const list = [...files].filter(Boolean)
    if (!list.length) return []
    const locals = list.map(f => ({
      id: -(++counter.current),
      uid: `l-${counter.current}`,
      kind: f.type?.startsWith('image/') ? 'image' : 'file',
      name: f.name || 'file',
      mime: f.type || '',
      size: f.size || 0,
      title: '',
      description: '',
      meta: {},
      src: f.type?.startsWith('image/') ? URL.createObjectURL(f) : '',
      local: true
    }))
    setAttachments(p => [...p, ...locals])
    pending.current += list.length

    const results = []
    await Promise.all(list.map(async (f, i) => {
      const placeholder = locals[i]
      try {
        const real = await attachmentsApi.upload(f, { taskId, messageId })
        results.push(real)
        setAttachments(p => p.map(x => (x.uid === placeholder.uid ? { ...real, uid: placeholder.uid } : x)))
        // The local URL is no longer used: without this release, every pasted
        // image keeps its blob in memory until the page is reloaded.
        if (placeholder.src) URL.revokeObjectURL(placeholder.src)
      } catch (e) {
        setAttachments(p => p.filter(x => x.uid !== placeholder.uid))
        if (placeholder.src) URL.revokeObjectURL(placeholder.src)
        fail(`"${placeholder.name}": ${e.message}`)
      } finally {
        pending.current--
      }
    }))
    return results
  }, [taskId, messageId, fail])

  const addLink = useCallback(async url => {
    // The card shows up right away with the domain alone: reading the page
    // sometimes takes several seconds, and a link that takes three seconds to
    // appear gives the impression that the paste did not work.
    const uid = `l-${++counter.current}`
    let domain = ''
    try { domain = new URL(url).hostname.replace(/^www\./, '') } catch { domain = url }
    setAttachments(p => [...p, { id: -counter.current, uid, kind: 'link', url, name: domain, title: domain, description: '', meta: { domain }, local: true }])
    try {
      const real = await attachmentsApi.link(url, { taskId, messageId })
      setAttachments(p => p.map(x => (x.uid === uid ? { ...real, uid } : x)))
      onLink?.(real)
      return real
    } catch (e) {
      setAttachments(p => p.filter(x => x.uid !== uid))
      fail(`Link: ${e.message}`)
      return null
    }
  }, [taskId, messageId, onLink, fail])

  const remove = useCallback(async attachment => {
    setAttachments(p => p.filter(x => (x.uid || x.id) !== (attachment.uid || attachment.id)))
    if (attachment.id > 0) { try { await attachmentsApi.remove(attachment.id) } catch (e) { fail(e.message) } }
  }, [fail])

  const onPaste = useCallback(e => {
    const dt = e.clipboardData
    if (!dt) return
    const files = [...(dt.files || [])]
    if (files.length) { e.preventDefault(); upload(files); return }
    // An address pasted alone becomes a link card. Pasted in the middle of a
    // sentence, it stays text: that is a quotation, not an attachment.
    const text = dt.getData('text/plain')?.trim()
    if (onLink !== false && text && /^https?:\/\/\S+$/i.test(text)) {
      e.preventDefault()
      addLink(text)
    }
  }, [upload, addLink, onLink])

  const zoneProps = {
    onPaste,
    onDragOver: e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true) } },
    onDragLeave: e => { if (e.currentTarget === e.target) setDragging(false) },
    onDrop: e => {
      if (!e.dataTransfer?.files?.length) { setDragging(false); return }
      e.preventDefault()
      setDragging(false)
      upload(e.dataTransfer.files)
    }
  }

  const clipButton = (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="attfile"
        onChange={e => { upload(e.target.files); e.target.value = '' }}
      />
      <button className="btn ico attclip" title="Attach an image or a file" onClick={() => input.current?.click()}>
        <IconClip size={16} />
      </button>
    </>
  )

  return { attachments, setAttachments, upload, addLink, remove, zoneProps, dragging, clipButton, open: () => input.current?.click() }
}

/* ------------------------------------------------------------------ */
/* The display                                                         */
/* ------------------------------------------------------------------ */

/**
 * The grid of the attachments of a task or a message.
 *
 * Images come first: they read at a glance where a card asks to be read. The
 * lightbox is opened here and not in each thumbnail, so that only one preview
 * exists at a time.
 */
export function AttachmentList ({ list = [], onRemove = null, dense = false }) {
  const [zoom, setZoom] = useState(null)
  if (!list.length) return null
  const images = list.filter(p => p.kind === 'image')
  const rest = list.filter(p => p.kind !== 'image')

  return (
    <div className={`att${dense ? ' dense' : ''}`}>
      {images.length
        ? (
          <div className="attimgs">
            {images.map(p => (
              <Thumb key={p.uid || p.id} attachment={p} onZoom={() => setZoom(p)} onRemove={onRemove} />
            ))}
          </div>
          )
        : null}
      {rest.map(p => (
        p.kind === 'link'
          ? <LinkCard key={p.uid || p.id} attachment={p} onRemove={onRemove} />
          : <FileCard key={p.uid || p.id} attachment={p} onRemove={onRemove} />
      ))}
      {zoom ? <Lightbox attachment={zoom} onClose={() => setZoom(null)} /> : null}
    </div>
  )
}

/** An image. Clicking it opens it large, that is the only gesture expected on it. */
function Thumb ({ attachment, onZoom, onRemove }) {
  const ratio = attachment.width && attachment.height ? attachment.width / attachment.height : null
  return (
    <figure className={`attimg${attachment.local ? ' sending' : ''}`} title={attachment.description || attachment.name}>
      <button className="attzoom" onClick={onZoom} aria-label={`Enlarge ${attachment.name}`}>
        {/* The image ratio comes from the server: without it the grid jumps as
            the images load. */}
        <img src={attachment.src} alt={attachment.description ? attachment.description.slice(0, 120) : attachment.name}
          style={ratio ? { aspectRatio: String(ratio) } : undefined} loading="lazy" />
      </button>
      {onRemove ? <button className="btn ico sm attremove" title="Remove" onClick={() => onRemove(attachment)}><IconX size={14} /></button> : null}
    </figure>
  )
}

/** A file: extension, name, size. Clicking it downloads it. */
function FileCard ({ attachment, onRemove }) {
  return (
    <div className={`attcard file${attachment.local ? ' sending' : ''}`}>
      <a className="attbody" href={attachment.src || '#'} download={attachment.name} target="_blank" rel="noopener noreferrer">
        <span className="attext">{extensionOf(attachment)}</span>
        <span className="atttxt">
          <span className="atttitle">{attachment.name}</span>
          <span className="attsub">{formatSize(attachment.size)}{attachment.local ? ' · sending…' : ''}</span>
        </span>
        <span className="attgo"><IconDown size={15} /></span>
      </a>
      {onRemove ? <button className="btn ico sm attremove" title="Remove" onClick={() => onRemove(attachment)}><IconX size={14} /></button> : null}
    </div>
  )
}

/**
 * A link.
 *
 * The card asked for by the user: bold title on ONE line, a line of grey
 * description below, and at the bottom left the favicon followed by the domain
 * in small type. Both texts are cut after one line (`-webkit-line-clamp`)
 * rather than left to overflow: a card whose height depends on the title breaks
 * the alignment of the whole grid.
 */
function LinkCard ({ attachment, onRemove }) {
  const [icon, setIcon] = useState(true)
  const domain = attachment.meta?.domain || attachment.name || hostOf(attachment.url)
  return (
    <div className={`attcard link${attachment.local ? ' sending' : ''}`}>
      <a className="attbody" href={attachment.url} target="_blank" rel="noopener noreferrer">
        <span className="atttxt">
          <span className="atttitle">{attachment.title || domain}</span>
          {attachment.description ? <span className="attdesc">{attachment.description}</span> : null}
          <span className="attsite">
            {icon && attachment.meta?.favicon
              ? <img className="attfav" src={attachment.meta.favicon} alt="" onError={() => setIcon(false)} />
              : <span className="attfav empty">{(domain[0] || '?').toUpperCase()}</span>}
            <span className="attdomain">{domain}</span>
          </span>
        </span>
        {attachment.meta?.image ? <img className="attog" src={attachment.meta.image} alt="" onError={e => { e.currentTarget.style.display = 'none' }} /> : null}
      </a>
      {onRemove ? <button className="btn ico sm attremove" title="Remove" onClick={() => onRemove(attachment)}><IconX size={14} /></button> : null}
    </div>
  )
}

/**
 * The image, large.
 *
 * Mounted as a portal on `document.body`: inside the chat or a week column, it
 * would be clipped by the `overflow` of the panel and would never fill the
 * whole screen.
 *
 * Two ways out, and both are expected: the Escape key and a click on the
 * background. A preview you do not know how to leave is a trap, especially with
 * a finger.
 */
export function Lightbox ({ attachment, onClose }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    // In the capture phase: the outliner listens for Escape too, and without
    // this the two would answer the same press.
    window.addEventListener('keydown', k, true)
    // The page background must not scroll behind the preview, especially with a finger.
    const before = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', k, true); document.body.style.overflow = before }
  }, [onClose])

  return createPortal(
    <div className="attbox" onClick={onClose} role="dialog" aria-modal="true">
      <button className="btn ico attboxclose" onClick={onClose} title="Close (Escape)"><IconX size={16} /></button>
      <img src={attachment.src} alt={attachment.name} onClick={e => e.stopPropagation()} />
      <div className="attboxfoot" onClick={e => e.stopPropagation()}>
        <span className="attboxname">{attachment.name}</span>
        <a href={attachment.src} download={attachment.name} target="_blank" rel="noopener noreferrer">download</a>
        {attachment.description
          ? <p className="attboxdesc">{attachment.description}</p>
          : null}
      </div>
    </div>,
    document.body
  )
}

/**
 * The paperclip button alone, for a container that does not want the whole hook.
 */
export function ClipButton ({ onFiles, title = 'Attach an image or a file' }) {
  const input = useRef(null)
  return (
    <>
      <input ref={input} type="file" multiple className="attfile"
        onChange={e => { onFiles([...e.target.files]); e.target.value = '' }} />
      <button className="btn ico attclip" title={title} onClick={() => input.current?.click()}>
        <IconClip size={16} />
      </button>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Small things                                                        */
/* ------------------------------------------------------------------ */

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url || '' } }

const extensionOf = p =>
  ((p.name || '').split('.').pop() || (p.mime || '').split('/').pop() || 'file').toUpperCase().slice(0, 5)

/** Disks count in bytes, the eye reads "2.4 MB". */
export function formatSize (n) {
  const o = Number(n) || 0
  if (!o) return ''
  if (o < 1024) return `${o} B`
  if (o < 1024 * 1024) return `${Math.round(o / 1024)} kB`
  return `${(o / (1024 * 1024)).toFixed(1)} MB`
}

/* The icons are drawn here rather than imported: this module plugs into  */
/* any screen without asking anything of anyone.                          */
const S = ({ children, size = 16 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
export const IconClip = p => (
  <S {...p}><path d="M20 11.5 12.4 19a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3.1 3.1 0 0 1 4.4 4.4l-7.7 7.8a1.6 1.6 0 0 1-2.2-2.2l7-7" /></S>
)
export const IconDown = p => (<S {...p}><path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M4.5 19.5h15" /></S>)
