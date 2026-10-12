/**
 * Postgres jsonb (and text) cannot store the NUL character: one stray U+0000 anywhere in a value makes the whole write fail with
 * "unsupported Unicode escape sequence". Posts come from the open internet, so every JSON document is cleaned before it is stored.
 */
export function stripNul<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined || !text.includes("\\u0000")) return value;
  return JSON.parse(text.replace(/\\u0000/g, "")) as T;
}
