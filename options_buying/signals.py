"""Swing signal core: Heikin-Ashi consolidation breakout + MA(fast/slow) trend filter.

Faithful port of the Heikin-Ashi breakout + EMA/SMA-filter Pine v5 strategy:
- Heikin-Ashi candles drive a bull/bear state.
- On every HA color flip, the flip bar's HA high/low become consolidation levels.
- A long fires when HA close breaks above the stored high; short when it breaks below
  the stored low. Only one signal per consolidation (signal_triggered latch).
- Optional MA filter: longs only when fastMA > slowMA, shorts only when fastMA < slowMA.
- Stop-loss = prior bar HA low/high +/- buffer; take-profit = close * (1 +/- tp_pct).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from options_buying.config import SwingConfig


@dataclass(frozen=True)
class Signal:
    date: pd.Timestamp
    side: str  # "buy" | "sell"
    entry_price: float
    stop_loss: float
    take_profit: float  # final/primary target (for display)
    leverage: int  # informational, as in the Pine label
    cons_high: float  # consolidation high at the triggering flip
    cons_low: float   # consolidation low at the triggering flip
    tp_levels: tuple[tuple[float, float], ...] = ()  # ((price, qty_fraction), ...) in fill order


def _ma(series: pd.Series, length: int, kind: str) -> pd.Series:
    if kind.upper() == "EMA":
        return series.ewm(span=length, adjust=False).mean()
    return series.rolling(length).mean()


def heikin_ashi(df: pd.DataFrame) -> pd.DataFrame:
    """Return HA open/high/low/close aligned to df index."""
    ha_close = (df["open"] + df["high"] + df["low"] + df["close"]) / 4.0
    ha_open = np.empty(len(df))
    o = df["open"].to_numpy()
    hc = ha_close.to_numpy()
    for i in range(len(df)):
        if i == 0:
            ha_open[i] = o[i]
        else:
            ha_open[i] = (ha_open[i - 1] + hc[i - 1]) / 2.0
    ha_open_s = pd.Series(ha_open, index=df.index)
    ha_high = pd.concat([df["high"], ha_open_s, ha_close], axis=1).max(axis=1)
    ha_low = pd.concat([df["low"], ha_open_s, ha_close], axis=1).min(axis=1)
    return pd.DataFrame(
        {"ha_open": ha_open_s, "ha_high": ha_high, "ha_low": ha_low, "ha_close": ha_close}
    )


def generate_signals(df: pd.DataFrame, cfg: SwingConfig) -> list[Signal]:
    """df must have columns open/high/low/close and a sorted DatetimeIndex (or 'date')."""
    if df.empty:
        return []
    data = df.copy()
    if "date" in data.columns:
        data = data.set_index("date")
    data = data.sort_index()

    ha = heikin_ashi(data)
    ha_open = ha["ha_open"].to_numpy()
    ha_high = ha["ha_high"].to_numpy()
    ha_low = ha["ha_low"].to_numpy()
    ha_close = ha["ha_close"].to_numpy()
    close = data["close"].to_numpy()
    idx = data.index

    fast = _ma(data["close"], cfg.ma_fast, cfg.ma_type).to_numpy()
    slow = _ma(data["close"], cfg.ma_slow, cfg.ma_type).to_numpy()

    start_ts = pd.Timestamp(cfg.start_year, cfg.start_month, cfg.start_day)

    current_bullish = ha_close > ha_open

    c_high = np.nan
    c_low = np.nan
    prev_bullish = bool(current_bullish[0])
    signal_triggered = False
    last_c_bar = -1
    sl_buf = cfg.sl_buffer_pct / 100.0
    tp_pct = cfg.tp_pct / 100.0

    signals: list[Signal] = []

    for i in range(len(data)):
        bullish = bool(current_bullish[i])
        if i == 0:
            prev_bullish = bullish
            continue

        if bullish != prev_bullish:  # HA color flip → new consolidation levels
            c_high = ha_high[i]
            c_low = ha_low[i]
            signal_triggered = False
            last_c_bar = i

        allow = idx[i] >= start_ts
        potential_buy = (not np.isnan(c_high)) and ha_close[i] > c_high
        potential_sell = (not np.isnan(c_low)) and ha_close[i] < c_low

        raw_buy = potential_buy and (not signal_triggered) and i > last_c_bar and allow
        raw_sell = potential_sell and (not signal_triggered) and i > last_c_bar and allow

        bullish_trend = fast[i] > slow[i]
        bearish_trend = fast[i] < slow[i]
        buy = raw_buy and (not cfg.apply_ma_filter or bool(bullish_trend))
        sell = raw_sell and (not cfg.apply_ma_filter or bool(bearish_trend))

        if buy or sell:
            signal_triggered = True
            entry = float(close[i])
            cr = max(float(c_high) - float(c_low), 0.0)  # consolidation range
            use_fib = cfg.tp_mode == "fibonacci"
            ratios = [r for r in (cfg.fib_tp1, cfg.fib_tp2, cfg.fib_tp3) if r > 0]
            fracs = [1.0 / len(ratios)] * len(ratios) if ratios else [1.0]
            if buy:
                sl = float(ha_low[i - 1]) * (1 - sl_buf)
                if use_fib and cr > 0:
                    levels = tuple((entry + cr * r, f) for r, f in zip(ratios, fracs))
                else:
                    levels = ((entry * (1 + tp_pct), 1.0),)
                lev = max(int(round(entry / (entry - sl))), 1) if entry > sl else 1
                signals.append(Signal(idx[i], "buy", entry, sl, levels[-1][0], lev,
                                      float(c_high), float(c_low), levels))
            else:
                sl = float(ha_high[i - 1]) * (1 + sl_buf)
                if use_fib and cr > 0:
                    levels = tuple((entry - cr * r, f) for r, f in zip(ratios, fracs))
                else:
                    levels = ((entry * (1 - tp_pct), 1.0),)
                lev = max(int(round(entry / (sl - entry))), 1) if sl > entry else 1
                signals.append(Signal(idx[i], "sell", entry, sl, levels[-1][0], lev,
                                      float(c_high), float(c_low), levels))

        prev_bullish = bullish

    return signals
