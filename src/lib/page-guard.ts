import { notFound } from "next/navigation";
import { hasReport } from "./data";

const KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Throws notFound() for a malformed OR unknown reporting week. Call it BEFORE any Suspense boundary, so the answer is a real
 * HTTP 404 rather than a streamed 200 with a "not found" body. A database error is not treated as "unknown": the page then
 * renders its own error state instead of a false 404.
 */
export async function requireKnownWeek(week: string | undefined): Promise<void> {
  if (week === undefined) return;
  if (!KEY.test(week)) notFound();
  let exists = true;
  try { exists = await hasReport(week); } catch { /* handled by the page's error state */ }
  if (!exists) notFound();
}
