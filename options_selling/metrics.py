"""Aggregations for the options-selling backtest UI."""

from __future__ import annotations

import pandas as pd


def monthly_pnl(positions: pd.DataFrame) -> pd.DataFrame:
    if positions.empty:
        return pd.DataFrame(columns=["month", "pnl_rupees", "trades", "win_rate"])
    p = positions.copy()
    p["month"] = pd.to_datetime(p["exit_date"]).dt.to_period("M").astype(str)
    agg = p.groupby("month").agg(
        pnl_rupees=("pnl_rupees", "sum"),
        trades=("pnl_rupees", "count"),
        wins=("pnl_rupees", lambda s: int((s > 0).sum())),
    )
    agg["win_rate"] = (100 * agg["wins"] / agg["trades"]).round(1)
    return agg.drop(columns="wins").reset_index()


def yearly_pnl(positions: pd.DataFrame) -> pd.DataFrame:
    if positions.empty:
        return pd.DataFrame(columns=["year", "pnl_rupees", "trades", "win_rate"])
    p = positions.copy()
    p["year"] = pd.to_datetime(p["exit_date"]).dt.year
    agg = p.groupby("year").agg(
        pnl_rupees=("pnl_rupees", "sum"),
        trades=("pnl_rupees", "count"),
        wins=("pnl_rupees", lambda s: int((s > 0).sum())),
    )
    agg["win_rate"] = (100 * agg["wins"] / agg["trades"]).round(1)
    return agg.drop(columns="wins").reset_index()
