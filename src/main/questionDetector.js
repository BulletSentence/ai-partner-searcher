const questionPatterns = [
  /\?\s*$/u,
  /^\s*(como|qual|quais|quando|onde|quem|por que|porque|o que|pode|voc[eê]|seria|tem|existe)\b/iu,
  /\b(como funciona|me explica|me conte|pode explicar|gostaria de saber|tenho uma d[úu]vida)\b/iu
]

/** A lightweight guard that avoids invoking the model for ordinary statements. */
export function isLikelyQuestion(text) {
  const normalized = text?.trim() || ''
  if (normalized.length < 8) return false
  return questionPatterns.some((pattern) => pattern.test(normalized))
}
