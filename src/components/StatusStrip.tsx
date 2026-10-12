import type { StatusLine } from "@/lib/status-plain";

/** Three honest lines: what was collected, whether the AI step worked, and which report this is. Each says "not recorded" when it is. */
export default function StatusStrip({ items }: { items: { k: string; s: StatusLine; when?: string }[] }) {
  return (
    <section className="status-strip" aria-label="How fresh and complete this is">
      {items.map(({ k, s, when }) => (
        <div className="status-item" key={k}>
          <span className="k">{k}</span>
          <strong><span className={`dot ${s.tone}`} aria-hidden="true" />{s.headline}</strong>
          <p>{s.detail}{when ? ` ${when}` : ""}</p>
        </div>
      ))}
    </section>
  );
}
