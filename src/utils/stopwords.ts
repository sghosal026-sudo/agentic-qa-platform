export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "been", "before",
  "being", "between", "both", "but", "by", "can", "could", "did", "do", "does", "doing", "each", "for", "from",
  "had", "has", "have", "having", "how", "i", "if", "in", "into", "is", "it", "its", "list", "me", "more", "most",
  "my", "no", "not", "of", "on", "or", "other", "our", "out", "over", "please", "show", "should", "so", "some",
  "such", "tell", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to",
  "under", "up", "us", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "will", "with", "would", "you", "your",
]);

/** Lowercase search terms without stopwords. Keeps snake_case identifiers intact. */
export function searchTerms(text: string): string[] {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
  return Array.from(new Set(terms));
}
