"""Config for the swing long/short backtest (Heikin-Ashi breakout + MA filter)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SwingConfig:
    symbol: str = "NIFTY"

    # --- signal core ---
    tp_pct: float = 3.0  # take-profit % on the underlying (tp_mode="percent")
    sl_buffer_pct: float = 0.5  # stop-loss buffer below/above prior HA low/high (%)

    # --- take-profit method ---
    tp_mode: str = "percent"  # percent | fibonacci
    # fibonacci: scale out in three legs at these extensions of the consolidation range
    fib_tp1: float = 1.0
    fib_tp2: float = 1.618
    fib_tp3: float = 2.618
    move_sl_to_be: bool = True  # after TP1 fills, move stop on the remainder to entry

    # --- MA trend filter ---
    apply_ma_filter: bool = True
    ma_fast: int = 6
    ma_slow: int = 9
    ma_type: str = "SMA"  # SMA | EMA

    # --- backtest window guard (mirrors the Pine start date) ---
    start_year: int = 2000
    start_month: int = 1
    start_day: int = 1
