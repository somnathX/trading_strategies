import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildMarket, isoToDay, type Market } from "./engine/market";
import type { MetricKey, Summary } from "./engine/metrics";
import { DEFAULT_CONFIG, type Candles, type StrategyConfig } from "./engine/types";
import { Compare, loadRuns, saveRuns, type SavedRun } from "./ui/Compare";
import { lotEstimate } from "./ui/analysis";
import { DataSection } from "./ui/ContextBar";
import { Hero } from "./ui/Hero";
import { load, save } from "./ui/storage";
import { verdict } from "./ui/analysis";
import { inr, setCurrency, shortDateTime } from "./ui/format";
import { Help, Toast, type ToastMsg } from "./ui/Help";
import { LogoIcon } from "./ui/icons";
import { Insights } from "./ui/Insights";
import { Overview } from "./ui/Overview";
import { describe, matchPreset, presetConfig, STRATEGIES } from "./ui/presets";
import { intervalLabel, isUsd, loadSettings, saveSettings, sessionOf, withDerived, type DataFile, type Settings } from "./ui/settings";
import { resample } from "./engine/market";
import { StrategyPanel } from "./ui/StrategyPanel";
import { Sweep, type SweepState } from "./ui/Sweep";
import { Trades } from "./ui/Trades";
import { useThemeName } from "./ui/useTheme";
import { V2, withV2 } from "./ui/V2";
import { Bookmark, BookmarkPlus, ChartColumnBig, CircleHelp, FlaskConical, Grid3x3, LayoutDashboard, ListOrdered, Moon, PanelLeftClose, PanelLeftOpen, Radio, Redo2, Sun, Undo2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Request, Response, RunResult, RunSpec, SweepAxis } from "./worker";

type Tab = "overview" | "trades" | "insights" | "optimize" | "compare" | "v2";
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "trades", label: "Trades", icon: ListOrdered },
  { id: "insights", label: "Insights", icon: ChartColumnBig },
  { id: "optimize", label: "Optimize", icon: Grid3x3 },
  { id: "compare", label: "Saved", icon: Bookmark }, // id kept so old #compare links still work
  { id: "v2", label: "V2", icon: FlaskConical },
];
const isTab = (x: string): x is Tab => TABS.some((t) => t.id === x);
const tabFromHash = (): Tab => {
  const h = location.hash.slice(1);
  return isTab(h) ? h : "overview";
};
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName));
/** Fields with their own text undo (radios, checkboxes and selects don't have one). */
const hasTextUndo = (t: EventTarget | null) =>
  (t instanceof HTMLInputElement && !["radio", "checkbox"].includes(t.type)) || t instanceof HTMLTextAreaElement;

export function App() {
  const theme = useThemeName();
  const [files, setFiles] = useState<DataFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/data/index.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`index.json: HTTP ${r.status}`))))
      .then((f: DataFile[]) => setFiles(withDerived(f)))
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="empty">Couldn't load market data ({error}). Run <code>npm run fetch-data</code> first.</p>;
  if (!files) return <p className="empty" aria-busy="true">Loading market data…</p>;
  if (!files.length) return <p className="empty">No market data yet. Run <code>npm run fetch-data</code>.</p>;
  return <Backtester files={files} theme={theme} />;
}

function Backtester({ files, theme: [theme, setTheme] }: { files: DataFile[]; theme: ReturnType<typeof useThemeName> }) {
  const history = useHistory<Settings>(() => loadSettings(files));
  const settings = history.present;
  const setSettings = history.set;
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runs, setRuns] = useState<SavedRun[]>(loadRuns);
  const [sweep, setSweep] = useState<SweepState | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // Data & strategy sidebar: docked on screens 1024px+ (open by default, remembered), a slide-out sheet below.
  const wide = useMedia("(min-width: 1024px)");
  const [docked, setDocked] = useState(() => load("orb:sidebar", true));
  const [sheetOpen, setSheetOpen] = useState(false);
  const panelOpen = wide ? docked : sheetOpen;
  const setPanelOpen = useCallback((open: boolean) => {
    if (matchMedia("(min-width: 1024px)").matches) { setDocked(open); save("orb:sidebar", open); } else setSheetOpen(open);
  }, []);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const file = files.find((f) => f.file === settings.file)!;
  const acctKey = isUsd(file) ? "usAccount" : "account";
  const account = settings[acctKey];
  setCurrency(isUsd(file) ? "USD" : "INR");
  const market = useMarket(file);
  const busy = useDelayed(running, 300); // runs usually take ~10 ms: don't flash a loading state

  const specFor = useCallback((s: Settings): RunSpec => {
    const f = files.find((x) => x.file === s.file) ?? file;
    return {
      file: s.file, source: f.source ?? f.file, resample: f.resample ?? null, interval: f.interval,
      lotSize: f.lotSize, from: s.from, to: s.to, oosFrom: s.oosEnabled ? s.oosFrom : null, cfg: s.cfg,
      account: isUsd(f) ? s.usAccount : s.account, session: sessionOf(f), symbol: f.symbol,
    };
  }, [files, file]);
  const spec = useMemo(() => specFor(settings), [specFor, settings]);

  // Summaries of everything run this session, so tiles can show the change from the previous settings.
  const summaries = useRef(new Map<string, Summary>());
  const prevSettings = history.past[history.past.length - 1];
  const prevSummary = prevSettings ? summaries.current.get(JSON.stringify(specFor(prevSettings))) ?? null : null;

  const notify = useCallback((text: string, action?: ToastMsg["action"]) => setToast({ id: Date.now(), text, action }), []);

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    window.history.replaceState(null, "", `#${t}`);
    // Each view starts at its top (the main column scrolls on desktop, the page on phones).
    requestAnimationFrame(() => { document.querySelector("main")?.scrollTo({ top: 0 }); window.scrollTo({ top: 0 }); });
  }, []);
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // One worker for runs and sweeps; responses for stale requests are ignored.
  const worker = useRef<Worker | null>(null);
  const runId = useRef(0);
  const runKey = useRef("");
  const sweepId = useRef(0);
  useEffect(() => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<Response>) => {
      const r = e.data;
      if (r.kind === "run" && r.id === runId.current) {
        summaries.current.set(runKey.current, r.result.all.summary);
        setResult(r.result);
        setRunning(false);
        setRunError(null);
      } else if (r.kind === "sweep-cell" && r.id === sweepId.current) {
        setSweep((s) => s && { ...s, cells: [...s.cells, r.cell], done: r.done, total: r.total });
      } else if (r.kind === "error" && (r.id === runId.current || r.id === sweepId.current)) {
        setRunError(r.message);
        setRunning(false);
      }
    };
    worker.current = w;
    return () => w.terminate();
  }, []);

  useEffect(() => {
    saveSettings(settings, file.to);
    setRunning(true);
    const id = ++runId.current;
    const key = JSON.stringify(spec);
    const timer = setTimeout(() => {
      runKey.current = key;
      worker.current?.postMessage({ kind: "run", id, spec } satisfies Request);
    }, 80);
    return () => clearTimeout(timer);
  }, [spec, settings]);

  const runSweep = (x: SweepAxis, y: SweepAxis, metric: MetricKey) => {
    const id = ++sweepId.current;
    setSweep({ x, y, metric, cells: [], done: 0, total: x.values.length * y.values.length });
    worker.current?.postMessage({ kind: "sweep", id, spec, x, y } satisfies Request);
  };

  const saveRun = useCallback(() => {
    if (!result) return;
    const base = runName(settings, file.symbol, file.interval);
    let name = base;
    for (let n = 2; runs.some((r) => r.name === name); n++) name = `${base} (${n})`;
    const run: SavedRun = {
      id: crypto.randomUUID(), name, savedAt: Date.now(), settings,
      summary: result.all.summary, outOfSample: result.outOfSample?.summary ?? null, equity: result.all.equity,
    };
    const next = [run, ...runs];
    setRuns(next);
    saveRuns(next);
    notify(`Saved “${name}”. Find it under Saved, or in Start from.`, { label: "View", run: () => setTab("compare") });
  }, [result, settings, file, runs, notify, setTab]);

  /** Apply a saved run's settings. Runs saved before newer options existed get today's defaults for those. */
  const loadSaved = (st: Partial<Settings>) => setSettings({
    ...settings, ...st,
    cfg: { ...DEFAULT_CONFIG, ...st.cfg },
    account: { ...settings.account, ...st.account },
    usAccount: { ...settings.usAccount, ...st.usAccount },
    file: st.file && files.some((f) => f.file === st.file) ? st.file : settings.file,
  }, false);

  const deleteRun = (run: SavedRun) => {
    const next = runs.filter((r) => r.id !== run.id);
    setRuns(next);
    saveRuns(next);
    notify(`Deleted “${run.name}”`, {
      label: "Undo",
      run: () => setRuns((cur) => {
        const restored = [run, ...cur].sort((a, b) => b.savedAt - a.savedAt);
        saveRuns(restored);
        return restored;
      }),
    });
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && (key === "z" || key === "y") && hasTextUndo(e.target)) return; // let the field undo its own typing
      if (mod && key === "z" && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
      if (mod && ((key === "z" && e.shiftKey) || key === "y")) { e.preventDefault(); history.redo(); return; }
      if (mod && key === "s") { e.preventDefault(); saveRun(); return; }
      if (mod || e.altKey || isTyping(e.target) || helpOpen) return;
      if (e.key === "?") { e.preventDefault(); setHelpOpen(true); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= TABS.length) setTab(TABS[n - 1].id);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [history, saveRun, setTab, helpOpen]);

  const s = result?.all.summary;
  const splitDay = settings.oosEnabled ? isoToDay(settings.oosFrom) : null;
  const preset = matchPreset(settings.cfg);
  const v = useMemo(() => (result ? verdict(result, file.symbol, account.capital, settings.oosEnabled ? settings.oosFrom : null) : null),
    [result, file.symbol, account.capital, settings.oosEnabled, settings.oosFrom]);
  const strategyKind = STRATEGIES.find((x) => x.value === settings.cfg.strategy)?.label ?? settings.cfg.strategy;
  const counts: Partial<Record<Tab, number>> = { trades: result?.all.rows.length, compare: runs.length || undefined };

  const sidebar = (
    <>
      <DataSection settings={settings} files={files} onChange={setSettings} />
      <StrategyPanel cfg={settings.cfg} account={account} lotSize={file.lotSize} interval={file.interval} file={file}
        onCfg={(cfg) => setSettings({ ...settings, cfg })}
        onPreset={(p) => {
          // Keep the instrument; only move to the preset's timeframe if this instrument has it.
          const same = p.interval ? files.find((f) => f.symbol === file.symbol && f.interval === p.interval) : undefined;
          setSettings({ ...settings, cfg: presetConfig(p), file: same?.file ?? settings.file });
        }}
        onAccount={(a) => setSettings({ ...settings, [acctKey]: a })}
        saved={runs.map((r) => ({ id: r.id, name: r.name }))}
        onLoadSaved={(id) => {
          const r = runs.find((x) => x.id === id);
          if (r) { loadSaved(r.settings); notify(`Loaded “${r.name}”`, { label: "Undo", run: history.undo }); }
        }}
        lots={result ? lotEstimate(result.all.rows, market ? market.c.c[market.c.c.length - 1] : null, file.lotSize, account) : null} />
    </>
  );
  const brand = (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
      <LogoIcon />
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-sm font-semibold tracking-tight">ORB Backtester</span>
        <span className="text-xs text-muted-foreground">Data &amp; strategy</span>
      </div>
    </div>
  );

  return (
    <TooltipProvider>
      <div className="relative flex h-dvh overflow-hidden bg-background text-foreground">
        <a href="#panel" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">Skip to results</a>

        {/* Inputs on the left: docked on wide screens, a slide-out panel on narrow ones. */}
        {wide ? panelOpen && (
          <aside id="strategy" aria-label="Data and strategy" className="flex w-[340px] shrink-0 flex-col border-r bg-sidebar xl:w-[360px]">
            {brand}
            <div className="scrollbar-thin relative flex-1 overflow-y-auto">{sidebar}</div>
          </aside>
        ) : (
          <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
            <SheetContent side="left" aria-describedby={undefined}>
              <SheetTitle className="sr-only">Data and strategy</SheetTitle>
              {brand}
              <div className="relative flex-1 overflow-y-auto">{sidebar}</div>
              {s && <div className="border-t p-3"><Button className="w-full" onClick={() => setPanelOpen(false)}>Show results · {inr(s.netInr)}</Button></div>}
            </SheetContent>
          </Sheet>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-1 border-b bg-background/80 px-3 backdrop-blur sm:px-4">
            <Button variant="ghost" size="icon-sm" onClick={() => setPanelOpen(!panelOpen)} aria-controls="strategy" aria-expanded={panelOpen}
              aria-label={panelOpen ? "Hide data and strategy" : "Show data and strategy"} title="Data and strategy">
              {panelOpen && wide ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
            <Separator orientation="vertical" className="mx-2 !h-5" />
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
              <span className="hidden truncate text-muted-foreground sm:inline">{file.symbol} · {intervalLabel(file.interval)}</span>
              <span className="hidden text-muted-foreground sm:inline" aria-hidden="true">/</span>
              <span className="truncate font-medium">{TABS.find((t) => t.id === tab)!.label}</span>
            </nav>
            <div className="ml-auto flex items-center gap-0.5">
              <Button variant="ghost" size="icon-sm" onClick={history.undo} disabled={!history.canUndo} aria-label="Undo" title="Undo (⌘Z)"><Undo2 /></Button>
              <Button variant="ghost" size="icon-sm" onClick={history.redo} disabled={!history.canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><Redo2 /></Button>
              <Separator orientation="vertical" className="mx-1.5 !h-5" />
              <Button variant="ghost" size="icon-sm" asChild><a href="/live" aria-label="Live trading" title="Live positions and orders (Dhan)"><Radio /></a></Button>
              <Button variant="ghost" size="icon-sm" onClick={() => setHelpOpen(true)} aria-label="Help and shortcuts" title="Help (?)"><CircleHelp /></Button>
              <Button variant="ghost" size="icon-sm" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`${theme === "dark" ? "Light" : "Dark"} theme`}>
                {theme === "dark" ? <Sun /> : <Moon />}
              </Button>
              <Button size="sm" className="ml-1.5" onClick={saveRun} disabled={!result} title="Save run (⌘S)"><BookmarkPlus /><span className="hidden sm:inline">Save run</span></Button>
            </div>
          </header>

          <main className="scrollbar-thin relative flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-6 sm:px-6">
              <Hero kind={strategyKind} name={preset ? preset.name : "Custom settings"} description={describe(settings.cfg)}
                grade={v?.grade} gradeLabel={v?.label} headline={v?.headline} error={runError}
                net={s?.netInr} returnPct={s?.returnPct} equity={result?.all.equity} capital={account.capital}
                meta={s ? <>
                  {s.trades} trades
                  {result?.options === "unavailable" ? " · no option prices, shown as futures"
                    : result?.options ? ` · options${result.options.noData ? ` (${result.options.noData} without option prices skipped)` : ""}` : ""}
                  {busy ? " · updating…" : ""}
                  {result?.dataEnd ? ` · data to ${shortDateTime(result.dataEnd)}` : ""}
                </> : "Running backtest…"} />

              <Tabs value={tab} onValueChange={(t) => setTab(t as Tab)} className="gap-5">
                <div className="scrollbar-none -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                  <TabsList>
                    {TABS.map((t, n) => (
                      <TabsTrigger key={t.id} value={t.id} id={`tab-${t.id}`} title={`${t.label} (${n + 1})`} className="px-2.5">
                        <t.icon />{t.label}
                        {counts[t.id] !== undefined && <span className="rounded bg-muted-foreground/15 px-1.5 text-[11px] font-medium leading-4 text-muted-foreground">{counts[t.id]}</span>}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>

                <div id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`} aria-busy={busy} tabIndex={-1}
                  className={cn("@container outline-none transition-opacity", busy && "opacity-60")}>
                  {!result && !runError && <p className="py-16 text-center text-muted-foreground">Running backtest…</p>}
                  {result && tab === "overview" && (
                    <Overview result={result} prev={prevSummary} symbol={file.symbol} capital={account.capital} compound={!!account.compound && account.sizing === "risk"}
                      oosFrom={settings.oosEnabled ? settings.oosFrom : null} splitDay={splitDay} />
                  )}
                  {result && tab === "trades" && <Trades rows={result.all.rows} market={market} focusDay={focusDay} cfg={settings.cfg} />}
                  {result && tab === "insights" && (
                    <Insights evaluation={result.all} onPickDay={(d) => { setFocusDay(d); setTab("trades"); }} />
                  )}
                  {tab === "optimize" && (
                    <Sweep key={settings.cfg.strategy} state={sweep} cfg={settings.cfg} hasOos={settings.oosEnabled} onRun={runSweep}
                      onApply={(patch: Partial<StrategyConfig>) => {
                        setSettings({ ...settings, cfg: { ...settings.cfg, ...patch } }, false);
                        setTab("overview");
                        notify("Applied those settings", { label: "Undo", run: history.undo });
                      }} />
                  )}
                  {tab === "v2" && (
                    <V2 spec={spec} v1={result} v2={settings.v2} onChange={(v2) => setSettings({ ...settings, v2 })}
                      onUseEverywhere={() => {
                        const s2 = withV2(spec, settings.v2);
                        setSettings({ ...settings, cfg: s2.cfg, [acctKey]: s2.account }, false);
                        setTab("overview");
                        notify("V2 settings now apply in every tab", { label: "Undo", run: history.undo });
                      }} />
                  )}
                  {tab === "compare" && (
                    <Compare runs={runs} onDelete={deleteRun}
                      onLoad={(st) => {
                        loadSaved(st);
                        setTab("overview");
                        notify("Loaded saved settings", { label: "Undo", run: history.undo });
                      }} />
                  )}
                </div>
              </Tabs>
            </div>
          </main>
        </div>

        <Help open={helpOpen} onClose={() => setHelpOpen(false)} />
        <Toast toast={toast} onDone={() => setToast(null)} />
      </div>
    </TooltipProvider>
  );
}

function runName(s: Settings, symbol: string, interval: number): string {
  return `${symbol} ${intervalLabel(interval)} · ${describe(s.cfg)}`;
}

/**
 * Settings with undo/redo. Rapid edits (typing a number, clicking through options)
 * within 700 ms collapse into one step.
 */
function useHistory<T>(init: () => T) {
  const [h, setH] = useState(() => ({ past: [] as T[], present: init(), future: [] as T[] }));
  const last = useRef(0);
  const set = useCallback((next: T, coalesce = true) => {
    const now = Date.now();
    const merge = coalesce && now - last.current < 700;
    last.current = now;
    setH((x) => ({ past: merge && x.past.length ? x.past : [...x.past, x.present].slice(-100), present: next, future: [] }));
  }, []);
  const undo = useCallback(() => {
    last.current = 0;
    setH((x) => (x.past.length ? { past: x.past.slice(0, -1), present: x.past[x.past.length - 1], future: [x.present, ...x.future] } : x));
  }, []);
  const redo = useCallback(() => {
    last.current = 0;
    setH((x) => (x.future.length ? { past: [...x.past, x.present], present: x.future[0], future: x.future.slice(1) } : x));
  }, []);
  return useMemo(() => ({ ...h, set, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 }), [h, set, undo, redo]);
}

/** Whether a media query matches, kept live. */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

/** `value`, but only turns true once it has stayed true for `ms`. */
function useDelayed(value: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!value) {
      setLate(false);
      return;
    }
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return value && late;
}

/** Full candles for the trade chart (the worker keeps its own copy for backtests). */
function useMarket(f: DataFile): Market | null {
  const [m, setM] = useState<{ id: string; market: Market } | null>(null);
  const { file: id, source, resample: minutes } = f;
  const session = sessionOf(f);
  useEffect(() => {
    let live = true;
    fetch(`/data/${source ?? id}`, { cache: "no-cache" })
      .then((r) => r.json() as Promise<Candles>)
      .then((c) => live && setM({ id, market: buildMarket(minutes ? resample(c, minutes, session.open) : c, session) }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, source, minutes]);
  return m?.id === id ? m.market : null;
}
