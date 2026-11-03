"""Positional short-premium backtest: sell straddle/strangle, hold to expiry with SL/TP."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date

import pandas as pd

from options_selling.config import OptionsSellingConfig
from options_selling.loader import iv_series_for
from options_selling.strikes import select_strikes


@dataclass
class Position:
    symbol: str
    structure: str
    expiry: date
    entry_date: date
    exit_date: date
    spot_entry: float
    ce_strike: float
    pe_strike: float
    ce_entry: float
    pe_entry: float
    entry_credit: float
    ce_exit: float
    pe_exit: float
    exit_debit: float
    exit_reason: str
    hold_days: int
    entry_iv: float | None
    mfe_pts: float  # best (lowest) combined premium reached → max favorable
    mae_pts: float  # worst (highest) combined premium reached → max adverse
    pnl_points: float
    pnl_rupees: float


def _expiry_groups(df: pd.DataFrame, only_monthly: bool) -> list[tuple[pd.Timestamp, pd.DataFrame]]:
    groups = []
    for expiry, g in df.groupby("expiry"):
        groups.append((expiry, g))
    groups.sort(key=lambda x: x[0])
    if only_monthly:
        # monthly = last expiry of each calendar month
        by_month: dict[tuple[int, int], pd.Timestamp] = {}
        for expiry, _ in groups:
            key = (expiry.year, expiry.month)
            if key not in by_month or expiry > by_month[key]:
                by_month[key] = expiry
        keep = set(by_month.values())
        groups = [(e, g) for e, g in groups if e in keep]
    return groups


def _leg_close(rows: pd.DataFrame, opt_type: str, strike: float) -> float | None:
    leg = rows[(rows["opt_type"] == opt_type) & (rows["strike"] == strike)]
    if leg.empty:
        return None
    val = leg["close"].iloc[0]
    return float(val) if pd.notna(val) else None


def _intrinsic(spot: float, strike: float, opt_type: str) -> float:
    if opt_type == "CE":
        return max(spot - strike, 0.0)
    return max(strike - spot, 0.0)


def _passes_iv_filter(cfg: OptionsSellingConfig, iv: pd.Series, entry_dt: pd.Timestamp) -> tuple[bool, float | None]:
    if iv.empty:
        return (not cfg.use_iv_filter, None)
    on_or_before = iv[iv.index <= entry_dt]
    if on_or_before.empty:
        return (not cfg.use_iv_filter, None)
    val = float(on_or_before.iloc[-1])
    if not cfg.use_iv_filter:
        return (True, val)
    if cfg.iv_percentile_lookback and cfg.iv_percentile_lookback > 0:
        window = iv[iv.index <= entry_dt].tail(cfg.iv_percentile_lookback)
        if len(window) < 5:
            return (val >= cfg.iv_min, val)
        pct = (window < val).mean() * 100
        return (pct >= 50.0 and val >= cfg.iv_min, val)
    return (val >= cfg.iv_min, val)


def backtest(df: pd.DataFrame, cfg: OptionsSellingConfig) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """Run the positional short-premium backtest.

    Returns (positions_df, equity_df, summary).
    """
    lot = cfg.resolved_lot_size() * max(cfg.lots, 1)
    slip = cfg.slippage_pct / 100.0
    cost_pts = (4 * cfg.brokerage_per_order) / lot if lot else 0.0
    iv = iv_series_for(cfg.symbol)

    positions: list[Position] = []

    for expiry, g in _expiry_groups(df, cfg.only_monthly):
        trade_dates = sorted(g["trade_date"].unique())
        if len(trade_dates) < cfg.entry_dte + 1:
            continue
        entry_dt = trade_dates[-(cfg.entry_dte + 1)]

        ok_iv, entry_iv = _passes_iv_filter(cfg, iv, entry_dt)
        if not ok_iv:
            continue

        entry_chain = g[g["trade_date"] == entry_dt]
        if entry_chain.empty:
            continue
        spot = float(entry_chain["underlying"].iloc[0])

        picked = select_strikes(
            entry_chain,
            spot,
            structure=cfg.structure,
            method=cfg.strike_method,
            target_delta=cfg.target_delta,
            target_premium=cfg.target_premium,
            offset_pct=cfg.offset_pct,
            step=cfg.strike_step(),
        )
        if picked is None:
            continue
        ce_strike, pe_strike = picked

        ce_entry = _leg_close(entry_chain, "CE", ce_strike)
        pe_entry = _leg_close(entry_chain, "PE", pe_strike)
        if ce_entry is None or pe_entry is None or (ce_entry + pe_entry) <= 0:
            continue

        # seller fills slightly worse: receive less credit
        entry_credit = (ce_entry + pe_entry) * (1 - slip)

        hold_dates = [d for d in trade_dates if d >= entry_dt]
        if cfg.max_hold_days and cfg.max_hold_days > 0:
            hold_dates = hold_dates[: cfg.max_hold_days + 1]

        sl_level = (ce_entry + pe_entry) * (1 + cfg.stop_loss_pct / 100.0)
        tp_level = (ce_entry + pe_entry) * (1 - cfg.take_profit_pct / 100.0)

        mfe_combined = ce_entry + pe_entry  # lowest seen
        mae_combined = ce_entry + pe_entry  # highest seen
        exit_reason = "expiry"
        exit_dt = hold_dates[-1]
        ce_exit = pe_exit = None

        for i, d in enumerate(hold_dates):
            rows = g[g["trade_date"] == d]
            ce_c = _leg_close(rows, "CE", ce_strike)
            pe_c = _leg_close(rows, "PE", pe_strike)
            is_expiry_day = d == trade_dates[-1]

            # on expiry, fall back to intrinsic if a leg has no quote
            if is_expiry_day:
                day_spot = float(rows["underlying"].iloc[0]) if not rows.empty else spot
                if ce_c is None:
                    ce_c = _intrinsic(day_spot, ce_strike, "CE")
                if pe_c is None:
                    pe_c = _intrinsic(day_spot, pe_strike, "PE")
            if ce_c is None or pe_c is None:
                continue

            combined = ce_c + pe_c
            mfe_combined = min(mfe_combined, combined)
            mae_combined = max(mae_combined, combined)

            if i == 0:
                continue  # no same-day exit on entry bar

            if combined >= sl_level:
                exit_reason, exit_dt, ce_exit, pe_exit = "stop_loss", d, ce_c, pe_c
                break
            if combined <= tp_level:
                exit_reason, exit_dt, ce_exit, pe_exit = "take_profit", d, ce_c, pe_c
                break
            if is_expiry_day or (cfg.max_hold_days and i == len(hold_dates) - 1):
                exit_reason = "expiry" if is_expiry_day else "time_stop"
                exit_dt, ce_exit, pe_exit = d, ce_c, pe_c
                break

        if ce_exit is None or pe_exit is None:
            continue

        exit_debit = (ce_exit + pe_exit) * (1 + slip)
        pnl_points = entry_credit - exit_debit - cost_pts
        hold_days = (pd.Timestamp(exit_dt) - pd.Timestamp(entry_dt)).days

        positions.append(
            Position(
                symbol=cfg.symbol,
                structure=cfg.structure,
                expiry=pd.Timestamp(expiry).date(),
                entry_date=pd.Timestamp(entry_dt).date(),
                exit_date=pd.Timestamp(exit_dt).date(),
                spot_entry=round(spot, 2),
                ce_strike=ce_strike,
                pe_strike=pe_strike,
                ce_entry=round(ce_entry, 2),
                pe_entry=round(pe_entry, 2),
                entry_credit=round(entry_credit, 2),
                ce_exit=round(ce_exit, 2),
                pe_exit=round(pe_exit, 2),
                exit_debit=round(exit_debit, 2),
                exit_reason=exit_reason,
                hold_days=hold_days,
                entry_iv=round(entry_iv, 2) if entry_iv is not None else None,
                mfe_pts=round((ce_entry + pe_entry) - mfe_combined, 2),
                mae_pts=round(mae_combined - (ce_entry + pe_entry), 2),
                pnl_points=round(pnl_points, 2),
                pnl_rupees=round(pnl_points * lot, 2),
            )
        )

    positions_df = pd.DataFrame([asdict(p) for p in positions])
    if not positions_df.empty:
        positions_df = positions_df.sort_values("exit_date").reset_index(drop=True)

    equity_df = _equity_curve(positions_df)
    summary = _summarize(positions_df, cfg, lot)
    return positions_df, equity_df, summary


def _equity_curve(positions: pd.DataFrame) -> pd.DataFrame:
    if positions.empty:
        return pd.DataFrame(columns=["exit_date", "pnl_rupees", "cum_pnl", "peak", "drawdown"])
    eq = positions[["exit_date", "pnl_rupees"]].copy()
    eq["cum_pnl"] = eq["pnl_rupees"].cumsum()
    eq["peak"] = eq["cum_pnl"].cummax()
    eq["drawdown"] = eq["cum_pnl"] - eq["peak"]
    return eq


def _summarize(positions: pd.DataFrame, cfg: OptionsSellingConfig, lot: int) -> dict:
    if positions.empty:
        return {
            "trades": 0,
            "win_rate": 0.0,
            "total_pnl": 0.0,
            "avg_pnl": 0.0,
            "avg_win": 0.0,
            "avg_loss": 0.0,
            "expectancy": 0.0,
            "profit_factor": 0.0,
            "max_drawdown": 0.0,
            "sharpe": 0.0,
            "avg_credit": 0.0,
            "lot_size": lot,
        }
    pnl = positions["pnl_rupees"]
    wins = pnl[pnl > 0]
    losses = pnl[pnl <= 0]
    gross_win = float(wins.sum())
    gross_loss = float(-losses.sum())
    eq = _equity_curve(positions)
    std = float(pnl.std(ddof=1)) if len(pnl) > 1 else 0.0
    sharpe = (float(pnl.mean()) / std) if std > 0 else 0.0
    reason_counts = positions["exit_reason"].value_counts().to_dict()
    return {
        "trades": int(len(positions)),
        "win_rate": round(100 * len(wins) / len(positions), 1),
        "total_pnl": round(float(pnl.sum()), 0),
        "avg_pnl": round(float(pnl.mean()), 0),
        "avg_win": round(float(wins.mean()) if len(wins) else 0.0, 0),
        "avg_loss": round(float(losses.mean()) if len(losses) else 0.0, 0),
        "expectancy": round(float(pnl.mean()), 0),
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else float("inf"),
        "max_drawdown": round(float(eq["drawdown"].min()), 0),
        "sharpe": round(sharpe, 2),
        "avg_credit": round(float(positions["entry_credit"].mean()), 1),
        "lot_size": lot,
        "exit_reasons": reason_counts,
    }
