"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icons";

const KEY = "jarvis-theme";

/** Light ("paper") is the default. The choice is remembered in this browser only; if storage is unavailable the toggle still works for the visit. */
export default function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const [theme, setTheme] = useState<"dark" | "light">("light");
  useEffect(() => { setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"); }, []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    if (next === "dark") document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem(KEY, next); } catch { /* private mode or blocked storage: keep the in-page choice only */ }
  };
  const to = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className={withLabel ? "btn" : "icon-btn"} onClick={flip} aria-label={`Switch to ${to} theme`} title={`Switch to ${to} theme`}>
      <Icon name={theme === "dark" ? "sun" : "moon"} />
      {withLabel && <span>{to === "light" ? "Light theme" : "Dark theme"}</span>}
    </button>
  );
}

/** Re-applies a saved dark theme after hydration. Needed on pages Next renders through its error shell (a thrown notFound()), which replaces <html> after the boot script ran. */
export function ThemeSync() {
  useEffect(() => {
    try { if (localStorage.getItem(KEY) === "dark") document.documentElement.dataset.theme = "dark"; } catch { /* storage unavailable: stay on the default */ }
  }, []);
  return null;
}

/** Runs before first paint (inlined in <head>) so a saved dark theme does not flash light. */
export const THEME_BOOT = `try{if(localStorage.getItem("${KEY}")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;
