"use client";

import { useEffect, useState } from "react";

/** A number that rolls up from zero when it first appears. The real value is rendered on the server, so it is right without JavaScript. */
export default function Count({ n }: { n: number }) {
  const [v, setV] = useState(n);
  useEffect(() => {
    if (n <= 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => { const p = Math.min(1, (t - t0) / 900); setV(Math.round(n * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(step); };
    setV(0);
    raf = requestAnimationFrame(step);
    const done = setTimeout(() => setV(n), 1200); // never leave a wrong number if animation frames are paused
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [n]);
  return <>{v}</>;
}
