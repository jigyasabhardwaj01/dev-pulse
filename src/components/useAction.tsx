"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type Notice = { kind: "ok" | "error"; text: string; warnings?: string[] } | null;

/**
 * One way every control talks to the server. It never assumes success: the page refreshes from the server only after the server
 * confirmed, and any refusal is shown in words, next to the control, from the server's own message.
 */
export function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  async function run(method: string, url: string, body?: unknown, okText = "Saved."): Promise<boolean> {
    setPending(true); setNotice(null);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; warnings?: string[] };
      if (!res.ok) {
        setNotice({ kind: "error", text: res.status === 401 ? "Your session has ended. Sign in again." : data.error ?? "That did not work. Nothing was changed." });
        return false;
      }
      setNotice({ kind: "ok", text: okText, warnings: data.warnings?.length ? data.warnings : undefined });
      router.refresh();
      return true;
    } catch {
      setNotice({ kind: "error", text: "Could not reach the server. Nothing was changed." });
      return false;
    } finally { setPending(false); }
  }
  return { run, pending, notice };
}

export function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <div role="status" aria-live="polite" className="small" style={{ minHeight: "1.2em" }}>
      {notice && <span className={notice.kind === "error" ? "notice-err" : "notice-ok"}>{notice.text}</span>}
      {notice?.warnings?.map((w) => <span key={w} className="muted" style={{ display: "block" }}>Note: {w}</span>)}
    </div>
  );
}
