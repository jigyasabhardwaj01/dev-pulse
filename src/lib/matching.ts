const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive, whole-word match; spaces in a keyword also match "-" or "_". `tolerant` also accepts a plural ("-s" / "-es") on the last word. */
export function keywordRegex(keyword: string, tolerant = false): RegExp {
  const body = escape(keyword.trim().toLowerCase()).replace(/\s+/g, "[\\s\\-_]+");
  return new RegExp(`(^|[^a-z0-9])${body}${tolerant ? "(?:e?s)?" : ""}($|[^a-z0-9])`, "i");
}

/** Every keyword that appears in `text` (not just the first). */
export function matchAll(text: string, keywords: string[], tolerant = false): string[] {
  return keywords.filter((kw) => kw.trim() && keywordRegex(kw, tolerant).test(text));
}

/** Returns the first keyword found in `text`, or null. */
export function matchKeyword(text: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    if (!kw.trim()) continue;
    if (keywordRegex(kw).test(text)) return kw;
  }
  return null;
}

export const matchesKeywords = (text: string, keywords: string[]) =>
  matchKeyword(text, keywords) !== null;
