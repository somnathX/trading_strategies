from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from config import OrbFibConfig
from data.fetcher import session_candles
from strategies.levels import range_levels
from strategies.orb_fib import TradeSignal, generate_signals


@dataclass
class TradeResult:
    session_date: str
    side: str
    entry_time: str
    exit_time: str
    entry_price: float
    exit_price: float
    pnl_points: float
    outcome: str
    orb_high: float
    orb_low: float
    entry_style: str
    tp1_price: float | None = None
    tp2_price: float | None = None
    tp3_price: float | None = None


def _ratchet_stop(
    signal: TradeSignal,
    levels: dict[str, float],
    cfg: OrbFibConfig,
    ratchet_idx: int,
) -> float:
    fib_pct = cfg.tsl_ratchet_fibs[min(ratchet_idx, len(cfg.tsl_ratchet_fibs) - 1)]
    span = signal.orb_high - signal.orb_low
    if signal.side == "long":
        return signal.orb_high - fib_pct * span
    return signal.orb_low + fib_pct * span


def _simulate_trade(
    day: pd.DataFrame,
    signal: TradeSignal,
    cfg: OrbFibConfig,
) -> TradeResult | None:
    session = day.loc[signal.entry_time:]
    if session.empty:
        return None

    levels = range_levels(signal.orb_high, signal.orb_low, cfg)
    entry = signal.entry_price
    stop = signal.stop_price
    remaining = 1.0
    pnl = 0.0
    outcomes: list[str] = []
    exit_time = session.index[-1]
    exit_price = float(session.iloc[-1]["close"])
    tp1_hit = False
    ratchet_idx = 0

    tps = [signal.tp1, signal.tp2, signal.tp3]
    sizes = list(cfg.tp_sizes)

    if cfg.exit_mode == "fib_tsl":
        target_rows = [(tps[0], sizes[0], "tp1")] if tps[0] is not None else []
    elif cfg.exit_mode == "tp_ladder":
        target_rows = [
            (tp, sizes[i], f"tp{i + 1}")
            for i, tp in enumerate(tps)
            if tp is not None and i < len(sizes)
        ]
    else:
        target_rows = []

    for ts, row in session.iterrows():
        hi, lo = float(row["high"]), float(row["low"])

        if signal.side == "long":
            if lo <= stop:
                pnl += remaining * (stop - entry)
                remaining = 0.0
                outcomes.append("tsl" if tp1_hit and cfg.exit_mode == "fib_tsl" else "stop")
                exit_time = ts
                exit_price = stop
                break

            for tp_price, alloc, label in target_rows:
                if alloc <= 0 or remaining < alloc or label in outcomes:
                    continue
                if hi >= tp_price:
                    pnl += alloc * (tp_price - entry)
                    remaining -= alloc
                    outcomes.append(label)
                    if label == "tp1":
                        tp1_hit = True
                    if cfg.exit_mode == "fib_tsl":
                        ratchet_idx = len(outcomes) - 1
                        stop = max(stop, _ratchet_stop(signal, levels, cfg, ratchet_idx))
                    elif cfg.exit_mode == "tp_ladder" and label == "tp1":
                        stop = max(stop, entry)

            if remaining <= 0:
                exit_time = ts
                break
        else:
            if hi >= stop:
                pnl += remaining * (stop - entry)
                remaining = 0.0
                outcomes.append("tsl" if tp1_hit and cfg.exit_mode == "fib_tsl" else "stop")
                exit_time = ts
                exit_price = stop
                break

            for tp_price, alloc, label in target_rows:
                if alloc <= 0 or remaining < alloc or label in outcomes:
                    continue
                if lo <= tp_price:
                    pnl += alloc * (tp_price - entry)
                    remaining -= alloc
                    outcomes.append(label)
                    if label == "tp1":
                        tp1_hit = True
                    if cfg.exit_mode == "fib_tsl":
                        ratchet_idx = len(outcomes) - 1
                        stop = min(stop, _ratchet_stop(signal, levels, cfg, ratchet_idx))
                    elif cfg.exit_mode == "tp_ladder" and label == "tp1":
                        stop = min(stop, entry)

            if remaining <= 0:
                exit_time = ts
                break

    if remaining > 0:
        eod_close = float(session.iloc[-1]["close"])
        pnl += remaining * ((eod_close - entry) if signal.side == "long" else (entry - eod_close))
        outcomes.append("eod")
        exit_time = session.index[-1]
        exit_price = eod_close

    outcome_str = "+".join(outcomes) if outcomes else "eod"
    avg_exit = entry + pnl if signal.side == "long" else entry - pnl

    return TradeResult(
        session_date=str(signal.session_date),
        side=signal.side,
        entry_time=str(signal.entry_time),
        exit_time=str(exit_time),
        entry_price=entry,
        exit_price=round(avg_exit, 2),
        pnl_points=round(pnl, 2),
        outcome=outcome_str,
        orb_high=signal.orb_high,
        orb_low=signal.orb_low,
        entry_style=signal.entry_style,
        tp1_price=signal.tp1,
        tp2_price=signal.tp2,
        tp3_price=signal.tp3,
    )


def run_backtest(df: pd.DataFrame, cfg: OrbFibConfig) -> tuple[pd.DataFrame, dict]:
    sessions = sorted({ts.date() for ts in df.index})
    trades: list[TradeResult] = []

    for session_date in sessions:
        day = session_candles(df, session_date)
        if day.empty:
            continue

        for signal in generate_signals(day, cfg):
            result = _simulate_trade(day, signal, cfg)
            if result:
                trades.append(result)

    if not trades:
        return pd.DataFrame(), {"trades": 0}

    results = pd.DataFrame([t.__dict__ for t in trades])
    wins = results[results["pnl_points"] > 0]
    losses = results[results["pnl_points"] <= 0]

    summary = {
        "trades": len(results),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / len(results) * 100, 2),
        "total_pnl_points": round(results["pnl_points"].sum(), 2),
        "avg_pnl_points": round(results["pnl_points"].mean(), 2),
        "max_win": round(results["pnl_points"].max(), 2),
        "max_loss": round(results["pnl_points"].min(), 2),
    }
    return results, summary
