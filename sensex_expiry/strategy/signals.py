"""SENSEX expiry-day strategy logic — placeholder until rules are defined."""

from __future__ import annotations

from datetime import date

import pandas as pd

from sensex_expiry.config import SensexExpiryConfig


def run_expiry_day(
    session: pd.DataFrame,
    session_date: date,
    cfg: SensexExpiryConfig,
) -> list[dict]:
    """
    Evaluate one expiry Thursday session. Returns trade dicts (empty until strategy rules exist).

    Expected trade keys (when implemented): session_date, entry_time, exit_time,
    direction, entry_price, exit_price, outcome, pnl_points.
    """
    if session.empty:
        return []
    _ = cfg
    return []
