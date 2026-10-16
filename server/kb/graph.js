import { kb } from './index.js'

/*
 * The graph of the base's [[wiki]] links, seen from one note. It is no longer
 * drawn anywhere: it serves the model's kb_related tool, to bounce from one
 * note to its neighbours without going back through search.
 */

/** The neighbours of a note: what it cites, what cites it, and its folder siblings. */
export function neighbors (path, { limit = 10 } = {}) {
  const outgoing = kb.prepare(`
    SELECT n.path, n.title FROM kb_links l JOIN kb_notes n ON n.path = l.target
    WHERE l.src = ? AND l.kind = 'wiki' AND l.target IS NOT NULL AND l.target <> l.src`).all(path)
  const incoming = kb.prepare(`
    SELECT n.path, n.title FROM kb_links l JOIN kb_notes n ON n.path = l.src
    WHERE l.target = ? AND l.kind = 'wiki' AND l.src <> l.target`).all(path)

  // A note may have no link at all and still be very close to its folder
  // neighbours: without this fallback, kb_related would answer nothing on a
  // whole imported base, where almost nobody has written a link by hand yet.
  const siblings = kb.prepare(`
    SELECT path, title FROM kb_notes
    WHERE folder = (SELECT folder FROM kb_notes WHERE path = ?) AND path <> ?
    ORDER BY path LIMIT ?`).all(path, path, limit)

  return { outgoing, incoming, folder: siblings }
}
