import { sanitizeError } from "./text";

/*
 * Structured run diagnostics. Each one has a STABLE code, a severity, the pipeline stage it belongs to, a short safe message written
 * by us (never a raw exception), a time, and where useful a remedy and a few numeric details. They are stored in the existing
 * pipeline_runs.warnings jsonb column (no schema change), and older runs that stored plain strings are still read.
 */
export type Severity = "info" | "warning" | "error";
export type DiagStage = "collect" | "classify" | "summary" | "persist" | "email" | "run";

export interface Diagnostic {
  code: string;
  severity: Severity;
  stage: DiagStage;
  message: string;
  /** ISO time the condition was observed. */
  at: string;
  source?: string;
  remedy?: string;
  detail?: Record<string, string | number | boolean | null>;
}

/** Remedies are looked up by code so every instance of a problem gives the same next step. */
export const REMEDY: Record<string, string> = {
  SOURCE_FAILED: "See the source's technical details. If it repeats on the next run, check the provider's status.",
  SOURCE_PARTIAL: "Counts for this source may be understated. A later run usually succeeds; check the provider's rate limits if it repeats.",
  SOURCE_RATE_LIMITED: "Wait for the provider's limit to reset. For Reddit, OAuth credentials (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET) raise the limit.",
  SOURCE_AUTH: "Check the source's API credentials in the deployment's environment variables.",
  SOURCE_CAPPED: "Only the newest results are retrieved, by design. No action needed unless complete counts matter.",
  CLASSIFY_NO_MODEL: "Set GEMINI_API_KEY and GEMINI_MODEL in the deployment environment.",
  CLASSIFY_ABORTED: "Posts stay unclassified and are retried on the next run. Check Gemini quota and the function logs.",
  CLASSIFY_PENDING: "These posts are retried automatically on the next run.",
  SUMMARY_FALLBACK: "Check that the Gemini key and quota are healthy; the numbers are unaffected.",
  EMAIL_UNCONFIRMED: "Check the inbox, then follow the unconfirmed-delivery steps in BACKEND.md. It is never resent automatically.",
  EMAIL_STATE_CHECK_FAILED: "Nothing was sent. The next run retries once the database answers.",
  EMAIL_FAILED: "The next scheduled run retries it.",
  EMAIL_MARK_SENT_FAILED: "The message was accepted. Verify the report's email status in the database.",
  CLASSIFY_WARNING: "Check the function logs for the batch-level details; affected posts are retried next run.",
  EMAIL_OUTCOME_UNKNOWN: "Check the inbox before resending. The claim stays in place and the week is reported as unconfirmed.",
  EMAIL_BRIEF_MISSING: "The report row is missing; check the database and rerun the period.",
  RUN_FAILED: "Check the function logs in Vercel for the cause.",
  RUN_BUDGET: "The run stopped starting new work to finish in time; the rest is retried next run.",
  MONITORING_FAILED: "Run history for this run may be incomplete; the pipeline itself was not affected.",
};

const SEVERITIES: Severity[] = ["info", "warning", "error"];
const STAGES: DiagStage[] = ["collect", "classify", "summary", "persist", "email", "run"];

/** Reads what a run stored. Strings are legacy plain warnings (counted, never displayed); objects must be well-formed or they are legacy too. */
export function parseDiagnostics(raw: unknown): { items: Diagnostic[]; legacyCount: number } {
  if (!Array.isArray(raw)) return { items: [], legacyCount: 0 };
  const items: Diagnostic[] = [];
  let legacyCount = 0;
  for (const e of raw) {
    const d = e as Partial<Diagnostic> | null;
    if (d && typeof d === "object" && typeof d.code === "string" && typeof d.message === "string" && SEVERITIES.includes(d.severity as Severity) && STAGES.includes(d.stage as DiagStage) && typeof d.at === "string") {
      const detail: Diagnostic["detail"] = {};
      for (const [k, v] of Object.entries(d.detail ?? {}).slice(0, 8)) {
        if (typeof v === "number" || typeof v === "boolean" || v === null) detail[k.slice(0, 40)] = v;
        else if (typeof v === "string") detail[k.slice(0, 40)] = v.slice(0, 80);
      }
      items.push({
        code: d.code.slice(0, 40).replace(/[^A-Z0-9_]/gi, "_"), severity: d.severity as Severity, stage: d.stage as DiagStage,
        message: sanitizeError(d.message, 240), at: d.at, ...(typeof d.source === "string" ? { source: d.source.slice(0, 20) } : {}),
        ...(typeof d.remedy === "string" ? { remedy: sanitizeError(d.remedy, 240) } : {}), ...(Object.keys(detail).length ? { detail } : {}),
      });
    } else legacyCount++;
  }
  return { items, legacyCount };
}

/**
 * The public page may show only fixed phrases, never raw error text (hosts, constraint or table names). Raw errors are reduced
 * to one of a few categories here.
 */
export function coarseReason(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (/\b429\b|rate.?limit|too many requests/.test(t)) return "Rate limited by the source";
  if (/time(d)? ?out|abort|deadline/.test(t)) return "Timed out";
  if (/\b40[13]\b|forbidden|unauthori[sz]ed|blocked/.test(t)) return "Access refused by the source";
  if (/\b5\d\d\b|unavailable|bad gateway/.test(t)) return "Source service error";
  if (/fetch failed|network|enotfound|econn|dns/.test(t)) return "Network problem";
  return "Source did not return usable data";
}

/** Collects diagnostics and mirrors each into the plain `warnings` list the cron response and logs already use. */
export function makeDiagnostics(now: () => number, warnings: string[]) {
  const items: Diagnostic[] = [];
  /** `legacy`: the plain warning text to mirror into `warnings` (default: the message); `null` mirrors nothing. */
  const add = (d: Omit<Diagnostic, "at" | "remedy"> & { remedy?: string }, legacy?: string | null) => {
    items.push({ ...d, remedy: d.remedy ?? REMEDY[d.code], at: new Date(now()).toISOString() });
    if (legacy !== null) warnings.push(legacy ?? d.message);
  };
  return { items, add };
}
