import { getTask } from '../tasks.js'
import { fetchLinkPreview, domainOf, isValidUrl } from '../links.js'
import { createAttachment, listAttachments, getAttachment, deleteAttachment, humanSize } from '../attachments.js'

/**
 * The attachment tools.
 *
 * Chat / interface parity: everything the user does with a click (attach a link
 * to a task, look at what is pinned, reread what an image tells) must exist as a
 * tool, otherwise the feature only half exists.
 *
 * One thing is deliberately absent: the agent cannot send a binary. A file comes
 * from the browser, never from a model.
 *
 * `read_image` NEVER looks at the image: it rereads the description already
 * written at upload time. Asking the vision model again at every turn would cost
 * several seconds per message for an identical result.
 *
 * This module exports `defs`, `handlers`, `labels` and `writers` in the same
 * shape as `tools.js`, which aggregates them. It does not register itself.
 */

const num = v => (v === '' || v == null ? null : Number(v))

const describe = p => {
  const what = p.kind === 'link'
    ? `link ${p.url}${p.title ? ` ("${p.title}")` : ''}`
    : p.kind === 'image'
      ? `image "${p.name}"${p.width ? ` ${p.width}×${p.height}` : ''}`
      : `file "${p.name}" (${humanSize(p.size)})`
  const where = p.taskId ? ` on task #${p.taskId}` : (p.messageId ? ' in the chat' : '')
  return `#${p.id} ${what}${where}`
}

/* ------------------------------------------------------------------ */
/* Declarations sent to the model                                      */
/* ------------------------------------------------------------------ */
/* Every text that goes to the model is written in careful, idiomatic   */
/* English: it mimics the style of its prompt.                          */

export const defs = [
  ['attach_link', "Pins a web address to a task. The server will read the page to draw its title, description and favicon from it: the user then sees a real clickable card, not a bare URL. Call it as soon as they dictate a link to keep on a task.", {
    taskId: ['number', 'identifier of the task to pin the link to', true],
    url: ['string', 'the full address, with https://', true],
    title: ['string', 'imposed title, only if the user dictates one; otherwise the page title is used']
  }],
  ['list_attachments', "Lists the attachments of a task: images, files and links, with what each one contains. Without an identifier, the latest attachments of the whole agenda.", {
    taskId: ['number', 'identifier of the task, optional'],
    limit: ['number', 'how many at most, 20 by default']
  }],
  ['read_image', "Returns what an image contains: the description written by the vision model at upload time, readable text in the image included. It is the only way for you to know what is on an image, you do not see it yourself.", {
    id: ['number', 'identifier of the attachment, the one given by list_attachments', true]
  }],
  ['detach', "Removes an attachment: the link, the file or the image is no longer pinned to the task.", {
    id: ['number', 'identifier of the attachment', true]
  }]
]

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export const handlers = {
  /**
   * The link is ALWAYS attached, even if the site does not answer.
   *
   * `fetchLinkPreview` never throws: a timeout, a 403 or a dead certificate
   * leave the domain alone, and the card shows with that. Losing a link because
   * the site was under maintenance would be absurd.
   */
  attach_link: async ({ taskId, url, title }) => {
    const id = num(taskId)
    const t = id ? getTask(id) : null
    if (id && !t) return `Task #${taskId} not found`
    if (!isValidUrl(url)) return `NOTHING ATTACHED. "${url}" is not a usable web address: a public address in http or https is needed.`

    const meta = await fetchLinkPreview(url)
    const p = createAttachment({
      taskId: id,
      kind: 'link',
      url: meta.url,
      name: meta.domain,
      title: String(title || '').trim() || meta.title,
      description: meta.description,
      mime: meta.mime || 'text/html',
      meta: { favicon: meta.favicon, image: meta.image, domain: meta.domain }
    })
    const on = t ? ` on "${t.content.replace(/^#+\s*/, '')}"` : ''
    return `Link attached${on}: "${p.title}" (${meta.domain}). ${p.description ? `The page says: ${p.description.slice(0, 200)}` : 'The page gave no description.'}`
  },

  list_attachments: ({ taskId, limit }) => {
    const id = num(taskId)
    const list = listAttachments({ taskId: id, limit: num(limit) || 20 })
    if (!list.length) return id ? `No attachment on task #${id}` : 'No attachment'
    return list.map(p => {
      const what = describe(p)
      // The description fits on one line here: the full detail is asked for with
      // read_image, otherwise a task with three screenshots would drown the turn.
      const says = p.description ? `: ${p.description.replace(/\s+/g, ' ').slice(0, 140)}${p.description.length > 140 ? '…' : ''}` : ''
      return `${what}${says}`
    }).join('\n')
  },

  read_image: ({ id }) => {
    const p = getAttachment(num(id))
    if (!p) return `Attachment #${id} not found`
    if (p.kind === 'link') {
      return `#${p.id} is a link, not an image: ${p.url}${p.title ? `, titled "${p.title}"` : ''}${p.description ? `. The page says: ${p.description}` : ''}`
    }
    if (p.kind !== 'image') {
      return `#${p.id} is a file "${p.name}" (${humanSize(p.size)}), not an image: I cannot read its content. Ask the user what is in it.`
    }
    if (!p.description) {
      return `The image "${p.name}" has no description: the vision model could not read it at upload time. Ask the user what it shows.`
    }
    return `Image "${p.name}"${p.width ? ` (${p.width}×${p.height})` : ''}:\n${p.description}`
  },

  detach: ({ id }) => {
    const p = getAttachment(num(id))
    if (!p) return `Attachment #${id} not found`
    deleteAttachment(p.id)
    return `Removed: ${describe(p)}`
  }
}

/** Readable label shown live in the chat while the tool runs. */
export const labels = {
  attach_link: 'pins a link',
  list_attachments: 'looks at the attachments',
  read_image: 'rereads what the image shows',
  detach: 'removes an attachment'
}

/** The tools that write: the interface refreshes only after those. */
export const writers = ['attach_link', 'detach']
