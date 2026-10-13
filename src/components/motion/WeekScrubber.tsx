"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ProblemTile, { TILE_KINDS } from "./ProblemTile";

export interface ScrubItem { key: string; theme: string; href: string; firstSeen: string; lastSeen: string; discussions: number }

const DAY = 86_400_000;
const DAYS = ["Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu"];
const LOOP_S = 7; // one reporting day per second

/**
 * "The week in seven seconds": a player over the seven reporting days. As the playhead moves, the problems that were being discussed on
 * that day light up. Days come from each problem's first and last stored discussion, nothing else. Pause, scrub or click a tile to open it.
 */
export default function WeekScrubber({ periodStart, periodLabel, items }: { periodStart: string; periodLabel: string; items: ScrubItem[] }) {
  const start = new Date(periodStart).getTime();
  const [t, setT] = useState(0); // seconds into the loop, 0..7
  const [playing, setPlaying] = useState(true);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setPlaying(false); setT(LOOP_S - 0.01); return; }
  }, []);
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => { setT((x) => (x + (now - last) / 1000) % LOOP_S); last = now; raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return;
    setT(Math.max(0, Math.min(LOOP_S - 0.001, ((clientX - r.left) / r.width) * LOOP_S)));
  };
  const day = Math.min(6, Math.floor(t));
  const dayStart = start + day * DAY, dayEnd = dayStart + DAY;
  const live = (i: ScrubItem) => new Date(i.firstSeen).getTime() < dayEnd && new Date(i.lastSeen).getTime() >= dayStart;
  const activeCount = items.filter(live).length;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date(dayStart + 6 * 3_600_000));
  const pct = (t / LOOP_S) * 100;

  return (
    <section className="scrubber" aria-labelledby="scrub-h">
      <div className="scrub-head">
        <button type="button" className="scrub-play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause the week replay" : "Play the week replay"}>
          {playing ? <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="1" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="8.5" y="1" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
            : <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9-5.5z" fill="currentColor" /></svg>}
        </button>
        <span className="scrub-time mono"><b>{String(day + 1).padStart(2, "0")}</b>/07 · {date}</span>
        <span className="scrub-sep" aria-hidden="true" />
        <h2 id="scrub-h" className="scrub-title">The week in seven seconds</h2>
        <span className="scrub-chip mono" aria-live="polite">{activeCount} of {items.length} problems discussed that day</span>
      </div>
      <div
        className="scrub-track"
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={`Day of ${periodLabel}`}
        aria-valuemin={1}
        aria-valuemax={7}
        aria-valuenow={day + 1}
        aria-valuetext={`Day ${day + 1}, ${date}`}
        onPointerDown={(e) => { dragging.current = true; setPlaying(false); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); seek(e.clientX); }}
        onPointerMove={(e) => { if (dragging.current) seek(e.clientX); }}
        onPointerUp={() => { dragging.current = false; }}
        onKeyDown={(e) => { if (e.key === "ArrowRight") { setPlaying(false); setT((x) => Math.min(LOOP_S - 0.01, Math.floor(x) + 1)); } if (e.key === "ArrowLeft") { setPlaying(false); setT((x) => Math.max(0, Math.floor(x) - 1)); } if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); } }}
      >
        {DAYS.map((d, i) => (
          <span key={d} className={`scrub-day${i === day ? " now" : ""}`} style={{ left: `${(i / 7) * 100}%` }}><span className="mono">{d}</span></span>
        ))}
        {Array.from({ length: 28 }, (_, i) => <i key={i} className="tick" style={{ left: `${(i / 28) * 100}%` }} />)}
        <span className="scrub-range" style={{ width: `${pct}%` }} />
        <span className="scrub-head-line" style={{ left: `${pct}%` }} />
      </div>
      <ol className="scrub-tiles">
        {items.map((it, i) => {
          const on = live(it);
          return (
            <li key={it.key}>
              <Link href={it.href} className={`scrub-tile${on ? " on" : ""}`} aria-label={`${it.theme}: ${it.discussions} discussions. Open to read the evidence.`}>
                <ProblemTile label={it.theme} kind={TILE_KINDS[i % TILE_KINDS.length]} index={i} active={on} />
                <span className="scrub-cap"><span className="mono">{String(i + 1).padStart(2, "0")}</span>{it.theme}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
