"use client";

import { useCallback, useRef } from "react";
import { cssVar, useCanvasLoop } from "./useCanvasLoop";

type Shape = "globe" | "torus" | "cube" | "helix";
type P3 = [number, number, number];

/** Line-art 3D shapes, drawn in a 2D canvas with a tiny perspective projection: no 3D library, a few kilobytes. Drag or hover to turn them. */
function lines(shape: Shape): P3[][] {
  const out: P3[][] = [];
  if (shape === "globe") {
    for (let lat = -75; lat <= 75; lat += 25) { const r = Math.cos((lat * Math.PI) / 180), y = Math.sin((lat * Math.PI) / 180); out.push(Array.from({ length: 49 }, (_, i) => { const a = (i / 48) * Math.PI * 2; return [Math.cos(a) * r, y, Math.sin(a) * r]; })); }
    for (let lon = 0; lon < 180; lon += 22.5) { const b = (lon * Math.PI) / 180; out.push(Array.from({ length: 49 }, (_, i) => { const a = (i / 48) * Math.PI * 2; return [Math.cos(a) * Math.cos(b), Math.sin(a), Math.cos(a) * Math.sin(b)]; })); }
  } else if (shape === "torus") {
    const R = 0.72, r = 0.3;
    for (let i = 0; i < 18; i++) { const u = (i / 18) * Math.PI * 2; out.push(Array.from({ length: 33 }, (_, j) => { const v = (j / 32) * Math.PI * 2; return [(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)]; })); }
    for (let j = 0; j < 10; j++) { const v = (j / 10) * Math.PI * 2; out.push(Array.from({ length: 65 }, (_, i) => { const u = (i / 64) * Math.PI * 2; return [(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)]; })); }
  } else if (shape === "cube") {
    const s = 0.62, v: P3[] = [[-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s], [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]];
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) out.push([v[a], v[b]]);
    const k = 0.32; const w: P3[] = v.map(([x, y, z]) => [x * k / s, y * k / s, z * k / s]);
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) out.push([w[a], w[b]]);
    for (let i = 0; i < 8; i++) out.push([v[i], w[i]]);
  } else {
    for (let s = 0; s < 2; s++) out.push(Array.from({ length: 120 }, (_, i) => { const a = (i / 119) * Math.PI * 6 + s * Math.PI; return [Math.cos(a) * 0.45, (i / 119) * 2 - 1, Math.sin(a) * 0.45]; }));
    for (let i = 0; i < 24; i++) { const a = (i / 23) * Math.PI * 6; const y = (i / 23) * 2 - 1; out.push([[Math.cos(a) * 0.45, y, Math.sin(a) * 0.45], [Math.cos(a + Math.PI) * 0.45, y, Math.sin(a + Math.PI) * 0.45]]); }
  }
  return out;
}

export default function Wireframe({ shape = "globe", className = "", nodes = 0, speed = 1 }: { shape?: Shape; className?: string; nodes?: number; speed?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const geo = useRef<{ shape: Shape; l: P3[][]; n: P3[] } | null>(null);
  const spin = useRef({ x: -0.35, y: 0, vx: 0, vy: 0, px: -1, py: -1 });
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number, t: number, p: { x: number; y: number; active: boolean }) => {
    if (!geo.current || geo.current.shape !== shape) {
      const n: P3[] = Array.from({ length: nodes }, (_, i) => { const y = 1 - (i / Math.max(1, nodes - 1)) * 2, r = Math.sqrt(1 - y * y), a = i * 2.399963; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
      geo.current = { shape, l: lines(shape), n };
    }
    const s = spin.current;
    if (p.active) { if (s.px >= 0) { s.vy += (p.x - s.px) * 0.0009; s.vx += (p.y - s.py) * 0.0009; } s.px = p.x; s.py = p.y; } else { s.px = -1; }
    s.vx *= 0.92; s.vy *= 0.92;
    s.y += 0.006 * speed + s.vy; s.x += s.vx;
    ctx.clearRect(0, 0, w, h);
    const ink = cssVar("--text", "#111"), accent = cssVar("--accent", "#ff4d1f");
    const scale = Math.min(w, h) * 0.42, cx = w / 2, cy = h / 2;
    const cy1 = Math.cos(s.y), sy1 = Math.sin(s.y), cx1 = Math.cos(s.x), sx1 = Math.sin(s.x);
    const proj = ([x, y, z]: P3): [number, number, number] => {
      const x1 = x * cy1 - z * sy1, z1 = x * sy1 + z * cy1;
      const y2 = y * cx1 - z1 * sx1, z2 = y * sx1 + z1 * cx1;
      const f = 2.6 / (2.6 + z2);
      return [cx + x1 * scale * f, cy + y2 * scale * f, z2];
    };
    ctx.lineWidth = 1;
    for (const line of geo.current.l) {
      ctx.beginPath();
      let depth = 0;
      line.forEach((pt, i) => { const [x, y, z] = proj(pt); depth += z; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.16 + Math.max(0, -depth / line.length) * 0.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    geo.current.n.forEach((pt, i) => {
      const [x, y, z] = proj(pt);
      if (z > 0.35) return;
      const pulse = 1.6 + Math.sin(t * 2 + i) * 1.2;
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(x, y, pulse + (0.4 - z) * 1.5, 0, Math.PI * 2); ctx.fill();
    });
  }, [shape, nodes, speed]);
  useCanvasLoop(ref, draw, 40);
  return <canvas ref={ref} className={`wireframe ${className}`} aria-hidden="true" />;
}
