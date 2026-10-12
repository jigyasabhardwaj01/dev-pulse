import Link from "next/link";

export default function EmptyState({ title, body, action }: { title: string; body: string; action?: { href: string; label: string } }) {
  return (
    <div className="card empty" role="status">
      <h2>{title}</h2>
      <p className="muted" style={{ maxWidth: "52ch" }}>{body}</p>
      {action && <Link className="btn" href={action.href}>{action.label}</Link>}
    </div>
  );
}
