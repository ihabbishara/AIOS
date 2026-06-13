const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on", "at",
  "by", "be", "as", "are", "was", "with", "that", "this", "from", "but", "not",
  "you", "your", "i", "me", "my", "we", "our", "they", "them", "he", "she", "his",
  "her", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could",
  "should", "if", "so", "no", "yes", "up", "out", "about", "into", "over", "then",
]);

/**
 * Light stem: drop a trailing plural "s" on longer tokens, but never "ss" (address).
 * Deliberately minimal — only plural -s. Linguistic precision matters less than the
 * SAME transform running at index + query time, which it does.
 */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/**
 * Deterministic tokenizer used at BOTH index and query time. Because every token is
 * reduced to [a-z0-9], no user input ever reaches a SQL/MATCH parser — there is no
 * query-injection surface, and garbage input simply yields zero tokens.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && t.length <= 40 && !STOPWORDS.has(t))
    .map(stem);
}
