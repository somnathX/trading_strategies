import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildMarket, isoToDay, type Market } from "./engine/market";
import type { MetricKey, Summary } from "./engine/metrics";
import type { Candles, StrategyConfig } from "./engine/types";
import { Compare, loadRuns, saveRuns, type SavedRun } from "./ui/Compare";
import { lotEstimate } from "./ui/analysis";
import { DataBar } from "./ui/DataBar";
import { inr, pct, setCurrency, shortDateTime } from "./ui/format";
import { Help, Toast, type ToastMsg } from "./ui/Help";
import { BookmarkIcon, CloseIcon, HelpIcon, LogoIcon, MoonIcon, RedoIcon, SlidersIcon, SunIcon, UndoIcon } from "./ui/icons";
import { Insights } from "./ui/Insights";
import { Overview } from "./ui/Overview";
import { describe, matchPreset, presetConfig } from "./ui/presets";
import { intervalLabel, isUsd, loadSettings, saveSettings, sessionOf, withDerived, type DataFile, type Settings } from "./ui/settings";
import { resample } from "./engine/market";
import { StrategyPanel } from "./ui/StrategyPanel";
import { Sweep, type SweepState } from "./ui/Sweep";
import { Trades } from "./ui/Trades";
import { useThemeName } from "./ui/useTheme";
import type { Request, Response, RunResult, RunSpec, SweepAxis } from "./worker";

type Tab = "overview" | "trades" | "insights" | "optimize" | "compare";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "trades", label: "Trades" },
  { id: "insights", label: "Insights" },
  { id: "optimize", label: "Optimize" },
  { id: "compare", label: "Compare" },
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
  const [panelOpen, setPanelOpen] = useState(false); // phone layout only
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
    // Start the new view at its top, just under the sticky tab bar (only if we'd scrolled past it).
    requestAnimationFrame(() => {
      const panel = document.getElementById("panel");
      if (panel && panel.getBoundingClientRect().top < 0) panel.scrollIntoView({ block: "start" });
    });
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
    saveSettings(settings);
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
    notify(`Saved “${name}”`, { label: "Compare", run: () => setTab("compare") });
  }, [result, settings, file, runs, notify, setTab]);

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

  return (
    <div className="app">
      <a className="skip" href="#panel">Skip to results</a>
      <header className="topbar">
        <div className="brand">
          <LogoIcon />
          <div className="brand-text">
            <h1>ORB Backtester</h1>
            <p>{preset ? preset.name : describe(settings.cfg)}</p>
          </div>
        </div>

        <div className="status" aria-live="polite">
          {runError ? <span className="neg">Couldn't run: {runError}</span>
            : s ? (
              <>
                <span className={`big ${s.netInr >= 0 ? "pos" : "neg"}`}>{inr(s.netInr)}</span>
                <span className="meta">
                  {pct(s.returnPct)} · {s.trades} trades
                  {result?.options === "unavailable" ? " · no option prices, shown as futures"
                    : result?.options ? ` · options${result.options.noData ? ` (${result.options.noData} without option prices skipped)` : ""}` : ""}
                  {busy ? " · updating…" : ""}
                  {result?.dataEnd ? ` · data to ${shortDateTime(result.dataEnd)}` : ""}
                </span>
              </>
            ) : <span className="meta">Running backtest…</span>}
        </div>

        <div className="actions">
          <button type="button" className="icon-btn" onClick={history.undo} disabled={!history.canUndo} aria-label="Undo" title="Undo (⌘Z)"><UndoIcon /></button>
          <button type="button" className="icon-btn" onClick={history.redo} disabled={!history.canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><RedoIcon /></button>
          <button type="button" className="btn" onClick={saveRun} disabled={!result} title="Save run (⌘S)"><BookmarkIcon /> <span className="btn-text">Save run</span></button>
          <button type="button" className="icon-btn" onClick={() => setHelpOpen(true)} aria-label="Help and shortcuts" title="Help (?)"><HelpIcon /></button>
          <button type="button" className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`${theme === "dark" ? "Light" : "Dark"} theme`}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <aside id="strategy" className={panelOpen ? "sidebar open" : "sidebar"} aria-label="Strategy">
        <div className="sheet-head">
          <h2>Strategy</h2>
          <button type="button" className="btn" onClick={() => setPanelOpen(false)}>
            <CloseIcon /> Show results{s ? ` · ${inr(s.netInr)}` : ""}
          </button>
        </div>
        <StrategyPanel cfg={settings.cfg} account={account} lotSize={file.lotSize} interval={file.interval} file={file}
          onCfg={(cfg) => setSettings({ ...settings, cfg })}
          onPreset={(p) => {
            // Keep the instrument; only move to the preset's timeframe if this instrument has it.
            const same = p.interval ? files.find((f) => f.symbol === file.symbol && f.interval === p.interval) : undefined;
            setSettings({ ...settings, cfg: presetConfig(p), file: same?.file ?? settings.file });
          }}
          onAccount={(a) => setSettings({ ...settings, [acctKey]: a })}
          lots={result ? lotEstimate(result.all.rows, market ? market.c.c[market.c.c.length - 1] : null, file.lotSize, account) : null} />
      </aside>

      <main className="main">
        <DataBar settings={settings} files={files} onChange={setSettings} />
        <button type="button" className="edit-strategy" onClick={() => setPanelOpen(true)} aria-controls="strategy" aria-expanded={panelOpen}>
          <SlidersIcon />
          <span>
            <b>{preset ? preset.name : "Custom strategy"}</b>
            <span className="hint">{describe(settings.cfg)} · tap to edit</span>
          </span>
        </button>

        <div className="tabs" role="tablist" aria-label="Views" onKeyDown={(e) => {
          const i = TABS.findIndex((t) => t.id === tab);
          const next = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 } as Record<string, number>)[e.key];
          if (next === undefined) return;
          e.preventDefault();
          const t = TABS[(next + TABS.length) % TABS.length];
          setTab(t.id);
          document.getElementById(`tab-${t.id}`)?.focus();
        }}>
          {TABS.map((t, n) => (
            <button key={t.id} id={`tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls="panel"
              tabIndex={tab === t.id ? 0 : -1} className="tab" onClick={() => setTab(t.id)} title={`${t.label} (${n + 1})`}>
              {t.label}
              {t.id === "compare" && runs.length > 0 && <span className="badge">{runs.length}</span>}
            </button>
          ))}
        </div>

        <div id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="content" aria-busy={busy} tabIndex={-1}>
          {!result && !runError && <p className="empty">Running backtest…</p>}
          {result && tab === "overview" && (
            <Overview result={result} prev={prevSummary} symbol={file.symbol} capital={account.capital}
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
          {tab === "compare" && (
            <Compare runs={runs} onDelete={deleteRun}
              onLoad={(st) => {
                setSettings({ ...st, file: files.some((f) => f.file === st.file) ? st.file : settings.file }, false);
                setTab("overview");
                notify("Loaded saved settings", { label: "Undo", run: history.undo });
              }} />
          )}
        </div>
      </main>

      <Help open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
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
