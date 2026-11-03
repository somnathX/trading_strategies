"""Backtest runner — only SENSEX expiry Thursdays (current regime)."""

from __future__ import annotations

from datetime import date

import pandas as pd

from sensex_expiry.calendar import REGIME_START, expiry_dates_in_range
from sensex_expiry.config import SensexExpiryConfig
from sensex_expiry.data import expiry_session_candles, list_expiry_sessions_in_data
from sensex_expiry.strategy.signals import run_expiry_day


def run_backtest(
    df: pd.DataFrame,
    *,
    start: date,
    end: date,
    cfg: SensexExpiryConfig | None = None,
) -> tuple[pd.DataFrame, list[date]]:
    """
    Run strategy on expiry Thursdays only. Returns (trades DataFrame, expiry dates tested).
    """
    cfg = cfg or SensexExpiryConfig()
    if end < REGIME_START:
        raise ValueError(
            f"End date {end} is before current regime start {REGIME_START}. "
            "SENSEX expiry backtests only support Thursday expiries from Sep 2025."
        )

    expiry_days = list_expiry_sessions_in_data(df, max(start, REGIME_START), end)
    if not expiry_days:
        scheduled = expiry_dates_in_range(max(start, REGIME_START), end)
        raise RuntimeError(
            f"No expiry sessions with data between {start} and {end}. "
            f"Expected {len(scheduled)} Thursday(s); fetch SENSEX data via dhan."
        )

    trades: list[dict] = []
    for session_date in expiry_days:
        session = expiry_session_candles(df, session_date)
        trades.extend(run_expiry_day(session, session_date, cfg))

    if not trades:
        return pd.DataFrame(), expiry_days

    return pd.DataFrame(trades), expiry_days


def summarize_results(results: pd.DataFrame) -> dict:
    if results.empty:
        return {
            "trades": 0,
            "wins": 0,
            "losses": 0,
            "win_rate": 0.0,
            "total_pnl_points": 0.0,
            "avg_pnl_points": 0.0,
            "max_win": 0.0,
            "max_loss": 0.0,
        }
    pnl = results["pnl_points"]
    wins = int((pnl > 0).sum())
    losses = int((pnl <= 0).sum())
    return {
        "trades": len(results),
        "wins": wins,
        "losses": losses,
        "win_rate": round(100 * wins / len(results), 1),
        "total_pnl_points": round(float(pnl.sum()), 2),
        "avg_pnl_points": round(float(pnl.mean()), 2),
        "max_win": round(float(pnl.max()), 2),
        "max_loss": round(float(pnl.min()), 2),
    }
