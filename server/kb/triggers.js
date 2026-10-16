/**
 * The trigger index of the knowledge base.
 *
 * It produces `data/kb/triggers.json`: for each note, the words that belong to
 * it and to it alone.
 *
 * The idea, exactly the one of a skill: some words belong to one note and to it
 * alone. When they show up in a sentence, we recall that the note exists. The
 * hook therefore makes NO model call and no search: it compares words, it
 * answers in a few milliseconds, and it cannot slow a conversation down.
 *
 * All the work is here, and it comes down to one rule: **a trigger must be
 * discriminating**. "offer", "client", "price" appear in half the notes of a
 * base about business: keeping them would make five notes ring at every
 * sentence, and a reminder that always rings is no longer read. So we keep only
 * what is rare in the corpus.
 *
 * **This file must stay right without anyone looking after it.** The base will
 * grow note after note, and the user must not have to come and say "careful,
 * that one will make noise". Two mechanisms carry that promise, and neither is
 * a word list to maintain:
 *
 *   - the ANTI-CORPUS (`data/kb/anti-triggers.txt`): sentences the user really
 *     writes and that require no business knowledge. Any word appearing there is
 *     disqualified, whatever its rarity in the base. A sentence added there
 *     brings all of its vocabulary at once, where a blacklist goes stale as soon
 *     as the topic changes;
 *   - the SELF-MEASURE: at each generation, the index is replayed against that
 *     same anti-corpus. If noise remains, the faulty words are removed and we
 *     start over, until no neutral sentence wakes a note. The report goes into
 *     the function's return value, so a drift is seen instead of settling in.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { listNotes, readNote, KB_ROOT, isGenerated } from './store.js'

/* Function words, plus the generic vocabulary of the domain: the latter would
   pass the rarity filter in a small enough base, while they name no note in
   particular. The French entries are kept: the base still accepts French
   notes and sentences, and they cost nothing here. */
const BANNED = new Set(`alors aussi autre autres avec avoir bien cela celle celles ceux chaque chose comme
comment dans deja depuis donc dont elle elles encore entre etre faire fait faut ils jamais leur leurs
mais meme mieux moins nous parce pas peut peuvent plus pour pourquoi quand que quel quelle quelque
qui sans ses seul seulement soit sont sous sur tous tout toute toutes tres trop vers votre vous
etait etaient sera seront ete avait avaient aura auront cette ceci cet ainsi afin apres avant
the and for you your with that this from have will not are was but they what when who how
business marche client clients argent temps travail entreprise projet produit vendre vente
faire monde gens personne chose exemple partie point niveau place moment facon maniere
note notes savoir plus moins grand petit bon mauvais vrai faux
ligne lignes jour jours mois heure heures semaine annee annees fois cas type sorte forme
etat sens ordre suite tour coup main tete idee idees nom noms numero version debut fin
fichier fichiers dossier dossiers code page pages texte mot mots service serveur base
donnee donnees test tests erreur erreurs bug bugs`.split(/\s+/).filter(Boolean))
/* The second block of banned words is not business vocabulary: they are the
   everyday words of work ("line", "file", "service", "test"). They are dropped
   because they create a whole class of false positives: "show me the last 20
   lines of the logs" woke a note about "lines of business". No knowledge note is
   recognised by those words, so banning them costs no true recall. */

const normalize = s => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')

/**
 * The root of a word, minimal version.
 *
 * Without it, "negotiate" in a sentence does not recognise a note whose concept
 * is "negotiation", which is the most common case: you write a verb while
 * talking about what you do, the note names the thing. So we strip the most
 * frequent endings, from the longest to the shortest, and we stop as soon as
 * fewer than four letters would remain, otherwise short and unrelated words
 * would end up sharing a root.
 *
 * A reader of the index must cut words with THIS function, otherwise it would
 * no longer speak the same language as the index.
 */
const SUFFIXES = ['ations', 'ation', 'ateurs', 'ateur', 'trices', 'trice', 'ements', 'ement',
  'ances', 'ance', 'ences', 'ence', 'ismes', 'isme', 'istes', 'iste', 'ables', 'able',
  'ibles', 'ible', 'euses', 'euse', 'eurs', 'eur', 'ions', 'ion', 'ies', 'ie', 'ent',
  'er', 'ir', 'ez', 'es', 's']
function stem (word) {
  for (const suf of SUFFIXES) {
    if (word.length - suf.length >= 4 && word.endsWith(suf)) return word.slice(0, -suf.length)
  }
  return word
}

const wordsOf = text => normalize(text)
  .replace(/[^a-z0-9]+/g, ' ')
  .split(' ')
  .filter(m => m.length >= 3 && m.length <= 24 && !BANNED.has(m) && !/^\d+$/.test(m))
  .map(stem)


/**
 * The sentences of the anti-corpus, exactly as they are written on disk.
 *
 * File missing or unreadable: we return an empty list and the generation still
 * happens, simply without a safety net. An index without an anti-corpus is
 * better than no index at all, and the function's return value says how many
 * words it used, so the absence is visible.
 */
function antiCorpusPhrases () {
  const f = resolve(KB_ROOT, 'anti-triggers.txt')
  if (!existsSync(f)) return []
  try {
    return readFileSync(f, 'utf8').split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  } catch { return [] }
}

/**
 * The sentences under watch, with the note each one must wake.
 * Format of a line: "the sentence => piece of the expected path".
 */
function expected () {
  const f = resolve(KB_ROOT, 'expected-triggers.txt')
  if (!existsSync(f)) return []
  try {
    return readFileSync(f, 'utf8').split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && l.includes('=>'))
      .map(l => {
        const [phrase, target] = l.split('=>')
        return { phrase: phrase.trim(), target: target.trim() }
      })
  } catch { return [] }
}

/** All the vocabulary of the anti-corpus, reduced to the same roots as the index. */
function antiCorpusWords () {
  const out = new Set()
  for (const phrase of antiCorpusPhrases()) for (const m of wordsOf(phrase)) out.add(m)
  return out
}

export function generateTriggers () {
  const notes = listNotes()
    .map(f => readNote(f.path))
    .filter(n => n && !isGenerated(n.path))

  /* How many notes use each word: that count is what decides whether a word
     names a note or describes the whole corpus. */
  const df = new Map()
  const bags = notes.map(n => {
    const tf = new Map()
    for (const m of wordsOf(n.body)) tf.set(m, (tf.get(m) || 0) + 1)
    for (const m of tf.keys()) df.set(m, (df.get(m) || 0) + 1)
    return tf
  })

  const N = notes.length
  const CAP = Math.max(2, Math.ceil(N * 0.12))

  /*
   * Who a word BELONGS to.
   *
   * The rarity filter alone is not enough, and the case that shows it is
   * telling: "negotiation" appears in about ten notes of the base (everyone
   * negotiates something), so it is dropped as banal. Except that one note is
   * ENTIRELY about negotiation and uses it twenty times while the others cite it
   * once in passing. That word belongs to it, and a sentence containing it must
   * recall that note.
   *
   * A word belongs to a note when the note uses it at least three times AND
   * clearly DOMINATES it: either it carries 40% of its occurrences in the corpus
   * on its own, or it uses it twice as much as the next note. Both paths count,
   * and the second is the one that holds as the base grows: a word cited in
   * passing by a dozen notes sees its owner's share fall below 40% while it
   * remains unquestionably the owner's. Measured on this corpus: "negotiation"
   * lives in thirteen notes, the one that deals with the topic carries only 32%
   * of it, but twice as much as the second.
   *
   * The floor of three occurrences rules out chance, dominance rules out words
   * that two or three notes share equally and that then name nobody.
   */
  const total = new Map()
  for (const tf of bags) for (const [m, f] of tf) total.set(m, (total.get(m) || 0) + f)
  /* The two best carriers of each word: we need to know the second one to judge
     whether the first really dominates. */
  const podium = new Map()
  for (let i = 0; i < notes.length; i++) {
    for (const [m, f] of bags[i]) {
      const p = podium.get(m) || { first: null, second: 0 }
      if (!p.first || f > p.first.f) {
        p.second = p.first ? p.first.f : p.second
        p.first = { i, f }
      } else if (f > p.second) p.second = f
      podium.set(m, p)
    }
  }
  const owner = new Map()
  for (const [m, p] of podium) {
    if (!p.first || p.first.f < 3) continue
    const share = p.first.f / total.get(m)
    const dominance = p.first.f / (p.second || 1)
    if (share >= 0.4 || dominance >= 2) owner.set(m, p.first)
  }
  const belongsTo = (word, i) => owner.get(word)?.i === i

  const index = notes.map((n, i) => {
    const tf = bags[i]
    /* The body gives the ORDINARY words: rare in the corpus, repeated inside the
       note. Two of them in a sentence are enough to recall it. */
    const ordinary = [...tf.entries()]
      .filter(([m, f]) => f >= 3 && (df.get(m) || 0) <= CAP)
      .sort((a, b) => (b[1] / (df.get(b[0]) || 1)) - (a[1] / (df.get(a[0]) || 1)))
      .slice(0, 14)
      .map(([m]) => m)

    /* The STRONG words name the note: a single one is enough to recall it. Three
       sources, and the third is the most important.
       The title and the tags, first. But a title is often an image ("Never put
       all your eggs in one basket") that contains none of the words one uses
       while talking about the topic: nobody writes "eggs" while preparing a
       negotiation. The
       thesis and the "when to use it", on the other hand, were written to name
       the topic plainly, so they are the ones that carry the real concepts.
       A word from the title that is present everywhere else is not a trigger: it
       names the corpus, not the note. */
    /* The words of the title are held to the SAME requirement as the concepts:
       live in the body at least twice. A title is often a whole sentence
       ("Why you can no longer duplicate what you see on the Internet") half of
       whose words are common verbs; without this condition, "see" became a
       trigger and any sentence containing it woke the note. The TAGS, however,
       escape the rule: the user writes them on purpose to name the note, they
       are the manual lever of the system. */
    const fromTitle = [...new Set(wordsOf(n.title))].filter(m => (tf.get(m) || 0) >= 2)
    const fromTags = [...new Set(n.tags.flatMap(t => wordsOf(t)))]
    /* Acronyms written in capitals in the note (SaaS, CRM, VAT, GDPR) are
       first-rate triggers even though they are two or three letters long: we
       pick them up on the ORIGINAL text, before normalisation, and they escape
       the length floor. Without them, "I am working on my CRM" woke nothing. */
    const acronyms = new Set(
      `${n.title}\n${n.body}`.split('\n')
        // A line written IN CAPITALS is a shouted title, not a sentence that
        // contains an acronym: looking for acronyms there yields "NE", "NOT",
        // "THIS", which then become triggers and wake the note at every message.
        // So we only look in mixed-case text.
        .filter(l => {
          const letters = l.replace(/[^A-Za-z]/g, '')
          return letters.length >= 8 && (l.replace(/[^A-Z]/g, '').length / letters.length) < 0.6
        })
        .flatMap(l => [...l.matchAll(/\b[A-Z]{3,5}\b/g)].map(m => normalize(m[0])))
        // A word written in capitals for emphasis ("IN", "ONLY", "ALL") is not an
        // acronym. Without this filter it short-circuited everything else,
        // because an acronym escapes the length floor and the rarity filter: two
        // empty words were enough to make a note noisy.
        .filter(m => !BANNED.has(m)))
    const namesTheNote = [...new Set([...fromTitle, ...fromTags, ...acronyms])]
    /* The concepts of the thesis and of the "when to use it" are kept only if
       they ALSO LIVE IN THE BODY, at least twice. Without this condition, the
       linking verbs the model uses while writing those sentences ("startup",
       "opens", "using") become triggers, and a request to restart a service
       wakes a business note. A real concept, on the other hand, is used in the
       note that deals with it. */
    const concepts = [...new Set([...wordsOf(n.thesis), ...wordsOf(n.use_for)])]
      .filter(m => (tf.get(m) || 0) >= 2)

    /* The TAGS escape the rarity filter, and that is deliberate: a tag is a
       declaration of intent, not a statistic. "brand" appears in about ten
       notes, but the one that carries it as a tag is the one dealing with the
       topic, and that is the one we want to recall. They remain subject to the
       anti-corpus, which would remove them if they made noise: that is the only
       safety net that matters here. */
    const strong = [...new Set([...namesTheNote, ...concepts])]
      // Three letters, that is "him", "see", "case": guaranteed noise. Only the
      // acronyms picked up in capitals in the note escape it, because a short
      // acronym IS the name of the topic.
      .filter(m => (m.length >= 4 || acronyms.has(m)) &&
                   (fromTags.includes(m) || acronyms.has(m) ||
                    (df.get(m) || 0) <= CAP || belongsTo(m, i)))

    return {
      path: n.path,
      title: n.title,
      thesis: n.thesis || '',
      use_for: n.use_for || '',
      strong,
      words: ordinary.filter(m => m.length >= 4 && !strong.includes(m))
    }
  }).filter(e => e.strong.length || e.words.length >= 2)

  /* ---------------------------------------------------------------- */
  /* The self-measure: the index corrects itself before being written  */
  /* ---------------------------------------------------------------- */

  /*
   * We replay the anti-corpus against the index we have just built, with
   * EXACTLY the rule of the hook (one strong word is enough, two ordinary words
   * are enough). Every neutral sentence that wakes a note points at the faulty
   * words: we remove them and start over.
   *
   * The loop necessarily converges, each round only removing words. The round
   * ceiling is only a programming safety net.
   */
  /*
   * The simulation must extract the words of the text EXACTLY like the hook, and
   * not like the generator. The generator drops short words and its banned
   * vocabulary; the hook, for its part, takes everything three letters long and
   * compares. Simulating with the generator's rules amounted to measuring with
   * an instrument more lenient than reality: the measure said "no noise" while
   * the real hook made some on seven sentences.
   */
  const likeTheHook = text => new Set(
    normalize(text).replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(m => m.length >= 3)
      .map(stem))

  const antiWords = antiCorpusWords()
  const report = { removed: [], rounds: 0 }

  // First pass, the widest one: every word present in the anti-corpus is
  // dropped, without even looking at whether it triggers. That is the vocabulary
  // filter.
  if (antiWords.size) {
    for (const e of index) {
      for (const key of ['strong', 'words']) {
        const before = e[key].length
        e[key] = e[key].filter(m => !antiWords.has(m))
        if (e[key].length !== before) report.removed.push(...[])
      }
    }
  }

  // Second pass: what STILL triggers on a neutral sentence. A word can pass the
  // previous filter and make noise anyway by combination.
  for (let round = 0; round < 6; round++) {
    report.rounds = round + 1
    const faulty = new Set()
    for (const phrase of antiCorpusPhrases()) {
      const present = likeTheHook(phrase)
      for (const e of index) {
        const f = e.strong.filter(m => present.has(m))
        const o = e.words.filter(m => present.has(m))
        if (f.length >= 1 || o.length >= 2) for (const m of [...f, ...o]) faulty.add(m)
      }
    }
    if (!faulty.size) break
    for (const e of index) {
      e.strong = e.strong.filter(m => !faulty.has(m))
      e.words = e.words.filter(m => !faulty.has(m))
    }
    report.removed.push(...faulty)
  }

  const kept = index.filter(e => e.strong.length || e.words.length >= 2)

  /*
   * The measure of RECALL, symmetric to the one of noise.
   *
   * The cleanup above only knows how to remove triggers: at the limit, an empty
   * index makes no noise at all. So we replay the sentences placed under watch
   * and count those that still find their note. This measure corrects nothing on
   * its own, it ALERTS: it is up to a human to decide whether the note changed
   * topic or the index became too strict.
   */
  const missed = []
  for (const a of expected()) {
    const present = likeTheHook(a.phrase)
    const hit = kept.filter(e =>
      e.strong.some(m => present.has(m)) ||
      e.words.filter(m => present.has(m)).length >= 2)
    if (!hit.some(e => e.path.includes(a.target))) missed.push(a)
  }

  const output = resolve(KB_ROOT, 'triggers.json')
  writeFileSync(output, JSON.stringify({ root: KB_ROOT, notes: kept }, null, 1), 'utf8')
  return {
    file: output,
    notes: kept.length,
    total: N,
    cap: CAP,
    antiCorpus: antiWords.size,
    removed: [...new Set(report.removed)],
    rounds: report.rounds,
    watched: expected().length,
    missed
  }
}
