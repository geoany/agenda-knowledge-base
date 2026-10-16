/**
 * Markdown rendering of an outliner line.
 *
 * A line shows formatted when it is not being edited, and goes back to plain
 * text as soon as you click in it: you see **bold** while typing, and bold once
 * out. This is Dynalist's way, and it avoids a full rich editor that we do not
 * need here.
 *
 * Everything goes through HTML escaping first: the text comes from the database
 * and may contain anything, we never let a hand-written tag through.
 */

export function escapeHtml (s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function renderMarkdown (raw) {
  const src = String(raw ?? '')
  if (!src) return ''

  // A heading is recognised by hashes at the start of the line, as in a markdown
  // file. The hashes themselves disappear from the display.
  const heading = src.match(/^(#{1,3})\s+(.*)$/)
  const body = heading ? heading[2] : src
  const html = inline(escapeHtml(body))
  return heading ? `<span class="mdh mdh${heading[1].length}">${html}</span>` : html
}

/**
 * Markdown rendering of a whole message (the chat), and not of a single line.
 *
 * The agent answers in markdown: lists, bold, sometimes a code block. Displayed
 * raw, we read "**done**" and "- buy bread" with the dashes, which made its
 * answers painful to read. We only support what it really produces: headings,
 * bullet and numbered lists, code blocks, paragraphs. No tables, no nested
 * quotes.
 *
 * The text is escaped before any processing: it comes from a model, hence from
 * a text the user may have dictated, and we never let a tag through.
 */
export function renderBlock (raw) {
  const src = String(raw ?? '').replace(/\r\n/g, '\n')
  if (!src.trim()) return ''

  const out = []
  let list = null           // current 'ul' or 'ol'
  let code = null           // lines of the current code block
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  const openList = type => {
    if (list === type) return
    closeList()
    out.push(`<${type}>`)
    list = type
  }

  for (const rawLine of src.split('\n')) {
    const l = rawLine.trimEnd()

    if (/^\s*```/.test(l)) {
      if (code) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null } else { closeList(); code = [] }
      continue
    }
    if (code) { code.push(escapeHtml(rawLine)); continue }

    if (!l.trim()) { closeList(); continue }

    const heading = l.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      closeList()
      out.push(`<div class="mdh mdh${heading[1].length}">${inline(escapeHtml(heading[2]))}</div>`)
      continue
    }
    const bullet = l.match(/^\s*[-*•]\s+(.*)$/)
    if (bullet) { openList('ul'); out.push(`<li>${inline(escapeHtml(bullet[1]))}</li>`); continue }

    const numbered = l.match(/^\s*\d+[.)]\s+(.*)$/)
    if (numbered) { openList('ol'); out.push(`<li>${inline(escapeHtml(numbered[1]))}</li>`); continue }

    closeList()
    out.push(`<p>${inline(escapeHtml(l))}</p>`)
  }
  closeList()
  if (code) out.push(`<pre><code>${code.join('\n')}</code></pre>`)
  return out.join('')
}

function inline (s) {
  return s
    // Code protects its content: it comes out first so that the asterisks
    // inside a code snippet are not taken for bold.
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => link(u, t))
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_, p, u) => `${p}${link(u, shorten(u))}`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/(^|\s)(#[a-zA-Z0-9\u00e0-\u00ff_-]{2,})/g, '$1<span class="mdtag">$2</span>')
}

const link = (url, text) =>
  `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`

/** A whole URL eats the width of a column: we show the domain. */
function shorten (url) {
  try {
    const u = new URL(url)
    const rest = (u.pathname + u.search).replace(/\/$/, '')
    return u.hostname.replace(/^www\./, '') + (rest.length > 1 ? (rest.length > 18 ? rest.slice(0, 18) + '…' : rest) : '')
  } catch { return url }
}

/** The text as it will be edited: identical to what is in the database. */
export const rawHtml = raw => escapeHtml(raw).replace(/\n/g, '<br>')

/** A task's note at rest: plain text, except its links, which become clickable. */
export const noteHtml = raw => escapeHtml(raw)
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => link(u, t))
  .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_, p, u) => `${p}${link(u, shorten(u))}`)
