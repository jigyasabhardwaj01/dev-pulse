const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive, whole-word match; spaces in a keyword also match "-" or "_". */
function keywordRegex(keyword: string): RegExp {
  const body = escape(keyword.trim().toLowerCase()).replace(/\s+/g, "[\\s\\-_]+");
  return new RegExp(`(^|[^a-z0-9])${body}($|[^a-z0-9])`, "i");
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
