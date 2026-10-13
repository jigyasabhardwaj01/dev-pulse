"use client";

import { useCallback, useRef } from "react";
import { cssVar, useCanvasLoop } from "./useCanvasLoop";

const RAMP = " .·:-=+*#%@";

/**
 * A field of ASCII characters whose density rolls like a signal: a picture of thousands of small conversations becoming a pattern.
 * The pointer pushes a ripple through it. Decorative only (hidden from assistive tech).
 */
export default function AsciiField({ className = "", cell = 14, words = ["SIGNAL", "PAIN", "BUG", "CI", "PR", "DX"] }: { className?: string; cell?: number; words?: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number, t: number, p: { x: number; y: number; active: boolean }) => {
    ctx.clearRect(0, 0, w, h);
    const ink = cssVar("--text", "#111");
    const accent = cssVar("--accent", "#ff4d1f");
    ctx.font = `${cell - 3}px ${cssVar("--font-mono", "ui-monospace, monospace")}`;
    ctx.textBaseline = "top";
    const cols = Math.ceil(w / (cell * 0.62)), rows = Math.ceil(h / cell);
    const cw = cell * 0.62;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const px = x * cw, py = y * cell;
        let v = Math.sin(x * 0.11 + t * 0.9) * 0.5 + Math.sin(y * 0.23 - t * 0.7 + x * 0.04) * 0.35 + Math.sin((x + y) * 0.05 + t * 0.4) * 0.3;
        if (p.active) { const d = Math.hypot(px - p.x, py - p.y); v += Math.max(0, 1 - d / 140) * 1.6 * Math.cos(d * 0.08 - t * 6); }
        const n = Math.max(0, Math.min(RAMP.length - 1, Math.floor(((v + 1.2) / 2.6) * RAMP.length)));
        if (n === 0) continue;
        const hot = n >= RAMP.length - 2;
        ctx.globalAlpha = 0.18 + (n / RAMP.length) * 0.6;
        ctx.fillStyle = hot ? accent : ink;
        ctx.fillText(RAMP[n], px, py);
      }
    }
    // a few words surface and fade, like recurring complaints rising out of noise
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = accent;
    words.forEach((word, i) => {
      const phase = (t * 0.25 + i * 0.37) % 1;
      if (phase > 0.6) return;
      const gx = Math.floor((((i * 9301 + 49297) % 233280) / 233280) * (cols - word.length)) * cw;
      const gy = Math.floor((((i * 7919 + 104729) % 99991) / 99991) * rows) * cell;
      ctx.globalAlpha = Math.sin((phase / 0.6) * Math.PI) * 0.9;
      ctx.fillText(word, gx, gy);
    });
    ctx.globalAlpha = 1;
  }, [cell, words]);
  useCanvasLoop(ref, draw, 24);
  return <canvas ref={ref} className={`ascii-field ${className}`} aria-hidden="true" />;
}
