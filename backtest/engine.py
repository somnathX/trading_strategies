from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from config import OrbFibConfig
from data.fetcher import post_entry_candles, session_candles
from strategies.levels import range_levels
from strategies.exit_rules import process_take_profits
from strategies.orb_fib import TradeSignal, _strong, next_signal, try_opening_range
from strategies.stops import (
    ratchet_trail_stop,
    stop_outcome_label,
    trail_distance,
)


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
    stop_price: float
    tp1_price: float | None = None
    tp2_price: float | None = None
    tp3_price: float | None = None
    hold_days: int = 1
    max_hold_sessions: int = 1
    impulse_low: float | None = None
    impulse_high: float | None = None


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


def _long_stop_fill(row: pd.Series, stop: float) -> tuple[float, str] | None:
    o, lo = float(row["open"]), float(row["low"])
    if lo <= stop:
        fill = o if o <= stop else stop
        label = "gap_stop" if o <= stop else "stop"
        return fill, label
    return None


def _short_stop_fill(row: pd.Series, stop: float) -> tuple[float, str] | None:
    o, hi = float(row["open"]), float(row["high"])
    if hi >= stop:
        fill = o if o >= stop else stop
        label = "gap_stop" if o >= stop else "stop"
        return fill, label
    return None


def _session_or_levels(
    df: pd.DataFrame,
    session_date,
    orb_minutes: int,
) -> tuple[float, float, pd.Timestamp] | None:
    day = session_candles(df, session_date)
    if day.empty:
        return None
    try:
        return try_opening_range(day, orb_minutes)
    except ValueError:
        return None


def _opposite_or_exit(
    signal: TradeSignal,
    row: pd.Series,
    or_high: float,
    or_low: float,
    cfg: OrbFibConfig,
) -> bool:
    """Next-day opposite OR breakout: long exits on bearish break below OR low, etc."""
    close = float(row["close"])
    if signal.side == "long":
        return close < or_low and _strong(row, "short", cfg)
    return close > or_high and _strong(row, "long", cfg)


def _is_last_session_bar(ts: pd.Timestamp, path: pd.DataFrame) -> bool:
    day_bars = path[path.index.date == ts.date()]
    return not day_bars.empty and ts == day_bars.index[-1]


def _hold_session_count(
    df: pd.DataFrame,
    entry_time: pd.Timestamp,
    exit_time: pd.Timestamp,
) -> int:
    """Trading sessions with data from entry day through exit day (inclusive)."""
    all_dates = sorted({d for d in df.index.date})
    entry_d = pd.Timestamp(entry_time).date()
    exit_d = pd.Timestamp(exit_time).date()
    held = [d for d in all_dates if entry_d <= d <= exit_d]
    return max(len(held), 1)


def _check_swing_opposite_or(
    ts: pd.Timestamp,
    row: pd.Series,
    path: pd.DataFrame,
    signal: TradeSignal,
    or_high: float,
    or_low: float,
    cfg: OrbFibConfig,
) -> bool:
    mode = cfg.swing_opposite_or
    if mode == "off":
        return False
    if mode == "eod" and not _is_last_session_bar(ts, path):
        return False
    if _opposite_or_exit(signal, row, or_high, or_low, cfg):
        return True
    return False


def _simulate_trade(
    df: pd.DataFrame,
    signal: TradeSignal,
    cfg: OrbFibConfig,
) -> TradeResult | None:
    path = post_entry_candles(df, signal.entry_time, cfg.max_hold_days)
    if path.empty:
        return None

    levels = range_levels(signal.orb_high, signal.orb_low, cfg)
    entry = signal.entry_price
    stop = signal.stop_price
    initial_stop = stop
    remaining = 1.0
    pnl = 0.0
    outcomes: list[str] = []
    exit_time = path.index[-1]
    exit_price = float(path.iloc[-1]["close"])
    tp1_hit = False
    ratchet_idx = 0
    swing = cfg.max_hold_days > 1
    trail_dist = trail_distance(cfg, signal) if cfg.stop_mode == "trail" else 0.0
    running_extreme = entry

    tps = [signal.tp1, signal.tp2, signal.tp3]
    sizes = list(cfg.tp_sizes)

    entry_date = signal.entry_time.date()
    day_or_cache: dict = {}

    def _day_or(bar_date) -> tuple[float, float, pd.Timestamp] | None:
        if bar_date <= entry_date:
            return None
        if bar_date not in day_or_cache:
            day_or_cache[bar_date] = _session_or_levels(df, bar_date, cfg.orb_minutes)
        return day_or_cache[bar_date]

    for ts, row in path.iterrows():
        hi, lo = float(row["high"]), float(row["low"])

        if signal.side == "long":
            running_extreme = max(running_extreme, hi)
        else:
            running_extreme = min(running_extreme, lo)

        if cfg.stop_mode == "trail":
            stop = ratchet_trail_stop(signal.side, stop, running_extreme, trail_dist)

        if remaining > 0 and swing and cfg.swing_opposite_or != "off":
            day_or = _day_or(ts.date())
            if day_or is not None and ts >= day_or[2]:
                or_high, or_low, _ = day_or
                if _check_swing_opposite_or(ts, row, path, signal, or_high, or_low, cfg):
                    close = float(row["close"])
                    if signal.side == "long":
                        pnl += remaining * (close - entry)
                    else:
                        pnl += remaining * (entry - close)
                    remaining = 0.0
                    label = "opp_or_eod" if cfg.swing_opposite_or == "eod" else "opp_or"
                    outcomes.append(label)
                    exit_time = ts
                    exit_price = close
                    break

        if signal.side == "long":
            stop_hit = _long_stop_fill(row, stop)
            if stop_hit:
                fill, fill_label = stop_hit
                pnl += remaining * (fill - entry)
                remaining = 0.0
                outcomes.append(
                    stop_outcome_label("long", fill_label, stop, initial_stop, cfg, tp1_hit)
                )
                exit_time = ts
                exit_price = fill
                break

            remaining, pnl, tp_exit_price, outcomes, tp1_hit, ratchet_idx, stop, ended = (
                process_take_profits(
                    ts=ts,
                    row=row,
                    side="long",
                    entry=entry,
                    stop=stop,
                    remaining=remaining,
                    pnl=pnl,
                    outcomes=outcomes,
                    tps=tps,
                    sizes=sizes,
                    cfg=cfg,
                    levels=levels,
                    signal=signal,
                    tp1_hit=tp1_hit,
                    ratchet_idx=ratchet_idx,
                )
            )
            if ended:
                exit_time = ts
                exit_price = tp_exit_price
                break
        else:
            stop_hit = _short_stop_fill(row, stop)
            if stop_hit:
                fill, fill_label = stop_hit
                pnl += remaining * (entry - fill)
                remaining = 0.0
                outcomes.append(
                    stop_outcome_label("short", fill_label, stop, initial_stop, cfg, tp1_hit)
                )
                exit_time = ts
                exit_price = fill
                break

            remaining, pnl, tp_exit_price, outcomes, tp1_hit, ratchet_idx, stop, ended = (
                process_take_profits(
                    ts=ts,
                    row=row,
                    side="short",
                    entry=entry,
                    stop=stop,
                    remaining=remaining,
                    pnl=pnl,
                    outcomes=outcomes,
                    tps=tps,
                    sizes=sizes,
                    cfg=cfg,
                    levels=levels,
                    signal=signal,
                    tp1_hit=tp1_hit,
                    ratchet_idx=ratchet_idx,
                )
            )
            if ended:
                exit_time = ts
                exit_price = tp_exit_price
                break

    if remaining > 0:
        close = float(path.iloc[-1]["close"])
        pnl += remaining * ((close - entry) if signal.side == "long" else (entry - close))
        outcomes.append("max_days" if swing else "eod")
        exit_time = path.index[-1]
        exit_price = close

    outcome_str = "+".join(outcomes) if outcomes else ("max_days" if swing else "eod")
    avg_exit = entry + pnl if signal.side == "long" else entry - pnl
    hold_days = _hold_session_count(df, signal.entry_time, exit_time)

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
        stop_price=signal.stop_price,
        tp1_price=signal.tp1,
        tp2_price=signal.tp2,
        tp3_price=signal.tp3,
        hold_days=hold_days,
        max_hold_sessions=cfg.max_hold_days,
        impulse_low=signal.impulse_low,
        impulse_high=signal.impulse_high,
    )


def _trade_limit(cfg: OrbFibConfig) -> int:
    return cfg.max_trades_per_day


def _cursor_after_exit(df: pd.DataFrame, exit_time: str | pd.Timestamp) -> pd.Timestamp | None:
    exit_ts = pd.Timestamp(exit_time)
    future = df.index[df.index > exit_ts]
    if future.empty:
        return None
    return future[0]


def collect_session_signals(
    day: pd.DataFrame,
    cfg: OrbFibConfig,
    df: pd.DataFrame,
) -> list[TradeSignal]:
    """Signals taken in sequence on this session (uses full df for swing simulation)."""
    or_levels = try_opening_range(day, cfg.orb_minutes)
    if or_levels is None:
        return []
    _, _, orb_end = or_levels
    cursor: pd.Timestamp = orb_end
    signals: list[TradeSignal] = []
    limit = _trade_limit(cfg)

    while len(signals) < limit:
        signal = next_signal(day, cfg, cursor)
        if signal is None:
            break
        result = _simulate_trade(df, signal, cfg)
        if result is None:
            break
        signals.append(signal)
        next_cursor = _cursor_after_exit(df, result.exit_time)
        if next_cursor is None:
            break
        cursor = next_cursor
        if cursor.date() > day.index[0].date():
            break

    return signals


def run_backtest(df: pd.DataFrame, cfg: OrbFibConfig) -> tuple[pd.DataFrame, dict]:
    sessions = sorted({ts.date() for ts in df.index})
    trades: list[TradeResult] = []
    global_cursor: pd.Timestamp | None = None

    for session_date in sessions:
        day = session_candles(df, session_date)
        if day.empty:
            continue

        or_levels = try_opening_range(day, cfg.orb_minutes)
        if or_levels is None:
            continue

        _, _, orb_end = or_levels

        if global_cursor is not None and global_cursor > day.index[-1]:
            continue

        if global_cursor is not None and global_cursor.date() == session_date:
            after = global_cursor
        else:
            after = orb_end

        limit = _trade_limit(cfg)
        session_count = 0

        while session_count < limit:
            if after > day.index[-1]:
                break
            signal = next_signal(day, cfg, after)
            if signal is None:
                break
            result = _simulate_trade(df, signal, cfg)
            if result is None:
                break
            trades.append(result)
            session_count += 1
            global_cursor = _cursor_after_exit(df, result.exit_time)
            if global_cursor is None:
                break
            after = global_cursor
            if global_cursor.date() > session_date:
                break
            if (
                cfg.block_same_day_after_swing
                and result.hold_days > 1
                and pd.Timestamp(result.exit_time).date() == session_date
            ):
                break

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
