"""Strike selection for short straddle / strangle from an entry-day chain."""

from __future__ import annotations

import pandas as pd


def _nearest_strike(strikes: pd.Series, target: float) -> float | None:
    if strikes.empty:
        return None
    return float(strikes.iloc[(strikes - target).abs().argmin()])


def atm_strike(chain: pd.DataFrame, spot: float) -> float | None:
    """Strike nearest spot (used for straddle, both legs same strike)."""
    return _nearest_strike(chain["strike"].drop_duplicates().sort_values(), spot)


def _leg_strike_by_delta(leg: pd.DataFrame, target_delta: float) -> float | None:
    if leg.empty or "delta" not in leg.columns or leg["delta"].isna().all():
        return None
    d = leg.dropna(subset=["delta"]).copy()
    d["abs_delta"] = d["delta"].abs()
    d = d[d["abs_delta"] > 0]
    if d.empty:
        return None
    idx = (d["abs_delta"] - target_delta).abs().idxmin()
    return float(d.loc[idx, "strike"])


def _leg_strike_by_premium(leg: pd.DataFrame, target_premium: float) -> float | None:
    if leg.empty:
        return None
    d = leg.dropna(subset=["close"]).copy()
    d = d[d["close"] > 0]
    if d.empty:
        return None
    idx = (d["close"] - target_premium).abs().idxmin()
    return float(d.loc[idx, "strike"])


def select_strikes(
    chain: pd.DataFrame,
    spot: float,
    *,
    structure: str,
    method: str,
    target_delta: float,
    target_premium: float,
    offset_pct: float,
    step: int,
) -> tuple[float, float] | None:
    """Return (ce_strike, pe_strike) for the position, or None if unresolvable.

    `chain` is the entry-day rows for a single expiry (CE + PE).
    """
    ce = chain[chain["opt_type"] == "CE"]
    pe = chain[chain["opt_type"] == "PE"]
    if ce.empty or pe.empty:
        return None

    if structure == "straddle":
        atm = atm_strike(chain, spot)
        if atm is None:
            return None
        return atm, atm

    # strangle — OTM call (above spot) + OTM put (below spot)
    if method == "delta":
        ce_strike = _leg_strike_by_delta(ce, target_delta)
        pe_strike = _leg_strike_by_delta(pe, target_delta)
    elif method == "premium":
        ce_strike = _leg_strike_by_premium(ce, target_premium)
        pe_strike = _leg_strike_by_premium(pe, target_premium)
    elif method == "offset_pct":
        ce_target = spot * (1 + offset_pct / 100.0)
        pe_target = spot * (1 - offset_pct / 100.0)
        ce_strike = _nearest_strike(ce["strike"].drop_duplicates().sort_values(), ce_target)
        pe_strike = _nearest_strike(pe["strike"].drop_duplicates().sort_values(), pe_target)
    elif method == "atm":
        atm = atm_strike(chain, spot)
        ce_strike = pe_strike = atm
    else:
        raise ValueError(f"Unknown strike_method: {method}")

    if ce_strike is None or pe_strike is None:
        return None

    # enforce OTM-ness for strangle: CE above spot, PE below spot
    if structure == "strangle":
        if ce_strike < spot:
            ce_strike = ce_strike + step * round((spot - ce_strike) / step + 0.5)
        if pe_strike > spot:
            pe_strike = pe_strike - step * round((pe_strike - spot) / step + 0.5)

    return float(ce_strike), float(pe_strike)
