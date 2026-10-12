import type { CoverageReading } from "@/lib/insights";
import { Icon } from "./Icons";

/** One concise, always-visible sentence whenever coverage changes how the report should be read. Detail lives in Data notes. */
export default function CoverageAlert({ reading, usedFallback }: { reading: CoverageReading; usedFallback: boolean }) {
  if (reading.level === "none" && !usedFallback) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {reading.level !== "none" && reading.headline && (
        <div className={`alert ${reading.level}`} role="note">
          <Icon name={reading.level === "warn" ? "alert" : "info"} />
          <p><strong>{reading.level === "warn" ? "Read with care. " : "Note. "}</strong>{reading.headline} <a href="#data-notes">See data notes</a></p>
        </div>
      )}
      {usedFallback && (
        <div className="alert info" role="note"><Icon name="info" /><p>The summary below was written from a template because the AI summary was unavailable. The numbers are unaffected.</p></div>
      )}
    </div>
  );
}
