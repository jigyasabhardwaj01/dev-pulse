"use client";

import { NoticeLine, useAction } from "./useAction";

/** Builds the problem analysis for an older saved report from discussions already stored. It never collects, calls the AI, or emails. */
export function DeriveButton({ weekStart }: { weekStart: string }) {
  const { run, pending, notice } = useAction();
  return (
    <span className="stack">
      <button className="btn btn-sm" type="button" disabled={pending} onClick={() => run("POST", "/api/analysis", { weekStart }, "Done. The problems from this report can now be opened in Explore & Decide.")}>{pending ? "Working…" : "Build the problem analysis from stored discussions"}</button>
      <NoticeLine notice={notice} />
    </span>
  );
}
