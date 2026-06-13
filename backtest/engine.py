from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from config import OrbFibConfig
from data.fetcher import session_candles
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


def _simulate_trade(day: pd.DataFrame, signal: TradeSignal) -> TradeResult | None:
    session = day.loc[signal.entry_time:]
    if session.empty:
        return None

    exit_time = session.index[-1]
    exit_price = float(session.iloc[-1]["close"])
    outcome = "eod"

    for ts, row in session.iterrows():
        if signal.side == "long":
            if row["low"] <= signal.stop_price:
                exit_time = ts
                exit_price = signal.stop_price
                outcome = "stop"
                break
            if row["high"] >= signal.target_price:
                exit_time = ts
                exit_price = signal.target_price
                outcome = "target"
                break
        else:
            if row["high"] >= signal.stop_price:
                exit_time = ts
                exit_price = signal.stop_price
                outcome = "stop"
                break
            if row["low"] <= signal.target_price:
                exit_time = ts
                exit_price = signal.target_price
                outcome = "target"
                break

    pnl = (
        exit_price - signal.entry_price
        if signal.side == "long"
        else signal.entry_price - exit_price
    )

    return TradeResult(
        session_date=str(signal.session_date),
        side=signal.side,
        entry_time=str(signal.entry_time),
        exit_time=str(exit_time),
        entry_price=signal.entry_price,
        exit_price=exit_price,
        pnl_points=pnl,
        outcome=outcome,
        orb_high=signal.orb_high,
        orb_low=signal.orb_low,
        entry_style=signal.entry_style,
    )


def run_backtest(df: pd.DataFrame, cfg: OrbFibConfig) -> tuple[pd.DataFrame, dict]:
    sessions = sorted({ts.date() for ts in df.index})
    trades: list[TradeResult] = []

    for session_date in sessions:
        day = session_candles(df, session_date)
        if day.empty:
            continue

        for signal in generate_signals(day, cfg):
            result = _simulate_trade(day, signal)
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
