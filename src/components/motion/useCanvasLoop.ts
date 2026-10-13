"use client";

import { useEffect, type RefObject } from "react";

/**
 * Shared animation loop for the decorative canvases: sized to the element at a capped pixel ratio, paused while off screen or in a
 * background tab, and drawn exactly once (no loop) when the visitor prefers reduced motion. Keeps every motion piece cheap.
 */
export function useCanvasLoop(ref: RefObject<HTMLCanvasElement | null>, draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, pointer: { x: number; y: number; active: boolean }) => void, fps = 30) {
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: -1, y: -1, active: false };
    let w = 0, h = 0, raf = 0, visible = true, last = 0;
    const size = () => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = r.width; h = r.height;
      c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, w, h, performance.now() / 1000, pointer); // a first frame right away, so the picture never depends on the loop starting
    };
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden || t - last < 1000 / fps) return;
      last = t;
      draw(ctx, w, h, t / 1000, pointer);
    };
    const ro = new ResizeObserver(size);
    ro.observe(c);
    size();
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { rootMargin: "80px" });
    io.observe(c);
    const onMove = (e: PointerEvent) => { const r = c.getBoundingClientRect(); pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; pointer.active = pointer.x >= 0 && pointer.y >= 0 && pointer.x <= r.width && pointer.y <= r.height; };
    const onLeave = () => { pointer.active = false; };
    window.addEventListener("pointermove", onMove, { passive: true });
    c.addEventListener("pointerleave", onLeave);
    if (!reduce) raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); window.removeEventListener("pointermove", onMove); c.removeEventListener("pointerleave", onLeave); };
  }, [ref, draw, fps]);
}

export const cssVar = (name: string, fallback: string) => (typeof window === "undefined" ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
