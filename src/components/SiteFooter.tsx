import Link from "next/link";
import LiveClock from "./LiveClock";
import AsciiField from "./motion/AsciiField";

/** Footer: what JARVIS reads, when it runs, and a huge wordmark sitting on a live ASCII field. */
export default function SiteFooter() {
  return (
    <footer className="footer">
      <div className="foot-grid">
        <div className="foot-col">
          <span className="eyebrow">What it reads</span>
          <p>JARVIS reads public developer discussions (Hacker News, Stack Overflow and GitHub Issues) and groups them into recurring problems. Counts are a sample of what is public, not every developer.</p>
        </div>
        <div className="foot-col">
          <span className="eyebrow">When it runs</span>
          <p>Every Friday at 06:00 IST, for the seven days before. <LiveClock label="Now" /></p>
        </div>
        <nav className="foot-col" aria-label="Footer">
          <span className="eyebrow">Go to</span>
          <Link href="/">Insights</Link><Link href="/explore">Explore &amp; Decide</Link><Link href="/plan">Weekly Action Plan</Link><Link href="/settings">Settings &amp; Diagnostics</Link>
        </nav>
      </div>
      <div className="foot-mark" aria-hidden="true">
        <AsciiField className="foot-ascii" cell={12} words={["FRIDAY", "06:00", "IST", "SIGNAL"]} />
        <span>JARVIS</span>
      </div>
    </footer>
  );
}
