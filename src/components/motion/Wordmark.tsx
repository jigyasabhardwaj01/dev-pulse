/** The JARVIS wordmark, set huge. Each letter rises in on load and stretches when the pointer passes over it (pure CSS). */
export default function Wordmark({ text = "JARVIS", className = "" }: { text?: string; className?: string }) {
  return (
    <div className={`wordmark ${className}`} aria-hidden="true">
      {[...text].map((ch, i) => <span key={i} style={{ ["--i" as string]: i }}>{ch}</span>)}
    </div>
  );
}
