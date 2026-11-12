// Whisper invents text for silence, music and keyboard noise. These are the phrases it produces most
// often in Portuguese and English; none of them is something a person says in a meeting.
const hallucinationPatterns = [
  /^\W*legendas?\s+(pela|da|de|por)\b/iu,
  /sous-titrage|radio-canada/iu,
  /amara\.org/iu,
  /obrigad[oa]\s+por\s+assistir/iu,
  /inscreva-se\s+no\s+canal/iu,
  /thanks?\s+for\s+watching/iu,
  /subtitles?\s+by/iu,
  /^\W*(m[úu]sica|aplausos|risos|sil[êe]ncio|music|applause)\W*$/iu
]
const NO_SPEECH_LIMIT = 0.6
// Mean token probability reported by Whisper. Real speech scores above 0.9; text invented for
// noise scores around 0.3 to 0.45, and so do isolated one-word utterances, which are unreliable.
const MIN_CONFIDENCE = 0.35
const MIN_SHORT_CONFIDENCE = 0.5
const SHORT_UTTERANCE_WORDS = 3
// Speech carries at least a word per second; a long "utterance" with almost no words is noise.
const SPARSE_MIN_DURATION_MS = 4_000
const SPARSE_WORDS_PER_SECOND = 0.5
const ECHO_SIMILARITY = 0.6
const ECHO_WINDOW_MS = 2_500

function words(text = '') {
  return (
    text
      .toLocaleLowerCase('pt-BR')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .match(/[\p{L}\p{N}]+/gu) || []
  )
}

/** Decides whether a finished utterance is real speech worth showing, saving and answering. */
export function isUsableTranscript(
  text = '',
  { noSpeechProbability = 0, confidence = 1, durationMs = 0, prompt = '' } = {}
) {
  const normalized = text.trim()
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) return false
  if (noSpeechProbability > NO_SPEECH_LIMIT) return false
  if (confidence < MIN_CONFIDENCE) return false
  if (confidence < MIN_SHORT_CONFIDENCE && words(normalized).length <= SHORT_UTTERANCE_WORDS)
    return false
  if (
    durationMs >= SPARSE_MIN_DURATION_MS &&
    words(normalized).length / (durationMs / 1000) < SPARSE_WORDS_PER_SECOND
  )
    return false
  if (hallucinationPatterns.some((pattern) => pattern.test(normalized))) return false
  // On noise the decoder sometimes just continues the vocabulary prompt it was given.
  if (/termos usados:|terms used:/iu.test(normalized)) return false
  if (prompt && normalized.length > 20 && prompt.includes(normalized)) return false
  return true
}

/** Share of the words in `candidate` that also appear in `reference` (0 to 1). */
export function wordOverlap(candidate, reference) {
  const candidateWords = words(candidate)
  if (!candidateWords.length) return 0
  const referenceWords = new Set(words(reference))
  return candidateWords.filter((word) => referenceWords.has(word)).length / candidateWords.length
}

/**
 * Without headphones the microphone hears the other participants coming out of the speakers. Such
 * an utterance overlaps theirs in time and repeats its words, so it is their voice, not the owner's.
 */
export function isEchoOfOthers(micUtterance, otherUtterances = []) {
  // The two sides are cut at different pauses, so the echo may span several of their utterances.
  const overlapping = otherUtterances.filter(
    (other) =>
      micUtterance.startMs < other.endMs + ECHO_WINDOW_MS &&
      micUtterance.endMs > other.startMs - ECHO_WINDOW_MS
  )
  if (!overlapping.length) return false
  const otherText = overlapping.map((other) => other.text).join(' ')
  return wordOverlap(micUtterance.text, otherText) >= ECHO_SIMILARITY
}
