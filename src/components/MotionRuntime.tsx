"use client";

import { useEffect } from "react";

/*
 * Pointer micro-interactions for the whole site, delegated from one listener so pages stay server-rendered:
 *  - primary buttons (and .magnet) lean toward the pointer,
 *  - cards marked .tilt tip in 3D and catch a soft spotlight.
 * It only sets CSS custom properties and a class while the pointer is over an element. Scroll reveals are pure CSS
 * (scroll-driven animations), so nothing here ever hides content. Mouse only; skipped when reduced motion is preferred.
 */
export default function MotionRuntime() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let mag: HTMLElement | null = null, tilt: HTMLElement | null = null;
    const clear = (el: HTMLElement | null, kind: "mag" | "tilt") => {
      if (!el) return;
      if (kind === "mag") { el.classList.remove("is-magnet"); el.style.removeProperty("--tx"); el.style.removeProperty("--ty"); }
      else { el.classList.remove("is-tilt"); for (const p of ["--rx", "--ry", "--mx", "--my"]) el.style.removeProperty(p); }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const t = e.target as Element | null;
        const m = t?.closest?.<HTMLElement>(".btn.primary:not(:disabled), .magnet") ?? null;
        if (m !== mag) { clear(mag, "mag"); mag = m; }
        if (m) {
          const r = m.getBoundingClientRect();
          m.classList.add("is-magnet");
          m.style.setProperty("--tx", `${((e.clientX - r.left) / r.width - 0.5) * 8}px`);
          m.style.setProperty("--ty", `${((e.clientY - r.top) / r.height - 0.5) * 6}px`);
        }
        const c = t?.closest?.<HTMLElement>(".tilt") ?? null;
        if (c !== tilt) { clear(tilt, "tilt"); tilt = c; }
        if (c) {
          const r = c.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
          c.classList.add("is-tilt");
          c.style.setProperty("--ry", `${(x - 0.5) * 5}deg`);
          c.style.setProperty("--rx", `${-(y - 0.5) * 5}deg`);
          c.style.setProperty("--mx", `${x * 100}%`);
          c.style.setProperty("--my", `${y * 100}%`);
        }
      });
    };
    const leave = () => { clear(mag, "mag"); clear(tilt, "tilt"); mag = tilt = null; };
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerleave", leave); cancelAnimationFrame(raf); };
  }, []);
  return null;
}
