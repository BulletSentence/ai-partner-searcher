const openingPatterns = [
  /^\s*(e\s+|mas\s+|ent[ãa]o\s+|agora\s+)?(como|qual|quais|quando|quanto|quantos|quantas|onde|quem|por que|porque|o que|pode|voc[eê]s?|seria|tem|existe|ser[áa] que|d[áa] pra|[ée] poss[íi]vel|consegue[m]?)\b/iu,
  /\b(como funciona|me explica|me conte|pode explicar|gostaria de saber|queria (saber|entender)|preciso (saber|entender)|sabe me dizer|tenho uma d[úu]vida|outra d[úu]vida|uma pergunta)\b/iu
]
// Questions people ask out of politeness or to check the call, which must not trigger an answer.
const smallTalk =
  /^(e\s+)?(oi|ol[áa]|bom dia|boa tarde|boa noite|tudo (bem|bom|certo|joia)|beleza|certo|ok|n[ãa]o [ée]|n[ée]|t[áa]( bom)?|entendeu|entende|sabe|pode ser|combinado|fechado|(voc[eê]s? )?(est[áaã]o?|t[áa]|t[ãa]o) me (ouvindo|escutando|vendo)|(d[áa] pra|conseguem?) me (ouvir|escutar|ver)|(d[áa] pra|conseguem?) ver (a |minha )?tela|al[ôo])[\s,!.?]*$/iu
const MIN_LENGTH = 8
const MIN_QUESTION_WORDS = 3

function isRealQuestionSentence(sentence) {
  const text = sentence.replace(/^[\s,;:.!-]+/, '').trim()
  const body = text.replace(/\?+$/, '').trim()
  if (smallTalk.test(body)) return false
  // "Bom dia, tudo bem?" is still small talk when every comma-separated part is.
  const parts = body.split(/\s*,\s*/)
  if (parts.every((part) => smallTalk.test(part))) return false
  // "Fechamos o lote ontem, né?" asks for agreement, not for information.
  if (parts.length > 1 && smallTalk.test(parts.at(-1))) return false
  return body.split(/\s+/).length >= MIN_QUESTION_WORDS
}

/** A lightweight guard that avoids invoking the model for ordinary statements and small talk. */
export function isLikelyQuestion(text) {
  const normalized = text?.trim() || ''
  if (normalized.length < MIN_LENGTH) return false

  // Whisper punctuates, so a question mark is the strongest signal when present.
  const questionSentences = normalized.match(/[^.!?]*\?/gu)
  if (questionSentences) return questionSentences.some(isRealQuestionSentence)

  return openingPatterns.some((pattern) => pattern.test(normalized)) && !smallTalk.test(normalized)
}
