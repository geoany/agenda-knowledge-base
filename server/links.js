/**
 * What we know about a link: its title, its description, its image, its favicon.
 *
 * A link card does not show a bare URL but what lies behind it: a bold title, a
 * line of description, the site favicon and its domain. Those four pieces of
 * information are read from the page header, server side, with Node's fetch and
 * nothing else. An HTML parsing library (cheerio and its dependencies) would
 * weigh more than the whole server for four regular expressions that only read
 * the `<head>`.
 *
 * Two rules that decide the behaviour:
 *
 *  - **Silent failure.** A site that does not answer, that refuses our bot or
 *    that takes eight seconds must NEVER prevent the link from being attached:
 *    we then render the domain alone, and the card is shown with that. A link
 *    lost because the site was under maintenance would be an absurd bug.
 *  - **We only read the beginning.** We cut at 256 kB: the `<head>` is in the
 *    first kilobytes, and some pages weigh several megabytes.
 */

const TIMEOUT_MS = Number(process.env.AGENDA_LINK_TIMEOUT || 8000)
const MAX_BYTES = 256 * 1024

// A real browser in the header: without it, a good half of the sites answer 403
// to an anonymous client and we would never get a title or a favicon.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** Is the URL usable, and public? */
export function isValidUrl (raw) {
  let u
  try { u = new URL(String(raw)) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // The server would fetch the URL itself: an internal address would make it
  // scan its own network from the outside. We refuse localhost and private
  // ranges, that is the bare minimum.
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '0.0.0.0') return null
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return null
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null
  return u
}

/** The domain shown under the card, without the www. */
export const domainOf = url => {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

/**
 * Reads the metadata of a page.
 *
 * Always returns a usable object, even when everything failed: `title` falls
 * back to the domain, and `favicon` to the `/favicon.ico` convention, which
 * works on the vast majority of sites even when the page does not declare it.
 */
export async function fetchLinkPreview (raw) {
  const u = isValidUrl(raw)
  const url = u ? u.toString() : String(raw || '')
  const domain = u ? u.hostname.replace(/^www\./, '') : ''
  const fallback = {
    url,
    domain,
    title: domain,
    description: '',
    image: '',
    favicon: u ? `${u.origin}/favicon.ico` : '',
    mime: ''
  }
  if (!u) return fallback

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en,fr;q=0.8' }
    })
    if (!res.ok) return fallback

    // The final URL is the one that counts: a link shortener has neither the
    // domain nor the favicon of the page it opens.
    const finalUrl = new URL(res.url || url)
    fallback.url = finalUrl.toString()
    fallback.domain = finalUrl.hostname.replace(/^www\./, '')
    fallback.title = fallback.domain
    fallback.favicon = `${finalUrl.origin}/favicon.ico`

    const type = String(res.headers.get('content-type') || '').split(';')[0].trim()
    fallback.mime = type
    // A direct link to a PDF or an image has no <head> to read: the file name
    // in the URL is the best label available.
    if (type && !type.includes('html')) {
      const name = decodeURIComponent(finalUrl.pathname.split('/').filter(Boolean).pop() || '')
      if (name) fallback.title = name
      return fallback
    }

    const html = await readHead(res)
    const m = meta(html)

    return {
      url: fallback.url,
      domain: fallback.domain,
      title: (m.ogTitle || m.title || fallback.domain).slice(0, 200),
      description: (m.ogDesc || m.desc || '').slice(0, 400),
      image: absolute(m.ogImage, finalUrl),
      favicon: absolute(m.icon, finalUrl) || fallback.favicon,
      mime: type
    }
  } catch {
    // Timeout, dead DNS, invalid certificate: we keep the domain and move on.
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

/** The first kilobytes of the body, decoded to text. */
async function readHead (res) {
  const reader = res.body?.getReader?.()
  if (!reader) return (await res.text()).slice(0, MAX_BYTES)
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let out = ''
  let read = 0
  while (read < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    read += value.length
    out += decoder.decode(value, { stream: true })
    // The <head> is over: whatever follows will teach us nothing more.
    if (/<\/head>/i.test(out)) break
  }
  try { reader.cancel() } catch { /* the stream closes on its own */ }
  return out
}

/**
 * The four pieces of information of the `<head>`, read with a regular expression.
 *
 * The order of the attributes varies from one site to another (`content` before
 * `property` as often as the opposite), hence the two passes over each tag
 * rather than a single pattern that would miss half the web.
 */
function meta (html) {
  const head = html.split(/<\/head>/i)[0] || html
  const attr = (tag, name) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`, 'i')
    const found = tag.match(re)?.[0]
    if (!found) return ''
    return decodeEntities(found.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] || '')
  }
  /*
   * Not every tag containing "icon" is a favicon: `fluid-icon` is a 512-pixel
   * image for an old Mac browser, and `mask-icon` is a monochrome stencil that
   * renders black on black. Taking them gave a GitHub card with a giant logo
   * instead of the favicon. Some pages also declare `href="data:,"`, that is,
   * nothing at all.
   */
  const icon = () => {
    let backup = ''
    for (const tag of head.match(/<link[^>]+>/gi) || []) {
      const rel = tag.match(/rel\s*=\s*["']([^"']*)["']/i)?.[1]?.toLowerCase() || ''
      if (!rel.includes('icon') || rel.includes('fluid') || rel.includes('mask')) continue
      const href = decodeEntities(tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] || '')
      if (!href || /^data:/i.test(href)) continue
      if (rel === 'icon' || rel === 'shortcut icon') return href
      backup ||= href
    }
    return backup
  }
  return {
    title: decodeEntities((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()),
    ogTitle: attr(head, 'og:title') || attr(head, 'twitter:title'),
    desc: attr(head, 'description'),
    ogDesc: attr(head, 'og:description') || attr(head, 'twitter:description'),
    ogImage: attr(head, 'og:image') || attr(head, 'twitter:image'),
    icon: icon()
  }
}

/** A relative address in the HTML must become absolute before being displayed. */
function absolute (href, base) {
  if (!href) return ''
  try { return new URL(href, base).toString() } catch { return '' }
}

/**
 * The most frequent HTML entities in a title.
 *
 * We do not decode the whole set: these six cover what breaks a title on screen
 * (`&amp;`, `&#039;`, `&nbsp;`), the rest is folklore.
 */
function decodeEntities (s) {
  return String(s || '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
      const table = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
      const low = code.toLowerCase()
      if (table[low]) return table[low]
      if (low.startsWith('#x')) return String.fromCodePoint(parseInt(low.slice(2), 16))
      if (low.startsWith('#')) return String.fromCodePoint(Number(low.slice(1)))
      return whole
    })
    .trim()
}
