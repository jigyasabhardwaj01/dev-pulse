"use client";

import { NoticeLine, useAction } from "./useAction";

export default function PackBuild({ hasPack }: { hasPack: boolean }) {
  const { run, pending, notice } = useAction();
  return (
    <div className="stack-sm">
      <button className="btn primary" type="button" disabled={pending} onClick={() => run("POST", "/api/pack", undefined, "Pack built from the saved report and current decisions.")}>{pending ? "Building…" : hasPack ? "Refresh pack" : "Build pack"}</button>
      <NoticeLine notice={notice} />
    </div>
  );
}
