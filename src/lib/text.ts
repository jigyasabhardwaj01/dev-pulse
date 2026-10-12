const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&#x2F;": "/", "&nbsp;": " ", "&apos;": "'",
};

export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<pre[\s\S]*?<\/pre>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:#x?[0-9a-f]+|[a-z]+);/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Short, secret-free error text safe to store: no query strings, tokens or auth headers. */
export function sanitizeError(e: unknown, max = 200): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(key|token|api_key|apikey|authorization)=[^\s&"']+/gi, "$1=[redacted]")
    .replace(/https?:\/\/\S+/g, (u) => { try { return new URL(u).host; } catch { return "[url]"; } })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
