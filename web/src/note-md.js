/**
 * Markdown rendering of a KB note, separate from the chat one (markdown.js).
 *
 * A note is not an agent answer: it has paragraphs hard-wrapped over several
 * lines, tables, quotes, nested lists, four-level headings. The chat rendering
 * turned every line into a paragraph and displayed tables as plain text.
 *
 * What serves the model and not the reader is never displayed: the
 * <!-- woven --> block and every HTML comment, the "See also" sections and
 * lines, and the top heading when it repeats the note's title. The file itself
 * is left alone: the model keeps reading all of it.
 *
 * Everything is escaped before being formatted: the text comes from the
 * database, a hand-written tag never gets through.
 */
import { escapeHtml } from './markdown.js'

/** Removes what the reader has no business seeing. */
export function cleanNote (body, title = '') {
  let s = String(body ?? '').replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
  const lines = s.split('\n')
  const out = []
  let skip = 0            // level of the "See also" heading being skipped, 0 otherwise
  let code = false
  for (const l of lines) {
    if (/^\s*```/.test(l)) code = !code
    if (!code) {
      const t = l.match(/^(#{1,6})\s+(.*)$/)
      if (t) {
        if (skip && t[1].length <= skip) skip = 0
        // "voir aussi" is kept for notes woven before the rename to English.
        if (!skip && /^(?:see also|voir aussi)\b/i.test(t[2].trim())) { skip = t[1].length; continue }
      }
      if (skip) continue
      if (/^(?:see also|voir aussi)\b/i.test(l)) continue
    }
    out.push(l)
  }
  s = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  // The top heading that repeats the note's title.
  const head = s.match(/^#\s+(.*)\n?/)
  if (head && simplify(head[1]) === simplify(title)) s = s.slice(head[0].length).trim()
  return s
}

const simplify = t => String(t || '').toLowerCase().replace(/[^a-z0-9\u00e0-\u00ff]+/g, '')

/** The HTML of a note, cleaned then formatted. */
export function renderNote (body, title = '') {
  const lines = cleanNote(body, title).split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const l = lines[i]

    // Code block: rendered as is, escaped.
    if (/^\s*```/.test(l)) {
      const code = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(escapeHtml(lines[i++]))
      i++
      out.push(`<pre><code>${code.join('\n')}</code></pre>`)
      continue
    }

    if (!l.trim()) { i++; continue }

    const heading = l.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const n = Math.min(heading[1].length, 4)
      out.push(`<div class="mdh mdh${n}">${inline(heading[2])}</div>`)
      i++
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue }

    // Table: a header line, then a line of dashes.
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = x => x.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      const head = cells(l)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push('<div class="mdtable"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>')
      continue
    }

    // Quote: consecutive ">" lines form a single block.
    if (/^\s*>/.test(l)) {
      const block = []
      while (i < lines.length && /^\s*>/.test(lines[i])) block.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${renderNote(block.join('\n'))}</blockquote>`)
      continue
    }

    // List: bullets or numbers, nested by indentation.
    if (/^\s*([-*•+]|\d+[.)])\s+/.test(l)) {
      const items = []
      while (i < lines.length) {
        const x = lines[i]
        const m = x.match(/^(\s*)([-*•+]|\d+[.)])\s+(.*)$/)
        if (m) { items.push({ level: Math.floor(m[1].replace(/\t/g, '  ').length / 2), ol: /\d/.test(m[2]), text: m[3] }); i++; continue }
        // An indented line without a bullet continues the previous item.
        if (x.trim() && /^\s{2,}/.test(x) && items.length) { items[items.length - 1].text += ' ' + x.trim(); i++; continue }
        break
      }
      out.push(buildList(items))
      continue
    }

    // Paragraph: consecutive lines join up.
    const para = []
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i], lines[i + 1])) para.push(lines[i++].trim())
    if (!para.length) para.push(lines[i++].trim())
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('')
}

function blockStart (l, next) {
  return /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) ||
    /^\s*([-*•+]|\d+[.)])\s+/.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) ||
    (/^\s*\|/.test(l) && /^\s*\|?\s*:?-{2,}/.test(next || ''))
}

/** A flat sequence of items with their level becomes nested lists. */
function buildList (items) {
  let html = ''
  const stack = []
  for (const it of items) {
    const tag = it.ol ? 'ol' : 'ul'
    while (stack.length > it.level + 1) html += `</li></${stack.pop()}>`
    if (stack.length === it.level + 1) html += '</li>'
    while (stack.length < it.level + 1) { stack.push(tag); html += `<${tag}>` }
    html += `<li>${inline(it.text)}`
  }
  while (stack.length) html += `</li></${stack.pop()}>`
  return html
}

function inline (raw) {
  const codes = []
  let s = escapeHtml(raw)
    // Code protects its content: it comes out first and returns last.
    .replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = s
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) =>
      `<a class="kbwiki" data-note="${target.trim()}">${(alias || target.split('/').pop()).trim()}</a>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[n]}</code>`)
}
