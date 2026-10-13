"use client";

import { useEffect, useState } from "react";

/** A ticking IST clock: the reporting week is defined in IST, so the time that matters is always on screen. */
export default function LiveClock({ label = "IST" }: { label?: string }) {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const tick = () => setNow(f.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="clock mono" aria-label={now ? `Time in India ${now}` : "Time in India"}><span className="clock-dot" aria-hidden="true" />{label} {now ?? "--:--:--"}</span>;
}
