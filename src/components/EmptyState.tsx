import Link from "next/link";

const ART = String.raw`   .-------.
  / ░ ░ ░ /|
 .-------. |
 |  ...  | '
 |       |/
 '-------'`;

export default function EmptyState({ title, body, action }: { title: string; body: string; action?: { href: string; label: string } }) {
  return (
    <div className="card empty" role="status">
      <pre className="empty-art" aria-hidden="true">{ART}</pre>
      <h2>{title}</h2>
      <p className="muted" style={{ maxWidth: "52ch" }}>{body}</p>
      {action && <Link className="btn" href={action.href}>{action.label}</Link>}
    </div>
  );
}
