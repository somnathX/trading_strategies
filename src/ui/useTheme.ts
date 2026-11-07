import { useEffect, useState } from "react";
import { load, save } from "./storage";

export type ThemeName = "dark" | "light";
const KEY = "orb:theme";

/** App theme: dark by default (trading-terminal convention), remembered per browser. */
export function useThemeName(): [ThemeName, (t: ThemeName) => void] {
  const [theme, setTheme] = useState<ThemeName>(() => load<ThemeName>(KEY, "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    save(KEY, theme);
  }, [theme]);
  return [theme, setTheme];
}

export interface ChartTheme {
  bg: string;
  text: string;
  grid: string;
  up: string;
  down: string;
  accent: string;
  muted: string;
  border: string;
  series: string[];
}

function read(): ChartTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    bg: v("--surface"),
    text: v("--text-2"),
    grid: v("--grid"),
    up: v("--pos"),
    down: v("--neg"),
    accent: v("--accent"),
    muted: v("--text-3"),
    border: v("--border"),
    series: [1, 2, 3, 4, 5, 6].map((n) => v(`--series-${n}`)),
  };
}

/** Chart colours from the CSS tokens, re-read whenever the theme attribute changes. */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}
