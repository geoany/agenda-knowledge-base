/**
 * Do two sentences say the same thing?
 *
 * Compares bags of meaningful words, with no model call: it is instant,
 * predictable, and good enough to deduplicate short sentences written by the
 * same agent. Used for rules and for learned facts, otherwise the agent saves
 * the same habit again in every conversation.
 */
export function similar (a, b, threshold = 0.7) {
  const A = bag(a); const B = bag(b)
  if (!A.size || !B.size) return false
  let common = 0
  for (const w of A) if (B.has(w)) common++
  return common / Math.min(A.size, B.size) >= threshold
}

/**
 * The em dash, banned from the project.
 *
 * The user never types it and immediately recognizes it as machine prose.
 * Telling the model is not enough, it still puts one in every third text: so we
 * also clean up afterwards, here, where it is deterministic. The ordinary hyphen
 * is never touched, it lives inside real words.
 */
export function stripEmDash (s) {
  return String(s || '')
    .replace(/\s*[—–]\s*$/gm, '')
    .replace(/\s*[—–]\s*/g, ', ')
}

/**
 * Is this line an action, or a thought disguised as a task?
 *
 * "Think about the redesign", "see if we keep the contractor", "figure out the
 * budget" cannot be checked off: nothing says when they are done. So they
 * travel from day to day forever and clutter every day. We spot them by their
 * wording, without a model: it is instant, predictable, and wording is plenty at
 * the scale of one agenda line.
 *
 * Deliberately narrow. A false positive costs far more than a miss: parking a
 * real action would be theft, letting one more thought through is merely the
 * status quo.
 *
 * English patterns first, French ones kept for French input.
 */
const OPEN_THOUGHTS = [
  /^\s*think\s+(?:about|over|through)\b/i,
  /^\s*(?:see|check)\s+(?:if|whether)\b/i,
  /^\s*figure\s+out\b/i,
  /^\s*(?:decide|consider|ponder|reflect\s+on)\b/i,
  /^\s*wonder\s+(?:if|whether|about)\b/i,
  /^\s*look\s+into\s+(?:whether|if)\b/i,
  /^\s*(?:make\s+up\s+my\s+mind|settle)\s+(?:on|between|about)\b/i,
  /^\s*choose\s+between\b/i,
  /^\s*(?:r[\u00e9e])?fl[\u00e9e]chir/i,
  /^\s*voir\s+(?:si|avec|pour|comment|ce que)\b/i,
  /^\s*se\s+(?:poser|renseigner)\b/i,
  /^\s*(?:se\s+)?d[\u00e9e]cider\b/i,
  /^\s*penser\s+[\u00e0a]\s/i,
  /^\s*savoir\s+si\b/i,
  /^\s*[\u00e9e]tudier\s+(?:la\s+possibilit|l'opportunit|si)\b/i,
  /^\s*(?:me\s+)?questionner\b/i,
  /^\s*trancher\s+(?:sur|entre)\b/i,
  /^\s*choisir\s+entre\b/i
]

export function isOpenThought (content) {
  const t = String(content || '').replace(/^\s*(?:#+|\d+[.)]|[-*])\s*/, '').trim()
  if (t.length < 4) return false
  return OPEN_THOUGHTS.some(re => re.test(t))
}

function bag (s) {
  return new Set(
    String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3)
  )
}
