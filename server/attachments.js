import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { dirname, resolve, join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, now } from './db.js'

/**
 * Attachments: where the binary lives, and what we know about it.
 *
 * A file is never stored under its original name but under the fingerprint of
 * its content. Two consequences, both intended: pasting the same screenshot
 * twice stores a single file, and no name coming from the browser ever ends up
 * in a disk path ("../../.env" as a file name would otherwise be an open door).
 *
 * The database row keeps the original name for display. The disk only ever
 * knows fingerprints.
 */

const here = dirname(fileURLToPath(import.meta.url))
export const FILES_DIR = process.env.AGENDA_FILES || resolve(process.env.AGENDA_DATA_DIR || resolve(here, '../data'), 'files')
mkdirSync(FILES_DIR, { recursive: true })

/* Ten megabytes. Beyond that it is no longer an agenda attachment but a file   */
/* transfer, and the database serves a phone on 4G.                             */
export const MAX_UPLOAD_SIZE = Number(process.env.AGENDA_UPLOAD_MAX || 10 * 1024 * 1024)

/**
 * The accepted types, and nothing else.
 *
 * The list is an allow list and not a deny list: an unknown type is refused,
 * otherwise every new executable format would have to be thought of in advance.
 * SVG is deliberately absent, it is XML that can carry a script and that we
 * would serve from our own domain.
 */
export const TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods'
}

export const isAcceptedType = mime => Boolean(TYPES[normalizeMime(mime)])
export const isImage = mime => String(mime || '').startsWith('image/')

/** The MIME type without its charset parameter, lowercased. */
export function normalizeMime (mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase()
}

/**
 * The real type of the file, read from its first bytes.
 *
 * The browser announces a type, but that is a declaration: it can be missing
 * (drag and drop from some applications) or wrong. Signatures do not lie, so we
 * prefer them as soon as we recognize one.
 */
export function sniffMime (buf, declared = '') {
  if (!buf || buf.length < 12) return normalizeMime(declared)
  const b = buf
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12)
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif'
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic'
  }
  if (b.toString('ascii', 0, 4) === '%PDF') return 'application/pdf'
  // A docx or an xlsx is a zip: the signature cannot tell them apart, so we
  // keep what the browser announces when it announces something known, and
  // fall back to zip otherwise.
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05)) {
    const d = normalizeMime(declared)
    return TYPES[d] && d !== 'application/zip' ? d : 'application/zip'
  }
  return normalizeMime(declared)
}

/* ------------------------------------------------------------------ */
/* Dimensions of an image, read from its headers                       */
/* ------------------------------------------------------------------ */
/* Four formats, four headers, about forty lines. An image decoding      */
/* dependency weighs several megabytes and compiles native code, for a   */
/* piece of information we only need at upload time and that fits in the */
/* first twenty bytes of the file.                                       */
/*                                                                       */
/* The dimensions are for the front end: without them a grid of          */
/* thumbnails jumps around as the images arrive.                         */

export function imageSize (buf) {
  if (!buf || buf.length < 16) return {}
  try {
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf)
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return webpSize(buf)
  } catch { /* truncated header: no dimensions, never an error */ }
  return {}
}

/**
 * JPEG does not carry its dimensions at a fixed position: the segments have to
 * be walked until the start-of-frame (SOF) marker. So we jump from length to
 * length, skipping the table segments (C4, C8, CC) that share the same prefix
 * as the frames.
 */
function jpegSize (buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return {}
}

/** WebP has three container variants, and each one stores its size elsewhere. */
function webpSize (buf) {
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    const b0 = buf[21]; const b1 = buf[22]; const b2 = buf[23]; const b3 = buf[24]
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    }
  }
  return {}
}

/* ------------------------------------------------------------------ */
/* The disk                                                            */
/* ------------------------------------------------------------------ */

/** A readable original name, without path or control character. */
export function cleanFileName (name, mime) {
  const raw = basename(String(name || '').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (raw && raw !== '.' && raw !== '..') return raw.slice(0, 120)
  const ext = TYPES[normalizeMime(mime)] || 'bin'
  return `attachment.${ext}`
}

/**
 * Writes the binary and returns what is needed to create the row.
 *
 * Does the file already exist? We do not rewrite it: `dedup` goes back to the
 * caller, who can then skip the description by the vision model. That is where
 * deduplication really pays off, thirteen seconds of call avoided, far more
 * than the few kilobytes of disk.
 */
export function storeFile (buf, { name = '', mime = '' } = {}) {
  if (!buf || !buf.length) throw new Error('empty file')
  if (buf.length > MAX_UPLOAD_SIZE) {
    throw Object.assign(new Error(`File too large: ${Math.round(buf.length / 1024)} kB, the limit is ${Math.round(MAX_UPLOAD_SIZE / 1024)} kB.`), { code: 'too_large' })
  }
  const real = sniffMime(buf, mime)
  if (!isAcceptedType(real)) {
    throw Object.assign(new Error(`File type rejected: ${real || 'unknown'}.`), { code: 'type_rejected' })
  }

  const hash = createHash('sha256').update(buf).digest('hex')
  const ext = TYPES[real]
  // Two levels of sub-folder: a flat directory of several thousand entries
  // becomes painful to list the day you want to look inside it.
  const rel = join(hash.slice(0, 2), `${hash}.${ext}`)
  const abs = join(FILES_DIR, rel)
  const dedup = existsSync(abs)
  if (!dedup) {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, buf)
  }

  const dims = isImage(real) ? imageSize(buf) : {}
  return {
    hash,
    path: rel,
    size: buf.length,
    mime: real,
    kind: isImage(real) ? 'image' : 'file',
    name: cleanFileName(name, real),
    width: dims.width ?? null,
    height: dims.height ?? null,
    dedup
  }
}

/** The absolute path of an attachment, or null if the binary has disappeared. */
export function absolutePath (row) {
  if (!row?.path) return null
  // The path comes from the database and not from the network, but we still
  // check that it stays under data/files: a hand-made row must not be able to
  // make us serve /etc/passwd.
  const abs = resolve(FILES_DIR, row.path)
  if (!abs.startsWith(resolve(FILES_DIR))) return null
  return existsSync(abs) ? abs : null
}

/* ------------------------------------------------------------------ */
/* The database                                                        */
/* ------------------------------------------------------------------ */

const rowToAttachment = r => r && ({
  id: r.id,
  taskId: r.task_id,
  messageId: r.message_id,
  kind: r.kind,
  url: r.url,
  name: r.name,
  mime: r.mime,
  size: r.size,
  width: r.width,
  height: r.height,
  title: r.title,
  description: r.description,
  meta: parseMeta(r.meta),
  createdAt: r.created_at,
  // The front end never knows the path on disk: it asks for the attachment by
  // its number, and the server decides what it serves.
  src: r.kind === 'link' ? r.url : `/api/files/${r.id}`
})

const parseMeta = s => { try { return s ? JSON.parse(s) : {} } catch { return {} } }

export function createAttachment (p) {
  const info = db.prepare(`
    INSERT INTO attachments (task_id, message_id, kind, url, path, hash, name, mime, size, width, height, title, description, meta, created_at)
    VALUES (@task_id, @message_id, @kind, @url, @path, @hash, @name, @mime, @size, @width, @height, @title, @description, @meta, @created_at)
  `).run({
    task_id: p.taskId ?? null,
    message_id: p.messageId ?? null,
    kind: p.kind || 'file',
    url: p.url ?? null,
    path: p.path ?? null,
    hash: p.hash ?? null,
    name: p.name || '',
    mime: p.mime || '',
    size: p.size || 0,
    width: p.width ?? null,
    height: p.height ?? null,
    title: p.title || '',
    description: p.description || '',
    meta: p.meta ? JSON.stringify(p.meta) : '',
    created_at: now()
  })
  return getAttachment(Number(info.lastInsertRowid))
}

export const getAttachment = id => rowToAttachment(db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id)))

/** The raw row, path on disk included: reserved for serving the file. */
export const getAttachmentRow = id => db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id))

export function listAttachments ({ taskId = null, messageId = null, limit = 200 } = {}) {
  if (taskId != null) {
    return db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY id ASC LIMIT ?')
      .all(Number(taskId), limit).map(rowToAttachment)
  }
  if (messageId != null) {
    return db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY id ASC LIMIT ?')
      .all(Number(messageId), limit).map(rowToAttachment)
  }
  return db.prepare('SELECT * FROM attachments ORDER BY id DESC LIMIT ?').all(limit).map(rowToAttachment)
}

/**
 * The attachments of several tasks at once, grouped by task.
 *
 * A day of thirty lines would make thirty requests if we queried task by task.
 * The front end receives a dictionary and only has to pick from it.
 */
export function attachmentsByTask (ids = []) {
  const list = [...new Set(ids.map(Number).filter(Boolean))]
  if (!list.length) return {}
  const rows = db.prepare(`SELECT * FROM attachments WHERE task_id IN (${list.map(() => '?').join(',')}) ORDER BY id ASC`).all(...list)
  const out = {}
  for (const r of rows) (out[r.task_id] ||= []).push(rowToAttachment(r))
  return out
}

/**
 * Deletes the row, and the binary only if nobody else uses it.
 *
 * This is the counterpart of deduplication: the same screenshot pasted into a
 * task and into the chat shares a single file, deleting one must not kill the
 * image of the other.
 */
export function deleteAttachment (id) {
  const row = getAttachmentRow(id)
  if (!row) return { ok: false }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(Number(id))
  if (row.hash) {
    const left = db.prepare('SELECT COUNT(*) n FROM attachments WHERE hash = ?').get(row.hash).n
    if (left === 0) {
      const abs = absolutePath(row)
      if (abs) { try { unlinkSync(abs) } catch { /* already gone, all the better */ } }
    }
  }
  return { ok: true, id: Number(id) }
}

/** Attaches an attachment to a task or a message after the fact. */
export function attachTo (id, { taskId, messageId } = {}) {
  const sets = []
  const vals = []
  if (taskId !== undefined) { sets.push('task_id = ?'); vals.push(taskId == null ? null : Number(taskId)) }
  if (messageId !== undefined) { sets.push('message_id = ?'); vals.push(messageId == null ? null : Number(messageId)) }
  if (!sets.length) return getAttachment(id)
  db.prepare(`UPDATE attachments SET ${sets.join(', ')} WHERE id = ?`).run(...vals, Number(id))
  return getAttachment(id)
}

/** Writes the description after the fact (the vision model answers after the insert). */
export function setDescription (id, description, meta) {
  db.prepare('UPDATE attachments SET description = ?, meta = ? WHERE id = ?')
    .run(String(description || ''), meta ? JSON.stringify(meta) : '', Number(id))
  return getAttachment(id)
}

/** Readable size: 340 kB, 2.4 MB. Disks count in bytes, the eye does not. */
export function humanSize (n) {
  const o = Number(n) || 0
  if (o < 1024) return `${o} B`
  if (o < 1024 * 1024) return `${Math.round(o / 1024)} kB`
  return `${(o / (1024 * 1024)).toFixed(1)} MB`
}

/** The extension shown on a file card, in capitals. */
export const extensionOf = (name, mime) =>
  (extname(String(name || '')).replace('.', '') || TYPES[normalizeMime(mime)] || 'file').toUpperCase().slice(0, 5)

export const fileExists = abs => Boolean(abs && existsSync(abs) && statSync(abs).isFile())

/**
 * The description already computed for this exact content.
 *
 * This is where deduplication really pays off: the same screenshot pasted again
 * into another task finds its description instantly, instead of paying several
 * seconds of vision model to rewrite it identically.
 */
export function knownDescription (hash) {
  if (!hash) return null
  return db.prepare("SELECT description, meta FROM attachments WHERE hash = ? AND description <> '' ORDER BY id ASC LIMIT 1").get(hash) || null
}

/* ------------------------------------------------------------------ */
/* The routes                                                          */
/* ------------------------------------------------------------------ */
/* They are set up here rather than copied into index.js: the whole      */
/* attachment batch plugs in with two lines, and there is only one       */
/* place to read what each route does.                                   */

/**
 * Plugs the attachment routes onto the already authenticated `/api` router.
 *
 * `express` is passed as an argument rather than imported: the module then
 * depends on nothing, and can be tested on a throwaway application.
 */
export function mountAttachmentRoutes (api, express, { describeImage = null, fetchLinkPreview = null } = {}) {
  /**
   * Uploading a file, as a RAW BODY.
   *
   * Exactly like voice dictation on /api/transcribe: the browser sends a single
   * file, a multipart form would bring nothing and would impose one more
   * dependency to decode it. The original name travels in a header, encoded,
   * because an HTTP header does not carry accents.
   *
   * The description of the image is written HERE, once. The screen, for its
   * part, does not wait: the local thumbnail is already displayed before the
   * first byte is sent.
   */
  api.post('/upload',
    // Transport limit well above the business limit: we would rather read the
    // file and refuse it ourselves with a clear sentence than let express cut
    // the connection on an unreadable error.
    express.raw({ type: () => true, limit: '32mb' }),
    async (req, res) => {
      try {
        const name = decodeURIComponent(req.get('x-file-name') || '')
        // The real type travels in its own header and the body announces itself
        // as bytes: express.json is mounted globally, and a .json file sent with
        // its real type would be decoded into an object before reaching here.
        const declared = req.get('x-file-type') || req.get('content-type')
        const file = storeFile(req.body, { name, mime: declared })

        const attachment = createAttachment({
          taskId: req.query.taskId ? Number(req.query.taskId) : null,
          messageId: req.query.messageId ? Number(req.query.messageId) : null,
          kind: file.kind,
          path: file.path,
          hash: file.hash,
          name: file.name,
          mime: file.mime,
          size: file.size,
          width: file.width,
          height: file.height
        })

        if (file.kind !== 'image' || req.query.describe === '0' || !describeImage) return res.json(attachment)

        // Already seen: we copy the description instead of paying for the call again.
        const known = knownDescription(file.hash)
        if (known) {
          return res.json(setDescription(attachment.id, known.description, { ...safeJson(known.meta), reused: true }))
        }

        const ctrl = new AbortController()
        res.on('close', () => ctrl.abort())
        const seen = await describeImage(req.body, file.mime, { signal: ctrl.signal })
        if (res.writableEnded) return
        // A vision failure does not prevent the attachment from existing: it is
        // already in the database and already on screen, it simply will not have
        // a description.
        res.json(seen.description
          ? setDescription(attachment.id, seen.description, { model: seen.model, ms: seen.ms })
          : { ...attachment, visionError: seen.error || '' })
      } catch (e) {
        const code = e.code === 'too_large' ? 413 : (e.code === 'type_rejected' ? 415 : 500)
        if (code === 500) console.error('upload:', e)
        res.status(code).json({ error: String(e.message || e) })
      }
    },
    // A body beyond the transport limit arrives here and not in the try: without
    // this net, express answers an HTML error page the front end cannot read.
    (err, req, res, next) => {
      if (res.headersSent) return next(err)
      const tooBig = err?.type === 'entity.too.large' || err?.status === 413
      res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `File too large: the limit is ${Math.round(MAX_UPLOAD_SIZE / 1024 / 1024)} MB.` : String(err?.message || err)
      })
    })

  /**
   * The binary.
   *
   * The front end never knows the path on disk: it asks for the attachment by
   * its number. The content being addressed by its fingerprint, it will never
   * change for that number, hence the long caching.
   */
  api.get('/files/:id', (req, res) => {
    const row = getAttachmentRow(req.params.id)
    const abs = absolutePath(row)
    if (!abs) return res.status(404).json({ error: 'not found' })
    const name = encodeURIComponent(row.name || 'file')
    // An image or a PDF opens in the page, the rest downloads. The nosniff is
    // essential: without it a browser can decide on its own that a text file is
    // HTML and run it on our domain.
    const inline = row.mime?.startsWith('image/') || row.mime === 'application/pdf'
    res.setHeader('content-type', row.mime || 'application/octet-stream')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('cache-control', 'private, max-age=31536000, immutable')
    res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`)
    res.sendFile(abs)
  })

  api.get('/attachments', (req, res) => {
    res.json(listAttachments({
      taskId: req.query.taskId ? Number(req.query.taskId) : null,
      messageId: req.query.messageId ? Number(req.query.messageId) : null,
      limit: Number(req.query.limit) || 200
    }))
  })

  /** The attachments of several tasks at once, for a whole day. */
  api.get('/attachments/by-task', (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean)
    res.json(attachmentsByTask(ids))
  })

  /**
   * Attaching a link.
   *
   * Reading the page can fail (dead site, 403, timeout): the link is attached
   * anyway, with its domain alone. Losing a link because the site was under
   * maintenance would be absurd.
   */
  api.post('/attachments/link', async (req, res) => {
    try {
      const url = String(req.body?.url || '').trim()
      if (!url) return res.status(400).json({ error: 'missing url' })
      const meta = fetchLinkPreview ? await fetchLinkPreview(url) : { url, domain: '', title: url, description: '', favicon: '', image: '' }
      res.json(createAttachment({
        taskId: req.body?.taskId ? Number(req.body.taskId) : null,
        messageId: req.body?.messageId ? Number(req.body.messageId) : null,
        kind: 'link',
        url: meta.url || url,
        name: meta.domain || '',
        title: String(req.body?.title || '').trim() || meta.title || meta.domain || url,
        description: meta.description || '',
        mime: meta.mime || 'text/html',
        meta: { favicon: meta.favicon || '', image: meta.image || '', domain: meta.domain || '' }
      }))
    } catch (e) {
      console.error('link:', e)
      res.status(500).json({ error: String(e.message || e) })
    }
  })

  /**
   * Attaching after the fact.
   *
   * An image pasted into the chat is sent BEFORE the message exists: the front
   * end attaches it to its message once the answer has come back. Without that,
   * sending the image would have to be delayed until the end of the agent turn.
   */
  api.post('/attachments/attach', (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean)
    const target = {}
    if (req.body?.taskId !== undefined) target.taskId = req.body.taskId
    if (req.body?.messageId !== undefined) target.messageId = req.body.messageId
    res.json(ids.map(id => attachTo(id, target)).filter(Boolean))
  })

  api.delete('/attachments/:id', (req, res) => res.json(deleteAttachment(req.params.id)))
}

const safeJson = s => { try { return s ? JSON.parse(s) : {} } catch { return {} } }
