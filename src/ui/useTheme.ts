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

/** Any CSS colour (oklch, color-mix…) as #rrggbb / rgba(), which the chart library understands: paint a pixel, read it back. */
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
function resolve(color: string): string {
  if (!probe) return color;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return a === 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

function read(): ChartTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => resolve(css.getPropertyValue(name).trim());
  return {
    bg: v("--card"),
    text: v("--muted-foreground"),
    grid: v("--chart-grid"),
    up: v("--pos"),
    down: v("--neg"),
    accent: v("--info"),
    muted: v("--muted-foreground"),
    border: v("--border"),
    series: [1, 2, 3, 4, 5, 6].map((n) => v(`--chart-${n}`)),
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
